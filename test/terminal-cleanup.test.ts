import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Client as SshClient } from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';
import type { ConnectionLease, TerminalIdentity } from '../src/core/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { TransferManager } from '../src/sftp/manager.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { ClientOwner } from '../src/ssh/clientOwner.js';
import { ConnectionPool } from '../src/ssh/pool.js';
import { withTerminalCleanup } from '../src/terminal/cleanup.js';
import { TerminalService } from '../src/terminal/service.js';
import { TerminalSession } from '../src/terminal/session.js';

const identity: TerminalIdentity = {
  ip: '127.0.0.1', port: 22, username: 'synthetic', codename: 'fixture_cleanup'
};

/** No socket, filesystem, user configuration or real credential is involved. */
class CleanupChannel extends PassThrough {
  readonly stderr = new PassThrough();
  readonly outbound: string[] = [];
  private probed = false;
  private ready = false;
  private nonce = '';

  constructor(private readonly shell = 'bash') { super(); }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const packet = chunk.toString('utf8');
    this.outbound.push(packet);
    callback();
    const match = /LSSH;([A-Za-z0-9_.-]+);STTY/u.exec(packet);
    if (match && !this.probed) {
      this.probed = true;
      this.nonce = match[1]!;
      queueMicrotask(() => this.emit('data', Buffer.from(
        encodeMarkerOsc(this.nonce, 'STTY;0:0:0:0')
        + encodeMarkerOsc(this.nonce, `PROBE;${this.shell}`)
      )));
    } else if (this.probed && !this.ready && packet.includes('__lssh_')) {
      this.ready = true;
      queueMicrotask(() => this.emit('data', Buffer.from(encodeMarkerOsc(this.nonce, 'READY;bash'))));
    }
  }

  close(): void {
    this.end();
    this.stderr.end();
    this.emit('close');
  }
}

function fixture(options: { shell?: string; retained?: boolean; ptyFailure?: boolean; realOwner?: boolean } = {}) {
  const channel = new CleanupChannel(options.shell);
  let closes = 0;
  let released = 0;
  let releaseReceipt: Promise<void> | undefined;
  const failure = new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic unconfirmed physical closure.');
  const client = new EventEmitter() as EventEmitter & { end(): void; destroy(): void; shell: unknown };
  client.end = () => undefined;
  client.destroy = () => undefined;
  client.shell = (_window: unknown, callback: (error: Error | null, stream?: CleanupChannel) => void) => {
    callback(options.ptyFailure ? new Error('synthetic rejection') : null, options.ptyFailure ? undefined : channel);
  };
  const owner = options.realOwner ? new ClientOwner(client as unknown as SshClient, () => undefined, 5, 5) : undefined;
  const lease: ConnectionLease = {
    client: client as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: () => {
      if (!releaseReceipt) {
        released++;
        releaseReceipt = owner ? owner.close() : Promise.reject(failure);
      }
      return releaseReceipt;
    }
  };
  // This seam tests fact propagation, not cache acquisition or permission
  // enforcement. Those use real owned files in cache/identity/ACL tests.
  const recorder = {
    path: 'synthetic-owned-cache-no-physical-file',
    recordLine: () => undefined,
    recordFrame: () => undefined,
    recordStep: () => undefined,
    beginRound: () => 'R1',
    flush: async () => undefined,
    close: async () => {
      closes++;
      return options.retained
        ? { cacheRemoved: false, cleanupError: 'CACHE_DELETE_FAILED EACCES' }
        : { cacheRemoved: true };
    }
  } as unknown as ReadableRecorder;
  return {
    channel, client, owner, lease, recorder,
    closes: () => closes,
    released: () => released,
    releaseFailure: failure
  };
}

async function opened(options: Parameters<typeof fixture>[0] = {}) {
  const value = fixture(options);
  const session = await TerminalSession.open(value.lease, identity, {
    recorder: value.recorder, initializationTimeoutMs: 1000, writeWaitMs: 200
  });
  return { ...value, session };
}

test('real ClientOwner rejection retains successful cache cleanup and settles the local terminal once', async () => {
  const value = await opened({ realOwner: true });
  const first = value.session.close();
  assert.equal(value.session.close(), first);
  const result = await first;
  assert.equal(result.ok, false);
  assert.equal(result.state, 'closed');
  assert.equal(result.localTerminalClosed, true);
  assert.equal(result.remoteChannelCleanupConfirmed, true);
  assert.equal(result.connectionCleanupConfirmed, false);
  assert.equal(result.connectionCleanupErrorCode, 'CONNECTION_CLEANUP_FAILED');
  assert.equal(result.cacheRemoved, true);
  assert.equal(result.cachePath, value.recorder.path);
  assert.equal(value.session.status, 'closed');
  assert.equal(value.closes(), 1);
  assert.equal(value.released(), 1);
  assert.equal(value.owner?.closed, false, 'a local terminal result must not fake physical SSH closure');
  await value.session.close();
  assert.equal(value.released(), 1);
  value.client.emit('close');
});

