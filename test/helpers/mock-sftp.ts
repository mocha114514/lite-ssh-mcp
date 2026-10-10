import { promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ServerChannel } from 'ssh2';
import { MAX_SFTP_PACKET, WireReader, attributes, packet, uint32, wireString } from './sftp-wire.js';
import { validateWindowsPath } from '../../src/sftp/local.js';

export interface SftpRequest {
  type: number;
  path?: string;
}

export interface SftpEffect extends SftpRequest {
  nativePath: string;
  file: FileHandle;
  /** Acquisition proof belongs to the fixture creator, not the MCP client. */
  exclusiveCreate: boolean;
}

export interface MockSftpOptions {
  publications?: boolean;
  beforeRequest?: (request: SftpRequest) => Promise<'fail' | 'disconnect' | void>;
  afterEffect?: (effect: SftpEffect) => Promise<'disconnect' | void>;
}

export interface MockSftpStats {
  channels: number;
  openHandles: number;
  mkdirs: number;
  exclusiveCreates: number;
  writeRequests: number;
  bytesWritten: number;
  commits: number;
  removals: number;
  reads: number;
  probes: number;
}

export function emptySftpStats(): MockSftpStats {
  return {
    channels: 0,
    openHandles: 0,
    mkdirs: 0,
    exclusiveCreates: 0,
    writeRequests: 0,
    bytesWritten: 0,
    commits: 0,
    removals: 0,
    reads: 0,
    probes: 0
  };
}

type Handle =
  | { kind: 'file'; file: FileHandle; nativePath: string; exclusiveCreate: boolean }
  | { kind: 'directory'; nativePath: string; names: string[]; offset: number };

/** Real raw SSH subsystem, bounded SFTP-v3 wire server, owned synthetic tree.
 * ssh2's public default server sends VERSION without extensions. Using its
 * public generic subsystem event lets this fixture advertise genuine wire
 * capabilities without altering node_modules or inspecting private fields.
 */
