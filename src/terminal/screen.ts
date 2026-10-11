/**
 * ScreenModel wraps a headless xterm.js terminal into the small, JSON-friendly
 * surface the MCP layer needs. It owns four responsibilities, kept deliberately
 * separate so the module stays focused:
 *
 *  1. Parse remote output into a readable screen (snapshot) with styles/modes.
 *  2. Turn the readable stream into {@link ParsedLine} records that never lose
 *     output to scrollback eviction (including one enormous wrapped line).
 *  3. Decode lite-ssh OSC 777 markers and surface them through `onMarker`.
 *  4. Forward terminal-generated replies (DA/DSR/... queries) via `onReply`.
 *
 * No raw bytes are persisted anywhere; byte input is handed straight to xterm
 * and only parsed, readable records escape this class.
 *
 * ## Capturing destructive transitions
 * Switching to/from the alternate screen (private modes 47/1047/1049) discards
 * the alternate buffer's content, so flushing "the cursor row" *after* the
 * switch reads the wrong buffer and loses text. Instead a public
 * `parser.registerCsiHandler` (returning `false` so xterm's own handling still
 * runs) captures the *old* screen before the switch: it flushes every pending
 * row of the outgoing logical line through `onLine` and reports the outgoing
 * frame (text, styles, cursor) through `onFrame`.
 *
 * Two more destructive transitions get the same treatment, all through public
 * API and independent of how the bytes are chunked:
 *
 *  - Erase (`CSI ... J` / `CSI ... K`) discards cells, so the readable line is
 *    flushed and the pre-erase frame is reported before the erase runs.
 *  - A carriage return or backspace that rewrites the current row (a CR that is
 *    NOT part of a CRLF) would overwrite text still pending in the readable
 *    line. `write()` splits the transaction at those C0 bytes and flushes the
 *    pending line before feeding the control, preserving the old text without
 *    ever treating it as a logical newline. A CR immediately followed by LF is
 *    a normal line ending and is left intact.
 *
 * ## Revision semantics
 * `ScreenSnapshot.revision` identifies the observable screen state, not the
 * number of `write()` calls. It advances only when the public snapshot
 * (cols/rows/buffer/cursor/lines/styles/modes) actually differs, so control-only
 * input, a split/partial OSC sequence or a non-visible cursor update leaves it
 * unchanged and a reader is not told "the screen was updated". Shell-marker
 * callbacks (`onMarker`) and readable-line callbacks (`onLine`) fire on their
 * own and are intentionally not tied to the revision.
 *
 * ## ParsedLine.wrapped semantics
 * `wrapped: false` marks a text record whose logical line really ended (LF, or
 * the very last row of a completed line): the consumer may append a line break.
 * `wrapped: true` marks a continuation fragment — a soft-wrapped row or an
 * explicit `flushLine()` of a not-yet-terminated line. The fragment carries no
 * line break, so the consumer must join it to the following record. `text`
 * never contains an LF. Every record also sets the optional `newline` flag
 * explicitly (`newline === !wrapped`): the writer can append a break exactly
 * when `newline` is true, and a partial flush is a plain `newline: false`
 * record rather than something the caller has to infer or cast.
 *
 * ## Capture strategy: read before eviction
 * xterm's scrollback is finite and trims old rows, so two things that are easy
 * to rely on are actually unsafe and are NOT used here: a stale absolute row
 * index (it comes to mean a different row) and a row-index-keyed dedup (it then
 * drops or repeats text).
 *
 *  - `onLineFeed` fires once per LF. It emits one logical line: soft-wrapped
 *    continuation rows as `wrapped: true` fragments followed by the terminating
 *    row as `wrapped: false`. This is exact even across thousands of lines in a
 *    single packet.
 *  - `registerEscHandler` catches non-LF newlines and indexing: NEL (`ESC E`)
 *    and IND (`ESC D`). xterm does not fire `onLineFeed` for these escape
 *    sequences; without synchronous interception, high-volume batches (e.g. 300
 *    NEL lines in a single write) scroll into scrollback uncaptured, losing
 *    history on eviction and reporting 0 output characters. Capturing the row
 *    before xterm executes the sequence guarantees log integrity across
 *    arbitrary batching and chunking.
 *  - `onScroll` also fires as a still-growing line pushes rows off the top (a
 *    soft wrap with no LF). When the cursor row is a wrapped continuation, the
 *    complete rows above it are emitted as continuations before trimming can
 *    reach them.
 *
 * Dedup compares rows by a *stable sequence* (`rowIndex + evictedRows`), which
 * is unchanged when earlier rows are trimmed, so a 30000-character line that
 * overflows the scrollback many times is still emitted exactly once. No column
 * arithmetic is used, so wide/combining characters are counted correctly. The
 * eviction count itself is exact (each `onScroll` creates exactly one row), and
 * never stores the full command; only the bounded xterm scrollback is read.
 * Together these fold every readable row into `onLine` without ever returning
 * "just the last screen".
 */
