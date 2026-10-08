import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { LiteSshError } from '../core/errors.js';
import { endpointKey, loginKey, normalizeIp } from '../core/targets.js';
import type { Endpoint, LoginTarget, ResolvedLogin } from '../core/types.js';
import { isFingerprint } from './fingerprint.js';
import { parseJsonStrict, type JsonObject, type JsonValue } from './json.js';
import { buildConfigurationView, type ConfigurationView, type LoginEntry } from './schema.js';

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

  constructor(filePath: string = defaultConfigPath()) {
    this.filePath = filePath;
  }

  /** All configured login combinations, with credentials and paths stripped. */
  async listConfigurations(): Promise<LoginTarget[]> {
    const view = await this.load();
    return view.list.map((target) => ({ ip: target.ip, port: target.port, username: target.username }));
  }

  /** Resolve one login combination to its credential branch and trust pin. */
  async resolveLogin(target: LoginTarget): Promise<ResolvedLogin> {
    const key = loginKey(target); // validates ip, port and username
    const view = await this.load();
    const entry = view.logins.get(key);
    if (entry === undefined) {
      if (!view.endpoints.has(endpointKey({ ip: target.ip, port: target.port }))) {
        throw new LiteSshError('CONFIG_NOT_FOUND', 'The requested endpoint is not present in the configuration.');
      }
      throw new LiteSshError('ACCOUNT_NOT_FOUND', 'The requested account is not present in the configuration.');
    }
    const resolved: ResolvedLogin = {
      target: { ip: entry.ip, port: entry.port, username: entry.username },
      auth: entry.auth.type === 'password'
        ? { type: 'password', password: entry.auth.password }
        : { type: 'privateKey', privateKeyPath: entry.auth.privateKeyPath, ...(entry.auth.passphrase !== undefined ? { passphrase: entry.auth.passphrase } : {}) },
      revision: revisionOf(entry),
    };
    if (entry.hostKeyFingerprint !== undefined) resolved.hostKeyFingerprint = entry.hostKeyFingerprint;
    return resolved;
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
  async confirmHostKey(endpoint: Endpoint, fingerprint: string, guard?: HostKeyConfirmationGuard): Promise<{ changed: boolean; fingerprint: string }> {
    const ip = normalizeIp(endpoint.ip);
    const port = endpoint.port;
    endpointKey({ ip, port }); // validate the port range
    if (!isFingerprint(fingerprint)) {
      throw new LiteSshError('CONFIG_INVALID', 'The fingerprint must use the SHA256 standard base64 form.');
    }

    const release = await this.acquireLock();
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
      if (entry.hostKeyFingerprint === fingerprint) return { changed: false, fingerprint };
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
      return { changed: true, fingerprint };
    } finally {
      await release();
    }
  }

  private async load(): Promise<ConfigurationView> {
    return buildConfigurationView(await this.readRaw());
  }

  private async readRaw(): Promise<JsonObject> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new LiteSshError('CONFIG_NOT_FOUND', 'No configuration file was found for the current user.');
      }
      throw new LiteSshError('CONFIG_INVALID', 'The configuration file could not be read.');
    }
    const value: JsonValue = parseJsonStrict(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new LiteSshError('CONFIG_INVALID', 'The configuration root must be a JSON object.');
    }
    return value;
  }

  /** Acquire the exclusive sibling lock, waiting at most the deadline. */
  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.filePath}.lock`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_DEADLINE_MS;
    for (;;) {
      let handle: FileHandle | undefined;
      try {
        handle = await fs.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new LiteSshError('CONFIG_LOCKED', 'The configuration lock could not be created.');
        }
      }
      if (handle !== undefined) {
        // Only the creator removes the lock; a stale lock is never swept.
        return async () => {
          try {
            await fs.rm(lockPath, { force: true });
          } catch {
            /* The lock already disappeared; closing the handle is still required. */
          } finally {
            try {
              await handle.close();
            } catch {
              /* Nothing further can be done for an already-closed handle. */
            }
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

async function atomicWrite(filePath: string, value: JsonObject, beforeCommit?: () => void): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  let closed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    closed = true;
    beforeCommit?.();
    await fs.rename(temporary, filePath);
  } catch (error) {
    if (!closed) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fs.rm(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}
