import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { test } from 'node:test';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createApplication } from '../src/app.js';
import { fixtureRoot } from './helpers/workspace.js';

interface Options {
  input: Readable;
  output: Writable;
  onFatal?: (error: Error) => void;
  limits?: { maxBytes?: number; closeMs?: number; flushMs?: number; confirmMs?: number };
}
type Factory = (options: Options) => Transport;
const moduleUrl = new URL('../src/mcp/stdio.js', import.meta.url);
let installed = false;
let factory: Factory;
try {
  const module = await import(moduleUrl.href) as { BoundedStdioTransport: new (options: Options) => Transport };
  factory = options => new module.BoundedStdioTransport(options);
  installed = true;
} catch (error) {
  const missing = error as { code?: string; url?: string };
  if (missing.code !== 'ERR_MODULE_NOT_FOUND' || missing.url !== moduleUrl.href) throw error;
  factory = options => new StdioServerTransport(options.input, options.output);
}
class BlockedOutput extends Writable {
  held = false;
  frames = 0;
  private tail = '';
  private complete: ((error?: Error) => void) | undefined;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.tail += chunk.toString();
    for (;;) {
      const newline = this.tail.indexOf('\n');
      if (newline < 0) break;
      JSON.parse(this.tail.slice(0, newline));
      this.frames++;
      this.tail = this.tail.slice(newline + 1);
    }
    if (this.held) this.complete = error => callback(error);
    else callback();
  }
  release(error?: Error): void {
    this.held = false;
    const done = this.complete;
    this.complete = undefined;
    done?.(error);
  }
}


function facts(io: Transport): NativeFacts {
  return (io as Transport & { facts(): NativeFacts }).facts();
}

test('F15 bounded safe error replacements never turn the original send into success', async () => {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      assert.ok(chunk.length <= 1024);
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  const io = factory({ input, output, limits: { maxBytes: 1024 } });
  let getterCalls = 0;
  const unsafe = {
    get privateContext(): string {
      getterCalls++;
      return 'OWNED_GETTER_CONTEXT';
    }
  };
  const cases = [
    { message: reply(7, 'OWNED_OVERSIZE_CONTEXT'.repeat(128)), code: 'STDIO_RESPONSE_TOO_LARGE' },
    { message: { jsonrpc: '2.0' as const, id: 8, result: unsafe }, code: 'STDIO_ENCODING_FAILED' }
  ];
  try {
    await io.start();
    for (const entry of cases) {
      chunks.length = 0;
      await assert.rejects(io.send(entry.message), { code: entry.code });
      const wire = Buffer.concat(chunks).toString('utf8');
      assert.ok(wire.endsWith('\n'));
      assert.ok(Buffer.byteLength(wire) <= 1024);
      const packet = JSON.parse(wire) as {
        id: number;
        error: { code: number; data: Record<string, unknown> };
      };
      assert.equal(packet.id, entry.message.id);
      assert.equal(packet.error.code, -32603);
      assert.equal(packet.error.data.code, entry.code);
      assert.equal(packet.error.data.responseDelivered, false);
      assert.equal(packet.error.data.effectsUnknown, true);
      assert.equal(packet.error.data.noAutoReplay, true);
      assert.equal(wire.includes('OWNED_OVERSIZE_CONTEXT'), false);
      assert.equal(wire.includes('OWNED_GETTER_CONTEXT'), false);
      assert.equal(facts(io).pendingSends, 0);
      assert.equal(facts(io).pendingBytes, 0);
    }
    assert.equal(getterCalls, 0);
  } finally {
    await io.close();
    input.destroy();
    output.destroy();
  }
});

