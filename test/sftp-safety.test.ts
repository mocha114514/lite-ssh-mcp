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
import { MemorySftpFs } from './helpers/memory-sftp.js';

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

class HookedMemoryFs extends MemorySftpFs {
  onLstat?: (value: string, current: Metadata | undefined) => void;
  onCreateExclusive?: (value: string) => void;
  beforeCommit?: (temporary: string, final: string, overwrite: boolean) => void;

  override async lstat(value: string): Promise<Metadata | undefined> {
    const initial = await super.lstat(value);
    this.onLstat?.(value, initial);
    const node = this.nodes.get(this.key(value));
    return node ? { ...node.metadata } : undefined;
  }

  override async createExclusive(value: string): Promise<WriteHandle> {
    this.onCreateExclusive?.(value);
    return super.createExclusive(value);
  }

  override async commit(temporary: string, final: string, overwrite: boolean): Promise<boolean> {
    this.beforeCommit?.(temporary, final, overwrite);
    return super.commit(temporary, final, overwrite);
  }
}

test('observed target metadata change during verifyEntry stops transfer with PATH_CHANGED (overwrite)', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.directory('/src');
  source.file('/src/file', 'source-bytes');
  target.directory('/dst');
  target.file('/dst/file', 'old-target');

  let armed = false;
  let afterArm = 0;
  target.onCreateExclusive = () => { armed = true; };
  target.onLstat = (val) => {
    if (target.key(val) !== target.key('/dst/file')) return;
    if (armed) {
      afterArm++;
      // In verifyEntry before commit:
      // afterArm === 1 is assertGuards (sees old target metadata)
      // afterArm === 2 is resolvePath (sees mutated metadata)
      if (afterArm === 2) {
        const node = target.nodes.get(target.key('/dst/file'))!;
        node.metadata = {
          ...node.metadata,
          size: 99,
          mtime: 5555,
          identity: 'id-replaced'
        };
        node.content = Buffer.from('MUTATED-CONTENT-SHOULD-NOT-BE-OVERWRITTEN');
      }
    }
  };

  const plan = await planTransfer(
    source, target, '/src/file', '/dst/file',
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);
  assert.equal(plan.issues.length, 0);

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    'audit-observed-target', TRANSFER_LIMITS, signal()
  );

  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.filesCommitted, 0);
  assert.equal(outcome.error?.code, 'PATH_CHANGED');
  assert.equal(target.content('/dst/file'), 'MUTATED-CONTENT-SHOULD-NOT-BE-OVERWRITTEN');
  assert.equal(outcome.cleanup.complete, true);
  assert.deepEqual(outcome.cleanup.residualPaths, []);
});

test('unmodified target in overwrite mode completes successfully and commits (control)', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.directory('/src');
  source.file('/src/file', 'source-bytes');
  target.directory('/dst');
  target.file('/dst/file', 'old-target');

  const plan = await planTransfer(
    source, target, '/src/file', '/dst/file',
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    'audit-target-control', TRANSFER_LIMITS, signal()
  );

  assert.equal(outcome.phase, 'completed');
  assert.equal(outcome.filesCommitted, 1);
  assert.equal(outcome.error, undefined);
  assert.equal(target.content('/dst/file'), 'source-bytes');
});

test('observed source metadata change during verifyEntry stops transfer with PATH_CHANGED', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.directory('/src');
  source.file('/src/file', 'source-bytes');
  target.directory('/dst');

  let armed = false;
  let afterArm = 0;
  target.onCreateExclusive = () => { armed = true; };
  source.onLstat = (val) => {
    if (source.key(val) !== source.key('/src/file')) return;
    if (armed) {
      afterArm++;
      // In verifyEntry before commit:
      // afterArm === 1 is assertGuards
      // afterArm === 2 is resolvePath
      if (afterArm === 2) {
        const node = source.nodes.get(source.key('/src/file'))!;
        node.metadata = {
          ...node.metadata,
          size: 88,
          mtime: 8888,
          identity: 'source-replaced'
        };
      }
    }
  };

  const plan = await planTransfer(
    source, target, '/src/file', '/dst/file',
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' },
    'audit-observed-source', TRANSFER_LIMITS, signal()
  );

  assert.equal(outcome.phase, 'failed');
  assert.equal(outcome.filesCommitted, 0);
  assert.equal(outcome.error?.code, 'PATH_CHANGED');
  assert.equal(target.nodes.has(target.key('/dst/file')), false);
  assert.equal(outcome.cleanup.complete, true);
});

