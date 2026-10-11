import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import type { EventEmitter } from 'node:events';
import type { Client as SshClient } from 'ssh2';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { LiteSshError } from '../src/core/errors.js';
import type { ConnectionLease, TerminalIdentity } from '../src/core/types.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { TerminalSession } from '../src/terminal/session.js';

const identity: TerminalIdentity = {
  ip: '127.0.0.1',
  port: 22,
  username: 'synthetic',
  codename: 'recording_close_regression',
};

class ScriptedChannel extends PassThrough {
  readonly stderr = new PassThrough({ emitClose: false });
  readonly outbound: string[] = [];
  private probed = false;
  private ready = false;
  private nonce = '';
  autoCloseOnDestroy = true;

  constructor(private readonly shell = 'bash') {
    super({ emitClose: false });
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const packet = chunk.toString('utf8');
    this.outbound.push(packet);
    callback();
    const match = /LSSH;([A-Za-z0-9_.-]+);STTY/u.exec(packet);
    if (match && !this.probed) {
      this.probed = true;
      this.nonce = match[1]!;
      queueMicrotask(() =>
        this.emit(
          'data',
          Buffer.from(
            encodeMarkerOsc(this.nonce, 'STTY;0:0:0:0') +
              encodeMarkerOsc(this.nonce, `PROBE;${this.shell}`),
          ),
        ),
      );
    } else if (this.probed && !this.ready && packet.includes('__lssh_')) {
      this.ready = true;
      queueMicrotask(() =>
        this.emit('data', Buffer.from(encodeMarkerOsc(this.nonce, 'READY;bash'))),
      );
    }
  }

  close(): void {
    this.end();
    this.stderr.end();
    this.emit('close');
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    super._destroy(error, callback);
    if (this.autoCloseOnDestroy) {
      this.emit('close');
    }
  }
}

interface GatedHandleFixture {
  handle: FileHandle;
  hold(): void;
  release(): void;
  failWrites(): void;
  readonly faultWrites: number;
  readonly totalWrites: number;
  readonly handleClosed: boolean;
}

function createGatedHandle(path: string): GatedHandleFixture {
  let gate: Promise<void> | undefined;
  let unblock: (() => void) | undefined;
  let failing = false;
  let closed = false;
  let faultWrites = 0;
  let totalWrites = 0;

  const handle = {
    stat: async () => fs.stat(path, { bigint: true }),
    write: async (_buffer: Buffer, _offset: number, length: number) => {
      totalWrites++;
      if (gate) await gate;
      if (failing) {
        faultWrites++;
        throw Object.assign(new Error('Synthetic disk write EIO failure'), { code: 'EIO' });
      }
      return { bytesWritten: length };
    },
    close: async () => {
      closed = true;
    },
  } as unknown as FileHandle;

  return {
    handle,
    hold: () => {
      gate ??= new Promise<void>(resolve => {
        unblock = resolve;
      });
    },
    release: () => {
      const u = unblock;
      gate = undefined;
      unblock = undefined;
      u?.();
    },
    failWrites: () => {
      failing = true;
    },
    get faultWrites() {
      return faultWrites;
    },
    get totalWrites() {
      return totalWrites;
    },
    get handleClosed() {
      return closed;
    },
  };
}

