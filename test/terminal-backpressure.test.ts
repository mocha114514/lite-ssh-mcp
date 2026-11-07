/** Parser/recorder bridge tests: in-memory handles, no SSH, files or credentials. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Client, ClientChannel } from 'ssh2';
import { ReadableRecorder } from '../src/cache/recorder.js';
import { SerialQueue } from '../src/core/async.js';
import type { ConnectionLease, TerminalIdentity } from '../src/core/types.js';
import { ScreenModel } from '../src/terminal/screen.js';
import { TerminalSession } from '../src/terminal/session.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface RecordingBridge {
  screen: ScreenModel;
  output: SerialQueue;
  status: string;
  channel?: ClientChannel;
  resize: TerminalSession['resize'];
}

async function fixture(cols = 240, rows = 100, maxPendingBytes?: number) {
  const gate = deferred();
  const drainRequested = deferred();
  const frames: string[] = [];
  let held = false;
  let failWrites = false;
  let expectedRow: string | undefined;
  let incompleteFrames = 0;
  let inspectFrame: ((text: string) => void) | undefined;
  const handle = {
    async write(buffer: Buffer, offset: number, length: number) {
      if (held) await gate.promise;
      if (failWrites) throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
      const text = buffer.subarray(offset, offset + length).toString('utf8');
      const header = text.split('\n', 1)[0]!;
      if (header.includes('cursor=(')) {
        frames.push(header);
        inspectFrame?.(text);
        if (expectedRow && header.includes('label=cursor-address') &&
            !text.includes(`[${rows - 1}] ${expectedRow}`)) incompleteFrames++;
      }
      return { bytesWritten: length, buffer };
    },
    async close() {},
  } as unknown as FileHandle;
  const identity: TerminalIdentity = { ip: '192.0.2.10', port: 22, username: 'synthetic', codename: 'backpressure' };
  const recorder = await ReadableRecorder.createWithHandle(
    handle, 'vb-test/backpressure/memory-only-not-created.context.log', identity, { maxPendingBytes },
  );
  const originalFlush = recorder.flush.bind(recorder);
  recorder.flush = () => {
    if (held) drainRequested.resolve();
    return originalFlush();
  };
  const lease: ConnectionLease = { client: {} as Client, target: identity, release: async () => {} };
  // Exercise the production constructor-installed recording callbacks without
  // opening a shell. Only screen/recording resources exist in this fixture.
  const Construct = TerminalSession as unknown as new (
    lease: ConnectionLease, identity: TerminalIdentity, recorder: ReadableRecorder,
    options: { cols: number; rows: number },
  ) => RecordingBridge;
  const bridge = new Construct(lease, identity, recorder, { cols, rows });
  return {
    bridge, recorder, frames,
    drainRequested: drainRequested.promise,
    hold: () => { held = true; },
    release: () => { held = false; gate.resolve(); },
    fail: () => { failWrites = true; },
    expectRow: (row: string) => { expectedRow = row; },
    incompleteFrames: () => incompleteFrames,
    inspectFrames: (inspect: (text: string) => void) => { inspectFrame = inspect; },
    async close() {
      held = false;
      gate.resolve();
      bridge.screen.dispose();
      return recorder.close({ remove: false });
    },
  };
}

test('one 4KiB cursor burst pauses for slow recording and retains all 1024 full frames', { timeout: 15_000 }, async () => {
  const f = await fixture();
  let work: Promise<void> | undefined;
  try {
    const row = 'X'.repeat(240);
    await f.bridge.screen.write(row.repeat(100));
    f.bridge.screen.flushLine();
    await f.recorder.flush();
    f.expectRow(row);
    f.hold();
    work = f.bridge.screen.write(('\x1b[1G\x1b[2G').repeat(512)).then(() => f.recorder.flush());
    void work.catch(() => {});
    await f.drainRequested;
    assert.equal(f.recorder.failed, undefined, 'a bounded control burst must backpressure, not overflow');
    f.release();
    await work;
    assert.equal(f.recorder.failed, undefined);
    assert.equal(f.frames.length, 1024);
    assert.equal(f.incompleteFrames(), 0, 'full frame bodies must survive, not just headers');
    const columns = f.frames.map(frame => Number(/cursor=\((\d+),/u.exec(frame)![1]));
    assert.equal(columns[0], 240);
    for (let index = 1; index < columns.length; index++) assert.equal(columns[index], (index + 1) % 2);
  } finally { f.release(); await work?.catch(() => {}); await f.close(); }
});

test('resize cannot change local or remote dimensions while parser recording is paused', { timeout: 5000 }, async () => {
  const f = await fixture(80, 3);
  const windows: Array<[number, number]> = [];
  f.bridge.channel = { setWindow: (rows: number, cols: number) => windows.push([rows, cols]) } as unknown as ClientChannel;
  f.bridge.status = 'open';
  let output: Promise<unknown> | undefined;
  let resizing: Promise<unknown> | undefined;
  try {
    f.hold();
    output = f.bridge.output.run(async () => {
      await f.bridge.screen.write('abc\x1b[1G\x1b[2G');
      await f.recorder.flush();
    });
    void output.catch(() => {});
    await f.drainRequested;
    resizing = f.bridge.resize(90, 4);
    void resizing.catch(() => {});
    await tick();
    assert.deepEqual(windows, []);
    assert.equal(f.bridge.screen.snapshot().cols, 80);
    f.release();
    await output;
    await resizing;
    assert.deepEqual(windows, [[4, 90]]);
    assert.equal(f.bridge.screen.snapshot().cols, 90);
    assert.match(f.frames.at(-2)!, /cols=80 rows=3.*label=before-resize/u);
    assert.match(f.frames.at(-1)!, /cols=90 rows=4.*label=RESIZE/u);
  } finally { f.release(); await Promise.allSettled([output, resizing]); await f.close(); }
});

test('a disk failure during parser backpressure rejects without leaving parsing suspended', { timeout: 5000 }, async () => {
  const f = await fixture(80, 3);
  let work: Promise<void> | undefined;
  try {
    f.hold();
    // Assert the parser write itself rejects, not merely a later recorder flush.
    work = f.bridge.screen.write('abc\x1b[1G\x1b[2G').then(() => {});
    void work.catch(() => {});
    await f.drainRequested;
    f.fail();
    f.release();
    await assert.rejects(work, { code: 'CACHE_WRITE_FAILED' });
    await assert.rejects(f.bridge.screen.write('late'), { code: 'CACHE_WRITE_FAILED' });
    const closed = await f.recorder.close({ remove: false });
    assert.equal(closed.cacheMayBeIncomplete, true);
    assert.equal(closed.recordingErrorCode, 'CACHE_WRITE_FAILED');
  } finally { f.release(); await work?.catch(() => {}); await f.close(); }
});

test('asynchronous frame barriers preserve erase, alternate, reset and restore ordering', { timeout: 5000 }, async () => {
  const f = await fixture(80, 3);
  const recorded: string[] = [];
  f.inspectFrames(text => { recorded.push(text); });
  let work: Promise<unknown> | undefined;
  try {
    f.hold();
    work = f.bridge.screen.write(
      'old\x1b[2J\x1b[Hnormal\x1b[?1049h\rALT\x1b[?1049l' +
      '\x1bcRESET\x1b7\x1b[2G\x1b8Z',
    );
    void work.catch(() => {});
    await f.drainRequested;
    assert.equal(recorded.length, 0, 'the pending body must drain before its old frame');
    f.release();
    await work;
    await f.recorder.flush();
    assert.deepEqual(f.frames.map(header => /label=(\S+)/u.exec(header)![1]), [
      'erase-j', 'cursor-address', 'alt-enter', 'alt-exit',
      'reset', 'cursor-address', 'cursor-restore',
    ]);
    assert.ok(recorded[0]!.includes('[0] old'));
    assert.ok(recorded[2]!.includes('buffer=normal') && recorded[2]!.includes('[0] normal'));
    assert.ok(recorded[3]!.includes('buffer=alternate') && recorded[3]!.includes('[0] ALT'));
    assert.ok(recorded[4]!.includes('buffer=normal') && recorded[4]!.includes('[0] normal'));
    assert.ok(recorded[6]!.includes('cursor=(1,0)') && recorded[6]!.includes('[0] RESET'));
    const screen = f.bridge.screen.snapshot();
    assert.equal(screen.buffer, 'normal');
    assert.equal(screen.lines[0], 'RESETZ');
    assert.equal(screen.cursor.x, 6);
  } finally { f.release(); await work?.catch(() => {}); await f.close(); }
});

test('a frame exceeding the real hard budget still fails instead of waiting forever', { timeout: 5000 }, async () => {
  const f = await fixture(240, 100, 512);
  try {
    await assert.rejects(async () => {
      await f.bridge.screen.write('\x1b[1G\x1b[2G');
      await f.recorder.flush();
    }, { code: 'CACHE_WRITE_FAILED' });
  } finally { await f.close(); }
});
