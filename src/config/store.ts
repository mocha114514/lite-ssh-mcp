import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { LiteSshError } from '../core/errors.js';
import { CleanupFailures } from '../core/cleanup.js';
import { endpointKey, loginKey, normalizeIp } from '../core/targets.js';
import type { Endpoint, LoginTarget, ResolvedLogin } from '../core/types.js';
import { isFingerprint } from './fingerprint.js';
import { parseJsonStrict, type JsonObject, type JsonValue } from './json.js';
import { buildConfigurationView, type ConfigurationView, type LoginEntry } from './schema.js';
import { ensurePrivateDirectory, requirePrivatePath, unlinkOwnedFile, type PrivateObjectIdentity } from '../platform/permissions.js';
import { readConfigurationText } from './file.js';
import { MAX_CONFIG_BYTES, MAX_HOST_KEY_CONFIRMATIONS } from './limits.js';

const LOCK_DEADLINE_MS = 5_000;
const LOCK_RETRY_MS = 50;

/** Internal trust-observation guard; not a caller-controlled MCP parameter. */
export interface HostKeyConfirmationGuard {
  expectedFingerprint: string | undefined;
  validateObservation(): void;
}

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.lite-ssh', 'config.json');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Derive an opaque generation tag from the selected auth and trust pin. */
function revisionOf(entry: LoginEntry): string {
  const auth = entry.auth;
  const credential = auth.type === 'password' ? auth.password : `${auth.privateKeyPath}\u0000${auth.passphrase ?? ''}`;
  const material = JSON.stringify([entry.ip, entry.port, entry.username, auth.type, credential, entry.hostKeyFingerprint ?? null]);
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Read and validate the on-disk configuration.
 *
 * The store never touches the filesystem in its constructor: CLI help, version
 * and tool listing can construct it without reading a user's private files.
 * Every query reads the current file so a running instance always sees the
 * latest credentials and trust pins.
 */
export class ConfigStore {
  readonly filePath: string;
  private retainedConfirmations = 0;
  private stopping = false;
  private readonly business = new Set<Promise<unknown>>();
  private closingPromise: Promise<void> | undefined;

  constructor(filePath: string = defaultConfigPath()) {
    this.filePath = filePath;
  }

  /**
   * Execute an accepted business operation, registering its work promise in the
   * active business set synchronously BEFORE the operation callback is invoked.
   */
  private executeTracked<T>(operation: () => Promise<T>): Promise<T> {
    const work = Promise.resolve().then(operation);
    this.business.add(work);
    void work.then(
      () => {
        this.business.delete(work);
      },
      () => {
        this.business.delete(work);
      }
    );
    return work;
  }

  /** All configured login combinations, with credentials and paths stripped. */
  listConfigurations(): Promise<LoginTarget[]> {
    if (this.stopping) {
      return Promise.reject(new LiteSshError('SERVER_STOPPING', 'The configuration store is shutting down.'));
    }
    return this.executeTracked(async () => {
      const view = await this.load();
      return view.list.map((target) => ({
        ip: target.ip,
        port: target.port,
        username: target.username
      }));
    });
  }

  /** Resolve one login combination to its credential branch and trust pin. */
  resolveLogin(target: LoginTarget): Promise<ResolvedLogin> {
    let key: string;
    try {
      key = loginKey(target); // validates ip, port and username
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.stopping) {
      return Promise.reject(new LiteSshError('SERVER_STOPPING', 'The configuration store is shutting down.'));
    }

    return this.executeTracked(async () => {
      const view = await this.load();
      const entry = view.logins.get(key);
      if (entry === undefined) {
        if (!view.endpoints.has(endpointKey({ ip: target.ip, port: target.port }))) {
          throw new LiteSshError('CONFIG_NOT_FOUND', 'The requested endpoint is not present in the configuration.');
        }
        throw new LiteSshError('ACCOUNT_NOT_FOUND', 'The requested account is not present in the configuration.');
      }
      const resolved: ResolvedLogin = {
        target: {
          ip: entry.ip,
          port: entry.port,
          username: entry.username
        },
        auth: entry.auth.type === 'password'
          ? { type: 'password', password: entry.auth.password }
          : {
              type: 'privateKey',
              privateKeyPath: entry.auth.privateKeyPath,
              ...(entry.auth.passphrase !== undefined ? { passphrase: entry.auth.passphrase } : {})
            },
        revision: revisionOf(entry)
      };
      if (entry.hostKeyFingerprint !== undefined) {
        resolved.hostKeyFingerprint = entry.hostKeyFingerprint;
      }
      return resolved;
    });
  }

  /**
   * Record a confirmed trust pin for one already-configured port.
   *
   * Only the chosen port's `hostKeyFingerprint` changes; if the endpoint is not
   * present the call fails with CONFIG_NOT_FOUND and the file is untouched. A
   * cross-process exclusive sibling lock serializes writers; the file is
   * re-read under the lock and a temporary sibling is written with `wx`/0600
   * and renamed over the configuration so readers never observe a partial file.
   */
  confirmHostKey(
    endpoint: Endpoint,
    fingerprint: string,
    guard?: HostKeyConfirmationGuard
  ): Promise<{ changed: boolean; fingerprint: string }> {
    let ip: string;
    let port: number;
    try {
      ip = normalizeIp(endpoint.ip);
      port = endpoint.port;
      endpointKey({ ip, port }); // validate the port range
      if (!isFingerprint(fingerprint)) {
        throw new LiteSshError('CONFIG_INVALID', 'The fingerprint must use the SHA256 standard base64 form.');
      }
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.stopping) {
      return Promise.reject(new LiteSshError('SERVER_STOPPING', 'The configuration store is shutting down.'));
    }

    // Readers and native permission helpers have later admission points. Hold
    // this independent work credit before even the first directory/lock await.
    if (this.retainedConfirmations >= MAX_HOST_KEY_CONFIRMATIONS) {
      return Promise.reject(new LiteSshError('RESOURCE_LIMIT', 'Too many host-key confirmations are awaiting completion.'));
    }
    this.retainedConfirmations++;

    return this.executeTracked(async () => {
      try {
        // Await the business finalizers: returning its promise directly would
        // retire this credit early. SDK observation cancellation is not retirement.
        return await this.performConfirmation({ ip, port }, fingerprint, guard);
      } finally {
        this.retainedConfirmations--;
      }
    });
  }

  /**
   * Synchronously stop admission of new queries and confirmations, and wait for
   * all accepted in-flight operations in the initial cohort to settle.
   * Historical already-settled failures do not make shutdown fail.
   */
  close(): Promise<void> {
    this.stopping = true;
    this.closingPromise ??= (async () => {
      // Capture unsettled cohort only at the moment close() is first called.
      const cohort = Array.from(this.business);
      if (cohort.length === 0) {
        return;
      }

      const outcomes = await Promise.allSettled(cohort);
      const cleanup = new CleanupFailures();
      let primaryError: LiteSshError | undefined;

      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          const uncertainty = extractCleanupUncertainty(outcome.reason);
          if (uncertainty !== undefined) {
            primaryError ??= outcome.reason instanceof LiteSshError ? outcome.reason : undefined;
            cleanup.add('configuration', outcome.reason, uncertainty.code, uncertainty.facts);
          }
        }
      }

      cleanup.throwIfAny(primaryError ? { error: primaryError } : undefined);
    })();

    return this.closingPromise;
  }

  private async performConfirmation(
    endpoint: Endpoint,
    fingerprint: string,
    guard?: HostKeyConfirmationGuard
  ): Promise<{ changed: boolean; fingerprint: string }> {
    const { ip, port } = endpoint;
    const release = await this.acquireLock();
    let confirmationCompleted = false;
    let configurationChanged = false;
    let primaryError: unknown;
    try {
      const raw = await this.readRaw();
      const view: ConfigurationView = buildConfigurationView(raw);
      const slot = view.endpoints.get(endpointKey({ ip, port }));
      if (slot === undefined) {
        // Confirmation registers trust for an already-configured port only. A
        // missing endpoint means the file no longer matches what this instance
        // observed; the file is left byte-for-byte unchanged.
        throw new LiteSshError('CONFIG_NOT_FOUND', 'The requested endpoint is not present in the configuration.');
      }

      const servers = raw.servers as JsonObject;
      const portObject = servers[slot.ipRaw] as JsonObject;
      const entry = portObject[slot.portRaw] as JsonObject;
      guard?.validateObservation();
      if (entry.hostKeyFingerprint === fingerprint) {
        confirmationCompleted = true;
        return { changed: false, fingerprint };
      }
      if (guard && entry.hostKeyFingerprint !== guard.expectedFingerprint) {
        throw new LiteSshError('HOST_KEY_MISMATCH', 'Endpoint trust changed after this observation. Observe and confirm the current key again.', {
          ip, port, fingerprint,
          ...(entry.hostKeyFingerprint !== undefined ? { expectedFingerprint: entry.hostKeyFingerprint } : {}),
        });
      }
      entry.hostKeyFingerprint = fingerprint;
      // Async temporary-file writes must not let a newer observation slip past
      // the earlier check. Revalidate immediately before atomic publication.
      await atomicWrite(this.filePath, raw, () => guard?.validateObservation());
      confirmationCompleted = true;
      configurationChanged = true;
      return { changed: true, fingerprint };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try { await release(); }
      catch (error) {
        // A successful rename must not be described as rolled back because
        // lock cleanup failed. Conversely, preserve a primary validation/write
        // failure and attach cleanup facts rather than replacing its meaning.
        const cleanup = error instanceof LiteSshError ? error.details : {};
        const details = {
          ...(primaryError instanceof LiteSshError ? primaryError.details : {}),
          confirmationCompleted,
          configurationChanged,
          lockCleanup: { complete: false, ...cleanup }
        };
        if (primaryError instanceof LiteSshError) {
          throw new LiteSshError(primaryError.code, primaryError.message, details);
        }
        throw new LiteSshError('CONFIG_LOCK_CLEANUP_FAILED',
          'Configuration lock cleanup was not confirmed. Check the reported lock name without deleting a replacement object.', details);
      }
    }
  }

  private async load(): Promise<ConfigurationView> {
    return buildConfigurationView(await this.readRaw());
  }

  private async readRaw(): Promise<JsonObject> {
    const text = await readConfigurationText(this.filePath);
    const value: JsonValue = parseJsonStrict(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new LiteSshError('CONFIG_INVALID', 'The configuration root must be a JSON object.');
    }
    return value;
  }

  /** Acquire the exclusive sibling lock, waiting at most the deadline. */
  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.filePath}.lock`;
    await ensurePrivateDirectory(path.dirname(this.filePath));
    const deadline = Date.now() + LOCK_DEADLINE_MS;
    for (;;) {
      let handle: FileHandle | undefined;
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
        await requirePrivatePath(lockPath, 'file', true, handle);
      } catch (error) {
        if (handle !== undefined) {
          let removalConfirmed = false;
          let handleCloseConfirmed = false;
          try { await unlinkOwnedFile(lockPath, handle); removalConfirmed = true; }
          catch { /* A failed first identity capture is not deletion authority. */ }
          finally {
            try { await handle.close(); handleCloseConfirmed = true; }
            catch { /* Preserve and expose close uncertainty without native details. */ }
          }
          const primary = error instanceof LiteSshError ? error
            : new LiteSshError('CONFIG_LOCKED', 'The acquired configuration lock could not be safely initialized.');
          throw new LiteSshError(primary.code, primary.message, {
            ...primary.details,
            lockCleanup: {
              removalConfirmed, handleCloseConfirmed,
              ...(!removalConfirmed ? { possibleResidualPaths: [lockPath] } : {})
            }
          });
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new LiteSshError('CONFIG_LOCKED', 'The configuration lock could not be created.');
        }
      }
      if (handle !== undefined) {
        // Only the creator removes the lock; a stale lock is never swept.
        return async () => {
          let removalConfirmed = false;
          let handleCloseConfirmed = false;
          try {
            // ENOENT is already handled by unlinkOwnedFile. Other errors mean
            // ownership/boundary/removal is unconfirmed, not 'already gone'.
            await unlinkOwnedFile(lockPath, handle);
            removalConfirmed = true;
          } catch { /* Preserve the uncertain name; report below. */ }
          finally {
            try { await handle.close(); handleCloseConfirmed = true; }
            catch { /* Never claim a failed close was confirmed. */ }
          }
          if (!removalConfirmed || !handleCloseConfirmed) {
            throw new LiteSshError('CONFIG_LOCK_CLEANUP_FAILED', 'The owned configuration lock was not fully cleaned up.', {
              removalConfirmed,
              handleCloseConfirmed,
              ...(!removalConfirmed ? { possibleResidualPaths: [lockPath] } : {})
            });
          }
        };
      }
      if (Date.now() >= deadline) {
        throw new LiteSshError('CONFIG_LOCKED', 'Another process is holding the configuration lock.');
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/**
 * Extract only whitelisted, bounded boolean facts from known cleanup uncertainty flags.
 * Gathers all concurrent uncertainties for a single business operation into one facts object.
 * Raw error messages and secret paths are strictly excluded.
 */
function extractCleanupUncertainty(
  error: unknown
): { code: string; facts: Record<string, unknown> } | undefined {
  if (!(error instanceof LiteSshError) || typeof error.details !== 'object' || error.details === null) {
    return undefined;
  }
  const details = error.details as Record<string, unknown>;
  const facts: Record<string, unknown> = {};
  let hasUncertainty = false;

  if (details.configurationHandleCloseConfirmed === false) {
    facts.configurationHandleCloseConfirmed = false;
    hasUncertainty = true;
  }

  if (details.temporaryHandleCloseConfirmed === false) {
    facts.temporaryHandleCloseConfirmed = false;
    hasUncertainty = true;
  }

  // A healthy temporary FD close does not prove removal after publication
  // failed. Project only completion, never residual names or native errors,
  // into this bounded ownership-fact map.
  if (details.cleanupComplete === false) {
    facts.temporaryCleanupComplete = false;
    hasUncertainty = true;
  }

  if (details.lockCleanup && typeof details.lockCleanup === 'object') {
    const lc = details.lockCleanup as Record<string, unknown>;
    if (lc.handleCloseConfirmed === false || lc.complete === false || lc.removalConfirmed === false) {
      const lockCleanupFacts: Record<string, unknown> = {};
      if (typeof lc.complete === 'boolean') lockCleanupFacts.complete = lc.complete;
      if (typeof lc.removalConfirmed === 'boolean') lockCleanupFacts.removalConfirmed = lc.removalConfirmed;
      if (typeof lc.handleCloseConfirmed === 'boolean') lockCleanupFacts.handleCloseConfirmed = lc.handleCloseConfirmed;
      facts.lockCleanup = lockCleanupFacts;
      hasUncertainty = true;
    }
  }

  if (!hasUncertainty) {
    return undefined;
  }

  return {
    code: error.code,
    facts
  };
}

async function atomicWrite(filePath: string, value: JsonObject, beforeCommit?: () => void): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) {
    throw new LiteSshError('RESOURCE_LIMIT', 'The configuration update exceeds the 4 MiB write budget.');
  }
  // New keys also consume structural budget. Never publish a document that
  // our own reader would reject immediately after a successful confirmation.
  parseJsonStrict(serialized);
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  );
  const handle = await fs.open(temporary, 'wx', 0o600);
  let identity: PrivateObjectIdentity | undefined;
  let closed = false;
  let temporaryHandleCloseConfirmed = true;

  try {
    identity = await handle.stat({ bigint: true });
    await requirePrivatePath(temporary, 'file', true, handle);
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    try {
      await handle.close();
      closed = true;
    } catch {
      temporaryHandleCloseConfirmed = false;
      throw new LiteSshError(
        'CONFIG_WRITE_FAILED',
        'The temporary configuration file handle could not confirm closure.'
      );
    }
    beforeCommit?.();
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        temporaryHandleCloseConfirmed = false;
      }
    }
    let cleanupComplete = false;
    if (identity) {
      try {
        await unlinkOwnedFile(temporary, identity);
        cleanupComplete = true;
      } catch {
        /* Preserve the uncertain object and report it, never force-rm. */
      }
    }
    const failure = error instanceof LiteSshError
      ? error
      : new LiteSshError('CONFIG_WRITE_FAILED', 'The configuration update could not be safely written.');
    throw new LiteSshError(failure.code, failure.message, {
      ...failure.details,
      cleanupComplete,
      ...(!cleanupComplete ? { possibleResidualPaths: [temporary] } : {}),
      ...(temporaryHandleCloseConfirmed === false ? { temporaryHandleCloseConfirmed: false } : {})
    });
  }
}
