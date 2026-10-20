/**
 * Encodes logical input actions into the byte strings a remote PTY expects.
 *
 * Three actions stay strictly distinct, matching the design:
 *  - `text`  literal typed characters (no implicit Enter, no paste wrapper);
 *  - `paste` a body framed with bracketed-paste markers. It is never silently
 *            downgraded to line-by-line input, and a body containing ESC or a
 *            control character other than a line break or TAB is rejected: an
 *            embedded `ESC[201~` would terminate the native bracketed wrapper
 *            early and let the rest of the payload run as raw keystrokes.
 *  - `key`   a named control key (arrows, Ctrl letters, F-keys, keypad, ...).
 *
 * Arrow/Home/End and keypad keys honour the application cursor/keypad modes
 * observed on the current {@link ScreenSnapshot}, so editors that switch modes
 * receive the bytes they expect. Unsupported names are rejected rather than
 * guessed. Nothing here logs or stores the text it is given.
 */
import { LiteSshError } from '../core/errors.js';
import type { InputAction, ScreenSnapshot } from '../core/types.js';

const BRACKETED_PASTE_BEGIN = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Control characters a paste body may carry: the line breaks (LF and CR, so a
 * CRLF payload survives) and TAB. Every other C0 control — ESC first among
 * them — plus DEL is rejected so a payload cannot break out of the bracketed
 * wrapper or quietly perform a control action.
 */
const PASTE_ALLOWED_CONTROLS = new Set(['\n', '\r', '\t']);

/** Keys whose encoding changes with the "application cursor keys" mode. */
const CURSOR_KEYS: Record<string, { normal: string; application: string }> = {
  UP: { normal: '\x1b[A', application: '\x1bOA' },
  DOWN: { normal: '\x1b[B', application: '\x1bOB' },
  RIGHT: { normal: '\x1b[C', application: '\x1bOC' },
  LEFT: { normal: '\x1b[D', application: '\x1bOD' },
  HOME: { normal: '\x1b[H', application: '\x1bOH' },
  END: { normal: '\x1b[F', application: '\x1bOF' },
};

/** Mode-independent named keys. */
const PLAIN_KEYS: Record<string, string> = {
  ENTER: '\r',
  RETURN: '\r',
  ESC: '\x1b',
  ESCAPE: '\x1b',
  TAB: '\t',
  BACKSPACE: '\x7f',
  BS: '\x7f',
  DELETE: '\x1b[3~',
  DEL: '\x1b[3~',
  INSERT: '\x1b[2~',
  PAGE_UP: '\x1b[5~',
  PAGEUP: '\x1b[5~',
  PAGE_DOWN: '\x1b[6~',
  PAGEDOWN: '\x1b[6~',
  SPACE: ' ',
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
};

/** Keypad keys in numeric ("normal") mode. */
const KEYPAD_NORMAL: Record<string, string> = {
  KP_0: '0', KP_1: '1', KP_2: '2', KP_3: '3', KP_4: '4',
  KP_5: '5', KP_6: '6', KP_7: '7', KP_8: '8', KP_9: '9',
  KP_ENTER: '\r', KP_DECIMAL: '.', KP_PERIOD: '.',
  KP_PLUS: '+', KP_ADD: '+', KP_MINUS: '-', KP_SUBTRACT: '-',
  KP_MULTIPLY: '*', KP_DIVIDE: '/',
};

/** Keypad keys while the application keypad (DECNKM) mode is active (SS3). */
const KEYPAD_APPLICATION: Record<string, string> = {
  KP_0: '\x1bOp', KP_1: '\x1bOq', KP_2: '\x1bOr', KP_3: '\x1bOs',
  KP_4: '\x1bOt', KP_5: '\x1bOu', KP_6: '\x1bOv', KP_7: '\x1bOw',
  KP_8: '\x1bOx', KP_9: '\x1bOy', KP_ENTER: '\x1bOM',
  KP_DECIMAL: '\x1bOn', KP_PERIOD: '\x1bOn',
  KP_PLUS: '\x1bOk', KP_ADD: '\x1bOk', KP_MINUS: '\x1bOm', KP_SUBTRACT: '\x1bOm',
  KP_MULTIPLY: '\x1bOj', KP_DIVIDE: '\x1bOo',
};

/** Ctrl+letter, e.g. CTRL_C -> 0x03. */
const CTRL_KEY = /^CTRL_([A-Z])$/;