test('F15 the 64-send hard cap retains a logically rejected native frame until its callback', async () => {
  const input = new PassThrough();
  const output = new BlockedOutput({ highWaterMark: 16_384 });
  output.held = true;
  const io = factory({ input, output });
  const observations: Promise<unknown>[] = [];
  try {
    await io.start();
    for (let index = 0; index < 64; index++) {
      observations.push(io.send(reply(index + 1)).then(() => 'delivered', error => error));
    }
    await until(() => output.frames === 1);
    assert.equal(facts(io).pendingSends, 64);
    await assert.rejects(io.send(reply(65)), { code: 'STDIO_OUTPUT_LIMIT' });
    const outcomes = await Promise.all(observations);
    assert.ok(outcomes.every(value => (value as { code?: string }).code === 'STDIO_OUTPUT_LIMIT'));
    assert.equal(facts(io).pendingSends, 1);
    assert.ok(facts(io).pendingBytes > 0);
    assert.equal(output.destroyed, false);
    output.release();
    await until(() => facts(io).pendingSends === 0);
    assert.equal(facts(io).pendingBytes, 0);
  } finally {
    output.release();
    await Promise.allSettled(observations);
    await io.close().catch(error => assert.equal((error as { code?: string }).code, 'STDIO_OUTPUT_LIMIT'));
    input.destroy();
    output.destroy();
  }
});

test('F15 unconfirmed shared-sink closure preserves native credits and observes late success or error', async () => {
  for (const lateError of [false, true]) {
    const input = new PassThrough();
    const output = new BlockedOutput({ autoDestroy: false });
    output.held = true;
    let fatalNotices = 0;
    const io = factory({
      input,
      output,
      onFatal: () => { fatalNotices++; },
      limits: { closeMs: 100, flushMs: 80, confirmMs: 20 }
    });
    let observation: Promise<unknown> | undefined;
    try {
      await io.start();
      observation = io.send(reply(1)).then(() => 'delivered', error => error);
      await until(() => output.frames === 1);
      await assert.rejects(io.close(), (error: unknown) => {
        const failure = error as { code: string; details: { pendingSends: number; pendingBytes: number } };
        assert.equal(failure.code, 'STDIO_OUTPUT_TIMEOUT');
        assert.equal(failure.details.pendingSends, 1);
        assert.ok(failure.details.pendingBytes > 0);
        return true;
      });
      assert.equal(fatalNotices, 1);
      assert.equal(facts(io).pendingSends, 1);
      assert.equal(output.destroyed, false);
      assert.equal(output.listenerCount('error'), 1);
      output.release(lateError ? new Error('OWNED_LATE_NATIVE_CONTEXT') : undefined);
      await until(() => facts(io).pendingSends === 0);
      assert.equal(facts(io).pendingBytes, 0);
      assert.equal((await observation as { code: string }).code, 'STDIO_OUTPUT_TIMEOUT');
      assert.equal(fatalNotices, 1);
      assert.equal(output.listenerCount('error'), 0);
      assert.equal(output.destroyed, false);
    } finally {
      output.release();
      if (observation) await observation;
      await io.close().catch(error => assert.equal((error as { code?: string }).code, 'STDIO_OUTPUT_TIMEOUT'));
      input.destroy();
      output.destroy();
    }
  }
});
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Owned stdio fixture did not settle.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
const reply = (id: number, text = 'owned') => ({ jsonrpc: '2.0' as const, id, result: { text } });

test('F15 the bounded stdio product module must be present', () => {
  assert.equal(installed, true);
});

test('F15 write(true) is not a successful send before the native callback', async () => {
  const input = new PassThrough();
  const output = new BlockedOutput({ highWaterMark: 16_384 });
  const transport = factory({ input, output });
  await transport.start();
  output.held = true;
  const sent = transport.send(reply(1));
  let settled = false;
  void sent.then(() => { settled = true; }, () => { settled = true; });
  try {
    await pause();
    assert.equal(output.frames, 1); // Sink observation, not physical delivery.
    assert.equal(settled, false);
    output.release();
    await sent;
    assert.equal(settled, true);
  } finally {
    output.release();
    await Promise.allSettled([sent]);
    await transport.close();
    input.destroy();
    output.destroy();
  }
});

