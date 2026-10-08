/**
 * Public surface of the readable terminal cache.
 *
 * HANDOVER: import `ReadableRecorder` from here (or directly from
 * `./recorder.js` in tests). `DEFAULT_MAX_PENDING_BYTES` and
 * `PREVIEW_LIMIT_CHARACTERS` are re-exported so callers/tests can reason about
 * the bounded budgets without reaching into `prefixes.js`.
 */
export { ReadableRecorder, type CloseResult } from './recorder.js';
export { DEFAULT_MAX_PENDING_BYTES, PREVIEW_LIMIT_CHARACTERS } from './prefixes.js';
