import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { InputAction, RoundResult, ScreenSnapshot } from '../src/core/types.js';
import {
  createRealShellEnvironment,
  startRealShellSsh,
  type RealShell,
} from './helpers/real-shell-ssh.js';
import { fixtureRoot } from './helpers/workspace.js';

const enabled = process.env.LSSH_REAL_SHELLS === '1';
const cli = resolve('dist/cli.js');
type Reply = Record<string, unknown>;
type Completion = RoundResult & { state: 'command_completed' | 'shell_input_finished' };
const command = (text: string): InputAction[] => [
  { type: 'text', text },
  { type: 'key', key: 'ENTER' },
];
const lastRound = (reply: Reply): string | undefined =>
  (reply.lastCompletedRound as RoundResult | null | undefined)?.round;

/** A changed screen or inputHandled=unknown says nothing about completion.
 * Only a new trusted END-backed result can settle this sequential submission;
 * lastCompletedRound must never accidentally reuse the preceding command.
 */
function freshCompletion(reply: Reply, previous: string | undefined): Completion | undefined {
  const direct = reply.state === 'command_completed' || reply.state === 'shell_input_finished';
  const result = (direct ? reply : reply.currentRound === null ? reply.lastCompletedRound : null) as
    RoundResult | null | undefined;
  if (!result) return undefined;
  if (direct) assert.notEqual(result.round, previous, 'write returned a stale completion');
  if (result.round === previous) return undefined;
  assert.match(result.round, /^R\d+$/);
  assert.equal(typeof result.commandStarted, 'boolean');
  assert.notEqual(result.commandStartUnknown, true, 'compromised hooks are not trusted completion');
  assert.ok(Number.isInteger(result.exitCode));
  const state = result.commandStarted ? 'command_completed' : 'shell_input_finished';
  if (direct) assert.equal(reply.state, state);
  return { ...result, state };
}

