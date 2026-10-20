import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isIP } from 'node:net';
import { ConfigStore } from '../config/store.js';
import { LiteSshError, publicError } from '../core/errors.js';
import { normalizeIp } from '../core/targets.js';
import { ConnectionPool } from '../ssh/pool.js';
import { TerminalService } from '../terminal/service.js';
import { TransferManager } from '../sftp/manager.js';
import type { InputAction } from '../core/types.js';

export const VERSION = '0.1.0';
const ip = z.string().refine(value => isIP(value) !== 0, 'Use a literal IPv4/IPv6 address.').describe('Configured service IP address.');
const port = z.number().int().min(1).max(65535).describe('Configured SSH port.');
const username = z.string().min(1).max(256).refine(value => !value.includes('\0')).describe('Actual configured SSH username, not a terminal nickname.');
const codename = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/).describe('Independent snake_case terminal name chosen by the AI.');
const target = { ip, port, codename };
const page = { ip: ip.optional(), port: port.optional(), username: username.optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) };
const outputSchema = z.looseObject({ ok: z.boolean(), state: z.string() });
const action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().max(65_536).describe('Literal printable typing. Vim i/:w/:q belong here.') }),
  z.strictObject({ type: z.literal('paste'), text: z.string().max(65_536).describe('Body paste; requires current bracketed-paste mode. No silent fallback.') }),
  z.strictObject({ type: z.literal('key'), key: z.string().min(1).max(32).describe('Named key such as ENTER, ESC, CTRL_C, UP. Encoding follows current terminal modes.') })
]);

function readable(result: Record<string, unknown>): string {
  if (result.ok === false) return `${String(result.code ?? 'ERROR')}: ${String(result.message ?? 'Operation failed.')}\n${JSON.stringify(result)}`;
  if (typeof result.output === 'string') return `${result.output}\n[${String(result.state)}; exitCode=${String(result.exitCode)}; ${String(result.round)}; cache=${String(result.cachePath)}]`;
  const screen = result.screen as { lines?: string[]; cursor?: { x: number; y: number } } | undefined;
  if (screen?.lines) return `${String(result.state)}; cache=${String(result.cachePath)}; cursor=${JSON.stringify(screen.cursor)}\n${screen.lines.join('\n')}`;
  return JSON.stringify(result);
}
async function respond(operation: () => Promise<Record<string, unknown>> | Record<string, unknown>, isStopping: () => boolean) {
  let result: Record<string, unknown>;
  try {
    if (isStopping()) throw new LiteSshError('SERVER_STOPPING', 'The MCP instance is shutting down.');
    result = await operation();
  } catch (error) { result = publicError(error); }
  return { content: [{ type: 'text' as const, text: readable(result) }], structuredContent: result, ...(result.ok === false ? { isError: true } : {}) };
}

