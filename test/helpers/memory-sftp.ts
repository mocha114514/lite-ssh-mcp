import path from 'node:path';
import type {
  Metadata,
  ReadHandle,
  TransferFileSystem,
  WriteHandle
} from '../../src/sftp/filesystem.js';

interface Node {
  path: string;
  metadata: Metadata;
  content?: Buffer;
  target?: string;
}

/**
 * An entirely synthetic POSIX/Windows namespace. Production resolvePath must
 * supply canonical, already-resolved paths: this helper never follows links.
 * This avoids borrowing the host OS's link/.. semantics for Linux wire paths.
 */
export class MemorySftpFs implements TransferFileSystem {
  readonly mutations: string[] = [];
  readonly reads: string[] = [];
  readonly nodes = new Map<string, Node>();
  private serial = 0;

  constructor(
    readonly paths: TransferFileSystem['paths'] = path.posix,
    readonly platform: TransferFileSystem['platform'] = 'posix',
    root = '/'
  ) {
    this.directory(root);
  }

  key(value: string): string {
    const canonical = this.paths.normalize(value);
    return this.platform === 'windows' ? canonical.toLowerCase() : canonical;
  }

  validate(value: string): void {
    if (!this.paths.isAbsolute(value) || value.includes('\0')) {
      throw new Error('Invalid synthetic absolute path');
    }
  }

  private add(value: string, kind: Metadata['kind']): Node {
    this.validate(value);
    const canonical = this.paths.normalize(value);
    const node: Node = {
      path: canonical,
      metadata: {
        kind,
        size: 0,
        mtime: 0,
        mode: kind === 'directory' ? 0o700 : 0o600,
        identity: `synthetic-${++this.serial}`
      }
    };
    this.nodes.set(this.key(canonical), node);
    return node;
  }

  directory(value: string): void {
    const parent = this.paths.dirname(value);
    if (parent !== value && !this.nodes.has(this.key(parent))) this.directory(parent);
    if (!this.nodes.has(this.key(value))) this.add(value, 'directory');
  }

  file(value: string, text: string): void {
    this.directory(this.paths.dirname(value));
    const node = this.add(value, 'file');
    node.content = Buffer.from(text, 'utf8');
    node.metadata.size = node.content.length;
  }

  link(value: string, target: string): void {
    this.directory(this.paths.dirname(value));
    this.add(value, 'symlink').target = target;
  }

  content(value: string): string {
    const node = this.nodes.get(this.key(value));
    if (node?.metadata.kind !== 'file') throw new Error('No synthetic file');
    return node.content!.toString('utf8');
  }

  async lstat(value: string): Promise<Metadata | undefined> {
    const metadata = this.nodes.get(this.key(value))?.metadata;
    return metadata ? { ...metadata } : undefined;
  }

  async readlink(value: string): Promise<string> {
    const node = this.nodes.get(this.key(value));
    if (node?.metadata.kind !== 'symlink') throw new Error('No synthetic link');
    return node.target!;
  }

  async *entries(value: string): AsyncIterable<string> {
    const parent = this.key(value);
    for (const node of this.nodes.values()) {
      if (this.key(node.path) !== parent && this.key(this.paths.dirname(node.path)) === parent) {
        yield this.paths.basename(node.path);
      }
    }
  }

  async mkdir(value: string): Promise<void> {
    if (this.nodes.has(this.key(value))) throw new Error('Synthetic mkdir conflict');
    this.mutations.push(`mkdir:${value}`);
    this.add(value, 'directory');
  }

  async openRead(value: string): Promise<ReadHandle> {
    const node = this.nodes.get(this.key(value));
    if (node?.metadata.kind !== 'file') throw new Error('No synthetic source file');
    this.reads.push(value);
    return {
      stat: async () => ({ ...node.metadata }),
      read: async (buffer, position) => node.content!.copy(buffer, 0, position, position + buffer.length),
      close: async () => undefined
    };
  }

  async createExclusive(value: string): Promise<WriteHandle> {
    if (this.nodes.has(this.key(value))) throw new Error('Synthetic exclusive conflict');
    this.mutations.push(`create:${value}`);
    const node = this.add(value, 'file');
    node.content = Buffer.alloc(0);
    return {
      stat: async () => ({ ...node.metadata }),
      write: async (buffer, length, position) => {
        this.mutations.push(`write:${value}`);
        const next = Buffer.alloc(Math.max(node.content!.length, position + length));
        node.content!.copy(next);
        buffer.copy(next, position, 0, length);
        node.content = next;
        node.metadata.size = next.length;
        node.metadata.mtime++;
      },
      close: async () => undefined
    };
  }

  async commit(temporary: string, final: string, overwrite: boolean): Promise<boolean> {
    if (!overwrite && this.nodes.has(this.key(final))) throw new Error('Synthetic publication conflict');
    const node = this.nodes.get(this.key(temporary));
    if (!node) throw new Error('No synthetic temporary file');
    this.mutations.push(`commit:${final}`);
    this.nodes.set(this.key(final), { ...node, path: final });
    if (overwrite) this.nodes.delete(this.key(temporary));
    return !overwrite;
  }

  async unlink(value: string): Promise<void> {
    this.mutations.push(`unlink:${value}`);
    this.nodes.delete(this.key(value));
  }
}
