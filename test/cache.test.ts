/**
 * M0 tests for the readable terminal cache (`src/cache/**`).
 *
 * HANDOVER / HOW TO RUN
 * ---------------------
 * These tests never touch real credentials, a remote host or private files.
 * They inject an isolated cache root under `vb-test/m0/cache-recorder/cases/`
 * (a private, git-ignored `vb-` location) and only create/delete their own
 * generated fixtures. `FOREIGN_SENTINEL.txt` represents a file this suite must
 * never remove; it is asserted intact before and after the run.
 *
 * Run (isolated build so it never races the shared `dist/`):
 *   npx tsc -p vb-test/m0/cache-recorder/tsconfig.cache.json
 *   node --test vb-test/m0/cache-recorder/build/test/cache.test.js
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rmdir, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ReadableRecorder } from '../src/cache/recorder.js';
import { BoundedWriteQueue } from '../src/cache/writeQueue.js';
import { DEFAULT_MAX_PENDING_BYTES } from '../src/cache/prefixes.js';
import { LiteSshError } from '../src/core/errors.js';
import type { ParsedLine, ScreenSnapshot, TerminalIdentity } from '../src/core/types.js';

const LABEL_ROOT = resolve(process.cwd(), 'vb-test', 'm0', 'cache-recorder');
const CASES_ROOT = join(LABEL_ROOT, 'cases');
const SENTINEL = join(LABEL_ROOT, 'FOREIGN_SENTINEL.txt');
const SENTINEL_TEXT = 'foreign-sentinel-must-survive\n';

let caseCounter = 0;
const trackedCases: string[] = [];

/** Unique generated fixture directory under this suite's private label. */
function caseRoot(name: string): string {
  caseCounter += 1;
  const dir = join(CASES_ROOT, `${name}-${Date.now()}-${caseCounter}`);
  trackedCases.push(dir);
  return dir;
}

const identity = (overrides: Partial<TerminalIdentity> = {}): TerminalIdentity => ({
  ip: '192.0.2.10',
  port: 22,
  username: 'deploy',
  codename: 'edit_config',
  ...overrides,
});

/** Build a `ParsedLine`; `newline:false` is the real optional field on the central type. */
function line(
  text: string,
  options: { buffer?: 'normal' | 'alternate'; wrapped?: boolean; newline?: boolean } = {},
): ParsedLine {
  const value: ParsedLine = {
    text,
    buffer: options.buffer ?? 'normal',
    wrapped: options.wrapped ?? false,
  };
  if (options.newline !== undefined) value.newline = options.newline;
  return value;
}

function screen(overrides: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return {
    revision: 1,
    cols: 80,
    rows: 24,
    buffer: 'normal',
    cursor: { x: 0, y: 0 },
    lines: [],
    styles: [],
    modes: { bracketedPaste: false, applicationCursorKeys: false, applicationKeypad: false },
    ...overrides,
  };
}

/** Fail fast (instead of hanging the whole suite) if a bounded promise never settles. */
function settlesWithin<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('HANG: promise did not settle within the deadline')), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A controlled fake `FileHandle`: the first `failAfterWrites` writes succeed,
 * everything after throws `EIO`. Never touches disk, never needs cleanup.
 */
function fakeHandle(failAfterWrites: number): FileHandle {
  let writes = 0;
  const handle = {
    write: async (_buffer: Buffer, _offset: number, length: number) => {
      writes += 1;
      if (writes > failAfterWrites) throw Object.assign(new Error('simulated disk write failure'), { code: 'EIO' });
      return { bytesWritten: length, buffer: _buffer };
    },
    close: async () => undefined,
  };
  return handle as unknown as FileHandle;
}

before(async () => {
  await mkdir(CASES_ROOT, { recursive: true });
  if (!existsSync(SENTINEL)) await writeFile(SENTINEL, SENTINEL_TEXT, 'utf8');
  assert.equal(await readFile(SENTINEL, 'utf8'), SENTINEL_TEXT);
});

after(async () => {
  // Targeted cleanup: only directories created by this suite, never a glob.
  for (const dir of trackedCases) {
    if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
  }
  assert.ok(existsSync(SENTINEL), 'foreign sentinel must be left intact');
  assert.equal(await readFile(SENTINEL, 'utf8'), SENTINEL_TEXT);
});

