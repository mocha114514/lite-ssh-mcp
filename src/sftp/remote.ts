import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Client, SFTPWrapper, Stats } from 'ssh2';
import { LiteSshError } from '../core/errors.js';
import type { Metadata, ReadHandle, TransferFileSystem, WriteHandle } from './filesystem.js';

export function normalizeRemotePath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0') || value.length > 32_768) {
    throw new LiteSshError('INVALID_REMOTE_PATH', 'Use an absolute Linux POSIX remote path without NUL characters.');
  }
  // Preserve every component until resolvePath has applied the link policy.
  // Lexically removing link/.. can otherwise select a different real object.
  return value;
}

function metadata(stats: Stats): Metadata {
  return {
    kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'special',
    size: stats.size,
    mtime: stats.mtime * 1000,
    mode: stats.mode
  };
}

/** One task owns one channel; ending it never ends a shared SSH client. */
export class RemoteFileSystem implements TransferFileSystem {
  readonly paths = path.posix;
  readonly platform = 'posix' as const;
  private closed = false;
  private unusable = false;
  private closing?: Promise<boolean>;
  private readonly checkedCommit = new Set<boolean>();
  private readonly pending = new Set<(error: Error) => void>();
  effectUnknown = false;
  private failPending(error: LiteSshError): void {
    this.unusable = true;
    for (const reject of [...this.pending]) reject(error);
  }
  private readonly onClose = (): void => {
    this.closed = true; // Only the actual close event proves channel teardown.
    this.failPending(new LiteSshError('CONNECTION_LOST', 'The owned SFTP channel closed.'));
  };
  private readonly onError = (): void => {
    this.failPending(new LiteSshError('SFTP_CHANNEL_ERROR', 'The owned SFTP channel failed; closure is not yet confirmed.'));
  };