/** Normalizes "Ctrl-C", "page up", "PgUp" into "CTRL_C", "PAGE_UP", ... */
export function normalizeKeyName(key: string): string {
  return key.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

/**
 * Encodes one input action. Throws {@link LiteSshError} for text containing
 * control characters, paste while bracketed paste is off, or unknown keys.
 */
export function encodeAction(action: InputAction, snapshot: ScreenSnapshot): string {
  switch (action.type) {
    case 'text':
      return encodeText(action.text);
    case 'paste':
      return encodePaste(action.text, snapshot);
    case 'key':
      return encodeKey(action.key, snapshot);
    default: {
      // Exhaustiveness guard for JS callers that send an unknown discriminator.
      throw new LiteSshError('INVALID_ACTION', 'Unknown input action type.');
    }
  }
}

/** Validates a batch and returns canonical names, so a failure happens before sending. */
export function validateKeys(keys: readonly string[]): string[] {
  return keys.map((key) => {
    const name = normalizeKeyName(key);
    if (!isSupportedKeyName(name)) {
      throw new LiteSshError('UNSUPPORTED_KEY', `Unsupported key name: ${key}.`);
    }
    return name;
  });
}

/** True when {@link encodeKey} can encode this name. */
export function isSupportedKey(key: string): boolean {
  return isSupportedKeyName(normalizeKeyName(key));
}

/**
 * Encodes a whole batch exactly once and reports how many actions submit a
 * shell line.
 *
 * Submission is decided by the ACTUAL encoded bytes (a lone CR or LF), never by
 * the action's name: `ENTER`, `RETURN`, `CTRL_M` and a numeric-keypad
 * `KP_ENTER` all encode `\r`, `CTRL_J` encodes `\n`, while an
 * application-keypad `KP_ENTER` encodes the SS3 sequence `ESC O M` that the
 * application consumes itself and is deliberately NOT a shell submission.
 * `text` cannot carry control bytes and a bracketed `paste` body is inserted
 * literally, so neither ever counts. Sharing this classifier keeps the session
 * and its tests on one definition.
 */
export function encodeBatch(
  actions: readonly InputAction[],
  snapshot: ScreenSnapshot,
): { packet: string; submissions: number } {
  let packet = '';
  let submissions = 0;
  for (const action of actions) {
    const encoded = encodeAction(action, snapshot);
    packet += encoded;
    if (action.type === 'key' && (encoded === '\r' || encoded === '\n')) submissions += 1;
  }
  return { packet, submissions };
}

function encodeText(text: string): string {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new LiteSshError(
        'INVALID_TEXT',
        'Text actions accept literal printable characters only; use a key action for control input.',
      );
    }
  }
  return text;
}

function encodePaste(text: string, snapshot: ScreenSnapshot): string {
  if (!snapshot.modes.bracketedPaste) {
    // Never downgrade: unbracketed multi-line paste would be executed line by
    // line by an interactive shell. The caller must decide another strategy.
    throw new LiteSshError(
      'PASTE_UNSUPPORTED',
      'The remote application has not enabled bracketed paste; the paste was not silently downgraded.',
    );
  }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl && !PASTE_ALLOWED_CONTROLS.has(character)) {
      // An embedded ESC[201~ would end the wrapper early; other controls would
      // be performed instead of pasted literally.
      throw new LiteSshError(
        'INVALID_PASTE',
        'Paste content may only contain printable characters, line breaks and TAB; control characters were rejected.',
      );
    }
  }
  return `${BRACKETED_PASTE_BEGIN}${text}${BRACKETED_PASTE_END}`;
}

function encodeKey(key: string, snapshot: ScreenSnapshot): string {
  const name = normalizeKeyName(key);
  const cursor = CURSOR_KEYS[name];
  if (cursor) return snapshot.modes.applicationCursorKeys ? cursor.application : cursor.normal;
  const plain = PLAIN_KEYS[name];
  if (plain !== undefined) return plain;
  const keypad = KEYPAD_NORMAL[name];
  if (keypad !== undefined) {
    return snapshot.modes.applicationKeypad ? (KEYPAD_APPLICATION[name] ?? keypad) : keypad;
  }
  const ctrl = CTRL_KEY.exec(name);
  if (ctrl && ctrl[1]) return String.fromCharCode(ctrl[1].charCodeAt(0) - 64);
  throw new LiteSshError('UNSUPPORTED_KEY', `Unsupported key name: ${key}.`);
}

function isSupportedKeyName(name: string): boolean {
  return (
    name in CURSOR_KEYS ||
    name in PLAIN_KEYS ||
    name in KEYPAD_NORMAL ||
    CTRL_KEY.test(name)
  );
}