describe('ReadableRecorder', () => {
  it('creates an exclusive cache file with a header and an absolute path', async () => {
    const root = caseRoot('header');
    const recorder = await ReadableRecorder.create(identity(), root);
    assert.equal(resolve(recorder.path), recorder.path);
    assert.ok(existsSync(recorder.path));
    assert.ok(existsSync(root));

    const content = await readFile(recorder.path, 'utf8');
    assert.match(content, /\[TERMINAL\] ip=192\.0\.2\.10 port=22 username=deploy codename=edit_config/);
    assert.ok(content.includes('created='));
    assert.ok(content.includes('instance='));

    assert.deepEqual(await recorder.close({ remove: true }), { cacheRemoved: true });
    assert.equal(existsSync(recorder.path), false);
  });

  it('records a normal round and returns a bounded summary with the cache range', async () => {
    const root = caseRoot('round');
    const recorder = await ReadableRecorder.create(identity(), root);

    assert.equal(recorder.beginRound(), 'R1');
    recorder.recordLine(line('hello'));
    recorder.recordLine(line('world'));
    const result = await recorder.endRound(7);

    assert.equal(result.round, 'R1');
    assert.equal(result.exitCode, 7);
    assert.equal(result.output, 'hello\nworld\n');
    assert.equal(result.outputCharacters, 12);
    assert.equal(result.outputOmitted, false);
    assert.deepEqual(result.cacheRange, { beginMarker: 'ROUND R1 BEGIN', endMarker: 'ROUND R1 END' });

    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('[ROUND R1 BEGIN]'));
    assert.ok(content.includes('[OUTPUT R1]'));
    assert.ok(content.includes('| hello\n| world\n'));
    assert.ok(content.includes('[ROUND R1 END] exitCode=7'));
    await recorder.close({ remove: true });
  });

  it('draws the 1000-code-point boundary exactly while persisting the full body', async () => {
    const root = caseRoot('codepoints');
    const recorder = await ReadableRecorder.create(identity(), root);

    recorder.beginRound();
    const thousand = '中'.repeat(1000);
    recorder.recordLine(line(thousand, { newline: false }));
    const atLimit = await recorder.endRound(0);
    assert.equal(atLimit.outputCharacters, 1000);
    assert.equal(atLimit.outputOmitted, false);
    assert.equal(atLimit.output, thousand);

    recorder.beginRound();
    const overLimit = '中'.repeat(1001);
    recorder.recordLine(line(overLimit, { newline: false }));
    const omitted = await recorder.endRound(0);
    assert.equal(omitted.outputCharacters, 1001);
    assert.equal(omitted.outputOmitted, true);
    assert.equal(omitted.output, null);

    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes(overLimit), 'the full over-limit body is still on disk');
    await recorder.close({ remove: true });
  });

  it('counts emoji by code point rather than UTF-16 units', async () => {
    const root = caseRoot('emoji');
    const recorder = await ReadableRecorder.create(identity(), root);
    const emoji = '😀'.repeat(1000); // 1000 code points, 2000 UTF-16 units

    recorder.beginRound();
    recorder.recordLine(line(emoji, { newline: false }));
    const result = await recorder.endRound(0);

    assert.equal(result.outputCharacters, 1000);
    assert.equal(result.outputOmitted, false);
    assert.equal(result.output, emoji);

    recorder.beginRound();
    const emojiOver = '😀'.repeat(1001);
    recorder.recordLine(line(emojiOver, { newline: false }));
    const omitted = await recorder.endRound(0);
    assert.equal(omitted.outputCharacters, 1001);
    assert.equal(omitted.outputOmitted, true);
    assert.equal(omitted.output, null);
    assert.ok((await readFile(recorder.path, 'utf8')).includes(emojiOver));
    await recorder.close({ remove: true });
  });

  it('keeps many lines intact and joins soft-wrapped lines without LF', async () => {
    const root = caseRoot('many');
    const recorder = await ReadableRecorder.create(identity(), root);
    const total = 5000;

    recorder.beginRound();
    for (let index = 0; index < total; index += 1) {
      recorder.recordLine(line(`line-${String(index).padStart(4, '0')}`));
    }
    recorder.recordLine(line('soft-', { wrapped: true }));
    recorder.recordLine(line('joined'));
    const result = await recorder.endRound(0);

    assert.equal(result.outputOmitted, true);
    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('| line-0000\n'));
    assert.ok(content.includes(`| line-${String(total - 1).padStart(4, '0')}\n`));
    assert.ok(content.includes('| soft-joined\n'), 'soft wrap joins without an LF');
    const intact = content.split('\n').filter((row) => row.startsWith('| line-'));
    assert.equal(intact.length, total);
    await recorder.close({ remove: true });
  });

  it('records action kinds and keys without mirroring text or paste values', async () => {
    const root = caseRoot('steps');
    const recorder = await ReadableRecorder.create(identity(), root);

    recorder.beginRound();
    const step = recorder.recordStep([
      { type: 'text', text: 'super-secret-token' },
      { type: 'paste', text: 'hunter2-password' },
      { type: 'key', key: 'ENTER' },
    ]);
    assert.equal(step, 'S1');
    await recorder.endRound(0);

    const content = await readFile(recorder.path, 'utf8');
    assert.ok(!content.includes('super-secret-token'), 'text payload must not be mirrored');
    assert.ok(!content.includes('hunter2-password'), 'paste payload must not be mirrored');
    assert.ok(content.includes('type=text'));
    assert.ok(content.includes('type=paste'));
    assert.ok(content.includes('key=ENTER'));
    await recorder.close({ remove: true });
  });

  it('records readable screen frames with cursor and style metadata', async () => {
    const root = caseRoot('frames');
    const recorder = await ReadableRecorder.create(identity(), root);
    const snapshot = screen({
      revision: 3,
      buffer: 'alternate',
      cursor: { x: 4, y: 1 },
      lines: ['menu', '> item'],
      styles: [
        {
          row: 1,
          start: 0,
          end: 1,
          style: {
            bold: true,
            italic: false,
            dim: false,
            underline: false,
            inverse: false,
            invisible: false,
            strikethrough: false,
            foreground: { mode: 'palette', value: 2 },
            background: { mode: 'default', value: 0 },
          },
        },
      ],
    });

    recorder.recordFrame(snapshot, 'main menu');
    recorder.recordFrame(snapshot); // identical frame is deduplicated
    await recorder.flush();
    await recorder.close({ remove: false });

    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('[SCREEN F1] revision=3 buffer=alternate cols=80 rows=24 cursor=(4,1)'));
    assert.ok(content.includes('label=main_menu'));
    assert.ok(content.includes('~ [0] menu'));
    assert.ok(content.includes('~ [1] > item'));
    assert.ok(content.includes('attrs=bold fg=palette:2'));
    assert.ok(content.includes('[SCREEN F2]') && content.includes('duplicate=1'));
    await unlink(recorder.path);
  });

  it('isolates overlapping instances for the same endpoint and codename', async () => {
    const root = caseRoot('instances');
    const first = await ReadableRecorder.create(identity(), root);
    const second = await ReadableRecorder.create(identity(), root);

    assert.notEqual(first.path, second.path);
    assert.ok(existsSync(first.path) && existsSync(second.path));
    assert.ok((await readFile(first.path, 'utf8')).includes('instance='));
    assert.ok((await readFile(second.path, 'utf8')).includes('instance='));

    await first.close({ remove: true });
    await second.close({ remove: true });
  });

  it('deletes only its own exact path on close', async () => {
    const root = caseRoot('delete');
    const keep = await ReadableRecorder.create(identity(), root);
    const drop = await ReadableRecorder.create(identity(), root);
    await keep.flush();
    await drop.flush();
    const keepPath = keep.path;
    const dropPath = drop.path;

    assert.deepEqual(await drop.close({ remove: true }), { cacheRemoved: true });
    assert.equal(existsSync(dropPath), false);
    assert.ok(existsSync(keepPath), 'the sibling instance file must be untouched');

    await keep.close({ remove: true });
    assert.ok(existsSync(SENTINEL), 'foreign sentinel must be untouched');
  });

  it('reports CACHE_DELETE_FAILED and keeps the file when deletion fails', async () => {
    const root = caseRoot('deletefail');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.recordLine(line('before failure'));
    await recorder.flush();

    const ownedPath = recorder.path;
    const movedPath = `${ownedPath}.moved`;
    // Replace the owned path with a directory so unlink cannot succeed on any OS.
    await rename(ownedPath, movedPath);
    await mkdir(ownedPath);

    const result = await recorder.close({ remove: true });
    assert.equal(result.cacheRemoved, false);
    assert.match(result.cleanupError ?? '', /CACHE_DELETE_FAILED/);
    assert.ok(existsSync(ownedPath), 'the retained path stays visible for inspection');

    await rmdir(ownedPath);
    await unlink(movedPath);
  });

  it('fails visibly when the bounded write budget is exceeded', async () => {
    const root = caseRoot('budget');
    const recorder = await ReadableRecorder.create(identity(), root);

    const oversized = 'x'.repeat(DEFAULT_MAX_PENDING_BYTES + 1024);
    recorder.recordLine(line(oversized, { newline: false }));

    await assert.rejects(recorder.flush(), (error: unknown) => {
      assert.ok(error instanceof LiteSshError);
      assert.equal((error as LiteSshError).code, 'CACHE_WRITE_FAILED');
      assert.ok(Number((error as LiteSshError).details.droppedBytes) > 0, 'dropped bytes are accounted for');
      return true;
    });

    assert.deepEqual(await recorder.close({ remove: false }), { cacheRemoved: false });
    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('[CACHE ERROR] CACHE_WRITE_FAILED'), 'failure notice is visible on disk');
    assert.ok(content.includes('dropped_bytes='), 'notice states how much was dropped');
    await unlink(recorder.path);
  });

  // --- P2: metadata boundaries vs. soft-wrapped / partial data rows ---------

  it('puts the END marker on its own physical line after a partial row, without counting the boundary LF', async () => {
    const root = caseRoot('boundary-end');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.beginRound();
    recorder.recordLine(line('foo', { newline: false }));
    const result = await recorder.endRound(0);

    assert.equal(result.output, 'foo');
    assert.equal(result.outputCharacters, 3, 'the inserted boundary LF is not part of the logical body');
    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('| foo\n[ROUND R1 END] exitCode=0\n'), 'END owns its own line');
    assert.ok(!content.includes('foo[ROUND'), 'the marker is never glued onto a partial data row');
    await recorder.close({ remove: true });
  });

  it('resets the data prefix after intervening frame/step metadata', async () => {
    const root = caseRoot('boundary-mixed');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.beginRound();
    recorder.recordLine(line('foo', { newline: false }));
    recorder.recordFrame(screen({ revision: 1, lines: ['a'] }));
    recorder.recordStep([{ type: 'key', key: 'ENTER' }]);
    recorder.recordLine(line('bar'));
    await recorder.flush();
    await recorder.close({ remove: false });

    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('| foo\n'), 'partial row is terminated before metadata');
    assert.ok(content.includes('\n[SCREEN F1]'), 'frame starts on its own line');
    assert.ok(content.includes('\n[STEP S1]'), 'step starts on its own line');
    assert.ok(content.includes('| bar\n'), 'data after metadata is prefixed again');
    assert.ok(!content.includes('foo[SCREEN') && !content.includes('foo[STEP'), 'no glued markers');
    await unlink(recorder.path);
  });

  it('preserves normal stdout logical concatenation (no LF) when no metadata intervenes', async () => {
    const root = caseRoot('logical-join');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.beginRound();
    recorder.recordLine(line('foo', { newline: false }));
    recorder.recordLine(line('bar', { newline: false }));
    const result = await recorder.endRound(0);

    assert.equal(result.output, 'foobar');
    assert.equal(result.outputCharacters, 6);
    assert.ok((await readFile(recorder.path, 'utf8')).includes('| foobar\n[ROUND R1 END]'));
    await recorder.close({ remove: true });
  });

  // --- markCommandStarted: pre-execution echo vs. trusted BEGIN -----------

  it('excludes pre-execution echo from the summary while keeping it in the cache', async () => {
    const root = caseRoot('mark-started');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.beginRound();
    // The session reserved R1 before the user Enter submission; a shell syntax
    // error is echoed and cached under the round before any trusted BEGIN.
    recorder.recordLine(line('bash: syntax error near unexpected token'));
    recorder.markCommandStarted(); // trusted BEGIN arrives
    recorder.recordLine(line('actual output'));
    const result = await recorder.endRound(1);

    assert.equal(result.round, 'R1', 'round id is unchanged');
    assert.equal(result.output, 'actual output\n', 'summary covers only actual output');
    assert.equal(result.outputCharacters, 'actual output\n'.length);
    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('| bash: syntax error near unexpected token\n'), 'echo stays in the cache');
    assert.ok(content.includes('[SHELL COMMAND BEGIN]\n'), 'trusted BEGIN metadata is written');
    assert.ok(content.includes('| actual output\n'));
    await recorder.close({ remove: true });
  });

  it('retains the readable error preview when no trusted BEGIN arrives', async () => {
    const root = caseRoot('mark-nobegin');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.beginRound();
    const echo = 'bash: syntax error near unexpected token';
    recorder.recordLine(line(echo));
    const result = await recorder.endRound(2); // parser-rejected input: nonzero exit

    assert.equal(result.output, `${echo}\n`, 'error body is retained in the preview');
    assert.equal(result.outputCharacters, `${echo}\n`.length);
    assert.equal(result.exitCode, 2);
    assert.ok(!(await readFile(recorder.path, 'utf8')).includes('[SHELL COMMAND BEGIN]'));
    await recorder.close({ remove: true });
  });

  it('terminates a partial echo row before the BEGIN marker and re-prefixes later data', async () => {
    const root = caseRoot('mark-partial');
    const recorder = await ReadableRecorder.create(identity(), root);
    recorder.beginRound();
    recorder.recordLine(line('partial-echo', { newline: false }));
    recorder.markCommandStarted();
    recorder.recordLine(line('out'));
    const result = await recorder.endRound(0);

    assert.equal(result.output, 'out\n', 'partial echo is excluded from the summary');
    const content = await readFile(recorder.path, 'utf8');
    assert.ok(content.includes('| partial-echo\n[SHELL COMMAND BEGIN]\n'), 'echo row is terminated before the marker');
    assert.ok(content.includes('| out\n'), 'data after the marker is prefixed again');
    await recorder.close({ remove: true });
  });

  // --- P1: a failing disk write must settle, never hang ----------------------

  it('close() resolves without hanging when cache writes fail', async () => {
    const root = caseRoot('closefail');
    const recorder = await ReadableRecorder.createWithHandle(
      fakeHandle(1), // header write succeeds; every later write throws EIO
      join(root, 'fake.context.log'),
      identity(),
    );
    recorder.beginRound();
    recorder.recordLine(line('x'));
    recorder.recordLine(line('y'));

    await assert.rejects(settlesWithin(recorder.flush()), { code: 'CACHE_WRITE_FAILED' });
    const result = await settlesWithin(recorder.close({ remove: false }));
    assert.equal(result.cacheRemoved, false);
  });
});

