import ssh2 from 'ssh2';
import type { Client as Ssh2Client, ConnectConfig } from 'ssh2';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LiteSshError } from '../core/errors.js';
import { endpointKey, normalizeIp } from '../core/targets.js';
import type { ConnectionLease, Endpoint, LoginTarget, ResolvedLogin } from '../core/types.js';
import type { ConfigStore } from '../config/store.js';
import { hostKeyDetails } from './fingerprint.js';

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const MAX_CONNECTIONS = 32;
const CLOSE_GRACE_MS = 2_000;

interface HostKeyObservation {
  /** Trust pin used when this concrete server key was observed. */
  configuredFingerprint: string | undefined;
  fingerprint: string;
  keyType: string;
  ip: string;
  port: number;
}

interface PoolEntry {
  key: string;
  client: Ssh2Client;
  leases: number;
  revision: string;
  ip: string;
  port: number;
  username: string;
  closed: boolean;
}

function tupleKey(resolved: ResolvedLogin): string {
  return JSON.stringify([resolved.target.ip, resolved.target.port, resolved.target.username, resolved.revision]);
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function mapConnectError(error: unknown): LiteSshError {
  const message = error instanceof Error ? error.message : '';
  if (/auth/i.test(message)) return new LiteSshError('AUTH_FAILED', 'SSH authentication failed.');
  return new LiteSshError('CONNECTION_LOST', 'The SSH connection failed before it became ready.');
}

/** Best-effort graceful close of an owned client. */
async function closeClient(client: Ssh2Client, alreadyClosed: boolean): Promise<void> {
  if (alreadyClosed) {
    try { client.end(); } catch { /* already gone */ }
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, CLOSE_GRACE_MS);
    client.once('close', finish);
    try {
      client.end();
    } catch {
      finish();
    }
  });
}

/**
 * Internal registry of authenticated SSH connections.
 *
 * Connections are reused per `ip + port + username + revision` tuple: the
 * revision changes whenever the selected credential or trust pin changes, so a
 * newer generation opens a new physical connection instead of mutating a live
 * one. Each physical connection carries a lease count; the last release closes
 * it, and an active lease is never closed by an idle policy (there is none).
 */
export class ConnectionPool {
  private readonly store: ConfigStore;
  private readonly readyTimeoutMs: number;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, Promise<PoolEntry>>();
  private readonly observed = new Map<string, HostKeyObservation>();
  private disposed = false;

  constructor(store: ConfigStore, options?: { readyTimeoutMs?: number }) {
    this.store = store;
    this.readyTimeoutMs = options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  async acquire(target: LoginTarget): Promise<ConnectionLease> {
    if (this.disposed) throw new LiteSshError('CONNECTION_LOST', 'The connection pool has been disposed.');
    const resolved = await this.store.resolveLogin(target);
    const key = tupleKey(resolved);

    const existing = this.entries.get(key);
    if (existing !== undefined && !existing.closed) {
      existing.leases += 1;
      return this.makeLease(existing, resolved.target);
    }

    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) {
      const entry = await inFlight;
      entry.leases += 1;
      return this.makeLease(entry, resolved.target);
    }

    if (this.entries.size + this.pending.size >= MAX_CONNECTIONS) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The connection pool has reached its connection budget.');
    }

