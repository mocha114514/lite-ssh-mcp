import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { LiteSshError } from '../src/core/errors.js';
import { LocalFileSystem, normalizeLocalPath } from '../src/sftp/local.js';
import { normalizeRemotePath } from '../src/sftp/remote.js';
import { appendLogicalPath, resolvePath } from '../src/sftp/paths.js';
import { planTransfer } from '../src/sftp/planner.js';
import { runTransfer } from '../src/sftp/runner.js';
import { TRANSFER_LIMITS } from '../src/sftp/types.js';
import { MemorySftpFs } from './helpers/memory-sftp.js';

const on = {
  conflictPolicy: 'overwrite_merge_on',
  symlinkPolicy: 'symlink_follow_on'
} as const;
const signal = () => new AbortController().signal;

function linkedNamespace(): MemorySftpFs {
  const files = new MemorySftpFs();
  files.directory('/outside/sub');
  files.link('/d/a/link', '/outside/sub');
  files.file('/outside/f', 'correct object');
  files.file('/d/a/f', 'wrong object');
  return files;
}

async function resolve(files: MemorySftpFs, value: string, side: 'source' | 'target' = 'source') {
  return resolvePath(files, value, side, 'symlink_follow_on', signal(), TRANSFER_LIMITS.depth);
}

test('accepted paths preserve link/.. before any physical resolution', () => {
  const input = `${path.parse(homedir()).root}synthetic${path.sep}link${path.sep}..${path.sep}f`;
  assert.equal(normalizeLocalPath(input), input);
  assert.equal(normalizeLocalPath('~/link/../f'), `${homedir()}${path.sep}link${path.sep}..${path.sep}f`);
  assert.equal(normalizeRemotePath('/d/a/link/../f'), '/d/a/link/../f');
  assert.equal(appendLogicalPath(path.posix, '/d/a/link/..', 'f'), '/d/a/link/../f');
  assert.equal(appendLogicalPath(path.win32, 'C:\\d\\link\\..', 'f'), 'C:\\d\\link\\..\\f');
});

test('request parent-link resolution selects the real source and target, not the lexical sibling', async () => {
  const source = linkedNamespace();
  const target = linkedNamespace();
  const sourcePath = normalizeRemotePath('/d/a/link/../f');
  const targetPath = normalizeRemotePath('/d/a/link/../f');
  const plan = await planTransfer(source, target, sourcePath, targetPath, on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.entries[0]?.actualSourcePath, '/outside/f');
  assert.equal(plan.entries[0]?.actualTargetPath, '/outside/f');
  const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.deepEqual(source.reads, ['/outside/f']);
  assert.equal(target.content('/outside/f'), 'correct object');
  assert.equal(target.content('/d/a/f'), 'wrong object');
  assert.equal((await target.lstat('/d/a/link'))?.kind, 'symlink');
});

test('default-off cannot skip a parent link hidden before ..', async () => {
  for (const side of ['source', 'target'] as const) {
    const source = linkedNamespace();
    const target = linkedNamespace();
    const plan = await planTransfer(
      source, target,
      side === 'source' ? '/d/a/link/../f' : '/outside/f',
      side === 'target' ? '/d/a/link/../f' : '/outside/f',
      { conflictPolicy: 'overwrite_merge_on', symlinkPolicy: 'symlink_follow_off' },
      TRANSFER_LIMITS, signal()
    );
    assert.ok(plan.issues.some(issue => issue.code === 'SYMLINK_BLOCKED' && issue.side === side));
    assert.equal(plan.planningComplete, false);
    assert.deepEqual(target.mutations, []);
  }
});

test('absolute and relative link contents preserve nested link/.. for reads and publication', async () => {
  for (const linkTarget of ['link/../f', '/d/a/link/../f']) {
    const source = linkedNamespace();
    const target = linkedNamespace();
    source.link('/d/a/ref', linkTarget);
    target.link('/d/a/ref', linkTarget);
    const plan = await planTransfer(source, target, '/d/a/ref', '/d/a/ref', on, TRANSFER_LIMITS, signal());
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.entries[0]?.actualSourcePath, '/outside/f');
    assert.equal(plan.entries[0]?.actualTargetPath, '/outside/f');
    const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
    assert.equal(result.phase, 'completed');
    assert.deepEqual(source.reads, ['/outside/f']);
    assert.equal(target.content('/d/a/f'), 'wrong object');
    assert.equal(await target.readlink('/d/a/ref'), linkTarget);
  }
});

test('recursive child mapping does not normalize away its logical parent link', async () => {
  const source = linkedNamespace();
  const target = linkedNamespace();
  source.directory('/outside/tree');
  source.file('/outside/tree/child', 'real child');
  source.directory('/d/a/tree');
  source.file('/d/a/tree/child', 'wrong child');
  target.directory('/outside/tree');
  target.directory('/d/a/tree');
  target.file('/d/a/tree/child', 'untouched');
  const plan = await planTransfer(
    source, target, '/d/a/link/../tree', '/d/a/link/../tree', on, TRANSFER_LIMITS, signal()
  );
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.entries[1]?.sourcePath, '/d/a/link/../tree/child');
  assert.equal(plan.entries[1]?.actualSourcePath, '/outside/tree/child');
  assert.equal(plan.entries[1]?.actualTargetPath, '/outside/tree/child');
  const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(target.content('/outside/tree/child'), 'real child');
  assert.equal(target.content('/d/a/tree/child'), 'untouched');
});

