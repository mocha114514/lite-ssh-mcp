import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import type { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';
import type { ConnectionLease } from '../src/core/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import type { ConnectionPool } from '../src/ssh/pool.js';
import type { TransferManager } from '../src/sftp/manager.js';
import { TerminalService } from '../src/terminal/service.js';
import { fixtureRoot } from './helpers/workspace.js';

const LIMIT = 64;
const target = { ip: '127.0.0.1', port: 22, codename: 'budget_probe' };
type Reply = Record<string, unknown>;

/** A real Session/Recorder/queue behind public MCP, with no network or user HOME. */
class BudgetChannel extends PassThrough {
  readonly stderr = new PassThrough();
  readonly windows: Array<{ rows: number; cols: number }> = [];
  private readonly outbound: string[] = [];
  private stage = 0;
  failWindow = false;

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outbound.push(chunk.toString('utf8'));
    callback();
    const sent = this.outbound.join('');
    const nonce = /LSSH;([A-Za-z0-9_.-]+);STTY/.exec(sent)?.[1];
    if (nonce && this.stage === 0) {
      this.stage = 1;
      queueMicrotask(() => this.emit('data', Buffer.from(
        encodeMarkerOsc(nonce, 'STTY;0:0:0:0') + encodeMarkerOsc(nonce, 'PROBE;bash')
      )));
    } else if (nonce && this.stage === 1 && sent.includes('__lssh_')) {
      this.stage = 2;
      queueMicrotask(() => this.emit('data', Buffer.from(encodeMarkerOsc(nonce, 'READY;bash'))));
    }
  }

  setWindow(rows: number, cols: number): void {
    if (this.failWindow) throw new LiteSshError('TERMINAL_RESIZE_FAILED', 'Synthetic owned window failure.');
    this.windows.push({ rows, cols });
  }

  close(): void {
    this.end();
    this.stderr.end();
    this.emit('close');
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Owned budget fixture did not reach ${label}.`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Quota must reject before the cache gate is released.')), 3000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectLimit(work: Promise<Reply>): Promise<void> {
  const result = await within(work);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESOURCE_LIMIT');
}

async function fixture() {
  const root = fixtureRoot('session-budget', randomUUID());
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'cache.log');
  await fs.writeFile(path, '', { flag: 'wx', mode: 0o600 });
  const identity = { ...target, username: 'synthetic' };
  let gate: Promise<void> | undefined;
  let complete: (() => void) | undefined;
  let writeBlocked = false;
  let failDisk = false;
  let handleClosed = false;
  let leaseReleases = 0;
  const handle = {
    stat: () => fs.stat(path, { bigint: true }),
    async write(buffer: Buffer, _offset: number, length: number) {
      if (gate) { writeBlocked = true; await gate; }
      if (failDisk) throw Object.assign(new Error('Synthetic cache write failure.'), { code: 'EIO' });
      return { bytesWritten: length, buffer };
    },
    async close() { handleClosed = true; }
  } as unknown as FileHandle;
  const recorder = await ReadableRecorder.createWithHandle(handle, path, identity);
  // Read-only queue observation proves the calls have actually reached the
  // slow native-work boundary. No production method/counter is patched.
  const queue = (recorder as unknown as { queue: { waiters: unknown[] } }).queue;
  const channel = new BudgetChannel();
  const lease = {
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    client: { shell: (_window: unknown, callback: (error: null, stream: BudgetChannel) => void) => callback(null, channel) },
    release: async () => { leaseReleases++; }
  } as unknown as ConnectionLease;
  const pool = { acquire: async () => lease, dispose: async () => undefined } as unknown as ConnectionPool;
  const terminals = new TerminalService(pool, {
    recorder, cols: 3, rows: 3, initializationTimeoutMs: 4000, writeWaitMs: 250
  });
  const server = createMcpServer({} as ConfigStore, pool, terminals, {} as TransferManager);
  const client = new Client({ name: 'owned-bounded-terminal-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const pending = new Set<Promise<Reply>>();
  const call = (name: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply> => {
    const work = client.callTool({
      name: `lite_ssh_terminal_${name}`,
      arguments: { ...target, ...fields }
    }, undefined, { signal }).then(result => result.structuredContent as Reply);
    pending.add(work);
    // Attach immediately, including aborted SDK requests; don't turn an
    // expected rejection into an unhandled rejection during fixture teardown.
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const opened = await call('open', { username: identity.username });
  assert.equal(opened.ok, true);
  const protocol = server.server as unknown as { _requestHandlerAbortControllers: Map<unknown, unknown> };
  const release = (): void => {
    const done = complete;
    gate = undefined;
    complete = undefined;
    done?.();
  };
  return {
    call, channel,
    flushWaiters: () => queue.waiters.length,
    activeHandlers: () => protocol._requestHandlerAbortControllers.size,
    async blockDisk(): Promise<void> {
      writeBlocked = false;
      gate = new Promise<void>(resolve => { complete = resolve; });
      recorder.recordLine({ text: 'owned disk gate', buffer: 'normal', wrapped: false });
      await until(() => writeBlocked, 'blocked cache write');
    },
    failDisk(): void { failDisk = true; },
    release,
    async close(): Promise<void> {
      release();
      await Promise.allSettled([...pending]);
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); } catch (error) { failures.push(error); }
      };
      await attempt(async () => {
        const closed = await call('close');
        // Only the deliberate disk-failure control expects recording loss.
        if (failDisk) {
          assert.equal(closed.ok, false);
          assert.equal(closed.code, 'CACHE_WRITE_FAILED');
          assert.equal(closed.cacheMayBeIncomplete, true);
        } else assert.equal(closed.ok, true);
        assert.equal(closed.cacheRemoved, true);
        assert.equal(closed.localTerminalClosed, true);
        assert.equal(closed.remoteChannelCleanupConfirmed, true);
      });
      await attempt(() => client.close());
      await attempt(() => terminals.dispose(false));
      await attempt(() => server.close());
      assert.equal(handleClosed, true);
      assert.equal(leaseReleases, 1);
      await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
      if (failures.length) throw new AggregateError(failures, 'Owned terminal budget fixture cleanup failed.');
    }
  };
}

const resize = (f: Awaited<ReturnType<typeof fixture>>, index = 0) =>
  f.call('resize', { cols: index % 2 ? 3 : 2, rows: index % 2 ? 3 : 2 });
const write = (f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) =>
  f.call('write', { actions: [{ type: 'text', text: 'x' }] }, signal);

// Old code must be red because these overflow requests wait at the disk gate
// rather than returning RESOURCE_LIMIT. finally always releases the gate;
// controls prove retirement, instance-bound cleanup and the existing write cap.
test('F13 public reads reject a 65th retained wait before flush; rejection consumes no slot', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const reads = Array.from({ length: LIMIT }, () => f.call('read'));
    await until(() => f.flushWaiters() === LIMIT, '64 read flush waiters');
    await expectLimit(f.call('read'));
    await expectLimit(f.call('read'));
    assert.equal(f.flushWaiters(), LIMIT);
    f.release();
    assert.ok((await Promise.all(reads)).every(result => result.ok === true));
    assert.equal((await f.call('read')).ok, true);
  } finally { await f.close(); }
});

test('F13 public resizes bound queued work and reject overflow before an extra window effect', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const work = Array.from({ length: LIMIT }, (_, index) => resize(f, index));
    await until(() => f.activeHandlers() === LIMIT && f.channel.windows.length === 1, '64 queued resizes');
    await expectLimit(resize(f));
    assert.equal(f.channel.windows.length, 1);
    f.release();
    assert.ok((await Promise.all(work)).every(result => result.ok === true));
    assert.equal(f.channel.windows.length, LIMIT);
    assert.equal((await resize(f)).ok, true);
    assert.equal(f.channel.windows.length, LIMIT + 1);
  } finally { await f.close(); }
});

test('F13 writes and resizes share retained-input credits while the read budget is independent', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const writes = Array.from({ length: LIMIT }, () => write(f));
    await until(() => f.activeHandlers() === LIMIT && f.flushWaiters() === 1, '64 retained writes');
    await expectLimit(resize(f));
    assert.equal(f.channel.windows.length, 0);
    const read = f.call('read');
    await until(() => f.flushWaiters() === 2, 'independent read waiter');
    f.release();
    assert.ok((await Promise.all(writes)).every(result => result.ok === true));
    assert.equal((await read).ok, true);
    assert.equal((await resize(f)).ok, true);
  } finally { await f.close(); }
});

test('F13 a full resize queue also blocks new writes without consuming a write observer', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const work = Array.from({ length: LIMIT }, (_, index) => resize(f, index));
    await until(() => f.activeHandlers() === LIMIT && f.channel.windows.length === 1, 'full resize queue');
    await expectLimit(write(f));
    f.release();
    await Promise.all(work);
    assert.equal((await write(f)).ok, true);
  } finally { await f.close(); }
});

test('F13 cancelled public read observers retain credits until their real flush work retires', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const controllers = Array.from({ length: LIMIT }, () => new AbortController());
    const reads = controllers.map(controller => f.call('read', {}, controller.signal).catch(error => error));
    await until(() => f.flushWaiters() === LIMIT, '64 retained cancellable reads');
    for (const controller of controllers) controller.abort();
    await Promise.all(reads);
    assert.equal(f.flushWaiters(), LIMIT);
    await expectLimit(f.call('read'));
    f.release();
    await until(() => f.activeHandlers() === 0, 'cancelled read retirement');
    assert.equal((await f.call('read')).ok, true);
  } finally { await f.close(); }
});

test('F13 cancelled resize observations do not borrow back queued physical window work', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const controllers = Array.from({ length: LIMIT }, () => new AbortController());
    const work = controllers.map((controller, index) => f.call('resize', {
      cols: index % 2 ? 3 : 2, rows: index % 2 ? 3 : 2
    }, controller.signal).catch(error => error));
    await until(() => f.activeHandlers() === LIMIT && f.channel.windows.length === 1, '64 cancellable resizes');
    for (const controller of controllers) controller.abort();
    await Promise.all(work);
    await expectLimit(resize(f));
    await expectLimit(write(f));
    f.release();
    await until(() => f.activeHandlers() === 0, 'cancelled resize retirement');
    assert.equal(f.channel.windows.length, LIMIT);
    assert.equal((await resize(f)).ok, true);
  } finally { await f.close(); }
});

test('F13 cache failures retire all read credits without hiding the recording failure', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const reads = Array.from({ length: LIMIT }, () => f.call('read'));
    await until(() => f.flushWaiters() === LIMIT, '64 failing read flushes');
    f.failDisk();
    f.release();
    assert.ok((await Promise.all(reads)).every(result => result.code === 'CACHE_WRITE_FAILED'));
    const retry = await Promise.all(Array.from({ length: LIMIT }, () => f.call('read')));
    assert.ok(retry.every(result => result.code === 'CACHE_WRITE_FAILED'));
  } finally { await f.close(); }
});

test('F13 resize exceptions retire credits, allowing repeated failures then a healthy control', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    f.channel.failWindow = true;
    for (let index = 0; index < LIMIT * 2; index++) {
      assert.equal((await resize(f, index)).code, 'TERMINAL_RESIZE_FAILED');
    }
    f.channel.failWindow = false;
    assert.equal((await resize(f)).ok, true);
    assert.equal(f.channel.windows.length, 1);
  } finally { await f.close(); }
});

test('F13 control: the existing 64-write cap is preserved and retires after queued sends settle', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const work = Array.from({ length: LIMIT }, () => write(f));
    await until(() => f.activeHandlers() === LIMIT && f.flushWaiters() === 1, '64 existing write credits');
    await expectLimit(write(f));
    f.release();
    assert.ok((await Promise.all(work)).every(result => result.ok === true));
    assert.equal((await write(f)).ok, true);
  } finally { await f.close(); }
});

test('F13 mixed 32 writes plus 32 resizes share one total-64 work budget', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const writes = Array.from({ length: LIMIT / 2 }, () => write(f));
    const resizes = Array.from({ length: LIMIT / 2 }, (_, index) => resize(f, index));
    await until(() => f.activeHandlers() === LIMIT && f.flushWaiters() === 1, 'mixed retained input work');
    await expectLimit(write(f));
    await expectLimit(resize(f));
    assert.equal(f.channel.windows.length, 0);
    f.release();
    assert.ok((await Promise.all([...writes, ...resizes])).every(result => result.ok === true));
    assert.equal(f.channel.windows.length, LIMIT / 2);
    assert.equal((await resize(f)).ok, true);
  } finally { await f.close(); }
});

test('F13 cancelled write observers cannot borrow their still-retained work credits for resize', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await f.blockDisk();
    const controllers = Array.from({ length: LIMIT }, () => new AbortController());
    const writes = controllers.map(controller => write(f, controller.signal).catch(error => error));
    await until(() => f.activeHandlers() === LIMIT && f.flushWaiters() === 1, '64 cancellable retained writes');
    for (const controller of controllers) controller.abort();
    await Promise.all(writes);
    await expectLimit(resize(f));
    await expectLimit(write(f));
    assert.equal(f.channel.windows.length, 0);
    f.release();
    await until(() => f.activeHandlers() === 0, 'cancelled write retirement');
    assert.equal((await resize(f)).ok, true);
    assert.equal(f.channel.windows.length, 1);
  } finally { await f.close(); }
});
