import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { LiteSshError } from '../core/errors.js';
import { requirePrivatePath } from '../platform/permissions.js';
import { MAX_CONFIG_BYTES, MAX_CONFIG_READERS, MAX_CONFIG_WAITERS } from './limits.js';

let readers = 0;
const waiters: Array<() => void> = [];

function validate(stat: BigIntStats): void {
  if (stat.isSymbolicLink()) {
    throw new LiteSshError('FILE_PERMISSION_ERROR', 'The configuration must not be selected through a link. Existing permissions were not rewritten.');
  }
  if (!stat.isFile()) throw new LiteSshError('CONFIG_INVALID', 'The configuration is not a regular file.');
  if (stat.size > BigInt(MAX_CONFIG_BYTES)) {
    throw new LiteSshError('RESOURCE_LIMIT', 'The configuration exceeds the 4 MiB read budget.');
  }
}
function unchanged(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}
function changed(): LiteSshError {
  return new LiteSshError('CONFIG_INVALID', 'The configuration changed during reading. Retry after the update has settled.');
}
function safe(error: unknown): LiteSshError {
  if (error instanceof LiteSshError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new LiteSshError('CONFIG_NOT_FOUND', 'No configuration file was found for the current user.');
  if (code === 'EACCES' || code === 'EPERM') {
    return new LiteSshError('FILE_PERMISSION_ERROR', 'Access to the configuration was denied. Existing permissions were not rewritten.');
  }
  return new LiteSshError('CONFIG_INVALID', 'The configuration file could not be read.');
}
async function slot(): Promise<() => void> {
  if (readers < MAX_CONFIG_READERS) readers++;
  else {
    if (waiters.length >= MAX_CONFIG_WAITERS) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The bounded configuration reader queue is full.');
    }
    await new Promise<void>(resolve => waiters.push(resolve));
  }
  return () => {
    const next = waiters.shift();
    if (next) next(); else readers--;
  };
}

/** Strict no-link configuration read, bound to one private FD and finite bytes.
 * A regular-file path -> FIFO swap cannot block a POSIX open (O_NONBLOCK), and
 * the acquired FD repeats the type/identity gate before reading any content.
 * Metadata checks detect observable changes, not malicious same-UID edits that
 * restore metadata. Neither native errors nor config contents enter errors.
 */
export async function readConfigurationText(target: string): Promise<string> {
  const release = await slot();
  let handle: FileHandle | undefined;
  let text: string | undefined;
  let failure: LiteSshError | undefined;
  try {
    const observed = await fs.lstat(target, { bigint: true });
    validate(observed);
    handle = await fs.open(target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const acquired = await handle.stat({ bigint: true });
    validate(acquired);
    if (!unchanged(observed, acquired)) throw changed();
    await requirePrivatePath(target, 'file', false, handle);
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, Math.min(64 * 1024, bytes.length - length), length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
      if (length > MAX_CONFIG_BYTES) {
        throw new LiteSshError('RESOURCE_LIMIT', 'The configuration exceeds the 4 MiB read budget.');
      }
    }
    const after = await handle.stat({ bigint: true });
    validate(after);
    if (!unchanged(acquired, after) || BigInt(length) !== after.size) throw changed();
    await requirePrivatePath(target, 'file', false, handle);
    const named = await fs.lstat(target, { bigint: true });
    validate(named);
    if (!unchanged(after, named)) throw changed();
    text = bytes.subarray(0, length).toString('utf8');
  } catch (error) {
    failure = safe(error);
  } finally {
    try { await handle?.close(); }
    catch {
      failure = new LiteSshError(failure?.code ?? 'CONFIG_INVALID', failure?.message ??
        'The configuration file handle could not confirm closure.', {
        ...failure?.details, configurationHandleCloseConfirmed: false
      });
    }
    release();
  }
  if (failure) throw failure;
  return text!;
}
