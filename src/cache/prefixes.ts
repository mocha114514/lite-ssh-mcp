/**
 * Frozen on-disk conventions for the readable terminal cache.
 *
 * HANDOVER / WHY THIS FILE EXISTS
 * -------------------------------
 * The cache is a plain UTF-8 text log, not a packet dump. All markers, data
 * prefixes and limits are frozen here so that `recorder.ts`, the tests and any
 * external grep/PowerShell/editor tooling agree on one vocabulary. Freezing the
 * vocabulary in a single module is what lets an agent locate a round with the
 * same file tools it already has; changing a prefix here is a format change and
 * must be coordinated with `recorder.ts` and `test/cache.test.ts`.
 *
 * Conventions (also mirrored in design doc 7.3):
 *   - Control markers are bracketed lines: `[ROUND R1 BEGIN]`, `[SCREEN F2]`.
 *   - Readable data lines carry a data prefix so a program that literally emits
 *     the word "ROUND" can never forge a round boundary:
 *         normal buffer    -> `| `
 *         alternate buffer -> `~ `
 *   - `cacheRange` values returned to the caller are the bracket-less marker
 *     identities (`ROUND R1 BEGIN`), which are substrings of the on-disk lines
 *     and therefore directly greppable.
 *
 * Central `ParsedLine` lives in `src/core/types.ts` and is intentionally NOT
 * redefined here.
 */

/** Maximum number of Unicode code points kept as an ordinary round body preview. */
export const PREVIEW_LIMIT_CHARACTERS = 1000;

/**
 * Bounded in-memory write backlog. The caller streams bounded chunks and calls
 * `flush()` after each chunk, so this budget is a safety net against a single
 * enormous event, never a limit on how much history reaches disk.
 */
export const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Data-line prefixes for the two terminal buffers. */
export const DATA_PREFIX: Readonly<Record<'normal' | 'alternate', string>> = {
  normal: '| ',
  alternate: '~ ',
};

/** Marker written once when a queue/disk failure is detected. */
export const CACHE_ERROR_LINE = '[CACHE ERROR]';

/**
 * Metadata marker for the trusted shell BEGIN of the current round's command.
 * It is emitted by `markCommandStarted()` AFTER any pre-execution echo that was
 * already cached under the same round, so the two are visibly separated on disk.
 */
export const SHELL_COMMAND_BEGIN_LINE = '[SHELL COMMAND BEGIN]';

/** On-disk marker lines. */
export function roundBeginLine(round: string): string { return `[ROUND ${round} BEGIN]`; }
export function roundEndLine(round: string, exitCode: number): string { return `[ROUND ${round} END] exitCode=${exitCode}`; }
export function outputSectionLine(round: string): string { return `[OUTPUT ${round}]`; }
export function stepMarkerLine(step: string): string { return `[STEP ${step}]`; }
/** Trusted shell BEGIN marker; see `SHELL_COMMAND_BEGIN_LINE`. */
export function shellCommandBeginLine(): string { return SHELL_COMMAND_BEGIN_LINE; }
export function frameMarkerLine(frame: string): string { return `[SCREEN ${frame}]`; }
export function styleMarkerLine(frame: string): string { return `[STYLE ${frame}]`; }

/** Bracket-less marker identities reported back through `RoundResult.cacheRange`. */
export function roundBeginMarker(round: string): string { return `ROUND ${round} BEGIN`; }
export function roundEndMarker(round: string): string { return `ROUND ${round} END`; }
