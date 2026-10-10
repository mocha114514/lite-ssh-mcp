import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensurePrivateDirectory, requirePrivatePath, unlinkOwnedFile, validatePosixAncestor } from '../src/platform/permissions.js';
import { LiteSshError } from '../src/core/errors.js';

const root = path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'permissions', `${process.pid}-${Date.now()}`);
const run = promisify(execFile);

async function windowsScript(script: string, target: string): Promise<string> {
  script = `
$ErrorActionPreference = 'Stop'
function Set-FixtureDacl($p, $acl) {
    $section = [System.Security.AccessControl.AccessControlSections]::Access
    if (([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::Directory) -ne 0) {
        $only = [System.Security.AccessControl.DirectorySecurity]::new()
        $only.SetSecurityDescriptorBinaryForm($acl.GetSecurityDescriptorBinaryForm(), $section)
        [System.IO.Directory]::SetAccessControl($p, $only)
    } else {
        $only = [System.Security.AccessControl.FileSecurity]::new()
        $only.SetSecurityDescriptorBinaryForm($acl.GetSecurityDescriptorBinaryForm(), $section)
        [System.IO.File]::SetAccessControl($p, $only)
    }
}
` + script;
  const result = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ], { env: {
    ...process.env,
    PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    LSSH_TEST_PATH: target
  } });
  return result.stdout.trim();
}

test('private adapter restricts only new owned paths and verifies files before writes', async () => {
  await ensurePrivateDirectory(path.join(root, 'new', 'private'));
  const file = path.join(root, 'new', 'private', 'file');
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await requirePrivatePath(file, 'file', true, handle);
    await handle.writeFile('synthetic fixture only');
  } finally { await handle.close(); }
  await requirePrivatePath(file, 'file');
  await ensurePrivateDirectory(path.dirname(file));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  }
});

test('existing unsafe permissions fail without rewriting owner ACL or contents', async () => {
  const directory = path.join(root, 'unsafe');
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, 'file');
  await fs.writeFile(file, 'synthetic fixture only', { mode: 0o600 });
  if (process.platform === 'win32') {
    await windowsScript(`
$p = $env:LSSH_TEST_PATH
$acl = Get-Acl -LiteralPath $p
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
    [System.Security.AccessControl.FileSystemRights]::Read,
    [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-FixtureDacl $p $acl
`, file);
  } else { await fs.chmod(file, 0o644); }
  const before = await fs.stat(file);
  const beforeAcl = process.platform === 'win32' ? await aclDigest(file) : '';
  await assert.rejects(requirePrivatePath(file, 'file'), error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'FILE_PERMISSION_ERROR');
    assert.equal(error.message.includes(file), false);
    return true;
  });
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
  if (process.platform === 'win32') assert.equal(await aclDigest(file), beforeAcl);
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic fixture only');
  // Intentionally keep the unsafe fixture unchanged: production verification
  // must never be used as an implicit permission repair operation.
});

test('wrong object types and linked parents are rejected', async () => {
  await ensurePrivateDirectory(root);
  const file = path.join(root, 'not-directory');
  await fs.writeFile(file, '', { mode: 0o600 });
  await assert.rejects(ensurePrivateDirectory(path.join(file, 'child')));
  const link = path.join(root, 'linked-parent');
  await fs.symlink(path.join(root, 'new'), link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensurePrivateDirectory(path.join(link, 'child')));
  await assert.rejects(requirePrivatePath(link, 'directory'));
});


async function aclDigest(target: string): Promise<string> {
  return windowsScript(`
$acl = Get-Acl -LiteralPath $env:LSSH_TEST_PATH
$bytes = [System.Text.Encoding]::UTF8.GetBytes($acl.Sddl)
$sha = [System.Security.Cryptography.SHA256]::Create()
try { [Convert]::ToBase64String($sha.ComputeHash($bytes)) } finally { $sha.Dispose() }
`, target);
}

test('exclusive FileHandle binds protection and cleanup; a replacement is left untouched', async () => {
  const directory = path.join(root, 'identity');
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, 'acquired');
  const moved = path.join(directory, 'moved-owned');
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await fs.rename(file, moved);
    await fs.writeFile(file, 'replacement fixture', { mode: 0o600 });
    const before = process.platform === 'win32' ? await aclDigest(file) : String((await fs.stat(file)).mode);
    await assert.rejects(requirePrivatePath(file, 'file', true, handle), { code: 'FILE_PERMISSION_ERROR' });
    await assert.rejects(unlinkOwnedFile(file, handle), { code: 'FILE_PERMISSION_ERROR' });
    const after = process.platform === 'win32' ? await aclDigest(file) : String((await fs.stat(file)).mode);
    assert.equal(after, before);
    assert.equal(await fs.readFile(file, 'utf8'), 'replacement fixture');
    await unlinkOwnedFile(moved, handle);
  } finally { await handle.close(); }
  await assert.rejects(fs.lstat(moved));
});