  constructor(private readonly channel: SFTPWrapper, private readonly timeoutMs = 15_000, private readonly closeTimeoutMs = 2000) {
    channel.on('close', this.onClose);
    channel.on('error', this.onError);
  }
  static async open(client: Client): Promise<RemoteFileSystem> {
    const channel = await new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new LiteSshError('SFTP_UNAVAILABLE', 'Opening the SFTP channel timed out.'));
      }, 15_000);
      try {
        client.sftp((error, channel) => {
          clearTimeout(timer);
          if (settled) { channel?.end(); return; }
          settled = true;
          if (error) reject(new LiteSshError('SFTP_UNAVAILABLE', 'The server could not open an SFTP channel.'));
          else resolve(channel);
        });
      } catch {
        clearTimeout(timer);
        settled = true;
        reject(new LiteSshError('SFTP_UNAVAILABLE', 'The server could not open an SFTP channel.'));
      }
    });
    return new RemoteFileSystem(channel);
  }
  key(value: string): string { return this.paths.normalize(value); }
  validate(value: string): void { normalizeRemotePath(value); }

  private request<T>(invoke: (done: (error: Error | null | undefined, result: T) => void) => void, writes = false): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.unusable) { reject(new LiteSshError('CONNECTION_LOST', 'The SFTP channel cannot accept operations.')); return; }
      let settled = false;
      const finish = (error: Error | null | undefined, result?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(fail);
        if (error) reject(error); else resolve(result as T);
      };
      const fail = (error: Error): void => {
        if (writes) this.effectUnknown = true;
        if (error instanceof LiteSshError) {
          finish(new LiteSshError(error.code, error.message, { ...error.details, effectPossible: writes }));
        } else { finish(error); }
      };
      const timer = setTimeout(() => fail(new LiteSshError('SFTP_REQUEST_TIMEOUT', 'An SFTP operation did not settle; its effects will not be guessed or replayed.')), this.timeoutMs);
      this.pending.add(fail);
      try {
        invoke((error, result) => {
          // ssh2 can reject outstanding callbacks BEFORE emitting close. A
          // numeric code identifies an actual SFTP STATUS reply; a callback
          // error without one cannot prove that the server rejected a write.
          // Keep synchronous invocation failures separate (not dispatched).
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            fail(new LiteSshError(
              writes ? 'SFTP_OUTCOME_UNKNOWN' : 'SFTP_CHANNEL_ERROR',
              writes
                ? 'An SFTP write callback lost its protocol outcome. Effects are not guessed or replayed.'
                : 'An SFTP callback failed without a protocol status.'
            ));
          } else { finish(error, result); }
        });
      } catch (error) { finish(error as Error); }
    });
  }
  async lstat(value: string): Promise<Metadata | undefined> {
    try { return metadata(await this.request<Stats>(done => this.channel.lstat(value, done))); }
    catch (error) {
      if ((error as { code?: number }).code === 2) return undefined;
      throw error;
    }
  }
  readlink(value: string): Promise<string> { return this.request(done => this.channel.readlink(value, done)); }
  async *entries(value: string): AsyncIterable<string> {
    const handle = await this.request<Buffer>(done => this.channel.opendir(value, done));
    try {
      for (;;) {
        const batch = await this.request<import('ssh2').FileEntryWithStats[] | false>(done => {
          // The public handle overload reports STATUS EOF as an error, unlike
          // the path overload which collects all entries internally.
          this.channel.readdir(handle, (error, entries) => {
            if ((error as { code?: number } | undefined)?.code === 1) done(undefined, false);
            else done(error, entries);
          });
        });
        if (batch === false || batch.length === 0) break;
        for (const entry of batch) if (entry.filename !== '.' && entry.filename !== '..') yield entry.filename;
      }
    } finally { await this.request<void>(done => this.channel.close(handle, error => done(error, undefined))); }
  }
  mkdir(value: string): Promise<void> {
    return this.request(done => this.channel.mkdir(value, { mode: 0o700 }, error => done(error, undefined)), true);
  }
  private file(handle: Buffer): ReadHandle & WriteHandle {
    return {
      stat: async () => metadata(await this.request<Stats>(done => this.channel.fstat(handle, done))),
      read: (buffer, position) => this.request<number>(done => this.channel.read(handle, buffer, 0, buffer.length, position, (error, length) => {
        // ssh2 reports EOF as status code 1 with zero bytes in some servers.
        if ((error as { code?: number } | undefined)?.code === 1) done(undefined, 0);
        else done(error, length);
      })),
      write: (buffer, length, position) => this.request<void>(done => this.channel.write(handle, buffer, 0, length, position, error => done(error, undefined)), true),
      close: () => this.request<void>(done => this.channel.close(handle, error => done(error, undefined)))
    };
  }
  async openRead(value: string): Promise<ReadHandle> {
    return this.file(await this.request<Buffer>(done => this.channel.open(value, 'r', done)));
  }
  async createExclusive(value: string): Promise<WriteHandle> {
    try {
      return this.file(await this.request<Buffer>(done => this.channel.open(value, 'wx', { mode: 0o600 }, done), true));
    } catch (error) {
      if (error instanceof LiteSshError && error.details.effectPossible === true) {
        throw new LiteSshError('SFTP_CREATE_OUTCOME_UNKNOWN', 'Exclusive SFTP creation did not settle. The attempted name is reported without guessing ownership.', { possibleResidualPath: value });
      }
      throw error;
    }
  }
  private async publish(temporary: string, final: string, overwrite: boolean, writes: boolean): Promise<void> {
    await this.request<void>(done => {
      try {
        const operation = overwrite ? this.channel.ext_openssh_rename.bind(this.channel) : this.channel.ext_openssh_hardlink.bind(this.channel);
        operation(temporary, final, error => done(error, undefined));
      } catch {
        throw new LiteSshError('COMMIT_UNSUPPORTED', 'The server does not advertise the required safe SFTP publication extension. No delete-and-copy fallback is used.');
      }
    }, writes).catch(error => {
      if ((error as { code?: number }).code === 8) {
        throw new LiteSshError('COMMIT_UNSUPPORTED', 'The server refused the required safe SFTP publication extension.');
      }
      throw error;
    });
  }
  async checkCommit(overwrite: boolean): Promise<void> {
    if (this.checkedCommit.has(overwrite)) return;
    // Use only ssh2's public extension APIs. Identical source/destination is
    // nonmutating (rename is a no-op, hardlink cannot replace that same name),
    // including a race where another client creates our random probe name.
    const probe = `/.lite-ssh-capability-${randomUUID()}`;
    try { await this.publish(probe, probe, overwrite, false); }
    catch (error) {
      if (error instanceof LiteSshError) throw error;
      const code = (error as { code?: unknown }).code;
      // A normal protocol status proves an advertised extension was reached;
      // unsupported status 8 is already mapped by publish. Actual path access
      // and I/O are still independently validated during planning/execution.
      if (typeof code !== 'number' || code < 1 || code > 7) throw error;
    }
    this.checkedCommit.add(overwrite);
  }
  async commit(temporary: string, final: string, overwrite: boolean): Promise<boolean> {
    await this.publish(temporary, final, overwrite, true);
    return !overwrite;
  }
  unlink(value: string): Promise<void> {
    return this.request(done => this.channel.unlink(value, error => done(error, undefined)), true);
  }
  dispose(): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    this.closing ??= new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.channel.removeListener('close', done);
        resolve(confirmed);
      };
      const done = (): void => finish(true);
      const timer = setTimeout(() => {
        this.failPending(new LiteSshError('SFTP_CLOSE_TIMEOUT', 'SFTP channel closure was not confirmed.'));
        finish(false); // Never synthesize an onClose event.
      }, this.closeTimeoutMs);
      this.channel.once('close', done);
      this.failPending(new LiteSshError('CONNECTION_LOST', 'The owned SFTP channel is being closed.'));
      try { this.channel.end(); } catch { finish(false); }
    });
    return this.closing;
  }
}
