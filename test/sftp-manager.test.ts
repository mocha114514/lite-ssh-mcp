import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TransferManager } from '../src/sftp/manager.js';
import { LocalFileSystem } from '../src/sftp/local.js';
import type { ReadHandle } from '../src/sftp/filesystem.js';
import { createTransferFixture, MappedRemote } from './helpers/sftp.js';

const base = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'sftp-manager', `${process.pid}-${Date.now()}`);
let serial = 0;
const target = { ip: '127.0.0.1', port: 2222, username: 'synthetic' };
async function fixture() { return createTransferFixture(path.join(base, String(++serial))); }
async function terminal(manager: TransferManager, id: string) {
  for (let i = 0; i < 250; i++) {
    const status = manager.status(id);
    if (status.stopped === true) return status;
    await sleep(10);
  }
  assert.fail('Owned synthetic transfer did not settle.');
}

test('upload is accepted quickly without terminal, runs independently and releases its own lease', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.localPath, '.hidden'), 'payload');
  const manager = new TransferManager(f.pool, { remote: f.remote });
  try {
    const accepted = await manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/destination' });
    assert.equal(accepted.state, 'queued');
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.planningComplete, false);
    const id = String(accepted.transferId);
    assert.equal((manager.list({ limit: 1 }).transfers as unknown[]).length, 1);
    const done = await terminal(manager, id);
    assert.equal(done.state, 'completed');
    assert.equal(done.filesCommitted, 1);
    assert.equal(done.bytesCommitted, 7);
    assert.equal(await fs.readFile(path.join(f.remoteRoot, 'destination', '.hidden'), 'utf8'), 'payload');
    assert.equal(f.released(), 1);
    assert.equal(f.remotes[0]?.closed, true);
    assert.equal(manager.cancel(id).state, 'completed');
    assert.equal(manager.cancel(id).cancellationAccepted, false);
  } finally { await manager.dispose(); }
});

test('download direction, paginated conflicts and context recovery are real task state', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.remoteRoot, 'from'));
  for (const name of ['a', 'b', '.extra']) await fs.writeFile(path.join(f.remoteRoot, 'from', name), name);
  const destination = path.join(f.localPath, 'new');
  const manager = new TransferManager(f.pool, { remote: f.remote });
  try {
    const accepted = await manager.accept('download', { ...target, localPath: destination, remotePath: '/from' });
    const id = String(accepted.transferId);
    const done = await terminal(manager, id);
    assert.equal(done.state, 'completed');
    assert.equal(done.filesCommitted, 3);
    assert.deepEqual((await fs.readdir(destination)).sort(), ['.extra', 'a', 'b']);
    const again = await manager.accept('download', { ...target, localPath: destination, remotePath: '/from' });
    const blocked = await terminal(manager, String(again.transferId));
    assert.equal(blocked.state, 'blocked');
    assert.equal(blocked.planningComplete, true);
    const first = manager.status(String(again.transferId), { offset: 0, limit: 2 });
    assert.equal((first.results as unknown[]).length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 2);
    assert.equal((first.results as Array<{ code: string }>)[0]?.code, 'TARGET_EXISTS');
    assert.equal((manager.list({ username: 'other' }).transfers as unknown[]).length, 0);
    assert.equal((manager.list({ username: 'synthetic', offset: 1, limit: 1 }).transfers as unknown[]).length, 1);
  } finally { await manager.dispose(); }
});

test('queued cancellation waits for actual channel closure before terminal cancelled', async () => {
  const f = await fixture();
  const manager = new TransferManager(f.pool, { remote: f.remote });
  try {
    const accepted = await manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/cancelled' });
    const id = String(accepted.transferId);
    assert.equal(manager.cancel(id).state, 'cancelling');
    assert.equal((await terminal(manager, id)).state, 'cancelled');
    await assert.rejects(fs.lstat(path.join(f.remoteRoot, 'cancelled')));
    assert.equal(f.released(), 1);
  } finally { await manager.dispose(); }
});

test('running cancellation does not guess that an unsettled read has stopped', async () => {
  const f = await fixture();
  const from = path.join(f.localPath, 'file');
  await fs.writeFile(from, Buffer.alloc(128 * 1024, 42));
  let resolveRead!: () => void;
  let announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { resolveRead = resolve; });
  class PausedLocal extends LocalFileSystem {
    override async openRead(value: string): Promise<ReadHandle> {
      const handle = await super.openRead(value);
      return { ...handle, stat: () => handle.stat(), close: () => handle.close(), read: async (buffer, position) => {
        announce(); await gate; return handle.read(buffer, position);
      } };
    }
  }
  const manager = new TransferManager(f.pool, { remote: f.remote, local: () => new PausedLocal() });
  try {
    const accepted = await manager.accept('upload', { ...target, localPath: from, remotePath: '/file' });
    const id = String(accepted.transferId);
    await started;
    assert.equal(manager.cancel(id).state, 'cancelling');
    await sleep(10);
    assert.equal(manager.status(id).stopped, false);
    resolveRead();
    const cancelled = await terminal(manager, id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.filesCommitted, 0);
    assert.deepEqual(await fs.readdir(f.remoteRoot), []);
  } finally { resolveRead(); await manager.dispose(); }
});