test('retained cache facts and a connection cleanup error are returned together', async () => {
  const value = await opened({ retained: true });
  const result = await value.session.close();
  assert.equal(result.cacheRemoved, false);
  assert.equal(result.cleanupError, 'CACHE_DELETE_FAILED EACCES');
  assert.equal(result.connectionCleanupConfirmed, false);
  assert.equal(result.cachePath, value.recorder.path);
  assert.equal(value.closes(), 1);
  assert.equal(value.session.status, 'closed');
});

test('a close wakes pending input observers without replay and preserves cleanup facts', async () => {
  const value = await opened();
  const writing = value.session.write([{ type: 'text', text: 'synthetic input' }, { type: 'key', key: 'ENTER' }]);
  while (!value.channel.outbound.some(packet => packet.includes('synthetic input'))) {
    await new Promise<void>(resolve => setTimeout(resolve, 1));
  }
  await value.session.close();
  const result = await writing;
  assert.equal(result.inputSent, true);
  assert.equal(result.inputHandled, 'unknown');
  assert.equal(result.cacheRemoved, true);
  assert.equal(result.connectionCleanupConfirmed, false);
  assert.equal(value.channel.outbound.filter(packet => packet.includes('synthetic input')).length, 1);
});

test('a snapshot finalizer error cannot skip screen disposal, cache closure or lease release', async t => {
  const value = await opened();
  let disposed = 0;
  const originalDispose = value.session.screen.dispose.bind(value.session.screen);
  t.mock.method(value.session.screen, 'snapshot', () => { throw new Error('synthetic sensitive native message'); });
  t.mock.method(value.session.screen, 'dispose', () => { disposed++; originalDispose(); });
  try {
    const result = await value.session.close();
    assert.equal(result.ok, false);
    assert.equal(result.cacheRemoved, true);
    assert.equal(result.connectionCleanupConfirmed, false);
    assert.equal(value.session.status, 'closed');
    assert.equal(disposed, 1);
    assert.equal(value.released(), 1);
    const final = await value.session.read();
    assert.equal(final.screenUnavailable, true);
    assert.ok(!JSON.stringify(final).includes('synthetic sensitive native message'));
  } finally { t.mock.restoreAll(); }
});

test('PTY and unsupported-Shell initialization failures keep their primary error through duplicate release', async () => {
  for (const scenario of [
    { ptyFailure: true, expected: 'PTY_OPEN_FAILED' },
    { shell: 'tcsh', expected: 'SHELL_INTEGRATION_UNSUPPORTED' }
  ]) {
    const value = fixture(scenario);
    const pool = { acquire: async () => value.lease } as unknown as ConnectionPool;
    const service = new TerminalService(pool, { recorder: value.recorder, initializationTimeoutMs: 1000 });
    await assert.rejects(service.open(identity, identity.codename), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, scenario.expected);
      assert.equal(error.details.cacheRemoved, true);
      assert.equal(error.details.connectionCleanupConfirmed, false);
      assert.equal(error.details.cachePath, value.recorder.path);
      return true;
    });
    assert.equal(value.closes(), 1);
    assert.equal(value.released(), 1);
    assert.equal(service.list().total, 0);
  }
});

test('cache factory facts survive lease rejection before a session exists', async t => {
  const value = fixture();
  const primary = new LiteSshError('FILE_PERMISSION_ERROR', 'Synthetic cache factory failure.', {
    cachePath: 'synthetic-factory-cache', cacheRemoved: true
  });
  t.mock.method(ReadableRecorder, 'create', async () => { throw primary; });
  const service = new TerminalService({ acquire: async () => value.lease } as unknown as ConnectionPool);
  try {
    await assert.rejects(service.open(identity, identity.codename), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, primary.code);
      assert.equal(error.message, primary.message);
      assert.equal(error.details.cacheRemoved, true);
      assert.equal(error.details.cachePath, 'synthetic-factory-cache');
      assert.equal(error.details.connectionCleanupConfirmed, false);
      assert.equal(error.details.cacheCleanupUnknown, undefined);
      return true;
    });
    assert.equal(value.released(), 1);
    assert.equal(service.list().total, 0);
  } finally { t.mock.restoreAll(); }
});

