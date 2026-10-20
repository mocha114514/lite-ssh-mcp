import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { ClientChannel } from 'ssh2';
import { ReadableRecorder } from '../cache/recorder.js';
import { LiteSshError } from '../core/errors.js';
import { SerialQueue, deferred, withTimeout } from '../core/async.js';
import type { ConnectionLease, InputAction, RoundResult, ScreenSnapshot, ShellMarker, TerminalIdentity, TerminalStatus } from '../core/types.js';
import { ScreenModel } from './screen.js';
import { MAX_SHELL_SEQUENCE } from '../shell/protocol.js';
import { encodeBatch } from './input.js';
import { detectShell, makeShellBootstrap, makeShellProbe } from '../shell/integration.js';
import { connectionCleanupFailure, terminalCleanupFailure, withTerminalCleanup } from './cleanup.js';

export interface SessionOptions {
  cacheRoot?: string;
  cols?: number;
  rows?: number;
  initializationTimeoutMs?: number;
  writeWaitMs?: number;
  /**
   * Test/advanced seam mirroring `ReadableRecorder.createWithHandle`: supply an
   * already-built recorder (for example over a controlled fake file handle) so
   * timing-sensitive cache behaviour can be driven without real private files.
   * Production callers omit it and the session creates and owns its recorder.
   */
  recorder?: ReadableRecorder;
}

/**
 * One real shell input cycle; a compound/quoted command can span several Enters.
 *
 * A cycle exists from either an actual byte handoff or a trusted BEGIN and
 * closes on the single trusted END that belongs to it. It is
 *  - `published` when it may be reported as `currentRound` and become a public
 *    completion (a real BEGIN arrived or we actually handed input to the shell);
 *  - `started` once a trusted BEGIN proved a foreground command is running;
 *  - `owner` set to the submission token of the line it belongs to (`owner` set
 *    with no `started` at END is the `shell_input_finished` case).
 *
 * A PRIVATE, unpublished candidate cycle is kept open after every trusted END
 * so the next prompt/echo/error output already has a readable home before the
 * next submission is handed off. An idle candidate is not an execution claim:
 * a trusted END can retain a factual non-executing completion, but no waiter
 * may claim it without a valid, unambiguous ownership credit.
 */
interface Cycle {
  id: string;
  published: boolean;
  started: boolean;
  /**
   * Submission token that owns this cycle. A cycle with an owner corresponds to
   * a line we really submitted, so an END without a BEGIN still becomes a
   * `shell_input_finished` result; an idle candidate has no owner.
   */
  owner?: number;
  /** Marked when a bare interrupt (Ctrl-C) at the prompt owns this candidate cycle. */
  interrupt?: boolean;
}

/** One concrete PTY instance. Waiters keep this object, never look up a reused codename. */
export class TerminalSession {
  readonly identity: TerminalIdentity;
  readonly recorder: ReadableRecorder;
  readonly screen: ScreenModel;
  status: TerminalStatus = 'opening';
  private channel?: ClientChannel;
  /** Only the actual channel close event confirms PTY channel teardown. */
  private channelClosed = false;
  /** A timed-out shell request can still return a late, independently owned PTY. */
  private shellRequestPending = false;
  /** A late callback is not a close acknowledgment for its returned stream. */
  private lateChannelCleanupPending = false;
  private readonly sends = new SerialQueue();
  private readonly output = new SerialQueue();
  private readonly roundWrites = new SerialQueue();
  private readonly events = new EventEmitter();
  private readonly ended = deferred<void>();
  private readonly stdoutEnded = deferred<void>();
  private readonly stderrEnded = deferred<void>();
  private readonly markers = new Map<string, ShellMarker>();
  private readonly nonce = randomBytes(16).toString('hex');
  private readonly initializationTimeout: number;
  private readonly writeWait: number;
  private eventSequence = 0;
  /** Remote wire rounds are not cache rounds, Enter credits or local change events. */
  private runtimeReady = false;
  private nextWireSequence = 1;
  private activeWireSequence?: number;
  private failure?: LiteSshError;
  /** Receive-side health is separate: remote EOF must not discard accepted bytes. */
  private recordingFailure?: LiteSshError;
  /**
   * A command can repair the BEGIN hook before its END reports healthy. Keep
   * observed hook loss until a valid trusted BEGIN proves boundaries work
   * again; neither a healthy END nor the absence of an owner proves recovery.
   */
  private beginHookTrustLost = false;
  /** The single open cache round/candidate; see {@link Cycle}. */
  private cycle?: Cycle;
  /**
   * At most one conservative ownership credit per active write, only while no
   * foreground command is running. Queued bytes are not predicted shell cycles:
   * a trusted BEGIN/END must claim the next credit. Expired observers remove
   * unused credits, so a continuation cannot leak ownership to a later call.
   */
  private pendingTokens: number[] = [];
  /** Monotonic per-write credit; only real markers can establish a claimable cycle. */
  private submissionCounter = 0;
  private lastResult?: RoundResult;
  /** Only active tool observers retain owner results: at most 64 per PTY. */
  private readonly waitingOwners = new Set<number>();
  private readonly ownerResults = new Map<number, { result?: RoundResult; error?: LiteSshError; sequence: number }>();
  private activeWrites = 0;
  /** Cancellation releases observers, not retained work. This credit spans
   * the awaited send AND post-observation parsing/recording drains, until the
   * whole write actually settles; neither phase may retain unbounded calls. */
  private retainedWrites = 0;
  /** A cancelled MCP observer cannot retire a read still draining or flushing. */
  private retainedReads = 0;
  /** Queued resizes share the retained-input-work budget with writes. */
  private retainedResizes = 0;
  /** Batch origin survives observer expiry; expiry is not an all-input ACK. */
  private batchOwner?: number;
  /** Once boundaries mix, this PTY keeps factual rounds but never guesses ownership. */
  private ownershipAmbiguous = false;
  /** Transient provenance barrier caused specifically by prompt interrupt (Ctrl-C). */
  private interruptBarrier = false;
  /** Count of submissions entered while interruptBarrier is active. */
  private interruptSubmissions = 0;
  /** Closed waiters may inspect the final parsed screen after emulator disposal. */
  private finalScreen?: ScreenSnapshot;
  private closePromise?: Promise<Record<string, unknown>>;
  private closeResult?: Record<string, unknown>;
  private initialized = false;

