import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { Client, ClientChannel } from 'ssh2';
import { ReadableRecorder } from '../src/cache/recorder.js';
import type { ConnectionLease, TerminalIdentity } from '../src/core/types.js';
import { encodeMarkerOsc, parseMarker } from '../src/shell/protocol.js';
import { TerminalSession } from '../src/terminal/session.js';
import { createShellMarkers } from './helpers/shell-markers.js';
import { fixtureRoot } from './helpers/workspace.js';

const NONCE = 'owned_sequence_parser';
const MAX_SEQUENCE = 2_147_483_647;
const TEST_MS = process.platform === 'win32' ? 60_000 : 30_000;

/** Local ordering fixture, never evidence of real SSH output backpressure. */
class OrderedChannel extends PassThrough {
  readonly stderr = new PassThrough();
  readonly outbound: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outbound.push(chunk.toString('utf8'));
    callback();
  }

  close(): void {
    this.end();
    this.push(null);
    this.stderr.end();
    this.emit('close');
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Owned sequence fixture did not reach ${label}.`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(readyTail = '', splitReady = false) {
  const root = fixtureRoot('shell-sequence', randomUUID());
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const cache = path.join(root, 'cache.log');
  await fs.writeFile(cache, '', { flag: 'wx', mode: 0o600 });
  let handleClosed = false;
  let releases = 0;
  let contents = '';
  // A memory writer with an exact owned on-disk identity for normal cache
  // removal. This does not pretend to be a native FD-failure experiment.
  const handle = {
    stat: async () => fs.stat(cache, { bigint: true }),
    write: async (buffer: Buffer, offset: number, length: number) => {
      contents += buffer.subarray(offset, offset + length).toString('utf8');
      return { bytesWritten: length, buffer };
    },
    close: async () => { handleClosed = true; },
  } as unknown as FileHandle;
  const identity: TerminalIdentity = {
    ip: '127.0.0.1', port: 22, username: 'owned_sequence', codename: 'sequence',
  };
  const recorder = await ReadableRecorder.createWithHandle(handle, cache, identity);
  const channel = new OrderedChannel();
  const lease: ConnectionLease = {
    target: { ip: identity.ip, port: identity.port, username: identity.username },
    client: {
      shell: (_window: unknown, callback: (error: null, stream: ClientChannel) => void) => {
        callback(null, channel as unknown as ClientChannel);
      },
    } as unknown as Client,
    release: async () => { releases++; },
  };
  const opening = TerminalSession.open(lease, identity, { recorder, writeWaitMs: 1_200 });
  void opening.catch(() => undefined);
  const initialize = async () => {
    await until(() => channel.outbound.join('').includes(';STTY'), 'probe');
    const nonce = /LSSH;([A-Za-z0-9_.-]+);STTY/.exec(channel.outbound.join(''))?.[1];
    assert.ok(nonce);
    channel.push(Buffer.from(
      encodeMarkerOsc(nonce, 'STTY;0:0:0:0') + encodeMarkerOsc(nonce, 'PROBE;bash'),
    ));
    await until(() => channel.outbound.join('').includes('__lssh_'), 'bootstrap');
    const ready = encodeMarkerOsc(nonce, 'READY;bash');
    if (splitReady) {
      const middle = Math.floor(ready.length / 2);
      channel.push(Buffer.from(ready.slice(0, middle)));
      await new Promise<void>(resolve => setImmediate(resolve));
      channel.push(Buffer.from(ready.slice(middle) + (readyTail ? encodeMarkerOsc(nonce, readyTail) : '')));
    } else {
      channel.push(Buffer.from(ready + (readyTail ? encodeMarkerOsc(nonce, readyTail) : '')));
    }
    return { session: await opening, nonce };
  };
  let initialized: Awaited<ReturnType<typeof initialize>>;
  try { initialized = await initialize(); }
  catch (primary) {
    const failures: unknown[] = [primary];
    try { channel.close(); } catch (error) { failures.push(error); }
    const [settled] = await Promise.allSettled([opening]);
    if (settled!.status === 'fulfilled') {
      try { await settled.value.close(); } catch (error) { failures.push(error); }
    } else if (settled!.reason !== primary) failures.push(settled!.reason);
    if (!handleClosed) {
      try { await recorder.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw primary;
    throw new AggregateError(failures, 'Owned initialization and cleanup failures; primary first.');
  }
  const { session, nonce } = initialized;
  const pending: Promise<unknown>[] = [];
  const submit = async (name: string): Promise<{ reply: Promise<Record<string, unknown>> }> => {
    const reply = session.write([{ type: 'text', text: name }, { type: 'key', key: 'ENTER' }]);
    pending.push(reply);
    void reply.catch(() => undefined); // Observe rejection without changing the business promise.
    await until(() => channel.outbound.includes(name + '\r'), 'input handoff');
    return { reply };
  };
  return {
    session, nonce, submit,
    markers: createShellMarkers(nonce),
    feed(payload: string): void { channel.push(Buffer.from(encodeMarkerOsc(nonce, payload))); },
    feedBytes(bytes: string): void { channel.push(Buffer.from(bytes)); },
    contents: () => contents,
    async cleanup(): Promise<void> {
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); } catch (error) { failures.push(error); }
      };
      await attempt(async () => {
        const result = await session.close();
        assert.equal(result.ok, true);
        assert.equal(result.remoteChannelCleanupConfirmed, true);
      });
      await Promise.allSettled(pending);
      await attempt(async () => assert.equal(handleClosed, true));
      await attempt(async () => assert.equal(releases, 1));
      await attempt(() => assert.rejects(fs.lstat(cache), { code: 'ENOENT' }));
      if (failures.length) throw new AggregateError(failures, 'Owned sequence fixture cleanup failed.');
    },
  };
}

async function usingFixture(
  body: (owned: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ...args: Parameters<typeof fixture>
): Promise<void> {
  const owned = await fixture(...args);
  const failures: unknown[] = [];
  try { await body(owned); }
  catch (error) { failures.push(error); }
  try { await owned.cleanup(); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Owned test assertion and cleanup failures; primary first.');
  }
}

test('wire BEGIN/END carry the same explicit sequence and factual status/health', () => {
  assert.deepEqual(parseMarker(`LSSH;${NONCE};BEGIN;12`, NONCE), {
    nonce: NONCE, kind: 'begin', sequence: 12,
  });
  assert.deepEqual(parseMarker(`LSSH;${NONCE};END;12;7;1`, NONCE), {
    nonce: NONCE, kind: 'end', sequence: 12, exitCode: 7, hookHealthy: true,
  });
});

test('wire rejects missing/out-of-range sequence, wrong field counts and invalid health', () => {
  for (const payload of [
    'BEGIN', 'END;7', 'END;7;1', 'BEGIN;0', 'BEGIN;-1', 'BEGIN;1.5',
    `BEGIN;${MAX_SEQUENCE + 1}`, 'BEGIN;1;extra', 'END;1;0',
    'END;1;0;2', 'END;1;0;1;extra', 'END;1;;1',
  ]) {
    assert.equal(parseMarker(`LSSH;${NONCE};${payload}`, NONCE), null, payload);
  }
});

test('wire range endpoints retain decimal values without a new status cap or leading-zero ban', () => {
  assert.deepEqual(parseMarker(`LSSH;${NONCE};BEGIN;0001`, NONCE), {
    nonce: NONCE, kind: 'begin', sequence: 1,
  });
  assert.deepEqual(parseMarker(`LSSH;${NONCE};END;${MAX_SEQUENCE};512;0`, NONCE), {
    nonce: NONCE, kind: 'end', sequence: MAX_SEQUENCE, exitCode: 512, hookHealthy: false,
  });
});

test('wire control: unchanged handshake and foreign nonce rejection', () => {
  assert.deepEqual(parseMarker(`LSSH;${NONCE};READY;bash`, NONCE), {
    nonce: NONCE, kind: 'ready', shell: 'bash',
  });
  assert.equal(parseMarker('LSSH;foreign;BEGIN;1', NONCE), null);
});

test('unsequenced runtime frames cannot publish trusted completion', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const { reply } = await f.submit('legacy_packet');
    f.feedBytes(encodeMarkerOsc(f.nonce, 'BEGIN') + 'owned legacy body\r\n' +
      encodeMarkerOsc(f.nonce, 'END;0;1'));
    const view = await f.session.read();
    assert.equal(view.lastCompletedRound, null, 'An unsequenced END must not create a completion.');
    assert.notEqual((await reply).state, 'command_completed');
    assert.ok(f.contents().includes('owned legacy body'));
  });
});

test('sequenced END-only input and subsequent command retain factual ownership', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const first = await f.submit('parser_rejection');
    f.feedBytes('owned syntax diagnostic\r\n' + f.markers.end(2));
    const rejected = await first.reply;
    assert.equal(rejected.state, 'shell_input_finished');
    assert.equal(rejected.commandStarted, false);
    assert.equal(rejected.exitCode, 2);
    const second = await f.submit('normal_command');
    f.feedBytes(f.markers.begin() + 'owned normal body\r\n' + f.markers.end(7));
    const completed = await second.reply;
    assert.equal(completed.state, 'command_completed');
    assert.equal(completed.commandStarted, true);
    assert.equal(completed.exitCode, 7);
  });
});

for (const anomaly of [
  { name: 'BEGIN gap', before: '', payload: 'BEGIN;2', completed: false },
  { name: 'END-only gap', before: '', payload: 'END;2;0;1', completed: false },
  { name: 'BEGIN/END mismatch', before: 'BEGIN;1', payload: 'END;2;0;1', completed: false },
  { name: 'duplicate active BEGIN', before: 'BEGIN;1', payload: 'BEGIN;1', completed: false },
  { name: 'replayed completed END', before: '', payload: 'END;1;0;1', completed: true },
  { name: 'backward BEGIN', before: '', payload: 'BEGIN;1', completed: true },
]) {
  test(`sequence policyA: ${anomaly.name} fails without changing trusted history`, { timeout: TEST_MS }, async () => {
    return usingFixture(async f => {
      if (anomaly.completed) {
        const first = await f.submit('finished_before_anomaly');
        f.feedBytes(f.markers.begin() + 'owned first history\r\n' + f.markers.end());
        assert.equal((await first.reply).state, 'command_completed');
      }
      const prior = (await f.session.read()).lastCompletedRound;
      const { reply } = await f.submit('anomaly_candidate');
      // One native chunk keeps both explicit frames causally ordered. Await
      // the writer's bounded observation before reading: read() drains only
      // already-admitted output, not a second chunk still paused in Readable.
      f.feedBytes((anomaly.before ? encodeMarkerOsc(f.nonce, anomaly.before) : '') +
        encodeMarkerOsc(f.nonce, anomaly.payload));
      const observed = await reply;
      const view = await f.session.read();
      assert.equal(view.code, 'SHELL_INTEGRATION_LOST');
      assert.equal(view.ok, false);
      assert.deepEqual(view.lastCompletedRound, prior);
      assert.notEqual(observed.state, 'command_completed');
      const before = f.contents();
      await assert.rejects(f.session.write([{ type: 'text', text: 'must_not_replay' }]), {
        code: 'SHELL_INTEGRATION_LOST',
      });
      assert.equal(f.contents(), before);
    });
  });
}

for (const split of [false, true]) {
  test(`READY tail advances wire state before open finishes (${split ? 'split' : 'single'} chunk)`, { timeout: TEST_MS }, async () => {
    return usingFixture(async f => {
      const { reply } = await f.submit('after_ready_tail');
      f.feed('BEGIN;1'); // It is now a backward sequence, not a first BEGIN.
      await reply; // Observe this frame, not merely the earlier READY-tail task.
      const view = await f.session.read();
      assert.equal(view.code, 'SHELL_INTEGRATION_LOST');
      assert.equal(view.lastCompletedRound, null);
      assert.notEqual((await reply).state, 'command_completed');
    }, 'END;1;0;1', split);
  });
}

test('hook repair END cannot clear loss until a valid sequenced BEGIN arrives', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const lost = await f.submit('missing_hook');
    f.feedBytes('owned unknown start\r\n' + f.markers.end(7, false));
    assert.equal((await lost.reply).commandStartUnknown, true);
    const repaired = await f.submit('restore_saved_hook');
    f.feedBytes('owned repair\r\n' + f.markers.end(0, true));
    assert.equal((await repaired.reply).commandStartUnknown, true);
    const healthy = await f.submit('healthy_after_repair');
    f.feedBytes(f.markers.begin() + 'owned healthy\r\n' + f.markers.end(23, true));
    const result = await healthy.reply;
    assert.equal(result.state, 'command_completed');
    assert.equal(result.commandStarted, true);
    assert.equal(result.exitCode, 23);
  });
});