    const creation = this.createEntry(key, resolved);
    this.pending.set(key, creation);
    let entry: PoolEntry;
    try {
      entry = await creation;
    } finally {
      this.pending.delete(key);
    }
    entry.leases += 1;
    return this.makeLease(entry, resolved.target);
  }

  /**
   * Gate a trust registration on the candidate this instance previously saw.
   * Unknown or mismatched candidates are refused so a value nobody displayed
   * cannot be written to the configuration.
   */
  async confirmHostKey(endpoint: Endpoint, fingerprint: string): Promise<{ changed: boolean; fingerprint: string }> {
    const ip = normalizeIp(endpoint.ip);
    const key = endpointKey({ ip, port: endpoint.port });
    const observation = this.observed.get(key);
    if (observation === undefined) {
      throw new LiteSshError('HOST_KEY_UNTRUSTED', 'This process has not observed a host key for this endpoint.', {
        ip,
        port: endpoint.port,
      });
    }
    if (observation.fingerprint !== fingerprint) {
      throw new LiteSshError('HOST_KEY_MISMATCH', 'The supplied fingerprint does not match the host key observed by this process.', {
        ip,
        port: endpoint.port,
        keyType: observation.keyType,
        expectedFingerprint: observation.fingerprint,
        fingerprint,
      });
    }
    return this.store.confirmHostKey({ ip, port: endpoint.port }, fingerprint, {
      expectedFingerprint: observation.configuredFingerprint,
      validateObservation: () => {
        if (this.disposed) throw new LiteSshError('SERVER_STOPPING', 'The connection pool is shutting down.');
        const current = this.observed.get(key);
        if (!current || current.fingerprint !== observation.fingerprint || current.keyType !== observation.keyType) {
          throw new LiteSshError('HOST_KEY_MISMATCH', 'The observed host key changed while confirmation was pending. Observe and confirm the current key again.', {
            ip, port: endpoint.port, fingerprint,
            ...(current ? { keyType: current.keyType, expectedFingerprint: current.fingerprint } : {}),
          });
        }
      },
    });
  }

  /** Close every owned connection and refuse further acquisitions. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.observed.clear();
    await Promise.all(entries.map(async (entry) => {
      const alreadyClosed = entry.closed;
      entry.leases = 0;
      entry.closed = true;
      await closeClient(entry.client, alreadyClosed);
    }));
  }

  private makeLease(entry: PoolEntry, target: LoginTarget): ConnectionLease {
    let released = false;
    return {
      client: entry.client,
      target,
      release: async () => {
        if (released) return;
        released = true;
        await this.releaseLease(entry);
      },
    };
  }

  private async releaseLease(entry: PoolEntry): Promise<void> {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases > 0) return;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    const alreadyClosed = entry.closed;
    entry.closed = true;
    await closeClient(entry.client, alreadyClosed);
  }

  private async createEntry(key: string, resolved: ResolvedLogin): Promise<PoolEntry> {
    const { ip, port, username } = resolved.target;
    const client = new ssh2.Client();
    let rejection: LiteSshError | undefined;

    // `hostHash` is intentionally omitted so ssh2 passes the raw host-key blob.
    // Returning false aborts the handshake before user authentication begins.
    const hostVerifier = (rawKey: Buffer): boolean => {
      let details;
      try {
        details = hostKeyDetails(rawKey);
      } catch {
        rejection = new LiteSshError('HOST_KEY_UNTRUSTED', 'The server host key could not be read.', { ip, port, keyType: 'unknown', fingerprint: '' });
        return false;
      }
      this.observed.set(endpointKey({ ip, port }), { ip, port, keyType: details.keyType, fingerprint: details.fingerprint, configuredFingerprint: resolved.hostKeyFingerprint });
      if (resolved.hostKeyFingerprint === undefined) {
        rejection = new LiteSshError('HOST_KEY_UNTRUSTED', 'The server host key is not confirmed for this endpoint.', {
          ip,
          port,
          keyType: details.keyType,
          fingerprint: details.fingerprint,
        });
        return false;
      }
      if (resolved.hostKeyFingerprint !== details.fingerprint) {
        rejection = new LiteSshError('HOST_KEY_MISMATCH', 'The observed host key fingerprint differs from the confirmed fingerprint.', {
          ip,
          port,
          keyType: details.keyType,
          expectedFingerprint: resolved.hostKeyFingerprint,
          fingerprint: details.fingerprint,
        });
        return false;
      }
      return true;
    };

    const config: ConnectConfig = { host: ip, port, username, readyTimeout: this.readyTimeoutMs, hostVerifier };
    if (resolved.auth.type === 'password') {
      config.password = resolved.auth.password;
    } else {
      // Load only this requested login's key, internally. ssh2 still cannot
      // send user authentication until hostVerifier accepts the server key.
      config.privateKey = await this.loadPrivateKey(resolved.auth.privateKeyPath);
      if (resolved.auth.passphrase !== undefined) config.passphrase = resolved.auth.passphrase;
    }

    try {
      await this.openConnection(client, config, () => rejection);
    } catch (error) {
      await closeClient(client, true);
      throw error;
    }

    if (this.disposed) {
      await closeClient(client, true);
      throw new LiteSshError('CONNECTION_LOST', 'The connection pool was disposed while this connection was opening.');
    }

    const entry: PoolEntry = { key, client, leases: 0, revision: resolved.revision, ip, port, username, closed: false };
    client.on('close', () => {
      entry.closed = true;
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    client.on('error', () => {
      // A permanent handler keeps a late socket error from becoming unhandled.
    });
    this.entries.set(key, entry);
    return entry;
  }

  private openConnection(client: Ssh2Client, config: ConnectConfig, rejectionOf: () => LiteSshError | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let state: 'opening' | 'ready' | 'failed' = 'opening';
      const fail = (error: LiteSshError): void => {
        if (state !== 'opening') return;
        state = 'failed';
        reject(error);
      };
      client.on('error', (error: Error) => {
        if (state === 'ready') return; // A later socket error is not a handshake failure.
        fail(rejectionOf() ?? mapConnectError(error));
      });
      client.on('timeout', () => fail(rejectionOf() ?? new LiteSshError('CONNECT_TIMEOUT', 'The SSH handshake did not complete before the deadline.')));
      client.on('close', () => fail(rejectionOf() ?? new LiteSshError('CONNECTION_LOST', 'The SSH connection closed before it became ready.')));
      client.once('ready', () => {
        state = 'ready';
        resolve();
      });
      try {
        client.connect(config);
      } catch (error) {
        fail(mapConnectError(error));
      }
    });
  }

  private async loadPrivateKey(privateKeyPath: string): Promise<string> {
    try {
      return await fs.readFile(expandHome(privateKeyPath), 'utf8');
    } catch {
      // Never echo the path: it is not needed to understand the failure.
      throw new LiteSshError('AUTH_FAILED', 'The configured private key could not be read.');
    }
  }
}
