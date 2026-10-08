import { normalizeIp, validateTerminalTarget } from '../core/targets.js';
import { LiteSshError } from '../core/errors.js';
import type { InputAction, LoginTarget, PageOptions, TerminalIdentity, TerminalTarget } from '../core/types.js';
import { ConnectionPool } from '../ssh/pool.js';
import { TerminalSession, type SessionOptions } from './session.js';

interface Entry { identity: TerminalIdentity; session?: TerminalSession }
export interface TerminalServiceOptions extends SessionOptions { maxTerminals?: number }

/** Global active-name registry for one MCP instance; physical SSH sessions stay internal. */
export class TerminalService {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Set<Promise<unknown>>();
  private stopping = false;
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
      } catch (error) { await lease.release(); throw error; }
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
    validateTerminalTarget(target);
    const entry = this.entries.get(target.codename);
    if (!entry || entry.identity.ip !== normalizeIp(target.ip) || entry.identity.port !== target.port) {
      throw new LiteSshError('TERMINAL_NOT_FOUND', 'No active terminal matches ip, port and codename in this MCP instance.');
    }
    if (!entry.session) throw new LiteSshError('TERMINAL_OPENING', 'This name is reserved while shell initialization is in progress.');
    return entry.session;
  }
  read(target: TerminalTarget): Promise<Record<string, unknown>> { return this.bind(target).read(); }
  write(target: TerminalTarget, actions: InputAction[]): Promise<Record<string, unknown>> { return this.bind(target).write(actions); }
  resize(target: TerminalTarget, cols: number, rows: number): Promise<Record<string, unknown>> { return this.bind(target).resize(cols, rows); }
  async close(target: TerminalTarget): Promise<Record<string, unknown>> {
    const session = this.bind(target);
    try { return await session.close(); }
    finally {
      if (this.entries.get(target.codename)?.session === session) this.entries.delete(target.codename);
    }
  }
  async dispose(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.opening]);
    await Promise.allSettled([...this.entries.values()].map(entry => entry.session?.close()));
    this.entries.clear();
    await this.pool.dispose();
  }
}
