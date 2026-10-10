import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { LiteSshError } from '../core/errors.js';
import { validatePosixAncestor } from './permissions.js';
import { windowsPermissions } from './windowsPermissions.js';

const MAX_STEPS = 1024;
const MAX_LINKS = 128;
const MAX_GUARD_BYTES = 1024 * 1024;

interface Guard {
  path: string;
  stat: BigIntStats;
  link: boolean;
}

function changed(): LiteSshError {
  return new LiteSshError('FILE_PERMISSION_ERROR',
    'The credential selection namespace is unsafe or changed. Existing permissions were not rewritten.');
}
function sameObject(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Follow existing key aliases without trusting a mutable alias namespace.
 * Unlike realpath alone, this records EVERY traversed directory/link, including
 * nodes in a link target and before a subsequent '..'. Never chmod any node.
 * The guarantee is detection of observable changes in a trusted namespace,
 * not an atomic filesystem transaction against an uncooperative same-UID user.
 */
async function resolveTrustedFile(input: string): Promise<{
  canonicalPath: string;
  stat: BigIntStats;
  verifySelection(): Promise<void>;
}> {
  const guards = new Map<string, Guard>();
  let guardBytes = 0;
  let steps = 0;
  let links = 0;
  const separators = (value: string) => process.platform === 'win32' ? value.replace(/\//gu, '\\') : value;
  // Separator normalization is not lexical path normalization: preserve '..'
  // and inspect each intermediate Windows junction even in mixed-style paths.
  input = separators(input);
  const rootOf = (value: string) => path.parse(value).root;
  const namesOf = (value: string) => value.slice(rootOf(value).length).split(path.sep).filter(Boolean);
  let current = rootOf(input);
  if (!current) throw changed();
  let pending = namesOf(input);

  const remember = (value: string, stat: BigIntStats): void => {
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    const old = guards.get(key);
    if (old && !sameObject(old.stat, stat)) throw changed();
    if (old) return;
    guardBytes += Buffer.byteLength(value, 'utf8') * 2 + 512;
    if (guardBytes > MAX_GUARD_BYTES) {
      throw new LiteSshError('RESOURCE_LIMIT', 'Credential selection exceeded its namespace budget.');
    }
    guards.set(key, { path: value, stat, link: stat.isSymbolicLink() });
  };
  const rootStat = await fs.lstat(current, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw changed();
  remember(current, rootStat);
  let selected: BigIntStats = rootStat;

  while (pending.length > 0) {
    if (++steps > MAX_STEPS) {
      throw new LiteSshError('RESOURCE_LIMIT', 'Credential selection exceeded its component budget.');
    }
    const name = pending.shift()!;
    if (name === '.') continue;
    if (name === '..') {
      current = path.dirname(current);
      selected = await fs.lstat(current, { bigint: true });
      remember(current, selected);
      continue;
    }
    const next = path.join(current, name);
    selected = await fs.lstat(next, { bigint: true });
    if (selected.isSymbolicLink()) {
      remember(next, selected);
      if (++links > MAX_LINKS) {
        throw new LiteSshError('RESOURCE_LIMIT', 'Credential selection exceeded its link budget.');
      }
      const target = separators(await fs.readlink(next));
      // Do not normalize target/remaining '..' before resolving nested links.
      const absolute = path.isAbsolute(target) ? target : `${current}${path.sep}${target}`;
      current = rootOf(absolute);
      pending = [...namesOf(absolute), ...pending];
      const stat = await fs.lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
      remember(current, stat);
    } else {
      current = next;
      if (selected.isDirectory()) remember(current, selected);
      else if (pending.length > 0) throw changed();
    }
  }
  if (!selected.isFile() || selected.isSymbolicLink()) {
    throw new LiteSshError('AUTH_FAILED', 'The configured private key is not a regular file.');
  }

  const verifyBoundaries = async (): Promise<void> => {
    for (const guard of guards.values()) {
      const actual = await fs.lstat(guard.path, { bigint: true });
      if (!sameObject(guard.stat, actual) || actual.isSymbolicLink() !== guard.link ||
          (!guard.link && !actual.isDirectory())) throw changed();
      if (process.platform !== 'win32') {
        if (guard.link) {
          const uid = BigInt(process.getuid!());
          if (actual.uid !== uid && actual.uid !== 0n) throw changed();
        } else validatePosixAncestor(actual, BigInt(process.getuid!()));
      }
    }
    if (process.platform === 'win32') {
      await windowsPermissions({
        operation: 'boundaries', target: current, kind: 'file', ancestors: [],
        boundaries: [...guards.values()].map(guard => ({
          path: guard.path, dev: guard.stat.dev.toString(), ino: guard.stat.ino.toString(), link: guard.link
        }))
      });
    }
    const final = await fs.lstat(current, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink() || !sameObject(selected, final)) throw changed();
  };
  const verifySelection = async (): Promise<void> => {
    try { await verifyBoundaries(); }
    catch (error) {
      if (error instanceof LiteSshError) throw error;
      throw changed(); // Never disclose helper/native errors or turn them into auth failures.
    }
  };
  await verifySelection();
  return { canonicalPath: current, stat: selected, verifySelection };
}

export async function selectTrustedFile(input: string): ReturnType<typeof resolveTrustedFile> {
  try { return await resolveTrustedFile(input); }
  catch (error) {
    if (error instanceof LiteSshError) throw error;
    throw changed();
  }
}
