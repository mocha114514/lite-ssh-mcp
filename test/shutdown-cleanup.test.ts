import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../src/app.js';
import { LiteSshError, publicError } from '../src/core/errors.js';
import type { TerminalIdentity } from '../src/core/types.js';
import type { ConnectionPool } from '../src/ssh/pool.js';
import { TerminalService } from '../src/terminal/service.js';
import type { TerminalSession } from '../src/terminal/session.js';
import { TransferManager } from '../src/sftp/manager.js';

const login = { ip: '127.0.0.1', port: 2222, username: 'synthetic' };

function seedTerminal(
  service: TerminalService,
  codename: string,
  close: () => Promise<Record<string, unknown>>
): void {
  const identity = { ...login, codename };
  const entries = (service as unknown as {
    entries: Map<string, { identity: TerminalIdentity; session: TerminalSession }>;
  }).entries;
  entries.set(codename, { identity, session: { close } as unknown as TerminalSession });
}

function cleanupFailures(error: unknown) {
  assert.ok(error instanceof LiteSshError);
  assert.ok(Array.isArray(error.details.cleanupFailures));
  return error.details.cleanupFailures as Array<{
    resource: string;
    code: string;
    facts?: Record<string, unknown>;
  }>;
}

test('F09 terminal dispose reports a false close result and still closes other owners and the pool', async () => {
  const calls: string[] = [];
  const service = new TerminalService({
    dispose: async () => { calls.push('pool'); }
  } as unknown as ConnectionPool);
  seedTerminal(service, 'loss', async () => {
    calls.push('loss');
    return {
      ok: false, code: 'CACHE_WRITE_FAILED', recordingErrorCode: 'CACHE_WRITE_FAILED',
      cacheMayBeIncomplete: true, cacheRemoved: true, localTerminalClosed: true,
      remoteChannelCleanupConfirmed: true
    };
  });
  seedTerminal(service, 'healthy', async () => {
    calls.push('healthy');
    return { ok: true, cacheRemoved: true, remoteChannelCleanupConfirmed: true };
  });
  await assert.rejects(service.dispose(), error => {
    const failures = cleanupFailures(error);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.code, 'CACHE_WRITE_FAILED');
    assert.equal(failures[0]?.facts?.cacheMayBeIncomplete, true);
    assert.equal(failures[0]?.facts?.cacheRemoved, true);
    return true;
  });
  assert.deepEqual(calls, ['loss', 'healthy', 'pool']);
});

test('F09 a rejected terminal close cannot skip or hide the pool finalizer', async () => {
  const calls: string[] = [];
  const service = new TerminalService({
    dispose: async () => {
      calls.push('pool');
      throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic pool cleanup failed.');
    }
  } as unknown as ConnectionPool);
  seedTerminal(service, 'rejected', async () => {
    calls.push('terminal');
    throw new Error('synthetic_secret_close_payload');
  });
  await assert.rejects(service.dispose(), error => {
    const failures = cleanupFailures(error);
    assert.deepEqual(failures.map(item => item.code), [
      'TERMINAL_CLEANUP_FAILED', 'CONNECTION_CLEANUP_FAILED'
    ]);
    assert.ok(!JSON.stringify(publicError(error)).includes('synthetic_secret_close_payload'));
    return true;
  });
  assert.deepEqual(calls, ['terminal', 'pool']);
});

test('F09 service failure lists are bounded but every owned terminal is still attempted', async () => {
  let closes = 0;
  const service = new TerminalService({ dispose: async () => {} } as unknown as ConnectionPool);
  // A fault-injected registry deliberately exceeds ordinary admission capacity
  // to exercise aggregate bounding independently of that admission policy.
  for (let index = 0; index < 40; index++) {
    seedTerminal(service, `fixture_${index}`, async () => {
      closes++;
      return { ok: false };
    });
  }
  await assert.rejects(service.dispose(), error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(cleanupFailures(error).length, 32);
    assert.equal(error.details.cleanupFailureCount, 40);
    assert.equal(error.details.cleanupFailuresComplete, false);
    return true;
  });
  assert.equal(closes, 40);
});

test('F09 transfer dispose retains known incomplete cleanup instead of silently clearing it', async () => {
  const manager = new TransferManager({ acquire: async () => { throw new Error('Unused fixture'); } });
  const tasks = (manager as unknown as { tasks: Map<string, unknown> }).tasks;
  tasks.set('tr_fixture', {
    transferId: 'tr_fixture', phase: 'failed', completion: Promise.resolve(),
    accountedBytes: 0, channelClosed: false,
    cleanup: {
      complete: false, outcomeUnknown: true,
      residualPaths: ['/synthetic/.owned.tmp'], possibleResidualPaths: []
    }
  });
  await assert.rejects(manager.dispose(), error => {
    const failures = cleanupFailures(error);
    assert.equal(failures[0]?.resource, 'transfer');
    assert.equal(failures[0]?.facts?.transferId, 'tr_fixture');
    const cleanup = failures[0]?.facts?.cleanup as Record<string, unknown>;
    assert.deepEqual(cleanup.residualPaths, ['/synthetic/.owned.tmp']);
    assert.equal(cleanup.outcomeUnknown, true);
    return true;
  });
  // The aggregate promise remains the same failure after registry teardown.
  await assert.rejects(manager.dispose(), error => cleanupFailures(error).length === 1);
});

