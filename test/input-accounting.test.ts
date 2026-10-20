import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { Client, ClientChannel } from 'ssh2';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { publicError } from '../src/core/errors.js';
import type { ConnectionLease, InputAction, TerminalIdentity } from '../src/core/types.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { TerminalSession } from '../src/terminal/session.js';
import { fixtureRoot } from './helpers/workspace.js';

const TEST_MS = process.platform === 'win32' ? 60_000 : 30_000;
const PAYLOAD = 'owned_literal_not_for_step_metadata';
const RAW_ERROR = 'owned_native_error_not_for_public_projection';

/** A real local Writable queue, not a real SSH or remote-delivery proof. */
class AccountingChannel extends PassThrough {
  readonly stderr = new PassThrough();
  readonly outbound: string[] = [];
  hold = false;
  lateError = false;
  onInput: (() => void) | undefined;
  held: ((error?: Error | null) => void) | undefined;

  constructor() { super({ highWaterMark: 1, autoDestroy: false }); }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.outbound.push(chunk.toString('utf8'));
    this.onInput?.();
    if (this.hold) this.held = callback;
    else if (this.lateError) setImmediate(() => callback(new Error(RAW_ERROR)));
    else callback();
  }

  release(): void {
    this.hold = false;
    const callback = this.held;
    this.held = undefined;
    callback?.();
  }

  close(): void {
    this.release();
    this.end();
    this.push(null); // Input errors must not leave the independent readable side without EOF.
    this.stderr.end();
    this.emit('close');
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Owned input fixture did not reach ${label}.`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const root = fixtureRoot('input-accounting', randomUUID());
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const cache = path.join(root, 'cache.log');
  await fs.writeFile(cache, '', { flag: 'wx', mode: 0o600 });
  let contents = '';
  let closed = false;
  let releases = 0;
  const handle = {
    stat: async () => fs.stat(cache, { bigint: true }),
    write: async (buffer: Buffer, offset: number, length: number) => {
      contents += buffer.subarray(offset, offset + length).toString('utf8');
      return { bytesWritten: length, buffer };
    },
    close: async () => { closed = true; },
  } as unknown as FileHandle;
  const identity: TerminalIdentity = {
    ip: '127.0.0.1', port: 22, username: 'owned_input', codename: 'accounting',
  };
  const recorder = await ReadableRecorder.createWithHandle(handle, cache, identity);
  const channel = new AccountingChannel();
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
    channel.push(Buffer.from(encodeMarkerOsc(nonce, 'READY;bash')));
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
    if (!closed) {
      try { await recorder.close(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw primary;
    throw new AggregateError(failures, 'Owned initialization and cleanup failures; primary first.');
  }
  const { session, nonce } = initialized;
  let attempts = 0;
  let nativeReturn: boolean | undefined;
  let throwAfterPrefix = false;
  let prefixEffects = 0;
  const originalWrite = channel.write;
  // Observe the real Writable result. The false-admission test does not simply
  // stub a false return; it retains a native Writable callback above its HWM.
  channel.write = function (this: AccountingChannel, ...args: unknown[]) {
    attempts++;
    if (throwAfterPrefix) {
      this.outbound.push(String(args[0]).slice(0, 1));
      prefixEffects++;
      throw new Error(RAW_ERROR);
    }
    nativeReturn = Reflect.apply(originalWrite, this, args) as boolean;
    return nativeReturn;
  } as typeof channel.write;
  const pending: Promise<unknown>[] = [];
  return {
    session, channel,
    write(actions: InputAction[], signal?: AbortSignal): Promise<Record<string, unknown>> {
      const work = session.write(actions, signal);
      pending.push(work);
      void work.catch(() => undefined);
      return work;
    },
    throwAfterPrefix(): void { throwAfterPrefix = true; },
    attempts: () => attempts,
    prefixEffects: () => prefixEffects,
    nativeReturn: () => nativeReturn,
    contents: () => contents,
    async cleanup(): Promise<void> {
      channel.onInput = undefined;
      channel.lateError = false;
      channel.release();
      // Restore the inherited advertised state used by one isolated guard test.
      if (Object.hasOwn(channel, 'errored')) Reflect.deleteProperty(channel, 'errored');
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); } catch (error) { failures.push(error); }
      };
      await attempt(async () => {
        const closing = session.close();
        // A failed writable half need not run Transform._final. Supply the
        // independent fixture EOF after closing starts, and consume that EOF.
        channel.push(null);
        channel.stderr.end();
        channel.resume();
        channel.stderr.resume();
        const result = await closing;
        assert.equal(result.ok, true);
        assert.equal(result.remoteChannelCleanupConfirmed, true);
      });
      await Promise.allSettled(pending);
      await attempt(async () => assert.equal(closed, true));
      await attempt(async () => assert.equal(releases, 1));
      await attempt(() => assert.rejects(fs.lstat(cache), { code: 'ENOENT' }));
      if (failures.length) throw new AggregateError(failures, 'Owned input fixture cleanup failed.');
    },
  };
}

async function rejection(work: Promise<unknown>): Promise<Record<string, unknown>> {
  try { await work; }
  catch (error) { return publicError(error); }
  assert.fail('The owned input operation must reject before the claimed handoff.');
}

function accounting(reply: Record<string, unknown>, requested: number, accepted: number | null): void {
  assert.equal(reply.inputActionsRequested, requested);
  assert.equal(reply.inputActionsAccepted, accepted);
  if (accepted === null) assert.notEqual(reply.inputSent, false, 'Unknown effects must not become known zero.');
  else assert.equal(reply.inputSent, accepted > 0);
  assert.equal(JSON.stringify(reply).includes(RAW_ERROR), false);
}

function stepAgreement(contents: string, requested: number, accepted: number | null): void {
  const request = contents.split('\n').find(line => line.endsWith(` actions=${requested}`));
  assert.ok(request, 'The original STEP requested-action line is retained.');
  const prefix = request.slice(0, request.indexOf(' actions='));
  assert.ok(contents.split('\n').includes(
    `${prefix} inputActionsRequested=${requested} inputActionsAccepted=${accepted === null ? 'unknown' : accepted}`,
  ), 'The same STEP id must retain its factual local handoff outcome.');
  assert.equal(contents.includes(PAYLOAD), false, 'STEP metadata must not mirror literal input.');
  assert.equal(contents.includes(RAW_ERROR), false);
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

test('input accounting: zero-byte whole batches are no-op before and behind native backlog', { timeout: TEST_MS }, async context => {
  return usingFixture(async f => {
    const actions: InputAction[] = [
      { type: 'text', text: '' },
      { type: 'text', text: '' },
    ];
    const before = await f.session.read();
    const header = f.contents();
    const empty = await f.write(actions);
    context.diagnostic(JSON.stringify({
      phase: 'fresh-zero-packet',
      nativeAttempts: f.attempts(),
      requested: empty.inputActionsRequested,
      accepted: empty.inputActionsAccepted,
      inputSent: empty.inputSent,
    }));
    accounting(empty, 2, 0);
    assert.equal(f.attempts(), 0);
    assert.equal(empty.state, before.state, 'A no-op must not invent a pending observation.');
    await f.session.read();
    assert.equal(f.contents(), header, 'A no-op must not create STEP or round metadata.');

    // The same zero-byte path must not append callbacks behind existing native work.
    f.channel.hold = true;
    accounting(await f.write([{ type: 'text', text: PAYLOAD }]), 1, 1);
    assert.equal(f.nativeReturn(), false);
    assert.ok(f.channel.held);
    await f.session.read();
    const retainedBytes = f.channel.writableLength;
    const afterInput = f.contents();
    accounting(await f.write(actions), 2, 0);
    assert.equal(f.attempts(), 1);
    assert.equal(f.channel.writableLength, retainedBytes);
    assert.ok(f.channel.held, 'The earlier native callback is still genuinely retained.');
    await f.session.read();
    assert.equal(f.contents(), afterInput);
  });
});

test('input accounting: pre-abort retains requested1/accepted0 without native or STEP effects', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(f.write([{ type: 'text', text: PAYLOAD }], controller.signal));
    assert.equal(error.code, 'REQUEST_CANCELLED');
    assert.equal(f.attempts(), 0);
    assert.equal(f.contents().includes(' actions='), false);
    accounting(error, 1, 0);
  });
});

test('input accounting: existing invalid encoding reports zero before native invocation', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const error = await rejection(f.write([{ type: 'text', text: '\n' }]));
    assert.equal(error.code, 'INVALID_TEXT');
    assert.equal(f.attempts(), 0);
    assert.equal(f.contents().includes(' actions='), false);
    accounting(error, 1, 0);
  });
});

test('input accounting: C1 text has no native handoff or STEP side effect', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const error = await rejection(f.write([{ type: 'text', text: 'a\u0085b' }]));
    assert.equal(error.code, 'INVALID_TEXT');
    assert.equal(f.attempts(), 0);
    assert.equal(f.contents().includes(' actions='), false);
    accounting(error, 1, 0);
  });
});

test('input accounting: normal batch admits N once and records the same STEP id', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const result = await f.write([{ type: 'text', text: PAYLOAD }, { type: 'key', key: 'LEFT' }]);
    assert.equal(result.inputHandled, 'unknown');
    assert.equal(f.attempts(), 1);
    assert.ok(f.contents().split('\n').some(line => line.endsWith(' actions=2')));
    accounting(result, 2, 2);
    stepAgreement(f.contents(), 2, 2);
  });
});

test('input accounting: real healthy Writable.write(false) still admits the whole batch', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    f.channel.hold = true;
    const result = await f.write([{ type: 'text', text: PAYLOAD }]);
    assert.equal(f.nativeReturn(), false);
    assert.ok(f.channel.held, 'The callback must still be held, not mistaken for a remote ACK.');
    assert.ok(f.channel.writableLength > 0);
    accounting(result, 1, 1);
    stepAgreement(f.contents(), 1, 1);
  });
});

test('input accounting: advertised pre-existing errored state rejects before calling write', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    // This is an owned public-state guard stub, not a claim of native failure.
    Object.defineProperty(f.channel, 'errored', {
      configurable: true, value: new Error(RAW_ERROR),
    });
    const error = await rejection(f.write([{ type: 'text', text: PAYLOAD }]));
    accounting(error, 1, 0);
    assert.equal(f.attempts(), 0);
  });
});

test('input accounting: a possible prefix effect followed by a native throw is unknown, not zero', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    f.throwAfterPrefix();
    const error = await rejection(f.write([{ type: 'text', text: PAYLOAD }]));
    assert.equal(f.attempts(), 1);
    assert.equal(f.prefixEffects(), 1);
    accounting(error, 1, null);
    await f.session.read();
    stepAgreement(f.contents(), 1, null);
  });
});

test('input accounting: a late native callback error cannot roll known N back', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    f.channel.lateError = true;
    const result = await f.write([{ type: 'text', text: PAYLOAD }]);
    assert.equal(result.ok, false);
    accounting(result, 1, 1);
    stepAgreement(f.contents(), 1, 1);
  });
});

test('input accounting: cancellation at native admission retains known N and same STEP', { timeout: TEST_MS }, async () => {
  return usingFixture(async f => {
    const controller = new AbortController();
    f.channel.onInput = () => controller.abort();
    const result = await f.write([{ type: 'text', text: PAYLOAD }], controller.signal);
    assert.equal(result.observationCancelled, true);
    accounting(result, 1, 1);
    await f.session.read();
    stepAgreement(f.contents(), 1, 1);
  });
});