// 1. 首次closing发生: closing armed when output blocked then tail write EIO
test('首次closing发生: closing tail write EIO preserves physical facts and surfaces CACHE_WRITE_FAILED', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-tail-eio-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    // Hold output writes in queue
    gated.hold();
    channel.emit('data', Buffer.from('output before closing\r\n'));
    // Arm tail write failure then release gate so subsequent write throws EIO
    gated.failWrites();
    gated.release();

    const result = await session.close();

    assert.ok(gated.faultWrites > 0, 'actual fault writes count must be > 0');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CACHE_WRITE_FAILED');
    assert.equal(result.state, 'closed');
    assert.equal(result.localTerminalClosed, true);
    assert.equal(result.remoteChannelCleanupConfirmed, true);
    assert.equal(result.cacheRemoved, true);
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.equal(result.recordingErrorCode, 'CACHE_WRITE_FAILED');
    assert.equal(result.reason, 'EIO');
    assert.ok(typeof result.droppedChunks === 'number' && result.droppedChunks > 0);
    assert.ok(typeof result.droppedBytes === 'number' && result.droppedBytes > 0);
    assert.equal(result.cachePath, cachePath);
    assert.deepEqual(result.terminal, identity);
    assert.equal(gated.handleClosed, true);
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 2. prior recording failure: recording failure prior to close
test('prior recording failure: prior recording write failure retains primary CACHE_WRITE_FAILED and loss metrics through completed close', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-prior-fail-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    // Arm failure before writing so data processing triggers genuine EIO
    gated.failWrites();
    channel.emit('data', Buffer.from('output triggering prior failure\r\n'));
    await session.read().catch(() => undefined);
    assert.ok(gated.faultWrites > 0, 'actual fault writes count must be > 0');

    const result = await session.close();

    assert.equal(result.ok, false);
    assert.equal(result.code, 'CACHE_WRITE_FAILED');
    assert.equal(result.state, 'closed');
    assert.equal(result.localTerminalClosed, true);
    assert.equal(result.remoteChannelCleanupConfirmed, true);
    assert.equal(result.cacheRemoved, true);
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.equal(result.recordingErrorCode, 'CACHE_WRITE_FAILED');
    assert.equal(result.reason, 'EIO');
    assert.ok(typeof result.droppedChunks === 'number' && result.droppedChunks > 0);
    assert.ok(typeof result.droppedBytes === 'number' && result.droppedBytes > 0);
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 3. 重复关闭: idempotent repeated close preserves identical facts
test('重复关闭: repeated close is idempotent, preserves identical failure facts and promise reference', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-repeat-close-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    gated.hold();
    channel.emit('data', Buffer.from('output for repeat close test\r\n'));
    gated.failWrites();
    gated.release();

    const firstPromise = session.close();
    const secondPromise = session.close();
    assert.equal(firstPromise, secondPromise, 'concurrent calls must return identical promise reference');

    const firstResult = await firstPromise;
    const thirdResult = await session.close();

    assert.ok(gated.faultWrites > 0, 'actual fault writes count must be > 0');
    assert.deepEqual(firstResult, thirdResult, 'subsequent close calls must return identical failure facts');
    assert.equal(firstResult.ok, false);
    assert.equal(firstResult.code, 'CACHE_WRITE_FAILED');
    assert.equal(firstResult.state, 'closed');
    assert.equal(firstResult.cacheRemoved, true);
    assert.equal(firstResult.cacheMayBeIncomplete, true);
    assert.equal(firstResult.recordingErrorCode, 'CACHE_WRITE_FAILED');
    assert.equal(firstResult.reason, 'EIO');
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 4. 正常无loss: clean close without error
test('正常无loss: normal close without loss returns ok: true, state: closed, cacheRemoved: true and no error codes', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-normal-close-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    const result = await session.close();

    assert.equal(gated.faultWrites, 0, 'no fault writes must occur during normal close');
    assert.equal(result.ok, true);
    assert.equal(result.state, 'closed');
    assert.equal(result.localTerminalClosed, true);
    assert.equal(result.remoteChannelCleanupConfirmed, true);
    assert.equal(result.cacheRemoved, true);
    assert.equal(result.code, undefined);
    assert.equal(result.recordingErrorCode, undefined);
    assert.equal(result.cacheMayBeIncomplete, undefined);
    assert.equal(result.cleanupError, undefined);
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 5. 清理另失败并存不覆盖主因
test('清理另失败并存不覆盖主因: tail recording failure coexists with connection lease release failure without overwriting CACHE_WRITE_FAILED', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-coexist-lease-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => {
      throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic lease release failure.');
    },
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    gated.hold();
    channel.emit('data', Buffer.from('output for lease failure coexistence\r\n'));
    gated.failWrites();
    gated.release();

    const result = await session.close();

    assert.ok(gated.faultWrites > 0, 'actual fault writes count must be > 0');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CACHE_WRITE_FAILED', 'primary error code must remain CACHE_WRITE_FAILED');
    assert.equal(result.recordingErrorCode, 'CACHE_WRITE_FAILED');
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.equal(result.reason, 'EIO');
    assert.equal(result.connectionCleanupConfirmed, false, 'connection cleanup failure must be reported');
    assert.equal(result.connectionCleanupErrorCode, 'CONNECTION_CLEANUP_FAILED');
    assert.equal(result.cacheRemoved, true);
    assert.equal(result.state, 'closed');
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('清理另失败并存不覆盖主因: tail recording failure coexists with unconfirmed remote channel closure keeping state: error', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-coexist-timeout-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  // Override channel close so it never emits close, and suppress autoClose on destroy
  channel.close = () => { /* simulate hung remote channel */ };
  channel.autoCloseOnDestroy = false;

  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 50,
    writeWaitMs: 20,
  });

  try {
    gated.hold();
    channel.emit('data', Buffer.from('output for channel unconfirmed coexistence\r\n'));
    gated.failWrites();
    gated.release();

    const result = await session.close();

    assert.ok(gated.faultWrites > 0, 'actual fault writes count must be > 0');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CACHE_WRITE_FAILED', 'primary error code must remain CACHE_WRITE_FAILED');
    assert.equal(result.state, 'error', 'unconfirmed channel closure must result in state: error');
    assert.equal(result.remoteChannelCleanupConfirmed, false);
    assert.equal(result.recordingErrorCode, 'CACHE_WRITE_FAILED');
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.equal(result.reason, 'EIO');
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 6. 对照回归: 自然EOF后正常close返回ok: true
test('自然EOF后正常close对照: clean remote exit followed by close returns ok: true', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-eof-clean-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    // Simulate remote PTY natural exit: emit end on streams and close event
    channel.emit('end');
    channel.stderr.emit('end');
    channel.emit('close');

    const result = await session.close();

    assert.equal(gated.faultWrites, 0, 'clean exit must produce no fault writes');
    assert.equal(result.ok, true, 'natural remote EOF must not fail the subsequent clean close');
    assert.equal(result.state, 'closed');
    assert.equal(result.localTerminalClosed, true);
    assert.equal(result.remoteChannelCleanupConfirmed, true);
    assert.equal(result.cacheRemoved, true);
    assert.equal(result.code, undefined);
    assert.equal(result.recordingErrorCode, undefined);
    assert.equal(result.cacheMayBeIncomplete, undefined);
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

// 7. 回归: dispose callback抛错时最终结果为ok: false
test('dispose callback抛错回归: late dispose listener failure marks result ok: false and code TERMINAL_CLEANUP_FAILED', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'lite-ssh-dispose-throw-'));
  const cachePath = join(root, 'cache.log');
  await fs.writeFile(cachePath, '', { flag: 'wx' });
  const gated = createGatedHandle(cachePath);

  const recorder = await ReadableRecorder.createWithHandle(gated.handle, cachePath, identity);
  const channel = new ScriptedChannel();
  const lease: ConnectionLease = {
    client: { shell: (_w: unknown, cb: (e: null, s: ScriptedChannel) => void) => cb(null, channel) } as unknown as SshClient,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };

  const session = await TerminalSession.open(lease, identity, {
    recorder,
    initializationTimeoutMs: 1000,
    writeWaitMs: 200,
  });

  try {
    // Attach throwing listener to internal events emitter
    (session as unknown as { events: EventEmitter }).events.on('dispose', () => {
      throw new Error('synthetic dispose callback explosion');
    });

    const result = await session.close();

    assert.equal(result.ok, false, 'dispose callback error must mark result ok: false');
    assert.equal(result.code, 'TERMINAL_CLEANUP_FAILED');
    assert.equal(result.state, 'closed');
    assert.equal(result.localTerminalClosed, true);
    assert.equal(result.cacheRemoved, true);
  } finally {
    channel.destroy();
    channel.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