  private constructor(private readonly lease: ConnectionLease, identity: TerminalIdentity, recorder: ReadableRecorder, options: SessionOptions) {
    this.identity = { ...identity };
    this.recorder = recorder;
    this.initializationTimeout = options.initializationTimeoutMs ?? 10_000;
    this.writeWait = options.writeWaitMs ?? 5_000;
    this.events.setMaxListeners(64);
    this.screen = new ScreenModel({
      nonce: this.nonce, cols: options.cols ?? 80, rows: options.rows ?? 24,
      onLine: line => {
        try { this.recorder.recordLine(line); } catch (error) { this.failRecording(error); }
      },
      onMarker: marker => this.onMarker(marker),
      onFrame: (snapshot, label) => {
        try { this.recorder.recordFrame(snapshot, label); } catch (error) { this.failRecording(error); }
      },
      // Protocol replies must not wait behind a tool's remote-output waiter.
      onReply: data => {
        if (this.failure || this.status === 'closing' || this.status === 'closed') return;
        try { this.enqueueInput(data); }
        catch (error) { this.fail(error, 'TERMINAL_WRITE_FAILED'); }
      }
    });
  }

  static async open(lease: ConnectionLease, identity: TerminalIdentity, options: SessionOptions = {}): Promise<TerminalSession> {
    // Recorder/model/listeners exist before requesting the shell. ssh2 buffers early data.
    let ownedRecorder: ReadableRecorder | undefined;
    let ownedSession: TerminalSession | undefined;
    try {
      const recorder = options.recorder ?? await ReadableRecorder.create(identity, options.cacheRoot);
      ownedRecorder = recorder;
      const session = new TerminalSession(lease, identity, recorder, options);
      ownedSession = session;
      let requestExpired = false;
      let channel: ClientChannel;
      try {
        channel = await withTimeout(new Promise<ClientChannel>((resolve, reject) => {
          session.shellRequestPending = true;
          try {
            lease.client.shell({
              term: 'xterm-256color',
              cols: options.cols ?? 80,
              rows: options.rows ?? 24
            }, (error, stream) => {
              session.shellRequestPending = false;
              if (requestExpired) {
                // A timeout does not cancel ssh2's request. Track a late
                // concrete channel through its actual close event, including
                // callbacks arriving while cache/lease teardown is awaiting.
                if (stream) {
                  session.lateChannelCleanupPending = true;
                  stream.once('close', () => { session.lateChannelCleanupPending = false; });
                  try { stream.close(); }
                  catch {
                    try { stream.destroy(); }
                    catch { /* Keep the unconfirmed owned-channel fact. */ }
                  }
                }
                return;
              }
              if (error) reject(new LiteSshError('PTY_OPEN_FAILED', 'The SSH server rejected the PTY/shell request.'));
              else resolve(stream);
            });
          } catch (error) {
            session.shellRequestPending = false;
            reject(error);
          }
        }), session.initializationTimeout, 'PTY_OPEN_TIMEOUT');
      } catch (error) { requestExpired = true; throw error; }
      session.attach(channel);
      const probe = session.awaitMarker('probe');
      const stty = session.awaitMarker('stty');
      await session.send(makeShellProbe(session.nonce));
      const [probeMarker, sttyMarker] = await Promise.all([probe, stty]);
      if (probeMarker.kind !== 'probe' || sttyMarker.kind !== 'stty') throw new LiteSshError('SHELL_INTEGRATION_FAILED', 'Invalid shell initialization state.');
      const shell = detectShell(probeMarker.shell);
      const ready = session.awaitMarker('ready');
      await session.send(makeShellBootstrap(shell, session.nonce, sttyMarker.value));
      await ready;
      await session.output.drain();
      await recorder.flush();
      if (session.failure) throw session.failure;
      session.initialized = true;
      session.status = 'open';
      return session;
    } catch (error) {
      // Initialization remains the primary failure even if owned teardown
      // fails. A factory that never returned has its own acquisition proof;
      // do not guess ownership of its possible residual file.
      let cleanup: Record<string, unknown> = {};
      if (ownedSession) {
        try { cleanup = await ownedSession.close(); }
        catch (closeError) { cleanup = terminalCleanupFailure(closeError); }
        cleanup.cachePath = ownedSession.recorder.path;
      } else {
        if (ownedRecorder) {
          cleanup.cachePath = ownedRecorder.path;
          try { Object.assign(cleanup, await ownedRecorder.close()); }
          catch (closeError) { Object.assign(cleanup, terminalCleanupFailure(closeError)); }
        }
        try { await lease.release(); }
        catch (releaseError) { Object.assign(cleanup, connectionCleanupFailure(releaseError)); }
      }
      throw withTerminalCleanup(error, identity, cleanup);
    }
  }

