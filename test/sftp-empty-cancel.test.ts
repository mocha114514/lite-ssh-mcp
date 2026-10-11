import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SFTPWrapper } from 'ssh2';
import { TransferManager } from '../src/sftp/manager.js';
import { RemoteFileSystem } from '../src/sftp/remote.js';
import { LiteSshError } from '../src/core/errors.js';
import { fixtureRoot } from './helpers/workspace.js';

test('TransferManager.cancel during pending READDIR delivering empty batch halts enumeration, closes handle, and reaches cancelled', async () => {
  let readdirCalls = 0;
  let opendirCalls = 0;
  let closeCalls = 0;
  let deliverReaddir!: () => void;
  let readdirPendingResolve!: () => void;
  const readdirPendingPromise = new Promise<void>(resolve => {
    readdirPendingResolve = resolve;
  });

  const fakeChannel = new EventEmitter() as any;
  fakeChannel.lstat = (_path: string, cb: (err: null, stat: any) => void) => {
    cb(null, {
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
      size: 0,
      mtime: 0,
      mode: 0o755
    });
  };
  fakeChannel.opendir = (_path: string, cb: (err: null, handle: Buffer) => void) => {
    opendirCalls++;
    cb(null, Buffer.from('dir-handle-1'));
  };
  fakeChannel.readdir = (_handle: Buffer, cb: (err: null, entries: any[]) => void) => {
    readdirCalls++;
    deliverReaddir = () => cb(null, []);
    readdirPendingResolve();
  };
  fakeChannel.close = (_handle: Buffer, cb: (err?: null) => void) => {
    closeCalls++;
    cb(null);
  };
  fakeChannel.end = () => {
    queueMicrotask(() => fakeChannel.emit('close'));
  };

  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: (err: null, chan: any) => void) => {
    cb(null, fakeChannel);
  };

  let leaseReleased = 0;
  const pool = {
    acquire: async (target: any) => ({
      client: fakeClient,
      target: { ip: target.ip, port: target.port, username: target.username },
      release: async () => { leaseReleased++; }
    })
  };

  // Uses default remote factory (RemoteFileSystem.open) and default planner
  const manager = new TransferManager(pool as any);
  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'synthetic',
    localPath: fixtureRoot('sftp-empty-cancel', 'download-target'),
    remotePath: '/remote/dir'
  };

  try {
    const accepted = await manager.accept('download', request);
    const id = String(accepted.transferId);

    // Wait until the real RemoteFileSystem.entries has opened the dir and is waiting in readdir
    await readdirPendingPromise;
    assert.equal(opendirCalls, 1);
    assert.equal(readdirCalls, 1);

    // Cancel the task while readdir is pending on the remote server
    const cancelRes = manager.cancel(id);
    assert.equal(cancelRes.cancellationAccepted, true);

    // Server now delivers an empty batch [] (e.g. ssh2 filtered . and ..)
    deliverReaddir();

    // Settle to terminal state
    let done: any;
    for (let i = 0; i < 200; i++) {
      const status = manager.status(id);
      if (status.stopped === true) {
        done = status;
        break;
      }
      await sleep(10);
    }

    assert.ok(done !== undefined, 'Transfer did not reach terminal stopped state');
    assert.equal(done.state, 'cancelled');
    assert.equal(done.filesCommitted, 0);
    // Crucial: no subsequent readdir was dispatched after empty batch upon cancellation
    assert.equal(readdirCalls, 1);
    // Crucial: the owned directory handle was properly closed via channel.close
    assert.equal(closeCalls, 1);
    assert.equal(leaseReleased, 1);
  } finally {
    await manager.dispose();
  }
});

test('RemoteFileSystem.entries aborts on pending readdir delivering empty batch, closes handle, and does not re-read', async () => {
  let readdirCalls = 0;
  let opendirCalls = 0;
  let closeCalls = 0;
  let deliverReaddir!: () => void;
  let readdirPendingResolve!: () => void;
  const readdirPendingPromise = new Promise<void>(resolve => {
    readdirPendingResolve = resolve;
  });

  const channel = Object.assign(new EventEmitter(), {
    opendir(_path: string, cb: (err: undefined, handle: Buffer) => void) {
      opendirCalls++;
      cb(undefined, Buffer.from('h'));
    },
    readdir(_handle: Buffer, cb: (err: undefined, entries: any[]) => void) {
      readdirCalls++;
      deliverReaddir = () => cb(undefined, []);
      readdirPendingResolve();
    },
    close(_handle: Buffer, cb: () => void) {
      closeCalls++;
      cb();
    },
    end() {
      queueMicrotask(() => channel.emit('close'));
    }
  });

  const fs = new RemoteFileSystem(channel as unknown as SFTPWrapper, 25, 25);
  const controller = new AbortController();

  try {
    const iterator = fs.entries('/synthetic', controller.signal)[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await readdirPendingPromise;
    assert.equal(opendirCalls, 1);
    assert.equal(readdirCalls, 1);

    controller.abort();
    deliverReaddir();

    await assert.rejects(nextPromise, (err: unknown) => {
      assert.ok(err instanceof LiteSshError);
      assert.equal(err.code, 'TRANSFER_CANCELLED');
      return true;
    });

    assert.equal(readdirCalls, 1);
    assert.equal(closeCalls, 1);
  } finally {
    await fs.dispose();
  }
});

test('RemoteFileSystem.entries aborts before opendir without acquiring handle', async () => {
  let opendirCalls = 0;
  const channel = Object.assign(new EventEmitter(), {
    opendir(_path: string, cb: (err: undefined, handle: Buffer) => void) {
      opendirCalls++;
      cb(undefined, Buffer.from('h'));
    },
    readdir(_handle: Buffer, cb: (err: undefined, entries: any[]) => void) {
      cb(undefined, []);
    },
    close(_handle: Buffer, cb: () => void) {
      cb();
    },
    end() {
      queueMicrotask(() => channel.emit('close'));
    }
  });

  const fs = new RemoteFileSystem(channel as unknown as SFTPWrapper, 25, 25);
  const controller = new AbortController();
  controller.abort();

  try {
    const iterator = fs.entries('/synthetic', controller.signal)[Symbol.asyncIterator]();
    await assert.rejects(iterator.next(), (err: unknown) => {
      assert.ok(err instanceof LiteSshError);
      assert.equal(err.code, 'TRANSFER_CANCELLED');
      return true;
    });
    assert.equal(opendirCalls, 0);
  } finally {
    await fs.dispose();
  }
});
