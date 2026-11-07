import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';

export type RealShell = 'bash' | 'zsh' | 'fish';
const shells = {
  bash: { path: '/bin/bash', command: 'exec /bin/bash --noprofile --norc -i' },
  zsh: { path: '/usr/bin/zsh', command: 'exec /usr/bin/zsh -f -i' },
  fish: { path: '/usr/bin/fish', command: 'exec /usr/bin/fish --no-config -i' },
} satisfies Record<RealShell, { path: string; command: string }>;
const runFile = promisify(execFile);
const PTY_TAIL_BYTES = 16 * 1024;
type Window = { rows: number; cols: number };

export interface OwnedShellPid {
  scriptPid: number;
  shellPid?: number;
  tty?: string;
  closed: boolean;
}

/** Explicit environment, not a copy of the caller's shell/Node startup settings.
 * The MCP CLI and the remote shell get separate homes beneath the owned fixture.
 */
export async function createRealShellEnvironment(root: string): Promise<Record<string, string>> {
  const directories = ['home', 'config', 'cache', 'data', 'state', 'runtime', 'tmp'];
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all(directories.map(name => fs.mkdir(join(root, name), { mode: 0o700 })));
  return {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    ZDOTDIR: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    TEMP: join(root, 'tmp'),
    HISTFILE: join(root, 'home', 'history'),
    INPUTRC: '/dev/null',
    ENV: '/dev/null',
    USER: 'real_shell_fixture',
    LOGNAME: 'real_shell_fixture',
    // util-linux script uses SHELL to select its -c wrapper, not the tested shell.
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PS1: 'fixture$ ',
  };
}

async function settledWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Real SSH protocol AND real Linux PTY. This intentionally is not an OpenSSH
 * daemon fixture and does not exercise real account startup files or macOS.
 * No shell integration markers are produced here: only dist/cli.js may send the
 * production probe/bootstrap, which the actual interactive shell must execute.
 */
