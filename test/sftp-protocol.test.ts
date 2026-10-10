import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/app.js';
import { startMockSsh } from './helpers/mock-ssh.js';
import { fixtureRoot } from './helpers/workspace.js';
import type { MockSftpOptions } from './helpers/mock-sftp.js';
import { unlinkOwnedFile, type PrivateObjectIdentity } from '../src/platform/permissions.js';

const terminalStates = new Set(['completed', 'blocked', 'failed', 'partial_failed', 'cancelled']);

async function fixture(options: MockSftpOptions & { pinned?: boolean; password?: string } = {}) {
  const root = fixtureRoot('sftp-protocol', randomUUID());
  const remote = path.join(root, 'remote');
  const local = path.join(root, 'local');
  await fs.mkdir(remote, { recursive: true, mode: 0o700 });
  await fs.mkdir(local, { mode: 0o700 });
  const ssh = await startMockSsh({ sftpRoot: remote, sftp: options });
  const login = { ip: ssh.ip, port: ssh.port, username: ssh.username };
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    version: 2,
    servers: { [ssh.ip]: { [ssh.port]: {
      ...(options.pinned === false ? {} : { hostKeyFingerprint: ssh.fingerprint }),
      accounts: { [ssh.username]: {
        auth: { type: 'password', password: options.password ?? ssh.password }
      } }
    } } }
  }), { mode: 0o600 });
  // These explicit paths are essential: never use the user's default config,
  // cache, key files, or an externally registered/live MCP tool in this suite.
  const app = createApplication({ configPath, cacheRoot: path.join(root, 'cache') });
  const client = new Client({ name: 'owned-loopback-sftp-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name: `lite_ssh_${name}`, arguments: args });
    return { error: response.isError === true, data: (response.structuredContent ?? {}) as Record<string, any> };
  };
  const wait = async (id: string): Promise<Record<string, any>> => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await call('transfer_status', { transferId: id });
      assert.equal(value.error, false);
      if (terminalStates.has(value.data.state)) return value.data;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Owned loopback transfer did not settle');
  };
  return {
    root, remote, local, ssh, login, app, client, call, wait,
    async close() {
      const failures: unknown[] = [];
      for (const cleanup of [() => client.close(), () => app.close(), () => ssh.close()]) {
        try { await cleanup(); }
        catch (error) { failures.push(error); }
      }
      assert.equal(ssh.sftpStats.openHandles, 0);
      if (failures.length) throw new AggregateError(failures, 'Owned protocol fixture cleanup failed');
    }
  };
}

function binary(length: number): Buffer {
  return Buffer.from(Array.from({ length }, (_, i) => i % 256));
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  return {
    release,
    async started() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Owned WRITE gate was never reached')), 5000);
          })
        ]);
      } finally { if (timer) clearTimeout(timer); }
    },
    async hold() { entered(); await waiting; }
  };
}

