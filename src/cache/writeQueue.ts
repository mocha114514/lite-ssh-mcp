/**
 * Bounded, ordered, asynchronous UTF-8 write queue for the terminal cache.
 *
 * HANDOVER / WHY THIS FILE EXISTS
 * -------------------------------
 * The recorder's event callbacks (`recordLine`, `recordFrame`, ...) are
 * synchronous and cannot `await`. They therefore *enqueue* UTF-8 buffers and a
 * single background drain writes them to one `FileHandle` in order.
 *
 * Guarantees:
 *   - Order is the enqueue order; round END is written after all of its body.
 *   - Pending bytes are bounded. Exceeding the budget (or a failing disk write)
 *     raises `CACHE_WRITE_FAILED`, appends one visible `[CACHE ERROR]` notice to
 *     disk and rejects every pending/`flush()` waiter. The file is never left
 *     silently short.
 *   - On a disk write failure the remaining backlog is discarded (and counted
 *     as dropped), and *every* waiter is rejected, so `flush()`/`close()` can
 *     never hang on a stuck queue during shutdown.
 *   - Partial writes are handled with a loop until the whole buffer is written.
 *   - `flush()` resolves only once every previously enqueued buffer is on disk
 *     (and, after a failure, once the error notice has been written).
 */

import type { FileHandle } from 'node:fs/promises';
import { LiteSshError } from '../core/errors.js';
import { CACHE_ERROR_LINE } from './prefixes.js';
import { reasonCode } from './format.js';

interface FlushWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Write a whole buffer, tolerating partial `handle.write` completions. */
export async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error('cache write made no progress');
    offset += bytesWritten;
  }
}

export class BoundedWriteQueue {
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private writing = false;
  private failure?: LiteSshError;
  /** True while the one-shot `[CACHE ERROR]` notice still needs writing. */
  private noticePending = false;
  private droppedChunks = 0;
  private droppedBytes = 0;
  /** Whether the last successful write ended exactly at a line boundary. */
  private atLineStart = true;
  private waiters: FlushWaiter[] = [];

  constructor(private readonly handle: FileHandle, private readonly maxPendingBytes: number) {}

  /** The sticky failure, if any; once set the queue accepts no further data. */
  get failed(): LiteSshError | undefined {
    return this.failure;
  }

  /**
   * Queue one chunk. Never throws: a synchronous callback cannot surface a
   * rejection, so failures are sticky and reported through `flush()`/`failed`
   * and the on-disk notice instead of being dropped silently.
   */
  enqueue(text: string): void {
    if (this.failure) {
      // Already failed: drop but account for it so the notice/flush detail is honest.
      this.droppedChunks += 1;
      this.droppedBytes += Buffer.byteLength(text, 'utf8');
      return;
    }
    const buffer = Buffer.from(text, 'utf8');
    if (this.pendingBytes + buffer.length > this.maxPendingBytes) {
      this.droppedChunks += 1;
      this.droppedBytes += buffer.length;
      this.setFailure(
        new LiteSshError(
          'CACHE_WRITE_FAILED',
          'The cache write backlog exceeded its bounded byte budget; readable history may be incomplete.',
          { pendingBytes: this.pendingBytes, chunkBytes: buffer.length, budgetBytes: this.maxPendingBytes },
        ),
      );
      return;
    }
    this.pending.push(buffer);
    this.pendingBytes += buffer.length;
    void this.drain();
  }

  /** Resolve after all currently queued data (and any error notice) is on disk. */
  flush(): Promise<void> {
    if (!this.writing && this.pending.length === 0 && !this.noticePending) {
      return this.failure ? Promise.reject(this.describeFailure()) : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      void this.drain();
    });
  }

  /** Attach the honest dropped-byte accounting to the sticky failure. */
  private describeFailure(): LiteSshError {
    const failure = this.failure!;
    failure.details.droppedChunks = this.droppedChunks;
    failure.details.droppedBytes = this.droppedBytes;
    return failure;
  }

  private setFailure(error: LiteSshError): void {
    if (!this.failure) {
      this.failure = error;
      this.noticePending = true;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.writing) return; // An in-flight drain will pick up new work.
    this.writing = true;
    try {
      // Never write past a failure; a failed buffer means the log is already
      // incomplete and any remaining backlog must be discarded, not retried.
      while (this.pending.length && !this.failure) {
        const buffer = this.pending.shift()!;
        this.pendingBytes -= buffer.length;
        try {
          await writeAll(this.handle, buffer);
          this.atLineStart = buffer.length > 0 && buffer[buffer.length - 1] === 0x0a;
        } catch (error) {
          // Account for the buffer that failed, then discard the rest of the
          // backlog so `settle()` can reject every waiter instead of hanging on
          // a non-empty queue forever (which would hang `close()`/shutdown).
          this.droppedChunks += 1;
          this.droppedBytes += buffer.length;
          this.discardPending();
          this.atLineStart = false; // A partial write may have left the row open.
          this.setFailure(
            new LiteSshError('CACHE_WRITE_FAILED', 'A cache write to disk failed; readable history may be incomplete.', {
              reason: reasonCode(error),
            }),
          );
          break;
        }
      }
      if (this.failure && this.noticePending) {
        this.noticePending = false;
        // The failure notice is metadata: give it its own physical line instead
        // of gluing it to a half-written data row.
        const notice =
          `${this.atLineStart ? '' : '\n'}${CACHE_ERROR_LINE} ${this.failure.code}` +
          ` dropped_chunks=${this.droppedChunks} dropped_bytes=${this.droppedBytes}\n`;
        try {
          await writeAll(this.handle, Buffer.from(notice, 'utf8'));
        } catch {
          /* Best effort: the failure itself is still reported to waiters. */
        }
      }
    } finally {
      this.writing = false;
      this.settle();
    }
  }

  /** Drop everything still queued, counting it as honestly lost. */
  private discardPending(): void {
    while (this.pending.length) {
      const buffer = this.pending.shift()!;
      this.pendingBytes -= buffer.length;
      this.droppedChunks += 1;
      this.droppedBytes += buffer.length;
    }
  }

  private settle(): void {
    if (this.writing) return;
    // A failure always settles: discard any stragglers so a non-empty backlog
    // can never block the rejection of an already-awaited `flush()`.
    if (this.failure) this.discardPending();
    if (!this.failure && (this.pending.length || this.noticePending)) return;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      if (this.failure) waiter.reject(this.describeFailure());
      else waiter.resolve();
    }
  }
}