test('links to the filesystem root return its directory metadata and permit an empty merge', async () => {
  const source = new MemorySftpFs();
  source.directory('/empty');
  source.link('/root_alias', '/');
  assert.equal((await resolve(source, '/root_alias')).metadata?.kind, 'directory');
  const target = new MemorySftpFs();
  target.link('/dest', '/');
  const plan = await planTransfer(source, target, '/empty', '/dest', on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.entries[0]?.actualTargetPath, '/');
  const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal((await target.lstat('/dest'))?.kind, 'symlink');
});

test('finite repeated links consume the suffix rather than being mistaken for a cycle', async () => {
  const files = new MemorySftpFs();
  files.directory('/d');
  files.link('/d/link', '/d');
  files.file('/d/f', 'value');
  const result = await resolve(files, '/d/link/link/f');
  assert.equal(result.actualPath, '/d/f');
  assert.equal(result.metadata?.kind, 'file');
  assert.equal(result.links.length, 2);
});

test('true link cycles still stop, and finite expansion budget exhaustion is RESOURCE_LIMIT', async () => {
  const cycle = new MemorySftpFs();
  cycle.link('/a', '/b');
  cycle.link('/b', '/a');
  await assert.rejects(resolve(cycle, '/a'), { code: 'SYMLINK_LOOP' });
  const chain = new MemorySftpFs();
  chain.link('/a', '/b');
  chain.link('/b', '/c');
  chain.link('/c', '/d');
  chain.file('/d', 'value');
  await assert.rejects(resolvePath(chain, '/a', 'source', 'symlink_follow_on', signal(), 2), {
    code: 'RESOURCE_LIMIT'
  });
});

test('cycle states are charged before retaining them', async () => {
  const files = linkedNamespace();
  let charged = 0;
  await assert.rejects(resolvePath(
    files, '/d/a/link/../f', 'source', 'symlink_follow_on', signal(), TRANSFER_LIMITS.depth,
    undefined,
    state => {
      charged++;
      assert.ok(state.includes('required'));
      throw new LiteSshError('RESOURCE_LIMIT', 'Synthetic state budget');
    }
  ), { code: 'RESOURCE_LIMIT' });
  assert.equal(charged, 1);
});

test('file/.. and missing-source/.. cannot become an unrelated existing file', async () => {
  const files = new MemorySftpFs();
  files.file('/file', 'first');
  files.file('/f', 'sibling');
  await assert.rejects(resolve(files, '/file/../f'), { code: 'PATH_TYPE_CONFLICT' });
  await assert.rejects(resolve(files, '/file/.'), { code: 'PATH_TYPE_CONFLICT' });
  await assert.rejects(resolve(files, '/missing/../f'), { code: 'PATH_NOT_FOUND' });
});

test('missing target parent followed by .. retains the existing final-object conflict', async () => {
  const source = new MemorySftpFs();
  source.file('/source', 'replacement');
  const target = new MemorySftpFs();
  target.file('/target/f', 'original');
  const plan = await planTransfer(
    source, target, '/source', '/target/new/../f',
    { conflictPolicy: 'overwrite_merge_off', symlinkPolicy: 'symlink_follow_on' },
    TRANSFER_LIMITS, signal()
  );
  assert.ok(plan.issues.some(issue => issue.code === 'TARGET_EXISTS' && issue.actualPath === '/target/f'));
  assert.equal(plan.entries[0]?.actualTargetPath, '/target/f');
  assert.deepEqual(target.mutations, []);
});

test('a missing directory revisited as a file leaf is a type conflict before any writes', async () => {
  const source = new MemorySftpFs();
  source.file('/source', 'data');
  for (const targetPath of ['/new/../new', '/new/.', '/new/']) {
    const target = new MemorySftpFs();
    const plan = await planTransfer(source, target, '/source', targetPath, on, TRANSFER_LIMITS, signal());
    assert.ok(plan.issues.some(issue => issue.code === 'PATH_TYPE_CONFLICT'));
    assert.deepEqual(target.mutations, []);
  }
});

