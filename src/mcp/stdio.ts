import { fork, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import { types } from 'node:util';
import { ReadBuffer } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { LiteSshError } from '../core/errors.js';
import {
  encodeMessage, measureMessage, MAX_STDIO_FRAME_BYTES,
  STDIO_WRITER_BLOCK_BYTES, StdioEncodingError
} from './stdio-codec.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Shutdown/ACK failures can precede the caller's await. This observer does
  // not replace the original promise or turn its rejection into success.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
interface Frame {
  buffer: Buffer;
  bytes: number;
  created: number;
  sequence: number;
  observer: Deferred<void>;
  ack: Deferred<void>;
  settled: boolean;
  retired: boolean;
  nativeDone: boolean;
}
export interface BoundedStdioOptions {
  input?: Readable;
  /** A shared injected sink is never destroyed. Production omits this option. */
  output?: Writable;
  onFatal?: (error: LiteSshError) => void;
  /** Internal finite test overrides, not public MCP options or tool inputs. */
  limits?: {
    maxBytes?: number;
    closeMs?: number;
    flushMs?: number;
    confirmMs?: number;
  };
}

/** Public SDK Transport, with bounded ingress and one independently owned writer. */
export class BoundedStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private readonly input: Readable;
  private readonly output?: Writable;
  private readonly reader = new ReadBuffer();
  private readonly queue: Frame[] = [];
  private readonly ready = deferred<void>();
  private readonly completion = deferred<void>();
  private readonly maxBytes: number;
  private readonly closeMs: number;
  private readonly flushMs: number;
  private readonly confirmMs: number;
  private child?: ChildProcess;
  private current?: Frame;
  private items = 0;
  private bytes = 0;
  private sequence = 0;
  private started = false;
  private writerReady = false;
  private busy = false;
  private pressured = false;
  private pump?: ReturnType<typeof setImmediate>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private oldestTimer?: ReturnType<typeof setTimeout>;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private confirmTimer?: ReturnType<typeof setTimeout>;
  private stopAt?: number;
  private closeRequested = false;
  private writerEnding = false;
  private writerStopped = false;
  private exited = false;
  private writerExitCode?: number | null;
  private writerExitSignal?: NodeJS.Signals | null;
  private processClosed = false;
  private pipeClosed = false;
  private closed = false;
  private fault?: LiteSshError;
  private reported = false;
  private fatalNotified = false;

  constructor(private readonly options: BoundedStdioOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output;
    this.maxBytes = options.limits?.maxBytes ?? MAX_STDIO_FRAME_BYTES;
    this.closeMs = options.limits?.closeMs ?? 5000;
    this.flushMs = options.limits?.flushMs ?? 4000;
    this.confirmMs = options.limits?.confirmMs ?? 1000;
    for (const limit of [this.maxBytes, this.closeMs, this.flushMs, this.confirmMs]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw this.failure('STDIO_INVALID_LIMIT');
    }
    if (this.maxBytes > MAX_STDIO_FRAME_BYTES || this.flushMs >= this.closeMs || this.confirmMs > this.closeMs) {
      throw this.failure('STDIO_INVALID_LIMIT');
    }
  }

  /** Metadata only; no frames, request IDs, credentials or native error text. */
  facts(): Record<string, number | string | boolean | null | undefined> {
    return {
      writerPid: this.child?.pid, pendingSends: this.items, pendingBytes: this.bytes,
      writerExited: this.exited, writerClosed: this.processClosed, pipeClosed: this.pipeClosed,
      stopped: this.closed,
      currentSequence: this.current?.sequence,
      currentNativeDone: this.current?.nativeDone ?? false,
      writerExitCode: this.writerExitCode,
      writerExitSignal: this.writerExitSignal
    };
  }
  private failure(code: string): LiteSshError {
    return new LiteSshError(code, 'The stdio transport could not complete; no input has been automatically replayed.');
  }
  private report(error: Error): void {
    if (this.reported) return;
    this.reported = true;
    try { this.onerror?.(error); } catch { /* A diagnostic is not a new owner. */ }
  }

  async start(): Promise<void> {
    if (this.closed || this.stopAt !== undefined) throw this.failure('STDIO_CLOSED');
    if (this.started) throw this.failure('STDIO_ALREADY_STARTED');
    this.started = true;
    if (this.output) {
      this.output.on('error', this.sinkError);
      this.writerReady = true;
      this.ready.resolve();
    } else {
      try {
        const env = { ...process.env };
        // Windows keys are case-insensitive. Only this child loses Node startup
        // injection; normal environment inheritance is not logged or persisted.
        for (const key of Object.keys(env)) if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
        this.child = fork(new URL('./stdio-writer.js', import.meta.url), [], {
          execPath: process.execPath, execArgv: [], env, windowsHide: true,
          stdio: ['pipe', 'inherit', 'ignore', 'ipc']
        });
        const child = this.child;
        child.on('message', message => this.metadata(message));
        child.on('error', () => {
          if (child.pid === undefined) this.exited = true; // Failed spawn: no process acquired.
          this.fatal('STDIO_WRITER_FAILED');
        });
        child.once('exit', (code, signal) => {
          this.exited = true;
          this.writerExitCode = code;
          this.writerExitSignal = signal;
          if (!this.writerEnding && !this.writerStopped || !this.fault && (code !== 0 || signal !== null) && !this.writerStopped) {
            this.fatal('STDIO_WRITER_FAILED');
          }
          this.current?.ack.reject(this.fault ?? this.failure('STDIO_CLOSED'));
          this.checkPhysicalClose();
        });
        child.once('close', () => { this.processClosed = true; this.checkPhysicalClose(); });
        if (!child.stdin) throw this.failure('STDIO_WRITER_FAILED');
        child.stdin.on('error', () => { if (!this.writerEnding && !this.writerStopped) this.fatal('STDIO_WRITER_FAILED'); });
        child.stdin.once('close', () => { this.pipeClosed = true; this.checkPhysicalClose(); });
        this.readyTimer = setTimeout(() => this.fatal('STDIO_WRITER_READY_TIMEOUT'), 15_000);
      } catch {
        if (!this.child) this.exited = this.processClosed = this.pipeClosed = true;
        this.fatal('STDIO_WRITER_FAILED');
      }
    }
    await this.ready.promise;
    if (this.stopAt !== undefined) return;
    this.input.on('data', this.data);
    this.input.on('error', this.inputError);
    this.input.once('end', this.inputEnd);
    this.input.resume();
  }
  private readonly sinkError = (): void => { this.fatal('STDIO_WRITER_FAILED'); };
  private readonly inputError = (): void => { this.fatal('STDIO_INPUT_FAILED'); };
  private readonly inputEnd = (): void => { this.beginClose(); this.closeRequested = true; this.finishWhenDrained(); };
  private readonly data = (chunk: Buffer): void => {
    // Keep the native input paused while processing even the current chunk.
    // readMessage(null) resumes only when more bytes are actually necessary.
    this.input.pause();
    try { this.reader.append(chunk); } catch { this.fatal('STDIO_INPUT_LIMIT'); return; }
    this.schedulePump();
  };
  private schedulePump(): void {
    if (this.pump || this.pressured || this.stopAt !== undefined || this.closed) return;
    this.pump = setImmediate(() => {
      this.pump = undefined;
      for (let count = 0; count < 8 && !this.pressured && this.stopAt === undefined; count++) {
        let message: JSONRPCMessage | null;
        try { message = this.reader.readMessage(); }
        catch { this.report(this.failure('STDIO_INPUT_FAILED')); continue; }
        if (message === null) { this.input.resume(); return; }
        try { this.onmessage?.(message); } catch { this.report(this.failure('STDIO_INPUT_FAILED')); }
      }
      this.schedulePump(); // A real macrotask turn, not an unbounded microtask loop.
    });
  }
  private pressure(): void {
    const high = this.items >= 32 || this.bytes >= Math.min(this.maxBytes, 256 * 1024);
    const low = this.items <= 16 && this.bytes <= Math.min(this.maxBytes / 2, 128 * 1024);
    if (high) { this.pressured = true; this.input.pause(); }
    else if (this.pressured && low) { this.pressured = false; this.schedulePump(); }
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || this.fault || this.writerEnding) {
      return Promise.reject(this.fault ?? this.failure('STDIO_CLOSED'));
    }
    if (this.items >= 64) return Promise.reject(this.fatal('STDIO_OUTPUT_LIMIT'));
    let bytes: number;
    try { bytes = measureMessage(message, { bytes: this.maxBytes }); }
    catch (error) {
      return this.encodingFailure(message, error instanceof StdioEncodingError ? error : new StdioEncodingError('STDIO_ENCODING_FAILED'));
    }
    if (this.bytes + bytes > this.maxBytes) return Promise.reject(this.fatal('STDIO_OUTPUT_LIMIT'));
    return this.enqueue(message, bytes);
  }
  private encodingFailure(message: JSONRPCMessage, error: StdioEncodingError): Promise<void> {
    // Never read an unsafe getter while preparing the error response either.
    const id = message && typeof message === 'object' && !types.isProxy(message)
      ? Object.getOwnPropertyDescriptor(message, 'id') : undefined;
    if (!id || id.get || id.set || typeof id.value !== 'string' && typeof id.value !== 'number') {
      this.fatal('STDIO_ENCODING_FAILED');
      return Promise.reject(error);
    }
    const replacement = {
      jsonrpc: '2.0' as const, id: id.value as string | number,
      error: { code: -32603, message: error.message, data: {
        code: error.code, responseDelivered: false, effectsUnknown: true, noAutoReplay: true,
        hint: 'For large read-only pages, request a smaller limit. Never replay an operation merely because its response failed.'
      } }
    };
    let bytes: number;
    try { bytes = measureMessage(replacement, { bytes: this.maxBytes }); }
    catch { this.fatal('STDIO_OUTPUT_LIMIT'); return Promise.reject(error); }
    if (this.items >= 64 || this.bytes + bytes > this.maxBytes) {
      this.fatal('STDIO_OUTPUT_LIMIT');
      return Promise.reject(error);
    }
    // This tracked error frame is not a successful delivery of the original
    // response. The original SDK send still rejects after the replacement.
    return this.enqueue(replacement, bytes).then(() => { throw error; }, () => { throw error; });
  }
  private enqueue(message: JSONRPCMessage, bytes: number): Promise<void> {
    this.items++;
    this.bytes += bytes; // Reserve before allocating the encoded frame.
    let buffer: Buffer;
    try { buffer = encodeMessage(message, { bytes: this.maxBytes }); }
    catch {
      this.items--;
      this.bytes -= bytes;
      return Promise.reject(this.fatal('STDIO_ENCODING_FAILED'));
    }
    const frame: Frame = {
      buffer, bytes, created: performance.now(), sequence: this.sequence = (this.sequence + 1) >>> 0,
      observer: deferred<void>(), ack: deferred<void>(), settled: false, retired: false, nativeDone: false
    };
    this.queue.push(frame);
    this.pressure();
    this.watchOldest();
    void this.writeLoop();
    return frame.observer.promise;
  }
  private metadata(value: unknown): void {
    const message = value as { type?: string; sequence?: number } | null;
    if (!message || typeof message !== 'object') { this.fatal('STDIO_WRITER_FAILED'); return; }
    if (message.type === 'ready' && !this.writerReady) {
      this.writerReady = true;
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.ready.resolve();
      void this.writeLoop();
    } else if (message.type === 'ack' && this.current && message.sequence === this.current.sequence) {
      this.current.nativeDone = true;
      this.current.ack.resolve();
    } else this.fatal('STDIO_WRITER_FAILED');
  }
  private write(stream: Writable, bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      stream.write(bytes, error => { if (error) reject(this.failure('STDIO_WRITER_FAILED')); else resolve(); });
    });
  }
  private async deliver(frame: Frame): Promise<void> {
    if (this.output) {
      try {
        for (let offset = 0; offset < frame.buffer.length; offset += STDIO_WRITER_BLOCK_BYTES) {
          if (this.fault) throw this.fault;
          await this.write(this.output, frame.buffer.subarray(offset, offset + STDIO_WRITER_BLOCK_BYTES));
        }
      } finally {
        // Reached only after the shared sink's native callback (including an
        // error), or before a next block was handed off. Delivery can still be
        // unknown; no shared native write remains outstanding at this point.
        frame.nativeDone = true;
      }
    } else {
      const pipe = this.child?.stdin;
      if (!pipe) throw this.failure('STDIO_WRITER_FAILED');
      const header = Buffer.allocUnsafe(8);
      header.writeUInt32BE(frame.sequence, 0);
      header.writeUInt32BE(frame.bytes, 4);
      await this.write(pipe, header);
      for (let offset = 0; offset < frame.buffer.length; offset += STDIO_WRITER_BLOCK_BYTES) {
        if (this.fault) throw this.fault;
        await this.write(pipe, frame.buffer.subarray(offset, offset + STDIO_WRITER_BLOCK_BYTES));
      }
      await frame.ack.promise;
    }
  }
  private settle(frame: Frame, error?: Error): void {
    if (frame.settled) return;
    frame.settled = true;
    if (error) frame.observer.reject(error); else frame.observer.resolve();
  }
  private retire(frame: Frame): void {
    if (frame.retired) return;
    frame.retired = true;
    this.items--;
    this.bytes -= frame.bytes;
    if (this.current === frame) this.current = undefined;
    if (this.closed && this.output) this.output.removeListener('error', this.sinkError);
    this.pressure();
    this.watchOldest();
  }
  private async writeLoop(): Promise<void> {
    if (this.busy || !this.writerReady || this.fault || this.closed) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.fault) {
        const frame = this.queue.shift()!;
        this.current = frame;
        try { await this.deliver(frame); this.settle(frame); }
        catch { this.settle(frame, this.fatal('STDIO_WRITER_FAILED')); }
        // Logical rejection alone does not retire a native in-flight frame.
        if (frame.nativeDone || this.physicallyClosed()) this.retire(frame);
        else break;
      }
    } finally {
      this.busy = false;
      this.finishWhenDrained();
    }
  }
  private watchOldest(): void {
    if (this.oldestTimer) clearTimeout(this.oldestTimer);
    if (this.fault || this.closed) return;
    const oldest = this.current ?? this.queue[0];
    if (oldest) this.oldestTimer = setTimeout(
      () => this.fatal('STDIO_OUTPUT_TIMEOUT'), Math.max(1, oldest.created + 30_000 - performance.now())
    );
  }

  /** Begin the absolute transport deadline before application owner cleanup. */
  beginClose(): void {
    if (this.stopAt !== undefined || this.closed) return;
    this.stopAt = performance.now();
    this.input.pause();
    this.input.removeListener('data', this.data);
    this.input.removeListener('error', this.inputError);
    this.input.removeListener('end', this.inputEnd);
    this.reader.clear();
    if (this.pump) { clearImmediate(this.pump); this.pump = undefined; }
    this.flushTimer = setTimeout(() => {
      this.closeRequested = true;
      if (this.items) this.fatal('STDIO_OUTPUT_TIMEOUT');
      else this.finishWhenDrained();
    }, this.flushMs);
    this.armConfirmation(this.stopAt + this.closeMs);
  }
  close(): Promise<void> {
    this.beginClose();
    this.closeRequested = true;
    this.finishWhenDrained();
    return this.completion.promise;
  }
  private fatal(code: string): LiteSshError {
    if (this.fault) return this.fault;
    const error = this.fault = this.failure(code);
    this.beginClose();
    this.closeRequested = true;
    this.report(error);
    this.ready.reject(error);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    if (this.oldestTimer) clearTimeout(this.oldestTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const frame of this.queue.splice(0)) { this.settle(frame, error); this.retire(frame); }
    if (this.current) { this.settle(this.current, error); this.current.ack.reject(error); }
    this.writerStopped = true;
    if (this.child) {
      // Exact owned instance, never a PID/name scan. Calling kill/destroy is an
      // attempt, not evidence of physical closure or successful output delivery.
      try { this.child.kill('SIGKILL'); } catch { /* Confirmation below remains authoritative. */ }
      this.child.stdin?.destroy();
    }
    this.armConfirmation(Math.min(this.stopAt! + this.closeMs, performance.now() + this.confirmMs));
    this.notifyFatal(error);
    this.checkPhysicalClose();
    return error;
  }


  /** Notify the CLI before logical SDK closure can detach the transport. */
  private notifyFatal(error: LiteSshError): void {
    if (this.fatalNotified) return;
    this.fatalNotified = true;
    try {
      this.options.onFatal?.(error);
    } catch {
      // An observer cannot replace the fixed primary failure or stop cleanup.
    }
  }
  private physicallyClosed(): boolean {
    return !this.output && this.exited && this.processClosed && this.pipeClosed;
  }
  private finishWhenDrained(): void {
    if (!this.closeRequested || this.closed) return;
    if (this.current || this.queue.length || this.busy) return;
    if (this.output || !this.started || !this.child) { this.finishClose(); return; }
    if (!this.writerEnding && !this.writerStopped) {
      this.writerEnding = true;
      this.child.stdin?.end();
    }
    this.checkPhysicalClose();
  }
  private checkPhysicalClose(): void {
    if (!this.physicallyClosed()) return;
    if (this.current) this.retire(this.current);
    if (!this.writerReady) this.ready.reject(this.fault ?? this.failure('STDIO_CLOSED'));
    if (this.closeRequested) this.finishClose();
  }
  private armConfirmation(deadline: number): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = setTimeout(() => {
      if (this.closed) return;
      // Preserve nonzero unknown in-flight facts; a failed close is not an ACK.
      this.fault ??= this.failure('STDIO_CLOSE_UNCONFIRMED');
      this.report(this.fault);
      if (this.child && !this.physicallyClosed()) {
        this.writerStopped = true;
        try { this.child.kill('SIGKILL'); } catch { /* Still unconfirmed. */ }
        this.child.stdin?.destroy();
      }
      // This may be the first fault, while app cleanup is still pending. The
      // SDK onclose below detaches its transport, so a later server.close can
      // no longer propagate our rejected completion promise to the CLI.
      this.notifyFatal(this.fault);
      this.finishClose();
    }, Math.max(1, deadline - performance.now()));
  }
  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of [this.readyTimer, this.oldestTimer, this.flushTimer, this.confirmTimer]) if (timer) clearTimeout(timer);
    // A late native callback/error must still be observed after an unconfirmed
    // shared-sink close. Retirement, not the observer deadline, removes it.
    if (this.output && !this.current) this.output.removeListener('error', this.sinkError);
    if (!this.writerReady) this.ready.reject(this.fault ?? this.failure('STDIO_CLOSED'));
    const error = this.fault;
    if (error) this.completion.reject(new LiteSshError(error.code, error.message, {
      ...this.facts(), responseDelivered: false, effectsUnknown: true, noAutoReplay: true
    }));
    else this.completion.resolve();
    try { this.onclose?.(); } catch { /* All application owners still run via CLI stop. */ }
  }
}
