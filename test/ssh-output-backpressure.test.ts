import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { FileHandle } from 'node:fs/promises';
import type { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Writable } from 'node:stream';
import { compileFunction } from 'node:vm';
import ssh2, { type ClientChannel, type ServerChannel } from 'ssh2';
import { fixtureRoot } from './helpers/workspace.js';
import { ReadableRecorder } from '../src/cache/recorder.js';
import type { ConnectionLease, TerminalIdentity } from '../src/core/types.js';
import { ensurePrivateDirectory, requirePrivatePath } from '../src/platform/permissions.js';
import { TerminalSession } from '../src/terminal/session.js';

const CHUNK_SIZE = 32 * 1024;
const TOTAL_CHUNKS = 256;
const TOTAL_STREAM_BYTES = CHUNK_SIZE * TOTAL_CHUNKS;
// Test-only Windows headroom: 16MiB crosses ~4096 sequential 4KiB render/flush
// transactions. A 64-write renderer-only sample took ~0.93s (~60s at16MiB),
// before real recording, setup, hashes and physical cleanup. Product budgets
// and every non-Windows/readiness/data/plateau assertion remain unchanged.
const OUTER_TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 30_000;
const READY_DEADLINE_MS = process.platform === 'win32' ? 30_000 : 10_000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface ProducerState {
  bytesWritten: number;
  falseObserved: boolean;
  waitingDrain: boolean;
  finished: boolean;
}

// Isolation is constructor locality, not a security sandbox. The dependency is already trusted.
/**
 * TEST SERVER ONLY. Stock ssh2 1.17.0 reproduces a stdout-complete/stderr-stuck
 * deadlock after both readers pause. Its window-adjust handler clears the one
 * wait flag, then exclusively retries stdout; separately pending stderr has
 * no wake-up after stdout retires. This narrowly corrected constructor is not
 * a fix, replacement or monkeypatch of the PRODUCT CLIENT or installed files.
 *
 * Keep real crypto/TCP, actual incoming window credit and native callbacks.
 * Snapshot/clear consumed slots BEFORE retrying, so callback reentry can safely
 * publish new pending slots. Always retry both old slots: if stdout used all
 * credit, native stderr._write re-arms its own slot and the shared wait flag.
 * Package/source drift fails closed, never silently chooses another adapter.
 */
function isolatedPressureServer(): typeof ssh2.Server {
  const require = createRequire(import.meta.url);
  const serverPath = require.resolve('ssh2/lib/server.js');
  const channelPath = require.resolve('ssh2/lib/Channel.js');
  const source = readFileSync(serverPath, 'utf8');
  const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
  assert.equal(sha256(source), '128b58ee54cf97a5ae17e18836ff4472de4a5e4e591f2862a5c9ec7f148befe5',
    'Review the isolated pressure fixture before accepting a new ssh2 server source.');
  assert.equal(sha256(readFileSync(channelPath)), '53e92988a025009b192b72be110bd240b5653f88dbdec93e515e3e401e7f94aa',
    'Review the isolated pressure fixture before accepting new channel pending-slot semantics.');
  const original = `          if (channel._waitWindow) {
            channel._waitWindow = false;

            if (channel._chunk) {
              channel._write(channel._chunk, null, channel._chunkcb);
            } else if (channel._chunkcb) {
              channel._chunkcb();
            } else if (channel._chunkErr) {
              channel.stderr._write(channel._chunkErr,
                                    null,
                                    channel._chunkcbErr);
            } else if (channel._chunkcbErr) {
              channel._chunkcbErr();
            }
          }`;
  const replacement = `          if (channel._waitWindow) {
            channel._waitWindow = false;
            const stdoutChunk = channel._chunk;
            const stdoutCallback = channel._chunkcb;
            const stderrChunk = channel._chunkErr;
            const stderrCallback = channel._chunkcbErr;
            channel._chunk = undefined;
            channel._chunkcb = undefined;
            channel._chunkErr = undefined;
            channel._chunkcbErr = undefined;

            if (stdoutChunk) {
              channel._write(stdoutChunk, null, stdoutCallback);
            } else if (stdoutCallback) {
              stdoutCallback();
            }
            if (stderrChunk) {
              channel.stderr._write(stderrChunk, null, stderrCallback);
            } else if (stderrCallback) {
              stderrCallback();
            }
          }`;
  assert.notEqual(source.indexOf(original), -1, 'The exact window-adjust branch must exist.');
  assert.equal(source.indexOf(original), source.lastIndexOf(original), 'The isolated correction must be unique.');
  const isolatedModule: { exports: unknown } = { exports: {} };
  const evaluate = compileFunction(source.replace(original, replacement), [
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
  ], { filename: `${serverPath}.isolated-pressure-fixture` });
  evaluate(isolatedModule.exports, createRequire(serverPath), isolatedModule, serverPath, dirname(serverPath));
  assert.equal(typeof isolatedModule.exports, 'function');
  return isolatedModule.exports as typeof ssh2.Server;
}