  private attach(channel: ClientChannel): void {
    this.channel = channel;
    const accept = (chunk: Buffer | string): void => {
      channel.pause();
      channel.stderr.pause();
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      void this.output.run(async () => {
        if (this.recordingFailure) throw this.recordingFailure;
        // Bound a parser/write transaction so line callbacks cannot queue an entire huge burst.
        for (let offset = 0; offset < bytes.length; offset += 4096) {
          const snapshot = await this.screen.write(bytes.subarray(offset, offset + 4096));
          this.recorder.recordFrame(snapshot);
          await this.recorder.flush();
          this.notify();
          // EOF/error forbids new input, not healthy recording of received data.
          if (this.recordingFailure) throw this.recordingFailure;
        }
      }).catch(error => this.failRecording(error)).finally(() => {
        // Closing still drains already-received buffered data; never freeze a paused stream.
        if (this.status !== 'closed' && !this.recordingFailure) {
          channel.resume();
          channel.stderr.resume();
        }
      });
    };
    channel.on('data', accept);
    channel.stderr.on('data', accept);
    channel.on('error', (error: Error) => this.fail(error, 'CONNECTION_LOST'));
    channel.stderr.on('error', (error: Error) => this.fail(error, 'CONNECTION_LOST'));
    channel.on('end', () => this.stdoutEnded.resolve());
    channel.stderr.on('end', () => this.stderrEnded.resolve());
    channel.on('close', () => {
      this.channelClosed = true;
      if (this.status !== 'closing' && this.status !== 'closed') {
        this.status = 'error';
        this.failure ??= new LiteSshError('TERMINAL_EXITED', 'The remote PTY exited; no unfinished round is marked complete.');
      }
      this.ended.resolve();
      this.notify();
    });
  }

  private failRecording(error: unknown): void {
    this.recordingFailure ??= error instanceof LiteSshError ? error :
      new LiteSshError('CACHE_WRITE_FAILED', 'The parsed terminal recording failed; input has not been replayed.');
    this.fail(this.recordingFailure, 'CACHE_WRITE_FAILED');
  }

  private fail(error: unknown, code: string): void {
    this.failure ??= error instanceof LiteSshError ? error : new LiteSshError(code, 'The terminal stream or readable cache failed; input has not been replayed.');
    if (this.status !== 'closing' && this.status !== 'closed') this.status = 'error';
    this.notify();
  }
  private notify(): void { this.eventSequence++; this.events.emit('change'); }

  private onMarker(marker: ShellMarker): void {
    if (marker.kind === 'begin' || marker.kind === 'end') {
      if (!this.runtimeReady) return;
      // Validate BEFORE changing ownership, cache cycles or hook-loss trust.
      // A malformed/foreign frame never reaches here; a valid but inconsistent
      // owned frame fails closed and cannot be repaired by a later READY/END.
      if (!this.acceptWireMarker(marker)) {
        this.runtimeReady = false;
        this.fail(new LiteSshError(
          'SHELL_INTEGRATION_LOST',
          'Shell marker sequence was inconsistent. Close this terminal and open a new one; input was not replayed.',
        ), 'SHELL_INTEGRATION_LOST');
        return;
      }
      this.markers.set(marker.kind, marker);
      if (marker.kind === 'begin') this.onTrustedBegin();
      else {
        this.onTrustedEnd(marker.exitCode, marker.hookHealthy);
        if (marker.sequence === MAX_SHELL_SEQUENCE) {
          // onTrustedEnd queues the final factual result first. Never wrap to
          // zero or let a future command reuse this already-completed round.
          this.runtimeReady = false;
          this.fail(new LiteSshError(
            'SHELL_INTEGRATION_UNSUPPORTED',
            'Shell marker sequence was exhausted. Close this terminal and open a new one.',
          ), 'SHELL_INTEGRATION_UNSUPPORTED');
        }
      }
      if (this.failure?.code === 'SHELL_INTEGRATION_LOST') this.runtimeReady = false;
    } else {
      if (marker.kind === 'ready' && !this.initialized && !this.markers.has('ready') && !this.failure) {
        // READY and a runtime tail can be parsed in the SAME xterm write. The
        // async open() continuation has not set initialized yet at this point.
        this.runtimeReady = true;
      }
      this.markers.set(marker.kind, marker);
      if (marker.kind === 'unsupported' && !this.failure) {
        this.runtimeReady = false;
        this.fail(new LiteSshError('SHELL_INTEGRATION_UNSUPPORTED', marker.reason), 'SHELL_INTEGRATION_UNSUPPORTED');
      }
    }
    this.notify();
  }

  /** Accept one wire transition; an END-only round is a real shell event too. */
  private acceptWireMarker(marker: Extract<ShellMarker, { kind: 'begin' | 'end' }>): boolean {
    if (marker.kind === 'begin') {
      if (this.activeWireSequence !== undefined || marker.sequence !== this.nextWireSequence) return false;
      this.activeWireSequence = marker.sequence;
      return true;
    }
    if (marker.sequence !== (this.activeWireSequence ?? this.nextWireSequence)) return false;
    this.activeWireSequence = undefined;
    if (marker.sequence < MAX_SHELL_SEQUENCE) this.nextWireSequence = marker.sequence + 1;
    return true;
  }

  /** Open a fresh, private candidate round with no publication or execution claim. */
  private openCycle(): Cycle {
    return { id: this.recorder.beginRound(), published: false, started: false };
  }

  /** The published (observable) round id, or `undefined` while only a candidate is open. */
  private activeRound(): string | undefined {
    return this.cycle?.published ? this.cycle.id : undefined;
  }

  /**
   * Trusted shell BEGIN. It proves a foreground command started, so it always
   * publishes the current round even if nothing was submitted by us.
   */
  private onTrustedBegin(): void {
    const cycle = this.cycle;
    if (!cycle) {
      this.beginHookTrustLost = false;
      // A shell-side command we did not reserve: still give its output a round.
      const opened: Cycle = { id: this.recorder.beginRound(), published: true, started: true };
      this.cycle = opened;
      this.recorder.markCommandStarted();
      return;
    }
    if (cycle.started) {
      this.fail(new LiteSshError('SHELL_INTEGRATION_LOST', 'A second BEGIN arrived before the previous round ended.'), 'SHELL_INTEGRATION_LOST');
      return;
    }
    this.beginHookTrustLost = false;
    cycle.interrupt = undefined;
    // F04: Only assign queued ownership if ownership is not ambiguous (cancel/expired barrier)
    // and no interrupt provenance barrier is active.
    // Factual execution (started, published, markCommandStarted) is ALWAYS recorded!
    if (!this.ownershipAmbiguous && !this.interruptBarrier) {
      this.assignPendingToken();
    }
    cycle.started = true;
    cycle.published = true;
    // Separate the trusted command output from any pre-execution echo already
    // cached in this round; the round id and on-disk echo history stay put.
    this.recorder.markCommandStarted();
  }

