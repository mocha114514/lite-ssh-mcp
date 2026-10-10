import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalFileSystem, validateWindowsPath } from '../src/sftp/local.js';
import { planTransfer } from '../src/sftp/planner.js';
import { runTransfer } from '../src/sftp/runner.js';
import { TRANSFER_LIMITS, policiesOf, type ConflictPolicy, type SymlinkPolicy } from '../src/sftp/types.js';

const base = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'sftp-planner', `${process.pid}-${Date.now()}`);
let serial = 0;
async function fixture() {
  const root = path.join(base, String(++serial));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await fs.mkdir(source, { recursive: true });
  return { root, source, target };
}
const local = new LocalFileSystem();
const signal = () => new AbortController().signal;
const policies = (conflictPolicy: ConflictPolicy = 'overwrite_merge_off', symlinkPolicy: SymlinkPolicy = 'symlink_follow_off') => ({ conflictPolicy, symlinkPolicy });

async function linkDirectory(from: string, to: string): Promise<void> {
  await fs.symlink(to, from, process.platform === 'win32' ? 'junction' : 'dir');
}

test('default policies are exact and independent; boolean/aliases are rejected', () => {
  assert.deepEqual(policiesOf({} as never), policies());
  for (const invalid of [true, false, 'on', 'off', 'follow', 'OVERWRITE_MERGE_ON']) {
    assert.throws(() => policiesOf({ conflictPolicy: invalid } as never));
    assert.throws(() => policiesOf({ symlinkPolicy: invalid } as never));
  }
});

test('full plan precedes writes; target path is final root and includes hidden entries', async () => {
  const { source, target } = await fixture();
  await fs.writeFile(path.join(source, 'file'), 'hello');
  await fs.writeFile(path.join(source, '.hidden'), 'hidden');
  const plan = await planTransfer(local, local, source, target, policies(), TRANSFER_LIMITS, signal());
  assert.equal(plan.planningComplete, true);
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.filesTotal, 2);
  await assert.rejects(fs.lstat(target));
  const result = await runTransfer(local, local, plan, policies(), 'fixture', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(result.filesCommitted, 2);
  assert.equal(result.bytesCommitted, 11);
  assert.deepEqual((await fs.readdir(target)).sort(), ['.hidden', 'file']);
});

test('off known conflicts block the entire plan including unrelated new children', async () => {
  const { source, target } = await fixture();
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'file'), 'old');
  await fs.writeFile(path.join(source, 'file'), 'new');
  await fs.writeFile(path.join(source, 'new'), 'new');
  const plan = await planTransfer(local, local, source, target, policies(), TRANSFER_LIMITS, signal());
  assert.equal(plan.planningComplete, true);
  assert.equal(plan.issues.filter(issue => issue.code === 'TARGET_EXISTS').length, 2);
  await assert.rejects(runTransfer(local, local, plan, policies(), 'fixture', TRANSFER_LIMITS, signal()));
  assert.equal(await fs.readFile(path.join(target, 'file'), 'utf8'), 'old');
  assert.deepEqual(await fs.readdir(target), ['file']);
});

test('merge preserves extra content and type conflicts never delete targets', async () => {
  const { source, target } = await fixture();
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'file'), 'new');
  await fs.writeFile(path.join(target, 'file'), 'old');
  await fs.writeFile(path.join(target, '.extra'), 'keep');
  const on = policies('overwrite_merge_on');
  const plan = await planTransfer(local, local, source, target, on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.equal((await runTransfer(local, local, plan, on, 'fixture', TRANSFER_LIMITS, signal())).phase, 'completed');
  assert.equal(await fs.readFile(path.join(target, 'file'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(target, '.extra'), 'utf8'), 'keep');
  await fs.mkdir(path.join(source, '.extra'));
  const conflict = await planTransfer(local, local, source, target, on, TRANSFER_LIMITS, signal());
  assert.ok(conflict.issues.some(issue => issue.code === 'PATH_TYPE_CONFLICT'));
});

test('links off are incomplete and zero-write; on keeps logical aliases and target link nodes', async () => {
  const { root, source, target } = await fixture();
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'data'), 'linked contents');
  await linkDirectory(path.join(source, 'alias_a'), outside);
  await linkDirectory(path.join(source, 'alias_b'), outside);
  const blocked = await planTransfer(local, local, source, target, policies(), TRANSFER_LIMITS, signal());
  assert.equal(blocked.planningComplete, false);
  assert.equal(blocked.issues.filter(issue => issue.code === 'SYMLINK_BLOCKED').length, 2);
  await assert.rejects(fs.lstat(target));
  const on = policies('overwrite_merge_on', 'symlink_follow_on');
  const plan = await planTransfer(local, local, source, target, on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.filesTotal, 2);
  assert.equal((await runTransfer(local, local, plan, on, 'fixture', TRANSFER_LIMITS, signal())).phase, 'completed');
  assert.equal((await fs.lstat(path.join(target, 'alias_a'))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(target, 'alias_a'))).isSymbolicLink(), false);
  assert.equal(await fs.readFile(path.join(target, 'alias_b', 'data'), 'utf8'), 'linked contents');
});