function closeReceipt(owner: EventEmitter) {
  let observed = false;
  const promise = new Promise<void>(resolve => {
    owner.once('close', () => {
      observed = true;
      resolve();
    });
  });
  return { promise, observed: () => observed };
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned SSH fixture timed out: ${label}.`)), READY_DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Independent real producers obey their OWN false/drain signal, not a shared scripted gate. */
async function runProducer(
  stream: Writable,
  chunk: Buffer,
  expectedHash: ReturnType<typeof createHash>,
  state: ProducerState,
  stop: AbortSignal,
): Promise<void> {
  try {
    for (let index = 0; index < TOTAL_CHUNKS; index++) {
      if (stop.aborted || stream.destroyed || !stream.writable) break;
      const accepted = stream.write(chunk);
      expectedHash.update(chunk);
      state.bytesWritten += chunk.length;
      if (accepted) {
        await new Promise<void>(resolve => setImmediate(resolve));
        continue;
      }
      state.falseObserved = true;
      state.waitingDrain = true;
      assert.ok(stream.writableLength <= stream.writableHighWaterMark + CHUNK_SIZE);
      try {
        await new Promise<void>((resolve, reject) => {
          const clean = () => {
            stream.off('drain', onDrain);
            stream.off('error', onError);
            stream.off('close', onStop);
            stop.removeEventListener('abort', onStop);
          };
          const onDrain = () => { clean(); resolve(); };
          const onError = (error: Error) => { clean(); reject(error); };
          const onStop = () => { clean(); resolve(); };
          stream.once('drain', onDrain);
          stream.once('error', onError);
          stream.once('close', onStop);
          stop.addEventListener('abort', onStop, { once: true });
          if (stop.aborted) onStop();
        });
      } finally {
        state.waitingDrain = false;
      }
    }
  } finally {
    state.finished = true;
  }
}

test('real SSH output backpressure holds both unfinished producers then preserves both stream hashes', {
  timeout: OUTER_TIMEOUT_MS,
}, async context => {
  const outerDeadline = performance.now() + OUTER_TIMEOUT_MS;
  const faults: unknown[] = [];
  const finalizerErrors: unknown[] = [];
  const peers = new Map<ssh2.Connection, ReturnType<typeof closeReceipt>>();
  const producers: Promise<void>[] = [];
  const stopProducers = new AbortController();
  const channels: { server?: ServerChannel; client?: ClientChannel } = {};
  let bodyThrew = false;
  let primaryError: unknown;
  let server: ssh2.Server | undefined;
  let serverClose: ReturnType<typeof closeReceipt> | undefined;
  let serverListened = false;
  let client: ssh2.Client | undefined;
  let clientClose: ReturnType<typeof closeReceipt> | undefined;
  let handle: FileHandle | undefined;
  let recorder: ReadableRecorder | undefined;
  let session: TerminalSession | undefined;
  let cachePath: string | undefined;
  let fileClose: Promise<void> | undefined;
  let nativeCloses = 0;
  let fileClosed = false;
  let leaseReleases = 0;
  let gateActive = false;
  let gateEntered = false;
  let releaseWrite: (() => void) | undefined;
  let writeGate: Promise<void> | undefined;
  let onStdout: ((data: Buffer) => void) | undefined;
  let onStderr: ((data: Buffer) => void) | undefined;
  const reportFault = (error: unknown): void => { faults.push(error); };
  const releaseGate = (): void => {
    gateActive = false;
    releaseWrite?.();
    releaseWrite = undefined;
  };
  const closeFile = (): Promise<void> => {
    assert.ok(handle);
    if (!fileClose) {
      nativeCloses++;
      fileClose = handle.close();
      void fileClose.then(() => { fileClosed = true; }, () => undefined);
    }
    return fileClose;
  };
  const attempt = async (action: () => unknown | Promise<unknown>): Promise<void> => {
    try { await action(); }
    catch (error) { finalizerErrors.push(error); }
  };
  const until = async (
    predicate: () => boolean,
    label: string,
    deadline = performance.now() + READY_DEADLINE_MS,
  ): Promise<void> => {
    while (!predicate()) {
      if (faults.length > 0) throw faults[0];
      if (context.signal.aborted) throw context.signal.reason;
      assert.ok(performance.now() < deadline, `Owned SSH fixture did not reach ${label}.`);
      await delay(20);
    }
  };

  try {
    // The shell is simulated, but every output byte travels through real SSH/TCP.
    // All keys/credentials are synthetic in-memory fixtures, never HOME/auth reads.
    const key = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const PressureServer = isolatedPressureServer();
    assert.notEqual(PressureServer, ssh2.Server, 'The stock server export must remain unchanged.');
    context.diagnostic(JSON.stringify({
      phase: 'fixture',
      server: 'SHA-guarded isolated ssh2 1.17.0 server with corrected dual-pending window resume',
      client: 'stock ssh2; product modules unchanged',
    }));
    server = new PressureServer({ hostKeys: [key.privateKey] }, peer => {
      peers.set(peer, closeReceipt(peer));
      peer.on('error', reportFault);
      peer.on('authentication', auth => {
        if (auth.method === 'password' && auth.username === 'bp_user' && auth.password === 'bp_pass') auth.accept();
        else auth.reject();
      });
      peer.on('ready', () => {
        peer.on('session', accept => {
          const request = accept();
          request.on('pty', ok => ok?.());
          request.on('shell', ok => {
            const channel = ok();
            channels.server = channel;
            channel.on('error', reportFault);
            channel.stderr.on('error', reportFault);
            channel.once('end', () => channel.end());
            channel.once('close', () => {
              if (!channel.destroyed) channel.end();
            });
            let input = '';
            let probe = false;
            let ready = false;
            channel.on('data', (data: Buffer) => {
              try {
                input += data.toString('utf8');
                const nonce = /LSSH;([A-Za-z0-9_.-]+);/.exec(input)?.[1];
                if (!nonce) return;
                if (!probe && input.includes('/proc/$PPID/comm')) {
                  probe = true;
                  channel.write(`\x1b]777;LSSH;${nonce};STTY;0:0:0:0\x07\x1b]777;LSSH;${nonce};PROBE;bash\x07`);
                }
                if (!ready && input.includes('READY;bash')) {
                  ready = true;
                  channel.write(`\x1b]777;LSSH;${nonce};READY;bash\x07`);
                }
              } catch (error) { reportFault(error); }
            });
          });
        });
      });
    });
    serverClose = closeReceipt(server);
    server.on('error', reportFault);
    await bounded(new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    }), 'listen');
    serverListened = true;
    const port = (server.address() as AddressInfo).port;
    client = new ssh2.Client();
    clientClose = closeReceipt(client);
    client.on('error', reportFault);
    await bounded(new Promise<void>((resolve, reject) => {
      client!.once('error', reject);
      client!.once('ready', () => {
        client!.off('error', reject);
        resolve();
      });
      client!.connect({ host: '127.0.0.1', port, username: 'bp_user', password: 'bp_pass' });
    }), 'SSH ready');

    // Capture the real public shell callback; do not inspect Session private fields.
    const nativeShell = client.shell;
    client.shell = function (this: ssh2.Client, ...args: unknown[]) {
      const callback = args[args.length - 1];
      assert.equal(typeof callback, 'function');
      args[args.length - 1] = (...values: unknown[]) => {
        if (!values[0]) channels.client = values[1] as ClientChannel;
        Reflect.apply(callback as (...values: unknown[]) => unknown, undefined, values);
      };
      return Reflect.apply(nativeShell, this, args);
    } as typeof client.shell;

    const root = fixtureRoot('ssh-output-backpressure', randomUUID());
    await ensurePrivateDirectory(root);
    cachePath = join(root, 'session.log');
    handle = await fs.open(cachePath, 'wx', 0o600);
    await requirePrivatePath(cachePath, 'file', true, handle);
    const gatedHandle = new Proxy(handle, {
      get(target, property) {
        if (property === 'close') return closeFile;
        if (property === 'write') {
          return (...args: unknown[]) => {
            const forward = () => Reflect.apply(target.write, target, args);
            if (!gateActive) return forward();
            gateEntered = true;
            assert.ok(writeGate);
            return writeGate.then(forward);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const identity: TerminalIdentity = {
      ip: '127.0.0.1', port, username: 'bp_user', codename: 'bp_term',
    };
    const lease: ConnectionLease = {
      client,
      target: { ip: identity.ip, port, username: identity.username },
      release: async () => { leaseReleases++; },
    };
    // Keep ALL production initialization and recorder budgets at their defaults.
    recorder = await ReadableRecorder.createWithHandle(gatedHandle, cachePath, identity);
    session = await TerminalSession.open(lease, identity, { recorder });
    assert.ok(channels.server);
    assert.ok(channels.client);
    const channel = channels.client;
    const output = channels.server;
    await until(() => !channel.isPaused() && !channel.stderr.isPaused(), 'initial read-side resume');

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    onStdout = data => { stdoutBytes += data.length; stdoutHash.update(data); };
    onStderr = data => { stderrBytes += data.length; stderrHash.update(data); };
    const paused = [channel.isPaused(), channel.stderr.isPaused()];
    channel.on('data', onStdout);
    channel.stderr.on('data', onStderr);
    assert.deepEqual([channel.isPaused(), channel.stderr.isPaused()], paused);
    // Passive observers see only events already admitted by Session's first
    // listener. They never read/resume either stream or buffer payload bodies.
    writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
    gateActive = true;
    const stdoutState: ProducerState = {
      bytesWritten: 0, falseObserved: false, waitingDrain: false, finished: false,
    };
    const stderrState: ProducerState = {
      bytesWritten: 0, falseObserved: false, waitingDrain: false, finished: false,
    };
    const expectedStdout = createHash('sha256');
    const expectedStderr = createHash('sha256');
    const stdoutChunk = Buffer.from(`${'O'.repeat(62)}\r\n`.repeat(512), 'ascii');
    const stderrChunk = Buffer.from(`${'E'.repeat(62)}\r\n`.repeat(512), 'ascii');
    assert.equal(stdoutChunk.length, CHUNK_SIZE);
    assert.equal(stderrChunk.length, CHUNK_SIZE);
    producers.push(runProducer(output, stdoutChunk, expectedStdout, stdoutState, stopProducers.signal));
    producers.push(runProducer(output.stderr, stderrChunk, expectedStderr, stderrState, stopProducers.signal));
    for (const producer of producers) void producer.catch(reportFault);

    // In-flight SSH window credit may settle first. Within ONE bounded run,
    // require a continuous 500ms unchanged, genuinely unfinished plateau.
    let stableAt = performance.now();
    let lastCounts = [-1, -1];
    await until(() => {
      assert.ok(stdoutState.bytesWritten < TOTAL_STREAM_BYTES && stderrState.bytesWritten < TOTAL_STREAM_BYTES,
        'Finite cap reached while held: saturation was NOT established.');
      const counts = [stdoutState.bytesWritten, stderrState.bytesWritten];
      const saturated = gateEntered && gateActive && !stdoutState.finished && !stderrState.finished &&
        stdoutState.waitingDrain && stderrState.waitingDrain && stdoutState.falseObserved && stderrState.falseObserved &&
        counts[0]! > 0 && counts[1]! > 0 && channel.isPaused() && channel.stderr.isPaused();
      if (!saturated || counts.some((value, index) => value !== lastCounts[index])) stableAt = performance.now();
      lastCounts = counts;
      return saturated && performance.now() - stableAt >= 500;
    }, 'unfinished dual-stream plateau');
    context.diagnostic(JSON.stringify({
      phase: 'held', plateauMs: performance.now() - stableAt, stdoutBytes: stdoutState.bytesWritten,
      stderrBytes: stderrState.bytesWritten, stdoutPaused: channel.isPaused(), stderrPaused: channel.stderr.isPaused(),
      stdoutFalse: stdoutState.falseObserved, stderrFalse: stderrState.falseObserved,
    }));
    releaseGate();
    // Readiness keeps its original 30s/10s budget. Completion belongs to the
    // already-approved 60s/30s OUTER budget, not a second readiness deadline.
    let lastProgressAt = performance.now();
    await until(() => {
      if (performance.now() - lastProgressAt >= 5_000) {
        lastProgressAt = performance.now();
        context.diagnostic(JSON.stringify({
          phase: 'released-progress',
          stdoutQueued: stdoutState.bytesWritten,
          stderrQueued: stderrState.bytesWritten,
          stdoutReceived: stdoutBytes,
          stderrReceived: stderrBytes,
          stdoutWaiting: stdoutState.waitingDrain,
          stderrWaiting: stderrState.waitingDrain,
        }));
      }
      return stdoutState.finished && stderrState.finished &&
        stdoutBytes === TOTAL_STREAM_BYTES && stderrBytes === TOTAL_STREAM_BYTES;
    }, 'both complete raw streams', outerDeadline);
    await Promise.all(producers);
    assert.equal(stdoutState.bytesWritten, TOTAL_STREAM_BYTES);
    assert.equal(stderrState.bytesWritten, TOTAL_STREAM_BYTES);
    assert.equal(stdoutBytes, TOTAL_STREAM_BYTES);
    assert.equal(stderrBytes, TOTAL_STREAM_BYTES);
    const stdoutDigest = stdoutHash.digest('hex');
    const stderrDigest = stderrHash.digest('hex');
    assert.equal(stdoutDigest, expectedStdout.digest('hex'));
    assert.equal(stderrDigest, expectedStderr.digest('hex'));
    context.diagnostic(JSON.stringify({
      phase: 'complete-raw',
      stdoutReceived: stdoutBytes,
      stderrReceived: stderrBytes,
      stdoutSha256: stdoutDigest,
      stderrSha256: stderrDigest,
    }));
    await session.read();
    await recorder.flush();
    const text = await fs.readFile(cachePath, 'utf8');
    assert.ok(text.includes('O'.repeat(32)));
    assert.ok(text.includes('E'.repeat(32)));
    if (faults.length > 0) throw faults[0];
  } catch (error) {
    bodyThrew = true;
    primaryError = error;
  } finally {
    releaseGate();
    // Abort only the harness drain observers, NEVER claim that this retires
    // native work. Confirm the actual SSH/socket/file owners separately below.
    stopProducers.abort();
    if (channels.client && onStdout) channels.client.off('data', onStdout);
    if (channels.client && onStderr) channels.client.stderr.off('data', onStderr);
    await attempt(async () => {
      if (session) {
        const cleanup = await session.close();
        assert.equal(cleanup.ok, true);
        assert.equal(cleanup.cacheRemoved, true);
        assert.equal(cleanup.remoteChannelCleanupConfirmed, true);
        assert.equal(leaseReleases, 1);
      } else if (recorder) {
        const cleanup = await recorder.close();
        assert.equal(cleanup.cacheRemoved, true);
        assert.equal(cleanup.cleanupError, undefined);
      }
    });
    // Shutdown requests precede joining producers: server stderr does not have
    // to emit a channel close event in order to cancel a test-only drain wait.
    await attempt(() => channels.server?.stderr.destroy());
    await attempt(() => channels.server?.close());
    await attempt(() => client?.end());
    await attempt(() => client?.destroy());
    for (const peer of peers.keys()) await attempt(() => peer.end());
    await attempt(async () => {
      if (clientClose) await bounded(clientClose.promise, 'client physical close');
    });
    for (const receipt of peers.values()) {
      await attempt(() => bounded(receipt.promise, 'peer physical close'));
    }
    await attempt(async () => {
      // ssh2.Server wraps net.Server and does not expose its listening field.
      // Use our observed acquisition/close state, not the broader type declaration.
      if (server && serverListened && !serverClose?.observed()) {
        await bounded(new Promise<void>((resolve, reject) => {
          server!.close(error => error ? reject(error) : resolve());
        }), 'server close');
      }
      if (serverListened && serverClose) await bounded(serverClose.promise, 'server physical close');
    });
    for (const outcome of await Promise.allSettled(producers)) {
      if (outcome.status === 'rejected' && outcome.reason !== primaryError) finalizerErrors.push(outcome.reason);
    }
    await attempt(async () => {
      if (handle) {
        await closeFile();
        assert.equal(nativeCloses, 1);
        assert.equal(fileClosed, true);
      }
    });
    await attempt(async () => {
      if (cachePath) await assert.rejects(fs.lstat(cachePath), { code: 'ENOENT' });
    });
    for (const error of faults) {
      if ((!bodyThrew || error !== primaryError) && !finalizerErrors.includes(error)) finalizerErrors.push(error);
    }
    context.diagnostic(JSON.stringify({
      phase: 'closed', fileClosed, nativeCloses, leaseReleases,
      clientClosed: clientClose?.observed() ?? 'not_acquired',
      peersClosed: [...peers.values()].every(receipt => receipt.observed()),
      serverClosed: serverClose?.observed() ?? 'not_acquired', finalizerFailures: finalizerErrors.length,
    }));
    if (bodyThrew) {
      if (finalizerErrors.length > 0) throw new AggregateError([primaryError, ...finalizerErrors], 'SSH body and cleanup failed; primary first.');
      throw primaryError;
    }
    if (finalizerErrors.length > 0) throw new AggregateError(finalizerErrors, 'Owned SSH fixture cleanup failed.');
  }
});
