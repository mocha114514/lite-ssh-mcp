import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { LiteSshError } from '../core/errors.js';
import type { Metadata, ReadHandle, TransferFileSystem, WriteHandle } from './filesystem.js';

export function validateWindowsPath(value: string): void {
  const root = path.win32.parse(value).root;
  for (const name of value.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    if (name === '.' || name === '..') continue;
    if (/[<>:"|?*\u0000-\u001f]/u.test(name) || /[. ]$/u.test(name) ||
        /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
      throw new LiteSshError('INVALID_LOCAL_PATH', 'A mapped filename is not representable on Windows. Names are never automatically changed.', { invalidName: name });
    }
  }
}

export function normalizeLocalPath(value: string): string {
  // Do not collapse link/..: the resolver must visit the link before .. .
  const expanded = value.startsWith('~/') || value.startsWith('~\\')
    ? `${homedir()}${path.sep}${value.slice(2)}`
    : value;
  if (!path.isAbsolute(expanded)) {
    throw new LiteSshError('INVALID_LOCAL_PATH', 'Use an absolute local path or an explicitly expanded ~/ path.');
  }
  if (expanded.includes('\0') || expanded.length > 32_768) {
    throw new LiteSshError('INVALID_LOCAL_PATH', 'The local path is invalid or too long.');
  }
  if (process.platform === 'win32') {
    validateWindowsPath(expanded);
    return expanded.replace(/\//gu, '\\');
  }
  return expanded;
}

function metadata(stats: BigIntStats): Metadata {
  return {
    kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'special',
    size: Number(stats.size),
    mtime: Number(stats.mtimeNs) / 1_000_000,
    mtimeExact: stats.mtimeNs.toString(),
    mode: Number(stats.mode),
    identity: `${stats.dev}:${stats.ino}`
  };
}

class LocalHandle implements ReadHandle, WriteHandle {
  constructor(private readonly handle: FileHandle) {}
  async stat(): Promise<Metadata> { return metadata(await this.handle.stat({ bigint: true })); }
  async read(buffer: Buffer, position: number): Promise<number> {
    return (await this.handle.read(buffer, 0, buffer.length, position)).bytesRead;
  }
  async write(buffer: Buffer, length: number, position: number): Promise<void> {
    let offset = 0;
    while (offset < length) {
      const { bytesWritten } = await this.handle.write(buffer, offset, length - offset, position + offset);
      if (bytesWritten === 0) throw new LiteSshError('FILE_IO_FAILED', 'The file write made no progress.');
      offset += bytesWritten;
    }
  }
  close(): Promise<void> { return this.handle.close(); }
}

export class LocalFileSystem implements TransferFileSystem {
  readonly paths = path;
  readonly platform = process.platform === 'win32' ? 'windows' as const : 'posix' as const;
  key(value: string): string {
    const normalized = this.paths.normalize(value);
    return this.platform === 'windows' ? normalized.toLowerCase() : normalized;
  }
  validate(value: string): void {
    if (this.platform === 'windows') validateWindowsPath(value);
    if (value.includes('\0')) throw new LiteSshError('INVALID_LOCAL_PATH', 'A mapped path contains a NUL character.');
  }
  async lstat(value: string): Promise<Metadata | undefined> {
    try { return metadata(await fs.lstat(value, { bigint: true })); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  readlink(value: string): Promise<string> { return fs.readlink(value); }
  async *entries(value: string): AsyncIterable<string> {
    const directory = await fs.opendir(value);
    // for-await owns closure even if the planner aborts at its resource limit.
    for await (const entry of directory) yield entry.name;
  }
  async mkdir(value: string): Promise<void> { await fs.mkdir(value, { mode: 0o700 }); }
  async openRead(value: string): Promise<ReadHandle> {
    // A regular source can become a FIFO after preflight. Open without
    // waiting for a writer, then let the runner's FD type/identity check reject
    // the replacement before reading or creating any target temporary file.
    const flags = constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0);
    return new LocalHandle(await fs.open(value, flags));
  }
  async createExclusive(value: string): Promise<WriteHandle> {
    return new LocalHandle(await fs.open(value, 'wx', 0o600));
  }
  async commit(temporary: string, final: string, overwrite: boolean): Promise<boolean> {
    if (overwrite) { await fs.rename(temporary, final); return false; }
    try { await fs.link(temporary, final); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
        throw new LiteSshError('COMMIT_UNSUPPORTED', 'The local filesystem does not support safe create-only publication.');
      }
      throw error;
    }
    return true;
  }
  unlink(value: string): Promise<void> { return fs.unlink(value); }
}