test('F15 valid public requests stop within the bounded batch even inside the current input chunk', {
  timeout: 30_000
}, async () => {
  const unused = fixtureRoot('stdio-no-files', randomUUID());
  const app = createApplication({ configPath: `${unused}/config.json`, cacheRoot: `${unused}/cache` });
  const original = app.terminals.list;
  let calls = 0;
  app.terminals.list = function (...args) { calls++; return Reflect.apply(original, this, args); };
  const input = new PassThrough();
  const output = new BlockedOutput({ highWaterMark: 16_384 });
  const transport = factory({ input, output });
  await app.server.connect(transport);
  const send = (message: JSONRPCMessage) => input.write(serializeMessage(message));
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'owned-pressure', version: '1' }
    } });
    await until(() => output.frames === 1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    output.held = true;
    const requests = Array.from({ length: 1024 }, (_, i) => serializeMessage({
      jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: 'lite_ssh_terminal_list', arguments: {} }
    })).join('');
    input.write(requests);
    await pause();
    assert.ok(calls > 0);
    assert.ok(calls <= 40, 'Admission must stop, not drain all1024 requests before noticing pressure.');
    assert.equal(input.readableFlowing, false);
    assert.ok(output.writableLength <= 16_384);
    output.release();
    await until(() => output.frames === 1025);
    assert.equal(calls, 1024);
  } finally {
    output.release();
    await until(() => output.frames === 1025);
    await app.close();
    input.destroy();
    output.destroy();
  }
});

test('F15 an in-flight response retains its bytes and overflow never destroys a shared sink', async () => {
  const input = new PassThrough();
  const output = new BlockedOutput();
  const transport = factory({ input, output, limits: { maxBytes: 1024, closeMs: 100, flushMs: 80, confirmMs: 20 } });
  await transport.start();
  output.held = true;
  const first = transport.send(reply(1, 'x'.repeat(800)));
  void first.catch(() => undefined);
  try {
    await pause();
    const overflow = transport.send(reply(2, 'x'.repeat(800)));
    await assert.rejects(overflow, error => {
      assert.equal((error as Error & { code?: string }).code, 'STDIO_OUTPUT_LIMIT');
      return true;
    });
    assert.equal(output.destroyed, false);
  } finally {
    output.release();
    await Promise.allSettled([first]);
    await transport.close().catch(error => {
      assert.equal((error as Error & { code?: string }).code, 'STDIO_OUTPUT_LIMIT');
    });
    input.destroy();
    output.destroy();
  }
});

interface NativeFacts {
  writerPid?: number;
  pendingSends: number;
  pendingBytes: number;
  writerExited: boolean;
  writerClosed: boolean;
  pipeClosed: boolean;
  stopped: boolean;
  currentSequence?: number;
  currentNativeDone: boolean;
  writerExitCode?: number | null;
  writerExitSignal?: NodeJS.Signals | null;
}
interface NativeReceipt {
  stage: string;
  facts: NativeFacts;
  elapsedMs?: number;
  code?: string;
  parentPid?: number;
  utc?: string;
  owners?: string[];
  ownerCleanupHeld?: boolean;
}
async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned native stdio did not reach ${label}.`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * Run the real compiled CLI and its real writer. The child-only observer keeps
 * original method/promise identities and records bounded metadata, never wire
 * content. It is not a production patch, OS signal emulation proof, or a claim
 * that adding observers has zero timing impact. The ordinary writer does not
 * inherit it. The explicit confirmation-failure control adds a separate finite
 * keepalive hook to that one owned writer and gates one application finalizer;
 * those are fault injections, not observations of normal production timing.
 */
async function nativeFixture(holdConfirmation = false) {
  const home = fixtureRoot('stdio-native', randomUUID());
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const hook = join(home, 'observe.mjs');
  const moduleUrl = pathToFileURL(resolve('dist/mcp/stdio.js')).href;
  const delayedWriterHook = join(home, 'hold-writer.mjs');
  const writerUrl = pathToFileURL(resolve('dist/mcp/stdio-writer.js')).href;
  const terminalUrl = pathToFileURL(resolve('dist/terminal/service.js')).href;
  const transferUrl = pathToFileURL(resolve('dist/sftp/manager.js')).href;
  const poolUrl = pathToFileURL(resolve('dist/ssh/pool.js')).href;
  const mcpUrl = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js')).href;
  if (holdConfirmation) {
    // The real writer can finish every frame and EOF yet stay physically alive.
    // The production parent's existing deadline must stop this exact process.
    await fs.writeFile(delayedWriterHook, 'setTimeout(() => {}, 15_000);\n', {
      encoding: 'utf8',
      flag: 'wx'
    });
  }
  const faultInjection = holdConfirmation ? `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { TerminalService } from ${JSON.stringify(terminalUrl)};
