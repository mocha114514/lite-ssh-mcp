import { test } from 'node:test';
import { fixtureRoot } from './helpers/workspace.js';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Client, ClientChannel } from 'ssh2';
import type { ConnectionLease, InputAction, TerminalIdentity, TerminalTarget } from '../src/core/types.js';
import { LiteSshError } from '../src/core/errors.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { createShellMarkers } from './helpers/shell-markers.js';
import { TerminalSession } from '../src/terminal/session.js';
import { ScreenModel } from '../src/terminal/screen.js';
import { SerialQueue } from '../src/core/async.js';
import { createApplication } from '../src/app.js';
import { startMockSsh } from './helpers/mock-ssh.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import type { TransferManager } from '../src/sftp/manager.js';
import type { ConfigStore } from '../src/config/store.js';
import type { ConnectionPool } from '../src/ssh/pool.js';
import type { TerminalService } from '../src/terminal/service.js';

class RejectingProbeChannel extends PassThrough {
  readonly stderr = new PassThrough();
  // Deliberate local write failure: no packet reaches a real or simulated remote.
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(new Error('fixture_write_failed')); }
  close(): void { this.end(); this.stderr.end(); this.emit('close'); }
}

test('failed initialization sends do not leave unhandled marker rejections', { timeout: 5000 }, async () => {
  const channel = new RejectingProbeChannel();
  let released = 0;
  const client = { shell: (_window: unknown, callback: (error: null, stream: ClientChannel) => void) => callback(null, channel as unknown as ClientChannel) } as unknown as Client;
  const lease: ConnectionLease = { client, target: { ip: '127.0.0.1', port: 2222, username: 'test' }, release: async () => { released++; } };
  await assert.rejects(TerminalSession.open(lease, { ...lease.target, codename: 'failed_probe' }, { cacheRoot: fixtureRoot('session-failure'), initializationTimeoutMs: 80 }));
  await new Promise<void>(resolve => setTimeout(resolve, 120));
  assert.equal(released, 1);
  // node:test itself treats any leaked unhandled rejection as a failing test.
});

// Windows fixture setup/cleanup includes native permission-helper startup.
// This outer harness budget does not change the 180ms PTY deadline, the 450ms
// late callback, or any channel/ownership assertion inside the test.
const latePtyFixtureTimeoutMs = process.platform === 'win32' ? 30_000 : 10_000;

