import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import type { ConfigStore } from '../src/config/store.js';
import type { ConnectionLease } from '../src/core/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import type { ConnectionPool } from '../src/ssh/pool.js';
import type { TransferManager } from '../src/sftp/manager.js';
import { TerminalService } from '../src/terminal/service.js';
import { fixtureRoot } from './helpers/workspace.js';

type Reply = Record<string, unknown>;
const target = { ip: '127.0.0.1', port: 22, codename: 'close_budget' };
class OwnedChannel extends PassThrough {
  readonly stderr = new PassThrough();
  private sent = '';
  private stage = 0;
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.sent += chunk.toString();
    callback();
    const nonce = /LSSH;([A-Za-z0-9_.-]+);STTY/.exec(this.sent)?.[1];
    if (nonce && this.stage === 0) {
      this.stage = 1;
      queueMicrotask(() => this.emit('data', Buffer.from(
        encodeMarkerOsc(nonce, 'STTY;0:0:0:0') + encodeMarkerOsc(nonce, 'PROBE;bash')
      )));
    } else if (nonce && this.stage === 1 && this.sent.includes('__lssh_')) {
      this.stage = 2;
      queueMicrotask(() => this.emit('data', Buffer.from(encodeMarkerOsc(nonce, 'READY;bash'))));
    }
  }
  close(): void { this.end(); this.stderr.end(); this.emit('close'); }
  setWindow(): void {}
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + (process.platform === 'win32' ? 15_000 : 5000);
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Owned close fixture did not reach its gate.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function quick<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Quota must reject before the close gate is released.')), 3000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function fixture() {
  const root = fixtureRoot('terminal-close-budget', randomUUID());
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, 'owned.log');
  const native = await fs.open(path, 'wx+', 0o600);
  let unblock!: () => void;
  let gate: Promise<void> | undefined;
  let blocked = false;
  let nativeCloses = 0;
  let releases = 0;
  const handle = {
    stat: (...args: Parameters<FileHandle['stat']>) => native.stat(...args),
    async write(buffer: Buffer, offset: number, length: number, position: number | null) {
      if (gate) { blocked = true; await gate; }
      return native.write(buffer, offset, length, position);
    },
    async close() { await native.close(); nativeCloses++; }
  } as unknown as FileHandle;
  const recorder = await ReadableRecorder.createWithHandle(handle, path, { ...target, username: 'synthetic' });
  const channel = new OwnedChannel();
  const lease = { target: { ...target, username: 'synthetic' },
    client: { shell: (_options: unknown, callback: (error: null, stream: OwnedChannel) => void) => callback(null, channel) },
    release: async () => { releases++; }
  } as unknown as ConnectionLease;
  const pool = { acquire: async () => lease, dispose: async () => undefined } as unknown as ConnectionPool;
  const service = new TerminalService(pool, { recorder, cols: 3, rows: 3, initializationTimeoutMs: 4000 });
  const server = createMcpServer({} as ConfigStore, pool, service, {} as TransferManager);
  const client = new Client({ name: 'owned-public-close-budget', version: '1' });
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(transport);
    await client.connect(peer);
  } catch (primary) {
    await Promise.allSettled([service.dispose(false), client.close(), server.close()]);
    if (nativeCloses === 0) await native.close();
    throw primary;
  }
  const pending = new Set<Promise<Reply>>();
  const call = (name: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply> => {
    const work = client.callTool({ name: `lite_ssh_terminal_${name}`, arguments: { ...target, ...fields } },
      undefined, { signal }).then(result => result.structuredContent as Reply);
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  try {
    assert.equal((await call('open', { username: 'synthetic' })).ok, true);
  } catch (primary) {
    await Promise.allSettled([service.dispose(false), client.close(), server.close()]);
    if (nativeCloses === 0) await native.close();
    throw primary;
  }
  const queue = (recorder as unknown as { queue: { waiters: unknown[] } }).queue;
  const protocol = server.server as unknown as { _requestHandlerAbortControllers: Map<unknown, unknown> };
  const release = (): void => { gate = undefined; unblock?.(); };
  return {
    call, service,
    handlers: () => protocol._requestHandlerAbortControllers.size,
    waiters: () => queue.waiters.length,
    release,
    async block(): Promise<void> {
      gate = new Promise<void>(resolve => { unblock = resolve; });
      recorder.recordLine({ text: 'owned close gate', buffer: 'normal', wrapped: false });
      await until(() => blocked);
    },
    async finish(): Promise<void> {
      release();
      await Promise.allSettled([...pending]);
      const failures: unknown[] = [];
      for (const owner of [() => service.dispose(false), () => client.close(), () => server.close()]) {
        try { await owner(); } catch (error) { failures.push(error); }
      }
      // A failed setup/assertion must not leave this fixture's actual FD open.
      if (nativeCloses === 0) {
        try { await native.close(); nativeCloses++; } catch (error) { failures.push(error); }
      }
      assert.equal(nativeCloses, 1);
      assert.equal(releases, 1);
      assert.equal(channel.destroyed || channel.readableEnded, true);
      await assert.rejects(fs.lstat(path), { code: 'ENOENT' });
      assert.equal(failures.length, 0);
    }
  };
}

test('F15 public close64 rejects the 65th caller before shared-owner retirement', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    await f.block();
    const closing = Array.from({ length: 64 }, () => f.call('close'));
    await until(() => f.handlers() >= 64 && f.waiters() >= 1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await quick(f.call('close'));
      assert.equal(result.ok, false);
      assert.equal(result.code, 'RESOURCE_LIMIT');
    }
    const absent = await quick(f.call('close', { codename: 'not_present' }));
    assert.equal(absent.code, 'TERMINAL_NOT_FOUND');
    f.release();
    const results = await Promise.all(closing);
    assert.equal(results.every(result => result.ok === true && result.cacheRemoved === true), true);
    await until(() => f.handlers() === 0);
    assert.equal((await f.call('close')).code, 'TERMINAL_NOT_FOUND');
  } finally { await f.finish(); }
});

test('F15 cancelling64 SDK close observations cannot return their real close credits', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    await f.block();
    const controls = Array.from({ length: 64 }, () => new AbortController());
    const reasons = controls.map(() => new McpError(ErrorCode.RequestTimeout, 'Owned close observation stopped.'));
    const closing = controls.map(controller => f.call('close', {}, controller.signal));
    await until(() => f.handlers() >= 64 && f.waiters() >= 1);
    controls.forEach((controller, index) => controller.abort(reasons[index]));
    const observations = await Promise.allSettled(closing);
    observations.forEach((result, index) => {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.equal(result.reason, reasons[index]);
    });
    assert.equal((await quick(f.call('close'))).code, 'RESOURCE_LIMIT');
    f.release();
    await until(() => f.handlers() === 0);
  } finally { await f.finish(); }
});

test('F15 saturated public-close credits do not block reads or owner disposal', { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    await f.block();
    const closing = Array.from({ length: 64 }, () => f.call('close'));
    await until(() => f.handlers() >= 64 && f.waiters() >= 1);
    const reading = f.call('read');
    await until(() => f.waiters() >= 2);
    let disposed = false;
    const disposing = f.service.dispose(false).then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    f.release();
    await disposing;
    assert.equal(disposed, true);
    assert.equal((await reading).code === 'RESOURCE_LIMIT', false);
    assert.equal((await Promise.all(closing)).every(result => result.ok === true), true);
  } finally { await f.finish(); }
});
