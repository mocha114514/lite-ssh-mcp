import { LiteSshError, publicError } from './errors.js';

export interface CleanupFailure {
  resource: 'terminal' | 'transfer' | 'sftp' | 'connection' | 'mcp' | 'configuration';
  code: string;
  /** Only caller-selected, bounded public ownership facts; never a raw Error. */
  facts?: Record<string, unknown>;
}

const MAX_FAILURES = 32;

/** A branded aggregate lets application shutdown retain component facts safely. */
export class CleanupError extends LiteSshError {
  constructor(
    primary: unknown,
    readonly failures: readonly CleanupFailure[],
    readonly failureCount: number
  ) {
    const safe = publicError(primary);
    const code = primary instanceof LiteSshError ? primary.code : String(safe.code);
    const message = primary instanceof LiteSshError ? primary.message : String(safe.message);
    // Deliberately public details must not override the authoritative class
    // fields or replace this aggregate's own bounded cleanup evidence.
    const {
      ok: _ok, state: _state, code: _code, message: _message,
      cleanupFailures: _failures, cleanupFailureCount: _count,
      cleanupFailuresComplete: _complete, ...details
    } = safe;
    super(code, message, {
      ...details,
      cleanupFailures: failures,
      cleanupFailureCount: failureCount,
      cleanupFailuresComplete: failures.length === failureCount
    });
  }
}

/** Continue independent finalizers, then report all known failures, boundedly. */
export class CleanupFailures {
  private readonly failures: CleanupFailure[] = [];
  private first: LiteSshError | undefined;
  private count = 0;

  add(
    resource: CleanupFailure['resource'],
    error: unknown,
    fallbackCode: string,
    facts?: Record<string, unknown>
  ): void {
    const failure = error instanceof LiteSshError ? error : new LiteSshError(
      fallbackCode,
      'Owned resource cleanup could not fully complete.'
    );
    this.first ??= failure;
    if (error instanceof CleanupError) {
      this.count += error.failureCount;
      for (const item of error.failures) {
        if (this.failures.length < MAX_FAILURES) this.failures.push(item);
      }
      return;
    }
    this.count++;
    if (this.failures.length < MAX_FAILURES) {
      this.failures.push({ resource, code: failure.code, ...(facts ? { facts } : {}) });
    }
  }

  async attempt(
    resource: CleanupFailure['resource'],
    action: () => unknown | Promise<unknown>,
    fallbackCode: string
  ): Promise<void> {
    try { await action(); }
    catch (error) { this.add(resource, error, fallbackCode); }
  }

  throwIfAny(primary?: { error: unknown }): void {
    if (this.count) {
      // The wrapper distinguishes even an explicit throw undefined/null from
      // absence of a primary failure; unknown primaries are safely projected.
      throw new CleanupError(primary ? primary.error : this.first, [...this.failures], this.count);
    }
  }
}
