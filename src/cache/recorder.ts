/**
 * `ReadableRecorder` — per-terminal readable context cache.
 *
 * HANDOVER / WHY THIS FILE EXISTS
 * -------------------------------
 * One active terminal owns exactly one UTF-8 text file. This module is the only
 * writer of that file; it is fed by the terminal service on every event, not by
 * "grab the current screen when a tool call returns". The cache therefore keeps
 * full readable history on disk while keeping only a tiny bounded preview in
 * memory (1000 code points per open round plus a bounded write backlog).
 *
 * Deliberate boundaries (do not violate without coordinating with `main`):
 *   - No raw SSH/PTY bytes are stored, ever, not even in a debug mode. Only
 *     parsed readable lines, decodable screen snapshots and rendered metadata.
 *   - `recordStep` records the action *kind* and named `key` only. `text` and
 *     `paste` payloads are never written, so hidden input is not mirrored.
 *   - The round output count is the code-point length of the readable body
 *     (line text plus hard LFs). A soft-wrapped or `newline:false` partial line
 *     contributes no LF, so the 1000 boundary is exact for `main` to reason about.
 *   - stdout/stderr are not fabricated as separate streams: one ordered log with
 *     round/step/frame markers preserves background output as a fact.
 *   - `ParsedLine` comes from `src/core/types.ts`; its optional `newline:false`
 *     field marks a partial final row (no LF). Metadata markers always start on
 *     their own physical line via `metadataBoundary()`, which resets the data
 *     prefix state without adding to the logical output body.
 *   - `close()` deletes only the exact path this instance created; there are no
 *     scans, globs or cross-instance deletes.
 *   - `markCommandStarted()` lets the session reserve a round before sending a
 *     user Enter submission. Pre-execution echo is cached under the round, then
 *     the trusted shell BEGIN resets only the in-memory summary so the returned
 *     result reflects the actual command output while the echo stays on disk.
 */

import { randomBytes } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { ensurePrivateDirectory, requirePrivatePath, unlinkOwnedFile, type PrivateObjectIdentity } from '../platform/permissions.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { LiteSshError } from '../core/errors.js';
import type { InputAction, ParsedLine, RoundResult, ScreenSnapshot, TerminalIdentity } from '../core/types.js';
import {
  DATA_PREFIX,
  DEFAULT_MAX_PENDING_BYTES,
  PREVIEW_LIMIT_CHARACTERS,
  outputSectionLine,
  roundBeginLine,
  roundBeginMarker,
  roundEndLine,
  roundEndMarker,
  shellCommandBeginLine,
  stepMarkerLine,
} from './prefixes.js';
import {
  buildCacheFileName,
  describeScreen,
  escapeControl,
  reasonCode,
  sanitizeToken,
  screenSignature,
  styleLine,
  terminalHeaderLine,
} from './format.js';
import { BoundedWriteQueue } from './writeQueue.js';

/** Per-instance filename isolation; the timestamp alone is not uniqueness. */
let instanceCounter = 0;
function uniqueInstance(): string {
  instanceCounter += 1;
  return `p${process.pid.toString(36)}-${instanceCounter.toString(36)}-${randomBytes(4).toString('hex')}`;
}

interface RoundState {
  id: string;
  beginMarker: string;
  endMarker: string;
  outputCharacters: number;
  preview: string[];
  previewCharacters: number;
}

/** Ensure the cache root exists and is private (`0700` on POSIX; ACLs on Windows). */
async function ensureRoot(root: string): Promise<void> {
  await ensurePrivateDirectory(root);
}

export interface CloseResult {
  cacheRemoved: boolean;
  cleanupError?: string;
}

export class ReadableRecorder {
  /** Absolute path of the file this instance exclusively created and owns. */
  readonly path: string;

  private readonly queue: BoundedWriteQueue;
  private readonly handle: FileHandle;
  private objectIdentity?: PrivateObjectIdentity;
  private roundCounter = 0;
  private stepCounter = 0;
  private frameCounter = 0;
  private round?: RoundState;
  private lastFrameSignature?: string;
  /** True when the previous data line suppressed its LF (soft wrap / partial). */
  private continuation = false;
  private lastBuffer?: 'normal' | 'alternate';
  private closed = false;
  private closeResult?: CloseResult;

  private constructor(handle: FileHandle, path: string, maxPendingBytes: number) {
    this.path = path;
    this.handle = handle;
    this.queue = new BoundedWriteQueue(handle, maxPendingBytes);
  }