  /**
   * Trusted shell END. Exactly one END closes one cycle.
   *
   *  - a published cycle becomes the writer-claimable completion; `started`
   *    decides between `command_completed` and `shell_input_finished` (parser
   *    errors emit END with no BEGIN, so a submitted line is still reported
   *    with real status);
   *  - a private candidate still records a FACTUAL terminal-level completion:
   *    the shell really finished handling a line with that status, so
   *    `lastCompletedRound` must reflect it instead of a stale earlier round.
   *    It is never published as `currentRound` and, because a writer only
   *    claims a completion whose owner token matches its own submission, it
   *    can never be handed to a writer that did not submit that line.
   *
   * After closing, the next PRIVATE candidate is opened immediately so the
   * following prompt/echo output has a readable home before the next handoff.
   */
  private onTrustedEnd(exitCode: number, hookHealthy = true): void {
    // This health fact also matters when no input reserved a cycle. A healthy
    // END cannot clear earlier loss: the repair command itself may lack BEGIN.
    if (!hookHealthy) this.beginHookTrustLost = true;
    const observedSeq = this.eventSequence;
    const cycle = this.cycle;
    if (!cycle) {
      // An END for input we never handed off (for example a bare Ctrl-C at a
      // prompt). It must not fabricate a round, but still prepare a home for
      // the following prompt output.
      this.prepareNextCycle();
      return;
    }
    const isInterrupt = cycle.interrupt === true;
    if (!isInterrupt) {
      this.assignPendingToken(); // A genuine END-only cycle can claim a queued owner.
    }
    this.cycle = undefined;
    const started = cycle.started;
    const isCompromised = !started && this.beginHookTrustLost;
    const completion = this.recorder.endRound(exitCode, isCompromised ? { commandStartUnknown: true } : undefined);
    if (started && this.interruptBarrier) {
      this.interruptBarrier = false;
      this.interruptSubmissions = 0;
    }
    this.prepareNextCycle();
    void this.roundWrites.run(async () => {
      const result = await completion;
      if (result.round === cycle.id) {
        if (isCompromised) {
          // F03: Hook compromised. Do not declare fake commandStarted: false or shell_input_finished.
          // Retain factual round with commandStartUnknown diagnostic.
          this.lastResult = result;
          if (cycle.owner !== undefined && this.waitingOwners.has(cycle.owner)) {
            const lostError = new LiteSshError(
              'SHELL_INTEGRATION_LOST',
              'Shell integration hook was removed or compromised; command execution could not be delimited.',
              {
                round: result.round,
                exitCode: result.exitCode,
                commandStartUnknown: true,
                cacheRange: result.cacheRange,
              },
            );
            this.ownerResults.set(cycle.owner, { error: lostError, result, sequence: observedSeq });
          }
        } else {
          // A trusted END is a factual cycle completion even when this session
          // did not own the submission. `commandStarted` stays false for a
          // non-executed END, so this is never an execution claim, and the
          // writer-owner gate in `write()` still stops any writer from claiming
          // a completion it did not submit.
          this.lastResult = { ...result, commandStarted: started };
          if (cycle.owner !== undefined && this.waitingOwners.has(cycle.owner)) {
            this.ownerResults.set(cycle.owner, { result: this.lastResult, sequence: observedSeq });
          }
        }
        this.notify();
      }
    }).catch(error => this.failRecording(error));
  }

  /** Future input is not a shell cycle until a real BEGIN/END claims it. */
  private prepareNextCycle(): void {
    this.cycle = this.openCycle();
    if (this.interruptBarrier) {
      this.cycle.interrupt = true;
    }
  }

  /** Give the open, unstarted, unowned cycle the next queued submission token. */
  private assignPendingToken(): void {
    if (this.ownershipAmbiguous) return; // Expired queued credits cannot migrate to another waiter.
    const cycle = this.cycle;
    if (!cycle || cycle.started || cycle.owner !== undefined || cycle.interrupt) return;
    const token = this.pendingTokens.shift() ??
      (this.batchOwner !== undefined && this.waitingOwners.has(this.batchOwner) ? this.batchOwner : undefined);
    if (token === undefined) return;
    cycle.owner = token;
    cycle.published = true;
  }

