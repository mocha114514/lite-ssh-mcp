import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { TransferManager } from '../src/sftp/manager.js';
import { RemoteFileSystem } from '../src/sftp/remote.js';
import { LiteSshError } from '../src/core/errors.js';
import { TRANSFER_LIMITS } from '../src/sftp/types.js';

test('real ssh2 loopback server omitting VERSION times out and retains cleanup ticket until client closes', async () => {
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  const serverClients = new Set<ssh2.Connection>();
  const server = new ssh2.Server({ hostKeys: [key.privateKey] }, client => {
    serverClients.add(client);
    client.on('error', () => undefined);
    client.on('close', () => serverClients.delete(client));
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('subsystem', (acceptSubsystem, _rejectSubsystem, info) => {
          if (info.name === 'sftp') {
            acceptSubsystem();
            // Crucial: Deliberately do not send VERSION packet
          }
        });
      });
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const sshClient = new ssh2.Client();
  await new Promise<void>((resolve, reject) => {
    sshClient.on('ready', resolve);
    sshClient.on('error', reject);
    sshClient.connect({
      host: '127.0.0.1',
      port,
      username: 'test_user',
      password: 'test_password'
    });
  });

  try {
    let cleanupPromise: Promise<{ confirmed: boolean }> | undefined;
    let caughtError: unknown;
    try {
      await RemoteFileSystem.open(sshClient, {
        timeoutMs: 50,
        onPendingCleanup: cleanup => { cleanupPromise = cleanup; }
      });
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof LiteSshError);
    assert.equal(caughtError.code, 'SFTP_UNAVAILABLE');
    assert.equal(caughtError.details.cleanupPending, true);
    assert.ok(cleanupPromise !== undefined);

    let cleanupSettled = false;
    void cleanupPromise.then(() => { cleanupSettled = true; });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(cleanupSettled, false);

    sshClient.end();
    const result = await cleanupPromise;
    assert.equal(result.confirmed, true);
  } finally {
    try { sshClient.destroy(); } catch {}
    for (const conn of serverClients) {
      try { conn.end(); } catch {}
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('20 admitted slots exhausted rejects 21st and retains budget memory until cleanup confirmed', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = () => {
    // Hangs forever (times out)
  };

  const pool = {
    acquire: async () => ({
      client: fakeClient,
      target: { ip: '127.0.0.1', port: 22, username: 'user' },
      release: async () => {}
    })
  };

  const manager = new TransferManager(pool as any, {
    openTimeoutMs: 20
  });

  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'user',
    localPath: '/tmp/local',
    remotePath: '/tmp/remote'
  };

  assert.equal(TRANSFER_LIMITS.admitted, 20);

  const errors: LiteSshError[] = [];
  for (let i = 0; i < 20; i++) {
    try {
      await manager.accept('upload', request);
    } catch (err) {
      errors.push(err as LiteSshError);
    }
  }

  assert.equal(errors.length, 20);
  for (const err of errors) {
    assert.equal(err.code, 'SFTP_UNAVAILABLE');
    assert.equal(err.details.cleanupPending, true);
  }

  // 20 admitted slots and memory budget are retained
  assert.equal((manager as any).admitted, 20);
  const memoryHeld = (manager as any).memoryUsed;
  assert.ok(memoryHeld > 0);

  // The 21st request MUST be rejected immediately with RESOURCE_LIMIT
  await assert.rejects(
    manager.accept('upload', request),
    (err: unknown) => {
      assert.ok(err instanceof LiteSshError);
      assert.equal(err.code, 'RESOURCE_LIMIT');
      return true;
    }
  );

  assert.equal((manager as any).admitted, 20);
  assert.equal((manager as any).memoryUsed, memoryHeld);

  // Now client emits 'close', confirming all 20 tickets
  fakeClient.emit('close');
  await new Promise(r => setTimeout(r, 20));

  assert.equal((manager as any).admitted, 0);
  assert.equal((manager as any).memoryUsed, 0);

  await manager.dispose();
});

test('shared active placeholder/terminal is not .end()ed on SFTP timeout, lease is released and budget retained', async () => {
  let clientEndCalled = false;
  let clientDestroyCalled = false;
  const fakeClient = new EventEmitter() as any;
  fakeClient.end = () => { clientEndCalled = true; };
  fakeClient.destroy = () => { clientDestroyCalled = true; };
  fakeClient.sftp = () => {
    // Hangs
  };

  let leaseCount = 2; // e.g. 1 terminal lease + 1 SFTP lease
  let sftpLeaseReleased = false;

  const pool = {
    acquire: async () => ({
      client: fakeClient,
      target: { ip: '127.0.0.1', port: 22, username: 'user' },
      release: async () => {
        sftpLeaseReleased = true;
        leaseCount--;
      }
    })
  };

  const manager = new TransferManager(pool as any, {
    openTimeoutMs: 25
  });

  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'user',
    localPath: '/tmp/local',
    remotePath: '/tmp/remote'
  };

  await assert.rejects(
    manager.accept('upload', request),
    (err: unknown) => {
      assert.ok(err instanceof LiteSshError);
      assert.equal(err.code, 'SFTP_UNAVAILABLE');
      assert.equal(err.details.cleanupPending, true);
      return true;
    }
  );

  // SFTP lease was released immediately
  assert.equal(sftpLeaseReleased, true);
  assert.equal(leaseCount, 1);

  // Shared client was NOT killed, active placeholder continues
  assert.equal(clientEndCalled, false);
  assert.equal(clientDestroyCalled, false);

  // Budget is still retained
  assert.equal((manager as any).admitted, 1);
  assert.ok((manager as any).memoryUsed > 0);

  // Later, terminal finishes and closes client
  fakeClient.emit('close');
  await new Promise(r => setTimeout(r, 10));

  assert.equal((manager as any).admitted, 0);
  assert.equal((manager as any).memoryUsed, 0);

  await manager.dispose();
});

test('lateReady callback with channel.end throwing does not treat throw as closed; waits for actual close', async () => {
  let sftpCallback: ((error?: Error, channel?: any) => void) | undefined;
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: any) => {
    sftpCallback = cb;
  };

  let cleanupPromise: Promise<{ confirmed: boolean }> | undefined;
  const openPromise = RemoteFileSystem.open(fakeClient, {
    timeoutMs: 20,
    onPendingCleanup: cleanup => { cleanupPromise = cleanup; }
  });

  await assert.rejects(openPromise, { code: 'SFTP_UNAVAILABLE' });
  assert.ok(cleanupPromise !== undefined);

  let confirmed = false;
  void cleanupPromise.then(res => { confirmed = res.confirmed; });

  const fakeChannel = new EventEmitter() as any;
  let endCalled = false;
  fakeChannel.end = () => {
    endCalled = true;
    throw new Error('channel.end failed');
  };

  assert.ok(sftpCallback);
  sftpCallback(undefined, fakeChannel);

  assert.equal(endCalled, true);
  // Throw MUST NOT be treated as closed
  await new Promise(r => setTimeout(r, 15));
  assert.equal(confirmed, false);

  // Actual close event on the channel confirms closure
  fakeChannel.emit('close');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(confirmed, true);
});