test('MCP first-public-read error preserves its primary classification and retained cache facts', async t => {
  const value = fixture({ retained: true });
  const primary = new LiteSshError('CACHE_WRITE_FAILED', 'Synthetic first-read failure.');
  t.mock.method(TerminalSession.prototype, 'read', async () => { throw primary; });
  const pool = { acquire: async () => value.lease } as unknown as ConnectionPool;
  const terminals = new TerminalService(pool, { recorder: value.recorder, initializationTimeoutMs: 1000 });
  const server = createMcpServer({} as ConfigStore, pool, terminals, {} as TransferManager);
  const client = new Client({ name: 'synthetic-terminal-cleanup', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: 'lite_ssh_terminal_open',
      arguments: { ...identity }
    });
    const content = result.structuredContent as Record<string, unknown>;
    assert.equal(result.isError, true);
    assert.equal(content.code, primary.code);
    assert.equal(content.message, primary.message);
    assert.equal(content.cacheRemoved, false);
    assert.equal(content.cleanupError, 'CACHE_DELETE_FAILED EACCES');
    assert.equal(content.connectionCleanupConfirmed, false);
    assert.equal(content.cachePath, value.recorder.path);
    assert.equal(terminals.list().total, 0);
    assert.equal(value.closes(), 1);
    assert.equal(value.released(), 1);
  } finally {
    t.mock.restoreAll();
    await client.close();
    await server.close();
    await terminals.dispose(false);
  }
});

test('a rejected cache close reports unknown cache cleanup but still completes other owners', async t => {
  const value = await opened();
  t.mock.method(value.recorder, 'close', async () => { throw new Error('synthetic private native payload'); });
  try {
    const result = await value.session.close();
    assert.equal(result.ok, false);
    assert.equal(result.cacheRemoved, undefined);
    assert.equal(result.cacheCleanupUnknown, true);
    assert.equal(result.connectionCleanupConfirmed, false);
    assert.equal(value.session.status, 'closed');
    assert.equal(value.released(), 1);
    assert.ok(!JSON.stringify(result).includes('synthetic private native payload'));
  } finally { t.mock.restoreAll(); }
});

test('an unconfirmed PTY channel is not presented as publicly closed', async t => {
  const value = await opened();
  // The controlled stream owns no socket. Hold its actual close event without
  // touching another process or pretending that destroy proved closure.
  (value.session as unknown as { initializationTimeout: number }).initializationTimeout = 20;
  t.mock.method(value.channel, 'close', () => undefined);
  t.mock.method(value.channel, 'destroy', () => value.channel);
  try {
    const result = await value.session.close();
    assert.equal(result.state, 'error');
    assert.equal(result.localTerminalClosed, true);
    assert.equal(result.remoteChannelCleanupConfirmed, false);
    assert.equal(result.cacheRemoved, true);
    assert.equal(value.session.status, 'closed');
    assert.equal(value.released(), 1);
  } finally {
    t.mock.restoreAll();
    value.channel.destroy();
    value.channel.stderr.destroy();
  }
});

test('a naturally closed channel still drains paused stderr before recorder closure', async t => {
  const value = await opened();
  const recorded: unknown[] = [];
  t.mock.method(value.recorder, 'recordLine', (line: Parameters<ReadableRecorder['recordLine']>[0]) => {
    recorded.push(line);
  });
  value.channel.stderr.pause();
  value.channel.stderr.write('buffered stderr tail\r\n');
  value.channel.end();
  value.channel.stderr.end();
  value.channel.emit('close');
  try {
    await value.session.close();
    const final = await value.session.read();
    assert.ok(JSON.stringify(recorded).includes('buffered stderr tail'));
    assert.ok(JSON.stringify(final.screen).includes('buffered stderr tail'));
    assert.equal(value.closes(), 1);
  } finally { t.mock.restoreAll(); }
});