  /**
   * Open/publish the submission's round EXACTLY at the byte handoff: called
   * synchronously after the pre-send flush and immediately before the channel
   * write. A prompt END observed while the flush was still pending therefore
   * can only touch a private candidate, never a round for bytes that had not
   * been handed to the shell yet. Returns this write's submission token (used to
   * attribute a completion to the writer that actually submitted it).
   */
  private handoff(submissions: number, packet = ''): number | undefined {
    if (this.ownershipAmbiguous) return undefined;
    const unresolvedBatch = this.batchOwner;
    this.batchOwner = undefined;
    if (unresolvedBatch !== undefined) {
      this.ownershipAmbiguous = true;
      // Remaining bytes of A's multi-submit packet can still produce A2 after
      // B arrives. Neither Enter counts nor FIFO credits can identify that
      // boundary as B: invalidate future attribution, retain factual rounds.
      this.waitingOwners.delete(unresolvedBatch);
      if (this.cycle?.owner === unresolvedBatch) this.cycle.owner = undefined;
      for (const pending of this.pendingTokens) this.waitingOwners.delete(pending);
      this.pendingTokens = [];
      return undefined;
    }
    if (this.cycle && !this.cycle.published && this.pendingTokens.length > 0 && !this.cycle.interrupt) {
      this.ownershipAmbiguous = true;
      // Earlier overlapping writes might have been continuation fragments, not
      // additional commands. A new packet across this private boundary makes
      // ownership ambiguous: keep factual ENDs but do not credit any waiter.
      for (const pending of this.pendingTokens) this.waitingOwners.delete(pending);
      this.pendingTokens = [];
      return undefined;
    }
    const hasCtrlC = packet.includes('\x03');
    if (hasCtrlC) {
      if (!this.cycle) this.cycle = this.openCycle();
      if (!this.cycle.started) {
        this.cycle.interrupt = true;
        // Another Ctrl-C cannot prove that earlier buffered submissions have
        // retired. Initialize only when entering a new provenance episode.
        if (!this.interruptBarrier) this.interruptSubmissions = 0;
        this.interruptBarrier = true;
        for (const pending of this.pendingTokens) this.waitingOwners.delete(pending);
        this.pendingTokens = [];
      }
    }
    if (submissions <= 0) return undefined;
    if (this.cycle?.started) return undefined; // Bytes go to the running program's stdin.

    if (this.interruptBarrier) {
      this.interruptSubmissions += submissions;
      if (this.interruptSubmissions > 1) {
        // Multiple submissions entered during the interrupt barrier (either a single
        // packet with multiple Enters or multiple independent packets during the barrier).
        // Line discipline now contains multiple pending commands; we cannot guess when the
        // shell finishes these lines, so escalate to permanent ownershipAmbiguous.
        this.ownershipAmbiguous = true;
      }
      return undefined;
    }

    const token = (this.submissionCounter += 1);
    // Several Enters can belong to one quote/loop/continuation. A write offers
    // one conservative ownership credit; only trusted shell markers create
    // later factual cycles. Never manufacture credits from shell grammar.
    this.pendingTokens.push(token);
    this.waitingOwners.add(token);
    if (submissions > 1) this.batchOwner = token;
    // The re-encode can turn non-submitting bytes into submitting ones (a keypad
    // ENTER whose application mode was switched off during the flush), so make
    // sure a cycle exists to own this submission before assigning the token.
    if (!this.cycle) this.cycle = this.openCycle();
    this.assignPendingToken();
    return token;
  }