describe('BoundedWriteQueue failure handling', () => {
  it('discards the backlog and rejects all waiters when a disk write fails', async () => {
    const queue = new BoundedWriteQueue(fakeHandle(0), 1 << 20);
    // Queue three buffers synchronously: the first is written, the other two
    // remain pending when the write fails. An already-awaited flush must settle.
    queue.enqueue('a'.repeat(64));
    queue.enqueue('b'.repeat(64));
    queue.enqueue('c'.repeat(64));
    const first = queue.flush();
    const second = queue.flush();

    await assert.rejects(settlesWithin(first), (error: unknown) => {
      assert.ok(error instanceof LiteSshError);
      assert.equal((error as LiteSshError).code, 'CACHE_WRITE_FAILED');
      assert.equal(Number((error as LiteSshError).details.droppedChunks), 3, 'failed buffer + backlog counted');
      assert.ok(Number((error as LiteSshError).details.droppedBytes) >= 192);
      return true;
    });
    await assert.rejects(settlesWithin(second), { code: 'CACHE_WRITE_FAILED' });
    // A later flush settles immediately (rejects) instead of hanging forever.
    await assert.rejects(settlesWithin(queue.flush()), { code: 'CACHE_WRITE_FAILED' });
    // Late enqueues after failure are accounted for, never silently dropped.
    queue.enqueue('late');
    await assert.rejects(settlesWithin(queue.flush()), { code: 'CACHE_WRITE_FAILED' });
  });

  it('raises the visible failure notice even when the notice write itself fails', async () => {
    const queue = new BoundedWriteQueue(fakeHandle(0), 1 << 20);
    queue.enqueue('payload');
    await assert.rejects(settlesWithin(queue.flush()), { code: 'CACHE_WRITE_FAILED' });
  });
});


it('R01 a failed initial cache header closes its handle and removes only its owned file', async () => {
  const root = caseRoot('r01-header-failure');
  await mkdir(root, { recursive: true });
  const owned = join(root, 'owned.context.log');
  const sibling = join(root, 'sibling.txt');
  await writeFile(owned, '', { flag: 'wx' });
  await writeFile(sibling, 'keep sibling\n', { flag: 'wx' });
  let closed = false;
  const handle = {
    write: async () => { throw Object.assign(new Error('fixture header EIO'), { code: 'EIO' }); },
    close: async () => { closed = true; },
  } as unknown as FileHandle;
  try {
    await assert.rejects(ReadableRecorder.createWithHandle(handle, owned, identity()), error => error instanceof LiteSshError && error.code === 'CACHE_WRITE_FAILED');
    assert.equal(closed, true, 'the factory is the cleanup owner even before a session exists');
    assert.equal(existsSync(owned), false);
    assert.equal(await readFile(sibling, 'utf8'), 'keep sibling\n');
  } finally {
    // Rescue only this fixture on the pre-fix baseline; no foreign path is swept.
    if (existsSync(owned)) await unlink(owned);
  }
});
