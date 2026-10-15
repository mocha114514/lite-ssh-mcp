import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import ssh2, { type Client } from 'ssh2';
import type { ConfigStore } from '../src/config/store.js';
import type { ResolvedLogin } from '../src/core/types.js';
import { ClientOwner } from '../src/ssh/clientOwner.js';
import { ConnectionPool } from '../src/ssh/pool.js';
import { createApplication } from '../src/app.js';
import { LiteSshError } from '../src/core/errors.js';
import { CleanupError } from '../src/core/cleanup.js';
import { fixtureRoot } from './helpers/workspace.js';

class SyntheticClient extends EventEmitter {
  ends = 0;
  destroys = 0;
  gracefulClose = false;
  forcedClose = true;
  end(): void {
    this.ends++;
    if (this.gracefulClose) queueMicrotask(() => this.emit('close'));
  }
  destroy(): void {
    this.destroys++;
    if (this.forcedClose) queueMicrotask(() => this.emit('close'));
  }
}

const target = { ip: '127.0.0.1', port: 22222, username: 'synthetic_user' };
const resolved: ResolvedLogin = {
  target,
  auth: { type: 'password', password: 'synthetic_only' },
  revision: 'synthetic_revision'
};
const store = (resolveLogin: () => Promise<ResolvedLogin>) => ({ resolveLogin }) as unknown as ConfigStore;

test('owned client grace expiry destroys once and awaits the actual close event', async () => {
  const client = new SyntheticClient();
  let observed = 0;
  const owner = new ClientOwner(client as unknown as Client, () => observed++, 10, 20);
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  assert.equal(owner.closed, false);
  await closing;
  assert.equal(client.ends, 1);
  assert.equal(client.destroys, 1);
  assert.equal(observed, 1);
  assert.equal(owner.closed, true);
});

test('owned client deadline never fabricates closure after end/destroy', async () => {
  const client = new SyntheticClient();
  client.forcedClose = false;
  const owner = new ClientOwner(client as unknown as Client, () => undefined, 10, 10);
  await assert.rejects(owner.close(), { code: 'CONNECTION_CLEANUP_FAILED' });
  assert.equal(owner.closed, false);
  assert.equal(client.destroys, 1);
  client.emit('close');
  assert.equal(owner.closed, true);
  await owner.close();
});

test('pool disposal tracks login resolution before its first asynchronous yield', async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const connects = t.mock.method(ssh2.Client.prototype, 'connect', function () {
    throw new Error('No socket should be created after disposal');
  });
  const pool = new ConnectionPool(store(async () => { await blocked; return resolved; }));
  const acquisition = pool.acquire(target);
  void acquisition.catch(() => undefined);
  const closing = pool.dispose();
  assert.equal(pool.dispose(), closing);
  let done = false;
  void closing.then(() => { done = true; });
  await sleep(5);
  assert.equal(done, false);
  release();
  await assert.rejects(acquisition, { code: 'CONNECTION_LOST' });
  await closing;
  assert.equal(connects.mock.callCount(), 0);
});

test('only the final shared lease closes the owner; concurrent release is idempotent', async t => {
  t.mock.method(ssh2.Client.prototype, 'connect', function (this: Client) {
    queueMicrotask(() => this.emit('ready'));
    return this;
  });
  const end = t.mock.method(ssh2.Client.prototype, 'end', function (this: Client) {
    queueMicrotask(() => this.emit('close'));
    return this;
  });
  const destroy = t.mock.method(ssh2.Client.prototype, 'destroy', function (this: Client) { return this; });
  const pool = new ConnectionPool(store(async () => resolved));
  try {
    const first = await pool.acquire(target);
    const second = await pool.acquire(target);
    assert.equal(first.client, second.client);
    await first.release();
    assert.equal(end.mock.callCount(), 0);
    assert.equal(destroy.mock.callCount(), 0);
    const releasing = second.release();
    assert.equal(second.release(), releasing);
    await releasing;
    assert.equal(end.mock.callCount(), 1);
    assert.equal(destroy.mock.callCount(), 0);
  } finally { await pool.dispose(); }
});

test('pool disposal aborts and awaits a registered but not-yet-ready client', async t => {
  let started!: () => void;
  const connecting = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(ssh2.Client.prototype, 'connect', function (this: Client) {
    started();
    return this;
  });
  const end = t.mock.method(ssh2.Client.prototype, 'end', function (this: Client) {
    queueMicrotask(() => this.emit('close'));
    return this;
  });
  const pool = new ConnectionPool(store(async () => resolved));
  const acquisition = pool.acquire(target);
  void acquisition.catch(() => undefined);
  await connecting;
  await pool.dispose();
  await assert.rejects(acquisition, { code: 'CONNECTION_LOST' });
  assert.equal(end.mock.callCount(), 1);
});

test('application always detaches its MCP transport when pool cleanup reports uncertainty', async t => {
  const root = fixtureRoot('app-cleanup');
  const app = createApplication({ configPath: `${root}/synthetic-config.json`, cacheRoot: `${root}/synthetic-cache` });
  const failure = new LiteSshError('CONNECTION_CLEANUP_FAILED', 'synthetic unconfirmed close');
  t.mock.method(app.pool, 'dispose', async () => { throw failure; });
  const close = t.mock.method(app.server, 'close');
  // F09 reports a branded aggregate, not the original object's identity.
  // The primary classification and every concrete cleanup fact must survive.
  await assert.rejects(app.close(), error => {
    assert.ok(error instanceof CleanupError);
    assert.equal(error.code, failure.code);
    assert.equal(error.message, failure.message);
    assert.equal(error.failureCount, 1);
    assert.deepEqual(error.failures, [{
      resource: 'connection',
      code: 'CONNECTION_CLEANUP_FAILED'
    }]);
    assert.equal(error.details.cleanupFailureCount, 1);
    assert.equal(error.details.cleanupFailuresComplete, true);
    assert.deepEqual(error.details.cleanupFailures, error.failures);
    return true;
  });
  assert.equal(close.mock.callCount(), 1);
});

test('physical connection budget includes closing owners without double-counting handshakes', async t => {
  const clients: Client[] = [];
  t.mock.method(ssh2.Client.prototype, 'connect', function (this: Client) {
    clients.push(this);
    queueMicrotask(() => this.emit('ready'));
    return this;
  });
  t.mock.method(ssh2.Client.prototype, 'end', function (this: Client) { return this; });
  const pool = new ConnectionPool({ resolveLogin: async (login: typeof target) => ({
    ...resolved, target: login, revision: login.username
  }) } as unknown as ConfigStore);
  const releases: Promise<void>[] = [];
  try {
    const leases = await Promise.all(Array.from({ length: 32 }, (_, i) => pool.acquire({
      ...target, username: `synthetic_${i}`
    })));
    assert.equal(clients.length, 32, 'pending and owner refer to one reservation, not two');
    for (const lease of leases) releases.push(lease.release());
    await assert.rejects(pool.acquire({ ...target, username: 'over_budget' }), { code: 'RESOURCE_LIMIT' });
    assert.equal(clients.length, 32, 'closing owners still occupy their physical slots');
    for (const client of clients) client.emit('close');
    await Promise.all(releases);
    const next = await pool.acquire({ ...target, username: 'after_confirmed_close' });
    assert.equal(clients.length, 33);
    const closing = next.release();
    clients.at(-1)!.emit('close');
    await closing;
  } finally {
    for (const client of clients) client.emit('close');
    await Promise.allSettled(releases);
    await pool.dispose();
  }
});
