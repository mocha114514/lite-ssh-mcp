/**
 * Unit tests for input action encoding (M0, local only).
 *
 * Verifies that text/paste/key stay distinct, that paste is never silently
 * downgraded, that cursor/keypad encodings honour the screen modes, and that
 * unsupported names are rejected before anything is sent.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LiteSshError } from '../src/core/errors.js';
import type { ScreenModes, ScreenSnapshot } from '../src/core/types.js';
import {
  encodeAction,
  encodeBatch,
  isSupportedKey,
  normalizeKeyName,
  validateKeys,
} from '../src/terminal/input.js';

function snapshot(modes: Partial<ScreenModes> = {}): ScreenSnapshot {
  return {
    revision: 0,
    cols: 80,
    rows: 24,
    buffer: 'normal',
    cursor: { x: 0, y: 0 },
    lines: [],
    styles: [],
    modes: {
      bracketedPaste: false,
      applicationCursorKeys: false,
      applicationKeypad: false,
      ...modes,
    },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof LiteSshError) return error.code;
    throw error;
  }
  throw new Error('expected the call to throw');
}

test('text passes literal printable characters through unchanged', () => {
  assert.equal(encodeAction({ type: 'text', text: 'vim a.txt' }, snapshot()), 'vim a.txt');
  assert.equal(encodeAction({ type: 'text', text: '中文' }, snapshot()), '中文');
  assert.equal(encodeAction({ type: 'text', text: '' }, snapshot()), '');
});

test('text rejects embedded control characters instead of guessing', () => {
  assert.equal(codeOf(() => encodeAction({ type: 'text', text: 'a\nb' }, snapshot())), 'INVALID_TEXT');
  assert.equal(codeOf(() => encodeAction({ type: 'text', text: 'a\x1bb' }, snapshot())), 'INVALID_TEXT');
  assert.equal(codeOf(() => encodeAction({ type: 'text', text: 'a\tb' }, snapshot())), 'INVALID_TEXT');
  assert.equal(codeOf(() => encodeAction({ type: 'text', text: 'a\x7fb' }, snapshot())), 'INVALID_TEXT');
});

test('paste requires bracketed paste and never downgrades', () => {
  assert.equal(
    codeOf(() => encodeAction({ type: 'paste', text: 'a\nb' }, snapshot())),
    'PASTE_UNSUPPORTED',
  );
  const out = encodeAction(
    { type: 'paste', text: 'a\nb' },
    snapshot({ bracketedPaste: true }),
  );
  assert.equal(out, '\x1b[200~a\nb\x1b[201~');
});

test('paste allows line breaks and TAB inside the wrapper', () => {
  const modes = snapshot({ bracketedPaste: true });
  const payload = 'line1\r\nline2\ncol\tcol';
  assert.equal(
    encodeAction({ type: 'paste', text: payload }, modes),
    '\x1b[200~' + payload + '\x1b[201~',
  );
});

test('paste rejects an embedded escape that could end the wrapper early', () => {
  const modes = snapshot({ bracketedPaste: true });
  // ESC[201~ would terminate the native bracketed region mid-payload.
  assert.equal(
    codeOf(() => encodeAction({ type: 'paste', text: 'safe\x1b[201~rm -rf /' }, modes)),
    'INVALID_PASTE',
  );
  assert.equal(
    codeOf(() => encodeAction({ type: 'paste', text: 'a\x1bb' }, modes)),
    'INVALID_PASTE',
  );
});

test('paste rejects other control characters instead of performing them', () => {
  const modes = snapshot({ bracketedPaste: true });
  assert.equal(codeOf(() => encodeAction({ type: 'paste', text: 'a\x00b' }, modes)), 'INVALID_PASTE');
  assert.equal(codeOf(() => encodeAction({ type: 'paste', text: 'a\x03b' }, modes)), 'INVALID_PASTE');
  assert.equal(codeOf(() => encodeAction({ type: 'paste', text: 'a\x7fb' }, modes)), 'INVALID_PASTE');
  assert.equal(codeOf(() => encodeAction({ type: 'paste', text: '\x0c' }, modes)), 'INVALID_PASTE');
});

test('encodes common named keys', () => {
  const s = snapshot();
  assert.equal(encodeAction({ type: 'key', key: 'ENTER' }, s), '\r');
  assert.equal(encodeAction({ type: 'key', key: 'ESC' }, s), '\x1b');
  assert.equal(encodeAction({ type: 'key', key: 'TAB' }, s), '\t');
  assert.equal(encodeAction({ type: 'key', key: 'BACKSPACE' }, s), '\x7f');
  assert.equal(encodeAction({ type: 'key', key: 'DELETE' }, s), '\x1b[3~');
  assert.equal(encodeAction({ type: 'key', key: 'PAGE_UP' }, s), '\x1b[5~');
  assert.equal(encodeAction({ type: 'key', key: 'PAGE_DOWN' }, s), '\x1b[6~');
  assert.equal(encodeAction({ type: 'key', key: 'F1' }, s), '\x1bOP');
  assert.equal(encodeAction({ type: 'key', key: 'F5' }, s), '\x1b[15~');
  assert.equal(encodeAction({ type: 'key', key: 'F12' }, s), '\x1b[24~');
});

test('encodes Ctrl letters and normalizes their spelling', () => {
  const s = snapshot();
  assert.equal(encodeAction({ type: 'key', key: 'CTRL_C' }, s), '\x03');
  assert.equal(encodeAction({ type: 'key', key: 'ctrl-a' }, s), '\x01');
  assert.equal(encodeAction({ type: 'key', key: 'Ctrl Z' }, s), '\x1a');
});

test('arrow keys honour application cursor key mode', () => {
  const normal = snapshot();
  const application = snapshot({ applicationCursorKeys: true });
  assert.equal(encodeAction({ type: 'key', key: 'UP' }, normal), '\x1b[A');
  assert.equal(encodeAction({ type: 'key', key: 'UP' }, application), '\x1bOA');
  assert.equal(encodeAction({ type: 'key', key: 'DOWN' }, application), '\x1bOB');
  assert.equal(encodeAction({ type: 'key', key: 'RIGHT' }, application), '\x1bOC');
  assert.equal(encodeAction({ type: 'key', key: 'LEFT' }, normal), '\x1b[D');
});

test('Home and End honour application cursor key mode', () => {
  const normal = snapshot();
  const application = snapshot({ applicationCursorKeys: true });
  assert.equal(encodeAction({ type: 'key', key: 'HOME' }, normal), '\x1b[H');
  assert.equal(encodeAction({ type: 'key', key: 'HOME' }, application), '\x1bOH');
  assert.equal(encodeAction({ type: 'key', key: 'END' }, normal), '\x1b[F');
  assert.equal(encodeAction({ type: 'key', key: 'END' }, application), '\x1bOF');
});

test('keypad honurs application keypad mode', () => {
  const normal = snapshot();
  const application = snapshot({ applicationKeypad: true });
  assert.equal(encodeAction({ type: 'key', key: 'KP_7' }, normal), '7');
  assert.equal(encodeAction({ type: 'key', key: 'KP_7' }, application), '\x1bOw');
  assert.equal(encodeAction({ type: 'key', key: 'KP_ENTER' }, normal), '\r');
  assert.equal(encodeAction({ type: 'key', key: 'KP_ENTER' }, application), '\x1bOM');
  assert.equal(encodeAction({ type: 'key', key: 'KP_DECIMAL' }, application), '\x1bOn');
});

test('rejects unsupported key names', () => {
  assert.equal(
    codeOf(() => encodeAction({ type: 'key', key: 'HYPER' }, snapshot())),
    'UNSUPPORTED_KEY',
  );
  assert.equal(codeOf(() => encodeAction({ type: 'key', key: '' }, snapshot())), 'UNSUPPORTED_KEY');
});

test('normalizeKeyName collapses spacing and case', () => {
  assert.equal(normalizeKeyName('page up'), 'PAGE_UP');
  assert.equal(normalizeKeyName('Ctrl-C'), 'CTRL_C');
  assert.equal(normalizeKeyName(' F5 '), 'F5');
});

test('every CR/LF alias is classified as a submission by its actual bytes', () => {
  const normal = snapshot();
  for (const key of ['ENTER', 'RETURN', 'Return', 'CTRL_M', 'ctrl-m', 'KP_ENTER']) {
    const encoded = encodeBatch([{ type: 'key', key }], normal);
    assert.equal(encoded.submissions, 1, `${key} must submit a shell line`);
  }
  const newline = encodeBatch([{ type: 'key', key: 'CTRL_J' }], normal);
  assert.equal(newline.packet, '\n');
  assert.equal(newline.submissions, 1);
});

test('submission classification is mode-sensitive for the keypad ENTER', () => {
  const numeric = snapshot();
  const application = snapshot({ applicationKeypad: true });
  const numericEnter = encodeBatch([{ type: 'key', key: 'KP_ENTER' }], numeric);
  assert.equal(numericEnter.packet, '\r');
  assert.equal(numericEnter.submissions, 1);
  // SS3 `ESC O M` is consumed by the running application, not by the shell.
  const applicationEnter = encodeBatch([{ type: 'key', key: 'KP_ENTER' }], application);
  assert.equal(applicationEnter.packet, '\x1bOM');
  assert.equal(applicationEnter.submissions, 0);
});

test('text and bracketed paste never count as submissions', () => {
  const modes = snapshot({ bracketedPaste: true });
  assert.equal(encodeBatch([{ type: 'text', text: 'true' }], modes).submissions, 0);
  assert.equal(encodeBatch([{ type: 'paste', text: 'a\nb\n' }], modes).submissions, 0);
  // A batch counts each literal Enter without joining anything: no implicit CR.
  const batch = encodeBatch([{ type: 'text', text: 'true' }, { type: 'key', key: 'RETURN' }], modes);
  assert.equal(batch.packet, 'true\r');
  assert.equal(batch.submissions, 1);
});

test('a literal CR/LF cannot be smuggled through a text action', () => {
  assert.equal(codeOf(() => encodeBatch([{ type: 'text', text: 'a\r' }], snapshot())), 'INVALID_TEXT');
});

test('validateKeys canonicalizes a batch and fails before sending', () => {
  assert.deepEqual(validateKeys(['Enter', 'ctrl-c', 'up', 'F5']), ['ENTER', 'CTRL_C', 'UP', 'F5']);
  assert.equal(codeOf(() => validateKeys(['ENTER', 'NOPE'])), 'UNSUPPORTED_KEY');
  assert.equal(isSupportedKey('home'), true);
  assert.equal(isSupportedKey('homepage'), false);
});

test('C1 text rejects every U+0080 through U+009F before encoding input', () => {
  for (let code = 0x80; code <= 0x9f; code++) {
    assert.equal(
      codeOf(() => encodeAction({ type: 'text', text: `a${String.fromCodePoint(code)}b` }, snapshot())),
      'INVALID_TEXT',
      `U+${code.toString(16).toUpperCase()}`,
    );
  }
});

test('C1 bracketed paste rejects every U+0080 through U+009F', () => {
  const modes = snapshot({ bracketedPaste: true });
  for (let code = 0x80; code <= 0x9f; code++) {
    assert.equal(
      codeOf(() => encodeAction({ type: 'paste', text: `a${String.fromCodePoint(code)}b` }, modes)),
      'INVALID_PASTE',
      `U+${code.toString(16).toUpperCase()}`,
    );
  }
});

test('C1 boundary controls retain printable text and allowed paste TAB/CR/LF', () => {
  const text = '~\u00a0中文😀';
  assert.equal(encodeAction({ type: 'text', text }, snapshot()), text);
  const paste = text + '\t\r\nnext\n';
  assert.equal(
    encodeAction({ type: 'paste', text: paste }, snapshot({ bracketedPaste: true })),
    '\x1b[200~' + paste + '\x1b[201~',
  );
});

test('C1 paste retains mode-off refusal precedence instead of silently downgrading', () => {
  assert.equal(
    codeOf(() => encodeAction({ type: 'paste', text: '\u0085' }, snapshot())),
    'PASTE_UNSUPPORTED',
  );
});