test('a boolean alone cannot authorize protection of an existing pathname', async () => {
  const directory = path.join(root, 'no-acquisition');
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, 'existing');
  await fs.writeFile(file, 'untouched', { mode: 0o600 });
  await assert.rejects(requirePrivatePath(file, 'file', true), { code: 'FILE_PERMISSION_ERROR' });
  assert.equal(await fs.readFile(file, 'utf8'), 'untouched');
});

test('existing private Read ACL is accepted without broadening owner or permissions', { skip: process.platform !== 'win32' }, async () => {
  const directory = path.join(root, 'readonly');
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, 'existing');
  await fs.writeFile(file, 'readonly fixture');
  await windowsScript(`
$acl = Get-Acl -LiteralPath $env:LSSH_TEST_PATH
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,
    [System.Security.AccessControl.FileSystemRights]::Read,
    [System.Security.AccessControl.AccessControlType]::Allow))
Set-FixtureDacl $env:LSSH_TEST_PATH $acl
`, file);
  const before = await aclDigest(file);
  await requirePrivatePath(file, 'file');
  assert.equal(await fs.readFile(file, 'utf8'), 'readonly fixture');
  assert.equal(await aclDigest(file), before);
});

test('new files under private inheritable Modify require DACL access, not WRITE_OWNER', { skip: process.platform !== 'win32' }, async () => {
  const directory = path.join(root, 'modify-parent');
  await ensurePrivateDirectory(directory);
  await windowsScript(`
$acl = Get-Acl -LiteralPath $env:LSSH_TEST_PATH
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,
    [System.Security.AccessControl.FileSystemRights]::Modify,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow))
Set-FixtureDacl $env:LSSH_TEST_PATH $acl
`, directory);
  const file = path.join(directory, 'new');
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    const before = await handle.stat({ bigint: true });
    await requirePrivatePath(file, 'file', true, handle);
    await handle.writeFile('protected before writing');
    assert.equal((await handle.stat({ bigint: true })).ino, before.ino);
  } finally { await handle.close(); }
  await requirePrivatePath(file, 'file');
});

test('untrusted mutation in a synthetic ancestor fails without rewriting that ancestor', async () => {
  const ancestor = path.join(root, 'unsafe-ancestor');
  await ensurePrivateDirectory(ancestor);
  if (process.platform === 'win32') {
    await windowsScript(`
$acl = Get-Acl -LiteralPath $env:LSSH_TEST_PATH
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
    [System.Security.AccessControl.AccessControlType]::Allow))
Set-FixtureDacl $env:LSSH_TEST_PATH $acl
`, ancestor);
  } else { await fs.chmod(ancestor, 0o777); }
  const before = process.platform === 'win32' ? await aclDigest(ancestor) : String((await fs.stat(ancestor)).mode);
  await assert.rejects(ensurePrivateDirectory(path.join(ancestor, 'child')), { code: 'FILE_PERMISSION_ERROR' });
  assert.equal(process.platform === 'win32' ? await aclDigest(ancestor) : String((await fs.stat(ancestor)).mode), before);
  await assert.rejects(fs.lstat(path.join(ancestor, 'child')));
});

test('root-as-private-directory fails early and literal Unicode/quotes/brackets work', async () => {
  const filesystemRoot = path.parse(root).root;
  await assert.rejects(ensurePrivateDirectory(filesystemRoot), { code: 'FILE_PERMISSION_ERROR' });
  const literal = path.join(root, "用户 [ACL] ' literal");
  await ensurePrivateDirectory(literal);
  const file = path.join(literal, "[file] ' 用户.txt");
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await requirePrivatePath(file, 'file', true, handle);
    await handle.writeFile('literal path fixture');
  } finally { await handle.close(); }
  await requirePrivatePath(file, 'file');
});

test('POSIX ancestor model accepts public read-only and trusted sticky, rejects mutation/foreign owner', () => {
  validatePosixAncestor({ uid: 0n, mode: 0o755n }, 42n);
  validatePosixAncestor({ uid: 42n, mode: 0o700n }, 42n);
  validatePosixAncestor({ uid: 0n, mode: 0o1777n }, 42n);
  assert.throws(() => validatePosixAncestor({ uid: 0n, mode: 0o777n }, 42n));
  assert.throws(() => validatePosixAncestor({ uid: 99n, mode: 0o755n }, 42n));
});
