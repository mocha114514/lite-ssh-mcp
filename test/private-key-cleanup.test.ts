/** Cross-layer cleanup facts use synthetic failures, never real credentials. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { ConfigStore } from '../src/config/store.js';
import { CleanupError } from '../src/core/cleanup.js';
import { LiteSshError } from '../src/core/errors.js';
import { ConnectionPool } from '../src/ssh/pool.js';
import { TerminalService } from '../src/terminal/service.js';
import { TransferManager } from '../src/sftp/manager.js';
import { createApplication } from '../src/app.js';

const target = { ip: '127.0.0.1', port: 2222, username: 'synthetic' };
const source = path.resolve('vb-test/fix-20261107/d2/not-created');
function failure(unconfirmed = true): LiteSshError {
  return new LiteSshError('AUTH_FAILED', 'Synthetic credential failure.',
    unconfirmed ? { privateKeyHandleCloseConfirmed: false } : {});
}
function retainsCloseFact(error: unknown): boolean {
  assert.ok(error instanceof CleanupError);
  assert.ok(error.failures.some(item => item.facts?.privateKeyHandleCloseConfirmed === false));
  return true;
}
function pendingPool() {
  let reject!: (error: unknown) => void;
  const resolution = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const pool = new ConnectionPool({ resolveLogin: () => resolution } as unknown as ConfigStore);
  return { pool, reject };
}

for (const unconfirmed of [false, true]) {
  test(`pool retains settled acquisition cleanup facts, but not ordinary auth failures (${unconfirmed})`, async () => {
    const pool = new ConnectionPool({ resolveLogin: async () => { throw failure(unconfirmed); } } as unknown as ConfigStore);
    await assert.rejects(pool.acquire(target), { code: 'AUTH_FAILED' });
    if (unconfirmed) await assert.rejects(pool.dispose(), retainsCloseFact);
    else await pool.dispose();
  });
}

test('pool includes an in-flight acquisition close failure in shutdown', async () => {
  const f = pendingPool();
  const acquisition = f.pool.acquire(target);
  const acquiring = assert.rejects(acquisition, { code: 'AUTH_FAILED' });
  const closing = assert.rejects(f.pool.dispose(), retainsCloseFact);
  f.reject(failure());
  await Promise.all([acquiring, closing]);
});

test('terminal-only shutdown retains an in-flight private-key close fact', async () => {
  const f = pendingPool();
  const terminals = new TerminalService(f.pool);
  const opening = assert.rejects(terminals.open(target, 'synthetic_key_close'), { code: 'AUTH_FAILED' });
  const closing = assert.rejects(terminals.dispose(false), retainsCloseFact);
  f.reject(failure());
  await Promise.all([opening, closing]);
  await assert.rejects(f.pool.dispose(), retainsCloseFact);
});

test('transfer-only shutdown retains an in-flight private-key close fact', async () => {
  const f = pendingPool();
  const transfers = new TransferManager(f.pool);
  const admitting = assert.rejects(transfers.accept('upload', {
    ...target, localPath: source, remotePath: '/synthetic/not-created',
  }), { code: 'AUTH_FAILED' });
  const closing = assert.rejects(transfers.dispose(), retainsCloseFact);
  f.reject(failure());
  await Promise.all([admitting, closing]);
  await assert.rejects(f.pool.dispose(), retainsCloseFact);
});

for (const route of ['terminal', 'transfer'] as const) {
  for (const unconfirmed of [false, true]) {
    test(`application close after a settled ${route} rejection reflects cleanup evidence (${unconfirmed})`, async t => {
      // Constructor injection and the mocked resolver prevent any configuration
      // or key read; neither this synthetic config path nor source is created.
      const app = createApplication({ configPath: path.join(source, 'config.json') });
      t.mock.method(app.store, 'resolveLogin', async () => { throw failure(unconfirmed); });
      const operation = route === 'terminal'
        ? app.terminals.open(target, 'synthetic_key_close')
        : app.transfers.accept('upload', { ...target, localPath: source, remotePath: '/synthetic/not-created' });
      await assert.rejects(operation, { code: 'AUTH_FAILED' });
      if (unconfirmed) await assert.rejects(app.close(), retainsCloseFact);
      else await app.close();
    });
  }
}