import headless from '@xterm/headless';
import type {
  IBuffer,
  IBufferCell,
  IBufferLine,
  IDisposable,
  Terminal as XtermTerminal,
} from '@xterm/headless';
import { LiteSshError } from '../core/errors.js';
import type {
  CellStyle,
  ParsedLine,
  ScreenModes,
  ScreenOptions,
  ScreenSnapshot,
  ShellMarker,
  StyleSpan,
} from '../core/types.js';
import { MARKER_NAMESPACE, MARKER_OSC_ID, parseMarker } from '../shell/protocol.js';

type BufferType = 'normal' | 'alternate';

/**
 * Per-buffer capture bookkeeping. It is deliberately free of absolute row
 * indices, because scrollback trimming shifts them: a stored row index can come
 * to mean a different row and wrongly drop or repeat text, and counting columns
 * per evicted row is wrong for wide/combining characters. Instead each row is
 * given a *stable sequence* (`bufferRowIndex + evictedRows`) that is invariant
 * under trimming, so dedup compares row identity, never character counts.
 */
interface CaptureCursor {
  /**
   * Stable sequence of the last row of the current logical line already emitted,
   * or -1 when nothing of the line has been emitted. Because a row's sequence is
   * unchanged when earlier rows are trimmed, it identifies the same physical row
   * across arbitrary eviction.
   */
  emittedSeq: number;
  /** Bounded readable row prefix; detects implicit overwrite after reflow. */
  emittedText: string;
  /** At most the visible row count; permits backward addressing without duplicates. */
  addressedRows: Map<number, string>;
}

function newCursor(): CaptureCursor {
  return { emittedSeq: -1, emittedText: '', addressedRows: new Map() };
}

/** Do not split a newly changed surrogate pair at a shared high surrogate. */
function commonReadablePrefix(previous: string, current: string): number {
  let index = 0;
  const limit = Math.min(previous.length, current.length);
  while (index < limit && previous.charCodeAt(index) === current.charCodeAt(index)) index++;
  if (index > 0) {
    const last = current.charCodeAt(index - 1);
    if (last >= 0xd800 && last <= 0xdbff) index--;
  }
  return index;
}

export class ScreenModel {
  private readonly nonce: string;
  private readonly onLine?: (line: ParsedLine) => void;
  private readonly onMarker?: (marker: ShellMarker) => void;
  private readonly onFrame?: (screen: ScreenSnapshot, label?: string) => void;
  private readonly onReply?: (data: string) => void;
  private readonly terminal: XtermTerminal;
  private readonly disposables: IDisposable[] = [];
  private readonly cursors: Record<BufferType, CaptureCursor> = {
    normal: newCursor(),
    alternate: newCursor(),
  };
  /**
   * Number of `onScroll` events seen per buffer. Each scroll creates exactly one
   * row, so with a recorded baseline `evicted = baseLength + (scrolled - baseScrolled) - length`
   * is the exact number of rows evicted from the front. Row sequences built from
   * it stay stable across scrollback trimming without any column arithmetic.
   */
  private readonly scrolled: Record<BufferType, number> = { normal: 0, alternate: 0 };
  /** Scroll count and buffer length captured when eviction counting restarted. */
  private readonly evictBaseScrolled: Record<BufferType, number> = { normal: 0, alternate: 0 };
  private readonly evictBaseLength: Record<BufferType, number> = { normal: 0, alternate: 0 };
  /**
   * A trailing CR is applied immediately. Only deciding whether its history
   * boundary is a CRLF or an overwrite waits for the next received byte.
   */
  private pendingCr = false;
  /** One bounded readable-state checkpoint per buffer. CR/BS have captured
   * the old cells, but only a witnessed rewrite invalidates their prefix. */
  private readonly rewriteCheckpoints: Partial<Record<BufferType, { baseY: number; x: number; y: number; lines: string[] }>> = {};
  private rewriteControlOnly = false;
  /**
   * Buffer switches make xterm emit a spurious `onScroll` (position 0) that adds
   * no row; counting it would fake an eviction. Each captured switch arms one
   * expected spurious scroll, which `onScroll` then ignores.
   */
  private pendingSwitchScrolls = 0;
  private revision = 0;
  /**
   * Serialized public state (everything in a snapshot except `revision`) as of
   * the last time `revision` was incremented. `revision` only advances when this
   * key changes, so control-only input, split OSC sequences or hidden cursor
   * updates do not make the session claim the screen was updated.
   */
  private renderKey = '';
  private disposed = false;