test('unmodified source completes successfully (control)', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.directory('/src');
  source.file('/src/file', 'source-bytes');
  target.directory('/dst');

  const plan = await planTransfer(
    source, target, '/src/file', '/dst/file',
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' },
    'audit-source-control', TRANSFER_LIMITS, signal()
  );

  assert.equal(outcome.phase, 'completed');
  assert.equal(outcome.filesCommitted, 1);
  assert.equal(target.content('/dst/file'), 'source-bytes');
});

test('unobserved target change after verify boundary before commit commits without full transaction guarantee', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.directory('/src');
  source.file('/src/file', 'source-bytes');
  target.directory('/dst');
  target.file('/dst/file', 'old-target');

  const seenIdentities: string[] = [];
  target.onLstat = (val, meta) => {
    if (target.key(val) === target.key('/dst/file') && meta?.identity) {
      seenIdentities.push(meta.identity);
    }
  };
  target.beforeCommit = (_temp, final, overwrite) => {
    if (!overwrite) return;
    const node = target.nodes.get(target.key(final));
    if (node) {
      node.metadata = { ...node.metadata, size: 77, mtime: 7777, identity: 'id-after-verify' };
      node.content = Buffer.from('LATE-RACE-NOT-OBSERVED');
    }
  };

  const plan = await planTransfer(
    source, target, '/src/file', '/dst/file',
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    'audit-unobserved-window', TRANSFER_LIMITS, signal()
  );

  assert.equal(seenIdentities.includes('id-after-verify'), false);
  assert.equal(outcome.phase, 'completed');
  assert.equal(outcome.filesCommitted, 1);
  assert.equal(target.content('/dst/file'), 'source-bytes');
});

test('target directory creation and normal directory mtime changes do not trigger false-alarm PATH_CHANGED', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.directory('/src/dir');
  source.file('/src/dir/file1', 'data-1');
  source.file('/src/dir/file2', 'data-2');
  target.directory('/dst');

  const plan = await planTransfer(
    source, target, '/src/dir', '/dst/dir',
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);
  assert.ok(plan.directories.includes('/dst/dir'));

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_off' },
    'audit-dir-mtime', TRANSFER_LIMITS, signal()
  );

  assert.equal(outcome.phase, 'completed');
  assert.equal(outcome.directoriesCreated, 1);
  assert.equal(outcome.filesCommitted, 2);
  assert.equal(target.content('/dst/dir/file1'), 'data-1');
  assert.equal(target.content('/dst/dir/file2'), 'data-2');
});

test('multiple files update known target guard and allow subsequent entries to verify against committed state', async () => {
  const source = new HookedMemoryFs();
  const target = new HookedMemoryFs();
  source.file('/src/a', 'source-a');
  source.file('/src/b', 'source-b');
  target.file('/dst/a', 'old-a');
  target.file('/dst/b', 'old-b');

  const plan = await planTransfer(
    source, target, '/src', '/dst',
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    TRANSFER_LIMITS, signal()
  );
  assert.equal(plan.planningComplete, true);

  const outcome = await runTransfer(
    source, target, plan,
    { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
    'audit-update-known', TRANSFER_LIMITS, signal()
  );

  assert.equal(outcome.phase, 'completed');
  assert.equal(outcome.filesCommitted, 2);
  assert.equal(target.content('/dst/a'), 'source-a');
  assert.equal(target.content('/dst/b'), 'source-b');
});