export async function startRealShellSsh(shell: RealShell, root: string) {
  if (process.platform !== 'linux') throw new Error('Real-shell SSH fixtures require Linux.');
  for (const path of ['/bin/sh', '/usr/bin/script', '/usr/bin/stty', shells[shell].path]) {
    try { await fs.access(path, constants.X_OK); }
    catch (cause) { throw new Error(`LSSH_REAL_SHELLS=1 requires executable ${path}.`, { cause }); }
  }
  const env = await createRealShellEnvironment(root);
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const parsed = ssh2.utils.parseKey(key.privateKey);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = `SHA256:${createHash('sha256')
    .update(parsed.getPublicSSH())
    .digest('base64')
    .replace(/=+$/, '')}`;
  const username = `fixture_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(32).toString('hex');
  // Keep only actual script/PTY stdout, never SSH authentication or input args.
  // This bounded evidence is written only after failure and never fed back into
  // the protocol or used as a substitute for production shell markers.
  let ptyTail = Buffer.alloc(0);
  let markerCarry = Buffer.alloc(0);
  const startedAt = performance.now();
  const elapsedMs = (): number => Math.round((performance.now() - startedAt) * 10) / 10;
  const metrics = {
    stdoutBytes: 0,
    stdoutChunks: 0,
    firstStdoutMs: null as number | null,
    lastStdoutMs: null as number | null,
    stopRequestedMs: null as number | null,
    firstMarkers: {} as Record<string, { ms: number; stdoutByteOffset: number }>,
  };
  const observeOutput = (chunk: Buffer): void => {
    const previousBytes = metrics.stdoutBytes;
    const now = elapsedMs();
    metrics.stdoutBytes += chunk.length;
    metrics.stdoutChunks++;
    metrics.firstStdoutMs ??= now;
    metrics.lastStdoutMs = now;
    ptyTail = Buffer.from(Buffer.concat([ptyTail, chunk]).subarray(-PTY_TAIL_BYTES));
    const scan = Buffer.concat([markerCarry, chunk]);
    // Diagnostic observation only: real ESC/BEL or ESC/ST, never printable
    // bootstrap escapes. Carry is bounded; each marker is counted once even
    // across stdout chunks. These times do NOT mean MCP has parsed the marker.
    const marker = /\x1b\]777;LSSH;[A-Za-z0-9_.-]+;(STTY|PROBE|READY|BEGIN|END|UNSUPPORTED)(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
    for (const match of scan.toString('latin1').matchAll(marker)) {
      const offset = previousBytes - markerCarry.length + match.index;
      if (offset + match[0].length <= previousBytes) continue;
      metrics.firstMarkers[match[1]!] ??= { ms: now, stdoutByteOffset: offset };
    }
    markerCarry = Buffer.from(scan.subarray(-512));
  };
  const clients = new Set<ssh2.Connection>();
  const children: OwnedShellPid[] = [];
  const windows: Window[] = [];
  let failure: Error | undefined;
  let closing = false;
  let pidWrites = Promise.resolve();
  let owned: ReturnType<typeof bridgeShell> | undefined;
  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
  };
  const recordPids = (): void => {
    const snapshot = JSON.stringify({ testPid: process.pid, shell, children });
    pidWrites = pidWrites
      .then(() => fs.writeFile(join(root, 'child-pids.json'), snapshot, { mode: 0o600 }))
      .catch(fail);
  };

  function bridgeShell(channel: ssh2.ServerChannel, initial: Window) {
    const sentinel = `REAL_SHELL_${randomBytes(24).toString('hex')}`;
    // This private line proves which exec-owned child and /dev/pts node belong
    // to this run. It is stripped before SSH output; it is NOT a READY/END marker.
    const command = `printf '${sentinel};%s;%s\\n' "$$" "$(tty)"; ${shells[shell].command}`;
    const child: ChildProcessWithoutNullStreams = spawn('/usr/bin/script', [
      '-q', '-e', '-f', '-c', command, '/dev/null',
    ], {
      cwd: root,
      env: { ...env, LINES: String(initial.rows), COLUMNS: String(initial.cols) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const record: OwnedShellPid = { scriptPid: child.pid ?? 0, closed: false };
    children.push(record);
    recordPids();
    let window = initial;
    let windowWork = Promise.resolve();
    let stopping = false;
    let stoppingWork: Promise<void> | undefined;
    let stderr = '';
    let prefix = Buffer.alloc(0);
    let initialized = false;
    channel.pause(); // Do not echo a production probe ahead of our private line.

    const resize = (next: Window): Promise<void> => {
      window = next;
      if (!record.tty || stopping) return windowWork;
      const tty = record.tty;
      windowWork = windowWork.then(async () => {
        if (stopping || record.closed) return;
        // Never accept a client-supplied device path. Only the random sentinel's
        // validated, currently owned PTY may receive initial/window-change sizes.
        await runFile('/usr/bin/stty', [
          '-F', tty, 'rows', String(next.rows), 'cols', String(next.cols),
        ], { cwd: root, env, timeout: 3000, maxBuffer: 4096 });
        windows.push({ ...next });
      });
      return windowWork;
    };

    const output = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (initialized) { callback(null, chunk); return; }
        prefix = Buffer.concat([prefix, chunk]);
        const newline = prefix.indexOf(0x0a);
        if (newline < 0) {
          if (prefix.length > 4096) callback(new Error('Missing owned PTY sentinel.'));
          else callback();
          return;
        }
        const line = prefix.subarray(0, newline).toString('ascii').replace(/\r$/, '');
        const fields = line.split(';');
        const pid = Number(fields[1]);
        if (fields.length !== 3 || fields[0] !== sentinel ||
            !/^\d+$/.test(fields[1] ?? '') || !Number.isSafeInteger(pid) || pid <= 1 ||
            !/^\/dev\/pts\/\d+$/.test(fields[2] ?? '')) {
          callback(new Error('Invalid owned child PID/PTY sentinel.'));
          return;
        }
        record.shellPid = pid;
        record.tty = fields[2]!;
        recordPids();
        const remainder = prefix.subarray(newline + 1);
        prefix = Buffer.alloc(0);
        void resize(window).then(() => {
          if (stopping) { callback(); return; }
          initialized = true;
          channel.pipe(child.stdin);
          channel.resume();
          callback(null, remainder);
        }, error => callback(error));
      },
    });
    const done = new Promise<void>(resolve => {
      child.once('close', code => {
        record.closed = true;
        recordPids();
        if (!stopping && !initialized) {
          fail(new Error(`script exited before PTY initialization: ${stderr}`));
        }
        if (!channel.destroyed) {
          channel.exit(code ?? 255);
          channel.end();
        }
        resolve();
      });
    });

    const stop = (): Promise<void> => {
      stoppingWork ??= (async () => {
        metrics.stopRequestedMs ??= elapsedMs();
        stopping = true;
        channel.unpipe(child.stdin);
        child.stdout.unpipe(output);
        output.unpipe(channel);
        output.destroy();
        child.stdout.resume();
        // EOF plus a terminal interrupt allows an owned foreground sleep and
        // its interactive shell to exit. Escalation targets ONLY this ChildProcess
        // object, never a process name/group or a PID discovered by scanning.
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('\x03\x04');
        if (!await settledWithin(done, 1500)) {
          child.kill('SIGTERM');
          if (!await settledWithin(done, 1500)) child.kill('SIGKILL');
        }
        if (!await settledWithin(done, 3000)) {
          throw new Error(`Owned script child ${record.scriptPid} did not close.`);
        }
        await windowWork.catch(error => { if (!record.closed) throw error; });
      })();
      return stoppingWork;
    };
    const bridgeFailed = (error: unknown): void => {
      if (!stopping) fail(error);
      channel.close();
      void stop().catch(fail);
    };
    child.on('error', bridgeFailed);
    child.stdin.on('error', bridgeFailed);
    child.stdout.on('error', bridgeFailed);
    output.on('error', bridgeFailed);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4096); });
    child.stderr.on('error', bridgeFailed);
    child.stdout.on('data', observeOutput);
    child.stdout.pipe(output).pipe(channel, { end: false });
    channel.once('end', () => { void stop().catch(fail); });
    channel.once('close', () => { void stop().catch(fail); });
    channel.on('error', bridgeFailed);
    return { resize, stop };
  }

  const server = new ssh2.Server({ hostKeys: [key.privateKey] }, client => {
    clients.add(client);
    client.on('error', error => { if (!closing) fail(error); });
    client.once('close', () => clients.delete(client));
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === username && auth.password === password) auth.accept();
      else auth.reject();
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        let window: Window | undefined;
        const validWindow = (info: Window): boolean =>
          Number.isInteger(info.rows) && info.rows >= 2 && info.rows <= 100 &&
          Number.isInteger(info.cols) && info.cols >= 2 && info.cols <= 240;
        session.on('pty', (ok, reject, info) => {
          if (window || !validWindow(info)) { reject(); return; }
          window = { rows: info.rows, cols: info.cols };
          ok?.();
        });
        session.on('window-change', (ok, reject, info) => {
          if (!window || !validWindow(info)) { reject?.(); return; }
          window = { rows: info.rows, cols: info.cols };
          void (owned?.resize(window) ?? Promise.resolve()).then(() => ok?.(), fail);
        });
        session.on('shell', (ok, reject) => {
          if (!window || owned || closing) { reject(); return; }
          owned = bridgeShell(ok(), window);
        });
      });
    });
  });
  server.on('error', fail);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  let closeWork: Promise<void> | undefined;
  return {
    ip: '127.0.0.1', port, username, password, fingerprint, children, windows,
    assertHealthy(): void { if (failure) throw failure; },
    /** The caller invokes this only on failure; no raw output log on success. */
    async writeFailureOutput(): Promise<string> {
      const path = join(root, 'pty-output-tail.log');
      const redacted = Buffer.from(ptyTail.toString('utf8').replaceAll(password, '[REDACTED]'));
      await fs.writeFile(path, redacted.subarray(-PTY_TAIL_BYTES), { mode: 0o600 });
      await fs.writeFile(join(root, 'pty-output-metrics.json'), JSON.stringify({
        shell,
        clock: 'milliseconds since helper startup; observed at script stdout, not MCP parsing',
        ...metrics,
      }, null, 2), { mode: 0o600 });
      return path;
    },
    close(): Promise<void> {
      closeWork ??= (async () => {
        closing = true;
        // All owners get a cleanup attempt even if a different one fails.
        const results = await Promise.allSettled([
          owned?.stop() ?? Promise.resolve(),
          (async () => {
            for (const client of clients) client.end();
            const closed = new Promise<void>(resolve => server.close(() => resolve()));
            if (!await settledWithin(closed, 3000)) throw new Error('Loopback SSH server did not close.');
          })(),
        ]);
        await pidWrites;
        for (const result of results) if (result.status === 'rejected') fail(result.reason);
        if (failure) throw failure;
      })();
      return closeWork;
    },
  };
}
