import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApplication } from '../src/app.js';
import { LiteSshError } from '../src/core/errors.js';
import { startMockSsh } from './helpers/mock-ssh.js';
import { TerminalSession } from '../src/terminal/session.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import type { InputAction } from '../src/core/types.js';

async function fixture(pinned = false, options: { lateSecondShellMs?: number; initializationTimeoutMs?: number } = {}) {
  const ssh = await startMockSsh(options);
  const root = resolve('vb-test/m0/integration', `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(root, { recursive: true });
  const configPath = join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ version: 2, servers: { [ssh.ip]: { [ssh.port]: {
    label: 'local generated fixture', ...(pinned ? { hostKeyFingerprint: ssh.fingerprint } : {}),
    accounts: { [ssh.username]: { auth: { type: 'password', password: ssh.password } } }
  } } } }), 'utf8');
  const app = createApplication({ configPath, cacheRoot: join(root, 'cache'), writeWaitMs: 180, initializationTimeoutMs: options.initializationTimeoutMs ?? 2000 });
  return { ssh, app, root, target: { ip: ssh.ip, port: ssh.port, username: ssh.username }, terminal: (codename: string) => ({ ip: ssh.ip, port: ssh.port, codename }) };
}
const command = (text: string): InputAction[] => [{ type: 'text', text }, { type: 'key', key: 'ENTER' }];

/** Tests may wait/read after a pending observation; never send the original input twice. */
async function completed(app: ReturnType<typeof createApplication>, target: { ip: string; port: number; codename: string }, reply: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (reply.state === 'command_completed') return reply;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await app.terminals.read(target);
    if (current.currentRound === null && current.lastCompletedRound) {
      return { ...current, ...(current.lastCompletedRound as Record<string, unknown>), state: 'command_completed' };
    }
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  assert.fail('No faithful shell END result arrived before the local test deadline.');
}

test('SSH -> PTY -> shell markers -> readable cache -> completion, with independent terminals', { timeout: 30_000 }, async () => {
  const { ssh, app, target, terminal } = await fixture();
  try {
    await assert.rejects(app.terminals.open(target, 'alpha_one'), error => error instanceof LiteSshError && error.code === 'HOST_KEY_UNTRUSTED');
    assert.equal(ssh.authAttempts, 0);
    assert.equal((app.terminals.list().terminals as unknown[]).length, 0);
    await app.pool.confirmHostKey(target, ssh.fingerprint);
    const opened = await app.terminals.open(target, 'alpha_one');
    assert.equal(opened.shellIntegration, 'ready');
    await app.terminals.open(target, 'beta_two');
    assert.equal(ssh.authenticatedConnections, 1);
    await assert.rejects(app.terminals.open(target, 'alpha_one'), error => error instanceof LiteSshError && error.code === 'CODENAME_IN_USE');

    const short = await app.terminals.write(terminal('alpha_one'), command('emit small'));
    assert.equal(short.state, 'command_completed');
    assert.equal(short.exitCode, 0);
    assert.ok(typeof short.output === 'string' && short.output.includes('short readable output'));
    const rejected = await app.terminals.write(terminal('alpha_one'), command('syntax error'));
    assert.equal(rejected.state, 'shell_input_finished');
    assert.equal(rejected.commandStarted, false);
    assert.equal(rejected.exitCode, 2);
    assert.ok(String(rejected.output).includes('syntax error'));
    const unbroken = await completed(app, terminal('alpha_one'), await app.terminals.write(terminal('alpha_one'), command('emit unbroken')));
    assert.equal(unbroken.outputCharacters, 1201);
    assert.equal(unbroken.outputOmitted, true);
    const transient = await completed(app, terminal('alpha_one'), await app.terminals.write(terminal('alpha_one'), command('transient tui')));
    assert.ok((await fs.readFile(String(transient.cachePath), 'utf8')).includes('transient_view_text'));
    const long = await completed(app, terminal('alpha_one'), await app.terminals.write(terminal('alpha_one'), command('emit large')));
    assert.equal(long.state, 'command_completed');
    assert.equal(long.output, null);
    assert.equal(long.outputOmitted, true);
    assert.ok(Number(long.outputCharacters) > 1000);
    const many = await completed(app, terminal('alpha_one'), await app.terminals.write(terminal('alpha_one'), command('emit many')));
    assert.equal(many.state, 'command_completed');
    const full = await fs.readFile(String(many.cachePath), 'utf8');
    assert.ok(full.includes('line_0') && full.includes('line_2499'));
    assert.equal(full.includes('\x1b'), false, 'readable cache must contain no raw ESC bytes');
    assert.ok(full.includes('ROUND R1 BEGIN'));

    const hidden = await app.terminals.write(terminal('alpha_one'), command('ask hidden'));
    assert.equal(hidden.state, 'pending');
    const hiddenResponse = await completed(app, terminal('alpha_one'), await app.terminals.write(terminal('alpha_one'), command('hidden_fixture_value')));
    assert.equal(hiddenResponse.state, 'command_completed');
    const afterHidden = await fs.readFile(String(hiddenResponse.cachePath), 'utf8');
    assert.equal(afterHidden.includes('hidden_fixture_value'), false, 'hidden input values must not be mirrored');

    const query = await app.terminals.write(terminal('alpha_one'), command('query cursor'));
    assert.equal(query.state, 'command_completed');
    assert.equal(ssh.queryReplies, 1);
    await app.terminals.resize(terminal('alpha_one'), 96, 30);
    const screen = (await app.terminals.read(terminal('alpha_one'))).screen as { cols: number; rows: number };
    assert.deepEqual([screen.cols, screen.rows], [96, 30]);
    const path = String(opened.cachePath);
    const closed = await app.terminals.close(terminal('alpha_one'));
    assert.equal(closed.cacheRemoved, true);
    await assert.rejects(fs.access(path));
    assert.equal((await app.terminals.read(terminal('beta_two'))).state, 'open');
    await app.terminals.open(target, 'alpha_one'); // A new concrete instance, independent file.
    await app.terminals.close(terminal('alpha_one'));
    await app.terminals.close(terminal('beta_two'));
  } finally { await app.close(); await ssh.close(); }
});

test('alternate screen and call deadlines never fabricate ordinary completion or replay', { timeout: 15_000 }, async () => {
  const { ssh, app, target, terminal } = await fixture(true);
  try {
    await app.terminals.open(target, 'editor_main');
    const tui = await app.terminals.write(terminal('editor_main'), command('enter tui'));
    assert.equal(tui.state, 'screen_updated');
    const snap = tui.screen as { buffer: string; modes: { bracketedPaste: boolean } };
    assert.equal(snap.buffer, 'alternate');
    assert.equal(snap.modes.bracketedPaste, true);
    const exit = await completed(app, terminal('editor_main'), await app.terminals.write(terminal('editor_main'), command(':q')));
    assert.equal(exit.state, 'command_completed');
    const pending = await app.terminals.write(terminal('editor_main'), command('hang'));
    assert.equal(pending.state, 'pending');
    assert.equal(pending.inputHandled, 'unknown');
    const interrupted = await completed(app, terminal('editor_main'), await app.terminals.write(terminal('editor_main'), [{ type: 'key', key: 'CTRL_C' }]));
    assert.equal(interrupted.exitCode, 130);
  } finally { await app.close(); await ssh.close(); }
});

test('RETURN and a numeric KP_ENTER submit shell lines exactly like ENTER', { timeout: 20_000 }, async () => {
  const { ssh, app, target, terminal } = await fixture(true);
  try {
    await app.terminals.open(target, 'alias_main');
    const viaReturn = await app.terminals.write(terminal('alias_main'), [{ type: 'text', text: 'emit small' }, { type: 'key', key: 'RETURN' }]);
    assert.equal(viaReturn.state, 'command_completed');
    assert.equal(viaReturn.exitCode, 0);
    // The remote never enables application keypad mode here, so KP_ENTER is a real CR.
    const viaKeypad = await app.terminals.write(terminal('alias_main'), [{ type: 'text', text: 'emit small' }, { type: 'key', key: 'KP_ENTER' }]);
    assert.equal(viaKeypad.state, 'command_completed');
    assert.equal(viaKeypad.exitCode, 0);
    const parseError = await app.terminals.write(terminal('alias_main'), [{ type: 'text', text: 'syntax error' }, { type: 'key', key: 'RETURN' }]);
    assert.equal(parseError.state, 'shell_input_finished');
    assert.equal(parseError.exitCode, 2);
  } finally { await app.close(); await ssh.close(); }
});

test('one batch with two submitted lines closes two shell cycles in order', { timeout: 20_000 }, async () => {
  const { ssh, app, target, terminal } = await fixture(true);
  try {
    await app.terminals.open(target, 'batch_main');
    const batch = await app.terminals.write(terminal('batch_main'), [
      { type: 'text', text: 'emit small' },
      { type: 'key', key: 'ENTER' },
      { type: 'text', text: 'syntax error' },
      { type: 'key', key: 'ENTER' },
    ]);
    // The reply must describe the last cycle the batch created, not the first.
    assert.equal(batch.state, 'shell_input_finished');
    assert.equal(batch.exitCode, 2);
    assert.equal(batch.commandStarted, false);
    assert.ok(String(batch.output).includes('syntax error'));
    const full = await fs.readFile(String(batch.cachePath), 'utf8');
    assert.ok(full.includes('ROUND R1 BEGIN') && full.includes('ROUND R2 BEGIN'), 'each submitted line owns a round');
    assert.ok(full.includes('[ROUND R1 END] exitCode=0'), 'the executed line keeps its real status');
    assert.ok(full.includes('[ROUND R2 END] exitCode=2'), 'the parser-error line keeps its own status');
    assert.ok(full.includes('[SHELL COMMAND BEGIN]'), 'the executed round is visibly separated from the error round');
  } finally { await app.close(); await ssh.close(); }
});

test('a running editor consumes Enter and :w without fabricating shell rounds', { timeout: 20_000 }, async () => {
  const { ssh, app, target, terminal } = await fixture(true);
  try {
    await app.terminals.open(target, 'editor_rounds');
    const tui = await app.terminals.write(terminal('editor_rounds'), command('enter tui'));
    assert.equal(tui.state, 'screen_updated');
    // Enter and `:w` are consumed by the foreground program, never by the shell.
    await app.terminals.write(terminal('editor_rounds'), [{ type: 'key', key: 'ENTER' }]);
    await app.terminals.write(terminal('editor_rounds'), [{ type: 'text', text: ':w' }, { type: 'key', key: 'ENTER' }]);
    const exit = await completed(app, terminal('editor_rounds'), await app.terminals.write(terminal('editor_rounds'), [{ type: 'text', text: ':q' }, { type: 'key', key: 'ENTER' }]));
    assert.equal(exit.state, 'command_completed');
    assert.equal(exit.round, 'R1');
    assert.equal(exit.commandStarted, true);
    const current = await app.terminals.read(terminal('editor_rounds'));
    assert.equal(current.currentRound, null, 'the editor exit must not leave a phantom running round');
    const full = await fs.readFile(String(exit.cachePath), 'utf8');
    assert.equal((full.match(/\[ROUND R\d+ BEGIN\]/g) ?? []).length, 2, 'only the editor round plus the next private candidate');
    assert.equal((full.match(/\[ROUND R\d+ END\]/g) ?? []).length, 1, 'only the editor round has really ended');
  } finally { await app.close(); await ssh.close(); }
});

test('MCP registers only actual M0 tools; schemas reject removed view/username targeting', { timeout: 15_000 }, async () => {
  const { ssh, app, target } = await fixture(true);
  const client = new Client({ name: 'm0-local-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await app.server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.equal(tools.tools.some(tool => /upload|download|transfer|_run$|_connect$/.test(tool.name)), false);
    const configurations = await client.callTool({ name: 'lite_ssh_list_configurations', arguments: {} });
    assert.equal(JSON.stringify(configurations.structuredContent).includes(ssh.password), false);
    const opened = await client.callTool({ name: 'lite_ssh_terminal_open', arguments: { ...target, codename: 'mcp_main' } });
    assert.equal(opened.isError, undefined);
    const invalid = await client.callTool({ name: 'lite_ssh_terminal_read', arguments: { ip: target.ip, port: target.port, codename: 'mcp_main', view: 'history' } });
    assert.equal(invalid.isError, true);
    const result = await client.callTool({ name: 'lite_ssh_terminal_write', arguments: { ip: target.ip, port: target.port, codename: 'mcp_main', actions: command('emit small') } });
    assert.equal((result.structuredContent as Record<string, unknown>).state, 'command_completed');
    await client.callTool({ name: 'lite_ssh_terminal_close', arguments: { ip: target.ip, port: target.port, codename: 'mcp_main' } });
  } finally { await client.close(); await app.close(); await ssh.close(); }
});


test('R01 initial public-read failure closes the already-open PTY and cache', { timeout: 15_000 }, async t => {
  const { ssh, app, root, target } = await fixture(true);
  let openedSession: TerminalSession | undefined;
  const failure = new LiteSshError('CACHE_WRITE_FAILED', 'fixture first public-read failure');
  t.mock.method(TerminalSession.prototype, 'read', async function (this: TerminalSession) {
    openedSession = this;
    throw failure;
  });
  try {
    await assert.rejects(app.terminals.open(target, 'r01_first_read'), error => error instanceof LiteSshError && error.code === failure.code && error.message === failure.message);
    assert.deepEqual(await fs.readdir(join(root, 'cache')), [], 'the opened session, not merely its connection lease, must be closed');
    assert.equal((app.terminals.list().terminals as unknown[]).length, 0);
  } finally {
    t.mock.restoreAll();
    await openedSession?.close().catch(() => undefined); // Baseline orphan rescue.
    await app.close(); await ssh.close();
  }
});

test('R01 shutdown gates writes and resizes before awaiting an opening terminal', { timeout: 15_000 }, async t => {
  const { ssh, app, target, terminal } = await fixture(true, { lateSecondShellMs: 250 });
  let opening: Promise<Record<string, unknown>> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await app.terminals.open(target, 'r01_stopping_kept');
    const writeSpy = t.mock.method(TerminalSession.prototype, 'write');
    const resizeSpy = t.mock.method(TerminalSession.prototype, 'resize');
    opening = app.terminals.open(target, 'r01_stopping_opening');
    void opening.catch(() => undefined);
    stopping = app.terminals.dispose();
    await assert.rejects(async () => app.terminals.write(terminal('r01_stopping_kept'), command('emit small')), error => error instanceof LiteSshError && error.code === 'SERVER_STOPPING');
    await assert.rejects(async () => app.terminals.resize(terminal('r01_stopping_kept'), 40, 10), error => error instanceof LiteSshError && error.code === 'SERVER_STOPPING');
    assert.equal(writeSpy.mock.callCount(), 0);
    assert.equal(resizeSpy.mock.callCount(), 0);
  } finally {
    await opening?.catch(() => undefined);
    await stopping?.catch(() => undefined);
    t.mock.restoreAll(); await app.close(); await ssh.close();
  }
});


test('R01 a failed first-read cleanup reports its retained owned cache and original error', { timeout: 15_000 }, async t => {
  const { ssh, app, root, target } = await fixture(true);
  let opened: TerminalSession | undefined;
  let retained: string | undefined;
  const original = new LiteSshError('CACHE_WRITE_FAILED', 'fixture original public-read error');
  const sibling = join(root, 'cache', 'retained-sibling.txt');
  t.mock.method(TerminalSession.prototype, 'read', async function (this: TerminalSession) {
    opened = this; retained = this.recorder.path;
    await fs.writeFile(sibling, 'retain sibling\n', { flag: 'wx' });
    throw original;
  });
  const originalClose = ReadableRecorder.prototype.close;
  t.mock.method(ReadableRecorder.prototype, 'close', async function (this: ReadableRecorder) {
    // Controlled delete-denied outcome: real handle closure, unchanged owned
    // file, no chmod/ACL/disk sabotage and no access to any user-owned path.
    const outcome = await originalClose.call(this, { remove: false });
    return { ...outcome, cacheRemoved: false, cleanupError: 'CACHE_DELETE_FAILED EACCES' };
  });
  try {
    let caught: unknown;
    try { await app.terminals.open(target, 'r01_retained_read'); } catch (error) { caught = error; }
    assert.ok(caught instanceof LiteSshError);
    assert.equal(caught.code, original.code);
    assert.equal(caught.message, original.message);
    assert.equal(caught.details.cacheRemoved, false);
    assert.equal(caught.details.cleanupError, 'CACHE_DELETE_FAILED EACCES');
    assert.equal(caught.details.cachePath, retained);
    assert.equal(opened?.status, 'closed', 'PTY and lease cleanup still complete');
    assert.ok(retained); await fs.stat(retained);
    assert.equal(await fs.readFile(sibling, 'utf8'), 'retain sibling\n');
  } finally {
    t.mock.restoreAll();
    await opened?.close().catch(() => undefined);
    await app.close(); await ssh.close();
    if (retained) await fs.unlink(retained); // Exact generated fixture, not a sweep.
  }
});


test('R01 application stop gates configuration and trust tools at the MCP entry', { timeout: 15_000 }, async t => {
  const { ssh, app, target } = await fixture(true, { lateSecondShellMs: 250 });
  const client = new Client({ name: 'r01-stop-entry-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let opening: Promise<Record<string, unknown>> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await app.server.connect(serverTransport); await client.connect(clientTransport);
    await app.terminals.open(target, 'r01_entry_kept');
    const listSpy = t.mock.method(app.store, 'listConfigurations');
    const trustSpy = t.mock.method(app.pool, 'confirmHostKey');
    opening = app.terminals.open(target, 'r01_entry_opening');
    void opening.catch(() => undefined);
    stopping = app.close();
    const configurations = await client.callTool({ name: 'lite_ssh_list_configurations', arguments: {} });
    const trust = await client.callTool({ name: 'lite_ssh_confirm_host_key', arguments: { ip: target.ip, port: target.port, fingerprint: ssh.fingerprint } });
    assert.equal((configurations.structuredContent as Record<string, unknown>).code, 'SERVER_STOPPING');
    assert.equal((trust.structuredContent as Record<string, unknown>).code, 'SERVER_STOPPING');
    assert.equal(listSpy.mock.callCount(), 0, 'no new private configuration query is dispatched after stop');
    assert.equal(trustSpy.mock.callCount(), 0, 'no new trust update is dispatched after stop');
  } finally {
    await opening?.catch(() => undefined); await stopping?.catch(() => undefined);
    t.mock.restoreAll(); await client.close(); await app.close(); await ssh.close();
  }
});
