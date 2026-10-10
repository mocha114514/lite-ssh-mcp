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
      await Promise.allSettled([terminals.dispose(false), transfers.dispose()]);
      // Still detach the MCP transport if physical connection cleanup reports
      // uncertainty. Leaving stdio attached would otherwise block shutdown.
      try { await pool.dispose(); }
      finally { await server.close(); }
    })();
    return closing;
  } };
}
