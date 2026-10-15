import { LiteSshError, publicError } from '../core/errors.js';
import type { TerminalIdentity } from '../core/types.js';

/** Cleanup facts must not overwrite the classification of the primary error. */
function detailsOf(result: Record<string, unknown>): Record<string, unknown> {
  const { ok: _ok, state: _state, code: _code, message: _message, ...details } = result;
  return details;
}

export function connectionCleanupFailure(error: unknown): Record<string, unknown> {
  return {
    connectionCleanupConfirmed: false,
    connectionCleanupErrorCode: error instanceof LiteSshError
      ? error.code
      : 'CONNECTION_CLEANUP_FAILED'
  };
}

/** A rejected teardown may still carry known cache facts; preserve those first. */
export function terminalCleanupFailure(error: unknown): Record<string, unknown> {
  const details = error instanceof LiteSshError ? detailsOf(error.details) : {};
  return {
    ...details,
    ...(typeof details.cacheRemoved === 'boolean' ? {} : { cacheCleanupUnknown: true }),
    terminalCleanupErrorCode: error instanceof LiteSshError ? error.code : 'TERMINAL_CLEANUP_FAILED'
  };
}

export function withTerminalCleanup(
  error: unknown,
  identity: TerminalIdentity,
  cleanup: Record<string, unknown>
): LiteSshError {
  const safe = publicError(error);
  // Read class fields directly: even deliberately public details must not
  // replace the original code/message through toResult's final spread.
  const code = error instanceof LiteSshError ? error.code : String(safe.code);
  const message = error instanceof LiteSshError ? error.message : String(safe.message);
  const primary = error instanceof LiteSshError ? detailsOf(error.details) : detailsOf(safe);
  return new LiteSshError(code, message, {
    ...primary,
    ...detailsOf(cleanup),
    terminal: { ...identity }
  });
}

/** Shutdown aggregates only the known public scalar facts from a close result. */
export function terminalShutdownFacts(
  result: Record<string, unknown>,
  identity?: TerminalIdentity
): Record<string, unknown> {
  const facts: Record<string, unknown> = identity ? { terminal: { ...identity } } : {};
  const fields = [
    'cachePath', 'cacheRemoved', 'cleanupError', 'cacheCleanupUnknown',
    'localTerminalClosed', 'remoteChannelCleanupConfirmed',
    'connectionCleanupConfirmed', 'connectionCleanupErrorCode',
    'recordingErrorCode', 'cacheMayBeIncomplete', 'reason',
    'droppedChunks', 'droppedBytes', 'terminalCleanupErrorCode'
  ];
  for (const field of fields) {
    const value = result[field];
    if (typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
      facts[field] = value;
    }
  }
  return facts;
}