  constructor(options: ScreenOptions) {
    this.nonce = options.nonce;
    this.onLine = options.onLine;
    this.onMarker = options.onMarker;
    this.onFrame = options.onFrame;
    this.onReply = options.onReply;
    this.terminal = new headless.Terminal({
      // buffer/parser/modes are proposed API but stable in headless xterm.
      allowProposedApi: true,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });
    // Capture the old screen before a private-mode buffer switch; returning
    // false lets xterm's default handler perform the switch itself.
    const altScreenSwitch = (final: 'h' | 'l') =>
      this.terminal.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        if (hasAltScreenMode(params)) this.captureBeforeSwitch(final === 'h');
        return false;
      });
    // Capture the readable line before an erase discards it (ED/EL); again
    // returning false so xterm still performs the erase.
    const eraseCapture = (final: 'J' | 'K') =>
      this.terminal.parser.registerCsiHandler({ final }, () => this.captureBeforeErase(final));
    this.disposables.push(
      this.terminal.parser.registerOscHandler(MARKER_OSC_ID, (data) => this.handleOsc(data)),
      altScreenSwitch('h'),
      altScreenSwitch('l'),
      eraseCapture('J'),
      eraseCapture('K'),
      this.terminal.parser.registerEscHandler({ final: 'c' }, () => this.captureBeforeReset()),
      this.terminal.parser.registerEscHandler({ final: '8' }, () => {
        this.rewriteControlOnly = true;
        this.flushLine();
        this.onFrame?.(this.buildSnapshot(), 'cursor-restore');
        this.preserveAddressedRows(this.terminal.buffer.active);
        return false;
      }),
      // NEL (Next Line, ESC E): Moves cursor to column 0 of next line (and scrolls if at bottom).
      // Unlike LF, xterm does not fire onLineFeed for ESC E. Capture the completed line
      // synchronously before xterm's native handler advances or scrolls the buffer, so
      // lines are not lost to scrollback eviction and log integrity is preserved.
      this.terminal.parser.registerEscHandler({ final: 'E' }, () => {
        if (this.disposed) return false;
        this.rewriteControlOnly = true;
        const buffer = this.terminal.buffer.active;
        this.captureUpTo(buffer.baseY + buffer.cursorY, true);
        return false;
      }),
      // IND (Index, ESC D): Moves cursor down one row in same column (and scrolls if at bottom).
      // Synchronously capture the completed row so non-LF indexing does not drop output.
      this.terminal.parser.registerEscHandler({ final: 'D' }, () => {
        if (this.disposed) return false;
        this.rewriteControlOnly = true;
        const buffer = this.terminal.buffer.active;
        this.captureUpTo(buffer.baseY + buffer.cursorY, true);
        return false;
      }),
      // Cursor addressing can replace cells without CR/BS or erase. Preserve
      // the chronological text/styles before xterm moves the write position.
      ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'f', 'd', 'u', 'L', 'M', 'S', 'T', 'X', 'P', '@'].map(final =>
        this.terminal.parser.registerCsiHandler({ final }, (params) => {
          this.rewriteControlOnly = true;
          this.flushLine();
          this.onFrame?.(this.buildSnapshot(), 'cursor-address');
          const buffer = this.terminal.buffer.active;
          if (['X', 'P', '@'].includes(final)) {
            // Character edits over unused padding do not change body identity.
            // Printed spaces and either half of a wide glyph are occupied cells.
            if (this.characterEditTouchesText(buffer, final, params)) this.forgetEmitted(buffer);
          } else if (['L', 'M', 'S', 'T'].includes(final)) this.forgetEmitted(buffer);
          else this.preserveAddressedRows(buffer);
          return false;
        })),
      this.terminal.buffer.onBufferChange(buffer => {
        if (buffer.type !== 'alternate') return;
        // The alternate buffer is allocated on its first activation, not at
        // construction. Its actual populated length is the eviction baseline.
        this.evictBaseScrolled.alternate = this.scrolled.alternate;
        this.evictBaseLength.alternate = buffer.length;
        this.cursors.alternate = newCursor();
        delete this.rewriteCheckpoints.alternate;
      }),
      this.terminal.onData((data) => {
        // Terminal-generated replies (DA1, DSR, ...) must not block parsing.
        this.onReply?.(data);
      }),
      this.terminal.onLineFeed(() => this.onLineFeed()),
      this.terminal.onScroll(() => this.onScroll()),
    );
    // Eviction counting starts here: at construction the buffers hold exactly
    // their initial rows, so this baseline makes `evictedRows` zero.
    this.evictBaseLength.normal = this.terminal.buffer.normal.length;
    this.evictBaseLength.alternate = this.terminal.buffer.alternate.length;
    // Seed the key with the empty initial screen so the first visible write (or
    // resize) is the first thing that advances the revision.
    this.renderKey = renderKeyOf(this.buildSnapshot());
  }

  /**
   * Feeds bytes or text to the emulator and resolves after xterm has parsed
   * them. The snapshot's `revision` advances only when the visible/state
   * snapshot actually changes; marker/line callbacks fire independently of it.
   *
   * The transaction is split at destructive CR/BS bytes so the readable line is
   * captured before the cursor rewrite, without depending on packet boundaries.
   * After such a split the rewritten row is flushed too, so both the overwritten
   * text and the final readable state are recorded (never as a logical newline).
   */
  async write(data: string | Uint8Array): Promise<ScreenSnapshot> {
    this.assertLive();
    // A trailing CR was already applied to the emulator. Only its history
    // classification waits: CRLF is one hard newline, a lone CR may overwrite.
    let destructive = false;
    if (this.pendingCr && data.length > 0) {
      this.pendingCr = false;
      const first = typeof data === 'string' ? data.charCodeAt(0) : data[0];
      if (first !== C0_LF) { this.flushBeforeOverwrite(); destructive = true; }
    }
    const trailing = takeTrailingCr(data);
    const body = trailing.body;
    for (const part of splitAtDestructive(body)) {
      if (startsDestructive(part)) {
        this.flushBeforeOverwrite();
        destructive = true;
      }
      await this.writeChunk(part, startsDestructive(part));
    }
    if (destructive) this.flushLine();
    if (trailing.pending) {
      await this.writeChunk(typeof data === 'string' ? '\r' : new Uint8Array([C0_CR]));
      this.pendingCr = true;
    }
    this.pendingSwitchScrolls = 0;
    return this.refresh();
  }

  /** Writes one already-split chunk and resolves when xterm has parsed it. */
  private writeChunk(data: string | Uint8Array, controlOnly = false): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (bytes.length === 0) return Promise.resolve();
    // Only a clean CR/BS checkpoint needs native callbacks between bytes.
    // Ordinary streams and the suffix after a witnessed rewrite stay batched.
    if (this.rewriteCheckpoints.normal || this.rewriteCheckpoints.alternate) {
      return this.writeWithRewriteCheckpoint(bytes, controlOnly);
    }
    const size = Math.max(1, this.terminal.cols);
    return new Promise<void>((resolve, reject) => {
      for (let offset = 0; offset < bytes.length; offset += size) {
        const end = Math.min(offset + size, bytes.length);
        this.terminal.write(bytes.subarray(offset, end), () => {
          try {
            if (this.terminal.buffer.active.type === 'alternate') this.flushLine();
            if (end === bytes.length) resolve();
          } catch (error) { reject(error); }
        });
      }
    });
  }

  /** Current readable screen. Never advances the revision by itself. */
  snapshot(): ScreenSnapshot {
    this.assertLive();
    return this.buildSnapshot();
  }

  /** Resizes the local emulator; the main loop mirrors this to the remote PTY. */
  resize(cols: number, rows: number): ScreenSnapshot {
    this.assertLive();
    // Capture pending cells and their styled frame before reflow/trim. Seed the
    // new cursor at the reflowed prefix so later appends do not repeat history.
    this.flushLine();
    this.onFrame?.(this.buildSnapshot(), 'before-resize');
    this.terminal.resize(cols, rows);
    for (const type of ['normal', 'alternate'] as const) {
      const buffer = type === 'normal' ? this.terminal.buffer.normal : this.terminal.buffer.alternate;
      this.evictBaseScrolled[type] = this.scrolled[type];
      this.evictBaseLength[type] = buffer.length;
      this.cursors[type] = newCursor();
      const row = buffer.baseY + buffer.cursorY;
      const line = buffer.getLine(row);
      if (line) {
        this.cursors[type].emittedSeq = row;
        this.cursors[type].emittedText = readableRow(line, this.terminal.cols, buffer.getNullCell());
      }
    }
    return this.refresh();
  }

  /**
   * Builds the current public snapshot. `revision` is only ever set here
   * (and by {@link refresh}); callers that want to know whether the visible
   * state changed compare {@link renderKeyOf} of two snapshots.
   */
  private buildSnapshot(): ScreenSnapshot {
    const buffer = this.terminal.buffer.active;
    const nullCell = buffer.getNullCell();
    const lines: string[] = [];
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row);
      lines.push(line ? readableRow(line, this.terminal.cols, nullCell) : '');
    }
    return {
      revision: this.revision,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      buffer: buffer.type,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      lines,
      styles: this.collectStyles(buffer),
      modes: this.collectModes(),
    };
  }

  /**
   * Returns a snapshot, advancing `revision` only if the visible/state content
   * (cols/rows/buffer/cursor/lines/styles/modes) differs from the last bump.
   */
  private refresh(): ScreenSnapshot {
    const snapshot = this.buildSnapshot();
    const key = renderKeyOf(snapshot);
    if (key !== this.renderKey) {
      this.renderKey = key;
      this.revision += 1;
      snapshot.revision = this.revision;
    }
    return snapshot;
  }

  /**
   * Emits every not-yet-emitted row of the in-progress logical line (including
   * the partial cursor row), so a long soft-wrapped line with no LF is not
   * reduced to its last visible row. The fragment carries no line break
   * (`wrapped: true`) and joins to whatever follows. Used before an END marker,
   * before an erase/alt switch, and at the end of a destructive write.
   */
  flushLine(): void {
    if (this.disposed) return;
    const buffer = this.terminal.buffer.active;
    this.captureUpTo(buffer.baseY + buffer.cursorY, false);
  }

  /**
   * Like {@link flushLine}, but forgets the emitted prefix afterwards because a
   * CR/BS is about to overwrite the current row; the overwritten text is thus
   * never treated as a prefix of the replacement.
   */
  private flushBeforeOverwrite(): void {
    if (this.disposed) return;
    const buffer = this.terminal.buffer.active;
    this.captureUpTo(buffer.baseY + buffer.cursorY, false);
    this.rewriteCheckpoints[buffer.type] = this.rewriteState();
  }

  /** Releases the emulator and all listeners. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.terminal.dispose();
  }

  /**
   * LF handler: the logical line ending one row above the cursor is complete, so
   * it is emitted with the final row as the terminating record; the cursor's new
   * row then starts a fresh logical line.
   */
  private onLineFeed(): void {
    if (this.disposed) return;
    const buffer = this.terminal.buffer.active;
    this.captureUpTo(buffer.baseY + buffer.cursorY - 1, true);
  }

  /**
   * Scroll handler: a soft wrap (no LF) leaves the cursor row marked `isWrapped`,
   * so every row above it is complete and may be evicted at any moment. They are
   * emitted as continuations before trimming can reach them. (LF and NEL/IND
   * newlines are handled synchronously by their respective linefeed/escape
   * handlers, ensuring no duplicate lines or missed rows during scrolling).
   */
  private onScroll(): void {
    if (this.disposed) return;
    const buffer = this.terminal.buffer.active;
    if (this.pendingSwitchScrolls > 0) {
      // A buffer switch just happened and this scroll did not add a row.
      this.pendingSwitchScrolls -= 1;
      return;
    }
    this.scrolled[buffer.type] += 1;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (buffer.getLine(cursorRow)?.isWrapped !== true) return;
    this.captureUpTo(cursorRow - 1, false);
  }

  /**
   * Emits every not-yet-emitted row of the logical line ending at `endRow`
   * (inclusive). `terminating` true marks a real line ending (the last row is
   * emitted `wrapped:false`); false emits continuations only and remembers the
   * line as still in progress.
   *
   * Dedup compares the *stable row sequence* of each row (`row + evictedRows`),
   * never a character count, so it is exact for wide, combining and surrogate
   * characters and stays correct after scrollback trimming. A row already emitted
   * in full is skipped; the last partially emitted row contributes only its new
   * suffix via `emittedChars`.
   */
  private captureUpTo(endRow: number, terminating: boolean): void {
    if (this.disposed) return;
    const buffer = this.terminal.buffer.active;
    const cursor = this.cursors[buffer.type];
    if (endRow < 0) {
      this.forgetEmitted(buffer);
      return;
    }
    // Walk back over continuation rows (isWrapped marks "wrapped from above").
    let start = endRow;
    while (start > 0) {
      const line = buffer.getLine(start);
      if (!line || !line.isWrapped) break;
      start -= 1;
    }
    const evicted = this.evictedRows(buffer);
    const nullCell = buffer.getNullCell();
    let head = '';
    let tail: string | null = null;
    let seenSeq = -1;
    let seenText = '';
    for (let row = start; row <= endRow; row += 1) {
      const seq = row + evicted;
      if (seq < cursor.emittedSeq && !cursor.addressedRows.has(seq)) continue; // No addressed-row mutation to inspect.
      const line = buffer.getLine(row);
      const text = line ? readableRow(line, this.terminal.cols, nullCell) : '';
      // A narrowing resize can clamp the insertion cursor inside old cells.
      // Length-only dedup would discard their replacement glyph. Compare the
      // actual readable prefix, keeping unchanged cells but emitting mutations.
      const addressed = cursor.addressedRows.get(seq);
      const previous = addressed ?? (seq === cursor.emittedSeq ? cursor.emittedText : undefined);
      const prefix = previous === undefined ? 0 : commonReadablePrefix(previous, text);
      const chunk = text.slice(prefix);
      if (addressed !== undefined) cursor.addressedRows.set(seq, text);
      seenSeq = seq;
      seenText = text;
      if (terminating && row === endRow) tail = chunk;
      else head += chunk;
    }
    if (head.length > 0) this.emitLine(head, true, buffer.type);
    if (terminating) {
      this.emitLine(tail ?? '', false, buffer.type);
      cursor.emittedSeq = -1;
      cursor.emittedText = '';
      // LF is not an overwrite: keep bounded addressed-row baselines so moving
      // back to unchanged older cells cannot repeat their body after this LF.
    } else if (seenSeq >= 0) {
      cursor.emittedSeq = seenSeq;
      cursor.emittedText = seenText;
    }
  }

  /**
   * Number of rows evicted from the front of `buffer`'s scrollback, from the
   * exact row count (`baseLength + rows-created - surviving length`). Each
   * `onScroll` creates exactly one row, so no per-row column estimate is needed.
   */
  private evictedRows(buffer: IBuffer): number {
    const type = buffer.type;
    const created = this.scrolled[type] - this.evictBaseScrolled[type];
    return Math.max(0, this.evictBaseLength[type] + created - buffer.length);
  }

  private rewriteState(): { baseY: number; x: number; y: number; lines: string[] } {
    const buffer = this.terminal.buffer.active;
    return { baseY: buffer.baseY, x: buffer.cursorX, y: buffer.cursorY, lines: this.buildSnapshot().lines };
  }

  /** Keep the old prefix until a native cursor/cell change witnesses rewriting.
   * A witness is sticky: restoring the cursor later cannot hide those glyphs.
   * Public cursor controls update the clean baseline without inventing output. */
  private async writeWithRewriteCheckpoint(bytes: Uint8Array, controlOnly: boolean): Promise<void> {
    const captureSize = Math.max(1, this.terminal.cols);
    for (let offset = 0; offset < bytes.length; offset++) {
      if (!this.rewriteCheckpoints.normal && !this.rewriteCheckpoints.alternate) {
        await this.writeChunk(bytes.subarray(offset));
        return;
      }
      this.rewriteControlOnly = controlOnly || bytes[offset]! < 32 || bytes[offset] === 127;
      await new Promise<void>((resolve, reject) => {
        this.terminal.write(bytes.subarray(offset, offset + 1), () => {
          try {
            const buffer = this.terminal.buffer.active;
            const before = this.rewriteCheckpoints[buffer.type];
            if (before) {
              const after = this.rewriteState();
              if (this.rewriteControlOnly) this.rewriteCheckpoints[buffer.type] = after;
              else if (before.baseY !== after.baseY || before.x !== after.x || before.y !== after.y ||
                  before.lines.length !== after.lines.length || after.lines.some((line, row) => line !== before.lines[row])) {
                this.forgetEmitted(buffer);
              }
            }
            // Observation bytes are not new body-capture boundaries: the
            // first rewrite can still leave old suffix cells in this row.
            // Match the ordinary bounded write pieces, including while a
            // normal checkpoint remains dormant. Retain pre-eviction capture.
            if (buffer.type === 'alternate' &&
                ((offset + 1) % captureSize === 0 || offset + 1 === bytes.length)) this.flushLine();
            resolve();
          } catch (error) { reject(error); }
        });
      });
    }
  }

  /** RIS replaces both native buffers. Capture the outgoing readable state
   * before reset, then discard prefix identities from those discarded cells.
   * Returning false preserves xterm's native reset and mode/style handling. */
  private captureBeforeReset(): boolean {
    if (this.disposed) return false;
    this.flushLine();
    this.onFrame?.(this.buildSnapshot(), 'reset');
    this.cursors.normal = newCursor();
    this.cursors.alternate = newCursor();
    delete this.rewriteCheckpoints.normal;
    delete this.rewriteCheckpoints.alternate;
    return false;
  }

  /** ECH changes only its count range; DCH/ICH shift the remaining row. Use
   * public cell occupancy, not trimmed text length or Unicode/column arithmetic. */
  private characterEditTouchesText(buffer: IBuffer, final: string, params: readonly (number | number[])[]): boolean {
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (!line) return false;
    const column = Math.min(buffer.cursorX, this.terminal.cols - 1);
    const first = params[0];
    const rawCount = Array.isArray(first) ? first[0] : first;
    const count = typeof rawCount === 'number' ? Math.max(1, rawCount) : 1;
    const end = final === 'X' ? Math.min(this.terminal.cols, column + count) : this.terminal.cols;
    // Erasing a continuation can erase the wide character that owns it.
    const start = column > 0 && line.getCell(column)?.getWidth() === 0 &&
      line.getCell(column - 1)?.getWidth() === 2 ? column - 1 : column;
    for (let col = start; col < end; col++) {
      if (line.getCell(col)?.getChars()) return true;
    }
    return false;
  }

  /** Public cursor coordinates may address any visible row, including an older
   * one. Seed only already-emitted rows before xterm moves; no CSI arithmetic,
   * origin-mode guesses, private API, or unbounded whole-buffer history. */
  private preserveAddressedRows(buffer: IBuffer): void {
    const cursor = this.cursors[buffer.type];
    const previous = cursor.addressedRows;
    const retained = new Map<number, string>();
    const evicted = this.evictedRows(buffer);
    const cell = buffer.getNullCell();
    const end = Math.min(buffer.length, buffer.baseY + this.terminal.rows);
    for (let row = buffer.baseY; row < end; row++) {
      const seq = row + evicted;
      if (seq > cursor.emittedSeq && !previous.has(seq)) continue;
      const line = buffer.getLine(row);
      if (line) retained.set(seq, readableRow(line, this.terminal.cols, cell));
    }
    cursor.addressedRows = retained;
  }

  /** Marks the current logical line as fully un-emitted (fresh identity). */
  private forgetEmitted(buffer: IBuffer): void {
    const cursor = this.cursors[buffer.type];
    cursor.emittedSeq = -1;
    cursor.emittedText = '';
    cursor.addressedRows.clear();
    delete this.rewriteCheckpoints[buffer.type];
  }

  /**
   * Captures the outgoing screen immediately before a destructive private-mode
   * switch: flush the in-progress readable line of the OLD buffer, report the
   * OLD frame (text/styles/cursor) through `onFrame`.
   *
   * The alternate buffer is always either about to be cleared (entering) or
   * discarded (leaving), so its partial bookkeeping is reset; the normal buffer
   * is preserved by xterm, so its dedup state is kept and a restored in-progress
   * line is not re-emitted when its command later completes.
   */
  private captureBeforeSwitch(enteringAlternate: boolean): void {
    this.rewriteControlOnly = true;
    if (this.disposed) return;
    if ((this.terminal.buffer.active.type === 'alternate') === enteringAlternate) return;
    this.flushLine();
    this.onFrame?.(this.buildSnapshot(), enteringAlternate ? 'alt-enter' : 'alt-exit');
    this.cursors.alternate = newCursor();
    // The outgoing ALT cells are captured above and then discarded. Their
    // checkpoint must not force future normal output into bytewise parsing;
    // the normal checkpoint still belongs to its preserved native buffer.
    delete this.rewriteCheckpoints.alternate;
    this.pendingSwitchScrolls += 1;
  }

  /**
   * Captures the readable line and screen immediately before an erase (ED/EL,
   * `CSI ... J`/`K`). Always returns false so xterm's own erase still runs; this
   * only preserves what the erase is about to discard.
   *
   * The dedup state is forgotten afterwards because the erase discards the grid:
   * text written into the same cells later (e.g. `abc` + `CSI 2J` + home + `abc`)
   * is genuinely new output and must be emitted, not deduplicated against the
   * pre-erase prefix.
   */
  private captureBeforeErase(final: 'J' | 'K'): boolean {
    if (this.disposed) return false;
    const buffer = this.terminal.buffer.active;
    this.flushLine();
    this.forgetEmitted(buffer);
    this.onFrame?.(this.buildSnapshot(), final === 'J' ? 'erase-j' : 'erase-k');
    return false;
  }

  private emitLine(text: string, wrapped: boolean, buffer: BufferType): void {
    // `wrapped` and `newline` are complementary: a continuation fragment must
    // be joined (no break), a terminating record carries the line break. The
    // explicit `newline` lets the readable-cache writer avoid re-deriving it.
    this.onLine?.({ text, buffer, wrapped, newline: !wrapped });
  }

  /** Decodes one OSC 777 payload. Returns true to consume the sequence. */
  private handleOsc(data: string): boolean {
    if (!data.startsWith(`${MARKER_NAMESPACE};`)) return false;
    const marker = parseMarker(data, this.nonce);
    if (!marker) return true;
    // BEGIN separates pre-execution prompt/echo from the command summary; END
    // closes it. Flush the visible prefix before either metadata transition.
    if (marker.kind === 'begin' || marker.kind === 'end') this.flushLine();
    this.onMarker?.(marker);
    return true;
  }

  private collectModes(): ScreenModes {
    const modes = this.terminal.modes;
    return {
      bracketedPaste: modes.bracketedPasteMode,
      applicationCursorKeys: modes.applicationCursorKeysMode,
      applicationKeypad: modes.applicationKeypadMode,
    };
  }

  /**
   * Compresses non-default cell styles into per-row runs. Default-styled cells
   * are omitted so the snapshot stays small for ordinary output.
   */
  private collectStyles(buffer: IBuffer): StyleSpan[] {
    const spans: StyleSpan[] = [];
    const nullCell = buffer.getNullCell();
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const line = buffer.getLine(buffer.baseY + row);
      if (!line) continue;
      let runStart = -1;
      let runKey = '';
      let runStyle: CellStyle | null = null;
      for (let x = 0; x < this.terminal.cols; x += 1) {
        const cell = line.getCell(x, nullCell);
        const style = cell ? this.readStyle(cell) : null;
        const key = style ? styleKey(style) : '';
        if (key === runKey) continue;
        if (runStyle && runStart >= 0) spans.push({ row, start: runStart, end: x, style: runStyle });
        runStart = style ? x : -1;
        runKey = key;
        runStyle = style;
      }
      if (runStyle && runStart >= 0) {
        spans.push({ row, start: runStart, end: this.terminal.cols, style: runStyle });
      }
    }
    return spans;
  }

  private readStyle(cell: IBufferCell): CellStyle | null {
    if (cell.isAttributeDefault()) return null;
    return {
      bold: cell.isBold() !== 0,
      italic: cell.isItalic() !== 0,
      dim: cell.isDim() !== 0,
      underline: cell.isUnderline() !== 0,
      inverse: cell.isInverse() !== 0,
      invisible: cell.isInvisible() !== 0,
      strikethrough: cell.isStrikethrough() !== 0,
      foreground: readColor(cell, true),
      background: readColor(cell, false),
    };
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new LiteSshError('SCREEN_DISPOSED', 'The screen model has already been disposed.');
    }
  }
}