test('real SSH/SFTP wire + scoped SDK: binary chunks, hidden files, final-root semantics and paging', { timeout: 20000 }, async () => {
  const f = await fixture();
  const bytes = binary(200123);
  try {
    await fs.writeFile(path.join(f.local, 'binary.bin'), bytes, { mode: 0o600 });
    await fs.writeFile(path.join(f.local, '.hidden'), 'synthetic hidden', { mode: 0o600 });
    await fs.mkdir(path.join(f.local, '子目录'), { mode: 0o700 });
    await fs.writeFile(path.join(f.local, '子目录', '文件.txt'), 'UTF8 fixture', { mode: 0o600 });
    assert.equal((await f.client.listTools()).tools.length, 13);
    const accepted = await f.call('upload', { ...f.login, localPath: f.local, remotePath: '/out' });
    assert.equal(accepted.error, false);
    assert.equal(accepted.data.accepted, true);
    const id = accepted.data.transferId;
    const done = await f.wait(id);
    assert.equal(done.state, 'completed');
    assert.equal(done.filesCommitted, 3);
    assert.equal(done.bytesCommitted, bytes.length + Buffer.byteLength('synthetic hiddenUTF8 fixture'));
    assert.equal(done.cleanup.complete, true);
    assert.equal(done.stopped, true);
    assert.deepEqual(await fs.readFile(path.join(f.remote, 'out', 'binary.bin')), bytes);
    assert.deepEqual((await fs.readdir(path.join(f.remote, 'out'))).sort(), ['.hidden', 'binary.bin', '子目录'].sort());
    assert.ok(f.ssh.sftpStats.writeRequests > 3, 'ssh2 really framed/chunked file writes');
    assert.equal(f.ssh.sftpStats.commits, 3);
    const page = await f.call('transfer_status', { transferId: id, offset: 0, limit: 1 });
    assert.equal(page.data.results.length, 1);
    assert.equal(page.data.hasMore, true);
    assert.equal(page.data.nextOffset, 1);
    const listed = await f.call('transfer_list', { ...f.login, limit: 1 });
    assert.equal(listed.data.transfers[0].transferId, id);
    assert.equal((await f.call('transfer_cancel', { transferId: id })).data.state, 'completed');

    const destination = path.join(f.root, 'download-exact');
    const downloaded = await f.call('download', { ...f.login, localPath: destination, remotePath: '/out' });
    const downloadedDone = await f.wait(downloaded.data.transferId);
    assert.equal(downloadedDone.state, 'completed', JSON.stringify(downloadedDone));
    assert.deepEqual(await fs.readFile(path.join(destination, 'binary.bin')), bytes);
    assert.equal(await fs.readFile(path.join(destination, '.hidden'), 'utf8'), 'synthetic hidden');
    assert.equal(await fs.readFile(path.join(destination, '子目录', '文件.txt'), 'utf8'), 'UTF8 fixture');
    assert.ok(f.ssh.sftpStats.reads > 3);
  } finally { await f.close(); }
});