  /**
   * Create the cache file exclusively and write the initialization header
   * before any round begins. `root` defaults to `~/.lite-ssh/cache`; tests
   * inject a private path. The returned `path` is absolute.
   */
  static async create(identity: TerminalIdentity, root?: string): Promise<ReadableRecorder> {
    const cacheRoot = resolve(root ?? join(homedir(), '.lite-ssh', 'cache'));
    await ensureRoot(cacheRoot);

    const createdAt = new Date();
    const instance = uniqueInstance();
    let handle: FileHandle | undefined;
    let chosen: string | undefined;
    let lastError: unknown;

    // `wx` + 0600 is the exclusive, private create. Retrying with a fresh
    // instance token is the conflict fallback for the astronomically unlikely
    // collision; it never overwrites another instance's file.
    for (let attempt = 0; attempt < 8 && !handle; attempt += 1) {
      const candidate = resolve(cacheRoot, buildCacheFileName(identity, createdAt, `${instance}-${attempt}`));
      try {
        handle = await open(candidate, 'wx', 0o600);
        chosen = candidate;
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new LiteSshError('CACHE_WRITE_FAILED', 'Could not create the readable cache file.', {
            reason: reasonCode(error),
          });
        }
      }
    }
    if (!handle || chosen === undefined) {
      throw new LiteSshError('CACHE_WRITE_FAILED', 'Could not allocate a unique readable cache file.', {
        reason: reasonCode(lastError),
      });
    }

