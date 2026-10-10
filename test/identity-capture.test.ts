import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { ensureConfigurationFiles } from '../src/config/bootstrap.js';
import { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';
import {
  ensurePrivateDirectory,
  unlinkOwnedFile,
  type PrivateObjectIdentity
} from '../src/platform/permissions.js';
import { fixtureRoot } from './helpers/workspace.js';

const root = () => fixtureRoot('identity-capture', randomUUID());
const secretMarker = 'synthetic_OS_error_must_not_be_returned';

function injectStatFailure(t: TestContext, select: (name: string) => boolean) {
  const originalOpen = fs.open.bind(fs);
  const acquired: Array<{ path: string; identity: PrivateObjectIdentity; closes: number }> = [];
  t.mock.method(fs, 'open', async (
    value: Parameters<typeof fs.open>[0],
    flags: Parameters<typeof fs.open>[1],
    mode?: Parameters<typeof fs.open>[2]
  ) => {
    const handle = await originalOpen(value, flags, mode);
    if (flags === 'wx' && select(String(value))) {
      // The test harness keeps acquisition evidence ONLY for its own teardown.
      // The application receives a real handle whose first identity observation
      // fails, and must not use a pathname/boolean as invented ownership proof.
      const identity = await handle.stat({ bigint: true });
      const record = { path: String(value), identity, closes: 0 };
      acquired.push(record);
      const originalClose = handle.close.bind(handle);
      t.mock.method(handle, 'stat', async () => {
        throw Object.assign(new Error(secretMarker), { code: 'EIO' });
      });
      t.mock.method(handle, 'close', async () => {
        record.closes++;
        await originalClose();
      });
    }
    return handle;
  });
  // recorder imports the builtin's named open export, whereas bootstrap/store
  // use the promises object. Synchronize only inside this isolated test process.
  syncBuiltinESMExports();
  return {
    acquired,
    async restore() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const item of acquired) {
        await unlinkOwnedFile(item.path, item.identity);
      }
    }
  };
}

function assertSafeFailure(error: unknown, code: string): LiteSshError {
  assert.ok(error instanceof LiteSshError);
  assert.equal(error.code, code);
  assert.equal(JSON.stringify({ message: error.message, details: error.details }).includes(secretMarker), false);
  return error;
}

test('bootstrap identity-capture failure closes acquired handle, writes no JSON and reports uncertain temporary', async t => {
  const directory = root();
  const config = path.join(directory, 'config.json');
  const fault = injectStatFailure(t, name => name.startsWith(directory) && name.endsWith('.init.tmp'));
  try {
    await assert.rejects(ensureConfigurationFiles(config), error => {
      const failure = assertSafeFailure(error, 'CONFIG_INIT_FAILED');
      assert.equal(failure.details.cleanupComplete, false);
      assert.deepEqual(failure.details.possibleResidualPaths, [fault.acquired[0]!.path]);
      return true;
    });
    assert.equal(fault.acquired.length, 1);
    assert.equal(fault.acquired[0]!.closes, 1);
    assert.equal((await fs.stat(fault.acquired[0]!.path)).size, 0);
    await assert.rejects(fs.lstat(config), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(directory, 'config.example.json')), { code: 'ENOENT' });
  } finally { await fault.restore(); }
});

test('configuration atomic writer identity-capture failure closes handle and preserves original configuration', async t => {
  const directory = root();
  await ensurePrivateDirectory(directory);
  const config = path.join(directory, 'config.json');
  const original = JSON.stringify({ version: 2, servers: { '127.0.0.1': { '22222': {
    accounts: { fixture_user: { auth: { type: 'password', password: 'synthetic_only' } } }
  } } } });
  await fs.writeFile(config, original, { mode: 0o600 });
  const store = new ConfigStore(config);
  const fault = injectStatFailure(t, name => name.startsWith(directory) && name.endsWith('.tmp'));
  try {
    await assert.rejects(store.confirmHostKey({ ip: '127.0.0.1', port: 22222 }, `SHA256:${'A'.repeat(43)}`), error => {
      const failure = assertSafeFailure(error, 'CONFIG_WRITE_FAILED');
      assert.equal(failure.details.cleanupComplete, false);
      assert.deepEqual(failure.details.possibleResidualPaths, [fault.acquired[0]!.path]);
      return true;
    });
    assert.equal(fault.acquired.length, 1);
    assert.equal(fault.acquired[0]!.closes, 1);
    assert.equal((await fs.stat(fault.acquired[0]!.path)).size, 0);
    assert.equal(await fs.readFile(config, 'utf8'), original);
    await assert.rejects(fs.lstat(`${config}.lock`), { code: 'ENOENT' });
  } finally { await fault.restore(); }
});

