import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiteSshError } from '../src/core/errors.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalFileSystem } from '../src/sftp/local.js';
import { planTransfer } from '../src/sftp/planner.js';
import { runTransfer } from '../src/sftp/runner.js';
import { TRANSFER_LIMITS, type TransferPolicies } from '../src/sftp/types.js';
import { MemoryTransferFileSystem } from './helpers/memory-transfer.js';

const off: TransferPolicies = { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_on' };
const signal = () => new AbortController().signal;

function aliases() {
  // No synthetic source inode: this also models the SFTP v3 limitation. Link
  // resolution to the exact same POSIX path is sufficient evidence of sameness.
  const source = new MemoryTransferFileSystem('posix', false);
  source.directory('/remote');
  source.file('/remote/A', 'payload');
  source.symlink('/remote/a', 'A');
  const target = new MemoryTransferFileSystem('windows');
  return { source, target };
}

test('F10 casefold path comparison never schedules mkdir for a target file leaf', async () => {
  const { source, target } = aliases();
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  assert.equal(plan.planningComplete, true);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.directories, ['C:\\inbox']);
});

test('F10 same source and same casefold target retain both mappings but commit physically once', async () => {
  const { source, target } = aliases();
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  const files = plan.entries.filter(entry => entry.kind === 'file');
  assert.equal(files.length, 2);
  assert.deepEqual(files.map(entry => entry.sourcePath), ['/remote/A', '/remote/a']);
  assert.equal(plan.links.length, 1);
  assert.equal(plan.filesTotal, 1);
  assert.equal(plan.bytesTotal, 7);
  const result = await runTransfer(source, target, plan, off, 'shared', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(target.commits, 1);
  assert.equal(source.reads, 1);
  assert.equal(result.filesCommitted, 1);
  assert.equal(result.bytesTransferred, 7);
  assert.equal(result.bytesCommitted, 7);
  assert.deepEqual(files.map(entry => result.results.get(entry)?.state), ['committed', 'merged']);
  assert.equal(target.text('C:\\inbox\\A'), 'payload');
  assert.equal(target.text('C:\\inbox\\a'), 'payload');
});

for (const contents of ['different', 'payload']) {
  for (const conflictPolicy of ['overwrite_merge_off', 'overwrite_merge_on'] as const) {
    test(`F10 independent POSIX A/a (${contents}, ${conflictPolicy}) collide before any target write`, async () => {
      const source = new MemoryTransferFileSystem('posix', false);
      source.directory('/remote');
      source.file('/remote/A', 'payload');
      source.file('/remote/a', contents);
      assert.notEqual(source.key('/remote/A'), source.key('/remote/a'));
      const target = new MemoryTransferFileSystem('windows');
      const policies = { ...off, conflictPolicy };
      const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', policies, TRANSFER_LIMITS, signal());
      assert.equal(plan.planningComplete, true);
      assert.ok(plan.issues.some(issue => issue.code === 'PATH_MAPPING_CONFLICT'));
      await assert.rejects(runTransfer(source, target, plan, policies, 'collision', TRANSFER_LIMITS, signal()));
      assert.deepEqual(target.mutations, []);
      assert.equal(target.commits, 0);
    });
  }
}

test('F10 same source at different POSIX targets is copied separately, not globally deduplicated', async () => {
  const { source } = aliases();
  const target = new MemoryTransferFileSystem('posix');
  const plan = await planTransfer(source, target, '/remote', '/target', off, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.filesTotal, 2);
  assert.equal(plan.bytesTotal, 14);
  const result = await runTransfer(source, target, plan, off, 'distinct', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(target.commits, 2);
  assert.equal(result.filesCommitted, 2);
  assert.equal(result.bytesCommitted, 14);
  assert.equal(target.text('/target/A'), 'payload');
  assert.equal(target.text('/target/a'), 'payload');
});

test('F10 an existing shared target still obeys overwrite-off preflight', async () => {
  const { source, target } = aliases();
  target.directory('C:\\inbox');
  target.file('C:\\inbox\\A', 'original');
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  assert.ok(plan.issues.some(issue => issue.code === 'TARGET_EXISTS'));
  await assert.rejects(runTransfer(source, target, plan, off, 'existing', TRANSFER_LIMITS, signal()));
  assert.deepEqual(target.mutations, []);
  assert.equal(target.text('C:\\inbox\\A'), 'original');
});

test('F10 coalescing keeps the nonrepresentative source link guard through the final copy check', async () => {
  const { source, target } = aliases();
  source.file('/remote/B', 'other');
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  let changed = false;
  source.onRead = () => {
    if (!changed) {
      changed = true;
      // Keep size/mtime the same and replace only the nonrepresentative link
      // target. A representative-only guard check cannot detect this change.
      source.symlink('/remote/a', 'B');
    }
  };
  const result = await runTransfer(source, target, plan, off, 'changed', TRANSFER_LIMITS, signal());
  assert.equal(changed, true, 'The copy must reach the injected alias change, not fail earlier.');
  assert.equal(source.reads, 1);
  assert.equal(result.error?.code, 'PATH_CHANGED');
  assert.equal(result.filesCommitted, 0);
  assert.equal(target.commits, 0);
  assert.equal(target.text('C:\\inbox\\A'), undefined);
  assert.equal(result.cleanup.complete, true);
});

test('F10 shared logical mappings complete without a second create-only publication', async () => {
  const { source, target } = aliases();
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  const result = await runTransfer(source, target, plan, off, 'publication', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed', JSON.stringify({
    phase: result.phase, filesCommitted: result.filesCommitted,
    directoriesCreated: result.directoriesCreated, bytesTransferred: result.bytesTransferred,
    errorCode: result.error?.code, sourceReads: source.reads, physicalCommits: target.commits
  }));
  assert.equal(result.filesCommitted, 1);
  assert.equal(result.bytesCommitted, 7);
  assert.equal(target.commits, 1);
});