test('F09 ordinary failed transfer with confirmed cleanup does not turn shutdown into failure', async () => {
  const manager = new TransferManager({ acquire: async () => { throw new Error('Unused fixture'); } });
  const tasks = (manager as unknown as { tasks: Map<string, unknown> }).tasks;
  tasks.set('tr_fixture', {
    transferId: 'tr_fixture', phase: 'failed', completion: Promise.resolve(),
    accountedBytes: 0, channelClosed: true,
    error: { code: 'FILE_IO_FAILED', message: 'Already reported operation failure.', details: {} },
    cleanup: { complete: true, outcomeUnknown: false, residualPaths: [], possibleResidualPaths: [] }
  });
  await manager.dispose();
});

test('F09 application shutdown aggregates all components and always detaches the MCP transport', async () => {
  const app = createApplication({
    configPath: path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'shutdown', 'synthetic-config.json')
  });
  const calls: string[] = [];
  app.terminals.dispose = async () => {
    calls.push('terminal');
    throw new LiteSshError('TERMINAL_CLEANUP_FAILED', 'Synthetic terminal failure.');
  };
  app.transfers.dispose = async () => {
    calls.push('transfer');
    throw new LiteSshError('TRANSFER_CLEANUP_FAILED', 'Synthetic transfer failure.');
  };
  app.pool.dispose = async () => {
    calls.push('pool');
    throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic pool failure.');
  };
  app.server.close = async () => {
    calls.push('mcp');
    throw new Error('synthetic_secret_transport_payload');
  };
  const closing = app.close();
  assert.equal(app.close(), closing);
  await assert.rejects(closing, error => {
    const failures = cleanupFailures(error);
    assert.deepEqual(failures.map(item => item.resource), ['terminal', 'transfer', 'connection', 'mcp']);
    assert.ok(!JSON.stringify(publicError(error)).includes('synthetic_secret_transport_payload'));
    return true;
  });
  assert.deepEqual(calls, ['terminal', 'transfer', 'pool', 'mcp']);
});

for (const kind of ['false', 'rejected']) {
  test(`F09 actual CLI ${kind} terminal cleanup exits nonzero, keeps stdout clean and attempts all owners`, {
    timeout: 15_000
  }, async () => {
    const home = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'shutdown-cli', `${kind}-${process.pid}-${Date.now()}`);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const marker = path.join(home, 'stages.txt');
    const hook = path.join(home, 'fault-preload.mjs');
    await fs.writeFile(marker, '', { flag: 'wx', encoding: 'utf8' });
    const moduleUrl = (name: string) => pathToFileURL(path.resolve('dist', name)).href;
    await fs.writeFile(hook, [
      `import { appendFileSync } from 'node:fs';`,
      `import { TerminalService } from ${JSON.stringify(moduleUrl('terminal/service.js'))};`,
      `import { TransferManager } from ${JSON.stringify(moduleUrl('sftp/manager.js'))};`,
      `import { ConnectionPool } from ${JSON.stringify(moduleUrl('ssh/pool.js'))};`,
      `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};`,
      `const record = name => appendFileSync(${JSON.stringify(marker)}, name + '\\n');`,
      `const dispose = TerminalService.prototype.dispose;`,
      `TerminalService.prototype.dispose = function(closePool = true) {`,
      `  record('terminal');`,
      `  this.entries.set('fixture', { identity: { ip: '127.0.0.1', port: 2222, username: 'synthetic', codename: 'fixture' },`,
      `    session: { close: async () => { ${kind === 'false' ? 'return { ok: false };' : "throw new Error('synthetic_cli_secret');"} } } });`,
      `  return dispose.call(this, closePool);`,
      `};`,
      `for (const [owner, method, name] of [[TransferManager, 'dispose', 'transfer'], [ConnectionPool, 'dispose', 'pool'], [McpServer, 'close', 'mcp']]) {`,
      `  const original = owner.prototype[method];`,
      `  owner.prototype[method] = async function(...args) { record(name); return original.apply(this, args); };`,
      `}`,
      ''
    ].join('\n'), { flag: 'wx', encoding: 'utf8' });
    const args = ['--import', pathToFileURL(hook).href, path.resolve('dist/cli.js')];
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(), windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const exited = once(child, 'exit');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await fs.writeFile(path.join(home, 'child-started.json'), JSON.stringify({ pid: child.pid, startedAt, args }));
      child.stdin.end();
      const [code, signal] = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned fault CLI did not exit.')), 10_000);
        })
      ]);
      await fs.writeFile(path.join(home, 'child-result.json'), JSON.stringify({
        pid: child.pid, startedAt, finishedAt: new Date().toISOString(), code, signal, stdout, stderr
      }));
      assert.equal(code, 1);
      assert.equal(signal, null);
      assert.equal(stdout, '');
      assert.match(stderr, /Shutdown cleanup failed\./);
      assert.ok(!stderr.includes('synthetic_cli_secret'));
      assert.deepEqual((await fs.readFile(marker, 'utf8')).trim().split('\n'), ['terminal', 'transfer', 'pool', 'mcp']);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      child.stdin.end();
      // Only this concrete, recorded child may be ended on a failed assertion.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    }
  });
}
