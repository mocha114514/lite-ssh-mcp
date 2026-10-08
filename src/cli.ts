#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplication } from './app.js';
import { VERSION } from './mcp/server.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`lite-ssh-mcp ${VERSION}\n`);
} else if (process.argv.includes('--help')) {
  process.stdout.write('lite-ssh-mcp [--help | --version]\nM0 stdio MCP terminal-core prototype. Default configuration: ~/.lite-ssh/config.json\nNo user configuration is read until a configuration/login tool is called.\n');
} else if (process.argv.length > 2) {
  process.stderr.write('Unknown argument. Use --help.\n');
  process.exitCode = 2;
} else {
  const app = createApplication();
  const stop = (): void => { void app.close().catch(() => { process.stderr.write('Shutdown cleanup failed.\n'); process.exitCode = 1; }); };
  process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  app.server.server.onclose = stop;
  try { await app.server.connect(new StdioServerTransport()); }
  catch { process.stderr.write('MCP stdio startup failed.\n'); await app.close(); process.exitCode = 1; }
}
