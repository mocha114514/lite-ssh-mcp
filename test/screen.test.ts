/**
 * Unit tests for ScreenModel (M0, local only).
 *
 * These exercise the emulator-backed model directly with in-memory bytes: no
 * real remote host, key, or user rc file is involved. They cover snapshot
 * shape, readable-line capture (including eviction and one huge wrapped line),
 * CR overwrite visibility, marker authentication, partial-line flushing before
 * END, reply forwarding, styles/modes, and lifecycle.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import headless from '@xterm/headless';

import { LiteSshError } from '../src/core/errors.js';
import type { ParsedLine, ShellMarker } from '../src/core/types.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { ScreenModel } from '../src/terminal/screen.js';
import { createShellMarkers } from './helpers/shell-markers.js';

const NONCE = 'm0-test-nonce';

test('R01 BEGIN flushes pre-execution echo before resetting the command body', async () => {
  const h = harness(80, 3);
  const markers = createShellMarkers(NONCE, 1);
  try {
    await h.model.write('prompt$ typed-echo' + markers.begin() + 'OK\r\n' + markers.end(0, true));
    assert.ok(h.events.indexOf('line:prompt$ typed-echo:true') < h.events.indexOf('marker:begin'));
    assert.deepEqual(h.lines.map(line => line.text), ['prompt$ typed-echo', 'OK']);
  } finally { h.model.dispose(); }
});

test('R01 resize preserves partial-line dedup across normal-buffer reflow', async () => {
  const h = harness(10, 2);
  try {
    await h.model.write('01234567890123456789');
    h.model.flushLine();
    h.model.resize(30, 3);
    await h.model.write('XYZ\r\n');
    assert.equal(h.lines.map(line => line.text).join(''), '01234567890123456789XYZ');
  } finally { h.model.dispose(); }
});

test('R01 alternate-buffer wraps retain every glyph before no-scrollback eviction', async () => {
  const h = harness(10, 3);
  const payload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  try {
    await h.model.write('\x1b[?1049h' + payload);
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text).join(''), payload);
  } finally { h.model.dispose(); }
});

test('R01 a trailing CR moves the cursor now without duplicating a later CRLF', async () => {
  const h = harness(10, 3);
  try {
    const snapshot = await h.model.write('ABCDEF\r');
    assert.equal(snapshot.cursor.x, 0);
    await h.model.write('\n');
    assert.deepEqual(h.lines.map(line => line.text), ['ABCDEF']);
  } finally { h.model.dispose(); }
});

test('R01 cursor-addressed TUI overwrites retain ordered styled frames even in one packet', async () => {
  const frames: ReturnType<ScreenModel['snapshot']>[] = [];
  const model = new ScreenModel({ nonce: NONCE, cols: 20, rows: 3, onFrame: frame => frames.push(frame) });
  try {
    await model.write('\x1b[?1049h\x1b[H\x1b[31mfirst\x1b[H\x1b[32msecond\x1b[?1049l');
    const first = frames.findIndex(frame => frame.lines.some(line => line.includes('first')));
    const second = frames.findIndex(frame => frame.lines.some(line => line.includes('second')));
    assert.ok(first >= 0 && second > first);
    assert.ok(frames[first]!.styles.length > 0);
    assert.ok(frames[second]!.styles.length > 0);
  } finally { model.dispose(); }
});

test('R02 cursor-only CSI does not append the unchanged body again', async () => {
  const h = harness();
  try {
    await h.model.write('ABC\x1b[1C\r\n');
    h.model.flushLine();
    const body = h.lines.map(line => line.text + (line.newline ? '\n' : '')).join('');
    assert.equal(body, 'ABC\n');
    assert.equal([...body].length, 4);
  } finally { h.model.dispose(); }
});

test('R02 cursor-only CSI keeps a wrapped 501-character body below the preview limit', async () => {
  const h = harness();
  try {
    await h.model.write('x'.repeat(501) + '\x1b[1C\r\n');
    h.model.flushLine();
    const body = h.lines.map(line => line.text + (line.newline ? '\n' : '')).join('');
    assert.equal(body, 'x'.repeat(501) + '\n');
    assert.equal([...body].length, 502);
  } finally { h.model.dispose(); }
});

test('R02 backward cursor addressing records changed earlier cells but not unchanged later rows', async () => {
  const h = harness();
  const markers = createShellMarkers(NONCE, 1);
  try {
    await h.model.write('ABC\r\nDEF\x1b[1;1HXYZ\r\n' + markers.end(0, true));
    h.model.flushLine();
    const body = h.lines.map(line => line.text + (line.newline ? '\n' : '')).join('');
    assert.ok(body.includes('XYZ'), 'the old last-row threshold must not hide the rewritten earlier row');
    assert.equal(body.split('ABC').length - 1, 1);
    assert.equal(body.split('DEF').length - 1, 1, 'LF must not forget the unchanged addressed-row baseline');
    assert.equal(body.split('XYZ').length - 1, 1);
  } finally { h.model.dispose(); }
});

test('R02 dedup of cursor-only movement retains styled frames and actual cursor coordinates', async () => {
  const lines: ParsedLine[] = [];
  const frames: ReturnType<ScreenModel['snapshot']>[] = [];
  const markers = createShellMarkers(NONCE, 1);
  const model = new ScreenModel({ nonce: NONCE, cols: 20, rows: 3,
    onLine: line => lines.push(line), onFrame: frame => frames.push(frame) });
  try {
    const snapshot = await model.write('\x1b[31mABC\x1b[1C' + markers.end(0, true));
    assert.equal(lines.map(line => line.text).join(''), 'ABC');
    assert.ok(frames.some(frame => frame.lines[0] === 'ABC' && frame.styles.length > 0));
    assert.deepEqual(snapshot.cursor, { x: 4, y: 0 });
    assert.ok(snapshot.styles.length > 0);
  } finally { model.dispose(); }
});

test('R02 character erase followed by identical glyphs remains genuinely new body', async () => {
  const h = harness();
  try {
    await h.model.write('ABC\x1b[1G\x1b[3XABC\r\n');
    const body = h.lines.map(line => line.text + (line.newline ? '\n' : '')).join('');
    assert.equal(body, 'ABCABC\n', 'ECH must invalidate the pre-addressed prefix just like other real erases');
  } finally { h.model.dispose(); }
});

for (const final of ['X', 'P', '@']) {
  test(`R02 character edit ${final} over unused padding does not repeat occupied body`, async () => {
    const h = harness();
    try {
      await h.model.write(`ABC\x1b[${final}\r\n`);
      h.model.flushLine();
      assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABC\n');
    } finally { h.model.dispose(); }
  });
}

test('R02 ECH over unused padding leaves a wrapped 501-character body below the preview limit', async () => {
  const h = harness();
  try {
    await h.model.write('x'.repeat(501) + '\x1b[X\r\n');
    h.model.flushLine();
    const body = h.lines.map(line => line.text + (line.newline ? '\n' : '')).join('');
    assert.equal(body, 'x'.repeat(501) + '\n');
    assert.equal([...body].length, 502);
  } finally { h.model.dispose(); }
});

test('R02 ECH range ending before a later occupied cell keeps unchanged body dedup', async () => {
  const h = harness();
  try {
    await h.model.write('ABC\x1b[6GZ\x1b[4G\x1b[X\r\n');
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABC  Z\n');
  } finally { h.model.dispose(); }
});

test('R02 printed spaces erased and rewritten are occupied output, not unused padding', async () => {
  const h = harness();
  try {
    await h.model.write('ABC   \x1b[4G\x1b[3X   \r\n');
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABC   ABC   \n');
  } finally { h.model.dispose(); }
});

for (const split of [false, true]) {
  test(`R03 RIS discards old normal-row prefixes (${split ? 'split ESC/c' : 'one packet'})`, async () => {
    const h = harness();
    try {
      if (split) {
        await h.model.write('ABC\r\nABC\x1b[1C\x1b');
        await h.model.write('cABC\r\n');
      } else await h.model.write('ABC\r\nABC\x1b[1C\x1bcABC\r\n');
      h.model.flushLine();
      assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABC\nABCABC\n');
    } finally { h.model.dispose(); }
  });
}

test('R03 RIS captures the outgoing alternate text and styled frame before native reset', async () => {
  const lines: ParsedLine[] = [];
  const frames: { screen: ReturnType<ScreenModel['snapshot']>; label?: string }[] = [];
  const model = new ScreenModel({ nonce: NONCE, onLine: line => lines.push(line), onMarker: () => {},
    onFrame: (screen, label) => frames.push({ screen, label }) });
  try {
    await model.write('NORMAL\r\n\x1b[?1049h\x1b[31mALT\x1bcAFTER\r\n');
    model.flushLine();
    assert.equal(lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'NORMAL\nALTAFTER\n');
    const resetFrame = frames.find(frame => frame.label === 'reset');
    assert.equal(resetFrame?.screen.buffer, 'alternate');
    assert.ok(resetFrame?.screen.styles.length);
    assert.ok(resetFrame?.screen.lines.some(line => line.includes('ALT')));
    assert.equal(model.snapshot().buffer, 'normal');
    assert.equal(model.snapshot().styles.length, 0);
  } finally { model.dispose(); }
});

for (const [name, parts] of [
  ['CR', ['ABC\r\x1bc']],
  ['BS', ['ABC\b\x1bc']],
  ['split CR', ['ABC\r', '\x1bc']],
  ['CR then nonprinting SGR', ['ABC\r\x1b[31m\x1bc']],
] as const) {
  test(`R03 RIS does not recapture unchanged text already preserved before ${name}`, async () => {
    const h = harness();
    try {
      for (const part of parts) await h.model.write(part);
      h.model.flushLine();
      assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABC');
    } finally { h.model.dispose(); }
  });
}

test('R03 actual same-glyph replacement after CR remains new text before RIS', async () => {
  const h = harness();
  try {
    await h.model.write('ABC\rABC\x1bc');
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABCABC');
  } finally { h.model.dispose(); }
});

for (const [name, restore] of [['ESC save/restore', '\x1b7ABC\x1b8'], ['CSI save/restore', '\x1b[sABC\x1b[u']] as const) {
  test(`R03 rewritten same glyphs remain new after ${name} before RIS`, async () => {
    const h = harness();
    try {
      await h.model.write('ABC\r' + restore + '\x1bc');
      h.model.flushLine();
      assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABCABC');
    } finally { h.model.dispose(); }
  });
}

test('R03 CR followed by fragmented ESC/c keeps its clean checkpoint until native reset', async () => {
  const h = harness();
  try {
    for (const part of ['ABC\r', '\x1b', 'c']) await h.model.write(part);
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABC');
  } finally { h.model.dispose(); }
});

test('R03 clean normal rewrite checkpoint survives a non-destructive alternate round trip', async () => {
  const h = harness();
  try {
    await h.model.write('ABC\r\x1b[?1049hALT\x1b[?1049l\x1bc');
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABCALT');
  } finally { h.model.dispose(); }
});

for (const [name, input, expected] of [
  ['CR', '\x1b[?1049hABC\rXYZ\x1b[?1049l', 'ABCXYZ'],
  ['CR with a dormant normal checkpoint', 'NORMAL\r\x1b[?1049hABC\rXYZ\x1b[?1049l', 'NORMALABCXYZ'],
  ['BS with an occupied suffix', '\x1b[?1049hABCDE\b\b\bXYZ\x1b[?1049l', 'ABCDEABXYZ'],
] as const) {
  test(`R03 ALT checkpoint coalesces the final replacement after ${name}`, async () => {
    const h = harness();
    try {
      await h.model.write(input);
      h.model.flushLine();
      assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), expected);
    } finally { h.model.dispose(); }
  });
}

for (const normalCheckpoint of [false, true]) {
  test(`R03 discarded ALT checkpoint restores native batching; normal checkpoint=${normalCheckpoint}`, { timeout: 15_000 }, async () => {
    const h = harness();
    const originalWrite = headless.Terminal.prototype.write;
    let nativeWrites = 0;
    // Count the public native API, not private emulator fields or wall time.
    // This file runs these owned models sequentially; restore the prototype.
    headless.Terminal.prototype.write = function(data, callback) {
      nativeWrites++;
      return originalWrite.call(this, data, callback);
    };
    try {
      await h.model.write((normalCheckpoint ? 'NORMAL\r' : '') + '\x1b[?1049hALT\r\x1b[?1049l');
      nativeWrites = 0;
      const text = 'N'.repeat(160);
      await h.model.write(text);
      h.model.flushLine();
      assert.equal(nativeWrites, normalCheckpoint ? 1 + Math.ceil((text.length - 1) / 80) : Math.ceil(text.length / 80));
      assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), (normalCheckpoint ? 'NORMAL' : '') + 'ALT' + text);
    } finally {
      headless.Terminal.prototype.write = originalWrite;
      h.model.dispose();
    }
  });
}

test('R03 dormant normal checkpoint keeps ALT soft-wrap output before no-scrollback eviction', { timeout: 15_000 }, async () => {
  const h = harness(16, 4);
  const text = '0123456789'.repeat(16);
  try {
    await h.model.write('N\r\x1b[?1049h' + text + '\x1b[?1049l\x1bc');
    h.model.flushLine();
    assert.equal(h.lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'N' + text);
  } finally { h.model.dispose(); }
});

interface Harness {
  model: ScreenModel;
  lines: ParsedLine[];
  markers: ShellMarker[];
  replies: string[];
  events: string[];
}

function harness(cols = 80, rows = 24): Harness {
  const lines: ParsedLine[] = [];
  const markers: ShellMarker[] = [];
  const replies: string[] = [];
  const events: string[] = [];
  const model = new ScreenModel({
    nonce: NONCE,
    cols,
    rows,
    onLine: (line) => {
      lines.push(line);
      events.push(`line:${line.text}:${line.wrapped}`);
    },
    onMarker: (marker) => {
      markers.push(marker);
      events.push(`marker:${marker.kind}`);
    },
    onReply: (data) => replies.push(data),
  });
  return { model, lines, markers, replies, events };
}

test('snapshot exposes the documented shape', async () => {
  const h = harness(20, 5);
  const snapshot = await h.model.write('hello');
  assert.equal(snapshot.cols, 20);
  assert.equal(snapshot.rows, 5);
  assert.equal(snapshot.buffer, 'normal');
  assert.deepEqual(snapshot.cursor, { x: 5, y: 0 });
  assert.equal(snapshot.lines[0], 'hello');
  assert.deepEqual(snapshot.modes, {
    bracketedPaste: false,
    applicationCursorKeys: false,
    applicationKeypad: false,
  });
  assert.ok(snapshot.revision >= 1);
  assert.ok(Array.isArray(snapshot.styles));
  h.model.dispose();
});

test('captures each LF-terminated line exactly once, including blank lines', async () => {
  const h = harness();
  await h.model.write('one\r\ntwo\r\n\r\nthree\r\n');
  assert.deepEqual(
    h.lines.map((l) => l.text),
    ['one', 'two', '', 'three'],
  );
  assert.deepEqual(h.lines.map((l) => l.wrapped), [false, false, false, false]);
  assert.ok(h.lines.every((l) => l.buffer === 'normal'));
  h.model.dispose();
});

test('reassembles one very long soft-wrapped line without loss', async () => {
  const h = harness(10, 5);
  const payload = 'x'.repeat(45);
  await h.model.write(payload + '\r\n');
  const joined = h.lines.map((l) => l.text).join('');
  assert.equal(joined, payload);
  // Every record but the final terminating fragment is a no-LF continuation.
  assert.ok(h.lines.length >= 2);
  assert.equal(h.lines.at(-1)?.wrapped, false);
  assert.ok(h.lines.slice(0, -1).every((l) => l.wrapped === true));
  h.model.dispose();
});

test('captures every line before scrollback eviction in a single packet', async () => {
  const h = harness(80, 24);
  const total = 4000; // far beyond the default 1000-line scrollback
  const blob = Array.from({ length: total }, (_, i) => `line-${i}`).join('\r\n') + '\r\n';
  await h.model.write(blob);
  assert.equal(h.lines.length, total);
  assert.equal(h.lines[0]?.text, 'line-0');
  assert.equal(h.lines.at(-1)?.text, `line-${total - 1}`);
  h.model.dispose();
});

test('captures a single line longer than the scrollback without loss', async () => {
  const h = harness(10, 5);
  // 30000 columns over 10-wide rows is ~3000 rows, well past scrollback+rows.
  const payload = Array.from({ length: 3000 }, (_, i) => String(i % 10)).join('');
  await h.model.write(payload + '\r\n');
  const joined = h.lines.map((l) => l.text).join('');
  assert.equal(joined, payload);
  assert.equal(h.lines.at(-1)?.wrapped, false);
  h.model.dispose();
});

test('a CR overwrite keeps the old text and the final readable text', async () => {
  const h = harness();
  await h.model.write('abc\rXY\r\n');
  // The pre-CR text is captured as a continuation (no extra newline) and the
  // overwritten row follows as the terminated readable text.
  assert.deepEqual(h.lines.map((l) => l.text), ['abc', 'XYc']);
  assert.deepEqual(h.lines.map((l) => l.wrapped), [true, false]);
  // The CRLF line still ends exactly once (one terminating record).
  assert.equal(h.lines.filter((l) => l.wrapped === false).length, 1);
  h.model.dispose();
});

test('a backspace overwrite keeps the old text and the final readable text', async () => {
  const h = harness();
  await h.model.write('abc\x08X');
  assert.deepEqual(h.lines.map((l) => l.text), ['abc', 'abX']);
  assert.ok(h.lines.every((l) => l.wrapped === true));
  assert.equal(h.model.snapshot().lines[0], 'abX');
  h.model.dispose();
});

test('one chunk with text, erase and END retains the text and reports a frame', async () => {
  const lines: ParsedLine[] = [];
  const frames: { label?: string; first: string }[] = [];
  const markers = createShellMarkers(NONCE, 1);
  const model = new ScreenModel({
    nonce: NONCE,
    cols: 80,
    rows: 24,
    onLine: (line) => lines.push(line),
    onFrame: (screen, label) => frames.push({ label, first: screen.lines[0] ?? '' }),
  });
  // `CSI 2J` erases the screen and `CSI H` homes the cursor; the text has no LF.
  await model.write('abc\x1b[2J\x1b[H');
  await model.write(markers.end(0, true));
  assert.deepEqual(lines.map((l) => l.text).join(''), 'abc');
  const erase = frames.find((f) => f.label?.startsWith('erase'));
  assert.ok(erase, 'a pre-erase frame is reported');
  assert.equal(erase.first, 'abc');
  assert.equal(model.snapshot().lines[0], '');
  model.dispose();
});

test('a CR overwrite captures both the old and final readable state', async () => {
  const h = harness();
  await h.model.write('first\rsecond');
  // Old text and the final readable state are both captured, neither as a
  // logical newline.
  assert.deepEqual(h.lines.map((l) => l.text), ['first', 'second']);
  assert.ok(h.lines.every((l) => l.wrapped === true && l.newline === false));
  assert.equal(h.model.snapshot().lines[0], 'second');
  // A later completion appends only the new suffix, never the flushed prefix.
  await h.model.write('X\n');
  assert.equal(h.lines.map((l) => l.text).join(''), 'firstsecondX');
  h.model.dispose();
});

test('a plain CRLF line is not duplicated', async () => {
  const h = harness();
  await h.model.write('abc\r\n');
  assert.deepEqual(h.lines.map((l) => l.text), ['abc']);
  assert.deepEqual(h.lines.map((l) => l.wrapped), [false]);
  assert.equal(h.lines.filter((l) => l.wrapped === false).length, 1);
  h.model.dispose();
});

test('public snapshot shows overwritten content too', async () => {
  const h = harness();
  await h.model.write('first\rsecond');
  const snapshot = h.model.snapshot();
  assert.equal(snapshot.lines[0], 'second');
  h.model.dispose();
});

test('flushLine is idempotent and a later completion does not duplicate it', async () => {
  const h = harness();
  await h.model.write('prompt> ');
  h.model.flushLine();
  h.model.flushLine();
  assert.deepEqual(h.lines.map((l) => l.text), ['prompt> ']);
  assert.equal(h.lines[0]?.wrapped, true);
  assert.equal(h.lines[0]?.newline, false);
  await h.model.write('more\n');
  // The completion emits only the appended suffix plus the line terminator.
  assert.deepEqual(h.lines.map((l) => l.text), ['prompt> ', 'more']);
  assert.equal(h.lines.at(-1)?.wrapped, false);
  assert.equal(h.lines.at(-1)?.newline, true);
  h.model.dispose();
});

test('every record sets newline = !wrapped so partials carry no break', async () => {
  const h = harness(10, 5);
  const payload = 'x'.repeat(25); // soft-wraps across several rows
  await h.model.write(payload);
  h.model.flushLine(); // <- not-yet-terminated tail of every row
  await h.model.write('\r\n'); // completes the logical line
  for (const line of h.lines) assert.equal(line.newline, !line.wrapped);
  // The partial flush joins all rows, so the aggregate is the whole line.
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  assert.equal(h.lines.at(-1)?.wrapped, false);
  assert.equal(h.lines.at(-1)?.newline, true);
  const wrapped = h.lines.filter((l) => l.wrapped);
  assert.ok(wrapped.length >= 1);
  assert.ok(wrapped.every((l) => l.newline === false));
  h.model.dispose();
});

test('END flushes the current partial line before onMarker(end)', async () => {
  const h = harness();
  const markers = createShellMarkers(NONCE, 1);
  await h.model.write('typing');
  await h.model.write(markers.end(3, true));
  const lineIndex = h.events.findIndex((e) => e.startsWith('line:typing'));
  const endIndex = h.events.indexOf('marker:end');
  assert.ok(lineIndex >= 0, 'partial line should be flushed');
  assert.ok(endIndex > lineIndex, 'END marker should arrive after the flush');
  const end = h.markers.find((m) => m.kind === 'end');
  assert.deepEqual(end, { nonce: NONCE, kind: 'end', sequence: 1, exitCode: 3, hookHealthy: true });
  h.model.dispose();
});

test('decodes every marker kind with its nonce', async () => {
  const h = harness();
  await h.model.write(encodeMarkerOsc(NONCE, 'PROBE;bash'));
  await h.model.write(encodeMarkerOsc(NONCE, 'STTY;500:5:bf'));
  await h.model.write(encodeMarkerOsc(NONCE, 'READY;zsh'));
  await h.model.write(encodeMarkerOsc(NONCE, 'BEGIN;1'));
  await h.model.write(encodeMarkerOsc(NONCE, 'UNSUPPORTED;no-hooks'));
  assert.deepEqual(h.markers, [
    { nonce: NONCE, kind: 'probe', shell: 'bash' },
    { nonce: NONCE, kind: 'stty', value: '500:5:bf' },
    { nonce: NONCE, kind: 'ready', shell: 'zsh' },
    { nonce: NONCE, kind: 'begin', sequence: 1 },
    { nonce: NONCE, kind: 'unsupported', reason: 'no-hooks' },
  ]);
  h.model.dispose();
});

test('rejects wrong nonce, unknown events and malformed fields', async () => {
  const h = harness();
  await h.model.write(encodeMarkerOsc('other-nonce', 'BEGIN;1'));
  await h.model.write(encodeMarkerOsc(NONCE, 'BOGUS'));
  await h.model.write(encodeMarkerOsc(NONCE, 'END;1;not-a-number;1'));
  await h.model.write(encodeMarkerOsc(NONCE, 'READY;tcsh'));
  await h.model.write(encodeMarkerOsc(NONCE, 'PROBE;'));
  assert.equal(h.markers.length, 0);
  // Rejected sequences must not leak to the readable screen either.
  assert.equal(h.model.snapshot().lines[0], '');
  h.model.dispose();
});

test('forwards terminal-generated replies through onReply', async () => {
  const h = harness();
  await h.model.write('\x1b[c'); // DA1 query
  assert.ok(h.replies.length >= 1);
  assert.ok(h.replies[0]?.startsWith('\x1b['));
  h.model.dispose();
});

test('reflects bracketed-paste and application cursor/keypad modes', async () => {
  const h = harness();
  await h.model.write('\x1b[?2004h\x1b[?1h\x1b[?66h');
  const snapshot = h.model.snapshot();
  assert.equal(snapshot.modes.bracketedPaste, true);
  assert.equal(snapshot.modes.applicationCursorKeys, true);
  assert.equal(snapshot.modes.applicationKeypad, true);
  h.model.dispose();
});

test('exposes compressed non-default style runs', async () => {
  const h = harness();
  await h.model.write('\x1b[1;31mR\x1b[0m');
  const span = h.model.snapshot().styles.find((s) => s.row === 0 && s.start === 0);
  assert.ok(span);
  assert.equal(span.end, 1);
  assert.equal(span.style.bold, true);
  assert.deepEqual(span.style.foreground, { mode: 'palette', value: 1 });
  h.model.dispose();
});

test('resize updates the reported geometry', async () => {
  const h = harness(80, 24);
  const snapshot = h.model.resize(120, 40);
  assert.equal(snapshot.cols, 120);
  assert.equal(snapshot.rows, 40);
  h.model.dispose();
});

test('revision advances only when the visible snapshot changes', async () => {
  const h = harness();
  const before = h.model.snapshot().revision;
  // Cursor visibility is not part of the public snapshot: no advance.
  const hidden = await h.model.write('\x1b[?25l');
  assert.equal(hidden.revision, before);
  // A window-title OSC is likewise not exposed.
  const titled = await h.model.write('\x1b]0;a-title\x07');
  assert.equal(titled.revision, before);
  // Real text changes the grid: advance.
  const written = await h.model.write('abc');
  assert.equal(written.revision, before + 1);
  // Rewriting the same cells with the same text renders identically: no advance.
  const identical = await h.model.write('\x1b[1;1Habc');
  assert.equal(identical.revision, written.revision);
  // Moving the cursor (an exposed field) is a real state change: advance.
  const moved = await h.model.write('\x1b[5;1H');
  assert.ok(moved.revision > written.revision);
  h.model.dispose();
});

test('a partial OSC sequence keeps the revision unchanged', async () => {
  const h = harness();
  const before = await h.model.write('ok');
  // A split marker never completes, so the grid does not change.
  const partial = await h.model.write('\x1b]777;LSSH;' + NONCE + ';BE');
  assert.equal(partial.revision, before.revision);
  // Completing it still changes nothing visible on the grid.
  const completed = await h.model.write('GIN;1\x07');
  assert.equal(completed.revision, before.revision);
  assert.equal(h.markers.at(-1)?.kind, 'begin');
  h.model.dispose();
});

test('an identical render on a later write keeps the revision', async () => {
  const h = harness();
  const first = await h.model.write('same');
  // Same text, but written after a carriage return to the same cells.
  const second = await h.model.write('\rsame');
  assert.equal(second.revision, first.revision);
  assert.equal(second.lines[0], 'same');
  h.model.dispose();
});

test('a real style change increments the revision', async () => {
  const h = harness();
  const plain = await h.model.write('X');
  const bold = await h.model.write('\x1b[1mY');
  assert.ok(bold.revision > plain.revision);
  assert.ok(bold.styles.length > 0);
  h.model.dispose();
});

test('a real mode change increments the revision', async () => {
  const h = harness();
  const off = await h.model.write('X');
  assert.equal(off.modes.bracketedPaste, false);
  const on = await h.model.write('\x1b[?2004h');
  assert.equal(on.modes.bracketedPaste, true);
  assert.ok(on.revision > off.revision);
  h.model.dispose();
});

test('marker callbacks fire even when the revision does not advance', async () => {
  const h = harness();
  const markers = createShellMarkers(NONCE, 1);
  const before = await h.model.write('ok');
  const after = await h.model.write(markers.end(7, true));
  assert.equal(after.revision, before.revision);
  assert.deepEqual(h.markers.at(-1), { nonce: NONCE, kind: 'end', sequence: 1, exitCode: 7, hookHealthy: true });
  h.model.dispose();
});

test('alt round-trip does not duplicate the restored normal line', async () => {
  const h = harness(80, 24);
  await h.model.write('prompt> ');
  // Enter and leave the alternate screen, then finish the normal line.
  await h.model.write('\x1b[?1049hALT\x1b[?1049l');
  await h.model.write('more\n');
  const joined = h.lines.map((l) => l.text).join('');
  assert.equal(joined, 'prompt> ' + '        ALT' + 'more');
  // The normal line contributes exactly once (partial + delta, no repeat).
  assert.equal(h.lines.filter((l) => l.buffer === 'normal').map((l) => l.text).join(''), 'prompt> more');
  h.model.dispose();
});

test('wide characters are preserved in rows and snapshots', async () => {
  const h = harness(10, 5);
  const snapshot = await h.model.write('中文abc\n');
  assert.equal(h.lines.map((l) => l.text).join(''), '中文abc');
  assert.equal(snapshot.lines[0], '中文abc');
  h.model.dispose();
});

test('alt-screen enter+text+exit in one chunk keeps the outgoing text and frame', async () => {
  const lines: ParsedLine[] = [];
  const frames: { label?: string; buffer: string; first: string; cursor: unknown; styles: number }[] = [];
  const model = new ScreenModel({
    nonce: NONCE,
    cols: 80,
    rows: 24,
    onLine: (line) => lines.push(line),
    onFrame: (screen, label) =>
      frames.push({ label, buffer: screen.buffer, first: screen.lines[0] ?? '', cursor: screen.cursor, styles: screen.styles.length }),
  });
  // One packet: enter the alternate screen, print with no LF, leave again.
  await model.write('\x1b[?1049h\x1b[1;31mlost_text\x1b[?1049l');
  // The outgoing text is captured before the destructive switch...
  assert.deepEqual(lines.map((l) => l.text), ['lost_text']);
  assert.equal(lines[0]?.buffer, 'alternate');
  // ...and reported as the outgoing frame with its style and cursor.
  const exit = frames.find((f) => f.label === 'alt-exit');
  assert.ok(exit, 'the outgoing alternate frame is reported');
  assert.equal(exit.buffer, 'alternate');
  assert.equal(exit.first, 'lost_text');
  assert.deepEqual(exit.cursor, { x: 9, y: 0 });
  assert.ok(exit.styles >= 1, 'the outgoing frame keeps its style runs');
  // The entered-from frame is also captured, and the final screen is normal.
  assert.ok(frames.some((f) => f.label === 'alt-enter' && f.buffer === 'normal'));
  assert.equal(model.snapshot().buffer, 'normal');
  model.dispose();
});

test('a 1201-character line with no LF is aggregated exactly before END', async () => {
  const h = harness(80, 24);
  const markers = createShellMarkers(NONCE, 1);
  const payload = 'A'.repeat(1201);
  await h.model.write(payload);
  await h.model.write(markers.end(0, true));
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  assert.equal(h.lines.map((l) => l.text).join('').length, 1201);
  assert.ok(h.lines.every((l) => l.wrapped === true));
  h.model.dispose();
});

test('a flush after scrolling does not duplicate the already-emitted prefix', async () => {
  const h = harness(10, 5);
  const markers = createShellMarkers(NONCE, 1);
  // 3000 columns over 10-wide rows is far past the 5-row screen: most rows are
  // flushed at scroll time, then the tail is completed with an END and an LF.
  const payload = Array.from({ length: 3000 }, (_, i) => String(i % 10)).join('');
  await h.model.write(payload);
  await h.model.write(markers.end(0, true));
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  await h.model.write('\r\n');
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  assert.equal(h.lines.at(-1)?.wrapped, false);
  h.model.dispose();
});

test('soft-wrap keeps printed spaces so a wide line is not collapsed', async () => {
  const h = harness(80, 24);
  const payload = 'x' + ' '.repeat(79) + 'y';
  const snapshot = await h.model.write(payload + '\n');
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  assert.equal(h.lines.map((l) => l.text).join('').length, 81);
  // The visible snapshot also preserves the occupied spaces on the wrapped row.
  assert.equal(snapshot.lines[0]?.length, 80);
  assert.equal(snapshot.lines[0], 'x' + ' '.repeat(79));
  h.model.dispose();
});

test('a 30000-character line with no LF survives scrollback eviction exactly', async () => {
  const h = harness(10, 5);
  const markers = createShellMarkers(NONCE, 1);
  // 3000 rows of 10 columns: far past the default 1000-line scrollback, so most
  // rows are trimmed. Character-offset dedup must still emit each exactly once.
  const payload = 'A'.repeat(30000);
  await h.model.write(payload);
  await h.model.write(markers.end(0, true));
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  assert.equal(h.lines.map((l) => l.text).join('').length, 30000);
  h.model.dispose();
});

test('repeated identical lines past scrollback keep exact counts', async () => {
  for (const [unit, repetitions] of [
    ['abc', 5000],
    ['xxxxxxxxxxx', 3000], // 11 columns wraps to two rows at width 10
  ] as const) {
    const h = harness(10, 5);
    await h.model.write((unit + '\r\n').repeat(repetitions));
    const joined = h.lines.map((l) => l.text).join('');
    assert.equal(joined, unit.repeat(repetitions), unit);
    assert.equal(joined.length, unit.length * repetitions);
    // Exactly one terminating record per input line; nothing deduped or doubled.
    assert.equal(h.lines.filter((l) => l.wrapped === false).length, repetitions);
    h.model.dispose();
  }
});

test('chunked writes around a trim flush the long line exactly once', async () => {
  const h = harness(10, 5);
  const markers = createShellMarkers(NONCE, 1);
  const payload = Array.from({ length: 30000 }, (_, i) => String(i % 10)).join('');
  // Write in small chunks so flushes interleave with trimming.
  for (let index = 0; index < payload.length; index += 777) {
    await h.model.write(payload.slice(index, index + 777));
  }
  await h.model.write(markers.end(0, true));
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  // Completing the line afterwards must not repeat the already-emitted prefix.
  await h.model.write('\r\n');
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  h.model.dispose();
});

test('write and flushLine throw after dispose', async () => {
  const h = harness();
  h.model.dispose();
  await assert.rejects(() => h.model.write('x'), (error: unknown) => {
    return error instanceof LiteSshError && error.code === 'SCREEN_DISPOSED';
  });
  assert.equal(h.model.flushLine(), undefined);
});

// Regression: eviction identities must not use terminal columns as string lengths.
for (const [label, unit, cols] of [
  ['CJK', '界', 10],
  ['surrogates', '😀', 10],
  ['combining-and-wide', 'A\u0301界😀 ', 13],
] as const) {
  test(`true scrollback eviction retains ${label} without column/UTF-16 confusion`, async () => {
    const h = harness(cols, 5);
    const markers = createShellMarkers(NONCE, 1);
    const payload = unit.repeat(15_000);
    try {
      await h.model.write(payload + markers.end(0, true));
      assert.equal(h.lines.map(line => line.text).join(''), payload);
      assert.equal(h.lines.reduce((count, line) => count + Array.from(line.text).length, 0), Array.from(payload).length);
      assert.ok(h.lines.every(line => line.newline === false));
    } finally { h.model.dispose(); }
  });
}

test('split UTF-8 writes retain a mixed Unicode line across true eviction', async () => {
  const h = harness(13, 5);
  const markers = createShellMarkers(NONCE, 1);
  const payload = 'A\u0301界😀 '.repeat(5000);
  const bytes = Buffer.from(payload, 'utf8');
  try {
    for (let offset = 0; offset < bytes.length; offset += 777) {
      await h.model.write(bytes.subarray(offset, offset + 777));
      h.model.flushLine();
    }
    await h.model.write(markers.end(0, true));
    assert.equal(h.lines.map(line => line.text).join(''), payload);
  } finally { h.model.dispose(); }
});

test('an erase followed by identical glyphs is new readable output', async () => {
  const h = harness();
  const markers = createShellMarkers(NONCE, 1);
  try {
    await h.model.write('abc\x1b[2J\x1b[Habc' + markers.end(0, true));
    assert.equal(h.lines.map(line => line.text).join(''), 'abcabc');
    assert.equal(h.model.snapshot().lines[0], 'abc');
  } finally { h.model.dispose(); }
});


test('R01 narrowing resize captures a new glyph that overwrites a clamped cursor cell', async () => {
  const h = harness(10, 3);
  try {
    await h.model.write('0123456789');
    h.model.resize(5, 3);
    await h.model.write('X\r\n');
    assert.ok(h.model.snapshot().lines.some(line => line.includes('X')));
    assert.ok(h.lines.map(line => line.text).join('').includes('X'), 'newly received X must reach readable history, not only the final screen');
  } finally { h.model.dispose(); }
});

test('R01 narrowing into a wide-cell continuation does not drop its replacement glyph', async () => {
  const h = harness(10, 3);
  try {
    await h.model.write('😀');
    h.model.resize(2, 3);
    await h.model.write('X\r\n');
    assert.ok(h.model.snapshot().lines.some(line => line.includes('X')));
    assert.ok(h.lines.map(line => line.text).join('').includes('X'));
  } finally { h.model.dispose(); }
});

test('F02 single write batch of 300 NEL (ESC E) lines preserves all 300 lines without history loss', async () => {
  const h = harness(80, 24);
  try {
    const total = 300;
    const blob = Array.from({ length: total }, (_, i) => `ONE${String(i + 1).padStart(4, '0')}\x1bE`).join('');
    await h.model.write(blob);
    h.model.flushLine();
    assert.equal(h.lines.length, total, 'all 300 NEL lines must be captured, not losing 271 to scrollback eviction');
    assert.equal(h.lines[0]?.text, 'ONE0001');
    assert.equal(h.lines[270]?.text, 'ONE0271');
    assert.equal(h.lines[total - 1]?.text, `ONE${String(total).padStart(4, '0')}`);
    assert.ok(h.lines.every(l => l.wrapped === false && l.newline === true), 'each NEL must be a hard terminating newline');
    assert.ok(h.lines.every(l => l.buffer === 'normal'));
  } finally { h.model.dispose(); }
});

test('F02 byte-by-byte chunking of 300 NEL (ESC E) lines captures every line in exact order', async () => {
  const h = harness(80, 24);
  try {
    const total = 300;
    const blob = Array.from({ length: total }, (_, i) => `ONE${String(i + 1).padStart(4, '0')}\x1bE`).join('');
    for (let i = 0; i < blob.length; i++) {
      await h.model.write(blob.charAt(i));
    }
    h.model.flushLine();
    assert.equal(h.lines.length, total, 'byte-by-byte streaming must not drop lines across split ESC E chunks');
    assert.equal(h.lines[0]?.text, 'ONE0001');
    assert.equal(h.lines[total - 1]?.text, `ONE${String(total).padStart(4, '0')}`);
    assert.ok(h.lines.every((l, i) => l.text === `ONE${String(i + 1).padStart(4, '0')}`));
    assert.ok(h.lines.every(l => l.wrapped === false && l.newline === true));
  } finally { h.model.dispose(); }
});

test('F01 SGR 8 invisible text masks raw text while preserving wide character column width and alignment', async () => {
  const h = harness(80, 24);
  try {
    // Two CJK wide characters (width 2 each, 4 columns total) with SGR 8 invisible, followed by visible CJK text
    await h.model.write('\x1b[8m密码\x1b[0m可见\r\n');
    h.model.flushLine();
    const snapshot = h.model.snapshot();
    const line0 = snapshot.lines[0] ?? '';
    assert.ok(line0.startsWith('    可见'), 'invisible wide characters must be masked as 4 spaces, preserving column alignment');
    assert.equal(line0.indexOf('可'), 4, 'subsequent visible text must align at column index 4');
    assert.equal(line0.includes('密码'), false, 'secret text must not be revealed in screen lines');
    assert.equal(h.lines[0]?.text, '    可见', 'captured line must contain masked spaces instead of secret text');
    assert.equal(h.lines[0]?.text.includes('密码'), false, 'secret text must not be emitted to line callbacks');
    // Styles must still report invisible: true for the first 4 columns
    assert.ok(snapshot.styles.some(s => s.row === 0 && s.start === 0 && s.end === 4 && s.style.invisible === true));
  } finally { h.model.dispose(); }
});

test('F01 SGR 8 invisible combining marks mask original characters with column width 1', async () => {
  const h = harness(80, 24);
  try {
    await h.model.write('\x1b[8me\u0301\x1b[0mOK\r\n');
    h.model.flushLine();
    const snapshot = h.model.snapshot();
    const line0 = snapshot.lines[0] ?? '';
    assert.ok(line0.startsWith(' OK'), 'invisible combining glyph (width 1) must be masked as 1 space');
    assert.equal(line0.indexOf('O'), 1, 'visible text must align at column index 1');
    assert.equal(line0.includes('e\u0301'), false, 'secret combining mark must not appear in screen lines');
    assert.equal(h.lines[0]?.text, ' OK');
  } finally { h.model.dispose(); }
});

test('F01 comparison: SGR 8 invisible vs no-echo input both protect sensitive plaintext', async () => {
  const hNoEcho = harness(80, 24);
  const hSgr8 = harness(80, 24);
  try {
    // In no-echo mode, the remote shell / pty does not echo characters to the terminal at all
    await hNoEcho.model.write('Password: ');
    // Simulated secret typing under no-echo: nothing written to terminal emulator
    await hNoEcho.model.write('\r\naccepted\r\n');
    hNoEcho.model.flushLine();
    assert.equal(hNoEcho.lines.some(l => l.text.includes('synthetic_password')), false, 'no-echo does not echo');

    // In SGR 8 invisible mode, characters are written with invisible attribute
    await hSgr8.model.write('Password: \x1b[8msynthetic_password\x1b[0m\r\naccepted\r\n');
    hSgr8.model.flushLine();
    assert.equal(hSgr8.lines.some(l => l.text.includes('synthetic_password')), false, 'SGR 8 masks invisible cells');
    assert.ok(hSgr8.lines[0]?.text.startsWith('Password: ' + ' '.repeat(18)), 'cells masked as spaces matching length');
    const snapshot = hSgr8.model.snapshot();
    assert.ok(snapshot.styles.some(s => s.style.invisible === true), 'styles record invisible: true');
  } finally {
    hNoEcho.model.dispose();
    hSgr8.model.dispose();
  }
});

test('F02 non-LF indexing with IND (ESC D) captures completed lines across scroll', async () => {
  const h = harness(80, 5);
  try {
    for (let i = 1; i <= 10; i++) {
      await h.model.write(`IND${i}\x1bD`);
    }
    h.model.flushLine();
    assert.equal(h.lines.length, 10, 'all 10 IND lines must be captured');
    assert.equal(h.lines[0]?.text, 'IND1');
    assert.equal(h.lines[9]?.text, ' '.repeat(36) + 'IND10', 'IND maintains cursor column across lines per VT semantics');
    assert.ok(h.lines.every(l => l.wrapped === false && l.newline === true));
  } finally { h.model.dispose(); }
});

test('RI baseline: a top-margin insert and unchanged revisit do not duplicate text', async () => {
  const h = harness(80, 3);
  try {
    // Write 'A' on row 0, then RI at top margin (inserts blank row at top, shifts 'A' to row 1),
    // then move cursor down to row 1 (\x1b[B) without rewriting
    await h.model.write('A\x1bM\x1b[B');
    h.model.flushLine();
    const text = h.lines.map(l => l.text).join('');
    assert.equal(text, 'A', 'RI baseline migration must not duplicate A on non-rewriting visit');
    assert.equal(h.lines.filter(l => l.text.includes('A')).length, 1);
  } finally { h.model.dispose(); }
});

test('F02 NEL stream exceeding scrollback (11000 lines) captures every line without loss or memory explosion', async () => {
  const h = harness(80, 24);
  try {
    const total = 11_000;
    const batchSize = 1000;
    for (let batchStart = 0; batchStart < total; batchStart += batchSize) {
      const count = Math.min(batchSize, total - batchStart);
      const blob = Array.from({ length: count }, (_, i) => `N${String(batchStart + i + 1).padStart(5, '0')}\x1bE`).join('');
      await h.model.write(blob);
    }
    h.model.flushLine();
    assert.equal(h.lines.length, total, 'all 11000 lines must be captured, far beyond xterm default scrollback');
    assert.equal(h.lines[0]?.text, 'N00001');
    assert.equal(h.lines[total - 1]?.text, `N${String(total).padStart(5, '0')}`);
    assert.ok(h.lines.every(l => l.wrapped === false && l.newline === true));
  } finally { h.model.dispose(); }
});

test('F01 SGR 8 invisible text across soft-wrap and resize maintains column masking and alignment', async () => {
  const h = harness(10, 4);
  try {
    // 10-column terminal. Invisible 6 chars + visible 6 chars wraps to next line.
    await h.model.write('\x1b[8mSECRET\x1b[0mWRAPME\r\n');
    h.model.flushLine();
    const joined = h.lines.map(l => l.text).join('');
    assert.equal(joined, '      WRAPME', 'invisible text masked with 6 spaces across wrap boundary');
    assert.equal(joined.includes('SECRET'), false);

    // Resize to 20 columns
    h.model.resize(20, 4);
    await h.model.write('\x1b[8m密码\x1b[0mOK\r\n');
    h.model.flushLine();
    const lastLine = h.lines.at(-1)?.text ?? '';
    assert.equal(lastLine, '    OK', 'invisible wide characters masked with 4 spaces after resize');
    assert.equal(lastLine.indexOf('O'), 4);
    assert.equal(lastLine.includes('密码'), false);
  } finally { h.model.dispose(); }
});

test('F02 mixed stream of normal LF, CR overwrite, auto-wrap, and NEL does not duplicate or drop', async () => {
  const h = harness(10, 4);
  try {
    // 1. Normal LF
    await h.model.write('NORMAL\r\n');
    // 2. CR overwrite
    await h.model.write('OLD\rNEW\r\n');
    // 3. Auto-wrap (10 cols: 10 chars + 5 chars + NEL)
    await h.model.write('0123456789WRAP1\x1bE');
    // 4. Standalone NEL
    await h.model.write('NEL_LINE\x1bE');
    h.model.flushLine();

    const texts = h.lines.map(l => l.text);
    assert.ok(texts.includes('NORMAL'), 'LF line present');
    assert.ok(texts.includes('OLD') && texts.includes('NEW'), 'CR overwrite preserved');
    assert.ok(texts.includes('0123456789') && texts.includes('WRAP1'), 'auto-wrap preserved');
    assert.ok(texts.includes('NEL_LINE'), 'NEL line present');
    // No duplication of NORMAL or NEL_LINE
    assert.equal(texts.filter(t => t === 'NORMAL').length, 1);
    assert.equal(texts.filter(t => t === 'NEL_LINE').length, 1);
  } finally { h.model.dispose(); }
});

for (const prefix of ['', '\x1b[?1049h']) {
  const bufferName = prefix ? 'alternate' : 'normal';
  test(`RI ${bufferName}: a newly inserted row remains readable after prior flush`, async () => {
    const h = harness(80, 3);
    try {
      await h.model.write(prefix + 'A');
      h.model.flushLine();
      await h.model.write('\x1bMZ');
      h.model.flushLine();
      const text = h.lines.map(line => line.text).join('');
      assert.equal(text.split('A').length - 1, 1);
      assert.equal(text.split('Z').length - 1, 1);
    } finally { h.model.dispose(); }
  });
  test(`RI ${bufferName}: a custom scroll-region revisit does not repeat unchanged text`, async () => {
    const h = harness(80, 4);
    try {
      await h.model.write(prefix + '\x1b[2;4r\x1b[2;1HA\x1bM\x1b[B');
      h.model.flushLine();
      assert.equal(h.lines.map(line => line.text).join(''), 'A');
    } finally { h.model.dispose(); }
  });
}