test('real protocol: all four independent policies, source aliases and preserved target link node', { timeout: 30000 }, async () => {
  for (const conflictPolicy of ['overwrite_merge_off', 'overwrite_merge_on']) {
    for (const symlinkPolicy of ['symlink_follow_off', 'symlink_follow_on']) {
      const f = await fixture();
      try {
        await fs.writeFile(path.join(f.local, 'a.txt'), 'new fixture', { mode: 0o600 });
        await fs.mkdir(path.join(f.local, 'real'), { mode: 0o700 });
        await fs.writeFile(path.join(f.local, 'real', 'b.txt'), 'alias fixture', { mode: 0o600 });
        await fs.symlink(path.join(f.local, 'real'), path.join(f.local, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
        const actual = path.join(f.remote, 'target-real');
        const linked = path.join(f.remote, 'target-alias');
        await fs.mkdir(actual, { mode: 0o700 });
        await fs.writeFile(path.join(actual, 'a.txt'), 'old fixture', { mode: 0o600 });
        await fs.writeFile(path.join(actual, 'extra'), 'keep fixture', { mode: 0o600 });
        await fs.symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
        const accepted = await f.call('upload', {
          ...f.login, localPath: f.local, remotePath: '/target-alias', conflictPolicy, symlinkPolicy
        });
        const done = await f.wait(accepted.data.transferId);
        const allowed = conflictPolicy === 'overwrite_merge_on' && symlinkPolicy === 'symlink_follow_on';
        assert.equal(done.state, allowed ? 'completed' : 'blocked');
        assert.equal(await fs.readFile(path.join(actual, 'a.txt'), 'utf8'), allowed ? 'new fixture' : 'old fixture');
        assert.equal(await fs.readFile(path.join(actual, 'extra'), 'utf8'), 'keep fixture');
        assert.equal((await fs.lstat(linked)).isSymbolicLink(), true);
        if (allowed) {
          assert.equal(await fs.readFile(path.join(actual, 'alias', 'b.txt'), 'utf8'), 'alias fixture');
          assert.equal(await fs.readFile(path.join(actual, 'real', 'b.txt'), 'utf8'), 'alias fixture');
          assert.equal((await fs.lstat(path.join(actual, 'alias'))).isDirectory(), true);
        } else {
          assert.equal(f.ssh.sftpStats.mkdirs, 0);
          assert.equal(f.ssh.sftpStats.exclusiveCreates, 0);
          assert.equal(f.ssh.sftpStats.bytesWritten, 0);
        }
      } finally { await f.close(); }
    }
  }
});

test('real protocol: unsupported file publication is zero-write but directory-only works', { timeout: 20000 }, async () => {
  const f = await fixture({ publications: false });
  try {
    const file = path.join(f.local, 'file.bin');
    await fs.writeFile(file, binary(100), { mode: 0o600 });
    const accepted = await f.call('upload', { ...f.login, localPath: file, remotePath: '/missing/child/file.bin' });
    const done = await f.wait(accepted.data.transferId);
    assert.equal(done.state, 'failed');
    assert.equal(done.error.code, 'COMMIT_UNSUPPORTED');
    assert.equal(f.ssh.sftpStats.mkdirs, 0);
    assert.equal(f.ssh.sftpStats.exclusiveCreates, 0);
    assert.deepEqual(await fs.readdir(f.remote), []);
    const empty = path.join(f.root, 'empty');
    await fs.mkdir(path.join(empty, 'nested'), { recursive: true, mode: 0o700 });
    const directory = await f.call('upload', { ...f.login, localPath: empty, remotePath: '/dirs' });
    assert.equal((await f.wait(directory.data.transferId)).state, 'completed');
    assert.deepEqual(await fs.readdir(path.join(f.remote, 'dirs')), ['nested']);
    for (const conflictPolicy of [true, 'on', null]) {
      assert.equal((await f.call('upload', {
        ...f.login, localPath: file, remotePath: '/invalid', conflictPolicy
      })).error, true);
    }
    assert.equal((await f.call('transfer_list')).data.total, 2);
  } finally { await f.close(); }
});

test('real protocol: host trust/configuration/authentication precede task acceptance', { timeout: 20000 }, async () => {
  const f = await fixture({ pinned: false });
  try {
    const file = path.join(f.local, 'file');
    await fs.writeFile(file, 'owned fixture', { mode: 0o600 });
    const args = { ...f.login, localPath: file, remotePath: '/final' };
    const unknown = await f.call('upload', args);
    assert.equal(unknown.error, true);
    assert.equal(unknown.data.code, 'HOST_KEY_UNTRUSTED');
    assert.equal(unknown.data.accepted, undefined);
    assert.equal(f.ssh.authAttempts, 0);
    assert.equal(f.ssh.sftpStats.channels, 0);
    assert.equal((await f.call('transfer_list')).data.total, 0);
    assert.equal((await f.call('confirm_host_key', { ip: f.ssh.ip, port: f.ssh.port, fingerprint: f.ssh.fingerprint })).error, false);
    const accepted = await f.call('upload', args);
    assert.equal((await f.wait(accepted.data.transferId)).state, 'completed');
    assert.equal((await f.call('upload', { ...args, username: 'unconfigured_fixture' })).error, true);
    assert.equal((await f.call('transfer_list')).data.total, 1);
  } finally { await f.close(); }
  const bad = await fixture({ password: 'synthetic_invalid_password' });
  try {
    const rejected = await bad.call('upload', { ...bad.login, localPath: bad.local, remotePath: '/bad' });
    assert.equal(rejected.error, true);
    assert.equal(rejected.data.accepted, undefined);
    assert.equal(bad.ssh.sftpStats.channels, 0);
    assert.equal((await bad.call('transfer_list')).data.total, 0);
    assert.equal(JSON.stringify(rejected).includes('synthetic_invalid_password'), false);
  } finally { await bad.close(); }
});

test('real protocol: terminal close cannot cancel the independent shared-connection transfer', { timeout: 20000 }, async () => {
  const blocker = gate();
  const f = await fixture({ beforeRequest: async request => { if (request.type === 6) await blocker.hold(); } });
  try {
    const file = path.join(f.local, 'file');
    await fs.writeFile(file, binary(100000), { mode: 0o600 });
    await f.app.terminals.open(f.login, 'independent_pty');
    const accepted = await f.call('upload', { ...f.login, localPath: file, remotePath: '/final' });
    await blocker.started();
    assert.equal(f.ssh.authenticatedConnections, 1);
    await f.app.terminals.close({ ip: f.ssh.ip, port: f.ssh.port, codename: 'independent_pty' });
    const running = await f.call('transfer_status', { transferId: accepted.data.transferId });
    assert.equal(running.data.cancellationRequested, false);
    assert.equal(f.ssh.sftpStats.channels, 1);
    blocker.release();
    assert.equal((await f.wait(accepted.data.transferId)).state, 'completed');
    assert.equal(f.ssh.authenticatedConnections, 1);
  } finally { blocker.release(); await f.close(); }
});

test('real protocol: cancellation waits for an actual in-flight WRITE and cleans only its temporary', { timeout: 20000 }, async () => {
  const blocker = gate();
  const f = await fixture({ beforeRequest: async request => { if (request.type === 6) await blocker.hold(); } });
  try {
    const file = path.join(f.local, 'file');
    await fs.writeFile(file, binary(100000), { mode: 0o600 });
    const accepted = await f.call('upload', { ...f.login, localPath: file, remotePath: '/final' });
    await blocker.started();
    const cancelled = await f.call('transfer_cancel', { transferId: accepted.data.transferId });
    assert.equal(cancelled.data.state, 'cancelling');
    assert.equal(cancelled.data.stopped, false);
    assert.equal(f.ssh.sftpStats.channels, 1);
    blocker.release();
    const done = await f.wait(accepted.data.transferId);
    assert.equal(done.state, 'cancelled');
    assert.equal(done.stopped, true);
    assert.equal(done.filesCommitted, 0);
    assert.equal(done.cleanup.complete, true);
    assert.deepEqual(await fs.readdir(f.remote), []);
  } finally { blocker.release(); await f.close(); }
});

test('real protocol: a later file failure preserves actual committed progress and extra content', { timeout: 20000 }, async () => {
  let commits = () => 0;
  const f = await fixture({ beforeRequest: async request => {
    if (request.type === 6 && commits() >= 1) return 'fail';
  } });
  commits = () => f.ssh.sftpStats.commits;
  try {
    await fs.writeFile(path.join(f.local, 'first'), binary(3000), { mode: 0o600 });
    await fs.writeFile(path.join(f.local, 'second'), binary(3000), { mode: 0o600 });
    const accepted = await f.call('upload', { ...f.login, localPath: f.local, remotePath: '/out' });
    const done = await f.wait(accepted.data.transferId);
    assert.equal(done.state, 'partial_failed');
    assert.equal(done.filesCommitted, 1);
    assert.equal(done.directoriesCreated, 1);
    assert.equal(done.cleanup.complete, true);
    assert.equal((await fs.readdir(path.join(f.remote, 'out'))).length, 1);
    assert.equal(f.ssh.sftpStats.openHandles, 0);
  } finally { await f.close(); }
});

test('real protocol: lost WRITE outcome is not replayed or disguised as completion', { timeout: 20000 }, async () => {
  const f = await fixture({ beforeRequest: async request => request.type === 6 ? 'disconnect' : undefined });
  try {
    const file = path.join(f.local, 'file');
    await fs.writeFile(file, binary(10000), { mode: 0o600 });
    const accepted = await f.call('upload', { ...f.login, localPath: file, remotePath: '/final' });
    const done = await f.wait(accepted.data.transferId);
    assert.equal(done.state, 'failed');
    assert.equal(done.error.code, 'SFTP_OUTCOME_UNKNOWN');
    assert.equal(done.filesCommitted, 0);
    assert.equal(done.cleanup.complete, false);
    assert.equal(f.ssh.sftpStats.exclusiveCreates, 1);
    assert.equal(f.ssh.sftpStats.commits, 0);
    assert.equal(f.ssh.authenticatedConnections, 1);
  } finally { await f.close(); }
});

test('real protocol: shutdown closes admission first and awaits its owned channel and handles', { timeout: 20000 }, async () => {
  const blocker = gate();
  const f = await fixture({ beforeRequest: async request => { if (request.type === 6) await blocker.hold(); } });
  let closing: Promise<void> | undefined;
  try {
    const file = path.join(f.local, 'file');
    await fs.writeFile(file, binary(100000), { mode: 0o600 });
    await f.call('upload', { ...f.login, localPath: file, remotePath: '/final' });
    await blocker.started();
    closing = f.app.close();
    const rejected = await f.call('upload', { ...f.login, localPath: file, remotePath: '/new' });
    assert.equal(rejected.data.code, 'SERVER_STOPPING');
    blocker.release();
    await closing;
    assert.equal(f.ssh.sftpStats.channels, 0);
    assert.equal(f.ssh.sftpStats.openHandles, 0);
    assert.deepEqual(await fs.readdir(f.remote), []);
  } finally { blocker.release(); await closing; await f.close(); }
});

test('real protocol: callback-lost exclusive OPEN retains only an uncertain name, never guessed ownership', { timeout: 20000 }, async () => {
  const f = await fixture({ beforeRequest: async request => request.type === 3 ? 'disconnect' : undefined });
  try {
    const file = path.join(f.local, 'file');
    await fs.writeFile(file, binary(100), { mode: 0o600 });
    const accepted = await f.call('upload', { ...f.login, localPath: file, remotePath: '/final' });
    const done = await f.wait(accepted.data.transferId);
    assert.equal(done.state, 'failed');
    assert.equal(done.error.code, 'SFTP_CREATE_OUTCOME_UNKNOWN');
    assert.equal(done.cleanup.outcomeUnknown, true);
    assert.equal(done.cleanup.possibleResidualPaths.length, 1);
    assert.equal(done.cleanup.residualPaths.length, 0);
    assert.equal(f.ssh.sftpStats.exclusiveCreates, 0);
    assert.equal(f.ssh.sftpStats.removals, 0);
    assert.equal(f.ssh.authenticatedConnections, 1);
  } finally { await f.close(); }
});

test('real protocol: acknowledged mkdir remains partial progress after post-check channel loss', { timeout: 20000 }, async () => {
  let created = () => 0;
  const f = await fixture({ publications: false, beforeRequest: async request => {
    if (request.type === 7 && created() > 0) return 'disconnect';
  } });
  created = () => f.ssh.sftpStats.mkdirs;
  try {
    const accepted = await f.call('upload', { ...f.login, localPath: f.local, remotePath: '/new-directory' });
    const done = await f.wait(accepted.data.transferId);
    assert.equal(done.state, 'partial_failed');
    assert.equal(done.directoriesCreated, 1);
    assert.equal(f.ssh.sftpStats.mkdirs, 1);
    assert.equal((await fs.lstat(path.join(f.remote, 'new-directory'))).isDirectory(), true);
  } finally { await f.close(); }
});

for (const type of [3, 6]) {
  test(`real protocol: ${type === 3 ? 'exclusive OPEN' : 'WRITE'} effect precedes lost ACK, without replay or guessed cleanup`, { timeout: 20000 }, async () => {
    let owned: { path: string; identity: PrivateObjectIdentity } | undefined;
    const f = await fixture({ afterEffect: async effect => {
      if (effect.type !== type) return;
      assert.equal(effect.exclusiveCreate, true);
      // Proof comes from the server's actual successful wx acquisition, not
      // from a client-reported possible name or a guessed post-loss path stat.
      const stat = await effect.file.stat({ bigint: true });
      owned = { path: effect.nativePath, identity: { dev: stat.dev, ino: stat.ino } };
      return 'disconnect';
    } });
    try {
      const bytes = binary(1000);
      const source = path.join(f.local, 'file');
      await fs.writeFile(source, bytes, { mode: 0o600 });
      const accepted = await f.call('upload', { ...f.login, localPath: source, remotePath: '/final' });
      assert.equal(accepted.error, false);
      const done = await f.wait(accepted.data.transferId);
      assert.equal(done.state, 'failed');
      assert.equal(done.filesCommitted, 0);
      assert.equal(done.error.code, type === 3 ? 'SFTP_CREATE_OUTCOME_UNKNOWN' : 'SFTP_OUTCOME_UNKNOWN');
      assert.equal(done.cleanup.outcomeUnknown, true);
      assert.equal(f.ssh.sftpStats.exclusiveCreates, 1);
      assert.equal(f.ssh.sftpStats.writeRequests, type === 3 ? 0 : 1);
      assert.equal(f.ssh.sftpStats.bytesWritten, type === 3 ? 0 : bytes.length);
      assert.equal(f.ssh.sftpStats.removals, 0);
      assert.equal(f.ssh.sftpStats.commits, 0);
      assert.equal(f.ssh.authenticatedConnections, 1);
      assert.ok(owned);
      const actual = await fs.lstat(owned.path, { bigint: true });
      assert.equal(actual.ino, owned.identity.ino);
      assert.equal(actual.size, type === 3 ? 0n : BigInt(bytes.length));
      if (type === 6) assert.deepEqual(await fs.readFile(owned.path), bytes);
    } finally {
      try { await f.close(); }
      finally {
        // The fixture creator can remove its proven residual after teardown.
        // The product must NOT infer this ownership from an unacknowledged OPEN.
        if (owned) await unlinkOwnedFile(owned.path, owned.identity);
      }
    }
  });
}
