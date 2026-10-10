import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import ssh2, { type Client } from 'ssh2';
import type { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';
import { ensurePrivateDirectory } from '../src/platform/permissions.js';
import { readPrivateKey, MAX_PRIVATE_KEY_BYTES } from '../src/ssh/privateKey.js';
import { ConnectionPool } from '../src/ssh/pool.js';
import { fixtureRoot } from './helpers/workspace.js';

const root = fixtureRoot('private-key');
const run = promisify(execFile);
let serial = 0;
async function fixture(material?: string) {
  const directory = path.join(root, String(++serial));
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, '生成的 key [only fixture].pem');
  const key = material ?? ssh2.utils.generateKeyPairSync('ed25519').private;
  await fs.writeFile(file, key, { mode: 0o600 });
  return { directory, file, key };
}
async function widenOwnFixture(target: string, directory: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.chmod(target, directory ? 0o777 : 0o644);
    return;
  }
  // Only the caller's newly created fixture is changed. DACL-only write never
  // requests owner privileges and never touches a real user's ACL.
  const script = `
$ErrorActionPreference = 'Stop'
$p = $env:LSSH_TEST_PATH
$section = [System.Security.AccessControl.AccessControlSections]::Access
if ($env:LSSH_TEST_KIND -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorBinaryForm((Get-Acl -LiteralPath $p).GetSecurityDescriptorBinaryForm(), $section)
    $rights = [System.Security.AccessControl.FileSystemRights]::Write
} else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $acl.SetSecurityDescriptorBinaryForm((Get-Acl -LiteralPath $p).GetSecurityDescriptorBinaryForm(), $section)
    $rights = [System.Security.AccessControl.FileSystemRights]::Read
}
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), $rights,
    [System.Security.AccessControl.AccessControlType]::Allow))
if ($env:LSSH_TEST_KIND -eq 'directory') { [System.IO.Directory]::SetAccessControl($p, $acl) }
else { [System.IO.File]::SetAccessControl($p, $acl) }
`;
  await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { env: {
    ...process.env,
    PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    LSSH_TEST_PATH: target, LSSH_TEST_KIND: directory ? 'directory' : 'file'
  } });
}
function code(expected: string, file: string, material: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, expected);
    const exposed = JSON.stringify(error.toResult());
    assert.equal(exposed.includes(file), false);
    assert.equal(exposed.includes(material), false);
    return true;
  };
}

test('credential reader uses bounded FD reads and follows an owned directory alias', async t => {
  const f = await fixture();
  const alias = path.join(root, 'owned-alias');
  await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.mock.method(fs, 'readFile', async () => { throw new Error('unbounded readFile is forbidden'); });
  assert.equal(await readPrivateKey(path.join(alias, path.basename(f.file))), f.key);
  if (process.platform === 'win32') {
    const mixed = `${alias.replace(/\\/gu, '/')}${path.sep}${path.basename(f.file)}`;
    assert.equal(await readPrivateKey(mixed), f.key);
  }
});

test('POSIX ~/ alias/.. follows the link before selecting its parent key', { skip: process.platform === 'win32' }, async t => {
  const home = path.join(root, 'synthetic-home');
  const target = path.join(home, 'directory', 'child');
  await ensurePrivateDirectory(target);
  await fs.writeFile(path.join(home, 'key'), 'wrong lexical key', { mode: 0o600 });
  await fs.writeFile(path.join(home, 'directory', 'key'), 'right linked parent key', { mode: 0o600 });
  await fs.symlink(target, path.join(home, 'alias'), 'dir');
  t.mock.method(os, 'homedir', () => home);
  assert.equal(await readPrivateKey('~/alias/../key'), 'right linked parent key');
});

test('non-regular and oversized credential gates perform zero file opens', async t => {
  const f = await fixture('synthetic public marker');
  await fs.writeFile(f.file, Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1), { mode: 0o600 });
  const open = t.mock.method(fs, 'open');
  await assert.rejects(readPrivateKey(f.directory), { code: 'AUTH_FAILED' });
  await assert.rejects(readPrivateKey(f.file), { code: 'RESOURCE_LIMIT' });
  assert.equal(open.mock.callCount(), 0);
});

test('unsafe existing credential permissions are rejected without repair or content changes', async () => {
  const f = await fixture();
  await widenOwnFixture(f.file, false);
  const before = await fs.stat(f.file, { bigint: true });
  await assert.rejects(readPrivateKey(f.file), code('FILE_PERMISSION_ERROR', f.file, f.key));
  const after = await fs.stat(f.file, { bigint: true });
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.equal(after.mode, before.mode);
  assert.equal(await fs.readFile(f.file, 'utf8'), f.key);
});

