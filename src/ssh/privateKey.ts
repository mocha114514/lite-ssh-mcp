import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiteSshError } from '../core/errors.js';
import { requirePrivatePath } from '../platform/permissions.js';
import { selectTrustedFile } from '../platform/trustedPath.js';

export const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_READERS = 4;
const MAX_WAITERS = 64;
let readers = 0;
const waiters: Array<() => void> = [];

function limit(): LiteSshError {
  return new LiteSshError('RESOURCE_LIMIT', 'The private key exceeds the 1 MiB credential read budget.');
}
function validate(stat: BigIntStats): void {
  if (!stat.isFile()) throw new LiteSshError('AUTH_FAILED', 'The configured private key is not a regular file.');
  if (stat.size > BigInt(MAX_PRIVATE_KEY_BYTES)) throw limit();
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}
function changed(): LiteSshError {
  return new LiteSshError('AUTH_FAILED', 'The selected private key changed during reading. Retry after the update has settled.');
}
function safe(error: unknown): LiteSshError {
  if (error instanceof LiteSshError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return new LiteSshError('FILE_PERMISSION_ERROR',
      'Access to the configured private credential was denied. Existing permissions were not rewritten.');
  }
  return new LiteSshError('AUTH_FAILED', 'The configured private key could not be read.');
}
function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  // Prefix substitution only: collapsing '..' here could select a different
  // key before following an earlier alias. The resolver owns that ordering.
  if (input.startsWith('~/') || input.startsWith('~\\')) return `${os.homedir()}${path.sep}${input.slice(2)}`;
  return input;
}
async function slot(): Promise<() => void> {
  if (readers < MAX_READERS) readers++;
  else {
    if (waiters.length >= MAX_WAITERS) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The bounded credential reader queue is full.');
    }
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  return () => {
    const next = waiters.shift();
    if (next) next();
    else readers--;
  };
}

/**
 * Existing credentials are read-only: preserve absolute/~/ paths and link
 * following, but bind selection, permission verification and bytes to one FD.
 * Nonblocking/no-follow open prevents a raced regular file -> FIFO/link swap
 * on POSIX. Windows verification binds the native file ID to this same FD.
 * Type and metadata checks detect observable change, not malicious same-UID
 * edits that restore metadata. No raw key, native error, or key path is returned
 * through an error. The returned material is internal authentication input.
 */
export async function readPrivateKey(input: string): Promise<string> {
  const release = await slot();
  let handle: FileHandle | undefined;
  let material: string | undefined;
  let failure: LiteSshError | undefined;
  try {
    const logicalPath = expandHome(input);
    // A no-open gate rejects named pipes/devices before any potentially blocking
    // read. The acquired FD repeats this check to cover a path substitution.
    const observed = await fs.stat(logicalPath, { bigint: true });
    validate(observed);
    const selection = await selectTrustedFile(logicalPath);
    if (!unchanged(observed, selection.stat)) throw changed();
    handle = await fs.open(selection.canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const acquired = await handle.stat({ bigint: true });
    validate(acquired);
    if (!unchanged(selection.stat, acquired)) throw changed();
    await requirePrivatePath(selection.canonicalPath, 'file', false, handle);
    await selection.verifySelection();
    const bytes = Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = Math.min(CHUNK_BYTES, bytes.length - length);
      const result = await handle.read(bytes, length, count, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
      if (length > MAX_PRIVATE_KEY_BYTES) throw limit();
    }
    const after = await handle.stat({ bigint: true });
    validate(after);
    if (!unchanged(acquired, after) || BigInt(length) !== after.size) throw changed();
    await requirePrivatePath(selection.canonicalPath, 'file', false, handle);
    await selection.verifySelection();
    const named = await fs.stat(logicalPath, { bigint: true });
    if (!unchanged(after, named)) throw changed();
    material = bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    failure = safe(error);
  } finally {
    try { await handle?.close(); }
    catch {
      failure = new LiteSshError(failure?.code ?? 'AUTH_FAILED', failure?.message ??
        'The private key file handle could not confirm closure.', {
        ...failure?.details, privateKeyHandleCloseConfirmed: false
      });
    }
    release();
  }
  if (failure) throw failure;
  return material!;
}
