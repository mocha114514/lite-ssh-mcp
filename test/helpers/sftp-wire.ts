import type { Stats } from 'node:fs';

// Test-only SFTP v3 framing. The real ssh2 Client performs all SSH negotiation
// and client-side SFTP parsing; no ssh2 private fields or runtime patches.
export const MAX_SFTP_PACKET = 1024 * 1024;

export function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

export function uint64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Unsafe test wire integer');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

export function wireString(value: string | Buffer): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([uint32(bytes.length), bytes]);
}

export function packet(type: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from([type]), ...parts]);
  if (body.length > MAX_SFTP_PACKET) throw new Error('Test wire packet budget exceeded');
  return Buffer.concat([uint32(body.length), body]);
}

export function attributes(stats: Stats): Buffer {
  return Buffer.concat([
    uint32(15),
    uint64(stats.size),
    uint32(0),
    uint32(0),
    uint32(stats.mode),
    uint32(Math.floor(stats.atimeMs / 1000)),
    uint32(Math.floor(stats.mtimeMs / 1000))
  ]);
}

export class WireReader {
  private offset = 0;
  constructor(private readonly bytes: Buffer) {}

  private take(length: number): Buffer {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Truncated test wire packet');
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  byte(): number { return this.take(1)[0]!; }
  uint32(): number { return this.take(4).readUInt32BE(); }
  uint64(): number {
    const value = this.take(8).readBigUInt64BE();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe test wire integer');
    return Number(value);
  }
  buffer(): Buffer { return this.take(this.uint32()); }
  string(): string {
    const bytes = this.buffer();
    const value = bytes.toString('utf8');
    if (!Buffer.from(value, 'utf8').equals(bytes)) throw new Error('Invalid test wire UTF8');
    return value;
  }
  attrs(): void {
    const flags = this.uint32();
    if (flags & ~15) throw new Error('Unsupported test attributes');
    if (flags & 1) this.uint64();
    if (flags & 2) { this.uint32(); this.uint32(); }
    if (flags & 4) this.uint32();
    if (flags & 8) { this.uint32(); this.uint32(); }
  }
  end(): void {
    if (this.offset !== this.bytes.length) throw new Error('Unexpected test wire trailing bytes');
  }
}