import { TransferManager } from ${JSON.stringify(transferUrl)};
import { ConnectionPool } from ${JSON.stringify(poolUrl)};
import { McpServer } from ${JSON.stringify(mcpUrl)};
const nativeFork = childProcess.fork;
childProcess.fork = function (...args) {
  if (args[0] instanceof URL && args[0].href === ${JSON.stringify(writerUrl)}) {
    const options = { ...args[2], execArgv: ['--import', ${JSON.stringify(pathToFileURL(delayedWriterHook).href)}] };
    return Reflect.apply(nativeFork, this, [args[0], args[1], options]);
  }
  return Reflect.apply(nativeFork, this, args);
};
syncBuiltinESMExports();
let releaseOwner;
const ownerGate = new Promise(resolve => { releaseOwner = resolve; });
const disposeTerminal = TerminalService.prototype.dispose;
TerminalService.prototype.dispose = function (...args) {
  owners.push('terminal');
  const work = Reflect.apply(disposeTerminal, this, args);
  return work.then(async value => {
    ownerCleanupHeld = true;
    send({ stage: 'owner-held', facts: io?.facts(), owners: [...owners], ownerCleanupHeld });
    await ownerGate;
    ownerCleanupHeld = false;
    return value;
  });
};
for (const [prototype, name] of [[TransferManager.prototype, 'transfer'], [ConnectionPool.prototype, 'connection']]) {
  const dispose = prototype.dispose;
  prototype.dispose = function (...args) {
    owners.push(name);
    return Reflect.apply(dispose, this, args);
  };
}
const closeServer = McpServer.prototype.close;
McpServer.prototype.close = function (...args) {
  owners.push('mcp');
  const work = Reflect.apply(closeServer, this, args);
  void work.then(() => send({ stage: 'owners-complete', facts: io?.facts(), owners: [...owners], ownerCleanupHeld }, () => {
    process.removeListener('message', control);
    if (process.connected) process.disconnect();
  }), () => {});
  return work;
};
` : '';
  await fs.writeFile(hook, `import { performance } from 'node:perf_hooks';