function readColor(cell: IBufferCell, foreground: boolean): CellStyle['foreground'] {
  const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return { mode: 'default', value: 0 };
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  return { mode: isRgb ? 'rgb' : 'palette', value };
}

/** Stable identity for a cell style, used to detect run boundaries. */
function styleKey(style: CellStyle): string {
  const { foreground, background, ...flags } = style;
  return [
    flags.bold,
    flags.italic,
    flags.dim,
    flags.underline,
    flags.inverse,
    flags.invisible,
    flags.strikethrough,
    foreground.mode,
    foreground.value,
    background.mode,
    background.value,
  ].join('|');
}

/**
 * Reads a row's occupied text, trimming only genuinely unused null padding.
 *
 * `translateToString(true)` trims by the line's "trimmed length", and relying on
 * that makes wrapped rows/partial EOF depend on emulator internals. Instead the
 * last occupied column is found through the public cell API: a printed space has
 * a real codepoint (32) and stays, while a never-written cell (codepoint 0) is padding.
 * That preserves meaningful trailing spaces at a soft-wrap boundary (e.g.
 * `x` + 79 spaces + `y`), and `translateToString(false, 0, end)` then keeps wide
 * characters intact because xterm advances by the cell width.
 *
 * When any cells have the invisible attribute (SGR 8, `isInvisible() !== 0`),
 * their raw text is masked with spaces preserving their exact display column width
 * (e.g. 2 spaces for wide characters, 1 space for standard/combining characters).
 * This prevents leaking sensitive credentials or concealed input into screen
 * snapshots, command summaries, or readable cache logs, while maintaining column
 * alignment for subsequent visible characters.
 */
