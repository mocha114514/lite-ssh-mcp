import ssh2 from 'ssh2';
import type { Client as Ssh2Client, ConnectConfig } from 'ssh2';
import { createHmac, randomBytes } from 'node:crypto';
import { LiteSshError } from '../core/errors.js';
import { endpointKey, normalizeIp } from '../core/targets.js';
import type { ConnectionLease, Endpoint, LoginTarget, ResolvedLogin } from '../core/types.js';
import type { ConfigStore } from '../config/store.js';
import { hostKeyDetails } from './fingerprint.js';
import { ClientOwner } from './clientOwner.js';
import { readPrivateKey } from './privateKey.js';

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const MAX_CONNECTIONS = 32;

interface HostKeyObservation {
  /** Trust pin used when this concrete server key was observed. */
  configuredFingerprint: string | undefined;
  fingerprint: string;
  keyType: string;
  ip: string;
  port: number;
}

interface ConnectionReservation {
  owner?: ClientOwner;
}

interface PoolEntry {
  key: string;
  client: Ssh2Client;
  leases: number;
  revision: string;
  ip: string;
  port: number;
  username: string;
  readonly closed: boolean;
  owner: ClientOwner;
}

function tupleKey(resolved: ResolvedLogin): string {
  return JSON.stringify([resolved.target.ip, resolved.target.port, resolved.target.username, resolved.revision]);
}

