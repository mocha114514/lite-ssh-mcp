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

  return {
    store,
    pool,
    terminals,
    transfers,
    server,
    close: (): Promise<void> => {
      // Close admission synchronously for both MCP dispatch and Store operations,
      // ensuring immediate SERVER_STOPPING rejection before any async teardown begins.
      stopping = true;
      if (closing !== undefined) return closing;

      let storeTeardown: Promise<void>;
      try {
        storeTeardown = store.close();
      } catch (error: unknown) {
        storeTeardown = Promise.reject(error);
      }
      void storeTeardown.catch(() => undefined);

      closing = (async () => {
        const cleanup = new CleanupFailures();

        // Terminal and transfer teardown start immediately without waiting for Store.
        // Independent errors are captured fully by the aggregate.
        await Promise.all([
          cleanup.attempt('terminal', () => terminals.dispose(false), 'TERMINAL_CLEANUP_FAILED'),
          cleanup.attempt('transfer', () => transfers.dispose(), 'TRANSFER_CLEANUP_FAILED')
        ]);

        // Connection pool disposal preserves completion of terminals and transfers.
        await cleanup.attempt('connection', () => pool.dispose(), 'CONNECTION_CLEANUP_FAILED');

        // Store business and lock cleanup must finish before server/MCP transport detachment.
        await cleanup.attempt('configuration', () => storeTeardown, 'CONFIG_CLEANUP_FAILED');

        // Server detachment is always attempted, even after preceding cleanup errors.
        await cleanup.attempt('mcp', () => server.close(), 'MCP_CLOSE_FAILED');

        cleanup.throwIfAny();
      })();

      return closing;
    }
  };
}
