import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readConfigurationText } from '../src/config/file.js';
import { parseJsonStrict } from '../src/config/json.js';
import { MAX_CONFIG_BYTES, MAX_CONFIG_DEPTH, MAX_CONFIG_NODES } from '../src/config/limits.js';
import { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';
import { ensurePrivateDirectory, unlinkOwnedFile } from '../src/platform/permissions.js';
import { fixtureRoot } from './helpers/workspace.js';

const root = fixtureRoot('bounded-config');
let serial = 0;
async function fixture(text = '{"version":2,"servers":{}}') {
  const directory = path.join(root, String(++serial));
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, 'config.json');
  await fs.writeFile(file, text, { mode: 0o600 });
  return { directory, file, text };
}

test('configuration bytes use bounded FD reads, not unbounded readFile', async t => {
  const f = await fixture();
  t.mock.method(fs, 'readFile', async () => { throw new Error('unbounded reader forbidden'); });
  assert.equal(await readConfigurationText(f.file), f.text);
  assert.deepEqual(await new ConfigStore(f.file).listConfigurations(), []);
});

test('configuration non-regular and oversize gates perform zero opens; missing stays CONFIG_NOT_FOUND', async t => {
  const f = await fixture();
  const created = await fs.open(f.file, 'r+');
  try { await created.truncate(MAX_CONFIG_BYTES + 1); }
  finally { await created.close(); }
  const open = t.mock.method(fs, 'open');
  await assert.rejects(readConfigurationText(f.file), { code: 'RESOURCE_LIMIT' });
  await assert.rejects(readConfigurationText(f.directory), { code: 'CONFIG_INVALID' });
  await assert.rejects(readConfigurationText(path.join(f.directory, 'missing')), { code: 'CONFIG_NOT_FOUND' });
  assert.equal(open.mock.callCount(), 0);
});

test('configuration first acquired fstat failure closes once without exposing native context', async t => {
  const f = await fixture();
  const originalOpen = fs.open;
  let closes = 0;
  let reads = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { closes++; await close(); });
    t.mock.method(handle, 'stat', async () => { throw new Error('synthetic_secret_native_context'); });
    t.mock.method(handle, 'read', async () => { reads++; throw new Error('must not read'); });
    return handle;
  });
  await assert.rejects(readConfigurationText(f.file), error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.equal(JSON.stringify(error.toResult()).includes('synthetic_secret_native_context'), false);
    return true;
  });
  assert.equal(closes, 1);
  assert.equal(reads, 0);
});

test('configuration reader bounds admission and hands failed slots to all 64 waiters', async t => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const stat = t.mock.method(fs, 'lstat', async () => {
    calls++;
    await gate;
    throw new Error('synthetic metadata failure');
  });
  const requests = Array.from({ length: 68 }, () => readConfigurationText(f.file));
  for (const request of requests) void request.catch(() => undefined);
  try {
    await assert.rejects(readConfigurationText(f.file), { code: 'RESOURCE_LIMIT' });
    assert.equal(calls, 4);
  } finally { release(); }
  const results = await Promise.allSettled(requests);
  assert.equal(results.every(result => result.status === 'rejected'), true);
  assert.equal(calls, 68);
  stat.mock.restore();
  assert.equal(await readConfigurationText(f.file), f.text);
});

test('strict JSON budgets reject depth, node and byte excess, not truncate or leak payloads', () => {
  assert.throws(() => parseJsonStrict('['.repeat(MAX_CONFIG_DEPTH + 1) + '0' + ']'.repeat(MAX_CONFIG_DEPTH + 1)), { code: 'RESOURCE_LIMIT' });
  assert.throws(() => parseJsonStrict('[' + Array(MAX_CONFIG_NODES).fill('0').join(',') + ']'), { code: 'RESOURCE_LIMIT' });
  assert.throws(() => parseJsonStrict(' '.repeat(MAX_CONFIG_BYTES + 1)), { code: 'RESOURCE_LIMIT' });
  assert.deepEqual(parseJsonStrict('[{"a":1},true,null]'), [Object.assign(Object.create(null), { a: 1 }), true, null]);
  assert.throws(() => parseJsonStrict('{"same":1,"same":2}'), { code: 'CONFIG_INVALID' });
});