import { BoundedStdioTransport } from ${JSON.stringify(moduleUrl)};
let io;
let firstClose;
let receiptSent = false;
const owners = [];
let ownerCleanupHeld = false;
const send = (message, done = () => {}) => {
  if (!process.connected || !process.send) { done(); return; }
  try { process.send(message, done); } catch { done(); }
};
${faultInjection}
const proto = BoundedStdioTransport.prototype;
const start = proto.start;
proto.start = function (...args) {
  io = this;
  const work = Reflect.apply(start, this, args);
  void work.then(() => send({ stage: 'ready', parentPid: process.pid, utc: new Date().toISOString(), facts: this.facts() }), () => {});
  return work;
};
const begin = proto.beginClose;
proto.beginClose = function (...args) {
  if (firstClose === undefined) firstClose = performance.now();
  return Reflect.apply(begin, this, args);
};
const close = proto.close;
proto.close = function (...args) {
  const work = Reflect.apply(close, this, args);
  const finish = error => {
    if (receiptSent) return;
    receiptSent = true;
    const allowed = ['STDIO_OUTPUT_TIMEOUT', 'STDIO_OUTPUT_LIMIT', 'STDIO_CLOSE_UNCONFIRMED', 'STDIO_WRITER_FAILED'];
    const code = error && allowed.includes(error.code) ? error.code : error ? 'UNKNOWN' : 'OK';
    send({ stage: 'closed', facts: this.facts(), elapsedMs: performance.now() - firstClose, code, owners: [...owners], ownerCleanupHeld }, () => {
      if (${holdConfirmation}) return; // Keep the owner gate controllable after logical IO failure.
      process.removeListener('message', control);
      if (process.connected) process.disconnect();
    });
  };
  void work.then(() => finish(), finish);
  return work;
};
const control = message => {
  if (message === 'snapshot' && io) send({ stage: 'snapshot', facts: io.facts(), owners: [...owners], ownerCleanupHeld });
  ${holdConfirmation ? "if (message === 'release-owner') releaseOwner();" : ''}
  if (message === 'signal') {
    process.emit('SIGTERM');
    process.emit('SIGINT');
    io?.beginClose();
    io?.beginClose();
    send({ stage: 'signal-seen', facts: io?.facts() });
    ${holdConfirmation ? 'void io?.close().catch(() => {}); // Observe public IO close independently of the held app owner.' : ''}
  }
};
process.on('message', control);
`, { encoding: 'utf8', flag: 'wx' });
  const child = fork(resolve('dist/cli.js'), [], {
    execArgv: ['--import', pathToFileURL(hook).href],
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  const observedSpawnUtc = new Date().toISOString();
  const receipts: NativeReceipt[] = [];
  child.on('message', message => {
    if (receipts.length >= 16) return;
    const receipt = message as NativeReceipt;
    if (['ready', 'closed', 'signal-seen', 'owner-held', 'owners-complete'].includes(receipt?.stage)) receipts.push(receipt);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
    child.once('exit', (code, signal) => yes({ code, signal }));
    child.once('error', () => no(new Error('Owned native stdio child could not start.')));
  });
  void exited.catch(() => undefined);
  const closed = new Promise<void>(yes => child.once('close', () => yes()));
  child.stdin!.on('error', () => undefined); // Peer shutdown can reject still-buffered legal input.
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderr.length < 1024) stderr += chunk.toString().slice(0, 1024 - stderr.length);
  });
  let initialized = false;
  let prefix = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    if (initialized) return; // Later output is neither saved nor projected.
    prefix += chunk.toString();
    const newline = prefix.indexOf('\n');
    if (newline >= 0) {
      const response = JSON.parse(prefix.slice(0, newline)) as { id?: number; result?: unknown };
      initialized = response.id === 1 && response.result !== undefined;
      prefix = '';
    }
  });
  const rpc = (message: JSONRPCMessage): void => { child.stdin!.write(serializeMessage(message)); };
  const command = (value: string): void => {
    if (child.connected) child.send(value, () => undefined);
  };
  const wait = async (check: () => boolean, ms: number, label: string, allowExited = false): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() >= deadline || !allowExited && (child.exitCode !== null || child.signalCode !== null)) {
        throw new Error(`Owned native stdio did not reach ${label}.`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let setupFailed: unknown;
  try {
    await wait(() => receipts.some(receipt => receipt.stage === 'ready'), 20_000, 'writer readiness');
    rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'owned-native-stdio', version: '1' }
    } });
    await wait(() => initialized, 5000, 'initialization');
    rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } catch (error) { setupFailed = error; }

  const finish = async (): Promise<void> => {
    // Drain before any fallback termination: a failed assertion must not leave
    // an inherited stdout pipe blocked in the grandchild. Only this exact owned
    // ChildProcess may be terminated, never a name scan or a recycled PID.
    child.stdout!.resume();
    if (holdConfirmation) command('release-owner'); // Release even after setup or assertion failure.
    child.stdin!.end();
    const errors: unknown[] = [];
    if (child.connected && !receipts.some(receipt => receipt.stage === 'ready')) child.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      command('signal');
      try { await bounded(exited, 15_000, 'teardown exit'); }
      catch (error) {
        errors.push(error);
        child.kill('SIGKILL');
        try { await bounded(exited, 5000, 'fallback exit'); } catch (failure) { errors.push(failure); }
      }
    }
    if (child.connected) child.disconnect();
    try { await bounded(closed, 5000, 'stdio close'); } catch (error) { errors.push(error); }
    const exit = await exited;
    await fs.writeFile(join(home, 'native-receipt.json'), JSON.stringify({
      parentPid: child.pid, observedSpawnUtc, exit, receipts, cleanupFailures: errors.length,
      faultInjection: holdConfirmation ? 'Owned writer finite keepalive and application terminal-finalizer gate.' : undefined,
      scope: 'Owned real Node/CLI/writer with bounded child-only metadata observers; no external SSH.'
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    assert.equal(errors.length, 0);
  };
  if (setupFailed) { await finish(); throw setupFailed; }
  return {
    child, receipts, exited, finish,
    stderr: () => stderr,
    async block(): Promise<NativeReceipt> {
      child.stdout!.pause();
      // A finite larger burst establishes real pipe pressure reliably; the
      // first1024-request native attempt did not reliably reach32 pending items.
      // The separate current-chunk conformance case deliberately stays1024.
      const requests = Array.from({ length: 4096 }, (_, index) => serializeMessage({
        jsonrpc: '2.0', id: index + 2, method: 'tools/call',
        params: { name: 'lite_ssh_terminal_list', arguments: {} }
      })).join('');
      child.stdin!.write(requests);
      // Snapshot replies while stdout remains unconsumed also prove that the
      // parent event loop remains usable after the writer encounters pressure.
      const deadline = Date.now() + 5000;
      let stableSequence: number | undefined;
      let stableSince = 0;
      while (Date.now() < deadline) {
        let observe!: (message: unknown) => void;
        const sample = new Promise<NativeReceipt>(yes => {
          observe = message => {
            const receipt = message as NativeReceipt;
            if (receipt?.stage === 'snapshot') yes(receipt);
          };
          child.on('message', observe);
          command('snapshot');
        });
        let receipt: NativeReceipt;
        try { receipt = await bounded(sample, 1000, 'responsive parent snapshot'); }
        finally { child.removeListener('message', observe); }
        // A transient queue of32 does not prove native blocking. Require the
        // same native frame to remain unacknowledged while the parent keeps
        // answering IPC and the peer never resumes stdout consumption.
        const sequence = receipt.facts.currentSequence;
        if (receipt.facts.pendingSends > 0 && !receipt.facts.currentNativeDone && sequence !== undefined) {
          if (sequence !== stableSequence) { stableSequence = sequence; stableSince = Date.now(); }
          else if (Date.now() - stableSince >= 250) { receipts.push(receipt); return receipt; }
        } else { stableSequence = undefined; stableSince = 0; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Owned native stdio did not reach blocked writer pressure.');
    },
    signal(): void { command('signal'); },
    releaseOwner(): void { command('release-owner'); },
    async receipt(stage: string, ms: number): Promise<NativeReceipt> {
      await wait(() => receipts.some(receipt => receipt.stage === stage), ms, stage);
      const receipt = receipts.find(receipt => receipt.stage === stage);
      assert.ok(receipt);
      return receipt;
    },
    async snapshot(): Promise<NativeReceipt> {
      let observe!: (message: unknown) => void;
      const work = new Promise<NativeReceipt>(yes => {
        observe = message => {
          const receipt = message as NativeReceipt;
          if (receipt?.stage === 'snapshot') yes(receipt);
        };
        child.on('message', observe);
        command('snapshot');
      });
      try { return await bounded(work, 1000, 'parent snapshot'); }
      finally { child.removeListener('message', observe); }
    },
    async result(ms: number): Promise<NativeReceipt> {
      const exit = await bounded(exited, ms, 'controlled exit');
      await wait(() => receipts.some(receipt => receipt.stage === 'closed'), 1000, 'closed metadata', true);
      const receipt = receipts.find(receipt => receipt.stage === 'closed');
      assert.ok(receipt);
      assert.equal(exit.signal, null);
      assert.equal(receipt.facts.writerExited, true);
      assert.equal(receipt.facts.writerClosed, true);
      assert.equal(receipt.facts.pipeClosed, true);
      assert.equal(receipt.facts.pendingSends, 0);
      assert.equal(receipt.facts.pendingBytes, 0);
      return receipt;
    }
  };
}


test('F15 first physical-close confirmation failure notifies CLI while application cleanup is still held', {
  timeout: 60_000
}, async () => {
  const f = await nativeFixture(true);
  try {
    const idleDeadline = Date.now() + 5000;
    let idle = await f.snapshot();
    while (idle.facts.pendingSends && Date.now() < idleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      idle = await f.snapshot();
    }
    assert.equal(idle.facts.pendingSends, 0);
    assert.equal(idle.facts.pendingBytes, 0);
    f.signal();
    await f.receipt('owner-held', 8000);
    const failure = await f.receipt('closed', 8000);
    assert.equal(failure.code, 'STDIO_CLOSE_UNCONFIRMED');
    assert.equal(failure.ownerCleanupHeld, true);
    assert.deepEqual(failure.owners, ['terminal', 'transfer']);
    assert.ok(failure.elapsedMs! >= 4000 && failure.elapsedMs! < 8000);

    // Logical failure is deliberately observed before releasing the app owner.
    // Wait separately for the exact writer's real exit/close/pipe events; the
    // SIGKILL attempt at the deadline is not substituted for physical proof.
    const physicalDeadline = Date.now() + 2000;
    let physical = await f.snapshot();
    while (!(physical.facts.writerExited && physical.facts.writerClosed && physical.facts.pipeClosed)
      && Date.now() < physicalDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      physical = await f.snapshot();
    }
    assert.equal(physical.facts.writerExited, true);
    assert.equal(physical.facts.writerClosed, true);
    assert.equal(physical.facts.pipeClosed, true);
    assert.equal(physical.facts.writerExitSignal, 'SIGKILL');
    assert.equal(physical.ownerCleanupHeld, true);
    f.receipts.push(physical);
    f.releaseOwner();
    const completed = await f.receipt('owners-complete', 5000);
    const exit = await bounded(f.exited, 5000, 'post-confirmation application exit');
    assert.deepEqual(completed.owners, ['terminal', 'transfer', 'connection', 'mcp']);
    assert.equal(completed.ownerCleanupHeld, false);
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 1);
    assert.equal(f.stderr(), 'MCP stdio transport failed.\n');
  } finally {
    await f.finish();
  }
});

test('F15 real native writer retires on ordinary EOF after a delivered initialization', { timeout: 60_000 }, async () => {
  const f = await nativeFixture();
  try {
    assert.equal(typeof f.receipts[0]?.facts.writerPid, 'number');
    f.child.stdin!.end();
    const closed = await f.result(10_000);
    assert.equal(closed.code, 'OK');
    assert.equal(closed.facts.writerExitCode, 0);
    assert.equal(closed.facts.writerExitSignal, null);
    assert.equal(f.child.exitCode, 0);
    assert.equal(f.stderr(), '');
  } finally { await f.finish(); }
});

test('F15 blocked native stdout does not block emitted SIGTERM or renew duplicate-stop deadlines', { timeout: 60_000 }, async () => {
  const f = await nativeFixture();
  try {
    const blocked = await f.block();
    assert.ok(blocked.facts.pendingBytes > 0);
    assert.ok(blocked.facts.pendingBytes <= 64 * 1024 * 1024);
    f.signal();
    const closed = await f.result(10_000);
    assert.equal(closed.code, 'STDIO_OUTPUT_TIMEOUT');
    assert.ok(closed.elapsedMs! < 8000);
    assert.equal(f.child.exitCode, 1);
    assert.equal(f.stderr(), 'MCP stdio transport failed.\n');
  } finally { await f.finish(); }
});

test('F15 blocked native stdout with hidden EOF still retires the exact writer under the oldest-send watchdog', {
  timeout: 65_000
}, async () => {
  const f = await nativeFixture();
  try {
    await f.block();
    const endedAt = Date.now();
    f.child.stdin!.end();
    const closed = await f.result(38_000);
    assert.equal(closed.code, 'STDIO_OUTPUT_TIMEOUT');
    assert.ok(Date.now() - endedAt < 38_000);
    assert.equal(f.child.exitCode, 1);
    assert.equal(f.stderr(), 'MCP stdio transport failed.\n');
    // An EOF hidden behind paused input is not falsely measured as a visible
    // EOF with a five-second whole-application deadline.
  } finally { await f.finish(); }
});
