import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SFTPWrapper } from 'ssh2';
import { RemoteFileSystem } from '../src/sftp/remote.js';

class Channel extends EventEmitter {
  ended = 0;
  opens = 0;
  probes: Array<[string, string, boolean]> = [];
  closeOnEnd = true;
  unsupported = false;
  denied = false;
  end(): void { this.ended++; if (this.closeOnEnd) queueMicrotask(() => this.emit('close')); }
  // Deliberately unsettle reads/opens to reproduce callbacks lost after send.
  lstat(): void {}
  open(): void { this.opens++; }
  ext_openssh_hardlink(from: string, to: string, callback: (error: Error) => void): void {
    this.probe(from, to, false, callback);
  }
  ext_openssh_rename(from: string, to: string, callback: (error: Error) => void): void {
    this.probe(from, to, true, callback);
  }
  private probe(from: string, to: string, overwrite: boolean, callback: (error: Error) => void): void {
    this.probes.push([from, to, overwrite]);
    if (this.unsupported) throw new Error('fixture unadvertised extension');
    callback(Object.assign(new Error('fixture status'), { code: this.denied ? 8 : 2 }));
  }
}
const remote = (channel: Channel) => new RemoteFileSystem(channel as unknown as SFTPWrapper, 25, 25);

test('SFTP error rejects pending operations but is not a confirmed close event', async () => {
  const channel = new Channel();
  channel.closeOnEnd = false;
  const fs = remote(channel);
  const operation = fs.lstat('/synthetic');
  channel.emit('error', new Error('fixture protocol error'));
  await assert.rejects(operation, { code: 'SFTP_CHANNEL_ERROR' });
  let settled = false;
  const closing = fs.dispose().then(value => { settled = true; return value; });
  await sleep(5);
  assert.equal(settled, false);
  assert.equal(channel.ended, 1);
  channel.emit('close');
  assert.equal(await closing, true);
  assert.equal(fs.effectUnknown, false);
});

test('a disposal deadline returns unconfirmed and never synthesizes closed state', async () => {
  const channel = new Channel();
  channel.closeOnEnd = false;
  const fs = remote(channel);
  assert.equal(await fs.dispose(), false);
  assert.equal(await fs.dispose(), false);
  assert.equal(channel.ended, 1);
  channel.emit('close');
  assert.equal(await fs.dispose(), true);
});

test('lost exclusive OPEN reports attempted temporary name without guessing ownership or replaying', async () => {
  const channel = new Channel();
  const fs = remote(channel);
  await assert.rejects(fs.createExclusive('/fixture/.owned-attempt.tmp'), error => {
    assert.equal((error as { code: string }).code, 'SFTP_CREATE_OUTCOME_UNKNOWN');
    assert.equal((error as { details: { possibleResidualPath: string } }).details.possibleResidualPath, '/fixture/.owned-attempt.tmp');
    return true;
  });
  assert.equal(channel.opens, 1);
  assert.equal(fs.effectUnknown, true);
  assert.equal(await fs.dispose(), true);
});

test('publication preflight uses identical names and caches each independent capability', async () => {
  const channel = new Channel();
  const fs = remote(channel);
  try {
    await fs.checkCommit(false);
    await fs.checkCommit(false);
    await fs.checkCommit(true);
    await fs.checkCommit(true);
    assert.equal(channel.probes.length, 2);
    for (const [from, to] of channel.probes) assert.equal(from, to);
    assert.deepEqual(channel.probes.map(probe => probe[2]), [false, true]);
    assert.equal(channel.opens, 0);
    assert.equal(fs.effectUnknown, false);
  } finally { await fs.dispose(); }
});

test('unadvertised and refused publication capabilities fail before mutation', async () => {
  for (const mode of ['unadvertised', 'refused']) {
    const channel = new Channel();
    channel.unsupported = mode === 'unadvertised';
    channel.denied = mode === 'refused';
    const fs = remote(channel);
    try {
      await assert.rejects(fs.checkCommit(false), { code: 'COMMIT_UNSUPPORTED' });
      await assert.rejects(fs.checkCommit(true), { code: 'COMMIT_UNSUPPORTED' });
      assert.equal(channel.opens, 0);
      assert.equal(fs.effectUnknown, false);
    } finally { await fs.dispose(); }
  }
});

test('handle READDIR EOF is normal exhaustion and still closes the directory handle', async () => {
  let reads = 0;
  let closes = 0;
  const channel = Object.assign(new EventEmitter(), {
    opendir(_path: string, callback: (error: undefined, handle: Buffer) => void) {
      callback(undefined, Buffer.alloc(4));
    },
    readdir(_handle: Buffer, callback: (error: Error | undefined, entries?: unknown[]) => void) {
      if (reads++ === 0) callback(undefined, [{ filename: '.' }, { filename: 'synthetic-item' }]);
      else callback(Object.assign(new Error('normal EOF'), { code: 1 }));
    },
    close(_handle: Buffer, callback: (error?: Error) => void) { closes++; callback(); },
    end() { queueMicrotask(() => channel.emit('close')); }
  });
  const fs = new RemoteFileSystem(channel as unknown as SFTPWrapper, 25, 25);
  try {
    const names: string[] = [];
    for await (const name of fs.entries('/synthetic')) names.push(name);
    assert.deepEqual(names, ['synthetic-item']);
    assert.equal(reads, 2);
    assert.equal(closes, 1);
  } finally { await fs.dispose(); }
});

test('callback failure before close preserves uncertain WRITE; numeric STATUS stays distinct', async () => {
  for (const protocolStatus of [false, true]) {
    const channel = Object.assign(new EventEmitter(), {
      open(...args: unknown[]) {
        const callback = args.at(-1) as (error: undefined, handle: Buffer) => void;
        callback(undefined, Buffer.alloc(4));
      },
      write(...args: unknown[]) {
        const callback = args.at(-1) as (error: Error) => void;
        const error = protocolStatus
          ? Object.assign(new Error('synthetic server failure'), { code: 4 })
          : new Error('synthetic no-response callback before close');
        queueMicrotask(() => callback(error));
      },
      end() { queueMicrotask(() => channel.emit('close')); }
    });
    const fs = new RemoteFileSystem(channel as unknown as SFTPWrapper, 25, 25);
    try {
      const file = await fs.createExclusive('/synthetic/.temporary');
      await assert.rejects(file.write(Buffer.from('synthetic'), 9, 0), error => {
        assert.equal((error as { code: unknown }).code, protocolStatus ? 4 : 'SFTP_OUTCOME_UNKNOWN');
        return true;
      });
      assert.equal(fs.effectUnknown, !protocolStatus);
    } finally { await fs.dispose(); }
  }
});
