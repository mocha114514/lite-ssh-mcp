import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionLease } from '../../src/core/types.js';
import { LocalFileSystem } from '../../src/sftp/local.js';
import type { OwnedRemoteFileSystem } from '../../src/sftp/manager.js';

/** Synthetic remote namespace: no SSH server, shell or real user path. */
export class MappedRemote implements OwnedRemoteFileSystem {
  readonly paths = path.posix;
  readonly platform = 'posix' as const;
  readonly effectUnknown: boolean = false;
  closed = false;
  private readonly local = new LocalFileSystem();
  constructor(readonly root: string) {}
  key(value: string): string { return this.paths.normalize(value); }
  validate(value: string): void {
    if (!value.startsWith('/') || value.includes('\0')) throw new Error('Invalid synthetic remote path');
  }
  private resolve(value: string): string {
    this.validate(value);
    return path.join(this.root, ...this.paths.normalize(value).slice(1).split('/'));
  }
  lstat(value: string) { return this.local.lstat(this.resolve(value)); }
  readlink(value: string) { return this.local.readlink(this.resolve(value)); }
  entries(value: string) { return this.local.entries(this.resolve(value)); }
  mkdir(value: string) { return this.local.mkdir(this.resolve(value)); }
  openRead(value: string) { return this.local.openRead(this.resolve(value)); }
  createExclusive(value: string) { return this.local.createExclusive(this.resolve(value)); }
  commit(temporary: string, final: string, overwrite: boolean) { return this.local.commit(this.resolve(temporary), this.resolve(final), overwrite); }
  unlink(value: string) { return this.local.unlink(this.resolve(value)); }
  async dispose(): Promise<boolean> { this.closed = true; return true; }
}

export async function createTransferFixture(root: string) {
  await fs.mkdir(path.join(root, 'remote'), { recursive: true });
  await fs.mkdir(path.join(root, 'local'), { recursive: true });
  const remotes: MappedRemote[] = [];
  let released = 0;
  let acquired = 0;
  return {
    root, localPath: path.join(root, 'local'), remoteRoot: path.join(root, 'remote'),
    pool: { acquire: async (target: ConnectionLease['target']): Promise<ConnectionLease> => {
      acquired++;
      return { client: {} as ConnectionLease['client'], target: { ip: target.ip, port: target.port, username: target.username }, release: async () => { released++; } };
    } },
    remote: async () => { const remote = new MappedRemote(path.join(root, 'remote')); remotes.push(remote); return remote; },
    remotes, acquired: () => acquired, released: () => released
  };
}