  private awaitMarker(kind: ShellMarker['kind']): Promise<ShellMarker> {
    const promise = new Promise<ShellMarker>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        this.events.off('change', listener);
        this.events.off('dispose', disposed);
      };
      const finish = (marker?: ShellMarker, error?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(marker!);
      };
      const listener = (): void => {
        if (this.failure) { finish(undefined, this.failure); return; }
        const marker = this.markers.get(kind);
        if (marker) finish(marker);
      };
      const disposed = (): void => finish(undefined, new LiteSshError('TERMINAL_CLOSED', 'The terminal was closed during initialization.'));
      this.events.on('change', listener);
      this.events.on('dispose', disposed);
      timer = setTimeout(() => finish(undefined, new LiteSshError('SHELL_INTEGRATION_FAILED', 'The shell initialization event did not arrive.')), this.initializationTimeout);
      listener();
    });
    // send() can fail before open() reaches its await/Promise.all. Handle rejection now,
    // but return the original promise so the caller still observes the real failure.
    void promise.catch(() => undefined);
    return promise;
  }

  private checkInputBudget(data: string): void {
    if (this.status === 'closing' || this.status === 'closed' || !this.channel?.writable ||
        this.channel.destroyed || this.channel.errored) {
      throw new LiteSshError('TERMINAL_CLOSED', 'The PTY is not writable.');
    }
    // Native Writable length includes the currently retained ssh2 callback and
    // every queued packet. Tool input and DA/DSR replies share this byte credit.
    if (this.channel.writableLength + Buffer.byteLength(data, 'utf8') > 256 * 1024) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The PTY outgoing queue reached its 256 KiB budget; input has not been replayed.');
    }
  }

  private enqueueInput(data: string, onAttempt?: () => void, onAccepted?: () => void): void {
    this.checkInputBudget(data);
    // Also cover internal protocol replies: byte credit cannot bound empty
    // Writable callback entries retained behind an earlier native write.
    if (data.length === 0) return;
    let returned = false;
    let synchronousFailure: LiteSshError | undefined;
    // An invoked native call can have a prefix effect even when it throws.
    onAttempt?.();
    this.channel!.write(data, (error?: Error | null) => {
      if (!error) return;
      const failure = new LiteSshError('TERMINAL_WRITE_FAILED', 'Input transmission failed; it has not been replayed.');
      if (!returned) synchronousFailure = failure;
      else if (this.status !== 'closed' && this.status !== 'closing') this.fail(failure, 'TERMINAL_WRITE_FAILED');
    });
    returned = true;
    if (synchronousFailure) throw synchronousFailure;
    onAccepted?.(); // A healthy write(false) still queued the complete packet.
  }

  private async send(data: string, onAttempt?: () => void, onAccepted?: () => void): Promise<void> {
    // Accepted by the native FIFO is the handoff, NOT a remote processing ACK.
    // ssh2 can retain its callback forever under window backpressure. Waiting
    // for it here would block both the observation deadline and owned close.
    this.enqueueInput(data, onAttempt, onAccepted);
  }

  private current(): Record<string, unknown> {
    if (this.status === 'closed' && this.closeResult) {
      return {
        // Late accepted output may have failed while close awaited EOF. Keep
        // its deliberately public loss counters, then restore owner/status.
        ...(this.failure?.details ?? {}),
        ...(this.recordingFailure?.details ?? {}),
        ...this.closeResult,
        currentRound: this.activeRound() ?? null,
        lastCompletedRound: this.lastResult ?? null,
        screen: this.finalScreen ?? null,
        ...(!this.finalScreen ? { screenUnavailable: true } : {}),
        ...(this.recordingFailure ? {
          recordingErrorCode: this.recordingFailure.code,
          cacheMayBeIncomplete: true
        } : {}),
        ...(this.failure ? {
          ok: false,
          code: this.failure.code,
          message: this.failure.message
        } : {})
      };
    }
    return {
      // LiteSshError details are deliberately public. Owner/status fields below
      // remain authoritative; a prior transport fault must not hide later EIO loss.
      ...(this.failure?.details ?? {}), ...(this.recordingFailure?.details ?? {}),
      ...(this.recordingFailure && this.recordingFailure !== this.failure ? { recordingErrorCode: this.recordingFailure.code } : {}),
      ok: !this.failure, state: this.status === 'closed' ? 'closed' : this.failure ? 'error' : this.status,
      terminal: { ...this.identity }, cachePath: this.recorder.path,
      currentRound: this.activeRound() ?? null, lastCompletedRound: this.lastResult ?? null,
      ...(this.ownershipAmbiguous || this.interruptBarrier ? { completionOwnership: 'unknown' } : {}),
      screen: this.finalScreen ?? this.screen.snapshot(),
      ...(this.failure ? { code: this.failure.code, message: this.failure.message, cacheMayBeIncomplete: true } : {})
    };
  }
  async read(): Promise<Record<string, unknown>> {
    if (this.retainedReads >= 64) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The PTY has reached its 64 retained-read-work budget.');
    }
    this.retainedReads++;
    try {
      await this.output.drain();
      await this.roundWrites.drain();
      await this.recorder.flush();
      return this.current();
    } finally {
      this.retainedReads--;
    }
  }

  async write(actions: InputAction[], signal?: AbortSignal): Promise<Record<string, unknown>> {
    const requested = actions.length;
    let accepted: number | null = 0;
    const facts = () => ({
      inputActionsRequested: requested,
      inputActionsAccepted: accepted,
      inputSent: accepted === null ? null : accepted > 0,
    });
    try {
      const result = await this.writeTracked(actions, signal, value => { accepted = value; });
      // Apply local facts LAST: an error's public details must not roll N back
      // to zero, or turn an invoked-but-unknown native effect into inputSent:false.
      return { ...result, ...facts() };
    } catch (error) {
      const failure = error instanceof LiteSshError
        ? error
        : accepted === null && this.failure
          ? this.failure
          : new LiteSshError('INTERNAL_ERROR', 'The operation failed; no input has been automatically replayed.');
      if (failure.code === 'CACHE_WRITE_FAILED') this.failRecording(failure);
      throw new LiteSshError(failure.code, failure.message, {
        ...failure.details,
        ...(this.recordingFailure ? {
          recordingErrorCode: this.recordingFailure.code,
          cacheMayBeIncomplete: true,
        } : {}),
        ...facts(),
      });
    }
  }

  private async writeTracked(
    actions: InputAction[],
    signal: AbortSignal | undefined,
    onHandoff: (accepted: number | null) => void,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new LiteSshError('REQUEST_CANCELLED', 'Observation cancelled before input handoff.', { inputSent: false });
    if (!actions.length || actions.length > 64) throw new LiteSshError('INVALID_ACTIONS', 'Provide 1 through 64 input actions.');
    if (this.activeWrites >= 64) throw new LiteSshError('RESOURCE_LIMIT', 'The PTY has reached its 64 active-input-observer budget.');
    if (this.retainedWrites + this.retainedResizes >= 64) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The PTY has reached its 64 retained-input-work budget.');
    }
    // Set inside the send transaction, before `sent` flips; the initial value is
    // never observed because the listener ignores events until `sent` is true.
    let observeScreenChange = true;
    let ambiguousBatch = false;
    let initialRevision = this.screen.snapshot().revision;
    let initialSequence = this.eventSequence;
    let sent = false;
    let noOp = false;
    let baseline = this.eventSequence;
    /** This write's submission token; undefined for non-submitting input. */
    let token: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    let released = false;
    this.activeWrites++;
    this.retainedWrites++;
    // Cancellation frees only this observer, never the remote input or PTY.
    // Idempotence covers abort racing ordinary completion and owned close.
    const releaseObserver = (): void => {
      if (released) return;
      released = true;
      this.activeWrites--;
      if (token !== undefined) {
        if (this.pendingTokens.includes(token) ||
            (this.cycle?.owner === token && !this.cycle.started && !this.ownerResults.has(token))) {
          this.ownershipAmbiguous = true;
        }
        this.waitingOwners.delete(token);
        this.ownerResults.delete(token);
        this.pendingTokens = this.pendingTokens.filter(pending => pending !== token);
      }
      if (timer) clearTimeout(timer);
      if (listener) this.events.off('change', listener);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    };
    const observation = new Promise<'event' | 'deadline' | 'cancelled'>(resolve => {
      listener = (): void => {
        if (!sent) return;
        if (this.failure || this.status !== 'open') { resolve('event'); return; }
        const snapshot = this.screen.snapshot();
        // Each active observer owns its completion independently. R1 remains
        // claimable even if R2 has started or overwritten the factual last result.
        const owned = token === undefined ? undefined : this.ownerResults.get(token);
        // A multi-Enter packet may be one compound command or several lines.
        // Keep observing within the existing deadline; return only real ENDs,
        // never infer that all queued actions were consumed from an Enter count.
        if (!ambiguousBatch && owned && owned.sequence >= baseline) { resolve('event'); return; }
        if (observeScreenChange && snapshot.revision > initialRevision) { resolve('event'); return; }
        if (snapshot.buffer === 'alternate' && snapshot.revision > initialRevision) resolve('event');
      };
      this.events.on('change', listener);
      timer = setTimeout(() => resolve('deadline'), this.writeWait);
      onAbort = (): void => { releaseObserver(); resolve('cancelled'); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      await this.sends.run(async () => {
        if (signal?.aborted) throw new LiteSshError('REQUEST_CANCELLED', 'Observation cancelled before input handoff.', { inputSent: false });
        if (this.status !== 'open' || this.failure) throw this.failure ?? new LiteSshError('TERMINAL_CLOSED', 'The terminal is not open.');
        // Fail fast: an invalid batch must not touch the cache at all. The
        // authoritative encode happens after the flush, against the screen as
        // it is at the actual handoff.
        const preliminary = encodeBatch(actions, this.screen.snapshot());
        if (preliminary.packet.length === 0) {
          // Keep validation/writable-state precedence, but empty literal text
          // creates no native callback, STEP, owner or remote observation.
          this.checkInputBudget(preliminary.packet);
          noOp = true;
          return;
        }
        // Give the submitted line a home inside a PRIVATE candidate before the
        // flush, then persist everything enqueued so far. A shell END observed
        // while this flush is pending belongs to earlier input and can only
        // touch the private candidate; the round for the bytes below is opened
        // only after the flush returns (see handoff).
        if (preliminary.submissions > 0 && !this.cycle) this.cycle = this.openCycle();
        await this.recorder.flush();
        // Re-encode against the CURRENT screen: the remote may have changed
        // modes (bracketed paste, application keypad/cursor) while the flush
        // was pending, so the bytes actually sent must match the mode at send
        // time. A paste whose bracketed mode was lost is rejected here, before
        // anything leaves for the shell.
        if (signal?.aborted) throw new LiteSshError('REQUEST_CANCELLED', 'Observation cancelled before input handoff.', { inputSent: false });
        if (this.status !== 'open' || this.failure) throw this.failure ?? new LiteSshError('TERMINAL_CLOSED', 'The terminal stopped before handoff.');
        const { packet, submissions } = encodeBatch(actions, this.screen.snapshot());
        if (Buffer.byteLength(packet, 'utf8') > 65_536) throw new LiteSshError('RESOURCE_LIMIT', 'This input batch exceeds the M0 64 KiB transport budget.');
        this.checkInputBudget(packet); // Reject before publishing an unsent round.
        observeScreenChange = this.activeRound() !== undefined || submissions === 0;
        ambiguousBatch = submissions > 1;
        token = this.handoff(submissions, packet);
        const step = this.recorder.recordStep(actions);
        let accepted: number | null = 0;
        const mark = (value: number | null): void => {
          accepted = value;
          onHandoff(value);
        };
        // Events observed while waiting for the send queue are not post-input observations.
        initialRevision = this.screen.snapshot().revision;
        baseline = this.eventSequence;
        initialSequence = this.eventSequence;
        try {
          // Queue admission is synchronous, not the retained ssh2 callback.
          // Record the final local outcome below before yielding to observation.
          this.enqueueInput(packet, () => mark(null), () => mark(actions.length));
        } catch (error) {
          this.fail(error, 'TERMINAL_WRITE_FAILED');
          throw error;
        } finally {
          // One outcome row belongs to the SAME STEP. Append failure is a
          // recording diagnostic, never a rollback of local queue admission
          // and never a replacement for an earlier transmission failure.
          try { this.recorder.recordStepOutcome(step, actions.length, accepted); }
          catch (error) { this.failRecording(error); }
        }
        sent = true;
        listener?.();
      });
      if (noOp) return this.current();
      const reason = await observation;
      if (reason === 'cancelled') {
        const view = this.current();
        return { ...view, state: view.ok && this.status === 'open' ? 'pending' : view.state,
          inputSent: true, inputHandled: 'unknown', observationCancelled: true,
          message: 'Observation cancelled. Queued input was not reversed; no Ctrl-C, replay, or terminal close was performed.' };
      }
      await this.output.drain();
      await this.roundWrites.drain();
      await this.recorder.flush();
      if (this.status === 'closing' && this.closePromise) await this.closePromise;
      if (this.failure || this.status !== 'open') return { ...this.current(), inputSent: true, inputHandled: 'unknown' };
      const owned = token === undefined ? undefined : this.ownerResults.get(token);
      if (owned && owned.sequence >= baseline) {
        if (owned.error) {
          return {
            ...this.current(),
            ...(owned.result ?? {}),
            ok: false,
            state: 'error',
            code: owned.error.code,
            message: owned.error.message,
            terminal: { ...this.identity },
            cachePath: this.recorder.path,
            inputSent: true,
            inputHandled: 'unknown',
            ...owned.error.details,
          };
        }
        const result = owned.result!;
        return { ok: true, state: result.commandStarted === false ? 'shell_input_finished' : 'command_completed', terminal: { ...this.identity }, cachePath: this.recorder.path, ...result, inputSent: true, inputHandled: 'unknown',
          ...(result.commandStarted === false ? { message: 'The shell finished handling submitted input without starting a foreground command. Consult exitCode and readable diagnostics.' } : {}),
          ...(result.outputOmitted ? { message: 'Output exceeds 1000 Unicode code points. Use local file tools on cachePath within the returned round markers.' } : {}) };
      }
      return {
        ...this.current(), state: reason === 'deadline' ? 'pending' : 'screen_updated', inputSent: true, inputHandled: 'unknown',
        observationChanged: this.eventSequence > initialSequence,
        message: 'Observed state is not proof that every key was handled. Read the current screen; do not automatically replay input.'
      };
    } catch (error) {
      if (!sent) throw error;
      // A post-handoff disk/transport failure must not erase the known effect.
      // Never replay: queue acceptance proves neither delivery nor key handling.
      if (error instanceof LiteSshError && error.code === 'CACHE_WRITE_FAILED') this.failRecording(error);
      else this.fail(error, 'CACHE_WRITE_FAILED');
      return { ...this.current(), inputSent: true, inputHandled: 'unknown', cacheMayBeIncomplete: true };
    } finally {
      releaseObserver();
      // The send is awaited above, so this also covers cancelled queued sends.
      // Do not free retained work merely because observation or handoff ended.
      this.retainedWrites--;
      // batchOwner is a bounded origin retained after cancellation/expiry:
      // neither event proves all queued input was handled.
    }
  }

  async resize(cols: number, rows: number): Promise<Record<string, unknown>> {
    if (this.retainedWrites + this.retainedResizes >= 64) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The PTY has reached its 64 retained-input-work budget.');
    }
    this.retainedResizes++;
    try {
      // Await the queued work itself: returning its promise would release this
      // credit in finally before the window change and cache flush settle.
      return await this.sends.run(async () => {
        if (this.status !== 'open' || !this.channel) throw new LiteSshError('TERMINAL_CLOSED', 'The terminal is not open.');
        this.channel.setWindow(rows, cols, 0, 0);
        const screen = this.screen.resize(cols, rows);
        this.recorder.recordFrame(screen, 'RESIZE');
        await this.recorder.flush();
        this.notify();
        return this.current();
      });
    } finally {
      this.retainedResizes--;
    }
  }

  close(): Promise<Record<string, unknown>> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }
  private async performClose(): Promise<Record<string, unknown>> {
    this.status = 'closing';
    let failure: LiteSshError | undefined;
    let channelDeadline: unknown;
    const cleanup: Record<string, unknown> = {};
    const failed = (error: unknown): void => {
      failure ??= error instanceof LiteSshError ? error : new LiteSshError(
        'TERMINAL_CLEANUP_FAILED',
        'Owned terminal cleanup could not fully complete.'
      );
    };
    const attempt = async (action: () => unknown | Promise<unknown>): Promise<void> => {
      try { await action(); }
      catch (error) { failed(error); }
    };
    try {
      await attempt(() => this.notify());
      await attempt(() => this.sends.run(async () => {
        if (!this.channel) return;
        try {
          // A channel close event does not drain paused stderr/stdout. Avoid
          // repeating the close request, but always restore both read sides
          // and wait for their end events before closing the recorder.
          if (!this.channelClosed && !this.channel.destroyed) this.channel.close();
          this.channel.resume();
          this.channel.stderr.resume();
          await withTimeout(
            Promise.all([this.ended.promise, this.stdoutEnded.promise, this.stderrEnded.promise]),
            this.initializationTimeout,
            'TERMINAL_CLOSE_TIMEOUT'
          );
        } catch (error) {
          // Force is a request, not proof. A subsequent real close may still
          // make the channel outcome known before the final result is built.
          channelDeadline = error;
          if (!(error instanceof LiteSshError && error.code === 'TERMINAL_CLOSE_TIMEOUT')) failed(error);
          await attempt(() => this.channel!.destroy());
          await attempt(() => this.channel!.resume());
          await attempt(() => this.channel!.stderr.resume());
        }
      }));
      await attempt(() => this.output.drain());
      await attempt(() => this.roundWrites.drain());
      try {
        const recorderResult = await this.recorder.close();
        Object.assign(cleanup, {
          cacheRemoved: recorderResult.cacheRemoved,
          ...(recorderResult.cleanupError !== undefined ? { cleanupError: recorderResult.cleanupError } : {}),
        });
        const recErr = this.recorder.failed;
        if (recErr) {
          this.failRecording(recErr);
        }
      } catch (error) {
        Object.assign(cleanup, terminalCleanupFailure(error));
        failed(error);
      }
    } finally {
      // Each finalizer is independent: a screen/cache/connection error must
      // never skip the remaining local finalizers or erase earlier facts.
      await attempt(() => { this.finalScreen = this.screen.snapshot(); });
      await attempt(() => this.screen.dispose());
      try { await this.lease.release(); }
      catch (error) {
        Object.assign(cleanup, connectionCleanupFailure(error));
        failed(error);
      }
      const remoteChannelCleanupConfirmed = this.channel
        ? this.channelClosed
        : !this.shellRequestPending && !this.lateChannelCleanupPending;
      if (!remoteChannelCleanupConfirmed) {
        failed(channelDeadline ?? new LiteSshError(
          'TERMINAL_CLOSE_TIMEOUT',
          'The owned PTY channel has not confirmed closure.'
        ));
      }
      this.status = 'closed';
      try { this.events.emit('dispose'); }
      catch (error) { failed(error); }
      finally { this.events.removeAllListeners(); }

      const recordingErr = this.recordingFailure ?? this.recorder.failed;
      if (recordingErr && !this.recordingFailure) {
        this.failRecording(recordingErr);
      }

      const diagnosticLoss: Record<string, unknown> = {};
      if (recordingErr) {
        diagnosticLoss.recordingErrorCode = recordingErr.code;
        diagnosticLoss.cacheMayBeIncomplete = true;
        if (typeof recordingErr.details?.reason === 'string') {
          diagnosticLoss.reason = recordingErr.details.reason;
        }
        if (typeof recordingErr.details?.droppedChunks === 'number') {
          diagnosticLoss.droppedChunks = recordingErr.details.droppedChunks;
        }
        if (typeof recordingErr.details?.droppedBytes === 'number') {
          diagnosticLoss.droppedBytes = recordingErr.details.droppedBytes;
        }
      }

      const primaryFailure = recordingErr ?? failure;
      const result: Record<string, unknown> = {
        ...cleanup,
        ...diagnosticLoss,
        ok: !primaryFailure && cleanup.cacheRemoved === true && !cleanup.cleanupError,
        state: remoteChannelCleanupConfirmed ? 'closed' : 'error',
        terminal: { ...this.identity },
        cachePath: this.recorder.path,
        localTerminalClosed: true,
        remoteChannelCleanupConfirmed,
        remoteBackgroundProcessesTerminated: 'not_guaranteed',
      };
      if (primaryFailure) {
        Object.assign(result, {
          ok: false,
          code: primaryFailure.code,
          message: primaryFailure.message,
          terminalCleanupErrorCode: primaryFailure.code,
        });
      }
      this.closeResult = result;
    }
    return this.closeResult!;
  }
}