test('client closes first before lateReady arrives; cleanup confirmed once without duplicate release', async () => {
  let sftpCallback: ((error?: Error, channel?: any) => void) | undefined;
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: any) => {
    sftpCallback = cb;
  };

  const pool = {
    acquire: async () => ({
      client: fakeClient,
      target: { ip: '127.0.0.1', port: 22, username: 'user' },
      release: async () => {}
    })
  };

  const manager = new TransferManager(pool as any, {
    openTimeoutMs: 20
  });

  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'user',
    localPath: '/tmp/local',
    remotePath: '/tmp/remote'
  };

  await assert.rejects(manager.accept('upload', request), { code: 'SFTP_UNAVAILABLE' });
  assert.equal((manager as any).admitted, 1);
  assert.ok((manager as any).memoryUsed > 0);

  // Client emits close FIRST
  fakeClient.emit('close');
  await new Promise(r => setTimeout(r, 15));

  assert.equal((manager as any).admitted, 0);
  assert.equal((manager as any).memoryUsed, 0);

  // Late ready arrives LATER
  const fakeChannel = new EventEmitter() as any;
  fakeChannel.end = () => {};
  assert.ok(sftpCallback);
  sftpCallback(undefined, fakeChannel);
  fakeChannel.emit('close');

  await new Promise(r => setTimeout(r, 15));
  assert.equal((manager as any).admitted, 0);
  assert.equal((manager as any).memoryUsed, 0);

  await manager.dispose();
});

