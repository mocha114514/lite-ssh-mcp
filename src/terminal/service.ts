import { normalizeIp, validateTerminalTarget } from '../core/targets.js';
import { LiteSshError } from '../core/errors.js';
import { CleanupFailures } from '../core/cleanup.js';
import type { InputAction, LoginTarget, PageOptions, TerminalIdentity, TerminalTarget } from '../core/types.js';
import { ConnectionPool } from '../ssh/pool.js';
import { TerminalSession, type SessionOptions } from './session.js';
import { connectionCleanupFailure, terminalCleanupFailure, terminalShutdownFacts, withTerminalCleanup } from './cleanup.js';

interface Entry { identity: TerminalIdentity; session?: TerminalSession }
export interface TerminalServiceOptions extends SessionOptions { maxTerminals?: number }

/** Global active-name registry for one MCP instance; physical SSH sessions stay internal. */
export class TerminalService {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Set<Promise<unknown>>();
  private stopping = false;
  private retainedCloseCalls = 0;
  constructor(private readonly pool: ConnectionPool, private readonly options: TerminalServiceOptions = {}) {}

  async open(login: LoginTarget, codename: string): Promise<Record<string, unknown>> {
    const identity: TerminalIdentity = { ...login, ip: normalizeIp(login.ip), codename };
    validateTerminalTarget(identity);
    if (this.stopping) throw new LiteSshError('SERVER_STOPPING', 'The MCP instance is shutting down.');
    if (this.entries.has(codename)) throw new LiteSshError('CODENAME_IN_USE', 'Choose a different independent codename; automatic numbering is not performed.');
    if (this.entries.size >= (this.options.maxTerminals ?? 16)) throw new LiteSshError('RESOURCE_LIMIT', 'The M0 active-terminal budget has been reached.');
    const entry: Entry = { identity };
    this.entries.set(codename, entry); // Reserve before any asynchronous network work.
    const operation = (async () => {
      const lease = await this.pool.acquire(login);
      try {
        entry.session = await TerminalSession.open(lease, identity, this.options);
        return { ...(await entry.session.read()), shellIntegration: 'ready' };
      } catch (error) {
        // A first public-read failure still owns the whole returned session.
        // If open never returned, its protected factory/initialization path
        // already retained cache facts. Releasing the shared lease receipt
        // again is safe, but its rejection must not replace the primary error.
        let cleanup: Record<string, unknown> = {};
        if (entry.session) {
          try { cleanup = await entry.session.close(); }
          catch (closeError) { cleanup = terminalCleanupFailure(closeError); }
          cleanup.cachePath = entry.session.recorder.path;
        } else {
          try { await lease.release(); }
          catch (releaseError) { cleanup = connectionCleanupFailure(releaseError); }
        }
        throw withTerminalCleanup(error, identity, cleanup);
      }
    })();
    this.opening.add(operation);
    try { return await operation; }
    catch (error) { if (this.entries.get(codename) === entry) this.entries.delete(codename); throw error; }
    finally { this.opening.delete(operation); }
  }

  list(options: PageOptions = {}): Record<string, unknown> {
    let entries = [...this.entries.values()];
    if (options.ip !== undefined) entries = entries.filter(entry => entry.identity.ip === normalizeIp(options.ip!));
    if (options.port !== undefined) entries = entries.filter(entry => entry.identity.port === options.port);
    if (options.username !== undefined) entries = entries.filter(entry => entry.identity.username === options.username);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return {
      ok: true, state: 'listed', total: entries.length, offset, limit,
      terminals: entries.slice(offset, offset + limit).map(entry => ({
        ...entry.identity, state: entry.session?.status ?? 'opening',
        ...(entry.session ? { cachePath: entry.session.recorder.path } : {})
      })),
      hasMore: offset + limit < entries.length
    };
  }

  private bind(target: TerminalTarget): TerminalSession {
    if (this.stopping) throw new LiteSshError('SERVER_STOPPING', 'The MCP instance is shutting down.');
    validateTerminalTarget(target);
    const entry = this.entries.get(target.codename);
    if (!entry || entry.identity.ip !== normalizeIp(target.ip) || entry.identity.port !== target.port) {
      throw new LiteSshError('TERMINAL_NOT_FOUND', 'No active terminal matches ip, port and codename in this MCP instance.');
    }
    if (!entry.session) throw new LiteSshError('TERMINAL_OPENING', 'This name is reserved while shell initialization is in progress.');
    return entry.session;
  }
  read(target: TerminalTarget): Promise<Record<string, unknown>> { return this.bind(target).read(); }
  write(target: TerminalTarget, actions: InputAction[], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.bind(target).write(actions, signal); }
  resize(target: TerminalTarget, cols: number, rows: number): Promise<Record<string, unknown>> { return this.bind(target).resize(cols, rows); }
  async close(target: TerminalTarget): Promise<Record<string, unknown>> {
    const session = this.bind(target);
    // Public observers can join one owner future indefinitely. Reserve before
    // the first await; SDK cancellation does not retire the actual close work.
    // Internal dispose/failed-open finalizers call Session.close directly.
    if (this.retainedCloseCalls >= 64) {
      throw new LiteSshError('RESOURCE_LIMIT', 'Too many terminal-close calls are awaiting completion.');
    }
    this.retainedCloseCalls++;
    try { return await session.close(); }
    finally {
      if (this.entries.get(target.codename)?.session === session) this.entries.delete(target.codename);
      this.retainedCloseCalls--;
    }
  }
  async dispose(closePool = true): Promise<void> {
    this.stopping = true;
    const cleanup = new CleanupFailures();
    const openings = await Promise.allSettled([...this.opening]);
    for (const opening of openings) {
      if (opening.status !== 'rejected' || !(opening.reason instanceof LiteSshError)) continue;
      const details = opening.reason.details;
      // An ordinary failed open is already reported to its caller. Only its
      // actual cleanup/loss facts make it a shutdown failure as well.
      if (details.cacheRemoved === false || details.cacheCleanupUnknown === true ||
          details.remoteChannelCleanupConfirmed === false ||
          details.connectionCleanupConfirmed === false || details.cacheMayBeIncomplete === true) {
        cleanup.add('terminal', opening.reason, 'TERMINAL_CLEANUP_FAILED', terminalShutdownFacts(details));
      }
    }
    const owners = [...this.entries.values()].filter(entry => entry.session !== undefined);
    const results = await Promise.allSettled(owners.map(async entry => entry.session!.close()));
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      const owner = owners[index]!;
      if (result.status === 'rejected') {
        const details = result.reason instanceof LiteSshError ? result.reason.details : {};
        cleanup.add('terminal', result.reason, 'TERMINAL_CLEANUP_FAILED', terminalShutdownFacts(details, owner.identity));
      } else if (result.value.ok !== true) {
        const code = typeof result.value.code === 'string' ? result.value.code : 'TERMINAL_CLEANUP_FAILED';
        cleanup.add('terminal', new LiteSshError(code, 'An owned terminal reported incomplete cleanup or recording loss.'),
          'TERMINAL_CLEANUP_FAILED', terminalShutdownFacts(result.value, owner.identity));
      }
    }
    this.entries.clear();
    if (closePool) {
      await cleanup.attempt('connection', () => this.pool.dispose(), 'CONNECTION_CLEANUP_FAILED');
    }
    cleanup.throwIfAny();
  }
}