// This suite is opt-in so ordinary local builds do not pretend Windows mocks
// exercised real Bash/Zsh/Fish. Enabling it on a non-Linux host is an error, as
// are missing binaries; there is deliberately no enabled-but-silently-skipped case.
// It covers ssh2 loopback, not a production OpenSSH daemon, user rc files or macOS.
for (const shell of ['bash', 'zsh', 'fish'] satisfies RealShell[]) {
  test(`real Linux PTY + ${shell} -> loopback SSH -> MCP CLI stdio`, {
    skip: enabled ? false : 'Set LSSH_REAL_SHELLS=1 on Linux to run real-shell regression.',
    timeout: 60_000,
  }, async t => {
    assert.equal(process.platform, 'linux', 'LSSH_REAL_SHELLS=1 requires Linux; macOS is deferred.');
    await fs.access(cli); // Use the real built production entrypoint, never create an alternate CLI.
    const root = fixtureRoot('real-shell', shell);
    const env = await createRealShellEnvironment(join(root, 'cli'));
    const ssh = await startRealShellSsh(shell, join(root, 'ssh'));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      cwd: root,
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: `real-${shell}-fixture`, version: '1' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192);
    });
    const target = { ip: ssh.ip, port: ssh.port, codename: `real_${shell}` };
    let phase = 'stdio_connect';
    let failed = false;
    const call = async (operation: string, args: Reply = {}): Promise<Reply> => {
      const context = `[${shell}/${phase}] terminal_${operation}`;
      // Keep progress small: repeated read polls and action/auth payloads are not logged.
      if (operation !== 'read') t.diagnostic(context);
      try {
        ssh.assertHealthy();
        const response = await client.callTool({
          name: `lite_ssh_terminal_${operation}`,
          arguments: { ...target, ...args },
        }, undefined, { timeout: 15_000 });
        ssh.assertHealthy();
        assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
        const reply = response.structuredContent as Reply;
        assert.ok(reply && reply.ok === true, JSON.stringify(response));
        return reply;
      } catch (cause) {
        throw new Error(`${context} failed`, { cause });
      }
    };
    const finish = async (initial: Reply, previous: string | undefined): Promise<Completion> => {
      let reply = initial;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const completion = freshCompletion(reply, previous);
        if (completion) return completion;
        await delay(40);
        // Poll observations only. In particular, never replay the original input
        // on pending/screen_updated/unknown or reinterpret those states as success.
        reply = await call('read');
        assert.equal(reply.state, 'open');
      }
      assert.fail(`No fresh trusted shell END within the deadline: ${JSON.stringify(reply)}`);
    };
    const execute = async (text: string, clearLine = false): Promise<Completion> => {
      const previous = lastRound(await call('read'));
      const actions = command(text);
      if (clearLine) actions.unshift({ type: 'key', key: 'CTRL_U' });
      return finish(await call('write', { actions }), previous);
    };
    const successful = (result: Completion): void => {
      assert.equal(result.state, 'command_completed');
      assert.equal(result.commandStarted, true);
      assert.equal(result.exitCode, 0);
    };
    const hasOutputLine = (result: Completion, line: string): void => {
      assert.ok(typeof result.output === 'string');
      assert.ok(result.output.split(/\r?\n/).some(value => value.trim() === line), result.output);
    };

    try {
      const configDirectory = join(env.HOME!, '.lite-ssh');
      await fs.mkdir(configDirectory, { mode: 0o700 });
      // Synthetic loopback credentials and the exact in-memory key fingerprint.
      // Neither the real user's config nor ~/.ssh/known_hosts is consulted.
      await fs.writeFile(join(configDirectory, 'config.json'), JSON.stringify({
        version: 2,
        servers: {
          [ssh.ip]: {
            [ssh.port]: {
              hostKeyFingerprint: ssh.fingerprint,
              accounts: {
                [ssh.username]: { auth: { type: 'password', password: ssh.password } },
              },
            },
          },
        },
      }), { encoding: 'utf8', mode: 0o600 });
      t.diagnostic(`[${shell}/${phase}] MCP connect`);
      try { await client.connect(transport); }
      catch (cause) { throw new Error(`[${shell}/${phase}] MCP connect failed`, { cause }); }
      finally {
        // Preserve the owned PID even when MCP initialization itself fails.
        if (transport.pid !== null) {
          await fs.writeFile(join(root, 'child-pid.json'), JSON.stringify({
            testPid: process.pid,
            cliPid: transport.pid,
          }), { mode: 0o600 });
        }
      }
      assert.ok(transport.pid, 'SDK must own a concrete CLI child');

      phase = 'open';
      const opened = await call('open', { username: ssh.username });
      assert.equal(opened.shellIntegration, 'ready');
      assert.equal(opened.state, 'open');
      assert.equal(ssh.children.length, 1);
      const child = ssh.children[0]!;
      assert.ok(child.scriptPid > 1 && child.shellPid! > 1);
      assert.match(child.tty!, /^\/dev\/pts\/\d+$/);
      // The wrapper used exec: this recorded PID must now name the tested binary,
      // not /bin/sh, a mock peer, or a process guessed from the user's machine.
      assert.equal((await fs.readFile(`/proc/${child.shellPid}/comm`, 'utf8')).trim(), shell);
      const cachePath = String(opened.cachePath);
      assert.ok(cachePath.startsWith(join(env.HOME!, '.lite-ssh', 'cache') + sep));
      await fs.access(cachePath);

      phase = 'printf_unicode';
      const greeting = `你好，真实 ${shell}`;
      const printed = await execute(`printf '%s\\n' '${greeting}'`);
      successful(printed);
      hasOutputLine(printed, greeting);

      phase = 'false';
      const rejected = await execute('false');
      assert.equal(rejected.state, 'command_completed');
      assert.equal(rejected.commandStarted, true);
      assert.notEqual(rejected.exitCode, 0);

      // All three parsers reject an unmatched closing parenthesis without a
      // foreground BEGIN. Production deliberately calls that shell_input_finished,
      // with the real parser status (not an assumed cross-shell numeric constant).
      phase = 'syntax_error';
      const syntax = await execute(')');
      assert.equal(syntax.state, 'shell_input_finished');
      assert.equal(syntax.commandStarted, false);
      assert.notEqual(syntax.exitCode, 0);
      assert.match(String(syntax.output), /syntax|parse|unexpected|expected/i);
      phase = 'after_syntax';
      // Fish keeps rejected input in its editor; a trusted END does not promise
      // an empty input line. Clear it explicitly, never alter production input.
      const recovered = await execute("printf '%s\\n' 'after_syntax'", true);
      successful(recovered);
      hasOutputLine(recovered, 'after_syntax');

      phase = 'foreground_sleep';
      const previous = lastRound(await call('read'));
      const token = randomBytes(8).toString('hex');
      const runningLine = `sleep_started_${token}`;
      let sleeping = await call('write', {
        // The complete output token is absent from the echoed input, so seeing
        // its own screen line proves execution, not just PTY input echo.
        actions: command(`printf 'sleep_%s\\n' 'started_${token}'; sleep 30`),
      });
      const sleepDeadline = Date.now() + 5000;
      while (!(sleeping.screen as ScreenSnapshot | undefined)?.lines
        .some(line => line.trim() === runningLine) && Date.now() < sleepDeadline) {
        assert.equal(freshCompletion(sleeping, previous), undefined, 'sleep ended before Ctrl-C');
        await delay(40);
        sleeping = await call('read');
      }
      assert.ok((sleeping.screen as ScreenSnapshot).lines.some(line => line.trim() === runningLine));
      assert.equal(freshCompletion(sleeping, previous), undefined);
      assert.equal(typeof sleeping.currentRound, 'string');
      phase = 'ctrl_c';
      const interrupted = await finish(await call('write', {
        actions: [{ type: 'key', key: 'CTRL_C' }],
      }), previous);
      assert.equal(interrupted.state, 'command_completed');
      assert.equal(interrupted.commandStarted, true);
      assert.notEqual(interrupted.exitCode, 0);
      phase = 'after_interrupt';
      const continued = await execute("printf '%s\\n' 'after_interrupt'");
      successful(continued);
      hasOutputLine(continued, 'after_interrupt');

      phase = 'initial_stty_size';
      const initial = opened.screen as ScreenSnapshot;
      assert.deepEqual(ssh.windows[0], { rows: initial.rows, cols: initial.cols });
      const initialSize = await execute('stty size');
      successful(initialSize);
      hasOutputLine(initialSize, `${initial.rows} ${initial.cols}`);
      phase = 'resize';
      const resized = { rows: 37, cols: 111 };
      await call('resize', resized);
      const resizeDeadline = Date.now() + 5000;
      while (!ssh.windows.some(value => value.rows === resized.rows && value.cols === resized.cols) &&
          Date.now() < resizeDeadline) {
        ssh.assertHealthy();
        await delay(20);
      }
      assert.ok(ssh.windows.some(value => value.rows === resized.rows && value.cols === resized.cols));
      phase = 'resized_stty_size';
      const realSize = await execute('stty size');
      successful(realSize);
      hasOutputLine(realSize, `${resized.rows} ${resized.cols}`);

      phase = 'close';
      const closed = await call('close');
      assert.equal(closed.state, 'closed');
      assert.equal(closed.cacheRemoved, true);
      await assert.rejects(fs.access(cachePath), { code: 'ENOENT' });
      ssh.assertHealthy();
      assert.equal(stderr, '');
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      // SDK close ends/reaps only its concrete CLI child. The SSH helper also
      // closes its owned script/PTY and server even after partial initialization.
      try {
        try { await client.close(); }
        finally {
          try { await transport.close(); }
          finally { await ssh.close(); }
        }
      } catch (cause) {
        // Preserve the shell/operation error if cleanup independently fails too.
        if (!failed) {
          failed = true;
          throw new Error(`[${shell}] cleanup failed`, { cause });
        }
        t.diagnostic(`[${shell}] cleanup also failed: ${String(cause)}`);
      } finally {
        if (failed) {
          try {
            const path = await ssh.writeFailureOutput();
            t.diagnostic(`[${shell}/${phase}] PTY output tail (at most 16 KiB): ${path}`);
          } catch (cause) {
            t.diagnostic(`[${shell}/${phase}] saving PTY output tail failed: ${String(cause)}`);
          }
        }
      }
    }
  });
}