/** All thirteen V2 tools share the application's concrete resource owners. */
export function createMcpServer(store: ConfigStore, pool: ConnectionPool, terminals: TerminalService, transfers: TransferManager, isStopping: () => boolean = () => false): McpServer {
  // All tool handlers share one admission point; teardown operations use
  // their concrete owners directly and are not routed through this gate.
  const dispatch = (operation: () => Promise<Record<string, unknown>> | Record<string, unknown>) => respond(operation, isStopping);
  const server = new McpServer({ name: 'lite-ssh-mcp-server', version: VERSION }, { capabilities: { logging: {} } });
  server.registerTool('lite_ssh_list_configurations', {
    title: 'List configured logins', description: 'List configured ip/port/username combinations. Credentials and private-key paths are never returned.',
    inputSchema: z.strictObject(page), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, args => dispatch(async () => {
    let entries = await store.listConfigurations();
    if (args.ip !== undefined) entries = entries.filter(item => normalizeIp(item.ip) === normalizeIp(args.ip!));
    if (args.port !== undefined) entries = entries.filter(item => item.port === args.port);
    if (args.username !== undefined) entries = entries.filter(item => item.username === args.username);
    return { ok: true, state: 'listed', configurations: entries.slice(args.offset, args.offset + args.limit), total: entries.length, offset: args.offset, limit: args.limit, hasMore: args.offset + args.limit < entries.length };
  }));
  server.registerTool('lite_ssh_confirm_host_key', {
    title: 'Confirm observed host key', description: 'After showing the observed SHA256 fingerprint to the user and obtaining confirmation, record that exact previously observed fingerprint. Retry the original operation afterward.',
    inputSchema: z.strictObject({ ip, port, fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }), outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, args => dispatch(async () => ({ ok: true, state: 'host_key_confirmed', ...await pool.confirmHostKey({ ip: args.ip, port: args.port }, args.fingerprint), nextAction: 'Retry the original terminal_open/upload/download operation; the key is verified again.' })));
  server.registerTool('lite_ssh_terminal_open', {
    title: 'Open named terminal', description: 'Create an independent named SSH PTY and temporary shell integration. Uses configured credentials; unknown/changed host keys stop before user authentication.',
    inputSchema: z.strictObject({ ip, port, username, codename }), outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, args => dispatch(() => terminals.open({ ip: args.ip, port: args.port, username: args.username }, args.codename)));
  server.registerTool('lite_ssh_terminal_list', {
    title: 'List active terminals', description: 'Find this MCP instance\'s active and opening terminal names, actual accounts, states and readable cache paths.',
    inputSchema: z.strictObject(page), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, args => dispatch(() => terminals.list(args)));
  server.registerTool('lite_ssh_terminal_write', {
    title: 'Write terminal actions', description: 'Type text, bracketed paste or named keys. Ordinary completion requires a trusted shell END event. Screen changes or input transmission do not prove every key was handled; deadlines never trigger replay.',
    inputSchema: z.strictObject({ ...target, actions: z.array(action).min(1).max(64) }), outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, (args, extra) => dispatch(() => terminals.write(args, args.actions as InputAction[], extra.signal)));
  server.registerTool('lite_ssh_terminal_read', {
    title: 'Read current terminal screen', description: 'Read only the current parsed character screen, cursor, styles and round state. No history/view/delta parameter; use local file tools on cachePath for history.',
    inputSchema: z.strictObject(target), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, args => dispatch(() => terminals.read(args)));
  server.registerTool('lite_ssh_terminal_resize', {
    title: 'Resize terminal', description: 'Change remote PTY and current local screen dimensions. M0 budget: 2-240 columns and 2-100 rows.',
    inputSchema: z.strictObject({ ...target, cols: z.number().int().min(2).max(240), rows: z.number().int().min(2).max(100) }), outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, args => dispatch(() => terminals.resize(args, args.cols, args.rows)));
  server.registerTool('lite_ssh_terminal_close', {
    title: 'Close terminal', description: 'Close this concrete terminal instance, drain parsed output/cache writes and remove only its own cache. Other terminals are unaffected; remote background-process termination is not promised.',
    inputSchema: z.strictObject(target), outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, args => dispatch(() => terminals.close(args)));
  const transferInput = z.strictObject({
    ip, port, username,
    localPath: z.string().min(1).max(32_768).refine(value => !value.includes('\0')).describe('Absolute local path (or ~/); this is the final object, not a containing folder.'),
    remotePath: z.string().min(1).max(32_768).refine(value => value.startsWith('/') && !value.includes('\0')).describe('Absolute Linux POSIX path of the final object.'),
    conflictPolicy: z.enum(['overwrite_merge_off', 'overwrite_merge_on']).default('overwrite_merge_off').describe('Explicit permission to replace same-name files or merge directories. Never implies link following.'),
    symlinkPolicy: z.enum(['symlink_follow_off', 'symlink_follow_on']).default('symlink_follow_off').describe('Follow source/target/parent/recursive links to content, retaining logical names and target link nodes. Never implies overwrite permission.')
  });
  for (const direction of ['upload', 'download'] as const) {
    server.registerTool(`lite_ssh_${direction}`, {
      title: `Submit independent ${direction}`,
      description: 'Authenticate and acquire an independent SFTP channel, then return transferId promptly. Accepted is not completed. Complete bounded preflight precedes target writes; blocked plans perform zero target writes. Query/cancel with transfer tools; terminal_close does not cancel transfers.',
      inputSchema: transferInput, outputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, args => dispatch(() => transfers.accept(direction, args)));
  }
  server.registerTool('lite_ssh_transfer_list', {
    title: 'List transfers and retained results',
    description: 'Recover this instance\'s transferIds, accounts, paths, phases and progress. Active tasks do not expire; terminal records are retained until recordExpiresAt. Restarted registries are not restored.',
    inputSchema: z.strictObject(page), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, args => dispatch(() => transfers.list(args)));
  const transferId = z.string().regex(/^tr_[0-9a-f-]{36}$/).describe('Concrete transferId from this MCP instance, not a terminal codename.');
  server.registerTool('lite_ssh_transfer_status', {
    title: 'Read transfer state and paginated results',
    description: 'Query actual progress, planning completeness, conflict/link mappings, committed files, failures and cleanup. Page all results with offset/limit; unknown totals remain null. Already committed content is not rolled back.',
    inputSchema: z.strictObject({ transferId, offset: page.offset, limit: page.limit }), outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, args => dispatch(() => transfers.status(args.transferId, args)));
  server.registerTool('lite_ssh_transfer_cancel', {
    title: 'Request transfer cancellation',
    description: 'Request stopping, not instant success. Poll status for actual stopped/cleanup results. Preserves committed content, removes only identifiable owned temporaries, and never changes a completed task to cancelled.',
    inputSchema: z.strictObject({ transferId }), outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, args => dispatch(() => transfers.cancel(args.transferId)));
  return server;
}
