import path from 'node:path';
import { LiteSshError } from '../../src/core/errors.js';
import type { Metadata, ReadHandle, TransferFileSystem, WriteHandle } from '../../src/sftp/filesystem.js';

interface Node {
  path: string;
  metadata: Metadata;
  contents: Buffer;
  link?: string;
}

/** Synthetic namespaces let POSIX A/a coexist while the target uses casefold. */
export class MemoryTransferFileSystem implements TransferFileSystem {
  readonly paths: typeof path.posix;
  readonly nodes = new Map<string, Node>();
  readonly mutations: string[] = [];
  commits = 0;
  reads = 0;
  onRead?: () => void;
  private identity = 0;

  constructor(
    readonly platform: 'posix' | 'windows',
    private readonly identities = true
  ) {
    this.paths = platform === 'windows' ? path.win32 : path.posix;
    this.directory(platform === 'windows' ? 'C:\\' : '/');
  }

  key(value: string): string {
    const normalized = this.paths.normalize(value);
    return this.platform === 'windows' ? normalized.toLowerCase() : normalized;
  }

  validate(value: string): void {
    if (!this.paths.isAbsolute(value) || value.includes('\0')) {
      throw new LiteSshError('INVALID_PATH', 'Invalid synthetic path.');
    }
  }

  private node(value: string, kind: Metadata['kind'], contents = Buffer.alloc(0), link?: string): Node {
    this.validate(value);
    const node: Node = {
      path: this.paths.normalize(value), contents, link,
      metadata: {
        kind, size: contents.length, mtime: 1, mode: kind === 'directory' ? 0o40700 : 0o100600,
        ...(this.identities ? { identity: `${this.platform}:${++this.identity}` } : {})
      }
    };
    this.nodes.set(this.key(value), node);
    return node;
  }

  directory(value: string): void { this.node(value, 'directory'); }
  file(value: string, contents: string): void { this.node(value, 'file', Buffer.from(contents)); }
  symlink(value: string, target: string): void { this.node(value, 'symlink', Buffer.from(target), target); }

  async lstat(value: string): Promise<Metadata | undefined> {
    this.validate(value);
    const node = this.nodes.get(this.key(value));
    return node ? { ...node.metadata } : undefined;
  }

  async readlink(value: string): Promise<string> {
    const node = this.nodes.get(this.key(value));
    if (node?.link === undefined) throw new LiteSshError('PATH_NOT_FOUND', 'Synthetic link not found.');
    return node.link;
  }

  async *entries(value: string): AsyncIterable<string> {
    const parent = this.key(value);
    for (const node of this.nodes.values()) {
      if (this.key(node.path) !== parent && this.key(this.paths.dirname(node.path)) === parent) {
        yield this.paths.basename(node.path);
      }
    }
  }

  private requireAbsent(value: string): void {
    if (this.nodes.has(this.key(value))) {
      throw new LiteSshError('PATH_CHANGED', 'Synthetic create-only target exists.');
    }
    const parent = this.nodes.get(this.key(this.paths.dirname(value)));
    if (parent?.metadata.kind !== 'directory') {
      throw new LiteSshError('PATH_NOT_FOUND', 'Synthetic parent directory not found.');
    }
  }

  async mkdir(value: string): Promise<void> {
    this.requireAbsent(value);
    this.mutations.push(`mkdir:${value}`);
    this.directory(value);
  }

  async openRead(value: string): Promise<ReadHandle> {
    const node = this.nodes.get(this.key(value));
    if (node?.metadata.kind !== 'file') throw new LiteSshError('PATH_NOT_FOUND', 'Synthetic source not found.');
    this.reads++;
    return {
      stat: async () => ({ ...node.metadata }),
      read: async (buffer, position) => {
        this.onRead?.();
        return node.contents.copy(buffer, 0, position, position + buffer.length);
      },
      close: async () => {}
    };
  }

  async createExclusive(value: string): Promise<WriteHandle> {
    this.requireAbsent(value);
    this.mutations.push(`create:${value}`);
    const node = this.node(value, 'file');
    return {
      stat: async () => ({ ...node.metadata }),
      write: async (buffer, length, position) => {
        const contents = Buffer.alloc(Math.max(node.contents.length, position + length));
        node.contents.copy(contents);
        buffer.copy(contents, position, 0, length);
        node.contents = contents;
        node.metadata.size = contents.length;
        node.metadata.mtime++;
      },
      close: async () => {}
    };
  }

  async commit(temporary: string, final: string, overwrite: boolean): Promise<boolean> {
    const node = this.nodes.get(this.key(temporary));
    if (!node) throw new LiteSshError('PATH_NOT_FOUND', 'Synthetic temporary not found.');
    if (!overwrite && this.nodes.has(this.key(final))) {
      throw new LiteSshError('PATH_CHANGED', 'Synthetic create-only target exists.');
    }
    this.mutations.push(`commit:${final}`);
    this.commits++;
    // Publication retains the temporary inode metadata, matching the production
    // atomic-publication post-check. Create-only leaves its owned hard-link temp.
    this.nodes.set(this.key(final), { ...node, path: this.paths.normalize(final) });
    if (overwrite) this.nodes.delete(this.key(temporary));
    return !overwrite;
  }

  async unlink(value: string): Promise<void> {
    this.mutations.push(`unlink:${value}`);
    this.nodes.delete(this.key(value));
  }

  text(value: string): string | undefined {
    return this.nodes.get(this.key(value))?.contents.toString('utf8');
  }
}