test('active admission budget includes pending connection acquisition', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new TransferManager({ acquire: async login => { await gate; return f.pool.acquire(login); } }, { remote: f.remote, limits: { admitted: 1 } });
  try {
    const first = manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/one' });
    await assert.rejects(manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/two' }), { code: 'RESOURCE_LIMIT' });
    const closing = manager.dispose();
    release();
    await assert.rejects(first, { code: 'SERVER_STOPPING' });
    await closing;
    assert.equal(f.acquired(), 1);
    assert.equal(f.released(), 1);
    assert.equal(f.remotes.length, 0);
  } finally { release(); await manager.dispose(); }
});

test('terminal records expire on their documented deadline; active records are not trimmed', async () => {
  const f = await fixture();
  let now = 1_000_000;
  const manager = new TransferManager(f.pool, { remote: f.remote, now: () => now, limits: { retentionMs: 60_000 } });
  try {
    const accepted = await manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/empty' });
    const id = String(accepted.transferId);
    const done = await terminal(manager, id);
    assert.equal(done.recordExpiresAt, new Date(now + 60_000).toISOString());
    now += 60_001;
    assert.equal(manager.list().total, 0);
    assert.throws(() => manager.status(id), { code: 'TRANSFER_EXPIRED' });
  } finally { await manager.dispose(); }
});

test('global memory budget rejects before authentication; bad paths and policies do not create tasks', async () => {
  const f = await fixture();
  const manager = new TransferManager(f.pool, { remote: f.remote, memoryBytes: 10 });
  try {
    await assert.rejects(manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/too-large' }), { code: 'RESOURCE_LIMIT' });
    assert.equal(f.acquired(), 0);
    await assert.rejects(manager.accept('upload', { ...target, localPath: f.localPath, remotePath: 'relative' }), { code: 'INVALID_REMOTE_PATH' });
    await assert.rejects(manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/ok', conflictPolicy: true } as never), { code: 'INVALID_TRANSFER_POLICY' });
    assert.equal(manager.list().total, 0);
  } finally { await manager.dispose(); }
});

test('shutdown closes admission synchronously and awaits exactly owned tasks/channels/leases', async () => {
  const f = await fixture();
  const manager = new TransferManager(f.pool, { remote: f.remote });
  await manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/shutdown' });
  const closing = manager.dispose();
  await assert.rejects(manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/after-stop' }), { code: 'SERVER_STOPPING' });
  await closing;
  assert.equal(f.released(), 1);
  assert.equal(f.remotes[0]?.closed, true);
  await assert.rejects(fs.lstat(path.join(f.remoteRoot, 'shutdown')));
});

test('terminal status is published only after both owned channel and lease cleanup settle', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.localPath, 'file'), 'payload');
  let releaseChannel!: () => void;
  let releaseLease!: () => void;
  let closingChannel = false;
  let closingLease = false;
  const channelGate = new Promise<void>(resolve => { releaseChannel = resolve; });
  const leaseGate = new Promise<void>(resolve => { releaseLease = resolve; });
  class ClosingRemote extends MappedRemote {
    override async dispose() {
      closingChannel = true;
      await channelGate;
      return super.dispose();
    }
  }
  const pool = { acquire: async (login: typeof target) => {
    const lease = await f.pool.acquire(login);
    return { ...lease, release: async () => {
      closingLease = true;
      await leaseGate;
      await lease.release();
    } };
  } };
  const manager = new TransferManager(pool, { remote: async () => new ClosingRemote(f.remoteRoot) });
  try {
    const accepted = await manager.accept('upload', { ...target, localPath: f.localPath, remotePath: '/out' });
    const id = String(accepted.transferId);
    for (let i = 0; i < 250 && !closingChannel; i++) await sleep(10);
    assert.equal(closingChannel, true);
    const beforeChannel = manager.status(id);
    assert.equal(beforeChannel.state, 'running');
    assert.equal(beforeChannel.finishing, true);
    assert.equal(beforeChannel.filesCommitted, 1);
    assert.equal(beforeChannel.stopped, false);
    assert.equal(beforeChannel.endedAt, undefined);
    releaseChannel();
    for (let i = 0; i < 250 && !closingLease; i++) await sleep(10);
    assert.equal(closingLease, true);
    assert.equal(manager.status(id).state, 'running');
    releaseLease();
    const done = await terminal(manager, id);
    assert.equal(done.state, 'completed');
    assert.equal(done.finishing, false);
    assert.ok(done.endedAt);
  } finally { releaseChannel(); releaseLease(); await manager.dispose(); }
});