test('late error callback without channel does not confirm cleanup until client.close', async () => {
  let sftpCallback: ((error?: Error, channel?: any) => void) | undefined;
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: any) => {
    sftpCallback = cb;
  };

  let cleanupPromise: Promise<{ confirmed: boolean }> | undefined;
  const openPromise = RemoteFileSystem.open(fakeClient, {
    timeoutMs: 20,
    onPendingCleanup: cleanup => { cleanupPromise = cleanup; }
  });

  await assert.rejects(openPromise, { code: 'SFTP_UNAVAILABLE' });
  assert.ok(cleanupPromise !== undefined);

  let confirmed = false;
  void cleanupPromise.then(res => { confirmed = res.confirmed; });

  // Late error callback with undefined channel
  assert.ok(sftpCallback);
  sftpCallback(new Error('late subsystem rejection'), undefined);

  // Must NOT treat cb(error, undefined) as cleanup confirmation
  await new Promise(r => setTimeout(r, 15));
  assert.equal(confirmed, false);

  // Client close is the only physical proof
  fakeClient.emit('close');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(confirmed, true);
});

test('dispose does not deadlock on pending ticket and late events do not create negative budget', async () => {
  let sftpCallback: ((error?: Error, channel?: any) => void) | undefined;
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: any) => {
    sftpCallback = cb;
  };

  const pool = {
    acquire: async () => ({
      client: fakeClient,
      target: { ip: '127.0.0.1', port: 22, username: 'user' },
      release: async () => {}
    })
  };

  const manager = new TransferManager(pool as any, {
    openTimeoutMs: 20
  });

  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'user',
    localPath: '/tmp/local',
    remotePath: '/tmp/remote'
  };

  await assert.rejects(manager.accept('upload', request), { code: 'SFTP_UNAVAILABLE' });
  assert.equal((manager as any).admitted, 1);
  assert.ok((manager as any).memoryUsed > 0);

  // Dispose while ticket is still pending: must not deadlock
  await manager.dispose();

  assert.ok((manager as any).admitted >= 0);
  assert.ok((manager as any).memoryUsed >= 0);

  // Late events arrive after dispose
  fakeClient.emit('close');
  if (sftpCallback) {
    sftpCallback(new Error('late error after dispose'), undefined);
  }

  await new Promise(r => setTimeout(r, 15));
  assert.equal((manager as any).admitted, 0);
  assert.equal((manager as any).memoryUsed, 0);
});

test('fast callback error with undefined channel retains cleanup ticket until client closes', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: any) => {
    cb(new Error('subsystem denied immediately'), undefined);
  };

  const pool = {
    acquire: async () => ({
      client: fakeClient,
      target: { ip: '127.0.0.1', port: 22, username: 'user' },
      release: async () => {}
    })
  };

  const manager = new TransferManager(pool as any);
  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'user',
    localPath: '/tmp/local',
    remotePath: '/tmp/remote'
  };

  const err = await manager.accept('upload', request).catch(e => e);
  assert.ok(err instanceof LiteSshError);
  assert.equal(err.code, 'SFTP_UNAVAILABLE');
  assert.equal(err.details.cleanupPending, true);

  assert.equal((manager as any).admitted, 1);
  assert.ok((manager as any).memoryUsed > 0);

  fakeClient.emit('close');
  await new Promise(r => setTimeout(r, 15));

  assert.equal((manager as any).admitted, 0);
  assert.equal((manager as any).memoryUsed, 0);

  await manager.dispose();
});

