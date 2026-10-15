import { CleanupFailures } from './core/cleanup.js';
import { ConfigStore } from './config/store.js';
import { ConnectionPool } from './ssh/pool.js';
import { TerminalService, type TerminalServiceOptions } from './terminal/service.js';
import { createMcpServer } from './mcp/server.js';
import { TransferManager } from './sftp/manager.js';

/** Constructor injection keeps local tests away from actual home configuration and keys. */
export function createApplication(options: TerminalServiceOptions & { configPath?: string } = {}) {
  const store = new ConfigStore(options.configPath);
  const pool = new ConnectionPool(store);
  const terminals = new TerminalService(pool, options);
  const transfers = new TransferManager(pool);
  let stopping = false;
  const server = createMcpServer(store, pool, terminals, transfers, () => stopping);
  let closing: Promise<void> | undefined;
  return { store, pool, terminals, transfers, server, close: (): Promise<void> => {
    // Close admission synchronously, including config/trust tools, before any
    // asynchronous owned-terminal cleanup can yield back to the dispatcher.
    stopping = true;
    closing ??= (async () => {
      // Terminals and transfers release independent leases before the shared
      // connection pool is ended. Terminal close never owns transfer teardown.
      const cleanup = new CleanupFailures();
      await Promise.all([
        cleanup.attempt('terminal', () => terminals.dispose(false), 'TERMINAL_CLEANUP_FAILED'),
        cleanup.attempt('transfer', () => transfers.dispose(), 'TRANSFER_CLEANUP_FAILED')
      ]);
      // Every remaining finalizer is attempted, even after an earlier error.
      // Ending the pool also resolves pending physical-close ownership tickets;
      // detaching stdio must never be skipped or replace the earlier failure.
      await cleanup.attempt('connection', () => pool.dispose(), 'CONNECTION_CLEANUP_FAILED');
      await cleanup.attempt('mcp', () => server.close(), 'MCP_CLOSE_FAILED');
      cleanup.throwIfAny();
    })();
    return closing;
  } };
}