test('a late PTY callback is closed while a different shared-connection terminal stays alive', {
  timeout: latePtyFixtureTimeoutMs,
}, async () => {
  const ssh = await startMockSsh({ lateSecondShellMs: 450 });
  const root = fixtureRoot('session-late', `${process.pid}-${Date.now()}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const configPath = join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 2, servers: { [ssh.ip]: { [ssh.port]: {
    hostKeyFingerprint: ssh.fingerprint,
    accounts: { [ssh.username]: { auth: { type: 'password', password: ssh.password } } }
  } } } }), { encoding: 'utf8', mode: 0o600 });
  const app = createApplication({ configPath, cacheRoot: join(root, 'cache'), initializationTimeoutMs: 180 });
  const login = { ip: ssh.ip, port: ssh.port, username: ssh.username };
  try {
    await app.terminals.open(login, 'kept_terminal');
    await assert.rejects(app.terminals.open(login, 'expired_open'), error => error instanceof LiteSshError && error.code === 'PTY_OPEN_TIMEOUT');
    assert.equal((app.terminals.list().terminals as unknown[]).length, 1);
    const deadline = Date.now() + 2500;
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    while (ssh.openChannels !== 1 && Date.now() < deadline) await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(ssh.openChannels, 1);
    assert.equal((await app.terminals.read({ ip: ssh.ip, port: ssh.port, codename: 'kept_terminal' })).state, 'open');
  } finally { await app.close(); await ssh.close(); }
});

/**
 * A fully scripted channel: writes are captured (never looped back), and test
 * code feeds remote bytes with `emit('data')` so marker/echo ordering is exact.
 * This is a local fake, not an SSH server: no key, config or remote is touched.
 */
class ScriptedChannel extends PassThrough {
  readonly stderr = new PassThrough();
  readonly outbound: string[] = [];
  private blocked = false;
  private held?: () => void;
  holdWrites(): void { this.blocked = true; }
  releaseWrites(): void { this.blocked = false; const held = this.held; this.held = undefined; held?.(); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outbound.push(chunk.toString('utf8'));
    if (this.blocked) this.held = () => callback(); else callback();
  }
  close(): void { this.releaseWrites(); this.end(); this.stderr.end(); this.emit('close'); }
}

/** A recorder over a fake file handle whose next writes can be held open. */
interface FlushGate {
  recorder: ReadableRecorder;
  /** Make every subsequent handle write wait until {@link release}. */
  hold(): void;
  release(): void;
  failWrites(): void;
  contents(): string;
  readonly handleClosed: boolean;
  readonly hasBlockedWrite: boolean;
}

async function gatedRecorder(identity: TerminalIdentity, path: string): Promise<FlushGate> {
  let gate: Promise<void> | undefined;
  let unblock: (() => void) | undefined;
  let failed = false;
  let closed = false;
  let entered = false;
  const written: string[] = [];
  // This isolated fixture supplies an exact owned deletion target; the fake
  // handle records parsed cache bytes in memory and never touches user files.
  await fs.writeFile(path, '', { flag: 'wx' });
  const handle = {
    stat: async () => fs.stat(path, { bigint: true }),
    write: async (buffer: Buffer, offset: number, length: number) => {
      if (gate) { entered = true; await gate; }
      if (failed) throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
      written.push(buffer.subarray(offset, offset + length).toString('utf8'));
      return { bytesWritten: length, buffer };
    },
    close: async () => { closed = true; },
  } as unknown as FileHandle;
  const recorder = await ReadableRecorder.createWithHandle(handle, path, identity);
  return {
    recorder,
    hold(): void { entered = false; gate = new Promise<void>(resolve => { unblock = resolve; }); },
    release(): void { const resolve = unblock; gate = undefined; unblock = undefined; resolve?.(); },
    failWrites(): void { failed = true; },
    contents(): string { return written.join(''); },
    get handleClosed(): boolean { return closed; },
    get hasBlockedWrite(): boolean { return entered; },
  };
}

function feed(channel: ScriptedChannel, data: string): void {
  channel.emit('data', Buffer.from(data, 'utf8'));
}

/** Private OSC payload with the session's own nonce, exactly as the shell emits it. */
function marker(nonce: string, payload: string): string {
  return encodeMarkerOsc(nonce, payload);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Poll `read()` until it matches, so a marker/frame is guaranteed processed. */
async function waitForRead(
  session: TerminalSession,
  predicate: (snapshot: Record<string, unknown>) => boolean,
  label: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await session.read();
    if (predicate(snapshot)) return snapshot;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/**
 * Open a real session over a scripted channel and complete the shell handshake
 * by hand. The recorder is the controlled fake so cache-flush timing is exact.
 */
async function scriptedSession(tag: string, writeWaitMs = 320): Promise<{
  session: TerminalSession;
  channel: ScriptedChannel;
  nonce: string;
  flush: FlushGate;
  markers: ReturnType<typeof createShellMarkers>;
  marker: (payloadOrNonce: string, maybePayload?: string) => string;
}> {
  const channel = new ScriptedChannel();
  const identity: TerminalIdentity = { ip: '127.0.0.1', port: 22, username: 'scripted', codename: tag };
  const lease: ConnectionLease = {
    client: { shell: (_window: unknown, callback: (error: null, stream: unknown) => void) => callback(null, channel) } as unknown as Client,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };
  const root = fixtureRoot('session', `submission-${tag}-${process.pid}-${Date.now()}`);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const flush = await gatedRecorder(identity, join(root, 'cache.log'));
  const opened = TerminalSession.open(lease, identity, { initializationTimeoutMs: 4000, writeWaitMs, recorder: flush.recorder });
  await waitFor(() => /LSSH;([A-Za-z0-9_.-]+);STTY/.test(channel.outbound.join('')), 'the shell probe');
  const nonce = /LSSH;([A-Za-z0-9_.-]+);STTY/.exec(channel.outbound.join(''))![1]!;
  const markers = createShellMarkers(nonce, 1);
  const marker = (payloadOrNonce: string, maybePayload?: string): string => {
    // Preserve explicit foreign/malformed wire fixtures, never silently replace
    // a caller-supplied different nonce with this session's authenticated one.
    if (maybePayload !== undefined && payloadOrNonce !== nonce) {
      return encodeMarkerOsc(payloadOrNonce, maybePayload);
    }
    return markers.marker(maybePayload ?? payloadOrNonce);
  };
  feed(channel, `${marker('STTY;0:0:0:0')}${marker('PROBE;bash')}`);
  await waitFor(() => channel.outbound.join('').includes('__lssh_'), 'the shell bootstrap');
  feed(channel, marker('READY;bash'));
  return { session: await opened, channel, nonce, flush, markers, marker };
}

test('a prompt END observed while the pre-send flush is pending cannot consume the new submission', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('presend');
  try {
    // Hold the cache flush open, then start a submission and deliver the earlier
    // prompt's END while the flush is still pending. Only the private candidate
    // may exist at that moment; the submission's own round is opened after.
    flush.hold();
    const pending = session.write([{ type: 'text', text: 'syntax error' }, { type: 'key', key: 'RETURN' }]);
    feed(channel, `${marker(nonce, 'END;130')}stale$ `);
    await waitFor(() => session.screen.snapshot().lines.some(line => line.includes('stale$')), 'the stale prompt frame');
    flush.release();
    await waitFor(() => channel.outbound.join('').includes('syntax error'), 'the submitted packet handoff');
    // The real answer to the submitted line: echo plus a parse error plus END(2)
    // and no BEGIN, because the parser rejected the line before execution.
    feed(channel, 'syntax error\r\n');
    feed(channel, 'bash: syntax error\r\n');
    feed(channel, marker(nonce, 'END;2'));
    const result = await pending;
    assert.equal(result.state, 'shell_input_finished');
    assert.equal(result.exitCode, 2, 'the previous prompt exit code must not leak into this submission');
    assert.equal(result.commandStarted, false);
    assert.ok(String(result.output).includes('syntax error'), 'the parse error must be cached in the submission round');
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('R02 the real round preview does not omit 501 characters after cursor-only CSI', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r02-preview');
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_preview_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_preview_command\r'), 'preview handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'x'.repeat(501) + '\x1b[1C\r\n' + marker(nonce, 'END;0'));
    const result = await outcome;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.outputOmitted, false);
    assert.equal(result.output, 'x'.repeat(501) + '\n');
    assert.equal(result.outputCharacters, 502);
  } finally { await session.close(); }
});

test('R02 a no-op character erase cannot force a 501-character real preview to be omitted', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r02-preview-padding');
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_padding_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_padding_command\r'), 'padding preview handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'x'.repeat(501) + '\x1b[X\r\n' + marker(nonce, 'END;0'));
    const result = await outcome;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.outputOmitted, false);
    assert.equal(result.outputCharacters, 502);
    assert.equal(result.output, 'x'.repeat(501) + '\n');
  } finally { await session.close(); }
});

test('R03 pre-CR text followed only by RIS cannot omit a genuine 501-character preview', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r03-ris-cr-preview');
  try {
    const outcome = session.write([{ type: 'text', text: 'r03_ris_cr' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r03_ris_cr\r'), 'RIS CR handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'x'.repeat(501) + '\r\x1bc' + marker(nonce, 'END;0'));
    const result = await outcome;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.outputCharacters, 501);
    assert.equal(result.outputOmitted, false);
    assert.equal(result.output, 'x'.repeat(501));
  } finally { await session.close(); }
});

test('R03 RIS replacement preserves the real 1003-character preview omission boundary', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r03-ris-preview');
  try {
    const outcome = session.write([{ type: 'text', text: 'r03_ris_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r03_ris_command\r'), 'RIS preview handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'x'.repeat(501) + '\x1b[1C\x1bc' + 'x'.repeat(501) + '\r\n' + marker(nonce, 'END;0'));
    const result = await outcome;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.outputCharacters, 1003);
    assert.equal(result.outputOmitted, true);
  } finally { await session.close(); }
});

test('R03 cancelled post-observation drains retain a bounded whole-input-work credit', { timeout: 10_000 }, async () => {
  const { session, channel } = await scriptedSession('r03-post-observation', 12);
  const originalWrite = ScreenModel.prototype.write;
  const originalDrain = SerialQueue.prototype.drain;
  let releaseParser!: () => void;
  const parserGate = new Promise<void>(resolve => { releaseParser = resolve; });
  let parserEntered = false;
  let drainEntries = 0;
  const settled = new Map<number, { code?: string }>();
  const promises: Promise<unknown>[] = [];
  // Both gates intercept public methods in this owned test process, not
  // private Session fields. The cache remains healthy throughout the test.
  ScreenModel.prototype.write = async function(data) {
    if (Buffer.from(data).toString('utf8') === 'R03_GATED_OUTPUT') { parserEntered = true; await parserGate; }
    return originalWrite.call(this, data);
  };
  SerialQueue.prototype.drain = async function() { drainEntries++; await originalDrain.call(this); };
  try {
    feed(channel, 'R03_GATED_OUTPUT');
    await waitFor(() => parserEntered, 'parser gate');
    const before = channel.outbound.length;
    for (let i = 0; i < 80; i++) {
      const controller = new AbortController();
      const previous = drainEntries;
      const promise = session.write([{ type: 'text', text: '.' }], controller.signal).then(
        result => { settled.set(i, {}); return result; },
        error => { settled.set(i, { code: (error as LiteSshError).code }); return error; });
      promises.push(promise);
      // Exact drain entry proves that observation has already resolved. An
      // abort here cannot retroactively win that earlier observation promise.
      await waitFor(() => drainEntries > previous || settled.has(i), 'post-observation drain or bounded rejection');
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(channel.outbound.length - before, 64);
    assert.equal(promises.length - settled.size, 64);
    assert.equal([...settled.values()].filter(value => value.code === 'RESOURCE_LIMIT').length, 16);
    releaseParser();
    await Promise.all(promises);
    const fresh = await session.write([{ type: 'text', text: 'fresh' }]);
    assert.equal(fresh.inputSent, true);
    assert.equal(fresh.code, undefined, 'whole-work credits are reusable only after real settlement');
  } finally {
    releaseParser();
    await Promise.all(promises);
    ScreenModel.prototype.write = originalWrite;
    SerialQueue.prototype.drain = originalDrain;
    await session.close();
  }
});

test('R02 natural EOF drains every slice of one already-accepted output chunk', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('r02-eof');
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_eof_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_eof_command\r'), 'EOF handoff');
    flush.hold();
    const payload = marker(nonce, 'BEGIN') + Array.from({ length: 1200 }, (_, i) => `R02_EOF_ROW_${String(i + 1).padStart(4, '0')}\r\n`).join('') + 'R02_EOF_TAIL\r\n';
    assert.ok(Buffer.byteLength(payload) < 32768, 'one realistic-sized, known accepted packet');
    feed(channel, payload);
    await waitFor(() => session.screen.snapshot().lines.some(line => line.includes('R02_EOF_ROW_')), 'first parsed slice before gated flush');
    channel.emit('end'); channel.stderr.emit('end'); channel.emit('close');
    await assert.rejects(session.write([{ type: 'text', text: 'never_after_eof' }]), error => error instanceof LiteSshError && error.code === 'TERMINAL_EXITED');
    flush.release();
    const result = await outcome;
    const current = await session.read();
    const body = flush.contents().split('\n').filter(line => /^\| R02_EOF_ROW_\d{4}$/.test(line));
    assert.equal(body.length, 1200);
    assert.ok(flush.contents().split('\n').includes('| R02_EOF_TAIL'));
    assert.equal(result.code, 'TERMINAL_EXITED');
    assert.equal(result.inputSent, true);
    assert.equal(current.lastCompletedRound, null, 'EOF is not a fabricated END');
    assert.ok(!channel.outbound.join('').includes('never_after_eof'));
  } finally { flush.release(); await session.close(); }
});

test('R02 healthy stderr buffered at EOF drains and retains its real END fact', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('r02-eof-stderr');
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_stderr_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_stderr_command\r'), 'stderr handoff');
    flush.hold();
    feed(channel, marker(nonce, 'BEGIN') + 'S'.repeat(8000) + '\r\n');
    await waitFor(() => session.screen.snapshot().lines.some(line => line.includes('SSSS')), 'stdout parsing before EOF');
    // Not an emitted data event: these readable bytes remain buffered while
    // attach() has paused stderr. Only healthy receive-side resumption delivers them.
    channel.stderr.push(Buffer.from('R02_BUFFERED_STDERR\r\n' + marker(nonce, 'END;23')));
    channel.stderr.push(null);
    channel.emit('end'); channel.emit('close');
    flush.release();
    await outcome;
    const current = await waitForRead(session, value => (value.lastCompletedRound as { exitCode?: number } | null)?.exitCode === 23, 'actual stderr END');
    assert.equal(current.code, 'TERMINAL_EXITED');
    assert.equal(current.currentRound, null);
    assert.ok(flush.contents().split('\n').includes('| R02_BUFFERED_STDERR'));
  } finally { flush.release(); await session.close(); }
});

test('R02 recording EIO after EOF stops queued parsing and exposes the actual loss reason', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('r02-eof-eio');
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_eof_eio_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_eof_eio_command\r'), 'EOF EIO handoff');
    flush.hold();
    feed(channel, marker(nonce, 'BEGIN') + 'P'.repeat(12000) + '\r\n');
    await waitFor(() => session.screen.snapshot().lines.some(line => line.includes('PPPP')), 'first slice before EIO');
    channel.stderr.emit('data', Buffer.from('NEVER_PARSE_AFTER_EIO\r\n' + marker(nonce, 'END;0')));
    channel.emit('end'); channel.stderr.emit('end'); channel.emit('close');
    flush.failWrites(); flush.release();
    const result = await outcome;
    await assert.rejects(session.read(), error => error instanceof LiteSshError && error.code === 'CACHE_WRITE_FAILED' && error.details.reason === 'EIO');
    assert.equal(result.code, 'TERMINAL_EXITED', 'preserve the factual sticky transport fault');
    assert.equal(result.recordingErrorCode, 'CACHE_WRITE_FAILED');
    assert.equal(result.reason, 'EIO');
    assert.ok(Number(result.droppedChunks) > 0 && Number(result.droppedBytes) > 0);
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.equal(result.lastCompletedRound, null);
    assert.ok(!(result.screen as { lines: string[] }).lines.some(line => line.includes('NEVER_PARSE_AFTER_EIO')));
    assert.ok(!flush.contents().includes('NEVER_PARSE_AFTER_EIO'));
  } finally { flush.release(); await session.close(); }
});

test('R02 cancellation during pre-send flush never becomes a late native handoff', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('r02-cancel-unsent');
  const controller = new AbortController();
  try {
    flush.hold();
    const outcome = session.write([{ type: 'text', text: 'r02_cancel_unsent' }, { type: 'key', key: 'ENTER' }], controller.signal).catch(error => error);
    await waitFor(() => flush.hasBlockedWrite, 'pre-handoff cache flush');
    controller.abort(); flush.release();
    const error: unknown = await outcome;
    assert.ok(error instanceof LiteSshError && error.code === 'REQUEST_CANCELLED');
    assert.equal(error.details.inputSent, false);
    assert.ok(!channel.outbound.join('').includes('r02_cancel_unsent'));
    assert.equal((await session.read()).currentRound, null);
    const next = session.write([{ type: 'text', text: 'r02_after_unsent' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_after_unsent\r'), 'new clean handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'OK\r\n' + marker(nonce, 'END;0'));
    assert.equal((await next).state, 'command_completed');
  } finally { controller.abort(); flush.release(); await session.close(); }
});

test('R02 cancelling an already-sent observer preserves later factual shell rounds', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r02-cancel-facts');
  const controller = new AbortController();
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_cancel_sent' }, { type: 'key', key: 'ENTER' }], controller.signal);
    await waitFor(() => channel.outbound.includes('r02_cancel_sent\r'), 'cancelled actual handoff');
    controller.abort();
    const result = await outcome;
    assert.equal(result.observationCancelled, true);
    assert.equal(result.inputSent, true);
    assert.equal(result.inputHandled, 'unknown');
    assert.equal(session.status, 'open');
    feed(channel, marker(nonce, 'BEGIN') + 'R02_FACT_AFTER_CANCEL\r\n' + marker(nonce, 'END;9'));
    const current = await waitForRead(session, value => (value.lastCompletedRound as { exitCode?: number } | null)?.exitCode === 9, 'factual round after cancellation');
    assert.equal(current.currentRound, null);
    assert.equal(channel.outbound.filter(packet => packet === 'r02_cancel_sent\r').length, 1);
    assert.ok(!channel.outbound.some(packet => packet.includes('\x03')));
  } finally { controller.abort(); await session.close(); }
});

test('R02 cancellation racing owned close does not report an open pending terminal', { timeout: 10_000 }, async () => {
  const { session, channel } = await scriptedSession('r02-cancel-close');
  const controller = new AbortController();
  let closing: Promise<Record<string, unknown>> | undefined;
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_cancel_close' }], controller.signal);
    await waitFor(() => channel.outbound.includes('r02_cancel_close'), 'close-race handoff');
    controller.abort(); closing = session.close();
    const result = await outcome;
    assert.ok(result.state === 'closing' || result.state === 'closed');
    assert.equal(result.inputSent, true);
    assert.equal((await closing).cacheRemoved, true);
    assert.equal((await session.read()).state, 'closed');
  } finally { controller.abort(); await closing; await session.close(); }
});

test('R02 cancelled queued handoffs remain bounded behind a blocked cache flush', { timeout: 10_000 }, async () => {
  const { session, channel, flush } = await scriptedSession('r02-cancel-queue', 30_000);
  const controllers: AbortController[] = [];
  const calls: Promise<unknown>[] = [];
  let rejected = 0;
  try {
    flush.hold();
    const head = new AbortController(); controllers.push(head);
    calls.push(session.write([{ type: 'text', text: 'r02_blocked_head' }, { type: 'key', key: 'ENTER' }], head.signal).catch(error => error));
    await waitFor(() => flush.hasBlockedWrite, 'blocked head handoff');
    // Eighty tiny owned requests suffice to prove the bound without allocating
    // huge payloads or intentionally exhausting the machine's memory.
    for (let i = 0; i < 80; i++) {
      const controller = new AbortController(); controllers.push(controller);
      calls.push(session.write([{ type: 'text', text: `r02_queued_cancel_${i}` }], controller.signal).catch(error => {
        if (error instanceof LiteSshError && error.code === 'RESOURCE_LIMIT') rejected++;
        return error;
      }));
      controller.abort();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(rejected, 17, 'one blocked head plus 63 retained tasks fill the separate 64-handoff bound');
    assert.ok(!channel.outbound.join('').includes('r02_queued_cancel_'));
  } finally {
    controllers.forEach(controller => controller.abort()); flush.release();
    await Promise.all(calls); await session.close();
  }
});

test('R02 public diagnostic details cannot replace authoritative terminal or handoff fields', { timeout: 10_000 }, async t => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('r02-detail-authority');
  try {
    const outcome = session.write([{ type: 'text', text: 'r02_detail_command' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.includes('r02_detail_command\r'), 'diagnostic handoff');
    t.mock.method(flush.recorder, 'recordLine', () => {
      throw new LiteSshError('CACHE_WRITE_FAILED', 'Controlled public recording failure.', {
        reason: 'EIO', droppedChunks: 2, droppedBytes: 17,
        ok: true, state: 'open', code: 'FOREIGN', message: 'foreign message',
        terminal: { codename: 'foreign' }, cachePath: 'foreign-path',
        inputSent: false, inputHandled: 'foreign', cacheMayBeIncomplete: false,
      });
    });
    feed(channel, marker(nonce, 'BEGIN') + 'diagnostic body\r\n');
    const result = await outcome;
    assert.equal(result.reason, 'EIO');
    assert.equal(result.droppedChunks, 2); assert.equal(result.droppedBytes, 17);
    assert.equal(result.ok, false); assert.equal(result.state, 'error');
    assert.equal(result.code, 'CACHE_WRITE_FAILED');
    assert.equal(result.message, 'Controlled public recording failure.');
    assert.deepEqual(result.terminal, session.identity);
    assert.equal(result.cachePath, session.recorder.path);
    assert.equal(result.inputSent, true); assert.equal(result.inputHandled, 'unknown');
    assert.equal(result.cacheMayBeIncomplete, true);
  } finally { t.mock.restoreAll(); await session.close(); }
});

test('R02 genuine SDK cancellations free observer quota without double release or remote controls', { timeout: 15_000 }, async () => {
  const { session, channel } = await scriptedSession('r02_sdk_cancel', 30_000);
  const client = new McpClient({ name: 'r02-cancel-regression', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const signals: AbortSignal[] = [];
  const terminals = { write: (_target: TerminalTarget, actions: InputAction[], signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return session.write(actions, signal);
  } } as unknown as TerminalService;
  const server = createMcpServer({} as ConfigStore, {} as ConnectionPool, terminals, {} as TransferManager);
  const controllers: AbortController[] = [];
  const calls: Promise<unknown>[] = [];
  const target = { ip: '127.0.0.1', port: 22, codename: 'r02_sdk_cancel' };
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    for (let i = 0; i < 64; i++) {
      const controller = new AbortController(); controllers.push(controller);
      calls.push(client.callTool({ name: 'lite_ssh_terminal_write', arguments: { ...target, actions: [{ type: 'text', text: `r02_cancel_${i}` }] } }, undefined, { signal: controller.signal }).catch(error => error));
    }
    await waitFor(() => channel.outbound.filter(packet => /^r02_cancel_\d+$/.test(packet)).length === 64, '64 actual SDK handoffs');
    controllers.forEach(controller => controller.abort()); await Promise.all(calls);
    await waitFor(() => signals.length === 64 && signals.every(signal => signal.aborted), '64 SDK server-side abort signals');
    // Refill every slot: a later 65th rejection proves cancel/finally did not
    // decrement twice and silently allow a negative observer count.
    for (let i = 0; i < 64; i++) {
      const controller = new AbortController(); controllers.push(controller);
      calls.push(client.callTool({ name: 'lite_ssh_terminal_write', arguments: { ...target, actions: [{ type: 'text', text: `r02_refill_${i}` }] } }, undefined, { signal: controller.signal }).catch(error => error));
    }
    await waitFor(() => channel.outbound.filter(packet => /^r02_refill_\d+$/.test(packet)).length === 64, '64 fresh admissions after cancellations');
    const overflow = await client.callTool({ name: 'lite_ssh_terminal_write', arguments: { ...target, actions: [{ type: 'text', text: 'r02_must_reject_65' }] } });
    assert.equal((overflow.structuredContent as Record<string, unknown>).code, 'RESOURCE_LIMIT');
    assert.ok(!channel.outbound.includes('r02_must_reject_65'));
    assert.ok(!channel.outbound.some(packet => packet.includes('\x03')));
    assert.equal(session.status, 'open');
  } finally {
    controllers.forEach(controller => controller.abort()); await Promise.all(calls);
    await session.close(); await client.close(); await server.close();
  }
});

test('two overlapping submissions get one cycle each, the later one END-only', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('overlap');
  try {
    const first = session.write([{ type: 'text', text: 'emit small' }, { type: 'key', key: 'RETURN' }]);
    await waitFor(() => channel.outbound.join('').includes('emit small'), 'the first packet');
    // The second line is handed off before the first can start a foreground
    // command, so both are real shell input cycles and both must be reported.
    const second = session.write([{ type: 'text', text: 'syntax error' }, { type: 'key', key: 'RETURN' }]);
    await waitFor(() => channel.outbound.join('').includes('syntax error'), 'the second packet');
    feed(channel, 'emit small\r\n');
    feed(channel, marker(nonce, 'BEGIN'));
    feed(channel, 'short readable output\r\n');
    feed(channel, marker(nonce, 'END;0'));
    feed(channel, 'syntax error\r\n');
    feed(channel, 'bash: syntax error\r\n');
    feed(channel, marker(nonce, 'END;2'));
    const firstResult = await first;
    const secondResult = await second;
    assert.equal(secondResult.state, 'shell_input_finished');
    assert.equal(secondResult.exitCode, 2);
    assert.equal(secondResult.commandStarted, false);
    assert.ok(String(secondResult.output).includes('syntax error'));
    assert.equal(firstResult.state, 'command_completed', 'the first completion must survive the later END');
    assert.equal(firstResult.round, 'R1');
    assert.equal(firstResult.exitCode, 0);
    assert.ok(String(firstResult.output).includes('short readable output'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('an END-only cycle is a factual completion even when no writer owns it', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('endonly');
  try {
    // R1: a real foreground command that never reads its stdin.
    const running = session.write([{ type: 'text', text: 'sleep' }, { type: 'key', key: 'RETURN' }]);
    await waitFor(() => channel.outbound.join('').includes('sleep'), 'the sleep packet');
    feed(channel, marker(nonce, 'BEGIN'));
    await waitForRead(session, snapshot => snapshot.currentRound === 'R1', 'the running round R1');
    // `)` Enter is queued while R1 runs, so it is deliberately NOT credited as a
    // new shell submission: the foreground program, not the shell, reads stdin.
    const mark = channel.outbound.length;
    const queued = session.write([{ type: 'text', text: ')' }, { type: 'key', key: 'RETURN' }]);
    await waitFor(() => channel.outbound.slice(mark).join('').includes(')'), 'the queued packet');
    // R1 finishes, then the queued line is rejected by the parser with a real
    // non-zero status and, as a syntax error, no BEGIN.
    feed(channel, marker(nonce, 'END;0'));
    feed(channel, ')\r\n');
    feed(channel, 'bash: syntax error near unexpected token\r\n');
    feed(channel, marker(nonce, 'END;2'));
    const queuedReply = await queued;
    assert.equal(queuedReply.inputHandled, 'unknown', 'no keypress-handled guarantee for a queued write');
    assert.notEqual(queuedReply.state, 'command_completed');
    assert.notEqual(queuedReply.state, 'shell_input_finished');
    const final = await waitForRead(
      session,
      snapshot => snapshot.currentRound === null && (snapshot.lastCompletedRound as Record<string, unknown> | null)?.round === 'R2',
      'the factual R2 completion',
    );
    assert.equal(final.currentRound, null, 'a private candidate must never become currentRound');
    const last = final.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.round, 'R2');
    assert.equal(last.exitCode, 2, 'the END-only read must reflect R2, not a stale R1/0');
    assert.equal(last.commandStarted, false, 'a non-executed END is never an execution claim');
    assert.ok(String(last.output).includes('syntax error'), 'the parser diagnostic stays readable');
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('a mode change during the pre-send flush is honoured at the actual handoff', { timeout: 10_000 }, async () => {
  const { session, channel, flush } = await scriptedSession('modechange');
  try {
    // Enable bracketed paste on the remote, then park real recorder data behind
    // the gate so the write's pre-send flush genuinely blocks.
    feed(channel, '\x1b[?2004h');
    await waitFor(() => session.screen.snapshot().modes.bracketedPaste, 'bracketed paste on');
    flush.hold();
    feed(channel, 'parked output\r\n');
    await waitFor(() => session.screen.snapshot().lines.some(line => line.includes('parked output')), 'the parked frame');
    const mark = channel.outbound.length;
    const pending = session.write([{ type: 'paste', text: 'a\nb' }]);
    const outcome = pending.then(() => 'sent' as const, error => error as unknown);
    // Flip the mode directly on the model while the write's flush is blocked:
    // this is exactly the remote disabling bracketed paste mid-flush.
    await session.screen.write('\x1b[?2004l');
    assert.equal(session.screen.snapshot().modes.bracketedPaste, false, 'mode change applied');
    flush.release();
    const error = await outcome;
    assert.ok(error instanceof LiteSshError && error.code === 'PASTE_UNSUPPORTED', 'a paste whose mode was lost must be rejected, not sent');
    assert.equal(channel.outbound.slice(mark).join('').includes('\x1b[200~'), false, 'no stale bracketed paste may reach the shell');
  } finally {
    await session.close().catch(() => undefined);
  }
});


// ROUND01 fault regressions use only scripted channels and owned local fixtures.
test('R01 multiline shell input publishes only actual marked cycles, not every Enter', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r01-multiline');
  try {
    const resultPromise = session.write([
      { type: 'text', text: 'for x in 1; do' }, { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'printf loop' }, { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'done' }, { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('done'), 'the multiline packet');
    feed(channel, 'for x in 1; do\r\n> printf loop\r\n> done\r\n' + marker(nonce, 'BEGIN') + 'loop\r\n' + marker(nonce, 'END;0'));
    const result = await resultPromise;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.round, 'R1');
    assert.equal((await session.read()).currentRound, null, 'no phantom successor may be published');
    const next = session.write([{ type: 'text', text: 'next-one' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('next-one'), 'the next packet');
    feed(channel, marker(nonce, 'BEGIN') + 'next output\r\n' + marker(nonce, 'END;0'));
    const nextResult = await next;
    if (nextResult.state === 'command_completed') assert.equal(nextResult.round, 'R2');
    else assert.equal(nextResult.inputHandled, 'unknown', 'a prior multi-submit packet is not an all-keys ACK');
    assert.equal(((await session.read()).lastCompletedRound as Record<string, unknown>).round, 'R2');
  } finally { channel.releaseWrites(); await session.close().catch(() => undefined); }
});

test('R01 an earlier owner completes while a later marked command is still running', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r01-owner-running');
  let later: Promise<Record<string, unknown>> | undefined;
  try {
    const first = session.write([{ type: 'text', text: 'first-owned' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('first-owned'), 'first handoff');
    later = session.write([{ type: 'text', text: 'later-owned' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('later-owned'), 'later handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'first output\r\n' + marker(nonce, 'END;0') + marker(nonce, 'BEGIN'));
    const result = await first;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.round, 'R1');
    assert.equal(result.exitCode, 0);
    assert.equal((await session.read()).currentRound, 'R2');
  } finally {
    feed(channel, 'later output\r\n' + marker(nonce, 'END;2'));
    await later?.catch(() => undefined);
    await session.close().catch(() => undefined);
  }
});

test('R01 SSH backpressure does not bypass the tool observation deadline', { timeout: 10_000 }, async () => {
  const { session, channel } = await scriptedSession('r01-send-deadline');
  let pending: Promise<Record<string, unknown>> | undefined;
  try {
    channel.holdWrites();
    pending = session.write([{ type: 'text', text: 'held-deadline' }, { type: 'key', key: 'ENTER' }]);
    void pending.catch(() => undefined);
    await waitFor(() => channel.outbound.join('').includes('held-deadline'), 'held native write');
    const result = await Promise.race([pending, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1000))]);
    assert.ok(result, 'the native callback must not keep the tool pending forever');
    assert.equal(result.state, 'pending');
    assert.equal(result.inputSent, true);
    assert.equal(result.inputHandled, 'unknown');
  } finally { channel.releaseWrites(); await pending?.catch(() => undefined); await session.close().catch(() => undefined); }
});

test('R01 close interrupts a backpressured send and returns owned cleanup facts', { timeout: 10_000 }, async () => {
  const { session, channel, flush } = await scriptedSession('r01-send-close');
  let pending: Promise<Record<string, unknown>> | undefined;
  let closing: Promise<Record<string, unknown>> | undefined;
  try {
    channel.holdWrites();
    pending = session.write([{ type: 'text', text: 'held-close' }, { type: 'key', key: 'ENTER' }]);
    void pending.catch(() => undefined);
    await waitFor(() => channel.outbound.join('').includes('held-close'), 'held native write');
    closing = session.close();
    // ACL-backed removal has real platform I/O cost. Keep a finite window
    // while the write callback remains permanently held; this still proves
    // that close is independent of backpressured input, not instantaneous.
    const result = await Promise.race([closing, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000))]);
    assert.ok(result, 'owned close must not sit behind a permanently retained write callback');
    assert.equal(result.cacheRemoved, true);
    assert.equal(flush.handleClosed, true);
    const writeResult = await pending;
    assert.equal(writeResult.inputSent, true);
    assert.equal(writeResult.state, 'closed');
  } finally { channel.releaseWrites(); await pending?.catch(() => undefined); await closing?.catch(() => undefined); await session.close().catch(() => undefined); }
});

test('R01 terminal-query replies share a bounded outgoing byte budget', { timeout: 10_000 }, async () => {
  const { session, channel } = await scriptedSession('r01-reply-budget');
  try {
    channel.holdWrites();
    feed(channel, '\x1b[5n'.repeat(70_000));
    const result = await session.read();
    assert.ok(channel.writableLength <= 256 * 1024, 'query responses must not accumulate unboundedly in ssh2');
    assert.equal(result.code, 'RESOURCE_LIMIT');
    assert.equal(result.cacheMayBeIncomplete, true);
  } finally { channel.releaseWrites(); await session.close().catch(() => undefined); }
});

test('R01 a cache EIO after handoff retains transmission and integrity context', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('r01-cache-context');
  try {
    const outcome = session.write([{ type: 'text', text: 'cache-failure-command' }, { type: 'key', key: 'ENTER' }])
      .catch((error): Record<string, unknown> => ({ thrown: error }));
    await waitFor(() => channel.outbound.join('').includes('cache-failure-command'), 'successful handoff');
    flush.failWrites();
    feed(channel, marker(nonce, 'BEGIN') + 'parsed output\r\n' + marker(nonce, 'END;0'));
    const result = await outcome;
    assert.equal(result.inputSent, true, 'do not replace a known handed-off packet with a generic error');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'CACHE_WRITE_FAILED');
    assert.equal(result.reason, 'EIO');
    assert.ok(Number(result.droppedChunks) > 0);
    assert.ok(Number(result.droppedBytes) > 0);
    assert.equal(result.inputHandled, 'unknown');
    assert.equal(result.cacheMayBeIncomplete, true);
    assert.ok(result.terminal);
    assert.equal(result.cachePath, session.recorder.path);
    assert.equal(channel.outbound.join('').split('cache-failure-command').length - 1, 1, 'no input replay');
  } finally { await session.close().catch(() => undefined); }
});


test('R01 an overlapping writer cannot claim the older batch\'s second actual round', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r01-mixed-batch');
  let batch: Promise<Record<string, unknown>> | undefined;
  try {
    batch = session.write([
      { type: 'text', text: 'batch-a1' }, { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'batch-a2' }, { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('batch-a2'), 'the older batch');
    const later = session.write([{ type: 'text', text: 'writer-b' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('writer-b'), 'the later writer');
    feed(channel,
      marker(nonce, 'BEGIN') + 'A1-only\r\n' + marker(nonce, 'END;3') +
      marker(nonce, 'BEGIN') + 'A2-only\r\n' + marker(nonce, 'END;7') +
      marker(nonce, 'BEGIN') + 'B-only\r\n' + marker(nonce, 'END;9'));
    const result = await later;
    if (result.state === 'command_completed') {
      assert.equal(result.round, 'R3', 'B must not inherit A2');
      assert.equal(result.exitCode, 9);
      assert.ok(String(result.output).includes('B-only'));
    } else {
      assert.equal(result.inputHandled, 'unknown', 'ambiguous ownership must stay explicitly unknown');
    }
    await batch;
    const factual = (await session.read()).lastCompletedRound as Record<string, unknown>;
    assert.equal(factual.round, 'R3');
    assert.equal(factual.exitCode, 9);
  } finally { await batch?.catch(() => undefined); await session.close().catch(() => undefined); }
});


test('R01 expiry of a batch observer cannot transfer its delayed second round to a new writer', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r01-expired-batch');
  try {
    const older = session.write([
      { type: 'text', text: 'delayed-a1' }, { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'delayed-a2' }, { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('delayed-a2'), 'the older packet');
    // A preserved prompt hook or delayed input delivery can postpone A2 beyond
    // this observer's deadline. Its expiry proves nothing about remaining keys.
    feed(channel, marker(nonce, 'BEGIN') + 'earlier A1\r\n' + marker(nonce, 'END;0'));
    await older;
    const later = session.write([{ type: 'text', text: 'delayed-b' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('delayed-b'), 'the new packet');
    feed(channel,
      marker(nonce, 'BEGIN') + 'older A2\r\n' + marker(nonce, 'END;7') +
      marker(nonce, 'BEGIN') + 'new B\r\n' + marker(nonce, 'END;9'));
    const result = await later;
    if (result.state === 'command_completed') {
      assert.equal(result.round, 'R3'); assert.equal(result.exitCode, 9);
    } else { assert.equal(result.inputHandled, 'unknown'); }
    assert.equal(((await session.read()).lastCompletedRound as Record<string, unknown>).round, 'R3');
  } finally { await session.close().catch(() => undefined); }
});


test('R01 a third overlapping packet cannot restore credit in an already ambiguous batch', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('r01-third-packet');
  let first: Promise<Record<string, unknown>> | undefined;
  let second: Promise<Record<string, unknown>> | undefined;
  try {
    first = session.write([
      { type: 'text', text: 'triple-a1' }, { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'triple-a2' }, { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('triple-a2'), 'A packet');
    second = session.write([{ type: 'text', text: 'triple-b' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('triple-b'), 'B packet');
    const third = session.write([{ type: 'text', text: 'triple-c' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('triple-c'), 'C packet');
    feed(channel,
      marker(nonce, 'BEGIN') + 'only A1\r\n' + marker(nonce, 'END;3') +
      marker(nonce, 'BEGIN') + 'only A2\r\n' + marker(nonce, 'END;7') +
      marker(nonce, 'BEGIN') + 'only B\r\n' + marker(nonce, 'END;9') +
      marker(nonce, 'BEGIN') + 'only C\r\n' + marker(nonce, 'END;11'));
    const result = await third;
    if (result.state === 'command_completed') {
      assert.equal(result.round, 'R4'); assert.equal(result.exitCode, 11);
    } else { assert.equal(result.inputHandled, 'unknown'); }
    await first; await second;
    assert.equal(((await session.read()).lastCompletedRound as Record<string, unknown>).round, 'R4');
  } finally { await first?.catch(() => undefined); await second?.catch(() => undefined); await session.close().catch(() => undefined); }
});

test('F03 hook health false reports SHELL_INTEGRATION_LOST without falseNoExec and self-heals after restoration', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f03-health');
  try {
    // 1. Hook is broken (e.g. PS0 overwritten), so command runs but BEGIN is not emitted.
    const compromised = session.write([{ type: 'text', text: 'audit_broken_cmd' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('audit_broken_cmd\r'), 'compromised handoff');
    // Output is produced, but END arrives with hookHealthy: false (parts[4] = 0) and no BEGIN
    feed(channel, 'real command output executed without begin\r\n' + marker(nonce, 'END;0;0'));
    const compResult = await compromised;
    // Must NOT declare commandStarted: false or shell_input_finished
    assert.notEqual(compResult.state, 'shell_input_finished');
    assert.equal(compResult.commandStarted, undefined);
    assert.equal(compResult.ok, false);
    assert.equal(compResult.state, 'error');
    assert.equal(compResult.code, 'SHELL_INTEGRATION_LOST');
    assert.equal(compResult.round, 'R1');
    assert.equal(compResult.exitCode, 0);
    assert.equal(compResult.commandStartUnknown, true);
    assert.ok(compResult.cacheRange);

    // Session remains open and observable (entrance not permanently sealed)
    assert.equal(session.status, 'open');
    const status = await session.read();
    assert.equal(status.state, 'open');
    assert.equal(status.ok, true);
    const last = status.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, undefined, 'must not falsely claim non-execution');
    assert.equal(last.commandStartUnknown, true, 'must carry narrow commandStartUnknown diagnostic');

    // 2. Recovery: Hook is restored, subsequent command executes with healthy BEGIN/END
    const recovered = session.write([{ type: 'text', text: 'audit_restored_cmd' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('audit_restored_cmd\r'), 'restored handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'restored output\r\n' + marker(nonce, 'END;0;1'));
    const recResult = await recovered;
    assert.equal(recResult.state, 'command_completed');
    assert.equal(recResult.exitCode, 0);
    assert.equal(recResult.commandStarted, true);
    assert.ok(String(recResult.output).includes('restored output'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F03 a healthy END after repairing the hook cannot erase known BEGIN loss', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush, marker } = await scriptedSession('f03-repair-boundary');
  try {
    // The command that disables the hook still had a real BEGIN. Its unhealthy
    // END must affect future boundaries without erasing this execution fact.
    const disabled = session.write([
      { type: 'text', text: 'disable_begin_hook' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('disable_begin_hook\r'), 'disable handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'hook disabled\r\n' + marker(nonce, 'END;0;0'));
    const disabledResult = await disabled;
    assert.equal(disabledResult.state, 'command_completed');
    assert.equal(disabledResult.commandStarted, true);

    // Repairing PS0 can execute without BEGIN yet restore health before END.
    // Health at END cannot prove that this already-executed command did not run.
    const repaired = session.write([
      { type: 'text', text: 'repair_begin_hook' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('repair_begin_hook\r'), 'repair handoff');
    feed(channel, 'repair command really executed\r\n' + marker(nonce, 'END;0;1'));
    const repairedResult = await repaired;
    assert.equal(repairedResult.state, 'error');
    assert.equal(repairedResult.code, 'SHELL_INTEGRATION_LOST');
    assert.equal(repairedResult.commandStarted, undefined);
    assert.equal(repairedResult.commandStartUnknown, true);
    assert.ok(String(repairedResult.output).includes('repair command really executed'));
    const repairedView = await session.read();
    const repairedRound = repairedView.lastCompletedRound as Record<string, unknown>;
    assert.equal(repairedRound.commandStarted, undefined);
    assert.equal(repairedRound.commandStartUnknown, true);

    // A second END-only cycle is still not a positive BEGIN observation.
    const unmarked = session.write([
      { type: 'text', text: 'still_without_begin' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('still_without_begin\r'), 'unmarked handoff');
    feed(channel, 'unmarked output\r\n' + marker(nonce, 'END;0;1'));
    const unmarkedResult = await unmarked;
    assert.equal(unmarkedResult.commandStartUnknown, true);
    assert.equal(unmarkedResult.commandStarted, undefined);

    // A real, valid BEGIN restores boundary trust, not merely a health flag.
    const trusted = session.write([
      { type: 'text', text: 'healthy_after_repair' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('healthy_after_repair\r'), 'healthy handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'healthy marked output\r\n' + marker(nonce, 'END;0;1'));
    const trustedResult = await trusted;
    assert.equal(trustedResult.state, 'command_completed');
    assert.equal(trustedResult.commandStarted, true);

    // Once BEGIN has been observed again, a genuine healthy syntax-error END
    // retains the original non-execution semantics instead of staying unknown.
    const syntax = session.write([
      { type: 'text', text: 'invalid_syntax' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('invalid_syntax\r'), 'syntax handoff');
    feed(channel, 'syntax diagnostics\r\n' + marker(nonce, 'END;2;1'));
    const syntaxResult = await syntax;
    assert.equal(syntaxResult.state, 'shell_input_finished');
    assert.equal(syntaxResult.commandStarted, false);
    assert.equal(syntaxResult.commandStartUnknown, undefined);
    assert.equal(syntaxResult.exitCode, 2);
    // This fixture's FileHandle collects the real serialized recorder writes
    // in memory; its owned on-disk file is only the safe deletion target.
    const cache = flush.contents();
    assert.match(cache, /\[ROUND R2 END\] exitCode=0 commandStartUnknown=true/);
    assert.match(cache, /\[ROUND R3 END\] exitCode=0 commandStartUnknown=true/);
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F03 an unhealthy END without a reserved cycle is remembered for later repair input', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f03-unowned-health');
  try {
    // No input has reserved a candidate yet. Put the visible witness AFTER END
    // so reading it proves this same packet's unhealthy marker was processed.
    feed(channel, marker(nonce, 'END;0;0') + 'unowned hook loss observed\r\n');
    const observed = await waitForRead(session, snapshot => {
      const screen = snapshot.screen as { lines: string[] };
      return screen.lines.some(line => line.includes('unowned hook loss observed'));
    }, 'unowned unhealthy END');
    assert.equal(observed.currentRound, null);
    assert.equal(observed.lastCompletedRound, null);

    const repaired = session.write([
      { type: 'text', text: 'repair_after_unowned_end' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('repair_after_unowned_end\r'), 'unowned repair handoff');
    feed(channel, 'unowned repair really executed\r\n' + marker(nonce, 'END;0;1'));
    const result = await repaired;
    assert.equal(result.state, 'error');
    assert.equal(result.code, 'SHELL_INTEGRATION_LOST');
    assert.equal(result.commandStartUnknown, true);
    assert.equal(result.commandStarted, undefined);
    assert.ok(String(result.output).includes('unowned repair really executed'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 bare Ctrl-C followed by Enter does not let late END130 claim new submission; factual command completes normally', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-ctrlc-enter');
  try {
    // 1. Bare Ctrl-C sent at prompt
    const ctrlC = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl-c handoff');
    await ctrlC;

    // 2. Subsequent command submitted before delayed prompt END arrives
    const pending = session.write([{ type: 'text', text: 'top' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('top\r'), 'top handoff');

    // 3. Delayed prompt END;130 from Ctrl-C arrives
    feed(channel, marker(nonce, 'END;130;1'));

    // Give a small tick: pending write must NOT claim this END;130
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    // 4. Authoritative BEGIN and END;0 for 'top' arrive
    feed(channel, marker(nonce, 'BEGIN') + 'top display body\r\n' + marker(nonce, 'END;0;1'));

    const result = await pending;
    assert.notEqual(result.exitCode, 130, 'write must not claim old interrupt END130');
    assert.equal(result.inputHandled, 'unknown', 'provenance barrier marks ambiguous submission unknown');

    // Factual execution is recorded cleanly
    const current = await session.read();
    const last = current.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, true);
    assert.equal(last.exitCode, 0);
    assert.ok(String(last.output).includes('top display body'));

    // 5. Subsequent command after barrier clearance safely re-establishes ownership
    const next = session.write([{ type: 'text', text: 'echo next' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('echo next\r'), 'next handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'next out\r\n' + marker(nonce, 'END;0;1'));

    const nextResult = await next;
    assert.equal(nextResult.state, 'command_completed');
    assert.equal(nextResult.exitCode, 0);
    assert.ok(String(nextResult.output).includes('next out'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 bare Ctrl-C followed by syntax error with single End-only remains unknown, subsequent command is unknown with factual round recorded', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-ambiguous-syntax', 150);
  try {
    // 1. Bare Ctrl-C
    const ctrlC = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl-c handoff');
    await ctrlC;

    // 2. Syntax error submission
    const syntaxErr = session.write([{ type: 'text', text: ')' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes(')\r'), 'syntax handoff');

    // 3. Only ONE End-only arrives (unable to distinguish old interrupt vs syntax error)
    feed(channel, marker(nonce, 'END;2;1'));

    const syntaxResult = await syntaxErr;
    assert.equal(syntaxResult.inputHandled, 'unknown', 'single End-only cannot be disambiguated, conservatively unknown');

    // 4. In ambiguous episode, nextCmd must not falsely claim command_completed, but factual execution is recorded
    const nextCmd = session.write([{ type: 'text', text: 'echo ok' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('echo ok\r'), 'nextCmd handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'ok\r\n' + marker(nonce, 'END;0;1'));

    const nextResult = await nextCmd;
    assert.equal(nextResult.inputHandled, 'unknown', 'ambiguous episode submission remains unknown');

    const current = await session.read();
    const last = current.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, true, 'factual execution must be recorded');
    assert.equal(last.exitCode, 0);
    assert.ok(String(last.output).includes('ok'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 Ctrl-C followed by syntax error A and command B: B output is not stolen by A', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-ab-syntax');
  try {
    // 1. Bare Ctrl-C at prompt settles with interrupt END130
    const ctrlC = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl-c handoff');
    feed(channel, marker(nonce, 'END;130;1'));
    await ctrlC;

    // 2. Authoritative prompt reset: command A submits syntax error ')' in candidate phase
    feed(channel, marker(nonce, 'BEGIN') + marker(nonce, 'END;0;1')); // Barrier clears on completed round
    await waitForRead(session, s => (s.lastCompletedRound as Record<string, unknown> | null)?.commandStarted === true, 'barrier reset');
    const pendingA = session.write([{ type: 'text', text: ')' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes(')\r'), 'A handoff');

    // 3. A syntax error END2 arrives
    feed(channel, 'bash: syntax error near unexpected token\r\n' + marker(nonce, 'END;2;1'));
    const resultA = await pendingA;
    assert.equal(resultA.state, 'shell_input_finished');
    assert.equal(resultA.exitCode, 2);
    assert.equal(resultA.commandStarted, false);

    // 4. B submits normal command 'echo B'
    const pendingB = session.write([{ type: 'text', text: 'echo B' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('echo B\r'), 'B handoff');

    // 5. B begins and completes
    feed(channel, marker(nonce, 'BEGIN') + 'B output\r\n' + marker(nonce, 'END;0;1'));
    const resultB = await pendingB;
    assert.equal(resultB.state, 'command_completed');
    assert.equal(resultB.exitCode, 0);
    assert.ok(String(resultB.output).includes('B output'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 bare Ctrl-C with 0 interrupt ENDs followed by command records factual execution', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-0end');
  try {
    const ctrlC = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl-c handoff');
    await ctrlC;

    // Remote emits 0 interrupt ENDs!
    const cmd = session.write([{ type: 'text', text: 'cmd0' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmd0\r'), 'cmd0 handoff');

    // Real command begins and ends
    feed(channel, marker(nonce, 'BEGIN') + 'cmd0 out\r\n' + marker(nonce, 'END;0;1'));
    const result = await cmd;
    assert.equal(result.inputHandled, 'unknown');

    const current = await session.read();
    const last = current.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, true);
    assert.equal(last.exitCode, 0);
    assert.ok(String(last.output).includes('cmd0 out'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 two bare Ctrl-Cs with two late END130s do not claim subsequent command', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-2ctrlc');
  try {
    // Two Ctrl-Cs
    const c1 = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'first ctrl-c');
    await c1;
    const c2 = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await c2;

    const cmd = session.write([{ type: 'text', text: 'top' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('top\r'), 'top handoff');

    // Two late interrupt ENDs arrive
    feed(channel, marker(nonce, 'END;130;1'));
    feed(channel, marker(nonce, 'END;130;1'));

    // Real command begins and ends
    feed(channel, marker(nonce, 'BEGIN') + 'top out\r\n' + marker(nonce, 'END;0;1'));
    const result = await cmd;
    assert.notEqual(result.exitCode, 130, 'must not claim either interrupt END130');
    assert.equal(result.inputHandled, 'unknown');

    const current = await session.read();
    const last = current.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, true);
    assert.equal(last.exitCode, 0);
    assert.ok(String(last.output).includes('top out'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 active queued A cancelled before BEGIN preserves original expired protections from stealing B token', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-cancel-barrier');
  try {
    // 1. In unstarted candidate phase at prompt, writer A queues input
    const controllerA = new AbortController();
    const pendingA = session.write([{ type: 'text', text: 'queued_a' }, { type: 'key', key: 'ENTER' }], controllerA.signal);
    await waitFor(() => channel.outbound.join('').includes('queued_a\r'), 'queued_a handoff');

    // 2. Writer A cancels observation before BEGIN arrives
    controllerA.abort();
    const resultA = await pendingA;
    assert.equal(resultA.observationCancelled, true);

    // 3. Writer B arrives after A cancelled
    const pendingB = session.write([{ type: 'text', text: 'writer_b' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('writer_b\r'), 'writer_b handoff');

    // 4. Old command A starts (late BEGIN) and finishes with END0
    feed(channel, marker(nonce, 'BEGIN') + 'a_out\r\n' + marker(nonce, 'END;0;1'));

    // Writer B must NOT be stolen by cancelled A's late execution!
    const resultB = await pendingB;
    assert.equal(resultB.inputHandled, 'unknown', 'cancelled A barrier must prevent B from stealing A completion');

    // Factual execution of A was NOT swallowed: lastCompletedRound records real commandStarted: true
    const current = await session.read();
    assert.equal(current.completionOwnership, 'unknown');
    const last = current.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, true, 'factual execution must be recorded, not falseNoExec');
    assert.equal(last.exitCode, 0);
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 bare Ctrl-C followed by batch packet with multiple Enters escalates to permanent ambiguous ownership', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-batch-multi-enter');
  try {
    // 1. Bare Ctrl-C at prompt
    const ctrlC = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl-c handoff');
    await ctrlC;

    // 2. During barrier, a batch packet with 2 Enters is submitted
    const batch = session.write([
      { type: 'text', text: 'cmd1' },
      { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'cmd2' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('cmd2\r'), 'batch handoff');

    // 3. cmd1 executes
    feed(channel, marker(nonce, 'BEGIN') + 'cmd1 out\r\n' + marker(nonce, 'END;0;1'));
    await batch;

    // 4. Subsequent command C arrives after cmd1 completed
    const cmdC = session.write([{ type: 'text', text: 'cmdC' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdC\r'), 'cmdC handoff');

    // Because multiple Enters entered during barrier, ownershipAmbiguous escalated to true!
    const resultC = await cmdC;
    assert.equal(resultC.inputHandled, 'unknown', 'batch multi-enter during barrier escalates to ambiguous ownership');

    // 5. Late cmd2 begins and completes
    feed(channel, marker(nonce, 'BEGIN') + 'cmd2 out\r\n' + marker(nonce, 'END;0;1'));

    // Command C was protected and never stolen by late cmd2
    const current = await session.read();
    assert.equal(current.completionOwnership, 'unknown');
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 bare Ctrl-C followed by two independent packets during barrier escalates to permanent ambiguous ownership', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-two-packets-barrier');
  try {
    // 1. Bare Ctrl-C at prompt
    const ctrlC = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl-c handoff');
    await ctrlC;

    // 2. During barrier, two independent packets are submitted
    const p1 = session.write([{ type: 'text', text: 'cmdA' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdA\r'), 'p1 handoff');
    const p2 = session.write([{ type: 'text', text: 'cmdB' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdB\r'), 'p2 handoff');

    // 3. cmdA executes
    feed(channel, marker(nonce, 'BEGIN') + 'cmdA out\r\n' + marker(nonce, 'END;0;1'));
    await p1;
    await p2;

    // 4. Subsequent command C arrives after cmdA completed
    const cmdC = session.write([{ type: 'text', text: 'cmdC' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdC\r'), 'cmdC handoff');

    const resultC = await cmdC;
    assert.equal(resultC.inputHandled, 'unknown', 'multiple independent packets during barrier escalate to ambiguous ownership');

    // 5. Late cmdB begins and completes
    feed(channel, marker(nonce, 'BEGIN') + 'cmdB out\r\n' + marker(nonce, 'END;0;1'));

    const current = await session.read();
    assert.equal(current.completionOwnership, 'unknown');
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 same packet containing Ctrl-C and Enter sets barrier, counts episode input, and does not claim 130', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, marker } = await scriptedSession('f04-same-packet-ctrlc');
  try {
    // Single packet contains both Ctrl-C and command with Enter
    const samePacket = session.write([
      { type: 'key', key: 'CTRL_C' },
      { type: 'text', text: 'echo same' },
      { type: 'key', key: 'ENTER' },
    ]);
    await waitFor(() => channel.outbound.join('').includes('echo same\r'), 'same packet handoff');

    // Late interrupt END;130 arrives
    feed(channel, marker(nonce, 'END;130;1'));
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    // Authoritative BEGIN and END0 for echo same arrive
    feed(channel, marker(nonce, 'BEGIN') + 'same out\r\n' + marker(nonce, 'END;0;1'));

    const result = await samePacket;
    assert.notEqual(result.exitCode, 130, 'same packet must not claim old interrupt 130');
    assert.equal(result.inputHandled, 'unknown');

    const current = await session.read();
    const last = current.lastCompletedRound as Record<string, unknown>;
    assert.equal(last.commandStarted, true);
    assert.equal(last.exitCode, 0);
    assert.ok(String(last.output).includes('same out'));

    // Single submission completed: barrier clears and next command regains ownership
    const next = session.write([{ type: 'text', text: 'echo next' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('echo next\r'), 'next handoff');
    feed(channel, marker(nonce, 'BEGIN') + 'next ok\r\n' + marker(nonce, 'END;0;1'));

    const nextResult = await next;
    assert.equal(nextResult.state, 'command_completed');
    assert.equal(nextResult.exitCode, 0);
    assert.ok(String(nextResult.output).includes('next ok'));
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('F04 interleaved Ctrl-C, A1, second Ctrl-C, A2 preserves submission counter across repeated Ctrl-C and protects C', { timeout: 10_000 }, async () => {
  // Use a generous observation budget (1500ms) to ensure C is actively observing
  // when late A2 arrives, proving protection comes from ambiguous ownership, not timeout.
  const { session, channel, nonce, marker } = await scriptedSession('f04-interleaved-ctrlc', 1500);
  try {
    // 1. First bare Ctrl-C sets interruptBarrier=true (submissions=0)
    const ctrl1 = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.join('').includes('\x03'), 'ctrl1 handoff');
    await ctrl1;

    // 2. A1 submitted during barrier (submissions count=1, BEGIN not yet parsed)
    const pendingA1 = session.write([{ type: 'text', text: 'cmdA1' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdA1\r'), 'A1 handoff');

    // 3. Second bare Ctrl-C arrives: must NOT reset interruptSubmissions counter while barrier is active
    const ctrl2 = session.write([{ type: 'key', key: 'CTRL_C' }]);
    await waitFor(() => channel.outbound.filter(c => c.includes('\x03')).length >= 2, 'ctrl2 handoff');
    await ctrl2;

    // 4. A2 submitted (submissions count becomes 2 -> escalates to permanent ownershipAmbiguous)
    const pendingA2 = session.write([{ type: 'text', text: 'cmdA2' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdA2\r'), 'A2 handoff');

    // 5. A1 executes with BEGIN/END0
    feed(channel, marker(nonce, 'BEGIN') + 'A1 out\r\n' + marker(nonce, 'END;0;1'));
    await waitForRead(session, s => (s.lastCompletedRound as Record<string, unknown> | null)?.commandStarted === true, 'A1 completed');
    await pendingA1;

    // 6. Start fresh command C, verify C bytes have actually been handed off to channel,
    // but DO NOT wait for C promise to finish — C is actively observing with 1500ms budget.
    const pendingC = session.write([{ type: 'text', text: 'cmdC' }, { type: 'key', key: 'ENTER' }]);
    await waitFor(() => channel.outbound.join('').includes('cmdC\r'), 'cmdC handoff');

    // 7. While C is actively observing (well before deadline), late A2 executes with BEGIN/END0.
    // In buggy code (counter reset to 0), C would mistakenly claim A2 as command_completed!
    feed(channel, marker(nonce, 'BEGIN') + 'A2 out\r\n' + marker(nonce, 'END;0;1'));

    // 8. Await C: C must NOT claim A2, must remain unknown, and must NOT receive A2 output.
    const resultC = await pendingC;
    assert.notEqual(resultC.state, 'command_completed', 'cmdC must NOT claim late A2 execution');
    assert.equal(resultC.inputHandled, 'unknown', 'cmdC must remain unknown under ambiguous ownership');
    assert.ok(!String(resultC.output ?? '').includes('A2 out'), 'cmdC must not receive A2 output');

    // 9. Confirm factual A2 round is recorded in cache/round history
    const factualA2 = await waitForRead(
      session,
      s => {
        const last = s.lastCompletedRound as Record<string, unknown> | null;
        return last?.commandStarted === true && String(last?.output).includes('A2 out');
      },
      'A2 factual completion',
    );
    const lastA2 = factualA2.lastCompletedRound as Record<string, unknown>;
    assert.equal(lastA2.exitCode, 0);
    assert.equal(lastA2.commandStarted, true);
    assert.ok(String(lastA2.output).includes('A2 out'));

    // 10. Subsequent factual C execution also recorded if run
    feed(channel, marker(nonce, 'BEGIN') + 'C out\r\n' + marker(nonce, 'END;0;1'));
    const factualC = await waitForRead(
      session,
      s => {
        const last = s.lastCompletedRound as Record<string, unknown> | null;
        return last?.commandStarted === true && String(last?.output).includes('C out');
      },
      'C factual completion',
    );
    const lastC = factualC.lastCompletedRound as Record<string, unknown>;
    assert.equal(lastC.exitCode, 0);
    assert.equal(lastC.commandStarted, true);
    assert.ok(String(lastC.output).includes('C out'));

    const current = await session.read();
    assert.equal(current.completionOwnership, 'unknown');
    await pendingA2.catch(() => undefined);
  } finally {
    await session.close().catch(() => undefined);
  }
});
