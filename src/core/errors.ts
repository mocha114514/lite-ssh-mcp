/** Business errors only carry deliberately public details, never credentials/raw packets. */
export class LiteSshError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LiteSshError';
  }
  toResult(): Record<string, unknown> {
    return { ok: false, state: 'error', code: this.code, message: this.message, ...this.details };
  }
}

export function publicError(error: unknown): Record<string, unknown> {
  if (error instanceof LiteSshError) return error.toResult();
  // A library/filesystem exception can contain secret paths or payloads.
  return { ok: false, state: 'error', code: 'INTERNAL_ERROR', message: 'The operation failed; no input has been automatically replayed.' };
}
