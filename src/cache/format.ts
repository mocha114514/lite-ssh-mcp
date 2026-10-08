/**
 * Readable-value rendering helpers for the terminal cache.
 *
 * HANDOVER / WHY THIS FILE EXISTS
 * -------------------------------
 * `prefixes.ts` freezes *which* markers exist; this module renders the *values*
 * that follow them. Everything here is deliberately lossless-but-safe:
 *
 *   - `escapeControl` turns every C0/C1/DEL code point into visible `\xNN` text
 *     (with `\t`, `\n`, `\r` short forms). A `ParsedLine` is not supposed to
 *     contain raw CSI, but if ESC ever leaks in it is written as the literal
 *     characters `\x1b` and can never re-animate a terminal emulator.
 *   - File names are sanitized to filesystem-safe ASCII so IPv6 colons and any
 *     Windows-reserved characters cannot reach the disk. The *true* endpoint is
 *     still recorded verbatim in the file header.
 *   - No helper in this file ever accepts an `InputAction` value. Action values
 *     (text/paste) must never be rendered — see `recorder.ts`.
 */

import type { CellStyle, ScreenSnapshot, StyleSpan, TerminalIdentity } from '../core/types.js';
import { frameMarkerLine, styleMarkerLine } from './prefixes.js';

/** Matches C0 controls (including TAB/LF/CR), DEL and the C1 range. */
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Render control code points as visible escapes. Tab/newline/carriage-return
 * get their common short forms; everything else becomes `\xNN`. The result is
 * always single-line and safe to embed after a data prefix.
 */
export function escapeControl(text: string): string {
  return text.replace(CONTROL_PATTERN, (character) => {
    const point = character.codePointAt(0) ?? 0;
    if (point === 0x09) return '\\t';
    if (point === 0x0a) return '\\n';
    if (point === 0x0d) return '\\r';
    return `\\x${point.toString(16).padStart(2, '0')}`;
  });
}

/** Keep only characters that are safe/readable inside a `key`/`label` token. */
export function sanitizeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9._+-]/g, '_');
}

/** Keep a filename component to filesystem-safe ASCII without separators. */
export function sanitizeFileNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Small helper that never echoes a filesystem message (which may hold paths). */
export function reasonCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNKNOWN';
}

/** Local creation timestamp, e.g. `20261007T083000123`. Internal to the file name. */
export function localTimestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Build the cache file name: filesystem-safe ip + port + codename + local
 * creation timestamp + per-instance isolation. The timestamp is for the cache
 * only and is never exposed through any recorder method.
 */
export function buildCacheFileName(identity: TerminalIdentity, createdAt: Date, instance: string): string {
  const ip = sanitizeFileNamePart(identity.ip);
  const codename = sanitizeFileNamePart(identity.codename);
  return `${ip}_${identity.port}_${codename}_${localTimestamp(createdAt)}_${instance}.context.log`;
}

/** File header: true endpoint/account/codename plus internal creation metadata. */
export function terminalHeaderLine(identity: TerminalIdentity, createdAt: Date, instance: string): string {
  return (
    `[TERMINAL] ip=${escapeControl(identity.ip)} port=${identity.port}` +
    ` username=${escapeControl(identity.username)} codename=${escapeControl(identity.codename)}` +
    ` created=${createdAt.toISOString()} instance=${instance}`
  );
}

function describeColor(color: CellStyle['foreground']): string {
  return color.mode === 'default' ? 'default' : `${color.mode}:${color.value}`;
}

/** Readable style metadata; active attributes only, colors always explicit. */
export function describeStyle(style: CellStyle): string {
  const attributes: string[] = [];
  if (style.bold) attributes.push('bold');
  if (style.italic) attributes.push('italic');
  if (style.dim) attributes.push('dim');
  if (style.underline) attributes.push('underline');
  if (style.inverse) attributes.push('inverse');
  if (style.invisible) attributes.push('invisible');
  if (style.strikethrough) attributes.push('strikethrough');
  return `attrs=${attributes.length ? attributes.join(',') : 'none'} fg=${describeColor(style.foreground)} bg=${describeColor(style.background)}`;
}

/** `[STYLE Fn] row=... start=... end=... attrs=... fg=... bg=...` */
export function styleLine(frameId: string, span: StyleSpan): string {
  return `${styleMarkerLine(frameId)} row=${span.row} start=${span.start} end=${span.end} ${describeStyle(span.style)}`;
}

const flag = (value: boolean): 0 | 1 => (value ? 1 : 0);

/**
 * `[SCREEN Fn]` header carrying dimensions, sequence, cursor, buffer and modes.
 * Cursor/style/dimension state is part of the context, so an all-text diff is
 * never enough to declare two frames identical.
 */
export function describeScreen(screen: ScreenSnapshot, frameId: string, label?: string, duplicate = false): string {
  const modes =
    `bracketedPaste:${flag(screen.modes.bracketedPaste)},` +
    `appCursor:${flag(screen.modes.applicationCursorKeys)},` +
    `appKeypad:${flag(screen.modes.applicationKeypad)}`;
  const pieces = [
    frameMarkerLine(frameId),
    `revision=${screen.revision}`,
    `buffer=${screen.buffer}`,
    `cols=${screen.cols}`,
    `rows=${screen.rows}`,
    `cursor=(${screen.cursor.x},${screen.cursor.y})`,
    `modes=${modes}`,
  ];
  if (label) pieces.push(`label=${sanitizeToken(label)}`);
  if (duplicate) pieces.push('duplicate=1');
  return pieces.join(' ');
}

/**
 * Content signature used to dedupe byte-identical consecutive frames. `revision`
 * is intentionally excluded: a new revision with identical visible content is
 * still the same context.
 */
export function screenSignature(screen: ScreenSnapshot): string {
  return JSON.stringify([
    screen.cols,
    screen.rows,
    screen.buffer,
    screen.cursor,
    screen.lines,
    screen.styles,
    screen.modes,
  ]);
}