function readableRow(line: IBufferLine, cols: number, nullCell: IBufferCell): string {
  let end = cols;
  while (end > 0) {
    const cell = line.getCell(end - 1, nullCell);
    if (cell && (cell.getCode() !== 0 || cell.getChars().length > 0)) break;
    end -= 1;
  }
  if (end === 0) return '';

  let hasInvisible = false;
  for (let x = 0; x < end; x++) {
    const cell = line.getCell(x, nullCell);
    if (cell && cell.isInvisible() !== 0) {
      hasInvisible = true;
      break;
    }
  }
  if (!hasInvisible) {
    return line.translateToString(false, 0, end);
  }

  let text = '';
  for (let x = 0; x < end; ) {
    const cell = line.getCell(x, nullCell);
    if (!cell) {
      text += ' ';
      x += 1;
      continue;
    }
    const width = cell.getWidth();
    if (cell.isInvisible() !== 0) {
      // Cell is masked due to invisible attribute (SGR 8).
      // Preserve column width: wide characters (width 2) become 2 spaces,
      // normal characters / combining marks (width 1) become 1 space.
      const step = width || 1;
      text += ' '.repeat(step);
      x += step;
    } else {
      text += cell.getChars() || ' ';
      x += width || 1;
    }
  }
  return text;
}

