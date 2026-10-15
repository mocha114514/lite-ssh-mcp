import { types } from 'node:util';

export const MAX_STDIO_FRAME_BYTES = 64 * 1024 * 1024;
export const STDIO_WRITER_BLOCK_BYTES = 64 * 1024;

export interface StdioCodecLimits {
  bytes?: number;
  depth?: number;
  nodes?: number;
}
export class StdioEncodingError extends Error {
  constructor(readonly code: 'STDIO_RESPONSE_TOO_LARGE' | 'STDIO_ENCODING_FAILED') {
    super(code === 'STDIO_RESPONSE_TOO_LARGE'
      ? 'The stdio response exceeds its encoded size budget.'
      : 'The stdio response cannot be encoded safely.');
    this.name = 'StdioEncodingError';
  }
}
const unsafe = (): never => { throw new StdioEncodingError('STDIO_ENCODING_FAILED'); };

/** Byte accounting without allocating a JSON-escaped copy of a large string. */
function quotedBytes(value: string, remaining: number): number {
  let size = 2;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) size += 2;
    else if (code < 32) size += 6;
    else if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { size += 4; i++; }
      else size += 6; // Well-formed JSON.stringify escapes a lone surrogate.
    } else if (code >= 0xdc00 && code <= 0xdfff) size += 6;
    else size += 3;
    if (size > remaining) throw new StdioEncodingError('STDIO_RESPONSE_TOO_LARGE');
  }
  return size;
}

/**
 * The same descriptor-only walk measures and emits JSON. No original object is
 * handed to JSON.stringify: inherited hooks, getters and proxies cannot run.
 * Only primitive strings/numbers use the built-in encoder. Shared references
 * are legal; only references already on the current ancestor path are cycles.
 */
function walk(value: unknown, limits: StdioCodecLimits, emit?: (text: string) => void): number {
  const maxBytes = limits.bytes ?? MAX_STDIO_FRAME_BYTES;
  const maxDepth = limits.depth ?? 64;
  const maxNodes = limits.nodes ?? 1_000_000;
  for (const limit of [maxBytes, maxDepth, maxNodes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) unsafe();
  }
  if (maxBytes > MAX_STDIO_FRAME_BYTES || maxDepth > 64 || maxNodes > 1_000_000) unsafe();
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const put = (text: string, length = Buffer.byteLength(text)): void => {
    bytes += length;
    if (bytes > maxBytes) throw new StdioEncodingError('STDIO_RESPONSE_TOO_LARGE');
    emit?.(text);
  };
  const string = (text: string): void => {
    const length = quotedBytes(text, maxBytes - bytes);
    // Measurement never materializes the escaped string. Encoding happens only
    // after the entire frame has passed its byte/depth/node preflight.
    if (emit) put(JSON.stringify(text), length);
    else { bytes += length; if (bytes > maxBytes) throw new StdioEncodingError('STDIO_RESPONSE_TOO_LARGE'); }
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) unsafe();
    if (item === null) { put('null'); return; }
    switch (typeof item) {
      case 'string': string(item); return;
      case 'boolean': put(item ? 'true' : 'false'); return;
      case 'number': put(Number.isFinite(item) ? JSON.stringify(item) : 'null'); return;
      case 'object': break;
      default: unsafe();
    }
    const object = item as object;
    if (types.isProxy(object)) unsafe();
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) unsafe();
    if (ancestors.has(object)) unsafe();
    const names = Object.getOwnPropertyNames(object);
    if (names.length > maxNodes) unsafe();
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(object, name)!;
      if (descriptor.get || descriptor.set) unsafe();
      if (name === 'toJSON' && typeof descriptor.value === 'function') unsafe();
    }
    ancestors.add(object);
    try {
      if (array) {
        const length = (object as unknown[]).length;
        if (length > maxNodes - nodes) unsafe();
        put('[');
        for (let i = 0; i < length; i++) {
          if (i !== 0) put(',');
          const entry = Object.getOwnPropertyDescriptor(object, String(i))?.value;
          visit(entry === undefined ? null : entry, depth + 1);
        }
        put(']');
      } else {
        put('{');
        let first = true;
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(object, name)!;
          if (!descriptor.enumerable || descriptor.value === undefined) continue;
          if (!first) put(',');
          first = false;
          string(name);
          put(':');
          visit(descriptor.value, depth + 1);
        }
        put('}');
      }
    } finally { ancestors.delete(object); }
  };
  visit(value, 1);
  put('\n');
  return bytes;
}

export function measureMessage(value: unknown, limits: StdioCodecLimits = {}): number {
  return walk(value, limits);
}

export function encodeMessage(value: unknown, limits: StdioCodecLimits = {}): Buffer {
  const bytes = measureMessage(value, limits);
  const buffer = Buffer.allocUnsafe(bytes);
  let offset = 0;
  const emitted = walk(value, limits, text => {
    offset += buffer.write(text, offset, buffer.length - offset, 'utf8');
  });
  if (emitted !== bytes || offset !== bytes) unsafe();
  return buffer;
}