    let objectIdentity: PrivateObjectIdentity | undefined;
    try {
      objectIdentity = await handle.stat({ bigint: true });
      await requirePrivatePath(chosen, 'file', true, handle);
    } catch (error) {
      let cacheRemoved = false;
      let cleanupError = 'CACHE_DELETE_FAILED acquisition_identity_unavailable';
      try {
        if (objectIdentity) {
          await unlinkOwnedFile(chosen, objectIdentity);
          cacheRemoved = true;
          cleanupError = '';
        }
      } catch { cleanupError = 'CACHE_DELETE_FAILED ownership_or_boundary_unconfirmed'; }
      finally {
        try { await handle.close(); }
        catch { cleanupError = 'CACHE_WRITE_FAILED handle_close_unconfirmed'; }
      }
      const failure = error instanceof LiteSshError ? error
        : new LiteSshError('CACHE_WRITE_FAILED', 'Could not capture the acquired cache identity. No content was written.');
      throw new LiteSshError(failure.code, failure.message, {
        ...failure.details, cachePath: chosen, cacheRemoved,
        ...(cleanupError ? { cleanupError } : {})
      });
    }
    const recorder = new ReadableRecorder(handle, chosen, DEFAULT_MAX_PENDING_BYTES);
    recorder.objectIdentity = objectIdentity;
    return recorder.initializeHeader(identity, createdAt, instance);
  }

  /**
   * Test/advanced seam: build a recorder around an already-open handle so a
   * controlled/fake `FileHandle` can exercise write-failure paths without
   * touching real disks. Production code should use `create`, which owns the
   * exclusive file and its cleanup path. Not re-exported by the public barrel.
   */
  static async createWithHandle(
    handle: FileHandle,
    path: string,
    identity: TerminalIdentity,
    options?: { maxPendingBytes?: number },
  ): Promise<ReadableRecorder> {
    const recorder = new ReadableRecorder(handle, resolve(path), options?.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES);
    if (typeof handle.stat === 'function') {
      try { recorder.objectIdentity = await handle.stat({ bigint: true }); }
      catch {
        const cleanup = await recorder.close();
        throw new LiteSshError('CACHE_WRITE_FAILED', 'The supplied cache handle identity could not be captured.', { cachePath: recorder.path, ...cleanup });
      }
    }
    return recorder.initializeHeader(identity, new Date(), 'test');
  }

  /** The factory retains cleanup ownership until its durable header succeeds. */
  private async initializeHeader(identity: TerminalIdentity, createdAt: Date, instance: string): Promise<ReadableRecorder> {
    try {
      this.enqueue(`${terminalHeaderLine(identity, createdAt, instance)}\n`);
      await this.flush();
      return this;
    } catch (error) {
      const cleanup = await this.close(); // Exact owned path/handle, never a sweep.
      const failure = error instanceof LiteSshError ? error : new LiteSshError('CACHE_WRITE_FAILED', 'Could not initialize the readable cache header.', { reason: reasonCode(error) });
      throw new LiteSshError(failure.code, failure.message, { ...failure.details, cachePath: this.path, ...cleanup });
    }
  }

  /** Allocate the next round id (`R1`, `R2`, ...) and open its cache range. */
  beginRound(): string {
    this.metadataBoundary(); // BEGIN marker always starts on a fresh physical row.
    this.roundCounter += 1;
    const id = `R${this.roundCounter}`;
    this.round = {
      id,
      beginMarker: roundBeginMarker(id),
      endMarker: roundEndMarker(id),
      outputCharacters: 0,
      preview: [],
      previewCharacters: 0,
    };
    this.enqueue(`${roundBeginLine(id)}\n`);
    this.enqueue(`${outputSectionLine(id)}\n`);
    return id;
  }

  /**
   * Mark the trusted shell BEGIN of the current round's command.
   *
   * The session reserves a round with `beginRound()` BEFORE sending a user
   * Enter submission, so any pre-execution echo (for example a bash syntax
   * error the parser rejects before a real BEGIN ever arrives) is already
   * cached inside the round. When the real, trusted BEGIN arrives this method
   * separates the two: it appends the `[SHELL COMMAND BEGIN]` metadata marker
   * (after a metadata boundary) and resets ONLY the in-memory summary of the
   * current round — its preview buffer and its code-point output count. The
   * round id, the file handle and the on-disk echo history are untouched, so a
   * normal result excludes the pre-execution echo while every visible echo
   * remains retrievable from the cache.
   *
   * If no round is open this only appends the metadata marker (there is nothing
   * to reset); it is never a substitute for `beginRound()`.
   */
  markCommandStarted(): void {
    this.metadataBoundary(); // BEGIN metadata owns its own physical line.
    this.enqueue(`${shellCommandBeginLine()}\n`);
    const round = this.round;
    if (round) {
      round.preview = [];
      round.previewCharacters = 0;
      round.outputCharacters = 0;
    }
  }

  /**
   * Append one readable output line. `wrapped === true` joins the next line with
   * no LF (soft wrap); an optional `newline: false` marks a partial final line.
   * Only the first physical line of a logical line carries the data prefix.
   */
  recordLine(line: ParsedLine): void {
    const text = escapeControl(line.text);
    const buffer: 'normal' | 'alternate' = line.buffer === 'alternate' ? 'alternate' : 'normal';
    const hardLine = line.newline === false ? false : !line.wrapped;
    const continuing = this.continuation && this.lastBuffer === buffer;
    const prefix = continuing ? '' : DATA_PREFIX[buffer];
    // `body` is exactly what the caller could read for this line: its text plus
    // the hard LF when present. Soft-wrapped and partial lines contribute no LF,
    // which is what makes the 1000-code-point boundary meaningful.
    const body = `${text}${hardLine ? '\n' : ''}`;
    this.enqueue(`${prefix}${body}`);
    this.continuation = !hardLine;
    this.lastBuffer = buffer;
    this.absorbOutput(body);
  }

  /** Append a readable screen frame with cursor, styles and dimensions. */
  recordFrame(screen: ScreenSnapshot, label?: string): void {
    this.metadataBoundary(); // A frame must never be glued onto an open data row.
    this.frameCounter += 1;
    const id = `F${this.frameCounter}`;
    const signature = screenSignature(screen);
    const duplicate = signature === this.lastFrameSignature;
    this.lastFrameSignature = signature;

    const lines = [describeScreen(screen, id, label, duplicate)];
    if (!duplicate) {
      const prefix = DATA_PREFIX[screen.buffer === 'alternate' ? 'alternate' : 'normal'];
      for (let row = 0; row < screen.lines.length; row += 1) {
        lines.push(`${prefix}[${row}] ${escapeControl(screen.lines[row] ?? '')}`);
      }
      for (const span of screen.styles) lines.push(styleLine(id, span));
    }
    this.enqueue(`${lines.join('\n')}\n`);
  }

  /**
   * Record one input step. ONLY the action kind and named key are written;
   * `text`/`paste` payloads are intentionally omitted so hidden input is never
   * mirrored into the cache.
   */
  recordStep(actions: InputAction[]): string {
    this.metadataBoundary(); // A step marker must never be glued onto an open data row.
    this.stepCounter += 1;
    const id = `S${this.stepCounter}`;
    const lines = [`${stepMarkerLine(id)} actions=${actions.length}`];
    actions.forEach((action, index) => {
      if (action.type === 'key') {
        lines.push(`${stepMarkerLine(id)} index=${index} type=key key=${sanitizeToken(action.key)}`);
      } else {
        lines.push(`${stepMarkerLine(id)} index=${index} type=${action.type}`);
      }
    });
    this.enqueue(`${lines.join('\n')}\n`);
    return id;
  }

  /**
   * Close the open round, wait for its queued writes to reach disk, and return
   * the bounded summary. A body over the preview limit is returned as
   * `output: null` / `outputOmitted: true`; the full readable history stays on
   * disk and is located by `cacheRange`.
   */
  async endRound(exitCode: number): Promise<RoundResult> {
    const round = this.round;
    if (!round) {
      throw new LiteSshError('ROUND_NOT_OPEN', 'No cache round is open; call beginRound before endRound.');
    }
    if (!Number.isInteger(exitCode)) {
      throw new LiteSshError('INVALID_EXIT_CODE', 'exitCode must be an integer.');
    }
    this.metadataBoundary(); // END marker must own its physical line.
    this.enqueue(`${roundEndLine(round.id, exitCode)}\n`);
    this.round = undefined;
    await this.flush(); // Result is only returned once the range is durable.

    const omitted = round.outputCharacters > PREVIEW_LIMIT_CHARACTERS;
    return {
      round: round.id,
      exitCode,
      outputCharacters: round.outputCharacters,
      output: omitted ? null : round.preview.join(''),
      outputOmitted: omitted,
      cacheRange: { beginMarker: round.beginMarker, endMarker: round.endMarker },
    };
  }

  /** Resolve once every enqueued write is on disk; rejects on `CACHE_WRITE_FAILED`. */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  /**
   * Drain, close the handle, then delete only this instance's exact path. A
   * failed delete is reported as `CACHE_DELETE_FAILED` (never as success) so the
   * retained, non-raw-readable file stays discoverable.
   */
  async close(options?: { remove?: boolean }): Promise<CloseResult> {
    if (this.closeResult) return this.closeResult;
    this.closed = true;
    const remove = options?.remove ?? true;
    let cleanupError: string | undefined;

    try {
      await this.queue.flush();
    } catch {
      /* Write failure was already surfaced by flush()/endRound() and on disk. */
    }
    let cacheRemoved = false;
    if (remove) {
      try {
        if (!this.objectIdentity) throw new LiteSshError('CACHE_DELETE_FAILED', 'No acquisition identity is available for safe removal.');
        // Keep the acquired descriptor alive during removal, preventing inode
        // reuse after closure. Windows deletion may pend until this FD closes.
        await unlinkOwnedFile(this.path, this.objectIdentity);
        cacheRemoved = true;
      } catch (error) {
        cleanupError = `CACHE_DELETE_FAILED ${reasonCode(error)}`;
      }
    }
    try {
      await this.handle.close();
    } catch (error) {
      cleanupError = `CACHE_WRITE_FAILED close:${reasonCode(error)}`;
    }

    this.closeResult = cleanupError === undefined ? { cacheRemoved } : { cacheRemoved, cleanupError };
    return this.closeResult;
  }

  /** Guard all post-close writes so a late callback cannot touch a closed handle. */
  private enqueue(text: string): void {
    if (this.closed) return;
    this.queue.enqueue(text);
  }

  /**
   * Terminate any open physical data row before a metadata marker is written,
   * then reset the data-prefix state so the next data line is prefixed again.
   *
   * The inserted LF is a *physical* row terminator for the on-disk log; it is
   * deliberately NOT fed to `absorbOutput`, so the logical output body and its
   * code-point count are unchanged. Pure stdout soft-wrap/partial concatenation
   * (with no metadata between the halves) still joins with no LF.
   */
  private metadataBoundary(): void {
    if (this.continuation) {
      this.enqueue('\n');
      this.continuation = false;
    }
  }

  /** Update the bounded round preview and the code-point output counter. */
  private absorbOutput(text: string): void {
    const round = this.round;
    if (!round) return; // Context before a round is still written; it is just unattributed.
    let index = 0;
    while (index < text.length) {
      const point = text.codePointAt(index) ?? 0;
      round.outputCharacters += 1;
      if (round.previewCharacters < PREVIEW_LIMIT_CHARACTERS) {
        round.preview.push(String.fromCodePoint(point));
        round.previewCharacters += 1;
      }
      index += point > 0xffff ? 2 : 1;
    }
  }
}