/** True when a DECSET/DECRST parameter list enables/disables the alternate screen. */
function hasAltScreenMode(params: readonly (number | number[])[]): boolean {
  for (const param of params) {
    const values = Array.isArray(param) ? param : [param];
    for (const value of values) {
      if (value === 47 || value === 1047 || value === 1049) return true;
    }
  }
  return false;
}

const C0_LF = 0x0a;
const C0_CR = 0x0d;
const C0_BS = 0x08;


/**
 * Separates a trailing lone CR from the rest of the input. Whether that CR is
 * destructive depends on the next byte, which may not have arrived yet, so it is
 * held back rather than classified.
 */
function takeTrailingCr(
  data: string | Uint8Array,
): { body: string | Uint8Array; pending: boolean } {
  if (typeof data === 'string') {
    if (data.length > 0 && data.charCodeAt(data.length - 1) === C0_CR) {
      return { body: data.slice(0, -1), pending: true };
    }
    return { body: data, pending: false };
  }
  if (data.length > 0 && data[data.length - 1] === C0_CR) {
    return { body: data.subarray(0, -1), pending: true };
  }
  return { body: data, pending: false };
}

/**
 * Splits input into chunks that begin at a destructive cursor control: a
 * backspace, or a carriage return that is not part of a CRLF. The C0 bytes LF,
 * CR and BS are ASCII and can never be a UTF-8 continuation byte, so splitting
 * raw bytes is safe. A CR immediately followed by LF is a normal line ending and
 * is deliberately left inside its chunk, so `\r\n` still yields exactly one LF.
 */
