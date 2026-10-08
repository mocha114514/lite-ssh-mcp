import { ConfigStore } from './config/store.js';
import { ConnectionPool } from './ssh/pool.js';
import { TerminalService, type TerminalServiceOptions } from './terminal/service.js';
import { createMcpServer } from './mcp/server.js';

/** Constructor injection keeps local tests away from actual home configuration and keys. */
export function createApplication(options: TerminalServiceOptions & { configPath?: string } = {}) {
  const store = new ConfigStore(options.configPath);
  const pool = new ConnectionPool(store);
  const terminals = new TerminalService(pool, options);
  const server = createMcpServer(store, pool, terminals);
  let closing: Promise<void> | undefined;
  return { store, pool, terminals, server, close: (): Promise<void> => {
    closing ??= (async () => { await terminals.dispose(); await server.close(); })();
    return closing;
  } };
}
