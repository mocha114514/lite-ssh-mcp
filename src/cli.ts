#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from './app.js';
import { ensureConfigurationFiles } from './config/bootstrap.js';
import { LiteSshError } from './core/errors.js';
import { VERSION } from './mcp/server.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`lite-ssh-mcp ${VERSION}\n`);
} else if (process.argv.includes('--help')) {
  process.stdout.write('lite-ssh-mcp [--help | --version]\nM0 stdio MCP terminal-core prototype. Default configuration: ~/.lite-ssh/config.json\nNormal stdio startup creates missing config.json and config.example.json; existing files are never overwritten.\nConfiguration/login tools read the current configuration; login uses the selected account credentials.\n');
} else if (process.argv.length > 2) {
  process.stderr.write('Unknown argument. Use --help.\n');
  process.exitCode = 2;
} else {
  const app = createApplication();
  let stopping = false;
  const stop = (): void => {
    stopping = true; // Latch synchronously even while first-run filesystem work is pending.
    void app.close().catch(() => { process.stderr.write('Shutdown cleanup failed.\n'); process.exitCode = 1; });
  };
  process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  app.server.server.onclose = stop;
  try {
    await ensureConfigurationFiles(app.store.filePath);
    // close() before connection has no transport to close; never attach a new
    // transport to an application whose idempotent shutdown already began.
    if (!stopping) await app.server.connect(new StdioServerTransport());
  } catch (error) {
    const message = error instanceof LiteSshError && error.code === 'CONFIG_INIT_FAILED'
      ? `${error.code}: ${error.message}`
      : 'MCP stdio startup failed.';
    process.stderr.write(`${message}\n`);
    await app.close();
    process.exitCode = 1;
  }
}