test('a timed-out shell request on a shared connection reports pending PTY cleanup truthfully', async () => {
  const value = fixture();
  let lateClosed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const originalClose = value.channel.close.bind(value.channel);
  value.channel.close = () => { lateClosed++; originalClose(); };
  value.client.shell = (_window: unknown, callback: (error: null, stream: CleanupChannel) => void) => {
    timer = setTimeout(() => callback(null, value.channel), 60);
  };
  // A sibling lease keeps the shared client alive. Releasing this lease does
  // not prove a request with a future shell callback has no PTY resource.
  value.lease.release = async () => undefined;
  try {
    await assert.rejects(TerminalSession.open(value.lease, identity, {
      recorder: value.recorder, initializationTimeoutMs: 10
    }), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, 'PTY_OPEN_TIMEOUT');
      assert.equal(error.details.cacheRemoved, true);
      assert.equal(error.details.remoteChannelCleanupConfirmed, false);
      assert.equal(error.details.localTerminalClosed, true);
      return true;
    });
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    assert.equal(lateClosed, 1, 'the late concrete PTY still belongs to the expired request');
  } finally {
    if (timer) clearTimeout(timer);
    value.channel.destroy();
    value.channel.stderr.destroy();
  }
});

test('in-flight input retains late recording-loss details through a completed local close', async t => {
  const value = await opened();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loss = new LiteSshError('CACHE_WRITE_FAILED', 'Synthetic accepted-output loss.', {
    reason: 'write_failed', droppedChunks: 2, droppedBytes: 42,
    state: 'spoofed', terminal: 'spoofed', cachePath: 'spoofed'
  });
  t.mock.method(value.recorder, 'recordLine', () => { throw loss; });
  t.mock.method(value.channel, 'close', () => {
    timer = setTimeout(() => {
      value.channel.emit('data', Buffer.from('late accepted output\r\n'));
      value.channel.end();
      value.channel.stderr.end();
      value.channel.emit('close');
    }, 10);
  });
  try {
    const writing = value.session.write([{ type: 'text', text: 'synthetic input' }, { type: 'key', key: 'ENTER' }]);
    while (!value.channel.outbound.some(packet => packet.includes('synthetic input'))) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
    await value.session.close();
    const result = await writing;
    assert.equal(result.inputSent, true);
    assert.equal(result.code, loss.code);
    assert.equal(result.reason, 'write_failed');
    assert.equal(result.droppedChunks, 2);
    assert.equal(result.droppedBytes, 42);
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.equal(result.cachePath, value.recorder.path);
    assert.deepEqual(result.terminal, identity);
    assert.equal(result.state, 'closed');
  } finally {
    if (timer) clearTimeout(timer);
    t.mock.restoreAll();
    value.channel.destroy();
    value.channel.stderr.destroy();
  }
});

test('a late PTY delivered during cache teardown remains unconfirmed until its real close', async () => {
  const value = fixture();
  let deliver: ((error: null, stream: CleanupChannel) => void) | undefined;
  let releaseCache!: () => void;
  let enteredCache!: () => void;
  let closeRequests = 0;
  const cacheGate = new Promise<void>(resolve => { releaseCache = resolve; });
  const cacheEntered = new Promise<void>(resolve => { enteredCache = resolve; });
  const originalCacheClose = value.recorder.close.bind(value.recorder);
  value.recorder.close = async () => {
    enteredCache();
    await cacheGate;
    return originalCacheClose();
  };
  value.client.shell = (_window: unknown, callback: typeof deliver) => { deliver = callback; };
  value.channel.close = () => { closeRequests++; };
  value.lease.release = async () => undefined;
  const opening = TerminalSession.open(value.lease, identity, {
    recorder: value.recorder, initializationTimeoutMs: 10
  });
  void opening.catch(() => undefined);
  try {
    await cacheEntered;
    assert.ok(deliver);
    deliver(null, value.channel);
    assert.equal(closeRequests, 1);
    releaseCache();
    await assert.rejects(opening, error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, 'PTY_OPEN_TIMEOUT');
      assert.equal(error.details.cacheRemoved, true);
      assert.equal(error.details.remoteChannelCleanupConfirmed, false);
      return true;
    });
  } finally {
    releaseCache();
    await opening.catch(() => undefined);
    value.channel.emit('close');
    value.channel.destroy();
    value.channel.stderr.destroy();
  }
});

test('cleanup control fields cannot overwrite the primary error class or actual identity', () => {
  const primary = new LiteSshError('PTY_OPEN_FAILED', 'Original public failure.', {
    ok: true, state: 'completed', code: 'SPOOFED', message: 'spoofed'
  });
  const result = withTerminalCleanup(primary, identity, {
    ok: true, state: 'closed', code: 'CONNECTION_CLEANUP_FAILED', message: 'secondary',
    cacheRemoved: true, connectionCleanupConfirmed: false
  }).toResult();
  assert.equal(result.ok, false);
  assert.equal(result.state, 'error');
  assert.equal(result.code, primary.code);
  assert.equal(result.message, primary.message);
  assert.deepEqual(result.terminal, identity);
  assert.equal(result.cacheRemoved, true);
});
