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

import { LiteSshError } from '../src/core/errors.js';
import type { ParsedLine, ShellMarker } from '../src/core/types.js';
import { encodeMarkerOsc } from '../src/shell/protocol.js';
import { ScreenModel } from '../src/terminal/screen.js';

const NONCE = 'm0-test-nonce';

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
  const model = new ScreenModel({
    nonce: NONCE,
    cols: 80,
    rows: 24,
    onLine: (line) => lines.push(line),
    onFrame: (screen, label) => frames.push({ label, first: screen.lines[0] ?? '' }),
  });
  // `CSI 2J` erases the screen and `CSI H` homes the cursor; the text has no LF.
  await model.write('abc\x1b[2J\x1b[H');
  await model.write(encodeMarkerOsc(NONCE, 'END;0'));
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
  await h.model.write('typing');
  await h.model.write(encodeMarkerOsc(NONCE, 'END;3'));
  const lineIndex = h.events.findIndex((e) => e.startsWith('line:typing'));
  const endIndex = h.events.indexOf('marker:end');
  assert.ok(lineIndex >= 0, 'partial line should be flushed');
  assert.ok(endIndex > lineIndex, 'END marker should arrive after the flush');
  const end = h.markers.find((m) => m.kind === 'end');
  assert.deepEqual(end, { nonce: NONCE, kind: 'end', exitCode: 3 });
  h.model.dispose();
});

test('decodes every marker kind with its nonce', async () => {
  const h = harness();
  await h.model.write(encodeMarkerOsc(NONCE, 'PROBE;bash'));
  await h.model.write(encodeMarkerOsc(NONCE, 'STTY;500:5:bf'));
  await h.model.write(encodeMarkerOsc(NONCE, 'READY;zsh'));
  await h.model.write(encodeMarkerOsc(NONCE, 'BEGIN'));
  await h.model.write(encodeMarkerOsc(NONCE, 'UNSUPPORTED;no-hooks'));
  assert.deepEqual(h.markers, [
    { nonce: NONCE, kind: 'probe', shell: 'bash' },
    { nonce: NONCE, kind: 'stty', value: '500:5:bf' },
    { nonce: NONCE, kind: 'ready', shell: 'zsh' },
    { nonce: NONCE, kind: 'begin' },
    { nonce: NONCE, kind: 'unsupported', reason: 'no-hooks' },
  ]);
  h.model.dispose();
});

test('rejects wrong nonce, unknown events and malformed fields', async () => {
  const h = harness();
  await h.model.write(encodeMarkerOsc('other-nonce', 'BEGIN'));
  await h.model.write(encodeMarkerOsc(NONCE, 'BOGUS'));
  await h.model.write(encodeMarkerOsc(NONCE, 'END;not-a-number'));
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
  const completed = await h.model.write('GIN\x07');
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
  const before = await h.model.write('ok');
  const after = await h.model.write(encodeMarkerOsc(NONCE, 'END;7'));
  assert.equal(after.revision, before.revision);
  assert.deepEqual(h.markers.at(-1), { nonce: NONCE, kind: 'end', exitCode: 7 });
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
  const payload = 'A'.repeat(1201);
  await h.model.write(payload);
  await h.model.write(encodeMarkerOsc(NONCE, 'END;0'));
  assert.equal(h.lines.map((l) => l.text).join(''), payload);
  assert.equal(h.lines.map((l) => l.text).join('').length, 1201);
  assert.ok(h.lines.every((l) => l.wrapped === true));
  h.model.dispose();
});

test('a flush after scrolling does not duplicate the already-emitted prefix', async () => {
  const h = harness(10, 5);
  // 3000 columns over 10-wide rows is far past the 5-row screen: most rows are
  // flushed at scroll time, then the tail is completed with an END and an LF.
  const payload = Array.from({ length: 3000 }, (_, i) => String(i % 10)).join('');
  await h.model.write(payload);
  await h.model.write(encodeMarkerOsc(NONCE, 'END;0'));
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
  // 3000 rows of 10 columns: far past the default 1000-line scrollback, so most
  // rows are trimmed. Character-offset dedup must still emit each exactly once.
  const payload = 'A'.repeat(30000);
  await h.model.write(payload);
  await h.model.write(encodeMarkerOsc(NONCE, 'END;0'));
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
  const payload = Array.from({ length: 30000 }, (_, i) => String(i % 10)).join('');
  // Write in small chunks so flushes interleave with trimming.
  for (let index = 0; index < payload.length; index += 777) {
    await h.model.write(payload.slice(index, index + 777));
  }
  await h.model.write(encodeMarkerOsc(NONCE, 'END;0'));
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
    const payload = unit.repeat(15_000);
    try {
      await h.model.write(payload + encodeMarkerOsc(NONCE, 'END;0'));
      assert.equal(h.lines.map(line => line.text).join(''), payload);
      assert.equal(h.lines.reduce((count, line) => count + Array.from(line.text).length, 0), Array.from(payload).length);
      assert.ok(h.lines.every(line => line.newline === false));
    } finally { h.model.dispose(); }
  });
}

test('split UTF-8 writes retain a mixed Unicode line across true eviction', async () => {
  const h = harness(13, 5);
  const payload = 'A\u0301界😀 '.repeat(5000);
  const bytes = Buffer.from(payload, 'utf8');
  try {
    for (let offset = 0; offset < bytes.length; offset += 777) {
      await h.model.write(bytes.subarray(offset, offset + 777));
      h.model.flushLine();
    }
    await h.model.write(encodeMarkerOsc(NONCE, 'END;0'));
    assert.equal(h.lines.map(line => line.text).join(''), payload);
  } finally { h.model.dispose(); }
});

test('an erase followed by identical glyphs is new readable output', async () => {
  const h = harness();
  try {
    await h.model.write('abc\x1b[2J\x1b[Habc' + encodeMarkerOsc(NONCE, 'END;0'));
    assert.equal(h.lines.map(line => line.text).join(''), 'abcabc');
    assert.equal(h.model.snapshot().lines[0], 'abc');
  } finally { h.model.dispose(); }
});