test('mutable alias selection namespace is rejected even when its canonical key is private', async () => {
  const f = await fixture();
  const mutable = path.join(root, 'mutable-alias-parent');
  await ensurePrivateDirectory(mutable);
  await fs.symlink(f.directory, path.join(mutable, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await widenOwnFixture(mutable, true);
  await assert.rejects(readPrivateKey(path.join(mutable, 'alias', path.basename(f.file))), { code: 'FILE_PERMISSION_ERROR' });
});

test('first acquired fstat failure always closes the FD and returns no native secret', async t => {
  const f = await fixture();
  const originalOpen = fs.open;
  let closes = 0;
  let reads = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { closes++; await close(); });
    t.mock.method(handle, 'read', async () => { reads++; throw new Error('read must not occur'); });
    t.mock.method(handle, 'stat', async () => {
      throw Object.assign(new Error('synthetic_hidden_native_marker'), { code: 'EIO' });
    });
    return handle;
  });
  await assert.rejects(readPrivateKey(f.file), error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(JSON.stringify(error.toResult()).includes('synthetic_hidden_native_marker'), false);
    return true;
  });
  assert.equal(closes, 1);
  assert.equal(reads, 0);
});

test('observable in-place content change during FD read is not returned as a stable credential', async t => {
  const f = await fixture();
  const originalOpen = fs.open;
  let mutated = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await read(buffer, offset, length, position);
      if (!mutated) {
        mutated = true;
        await fs.appendFile(f.file, '\nsynthetic update');
      }
      return result;
    });
    return handle;
  });
  await assert.rejects(readPrivateKey(f.file), { code: 'AUTH_FAILED' });
  assert.equal(mutated, true);
});

test('invalid key is rejected before connect; same-path key rotation isolates new leases', async t => {
  const f = await fixture('synthetic_invalid_key');
  const target = { ip: '127.0.0.1', port: 22222, username: 'synthetic_key_account' };
  const pool = new ConnectionPool({ resolveLogin: async () => ({
    target, revision: 'unchanged_config_revision', auth: { type: 'privateKey', privateKeyPath: f.file }
  }) } as unknown as ConfigStore);
  const clients: Client[] = [];
  t.mock.method(ssh2.Client.prototype, 'connect', function (this: Client) {
    clients.push(this);
    queueMicrotask(() => this.emit('ready'));
    return this;
  });
  const end = t.mock.method(ssh2.Client.prototype, 'end', function (this: Client) {
    queueMicrotask(() => this.emit('close'));
    return this;
  });
  try {
    await assert.rejects(pool.acquire(target), { code: 'AUTH_FAILED' });
    assert.equal(clients.length, 0);
    await fs.writeFile(f.file, ssh2.utils.generateKeyPairSync('ed25519').private);
    const old = await pool.acquire(target);
    const same = await pool.acquire(target);
    assert.equal(old.client, same.client);
    await fs.writeFile(f.file, ssh2.utils.generateKeyPairSync('ed25519').private);
    const next = await pool.acquire(target);
    assert.notEqual(next.client, old.client);
    assert.equal(end.mock.callCount(), 0, 'rotation never closes an existing lease');
    await same.release();
    await old.release();
    await next.release();
  } finally { await pool.dispose(); }
});

test('reader admits four active plus 64 queued calls and hands off every slot after failure', async t => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let stats = 0;
  const stat = t.mock.method(fs, 'stat', async () => {
    stats++;
    await blocked;
    throw new Error('synthetic blocked metadata failure');
  });
  const requests = Array.from({ length: 68 }, () => readPrivateKey(f.file));
  for (const request of requests) void request.catch(() => undefined);
  try {
    await assert.rejects(readPrivateKey(f.file), { code: 'RESOURCE_LIMIT' });
    assert.equal(stats, 4);
  } finally { release(); }
  const settled = await Promise.allSettled(requests);
  assert.equal(settled.every(result => result.status === 'rejected'), true);
  assert.equal(stats, 68);
  stat.mock.restore();
  assert.equal(await readPrivateKey(f.file), f.key, 'failed readers did not leak admission slots');
});

test('close rejection never returns credential bytes or native errors', async t => {
  const f = await fixture();
  const originalOpen = fs.open;
  let closed = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => {
      await close();
      closed++;
      // Harness knows its FD closed; the application only sees rejection and
      // must truthfully report an unconfirmed close rather than infer success.
      throw new Error('synthetic_secret_close_message');
    });
    return handle;
  });
  await assert.rejects(readPrivateKey(f.file), error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(error.details.privateKeyHandleCloseConfirmed, false);
    assert.equal(JSON.stringify(error.toResult()).includes(f.key), false);
    assert.equal(JSON.stringify(error.toResult()).includes('synthetic_secret_close_message'), false);
    return true;
  });
  assert.equal(closed, 1);
});

test('a substituted acquired FD is rejected before reading bytes and is still closed', async t => {
  const expected = await fixture('selected key');
  const substituted = await fixture('different key');
  const originalOpen = fs.open;
  let reads = 0;
  let closes = 0;
  t.mock.method(fs, 'open', async () => {
    const handle = await originalOpen(substituted.file, 'r');
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'read', async () => { reads++; throw new Error('must not read'); });
    t.mock.method(handle, 'close', async () => { closes++; await close(); });
    return handle;
  });
  await assert.rejects(readPrivateKey(expected.file), { code: 'AUTH_FAILED' });
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});
