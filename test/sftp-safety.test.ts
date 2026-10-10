import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LiteSshError } from '../src/core/errors.js';
import { LocalFileSystem } from '../src/sftp/local.js';
import { planTransfer } from '../src/sftp/planner.js';
import { runTransfer } from '../src/sftp/runner.js';
import { TransferManager } from '../src/sftp/manager.js';
import type { Metadata, WriteHandle } from '../src/sftp/filesystem.js';
import { TRANSFER_LIMITS } from '../src/sftp/types.js';
import { createTransferFixture, MappedRemote } from './helpers/sftp.js';

const base = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'sftp-safety', `${process.pid}-${Date.now()}`);
let serial = 0;
const policies = { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' } as const;
const login = { ip: '127.0.0.1', port: 2222, username: 'synthetic' };
const signal = () => new AbortController().signal;
const noIdentity = (value: Metadata): Metadata => { const { identity: _identity, mtimeExact: _mtimeExact, ...rest } = value; return rest; };
async function fixture() { return createTransferFixture(path.join(base, String(++serial))); }
async function terminal(manager: TransferManager, id: string) {
  for (let i = 0; i < 250; i++) {
    const status = manager.status(id);
    if (status.stopped === true) return status;
    await sleep(10);
  }
  assert.fail('Synthetic transfer did not finish.');
}

test('unsupported target capability is detected before mkdir/temp/content writes', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.localPath, 'file'), 'payload');
  class Unsupported extends MappedRemote {
    async checkCommit() { throw new LiteSshError('COMMIT_UNSUPPORTED', 'fixture safe extension unavailable'); }
  }
  const remote = new Unsupported(f.remoteRoot);
  const local = new LocalFileSystem();
  const plan = await planTransfer(local, remote, f.localPath, '/new/tree', policies, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  const result = await runTransfer(local, remote, plan, policies, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'failed');
  assert.equal(result.error?.code, 'COMMIT_UNSUPPORTED');
  assert.equal(result.directoriesCreated, 0);
  assert.deepEqual(await fs.readdir(f.remoteRoot), []);
});

test('many ordinary components fail RESOURCE_LIMIT before retaining quadratic prefix guards', async () => {
  const f = await fixture();
  const source = path.join(f.localPath, 'file');
  await fs.writeFile(source, 'payload');
  let inspected = 0;
  class Counting extends MappedRemote {
    override async lstat(value: string) { inspected++; return super.lstat(value); }
  }
  const remote = new Counting(f.remoteRoot);
  const plan = await planTransfer(new LocalFileSystem(), remote, source, '/' + 'a/'.repeat(10_000), policies, TRANSFER_LIMITS, signal());
  assert.equal(plan.planningComplete, false);
  assert.ok(plan.issues.some(issue => issue.code === 'RESOURCE_LIMIT'));
  assert.equal(inspected, 0);
  assert.deepEqual(await fs.readdir(f.remoteRoot), []);
});