test('comparison 1: client.close happens synchronously before sftp cb succeeds; rejects and ends late channel', async () => {
  let sftpCallback: ((error?: Error, channel?: any) => void) | undefined;
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = (cb: any) => {
    sftpCallback = cb;
  };

  let cleanupPromise: Promise<{ confirmed: boolean }> | undefined;
  const openPromise = RemoteFileSystem.open(fakeClient, {
    timeoutMs: 5000,
    onPendingCleanup: cleanup => { cleanupPromise = cleanup; }
  });

  // Client emits close BEFORE sftp callback
  fakeClient.emit('close');

  const err = await assert.rejects(openPromise, (e: any) => {
    assert.ok(e instanceof LiteSshError);
    assert.equal(e.code, 'SFTP_UNAVAILABLE');
    assert.equal(e.details.cleanupPending, false); // Already confirmed by client.close!
    return true;
  });

  // Now sftp callback arrives with channel: must NOT resolve successfully
  const fakeChannel = new EventEmitter() as any;
  let endCalled = false;
  fakeChannel.end = () => { endCalled = true; };
  assert.ok(sftpCallback);
  sftpCallback(undefined, fakeChannel);

  assert.equal(endCalled, true); // Late channel ended immediately
  const cleanupResult = await cleanupPromise;
  assert.equal(cleanupResult?.confirmed, true);
});

test('comparison 2: client.close happens and sftp never callbacks; immediately rejects without waiting for timeout', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = () => {
    // Never callbacks
  };

  const start = Date.now();
  let cleanupPromise: Promise<{ confirmed: boolean }> | undefined;
  const openPromise = RemoteFileSystem.open(fakeClient, {
    timeoutMs: 15_000, // 15 seconds
    onPendingCleanup: cleanup => { cleanupPromise = cleanup; }
  });

  // Client emits close immediately
  fakeClient.emit('close');

  await assert.rejects(openPromise, (e: any) => {
    assert.ok(e instanceof LiteSshError);
    assert.equal(e.code, 'SFTP_UNAVAILABLE');
    assert.equal(e.details.cleanupPending, false);
    return true;
  });

  const duration = Date.now() - start;
  assert.ok(duration < 1000, `Rejected immediately on client close without waiting for timeout, took ${duration}ms`);
  const cleanupResult = await cleanupPromise;
  assert.equal(cleanupResult?.confirmed, true);
});

test('onPendingCleanup throw does not leave timer unhandled and open still rejects safely', async () => {
  const fakeClient = new EventEmitter() as any;
  fakeClient.sftp = () => {
    // Hangs
  };

  let caughtError: unknown;
  try {
    await RemoteFileSystem.open(fakeClient, {
      timeoutMs: 20,
      onPendingCleanup: () => {
        throw new Error('sync throw in onPendingCleanup callback');
      }
    });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError instanceof LiteSshError);
  assert.equal((caughtError as LiteSshError).code, 'SFTP_UNAVAILABLE');
  assert.equal((caughtError as LiteSshError).details.cleanupPending, true);

  // Client close still works and does not throw
  fakeClient.emit('close');
  await new Promise(r => setTimeout(r, 10));
});

test('pendingCleanup unknown reject does not release failed admission budget', async () => {
  let rejectCleanup!: (reason: any) => void;
  const customCleanupPromise = new Promise<{ confirmed: boolean }>((_, reject) => {
    rejectCleanup = reject;
  });

  const pool = {
    acquire: async () => ({
      client: {} as any,
      target: { ip: '127.0.0.1', port: 22, username: 'user' },
      release: async () => {}
    })
  };

  const manager = new TransferManager(pool as any, {
    remote: async (_client, options) => {
      options?.onPendingCleanup?.(customCleanupPromise);
      throw new LiteSshError('SFTP_UNAVAILABLE', 'Failed');
    }
  });

  const request = {
    ip: '127.0.0.1',
    port: 22,
    username: 'user',
    localPath: '/tmp/local',
    remotePath: '/tmp/remote'
  };

  await assert.rejects(manager.accept('upload', request), { code: 'SFTP_UNAVAILABLE' });
  assert.equal((manager as any).admitted, 1);
  const memoryHeld = (manager as any).memoryUsed;
  assert.ok(memoryHeld > 0);

  // Reject the cleanup promise with an error (unknown reject)
  rejectCleanup(new Error('cleanup rejected'));
  await new Promise(r => setTimeout(r, 15));

  // Budget MUST NOT be released on unknown reject
  assert.equal((manager as any).admitted, 1);
  assert.equal((manager as any).memoryUsed, memoryHeld);

  // Clean up
  await manager.dispose();
});