export function attachMockSftp(
  channel: ServerChannel,
  root: string,
  stats: MockSftpStats,
  options: MockSftpOptions = {}
): { close(): Promise<void> } {
  const handles = new Map<number, Handle>();
  let nextHandle = 1;
  let received = Buffer.alloc(0);
  let initialized = false;
  let stopped = false;
  let pending = 0;
  let tail = Promise.resolve();
  let closing: Promise<void> | undefined;
  stats.channels++;

  const send = (bytes: Buffer): Promise<void> => {
    if (stopped) return Promise.resolve();
    // Await the public stream callback: the peer's SSH window must bound
    // outgoing responses too, not just the incoming request queue.
    return new Promise((resolve, reject) => {
      let settled = false;
      const closed = (): void => finish();
      const finish = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        channel.removeListener('close', closed);
        if (error) reject(error); else resolve();
      };
      channel.once('close', closed);
      try { channel.write(bytes, finish); }
      catch (error) { finish(error as Error); }
    });
  };
  const status = (id: number, code: number): Promise<void> => {
    return send(packet(101, uint32(id), uint32(code), wireString('synthetic status'), wireString('')));
  };
  const withinRoot = (value: string): boolean => {
    const relative = path.relative(root, value);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  const virtual = (native: string): string => {
    if (!withinRoot(native)) throw Object.assign(new Error('Outside synthetic root'), { code: 'EACCES' });
    return '/' + path.relative(root, native).split(path.sep).join('/');
  };
  const nativePath = async (value: string, followFinal = false): Promise<string> => {
    if (!value.startsWith('/') || value.includes('\0') || value.length > 32768 ||
        (process.platform === 'win32' && value.includes('\\'))) {
      throw Object.assign(new Error('Invalid synthetic path'), { code: 'EACCES' });
    }
    const result = path.resolve(root, '.' + path.posix.normalize(value));
    if (process.platform === 'win32') validateWindowsPath(result);
    if (!withinRoot(result)) throw Object.assign(new Error('Outside synthetic root'), { code: 'EACCES' });
    // Check existing physical ancestors before any data access. In particular,
    // a test-created junction cannot route requests into another user's tree.
    let candidate = followFinal || result === root ? result : path.dirname(result);
    for (;;) {
      try {
        const actual = await fs.realpath(candidate);
        if (!withinRoot(actual)) throw Object.assign(new Error('Outside synthetic root'), { code: 'EACCES' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === root) throw error;
        candidate = path.dirname(candidate);
      }
    }
    return result;
  };
  const replyNames = (id: number, names: Array<{ name: string; stats?: Stats }>): Promise<void> => {
    return send(packet(104, uint32(id), uint32(names.length), ...names.flatMap(entry => [
      wireString(entry.name),
      wireString(''),
      entry.stats ? attributes(entry.stats) : uint32(0)
    ])));
  };
  const getHandle = (reader: WireReader): Handle => {
    const bytes = reader.buffer();
    if (bytes.length !== 4) throw new Error('Bad synthetic handle');
    const value = handles.get(bytes.readUInt32BE());
    if (!value) throw new Error('Unknown synthetic handle');
    return value;
  };
  const effectLost = async (type: number, handle: Extract<Handle, { kind: 'file' }>): Promise<boolean> => {
    const action = await options.afterEffect?.({
      type, nativePath: handle.nativePath, file: handle.file, exclusiveCreate: handle.exclusiveCreate
    });
    if (action !== 'disconnect') return false;
    channel.close();
    return true;
  };
  const addHandle = async (id: number, handle: Handle): Promise<void> => {
    const key = nextHandle++;
    handles.set(key, handle);
    stats.openHandles++;
    // Register the acquired FD BEFORE fault injection, so even an OPEN whose
    // HANDLE response is lost belongs to the fixture's normal FD teardown.
    if (handle.kind === 'file' && handle.exclusiveCreate && await effectLost(3, handle)) return;
    await send(packet(102, uint32(id), wireString(uint32(key))));
  };

  const dispatch = async (bytes: Buffer): Promise<void> => {
    const reader = new WireReader(bytes);
    const type = reader.byte();
    if (type === 1) {
      if (initialized || reader.uint32() !== 3) throw new Error('Bad synthetic INIT');
      reader.end();
      initialized = true;
      const extensions = options.publications === false ? [] : [
        wireString('hardlink@openssh.com'), wireString('1'),
        wireString('posix-rename@openssh.com'), wireString('1')
      ];
      await send(packet(2, uint32(3), ...extensions));
      return;
    }
    if (!initialized) throw new Error('Request before synthetic INIT');
    const id = reader.uint32();
    try {
      const request: SftpRequest = { type };
      const action = await options.beforeRequest?.(request);
      if (action === 'disconnect') { channel.close(); return; }
      if (action === 'fail') { await status(id, 4); return; }
      switch (type) {
        case 3: {
          const value = reader.string();
          const flags = reader.uint32();
          reader.attrs();
          reader.end();
          const writing = Boolean(flags & 2);
          if (writing && (!(flags & 8) || !(flags & 32) || (flags & 4))) {
            await status(id, 8);
            return;
          }
          const native = await nativePath(value, !writing);
          const file = await fs.open(native, writing ? 'wx' : 'r', 0o600);
          if (writing) stats.exclusiveCreates++;
          await addHandle(id, { kind: 'file', file, nativePath: native, exclusiveCreate: writing });
          break;
        }
        case 4: {
          const value = reader.buffer();
          reader.end();
          if (value.length !== 4) throw new Error('Bad synthetic handle');
          const key = value.readUInt32BE();
          const handle = handles.get(key);
          if (!handle) throw new Error('Unknown synthetic handle');
          if (handle.kind === 'file') await handle.file.close();
          handles.delete(key);
          stats.openHandles--;
          await status(id, 0);
          break;
        }
        case 5: {
          const handle = getHandle(reader);
          const position = reader.uint64();
          const length = reader.uint32();
          reader.end();
          if (handle.kind !== 'file' || length > 256 * 1024) throw new Error('Bad synthetic READ');
          const buffer = Buffer.alloc(length);
          const result = await handle.file.read(buffer, 0, length, position);
          stats.reads++;
          if (!result.bytesRead) await status(id, 1);
          else await send(packet(103, uint32(id), wireString(buffer.subarray(0, result.bytesRead))));
          break;
        }
        case 6: {
          const handle = getHandle(reader);
          const position = reader.uint64();
          const data = reader.buffer();
          reader.end();
          if (handle.kind !== 'file') throw new Error('Bad synthetic WRITE');
          let offset = 0;
          while (offset < data.length) {
            const result = await handle.file.write(data, offset, data.length - offset, position + offset);
            if (!result.bytesWritten) throw new Error('Synthetic write made no progress');
            offset += result.bytesWritten;
          }
          stats.writeRequests++;
          stats.bytesWritten += data.length;
          if (await effectLost(6, handle)) return;
          await status(id, 0);
          break;
        }
        case 8: {
          const handle = getHandle(reader);
          reader.end();
          const value = handle.kind === 'file' ? await handle.file.stat() : await fs.stat(handle.nativePath);
          await send(packet(105, uint32(id), attributes(value)));
          break;
        }
        case 7:
        case 17: {
          const value = await nativePath(reader.string(), type === 17);
          reader.end();
          const result = type === 7 ? await fs.lstat(value) : await fs.stat(value);
          await send(packet(105, uint32(id), attributes(result)));
          break;
        }
        case 11: {
          const value = await nativePath(reader.string(), true);
          reader.end();
          const names = await fs.readdir(value);
          if (names.length > 20000) throw new Error('Synthetic directory budget exceeded');
          await addHandle(id, { kind: 'directory', nativePath: value, names, offset: 0 });
          break;
        }
        case 12: {
          const handle = getHandle(reader);
          reader.end();
          if (handle.kind !== 'directory') throw new Error('Bad synthetic READDIR');
          const names = handle.names.slice(handle.offset, handle.offset + 16);
          handle.offset += names.length;
          if (!names.length) await status(id, 1);
          else await replyNames(id, await Promise.all(names.map(async name => ({
            name,
            stats: await fs.lstat(path.join(handle.nativePath, name))
          }))));
          break;
        }
        case 13: {
          const value = await nativePath(reader.string());
          reader.end();
          await fs.unlink(value);
          stats.removals++;
          await status(id, 0);
          break;
        }
        case 14: {
          const value = await nativePath(reader.string());
          reader.attrs();
          reader.end();
          await fs.mkdir(value, { mode: 0o700 });
          stats.mkdirs++;
          await status(id, 0);
          break;
        }
        case 19: {
          const value = await nativePath(reader.string());
          reader.end();
          const target = await fs.readlink(value);
          const absolute = path.resolve(path.dirname(value), target);
          await replyNames(id, [{ name: virtual(absolute) }]);
          break;
        }
        case 200: {
          const extension = reader.string();
          const from = await nativePath(reader.string());
          const to = await nativePath(reader.string());
          reader.end();
          if (options.publications === false ||
              !['hardlink@openssh.com', 'posix-rename@openssh.com'].includes(extension)) {
            await status(id, 8);
            break;
          }
          if (from === to) stats.probes++;
          if (extension === 'hardlink@openssh.com') await fs.link(from, to);
          else await fs.rename(from, to);
          if (from !== to) stats.commits++;
          await status(id, 0);
          break;
        }
        default: await status(id, 8);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      await status(id, code === 'ENOENT' ? 2 : code === 'EACCES' || code === 'EPERM' ? 3 : 4);
    }
  };

  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopped = true;
      await tail;
      for (const handle of handles.values()) {
        if (handle.kind === 'file') await handle.file.close();
        stats.openHandles--;
      }
      handles.clear();
    })();
    return closing;
  };
  channel.on('error', () => undefined);
  channel.on('close', () => { stats.channels--; void close(); });
  channel.on('end', () => { channel.end(); channel.close(); });
  channel.on('data', (chunk: Buffer) => {
    if (stopped) return;
    received = Buffer.concat([received, chunk]);
    if (received.length > MAX_SFTP_PACKET + 4) { channel.close(); return; }
    while (received.length >= 4) {
      const length = received.readUInt32BE();
      if (length < 1 || length > MAX_SFTP_PACKET || pending >= 128) { channel.close(); return; }
      if (received.length < length + 4) break;
      const bytes = received.subarray(4, length + 4);
      received = received.subarray(length + 4);
      pending++;
      if (pending >= 8) channel.pause();
      tail = tail.then(() => stopped ? undefined : dispatch(bytes))
        .catch(() => { channel.close(); })
        .finally(() => {
          pending--;
          if (!stopped && pending < 8) channel.resume();
        });
    }
  });
  return { close };
}