test('F10 actual Windows default-casefold target has one committed file for both source aliases', {
  skip: process.platform !== 'win32'
}, async () => {
  const { source } = aliases();
  const base = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'shared-copy-real', `${process.pid}-${Date.now()}`);
  await fs.mkdir(base, { recursive: true });
  const destination = path.join(base, 'target');
  const target = new LocalFileSystem();
  const plan = await planTransfer(source, target, '/remote', destination, off, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  const result = await runTransfer(source, target, plan, off, 'real-casefold', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(result.filesCommitted, 1);
  assert.equal(result.bytesCommitted, 7);
  assert.deepEqual(await fs.readdir(destination), ['A']);
  assert.equal(await fs.readFile(path.join(destination, 'a'), 'utf8'), 'payload');
  assert.equal((await target.lstat(path.join(destination, 'A')))?.identity,
    (await target.lstat(path.join(destination, 'a')))?.identity);
  assert.equal(plan.entries.filter(entry => entry.kind === 'file').length, 2);
});

test('F10 distinct publication names are not coalesced merely because old target hard-links share an inode', async () => {
  const source = new MemoryTransferFileSystem('posix', false);
  source.directory('/remote');
  source.file('/remote/one', 'payload');
  source.symlink('/remote/two', 'one');
  const base = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'shared-copy-hardlinks', `${process.pid}-${Date.now()}`);
  await fs.mkdir(base, { recursive: true });
  const one = path.join(base, 'one');
  const two = path.join(base, 'two');
  await fs.writeFile(one, 'old');
  await fs.link(one, two);
  const target = new LocalFileSystem();
  assert.equal((await target.lstat(one))?.identity, (await target.lstat(two))?.identity);
  const policies = { ...off, conflictPolicy: 'overwrite_merge_on' as const };
  const plan = await planTransfer(source, target, '/remote', base, policies, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.filesTotal, 2);
  const result = await runTransfer(source, target, plan, policies, 'distinct-hardlinks', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(result.filesCommitted, 2);
  assert.equal(result.bytesCommitted, 14);
  assert.equal(await fs.readFile(one, 'utf8'), 'payload');
  assert.equal(await fs.readFile(two, 'utf8'), 'payload');
});

test('F10 cancellation after common publication retains every completed logical mapping', async () => {
  const { source, target } = aliases();
  const controller = new AbortController();
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, controller.signal);
  const files = plan.entries.filter(entry => entry.kind === 'file');
  let statesAtPublication: Array<string | undefined> = [];
  const result = await runTransfer(source, target, plan, off, 'cancel-after-shared-commit', TRANSFER_LIMITS, controller.signal,
    (progress, results) => {
      if (progress.filesCommitted === 1 && !controller.signal.aborted) {
        statesAtPublication = files.map(entry => results.get(entry)?.state);
        controller.abort();
      }
    });
  assert.equal(result.phase, 'cancelled');
  assert.equal(result.filesCommitted, 1);
  assert.equal(result.bytesTransferred, 7);
  assert.equal(result.bytesCommitted, 7);
  assert.equal(target.commits, 1);
  assert.equal(source.reads, 1);
  assert.equal(target.text('C:\\inbox\\a'), 'payload');
  assert.equal(result.cleanup.complete, true);
  assert.deepEqual(files.map(entry => result.results.get(entry)?.state), ['committed', 'merged']);
  assert.deepEqual(statesAtPublication, ['committed', 'merged'], 'Public progress must include all mappings fulfilled by that publication.');
  assert.deepEqual(result.results.get(files[1]!), {
    state: 'merged', bytesTransferred: 0, sharedCommitTargetPath: files[0]!.actualTargetPath
  });
});