test('different source files mapped through target directory aliases conflict even with both on', async () => {
  const { root, source, target } = await fixture();
  await fs.mkdir(path.join(source, 'a'));
  await fs.mkdir(path.join(source, 'b'));
  await fs.writeFile(path.join(source, 'a', 'same'), 'a');
  await fs.writeFile(path.join(source, 'b', 'same'), 'b');
  const real = path.join(root, 'real-target');
  await fs.mkdir(real);
  await fs.mkdir(target);
  await linkDirectory(path.join(target, 'a'), real);
  await linkDirectory(path.join(target, 'b'), real);
  const on = policies('overwrite_merge_on', 'symlink_follow_on');
  const plan = await planTransfer(local, local, source, target, on, TRANSFER_LIMITS, signal());
  assert.equal(plan.planningComplete, true);
  assert.ok(plan.issues.some(issue => issue.code === 'PATH_MAPPING_CONFLICT' && issue.otherSourcePath));
  assert.deepEqual(await fs.readdir(real), []);
  await assert.rejects(runTransfer(local, local, plan, on, 'fixture', TRANSFER_LIMITS, signal()));
});

test('source directory links have branch-local cycle detection, not global alias deduplication', async () => {
  const { source, target } = await fixture();
  await linkDirectory(path.join(source, 'loop'), source);
  const plan = await planTransfer(local, local, source, target, policies('overwrite_merge_on', 'symlink_follow_on'), TRANSFER_LIMITS, signal());
  assert.equal(plan.planningComplete, false);
  assert.ok(plan.issues.some(issue => issue.code === 'SYMLINK_LOOP'));
});

test('entry and retained-memory budgets fail incomplete, not truncate-success', async () => {
  const { source, target } = await fixture();
  for (const name of ['a', 'b', 'c']) await fs.writeFile(path.join(source, name), name);
  for (const limits of [{ ...TRANSFER_LIMITS, entries: 2 }, { ...TRANSFER_LIMITS, planningBytes: 512 }]) {
    const plan = await planTransfer(local, local, source, target, policies(), limits, signal());
    assert.equal(plan.planningComplete, false);
    assert.ok(plan.issues.some(issue => issue.code === 'RESOURCE_LIMIT'));
    await assert.rejects(fs.lstat(target));
  }
});

test('create-only commit protects an externally inserted target and cleans only owned temp', async () => {
  const { source, target } = await fixture();
  const from = path.join(source, 'file');
  await fs.writeFile(from, 'new');
  const to = path.join(source, 'final');
  const plan = await planTransfer(local, local, from, to, policies(), TRANSFER_LIMITS, signal());
  // Inject the race at publication, after all pre-commit path checks.
  class RacingTarget extends LocalFileSystem {
    override async commit(temp: string, final: string, overwrite: boolean) {
      await fs.writeFile(final, 'external');
      return super.commit(temp, final, overwrite);
    }
  }
  const result = await runTransfer(local, new RacingTarget(), plan, policies(), 'fixture', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'failed');
  assert.equal(result.filesCommitted, 0);
  assert.equal(await fs.readFile(to, 'utf8'), 'external');
  assert.equal((await fs.readdir(source)).some(name => name.endsWith('.tmp')), false);
  await assert.rejects(fs.lstat(target));
});

test('observable changes after planning stop before writes', async () => {
  const { source, target } = await fixture();
  await fs.writeFile(path.join(source, 'file'), 'new');
  const plan = await planTransfer(local, local, source, target, policies(), TRANSFER_LIMITS, signal());
  await fs.writeFile(path.join(source, 'file'), 'changed source');
  const result = await runTransfer(local, local, plan, policies(), 'fixture', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'failed');
  assert.equal(result.error?.code, 'PATH_CHANGED');
  await assert.rejects(fs.lstat(target));
});

test('Windows invalid names are explicit failures, never silent renames', () => {
  for (const name of ['CON', 'nul.txt', 'LPT9', 'com¹.log', 'space ', 'dot.', 'colon:stream', 'a?b']) {
    assert.throws(() => validateWindowsPath(`C:\\fixture\\${name}`));
  }
  validateWindowsPath('C:\\fixture\\normal.txt');
});


test('local target hard-link aliases with exact file IDs cannot accept different source files', async () => {
  const { source, target } = await fixture();
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'a'), 'new a');
  await fs.writeFile(path.join(source, 'b'), 'new b');
  await fs.writeFile(path.join(target, 'a'), 'original');
  await fs.link(path.join(target, 'a'), path.join(target, 'b'));
  const on = policies('overwrite_merge_on', 'symlink_follow_on');
  const plan = await planTransfer(local, local, source, target, on, TRANSFER_LIMITS, signal());
  assert.ok(plan.issues.some(issue => issue.code === 'PATH_MAPPING_CONFLICT' && issue.otherSourcePath));
  await assert.rejects(runTransfer(local, local, plan, on, 'fixture', TRANSFER_LIMITS, signal()));
  assert.equal(await fs.readFile(path.join(target, 'a'), 'utf8'), 'original');
  assert.equal(await fs.readFile(path.join(target, 'b'), 'utf8'), 'original');
});
