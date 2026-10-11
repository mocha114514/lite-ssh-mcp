/**
 * Wire format for lite-ssh shell-integration markers.
 *
 * Markers travel as private OSC 777 payloads so they never render as screen
 * text and never collide with printable output. The payload grammar is:
 *
 *   OSC 777 ; LSSH ; <nonce> ; <EVENT> [ ; <arg> ... ] BEL
 *
 * Events (see {@link ShellMarker}):
 *   PROBE;<shell>       interactive shell name resolved from /proc/<ppid>/comm
 *   STTY;<value>        saved `stty -g` string, restored verbatim on bootstrap
 *   READY;<shell>       hooks installed; main may begin issuing rounds
 *   BEGIN               foreground command started
 *   END;<exitCode>      foreground command finished with a numeric status
 *   UNSUPPORTED;<text>  integration is impossible for this shell/version
 *
 * This module is the single source of truth shared by the screen parser
 * (src/terminal/screen.ts) and the shell script emitters (src/shell).
 * Raw terminal bytes are never persisted; only these parsed markers leave the
 * model, and they carry no command line or other secret payload.
 */
import type { ShellMarker } from '../core/types.js';

/** OSC numeric identifier reserved for this project's private markers. */
export const MARKER_OSC_ID = 777;

/** Namespace token that lets foreign OSC 777 users pass through untouched. */
export const MARKER_NAMESPACE = 'LSSH';

/**
 * Parses an OSC 777 payload into a marker, or `null` when the payload must be
 * rejected (foreign namespace, wrong nonce, unknown event, malformed fields).
 * Rejected payloads are still consumed by the caller so they never leak to the
 * screen; only well-formed, nonce-matching events reach `onMarker`.
 */
export function parseMarker(data: string, nonce: string): ShellMarker | null {
  const parts = data.split(';');
  if (parts[0] !== MARKER_NAMESPACE) return null;
  // A non-empty nonce is mandatory; never accept an unauthenticated marker.
  if (!nonce || parts[1] !== nonce) return null;
  const event = parts[2];
  switch (event) {
    case 'PROBE': {
      const shell = parts[3];
      if (!shell) return null;
      return { nonce, kind: 'probe', shell };
    }
    case 'STTY': {
      const value = parts.slice(3).join(';');
      if (!value) return null;
      return { nonce, kind: 'stty', value };
    }
    case 'READY': {
      const shell = parts[3];
      if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') return null;
      return { nonce, kind: 'ready', shell };
    }
    case 'BEGIN':
      return { nonce, kind: 'begin' };
    case 'END': {
      const raw = parts[3];
      if (raw === undefined || raw === '') return null;
      const exitCode = Number(raw);
      if (!Number.isInteger(exitCode) || exitCode < 0) return null;
      // The optional health field is emitted by the new bootstrap. Keep the
      // legacy marker shape unchanged; Session supplies its legacy default.
      return {
        nonce,
        kind: 'end',
        exitCode,
        ...(parts[4] !== undefined ? { hookHealthy: parts[4] === '1' } : {}),
      };
    }
    case 'UNSUPPORTED': {
      // Reason is free text after the event keyword; empty is still valid.
      const reason = parts.slice(3).join(';');
      return { nonce, kind: 'unsupported', reason };
    }
    default:
      return null;
  }
}

/**
 * Builds the raw OSC bytes for a marker payload (for tests and diagnostics).
 * Shell scripts do not embed these bytes directly; they use printable octal
 * escapes so the generated command line stays copy-safe.
 */
export function encodeMarkerOsc(nonce: string, payload: string): string {
  return `\x1b]${MARKER_OSC_ID};${MARKER_NAMESPACE};${nonce};${payload}\x07`;
}