test('F10 unrelated entry failure cannot hide an earlier common publication from a later alias', async () => {
  class UnrelatedReadFailure extends MemoryTransferFileSystem {
    override async openRead(value: string) {
      if (value === '/remote/M') throw new LiteSshError('FILE_IO_FAILED', 'Synthetic unrelated read failure.');
      return super.openRead(value);
    }
  }
  const source = new UnrelatedReadFailure('posix', false);
  source.directory('/remote');
  source.file('/remote/A', 'payload');
  source.file('/remote/M', 'other');
  source.symlink('/remote/a', 'A');
  const target = new MemoryTransferFileSystem('windows');
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  const files = plan.entries.filter(entry => entry.kind === 'file');
  assert.deepEqual(files.map(entry => entry.sourcePath), ['/remote/A', '/remote/M', '/remote/a']);
  const result = await runTransfer(source, target, plan, off, 'failure-before-later-alias', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'partial_failed');
  assert.equal(result.error?.code, 'FILE_IO_FAILED');
  assert.equal(result.filesCommitted, 1);
  assert.equal(result.bytesCommitted, 7);
  assert.equal(target.commits, 1);
  assert.equal(source.reads, 1);
  assert.equal(result.cleanup.complete, true);
  assert.equal(target.text('C:\\inbox\\a'), 'payload');
  assert.deepEqual(files.map(entry => result.results.get(entry)?.state), ['committed', 'failed', 'merged']);
  assert.equal(result.results.get(files[2]!)?.sharedCommitTargetPath, files[0]!.actualTargetPath);
});

test('F10 acknowledged shared results do not skip later logical alias guard checks', async () => {
  const { source, target } = aliases();
  source.file('/remote/B', 'other');
  const plan = await planTransfer(source, target, '/remote', 'C:\\inbox', off, TRANSFER_LIMITS, signal());
  const files = plan.entries.filter(entry => entry.kind === 'file');
  let changed = false;
  const result = await runTransfer(source, target, plan, off, 'later-alias-guard', TRANSFER_LIMITS, signal(), progress => {
    if (progress.filesCommitted === 1 && !changed) {
      changed = true;
      source.symlink('/remote/a', 'B');
    }
  });
  assert.equal(changed, true);
  assert.equal(result.phase, 'partial_failed');
  assert.equal(result.error?.code, 'PATH_CHANGED');
  assert.equal(result.filesCommitted, 1);
  assert.equal(result.bytesCommitted, 7);
  assert.equal(target.commits, 1);
  assert.equal(target.text('C:\\inbox\\a'), 'payload');
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.results.get(files[0]!)?.state, 'committed');
  assert.deepEqual(result.results.get(files[1]!), {
    state: 'merged', bytesTransferred: 0, sharedCommitTargetPath: files[0]!.actualTargetPath
  }, 'A later changed guard stops scheduling but cannot erase the prior publication acknowledgement.');
});