test('Windows separator, drive and UNC root handling preserve nested link semantics', async () => {
  const files = new MemorySftpFs(path.win32, 'windows', 'C:\\');
  files.directory('D:\\outside\\sub');
  files.link('C:\\d\\link', 'D:/outside/sub');
  files.file('D:\\outside\\f', 'real');
  assert.equal((await resolve(files, 'C:/d/link/../f')).actualPath, 'D:\\outside\\f');
  files.link('C:\\root_alias', 'D:\\');
  assert.equal((await resolve(files, 'C:\\root_alias')).metadata?.kind, 'directory');
  files.directory('C:\\outside\\sub');
  files.file('C:\\outside\\f', 'root relative');
  files.link('C:\\d\\root_relative', '\\outside\\sub');
  assert.equal((await resolve(files, 'C:\\d\\root_relative\\..\\f')).actualPath, 'C:\\outside\\f');
  files.directory('C:\\d\\relative');
  files.file('C:\\d\\f', 'same drive');
  files.link('C:\\d\\drive_relative', 'C:relative');
  assert.equal((await resolve(files, 'C:\\d\\drive_relative\\..\\f')).actualPath, 'C:\\d\\f');
  files.directory('\\\\server\\share\\outside\\sub');
  files.file('\\\\server\\share\\outside\\f', 'unc');
  files.link('C:\\unc_alias', '\\\\server\\share\\outside\\sub');
  assert.equal((await resolve(files, 'C:\\unc_alias\\..\\f')).actualPath, '\\\\server\\share\\outside\\f');
});

test('dangling links, empty link contents and directory-only link targets fail explicitly', async () => {
  const files = new MemorySftpFs();
  files.link('/dangling', '/missing');
  files.link('/empty', '');
  files.file('/file', 'data');
  files.link('/directory_syntax', '/file/');
  await assert.rejects(resolve(files, '/dangling'), { code: 'BROKEN_SYMLINK' });
  await assert.rejects(resolve(files, '/empty'), { code: 'BROKEN_SYMLINK' });
  await assert.rejects(resolve(files, '/directory_syntax'), { code: 'PATH_TYPE_CONFLICT' });
});

test('a missing ordinary parent is created before publishing through its .. path', async () => {
  const source = new MemorySftpFs();
  source.file('/source', 'replacement');
  const target = new MemorySftpFs();
  target.file('/target/f', 'original');
  const plan = await planTransfer(source, target, '/source', '/target/new/../f', on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(plan.directories, ['/target/new']);
  const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'completed');
  assert.equal(result.directoriesCreated, 1);
  assert.equal((await target.lstat('/target/new'))?.kind, 'directory');
  assert.equal(target.content('/target/f'), 'replacement');
});

test('a changed traversed link directory stops scheduling before any target writes', async () => {
  const source = linkedNamespace();
  const target = new MemorySftpFs();
  const plan = await planTransfer(source, target, '/d/a/link/../f', '/dest', on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  source.nodes.delete(source.key('/outside/sub'));
  source.directory('/outside/sub');
  const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'failed');
  assert.equal(result.error?.code, 'PATH_CHANGED');
  assert.deepEqual(target.mutations, []);
});

test('growing queues and oversized link targets fail within the resolver without plan callbacks', async () => {
  const growing = new MemorySftpFs();
  growing.link('/grow', '/grow/tail');
  await assert.rejects(resolvePath(growing, '/grow', 'source', 'symlink_follow_on', signal(), 4), {
    code: 'RESOURCE_LIMIT'
  });
  const large = new MemorySftpFs();
  large.link('/large', `/${'a'.repeat(32_768)}`);
  await assert.rejects(resolve(large, '/large'), { code: 'RESOURCE_LIMIT' });
});

test('the intrinsic scratch byte limit stops large finite states without a planning callback', async () => {
  const files = new MemorySftpFs();
  const parent = `/d/${'界'.repeat(12_000)}`;
  files.directory(parent);
  files.link(`${parent}/ln`, parent);
  files.file(`${parent}/f`, 'value');
  const input = `${parent}${'/ln'.repeat(110)}/f`;
  await assert.rejects(resolve(files, input), error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'RESOURCE_LIMIT');
    assert.ok(error.message.includes('scratch budget'));
    return true;
  });
});

test('local source opening requests nonblocking/no-follow flags and retains the acquired handle', async () => {
  const original = fs.open;
  let observed: number | undefined;
  let closes = 0;
  fs.open = (async (_value, flags) => {
    observed = flags as number;
    return { close: async () => { closes++; } } as unknown as FileHandle;
  }) as typeof fs.open;
  try {
    const handle = await new LocalFileSystem().openRead('synthetic-only-no-filesystem-access');
    assert.equal(observed, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    await handle.close();
    assert.equal(closes, 1);
  } finally {
    fs.open = original;
  }
});

test('an opened special-object replacement is rejected and closed before any target write', async () => {
  let reads = 0;
  let closes = 0;
  class ReplacedSource extends MemorySftpFs {
    override async openRead(value: string) {
      const handle = await super.openRead(value);
      return {
        stat: async () => ({ ...(await handle.stat()), kind: 'special' as const }),
        read: async () => { reads++; return 0; },
        close: async () => { closes++; }
      };
    }
  }
  const source = new ReplacedSource();
  source.file('/source', 'data');
  const target = new MemorySftpFs();
  const plan = await planTransfer(source, target, '/source', '/dest', on, TRANSFER_LIMITS, signal());
  assert.deepEqual(plan.issues, []);
  const result = await runTransfer(source, target, plan, on, 'synthetic', TRANSFER_LIMITS, signal());
  assert.equal(result.phase, 'failed');
  assert.equal(result.error?.code, 'PATH_CHANGED');
  assert.equal(reads, 0);
  assert.equal(closes, 1);
  assert.deepEqual(target.mutations, []);
});
