import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Client, ClientChannel } from 'ssh2';
import type { ConnectionLease, TerminalIdentity } from '../src/core/types.js';
import { LiteSshError } from '../src/core/errors.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { TerminalSession } from '../src/terminal/session.js';
import { createApplication } from '../src/app.js';
import { startMockSsh } from './helpers/mock-ssh.js';

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
  await assert.rejects(TerminalSession.open(lease, { ...lease.target, codename: 'failed_probe' }, { cacheRoot: resolve('vb-test/m0/session/failure'), initializationTimeoutMs: 80 }));
  await new Promise<void>(resolve => setTimeout(resolve, 120));
  assert.equal(released, 1);
  // node:test itself treats any leaked unhandled rejection as a failing test.
});

test('a late PTY callback is closed while a different shared-connection terminal stays alive', { timeout: 10_000 }, async () => {
  const ssh = await startMockSsh({ lateSecondShellMs: 450 });
  const root = resolve('vb-test/m0/session/late', `${process.pid}-${Date.now()}`);
  await fs.mkdir(root, { recursive: true });
  const configPath = join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 2, servers: { [ssh.ip]: { [ssh.port]: {
    hostKeyFingerprint: ssh.fingerprint,
    accounts: { [ssh.username]: { auth: { type: 'password', password: ssh.password } } }
  } } } }), 'utf8');
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
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outbound.push(chunk.toString('utf8'));
    callback();
  }
  close(): void { this.end(); this.stderr.end(); this.emit('close'); }
}

/** A recorder over a fake file handle whose next writes can be held open. */
interface FlushGate {
  recorder: ReadableRecorder;
  /** Make every subsequent handle write wait until {@link release}. */
  hold(): void;
  release(): void;
}

async function gatedRecorder(identity: TerminalIdentity, path: string): Promise<FlushGate> {
  let gate: Promise<void> | undefined;
  let unblock: (() => void) | undefined;
  const handle = {
    // Never touches disk; while `gate` is set this models a slow cache flush.
    write: async (buffer: Buffer, _offset: number, length: number) => {
      if (gate) await gate;
      return { bytesWritten: length, buffer };
    },
    close: async () => undefined,
  } as unknown as FileHandle;
  const recorder = await ReadableRecorder.createWithHandle(handle, path, identity);
  return {
    recorder,
    hold(): void { gate = new Promise<void>(resolve => { unblock = resolve; }); },
    release(): void { const resolve = unblock; gate = undefined; unblock = undefined; resolve?.(); },
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
async function scriptedSession(tag: string): Promise<{ session: TerminalSession; channel: ScriptedChannel; nonce: string; flush: FlushGate }> {
  const channel = new ScriptedChannel();
  const identity: TerminalIdentity = { ip: '127.0.0.1', port: 22, username: 'scripted', codename: tag };
  const lease: ConnectionLease = {
    client: { shell: (_window: unknown, callback: (error: null, stream: unknown) => void) => callback(null, channel) } as unknown as Client,
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    release: async () => undefined,
  };
  const root = resolve('vb-test/m0/session', `submission-${tag}-${process.pid}-${Date.now()}`);
  await fs.mkdir(root, { recursive: true });
  const flush = await gatedRecorder(identity, join(root, 'cache.log'));
  const opened = TerminalSession.open(lease, identity, { initializationTimeoutMs: 4000, writeWaitMs: 320, recorder: flush.recorder });
  await waitFor(() => /LSSH;([A-Za-z0-9_.-]+);STTY/.test(channel.outbound.join('')), 'the shell probe');
  const nonce = /LSSH;([A-Za-z0-9_.-]+);STTY/.exec(channel.outbound.join(''))![1]!;
  feed(channel, `${marker(nonce, 'STTY;0:0:0:0')}${marker(nonce, 'PROBE;bash')}`);
  await waitFor(() => channel.outbound.join('').includes('__lssh_'), 'the shell bootstrap');
  feed(channel, marker(nonce, 'READY;bash'));
  return { session: await opened, channel, nonce, flush };
}

test('a prompt END observed while the pre-send flush is pending cannot consume the new submission', { timeout: 10_000 }, async () => {
  const { session, channel, nonce, flush } = await scriptedSession('presend');
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

test('two overlapping submissions get one cycle each, the later one END-only', { timeout: 10_000 }, async () => {
  const { session, channel, nonce } = await scriptedSession('overlap');
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
    assert.notEqual(firstResult.exitCode, 2, 'the earlier submission must not inherit the later parse error');
  } finally {
    await session.close().catch(() => undefined);
  }
});

test('an END-only cycle is a factual completion even when no writer owns it', { timeout: 10_000 }, async () => {
  const { session, channel, nonce } = await scriptedSession('endonly');
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
