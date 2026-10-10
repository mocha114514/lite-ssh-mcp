import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { LiteSshError } from '../core/errors.js';
import { windowsPermissions, type WindowsObjectIdentity } from './windowsPermissions.js';

type PrivateKind = 'file' | 'directory';
export interface PrivateObjectIdentity { dev: bigint; ino: bigint }

function permissionFailure(): LiteSshError {
  return new LiteSshError('FILE_PERMISSION_ERROR', 'Private filesystem permissions or a stable parent boundary could not be established. Existing user permissions were not rewritten.');
}
function identityMatches(a: PrivateObjectIdentity, b: PrivateObjectIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function nativeIdentity(target: string, stat: BigIntStats): WindowsObjectIdentity {
  return { path: target, dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function isDirectory(stat: BigIntStats): boolean { return stat.isDirectory() && !stat.isSymbolicLink(); }

/** Public-readable ancestors are allowed, untrusted namespace mutation is not. */
export function validatePosixAncestor(stat: Pick<BigIntStats, 'uid' | 'mode'>, uid: bigint): void {
  if (stat.uid !== uid && stat.uid !== 0n) throw permissionFailure();
  // A trusted sticky /tmp permits creation but protects other users' children.
  // Every existing child is independently required to have a trusted owner.
  if ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) throw permissionFailure();
}
async function existingAncestors(target: string, includeTarget = false): Promise<{ objects: WindowsObjectIdentity[]; components: string[] }> {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const components = [root];
  let current = root;
  const names = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (const name of names.slice(0, includeTarget ? names.length : -1)) {
    current = path.join(current, name);
    components.push(current);
  }
  const objects: WindowsObjectIdentity[] = [];
  for (const component of components) {
    let stat;
    try { stat = await fs.lstat(component, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (!isDirectory(stat)) throw permissionFailure();
    if (process.platform !== 'win32') validatePosixAncestor(stat, BigInt(process.getuid!()));
    objects.push(nativeIdentity(component, stat));
  }
  return { objects, components };
}
async function checkAncestorIdentities(objects: WindowsObjectIdentity[]): Promise<void> {
  for (const object of objects) {
    const current = await fs.lstat(object.path, { bigint: true });
    if (!isDirectory(current) || current.dev.toString() !== object.dev || current.ino.toString() !== object.ino) throw permissionFailure();
    if (process.platform !== 'win32') validatePosixAncestor(current, BigInt(process.getuid!()));
  }
}

/**
 * Existing objects are verification-only. New FILE permission changes require
 * the actual exclusive FileHandle: a boolean/name cannot prove acquisition.
 * Windows opens a native no-delete-sharing handle and checks volume + inode
 * against that FileHandle before any DACL mutation. POSIX uses fchmod only.
 */
export async function requirePrivatePath(target: string, kind: PrivateKind, ownedNewObject = false, acquired?: FileHandle): Promise<void> {
  try {
    if (ownedNewObject && (!acquired || kind !== 'file')) throw permissionFailure();
    const before = acquired ? await acquired.stat({ bigint: true }) : await fs.lstat(target, { bigint: true });
    const named = await fs.lstat(target, { bigint: true });
    if (!identityMatches(before, named) || named.isSymbolicLink() ||
        (kind === 'directory' ? !named.isDirectory() : !named.isFile())) throw permissionFailure();
    const ancestors = await existingAncestors(target);
    if (ancestors.objects.length !== ancestors.components.length) throw permissionFailure();
    if (process.platform === 'win32') {
      await windowsPermissions({
        operation: ownedNewObject ? 'protect' : 'verify', target: path.resolve(target), kind,
        expected: nativeIdentity(target, before), ancestors: ancestors.objects
      });
    } else {
      await checkAncestorIdentities(ancestors.objects);
      if (ownedNewObject) await acquired!.chmod(0o600);
      const actual = acquired ? await acquired.stat({ bigint: true }) : await fs.lstat(target, { bigint: true });
      if ((actual.mode & 0o077n) !== 0n || actual.uid !== BigInt(process.getuid!())) throw permissionFailure();
    }
    const after = await fs.lstat(target, { bigint: true });
    if (after.isSymbolicLink() || !identityMatches(before, after)) throw permissionFailure();
    await checkAncestorIdentities(ancestors.objects);
  } catch (error) {
    if (error instanceof LiteSshError) throw error;
    throw permissionFailure(); // No native output, SIDs, paths or ACLs disclosed.
  }
}

/**
 * New POSIX directories are private at mkdir(0700), never path-chmodded.
 * Windows creates them with a protected private SD while parent handles stay
 * held. Existing components, including EEXIST winners, are never rewritten.
 */
export async function ensurePrivateDirectory(target: string): Promise<void> {
  try {
    const absolute = path.resolve(target);
    if (absolute === path.parse(absolute).root) throw permissionFailure();
    const ancestors = await existingAncestors(absolute, true);
    if (process.platform === 'win32') {
      await windowsPermissions({ operation: 'directory', target: absolute, kind: 'directory', ancestors: ancestors.objects, components: ancestors.components });
      await checkAncestorIdentities(ancestors.objects);
      return;
    }
    await checkAncestorIdentities(ancestors.objects);
    for (let i = ancestors.objects.length; i < ancestors.components.length; i++) {
      try { await fs.mkdir(ancestors.components[i]!, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      // Verification only even after mkdir: no path mutation can affect a
      // concurrent existing replacement that was not acquired by this call.
      await requirePrivatePath(ancestors.components[i]!, 'directory');
      const stat = await fs.lstat(ancestors.components[i]!, { bigint: true });
      ancestors.objects.push(nativeIdentity(ancestors.components[i]!, stat));
      await checkAncestorIdentities(ancestors.objects);
    }
    await requirePrivatePath(absolute, 'directory');
  } catch (error) {
    if (error instanceof LiteSshError) throw error;
    throw permissionFailure();
  }
}

/** Remove only the proven exclusive object, never an EEXIST/replacement path. */
export async function unlinkOwnedFile(target: string, acquired: FileHandle | PrivateObjectIdentity): Promise<void> {
  try {
    const expected = 'stat' in acquired ? await acquired.stat({ bigint: true }) : acquired;
    let named;
    try { named = await fs.lstat(target, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!named.isFile() || named.isSymbolicLink() || !identityMatches(expected, named)) throw permissionFailure();
    const ancestors = await existingAncestors(target);
    if (process.platform === 'win32') {
      await windowsPermissions({ operation: 'remove', target: path.resolve(target), kind: 'file', expected: nativeIdentity(target, named), ancestors: ancestors.objects });
    } else {
      await checkAncestorIdentities(ancestors.objects);
      // Complete every potentially yielding ancestor check FIRST. Then compare
      // the acquired identity at the final no-follow observation immediately
      // before unlink. POSIX offers no atomic unlink-by-inode/FD operation:
      // this detects observable substitution in a trusted namespace, not an
      // uncooperative same-UID transaction guarantee across the two syscalls.
      let final;
      try { final = await fs.lstat(target, { bigint: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!final.isFile() || final.isSymbolicLink() || !identityMatches(expected, final)) throw permissionFailure();
      await fs.unlink(target);
    }
  } catch (error) {
    if (error instanceof LiteSshError) throw error;
    throw permissionFailure();
  }
}
