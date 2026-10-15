import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

interface Limits { bytes?: number; depth?: number; nodes?: number }
type Encoder = (value: unknown, limits?: Limits) => Buffer;
const moduleUrl = new URL('../src/mcp/stdio-codec.js', import.meta.url);
let installed = false;
let encode: Encoder;
try {
  const module = await import(moduleUrl.href) as { encodeMessage: Encoder };
  encode = module.encodeMessage;
  installed = true;
} catch (error) {
  const missing = error as { code?: string; url?: string };
  if (missing.code !== 'ERR_MODULE_NOT_FOUND' || missing.url !== moduleUrl.href) throw error;
  // The baseline delegates to the actual SDK codec. A dedicated presence test
  // prevents this RED-only fallback from hiding a missing product module later.
  encode = value => Buffer.from(serializeMessage(value as Parameters<typeof serializeMessage>[0]));
}
const message = (result: unknown) => ({ jsonrpc: '2.0' as const, id: 'owned-fixture', result });
const sdk = (value: unknown): string => serializeMessage(value as Parameters<typeof serializeMessage>[0]);
const safeFailure = (work: () => unknown, code: string): void => {
  assert.throws(work, error => {
    const failure = error as Error & { code?: string };
    assert.equal(failure.code, code);
    assert.equal(failure.message, code === 'STDIO_RESPONSE_TOO_LARGE'
      ? 'The stdio response exceeds its encoded size budget.'
      : 'The stdio response cannot be encoded safely.');
    return true;
  });
};

test('F15 the bounded codec product module must be present', () => {
  assert.equal(installed, true);
});

test('F15 codec preserves SDK JSON, UTF-8, escaping, sparse arrays and shared references', () => {
  const shared = { text: '中文😀\n\t"\\\ud800', absent: undefined };
  const value = message({ first: shared, second: shared, array: [undefined, null, NaN, Infinity, -0] });
  const actual = encode(value);
  assert.equal(actual.toString('utf8'), sdk(value));
  assert.equal(actual.at(-1), 10);
  assert.deepEqual(JSON.parse(actual.toString()), JSON.parse(sdk(value)));
});

test('F15 byte budget includes echoed ID and the final newline at the exact boundary', () => {
  const value = message({ text: 'owned body' });
  const length = Buffer.byteLength(sdk(value));
  assert.equal(encode(value, { bytes: length }).length, length);
  safeFailure(() => encode(value, { bytes: length - 1 }), 'STDIO_RESPONSE_TOO_LARGE');
  safeFailure(() => encode({ ...value, id: 'x'.repeat(1024) }, { bytes: 256 }), 'STDIO_RESPONSE_TOO_LARGE');
});

test('F15 codec bounds nesting and traversal without executing custom serialization', () => {
  safeFailure(() => encode(message({ a: { b: { c: 1 } } }), { depth: 3 }), 'STDIO_ENCODING_FAILED');
  safeFailure(() => encode(message({ a: 1, b: 2, c: 3 }), { nodes: 3 }), 'STDIO_ENCODING_FAILED');
  let calls = 0;
  safeFailure(() => encode(message({ toJSON() { calls++; return {}; } })), 'STDIO_ENCODING_FAILED');
  assert.equal(calls, 0);
  const accessor = Object.defineProperty({}, 'text', { enumerable: true, get() { calls++; return 'owned'; } });
  safeFailure(() => encode(message(accessor)), 'STDIO_ENCODING_FAILED');
  assert.equal(calls, 0);
});

test('F15 cycle, bigint and unsupported values fail with fixed input-free diagnostics', () => {
  const cycle: Record<string, unknown> = { text: 'synthetic-do-not-project' };
  cycle.loop = cycle;
  for (const value of [cycle, { number: 1n }, { fn: () => 'synthetic-do-not-project' }]) {
    safeFailure(() => encode(message(value)), 'STDIO_ENCODING_FAILED');
  }
});

test('F15 a complete accepted-input-sized frame can exceed 16 MiB but fit the approved 64 MiB policy', () => {
  const id = 'x'.repeat(9 * 1024 * 1024);
  const result = { ok: true, state: 'listed', name: '"'.repeat(2 * 1024 * 1024 - 512) };
  const value = { jsonrpc: '2.0', id, result: {
    content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result
  } };
  const frame = encode(value);
  assert.ok(frame.length > 16 * 1024 * 1024);
  assert.ok(frame.length < 64 * 1024 * 1024);
  assert.equal(frame.length, Buffer.byteLength(sdk(value)));
  safeFailure(() => encode(value, { bytes: 16 * 1024 * 1024 }), 'STDIO_RESPONSE_TOO_LARGE');
});