function mapConnectError(error: unknown): LiteSshError {
  const message = error instanceof Error ? error.message : '';
  if (/auth/i.test(message)) return new LiteSshError('AUTH_FAILED', 'SSH authentication failed.');
  return new LiteSshError('CONNECTION_LOST', 'The SSH connection failed before it became ready.');
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
  private closing?: Promise<void>;
  private readonly acquiring = new Set<Promise<ConnectionLease>>();
  private readonly clients = new Set<ClientOwner>();
  private readonly reservations = new Set<ConnectionReservation>();
  /** Process-local generation MAC, never exposed in leases/results/logs. */
  private readonly materialGenerationKey = randomBytes(32);

  constructor(store: ConfigStore, options?: { readyTimeoutMs?: number }) {
    this.store = store;
    this.readyTimeoutMs = options?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  acquire(target: LoginTarget): Promise<ConnectionLease> {
    if (this.disposed) return Promise.reject(new LiteSshError('CONNECTION_LOST', 'The connection pool has been disposed.'));
    // Track the request before its first configuration/key-loading yield, not
    // merely after a socket has reached the pending/ready maps.
    const operation = this.acquireLease(target);
    this.acquiring.add(operation);
    void operation.finally(() => this.acquiring.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async acquireLease(target: LoginTarget): Promise<ConnectionLease> {
    let resolved = await this.store.resolveLogin(target);
    if (this.disposed) throw new LiteSshError('CONNECTION_LOST', 'The connection pool stopped during login resolution.');
    let privateKey: string | undefined;
    if (resolved.auth.type === 'privateKey') {
      // Validate only this selected credential on EVERY new resource request,
      // including reuse. File rotation at an unchanged path is a new snapshot.
      privateKey = await readPrivateKey(resolved.auth.privateKeyPath);
      const parsed = ssh2.utils.parseKey(privateKey, resolved.auth.passphrase);
      if (parsed instanceof Error || !parsed.isPrivateKey()) {
        throw new LiteSshError('AUTH_FAILED', 'The configured private key could not be parsed as a private credential.');
      }
      const revision = createHmac('sha256', this.materialGenerationKey)
        .update(resolved.revision)
        .update('\0')
        .update(privateKey)
        .digest('hex');
      resolved = { ...resolved, revision };
    }
    if (this.disposed) throw new LiteSshError('CONNECTION_LOST', 'The connection pool stopped during authentication-material loading.');
    const key = tupleKey(resolved);

    const existing = this.entries.get(key);
    if (existing !== undefined && !existing.closed) {
      existing.leases += 1;
      return this.makeLease(existing, resolved.target);
    }

    const inFlight = this.pending.get(key);
    if (inFlight !== undefined) {
      const entry = await inFlight;
      if (this.disposed || entry.closed) throw new LiteSshError('CONNECTION_LOST', 'The connection stopped before its lease could be issued.');
      entry.leases += 1;
      return this.makeLease(entry, resolved.target);
    }

    if (this.reservations.size >= MAX_CONNECTIONS) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The connection pool has reached its connection budget.');
    }

    // The reader has its own bounded admission; now reserve exactly once for
    // the physical generation through handshake, ready leases and actual close.
    // Do not double-count pending owners or forget closing ones.
    const reservation: ConnectionReservation = {};
    this.reservations.add(reservation);
    const creation = this.createEntry(key, resolved, reservation, privateKey);
    this.pending.set(key, creation);
    let entry: PoolEntry;
    try {
      entry = await creation;
    } finally {
      this.pending.delete(key);
      if (!reservation.owner) this.reservations.delete(reservation);
    }
    if (this.disposed || entry.closed) throw new LiteSshError('CONNECTION_LOST', 'The connection stopped before its lease could be issued.');
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
  dispose(): Promise<void> {
    this.disposed = true;
    this.closing ??= (async () => {
      this.entries.clear();
      this.observed.clear();
      // Physical ownership survives removal from the reusable-entry map.
      // End already-started clients now; pending acquisitions cannot create
      // another owner after their post-await stopping checks.
      const closes = [...this.clients].map(owner => owner.close());
      const results = Promise.allSettled(closes);
      await Promise.allSettled([...this.acquiring]);
      const closed = await results;
      if (closed.some(result => result.status === 'rejected') || this.clients.size > 0) {
        throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'One or more owned SSH clients did not confirm closure.', {
          unconfirmedClients: this.clients.size
        });
      }
    })();
    return this.closing;
  }

  private makeLease(entry: PoolEntry, target: LoginTarget): ConnectionLease {
    let releasing: Promise<void> | undefined;
    return {
      client: entry.client,
      target,
      release: () => releasing ??= this.releaseLease(entry),
    };
  }

  private async releaseLease(entry: PoolEntry): Promise<void> {
    entry.leases = Math.max(0, entry.leases - 1);
    if (entry.leases > 0) return;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    await entry.owner.close();
  }

  private async createEntry(
    key: string,
    resolved: ResolvedLogin,
    reservation: ConnectionReservation,
    privateKey?: string
  ): Promise<PoolEntry> {
    const { ip, port, username } = resolved.target;
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
      // Already bounded/read/validated for this request, before owning a socket.
      // Authentication is still gated on hostVerifier accepting the server key.
      config.privateKey = privateKey!;
      if (resolved.auth.passphrase !== undefined) config.passphrase = resolved.auth.passphrase;
    }

    if (this.disposed) throw new LiteSshError('CONNECTION_LOST', 'The connection pool stopped during authentication-material loading.');
    const client = new ssh2.Client();
    const owner = new ClientOwner(client, () => {
      this.clients.delete(owner);
      this.reservations.delete(reservation);
    });
    reservation.owner = owner;
    this.clients.add(owner);
    try {
      await this.openConnection(client, config, () => rejection);
    } catch (error) {
      try { await owner.close(); }
      catch {
        const primary = error instanceof LiteSshError ? error : mapConnectError(error);
        throw new LiteSshError(primary.code, primary.message, { ...primary.details, connectionCleanupConfirmed: false });
      }
      throw error;
    }

    if (this.disposed) {
      await owner.close();
      throw new LiteSshError('CONNECTION_LOST', 'The connection pool was disposed while this connection was opening.');
    }

    const entry: PoolEntry = {
      key, client, owner, leases: 0, revision: resolved.revision, ip, port, username,
      get closed() { return owner.closed; }
    };
    client.on('close', () => {
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

}