function splitAtDestructive(data: string | Uint8Array): Array<string | Uint8Array> {
  const parts: Array<string | Uint8Array> = [];
  const codeAt = (index: number): number | undefined => typeof data === 'string' ? data.charCodeAt(index) : data[index];
  let start = 0;
  for (let index = 0; index < data.length; index++) {
    const code = codeAt(index);
    if (code !== C0_BS && !(code === C0_CR && codeAt(index + 1) !== C0_LF)) continue;
    if (index > start) parts.push(data.slice(start, index));
    // Classify this control separately, using xterm's actual post-control
    // coordinates rather than guessing BS/reverse-wrap or CR behaviour.
    parts.push(data.slice(index, index + 1));
    start = index + 1;
  }
  if (start < data.length || !parts.length) parts.push(data.slice(start));
  return parts;
}

/** True when a chunk begins with a destructive CR (not CRLF) or BS. */
function startsDestructive(part: string | Uint8Array): boolean {
  if (typeof part === 'string') {
    const first = part.charCodeAt(0);
    if (first === C0_BS) return true;
    return first === C0_CR && part.charCodeAt(1) !== C0_LF;
  }
  const first = part[0];
  if (first === C0_BS) return true;
  return first === C0_CR && part[1] !== C0_LF;
}

/**
 * Serializes everything a snapshot exposes except `revision`. Two snapshots
 * with equal keys are indistinguishable to a reader, which is exactly when the
 * screen revision must not advance.
 */
function renderKeyOf(snapshot: ScreenSnapshot): string {
  return JSON.stringify([
    snapshot.cols,
    snapshot.rows,
    snapshot.buffer,
    snapshot.cursor.x,
    snapshot.cursor.y,
    snapshot.lines,
    snapshot.styles,
    snapshot.modes,
  ]);
}