test('cleanup never unlinks through a substituted parent even when remote-v3 metadata matches', async () => {
  const f = await fixture();
  const from = path.join(f.localPath, 'file');
  await fs.writeFile(from, 'owned payload');
  const target = path.join(f.remoteRoot, 'target');
  const moved = path.join(f.remoteRoot, 'moved-owned-target');
  const foreign = path.join(f.remoteRoot, 'foreign-fixture');
  await fs.mkdir(target);
  await fs.mkdir(foreign);
  let temporary = '';
  let prior: Metadata | undefined;
  let unlinks = 0;
  class ChangingParent extends MappedRemote {
    override async lstat(value: string) {
      // Deliberately model the coarse SFTP stat collision described by review.
      if (value === temporary && prior) return prior;
      const metadata = await super.lstat(value);
      return metadata ? noIdentity(metadata) : undefined;
    }
    override async createExclusive(value: string): Promise<WriteHandle> {
      temporary = value;
      const handle = await super.createExclusive(value);
      return {
        stat: async () => noIdentity(await handle.stat()),
        write: (buffer, length, position) => handle.write(buffer, length, position),
        close: async () => {
          prior = noIdentity(await handle.stat());
          await handle.close();
          const name = path.posix.basename(value);
          await fs.writeFile(path.join(foreign, name), 'foreign payload');
          await fs.rename(target, moved);
          await fs.symlink(foreign, target, process.platform === 'win32' ? 'junction' : 'dir');
        }
      };
    }
    override async unlink(value: string) { unlinks++; await super.unlink(value); }
  }
  const remote = new ChangingParent(f.remoteRoot);
  const local = new LocalFileSystem();
  const plan = await planTransfer(local, remote, from, '/target/final', policies, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  const result = await runTransfer(local, remote, plan, policies, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'failed');
  assert.equal(result.error?.code, 'PATH_CHANGED');
  assert.equal(result.cleanup.complete, false);
  assert.equal(result.cleanup.outcomeUnknown, true);
  assert.deepEqual(result.cleanup.possibleResidualPaths, [temporary]);
  assert.equal(unlinks, 0);
  const name = path.posix.basename(temporary);
  assert.equal(await fs.readFile(path.join(foreign, name), 'utf8'), 'foreign payload');
  assert.equal(await fs.readFile(path.join(moved, name), 'utf8'), 'owned payload');
});

test('uncertain wx creation retains a possible residual, never asserts ownership or deletes it', async () => {
  const f = await fixture();
  const from = path.join(f.localPath, 'file');
  await fs.writeFile(from, 'payload');
  let attempted = '';
  class LostOpen extends MappedRemote {
    override readonly effectUnknown = true;
    override async createExclusive(value: string): Promise<WriteHandle> {
      attempted = value;
      const handle = await super.createExclusive(value);
      await handle.close();
      throw new LiteSshError('SFTP_CREATE_OUTCOME_UNKNOWN', 'fixture lost callback', { possibleResidualPath: value });
    }
  }
  const manager = new TransferManager(f.pool, { remote: async () => new LostOpen(f.remoteRoot) });
  try {
    const accepted = await manager.accept('upload', { ...login, localPath: from, remotePath: '/final' });
    const done = await terminal(manager, String(accepted.transferId));
    assert.equal(done.state, 'failed');
    assert.equal(done.filesCommitted, 0);
    assert.deepEqual((done.cleanup as { possibleResidualPaths: string[] }).possibleResidualPaths, [attempted]);
    assert.equal((done.cleanup as { complete: boolean }).complete, false);
    assert.deepEqual(await fs.readdir(f.remoteRoot), [path.posix.basename(attempted)]);
  } finally { await manager.dispose(); }
});

test('cancelled with changed temporary ownership reaches a terminal result, not permanent cancelling', async () => {
  const f = await fixture();
  const from = path.join(f.localPath, 'file');
  await fs.writeFile(from, 'payload');
  let manager!: TransferManager;
  let id = '';
  let attempted = '';
  class ChangedTemporary extends MappedRemote {
    override async createExclusive(value: string): Promise<WriteHandle> {
      attempted = value;
      const handle = await super.createExclusive(value);
      return {
        stat: () => handle.stat(),
        write: async (buffer, length, position) => {
          await handle.write(buffer, length, position);
          manager.cancel(id);
        },
        close: async () => {
          await handle.close();
          const file = path.join(f.remoteRoot, path.posix.basename(value));
          await fs.rename(file, file + '.moved-owned');
          await fs.writeFile(file, 'foreign replacement fixture');
        }
      };
    }
  }
  manager = new TransferManager(f.pool, { remote: async () => new ChangedTemporary(f.remoteRoot) });
  try {
    const accepted = await manager.accept('upload', { ...login, localPath: from, remotePath: '/final' });
    id = String(accepted.transferId);
    const done = await terminal(manager, id);
    assert.equal(done.state, 'cancelled');
    assert.equal(done.cancellationRequested, true);
    assert.equal((done.cleanup as { complete: boolean }).complete, false);
    assert.equal((done.cleanup as { outcomeUnknown: boolean }).outcomeUnknown, true);
    assert.deepEqual((done.cleanup as { possibleResidualPaths: string[] }).possibleResidualPaths, [attempted]);
    assert.equal(await fs.readFile(path.join(f.remoteRoot, path.posix.basename(attempted)), 'utf8'), 'foreign replacement fixture');
  } finally { await manager.dispose(); }
});

test('directory-only plans do not require file-publication extensions', async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.localPath, 'empty-child'));
  let checked = 0;
  class DirectoryOnly extends MappedRemote {
    async checkCommit() {
      checked++;
      throw new LiteSshError('COMMIT_UNSUPPORTED', 'fixture has no file extension');
    }
  }
  const remote = new DirectoryOnly(f.remoteRoot);
  const local = new LocalFileSystem();
  const plan = await planTransfer(local, remote, f.localPath, '/new', policies, TRANSFER_LIMITS, signal());
  assert.equal(plan.filesTotal, 0);
  const result = await runTransfer(local, remote, plan, policies, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(result.directoriesCreated, 2);
  assert.equal(checked, 0);
  assert.deepEqual(await fs.readdir(path.join(f.remoteRoot, 'new')), ['empty-child']);
});

test('a confirmed mkdir remains recorded when its immediate post-check fails', async () => {
  const f = await fixture();
  let created = false;
  class LostPostCheck extends MappedRemote {
    override async mkdir(value: string) {
      await super.mkdir(value);
      created = true;
    }
    override async lstat(value: string) {
      if (created && value === '/new') {
        throw new LiteSshError('CONNECTION_LOST', 'fixture read lost after successful mkdir');
      }
      return super.lstat(value);
    }
  }
  const remote = new LostPostCheck(f.remoteRoot);
  const local = new LocalFileSystem();
  const plan = await planTransfer(local, remote, f.localPath, '/new', policies, TRANSFER_LIMITS, signal());
  let progress = 0;
  const result = await runTransfer(local, remote, plan, policies, 'synthetic', TRANSFER_LIMITS, signal(), value => {
    progress = value.directoriesCreated;
  });
  assert.equal(result.phase, 'partial_failed');
  assert.equal(result.directoriesCreated, 1);
  assert.equal(progress, 1);
  assert.equal((await fs.lstat(path.join(f.remoteRoot, 'new'))).isDirectory(), true);
});