test('cache factory identity-capture failure closes handle and emits no header or guessed deletion', async t => {
  const directory = root();
  const fault = injectStatFailure(t, name => name.startsWith(directory));
  try {
    await assert.rejects(ReadableRecorder.create({
      ip: '127.0.0.1', port: 22222, username: 'fixture_user', codename: 'identity_fault'
    }, directory), error => {
      const failure = assertSafeFailure(error, 'CACHE_WRITE_FAILED');
      assert.equal(failure.details.cacheRemoved, false);
      assert.equal(failure.details.cachePath, fault.acquired[0]!.path);
      assert.match(String(failure.details.cleanupError), /acquisition_identity_unavailable/);
      return true;
    });
    assert.equal(fault.acquired.length, 1);
    assert.equal(fault.acquired[0]!.closes, 1);
    assert.equal((await fs.stat(fault.acquired[0]!.path)).size, 0);
  } finally { await fault.restore(); }
});

test('lock cleanup failure preserves both committed-change facts and primary write failures', async t => {
  for (const committed of [true, false]) {
    const directory = root();
    await ensurePrivateDirectory(directory);
    const config = path.join(directory, 'config.json');
    const lock = `${config}.lock`;
    const moved = `${lock}.owned-moved`;
    const original = JSON.stringify({ version: 2, servers: { '127.0.0.1': { '22222': {
      accounts: { fixture_user: { auth: { type: 'password', password: 'synthetic_only' } } }
    } } } });
    await fs.writeFile(config, original, { mode: 0o600 });
    const originalOpen = fs.open.bind(fs);
    const originalRename = fs.rename.bind(fs);
    const owned: Array<{ path: string; identity: PrivateObjectIdentity }> = [];
    let lockCloses = 0;
    t.mock.method(fs, 'open', async (
      value: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2]
    ) => {
      const handle = await originalOpen(value, flags, mode);
      if (String(value) === lock && flags === 'wx') {
        owned.push({ path: moved, identity: await handle.stat({ bigint: true }) });
        const close = handle.close.bind(handle);
        t.mock.method(handle, 'close', async () => { lockCloses++; await close(); });
      }
      return handle;
    });
    t.mock.method(fs, 'rename', async (
      from: Parameters<typeof fs.rename>[0],
      to: Parameters<typeof fs.rename>[1]
    ) => {
      if (String(to) !== config) return originalRename(from, to);
      if (committed) await originalRename(from, to);
      await originalRename(lock, moved);
      const foreign = await originalOpen(lock, 'wx', 0o600);
      owned.push({ path: lock, identity: await foreign.stat({ bigint: true }) });
      await foreign.writeFile('foreign replacement fixture');
      await foreign.close();
      if (!committed) throw Object.assign(new Error(secretMarker), { code: 'EIO' });
    });
    try {
      await assert.rejects(new ConfigStore(config).confirmHostKey(
        { ip: '127.0.0.1', port: 22222 }, `SHA256:${'A'.repeat(43)}`
      ), error => {
        const failure = assertSafeFailure(error, committed ? 'CONFIG_LOCK_CLEANUP_FAILED' : 'CONFIG_WRITE_FAILED');
        assert.equal(failure.details.confirmationCompleted, committed);
        assert.equal(failure.details.configurationChanged, committed);
        const cleanup = failure.details.lockCleanup as Record<string, unknown>;
        assert.equal(cleanup.complete, false);
        assert.equal(cleanup.removalConfirmed, false);
        assert.equal(cleanup.handleCloseConfirmed, true);
        assert.deepEqual(cleanup.possibleResidualPaths, [lock]);
        return true;
      });
      assert.equal(lockCloses, 1);
      assert.equal(await fs.readFile(lock, 'utf8'), 'foreign replacement fixture');
      const current = await fs.readFile(config, 'utf8');
      if (committed) assert.equal(JSON.parse(current).servers['127.0.0.1']['22222'].hostKeyFingerprint, `SHA256:${'A'.repeat(43)}`);
      else assert.equal(current, original);
    } finally {
      t.mock.restoreAll();
      for (const item of owned) await unlinkOwnedFile(item.path, item.identity);
    }
  }
});
