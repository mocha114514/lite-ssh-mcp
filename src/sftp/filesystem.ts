import type path from 'node:path';
import { LiteSshError } from '../core/errors.js';

export type ObjectKind = 'file' | 'directory' | 'symlink' | 'special';
export interface Metadata {
  kind: ObjectKind;
  size: number;
  mtime: number;
  /** Exact local nanoseconds when available; SFTP exposes only seconds. */
  mtimeExact?: string;
  mode: number;
  /** POSIX/local file identity when available; SFTP v3 has no inode field. */
  identity?: string;
}
export interface ReadHandle {
  stat(): Promise<Metadata>;
  read(buffer: Buffer, position: number): Promise<number>;
  close(): Promise<void>;
}
export interface WriteHandle {
  stat(): Promise<Metadata>;
  write(buffer: Buffer, length: number, position: number): Promise<void>;
  close(): Promise<void>;
}

/** Policy and scheduling code never imports ssh2 or performs shell commands. */
export interface TransferFileSystem {
  readonly paths: typeof path.posix;
  readonly platform: 'windows' | 'posix';
  key(value: string): string;
  validate(value: string): void;
  lstat(value: string): Promise<Metadata | undefined>;
  readlink(value: string): Promise<string>;
  entries(value: string): AsyncIterable<string>;
  mkdir(value: string): Promise<void>;
  openRead(value: string): Promise<ReadHandle>;
  createExclusive(value: string): Promise<WriteHandle>;
  /** Returns true if publication left our temporary hard-link name behind. */
  commit(temporary: string, final: string, overwrite: boolean): Promise<boolean>;
  unlink(value: string): Promise<void>;
  /** Nonmutating capability preflight, before any target directory/temp write. */
  checkCommit?(overwrite: boolean): Promise<void>;
}

export function sameMetadata(a: Metadata | undefined, b: Metadata | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.identity !== b.identity || a.mode !== b.mode) return false;
  // Creating our own children changes directory timestamps, not its identity.
  return a.kind === 'directory' || (a.size === b.size && a.mtime === b.mtime && a.mtimeExact === b.mtimeExact);
}

export function fileError(error: unknown, fallback = 'FILE_IO_FAILED'): LiteSshError {
  if (error instanceof LiteSshError) return error;
  const code: unknown = (error as { code?: unknown })?.code;
  const mapped = code === 'ENOENT' || code === 2
    ? 'PATH_NOT_FOUND'
    : code === 'EACCES' || code === 'EPERM' || code === 3
      ? 'PATH_PERMISSION_DENIED'
      : code === 'EEXIST' ? 'PATH_CHANGED' : fallback;
  return new LiteSshError(mapped, 'The filesystem operation failed; no automatic retry or replay was performed.');
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new LiteSshError('TRANSFER_CANCELLED', 'Transfer cancellation is being finalized.');
}
