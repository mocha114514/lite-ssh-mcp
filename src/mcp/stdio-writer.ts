import { MAX_STDIO_FRAME_BYTES, STDIO_WRITER_BLOCK_BYTES } from './stdio-codec.js';

// This entry point is intentionally a stdlib-only byte forwarder. MCP parsing,
// business operations, configuration and credentials belong to the parent.
// On Windows a standard stdout pipe can block synchronously; only this owned
// child may encounter that write, never the parent's cleanup event loop.
const header = Buffer.alloc(8);
let headerBytes = 0;
let remaining = 0;
let sequence = 0;
let failed = false;
let stopped = false;
let ending = false;
let consuming: Promise<void> | undefined;

function metadata(message: { type: 'ready' | 'ack' | 'failed'; sequence?: number }): void {
  if (!process.connected || !process.send) { stop(); return; }
  process.send(message, error => { if (error) stop(); });
}
function stop(): void {
  if (stopped) return;
  stopped = true;
  failed = true;
  process.exitCode = 1;
  process.stdin.destroy();
  if (process.connected) process.disconnect?.();
}
function fail(): void {
  if (failed) return;
  failed = true;
  // No native error, frame, request ID or environment value crosses IPC.
  if (process.connected && process.send) {
    process.send({ type: 'failed' }, () => stop());
  } else stop();
}
function write(bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    // Even write(true) only means acceptance. The native callback is the
    // completion boundary; a frame ACK is sent after every block crosses it.
    process.stdout.write(bytes, error => { if (error) reject(error); else resolve(); });
  });
}
async function consume(chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length && !failed) {
    if (remaining === 0) {
      const count = Math.min(8 - headerBytes, chunk.length - offset);
      chunk.copy(header, headerBytes, offset, offset + count);
      headerBytes += count;
      offset += count;
      if (headerBytes !== 8) continue;
      sequence = header.readUInt32BE(0);
      remaining = header.readUInt32BE(4);
      headerBytes = 0;
      if (remaining < 1 || remaining > MAX_STDIO_FRAME_BYTES) throw new Error('Invalid writer frame.');
    }
    const count = Math.min(remaining, chunk.length - offset, STDIO_WRITER_BLOCK_BYTES);
    if (count === 0) continue;
    const part = chunk.subarray(offset, offset + count);
    if (count === remaining && part.at(-1) !== 10) throw new Error('Invalid writer frame.');
    await write(part);
    offset += count;
    remaining -= count;
    if (remaining === 0) metadata({ type: 'ack', sequence });
  }
}

process.stdout.on('error', fail);
process.stdin.on('error', fail);
process.on('disconnect', () => { if (!ending) stop(); });
process.stdin.on('data', (chunk: Buffer) => {
  process.stdin.pause();
  consuming = consume(chunk);
  void consuming.then(() => {
    consuming = undefined;
    if (!failed) process.stdin.resume();
  }, fail);
});
process.stdin.once('end', () => {
  void (consuming ?? Promise.resolve()).then(() => {
    if (remaining !== 0 || headerBytes !== 0) { fail(); return; }
    if (failed) return;
    ending = true;
    // End means the parent has requested retirement after all acknowledged
    // frames. Natural exit releases this process's actual standard descriptors.
    if (process.connected) process.disconnect?.();
  }, fail);
});
metadata({ type: 'ready' });