test('a formatting-expanded trust update exceeding the config budget leaves the original file unchanged', async () => {
  const value = { version: 2, servers: { '127.0.0.1': { '22222': {
    accounts: { synthetic: { auth: { type: 'password', password: '' } } }
  } } } };
  value.servers['127.0.0.1']['22222'].accounts.synthetic.auth.password =
    'x'.repeat(MAX_CONFIG_BYTES - Buffer.byteLength(JSON.stringify(value)) - 1);
  const original = JSON.stringify(value);
  assert.equal(Buffer.byteLength(original), MAX_CONFIG_BYTES - 1);
  const f = await fixture(original);
  const store = new ConfigStore(f.file);
  await assert.rejects(store.confirmHostKey({ ip: '127.0.0.1', port: 22222 }, `SHA256:${'A'.repeat(43)}`), { code: 'RESOURCE_LIMIT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual(await fs.readdir(f.directory), ['config.json']);
});

test('lock initialization identity failure closes once and reports uncertainty without guessing deletion', async t => {
  const f = await fixture();
  const originalOpen = fs.open;
  let closes = 0;
  let captured: { dev: bigint; ino: bigint } | undefined;
  const lockPath = `${f.file}.lock`;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) !== lockPath) return handle;
    const stat = await handle.stat({ bigint: true });
    // Only the fixture creator retains this proof for its own teardown. The
    // application's fstat fails and it must not gain deletion authority.
    captured = { dev: stat.dev, ino: stat.ino };
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { closes++; await close(); });
    t.mock.method(handle, 'stat', async () => { throw new Error('synthetic_secret_lock_identity'); });
    return handle;
  });
  try {
    await assert.rejects(new ConfigStore(f.file).confirmHostKey({ ip: '127.0.0.1', port: 22222 }, `SHA256:${'A'.repeat(43)}`), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, 'FILE_PERMISSION_ERROR');
      const cleanup = error.details.lockCleanup as Record<string, unknown>;
      assert.equal(cleanup.removalConfirmed, false);
      assert.equal(cleanup.handleCloseConfirmed, true);
      assert.deepEqual(cleanup.possibleResidualPaths, [lockPath]);
      assert.equal(JSON.stringify(error.toResult()).includes('synthetic_secret_lock_identity'), false);
      return true;
    });
    assert.equal(closes, 1);
    assert.equal(await fs.readFile(f.file, 'utf8'), f.text);
    const residual = await fs.lstat(lockPath, { bigint: true });
    assert.equal(residual.ino, captured!.ino);
    assert.equal(residual.size, 0n);
  } finally {
    // No raw path rm. Removal uses the acquisition proof obtained only by the
    // synthetic fixture creator above, not by the failing application.
    if (captured) await unlinkOwnedFile(lockPath, captured);
  }
});

test('new trust-pin nodes cannot publish an unreadable over-budget configuration', async () => {
  const accounts = (): Record<string, { auth: { type: string; password: string } }> => {
    const result: Record<string, { auth: { type: string; password: string } }> = {};
    for (let i = 0; i < 6249; i++) result[`u${i.toString(36)}`] = { auth: { type: 'password', password: 'x' } };
    return result;
  };
  // Root/servers/IP = 7 nodes; each port/accounts = 4; each login = 8.
  // 7 + 2*4 + 12498*8 = 99999. A new pin adds a key and a value (100001).
  const value = { version: 2, servers: { '127.0.0.1': {
    '22222': { accounts: accounts() },
    '22223': { accounts: accounts() }
  } } };
  const original = JSON.stringify(value);
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2)) < MAX_CONFIG_BYTES);
  parseJsonStrict(original);
  const f = await fixture(original);
  const store = new ConfigStore(f.file);
  await assert.rejects(store.confirmHostKey({ ip: '127.0.0.1', port: 22222 }, `SHA256:${'A'.repeat(43)}`), { code: 'RESOURCE_LIMIT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
  assert.deepEqual(await fs.readdir(f.directory), ['config.json']);
  assert.equal((await store.listConfigurations()).length, 12498);
});
