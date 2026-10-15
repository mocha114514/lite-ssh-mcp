#!/usr/bin/env node
import { BoundedStdioTransport } from './mcp/stdio.js';
import { createApplication } from './app.js';
import { ensureConfigurationFiles } from './config/bootstrap.js';
import { LiteSshError } from './core/errors.js';
import { VERSION } from './mcp/server.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`lite-ssh-mcp ${VERSION}\n`);
} else if (process.argv.includes('--help')) {
  process.stdout.write([
    'lite-ssh-mcp [--help | --version]',
    'stdio MCP server with 13 tools for named SSH terminals and independent SFTP transfers.',
    'Default configuration: ~/.lite-ssh/config.json',
    'Normal startup creates missing config.json and config.example.json; existing files are never overwritten.',
    'New resources validate current configuration and selected credentials; existing resources retain their connection snapshot.',
    'Configuration is bounded to 4 MiB; private keys to 1 MiB. Existing permissions are verified, never automatically repaired.',
    ''
  ].join('\n'));
} else if (process.argv.length > 2) {
  process.stderr.write('Unknown argument. Use --help.\n');
  process.exitCode = 2;
} else {
  const app = createApplication();
  let transport: BoundedStdioTransport | undefined;
  let diagnosticWritten = false;
  const report = (message: string): void => {
    if (diagnosticWritten) return;
    diagnosticWritten = true;
    process.stderr.write(message);
  };
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true; // Latch synchronously even while first-run filesystem work is pending.
    // Start the absolute IO deadline now, not after domain owners finish. The
    // application still attempts every existing finalizer without a forced exit.
    transport?.beginClose();
    void app.close().catch(() => { report('Shutdown cleanup failed.\n'); process.exitCode = 1; });
  };
  process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  app.server.server.onclose = stop;
  try {
    await ensureConfigurationFiles(app.store.filePath);
    // close() before connection has no transport to close; never attach a new
    // transport to an application whose idempotent shutdown already began.
    if (!stopping) {
      transport = new BoundedStdioTransport({ onFatal: () => {
        report('MCP stdio transport failed.\n');
        process.exitCode = 1;
        stop();
      } });
      await app.server.connect(transport);
    }
  } catch (error) {
    const message = error instanceof LiteSshError && error.code === 'CONFIG_INIT_FAILED'
      ? `${error.code}: ${error.message}`
      : 'MCP stdio startup failed.';
    if (!stopping) report(`${message}\n`);
    transport?.beginClose();
    await app.close().catch(() => { process.exitCode = 1; });
    if (!stopping) process.exitCode = 1;
  }
}
