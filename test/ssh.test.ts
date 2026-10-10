import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fixtureRoot } from './helpers/workspace.js';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { Server as Ssh2Server } from 'ssh2';
import { ConfigStore } from '../src/config/store.js';
import { ConnectionPool } from '../src/ssh/pool.js';
import { LiteSshError } from '../src/core/errors.js';
import { endpointKey } from '../src/core/targets.js';

/**
 * A fake loopback SSH server with an in-memory RSA host key. All fixtures live
 * under the private `vb-test/m0/<run>` tree; no real remote, user key or user
 * configuration is ever touched.
 */
const RUN_DIR = fixtureRoot('ssh');
const USERNAME = 'testuser';
const PASSWORD = 'secret';
const KEY_USERNAME = 'keyuser';

let server: Ssh2Server;
let port = 0;
let expectedFingerprint = '';
let expectedKeyType = '';
let authAttempts = 0;
let readyConnections = 0;
let serial = 0;

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for ${label}.`);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<LiteSshError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LiteSshError, `expected a LiteSshError, received ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected the operation to fail with ${code}.`);
}

async function writeConfig(portConfig: Record<string, unknown>): Promise<string> {
  await fs.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUN_DIR, `${String(serial += 1).padStart(3, '0')}-config.json`);
  const document = { version: 2, servers: { '127.0.0.1': { [String(port)]: portConfig } } };
  await fs.writeFile(file, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });
  return file;
}

function endpoint(): { ip: string; port: number } {
  return { ip: '127.0.0.1', port };
}

function target(username = USERNAME): { ip: string; port: number; username: string } {
  return { ip: '127.0.0.1', port, username };
}

before(async () => {
  const hostPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const parsed = ssh2.utils.parseKey(hostPair.privateKey);
  if (parsed instanceof Error) throw parsed;
  expectedKeyType = parsed.type;
  expectedFingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;

  server = new ssh2.Server({ hostKeys: [hostPair.privateKey] }, (client) => {
    // A rejected handshake destroys the client socket, so the server connection
    // reports a KEY_EXCHANGE_FAILED error; keep it from becoming unhandled.
    client.on('error', () => { /* expected when this prototype refuses a host key */ });
    client.on('authentication', (context) => {
      authAttempts += 1;
      if (context.method === 'password' && context.username === USERNAME && context.password === PASSWORD) context.accept();
      else if (context.method === 'password' && context.username === USERNAME && context.password === 'rotated') context.accept();
      else if (context.method === 'publickey' && context.username === KEY_USERNAME) context.accept();
      else context.reject();
    });
    client.on('ready', () => { readyConnections += 1; });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('rejects an unknown host key before sending any credential', async () => {
  const file = await writeConfig({ accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } } });
  const pool = new ConnectionPool(new ConfigStore(file));
  const attemptsBefore = authAttempts;
  try {
    const error = await expectCode(pool.acquire(target()), 'HOST_KEY_UNTRUSTED');
    assert.equal(error.details.ip, '127.0.0.1');
    assert.equal(error.details.port, port);
    assert.equal(error.details.keyType, expectedKeyType);
    assert.equal(error.details.fingerprint, expectedFingerprint);
    // The handshake was refused, so no account credential ever reached the server.
    assert.equal(authAttempts, attemptsBefore);
  } finally {
    await pool.dispose();
  }
});

test('rejects a fingerprint mismatch without silently replacing it', async () => {
  const wrong = `SHA256:${'C'.repeat(43)}`;
  const file = await writeConfig({
    hostKeyFingerprint: wrong,
    accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } },
  });
  const pool = new ConnectionPool(new ConfigStore(file));
  const attemptsBefore = authAttempts;
  const readyBefore = readyConnections;
  try {
    const error = await expectCode(pool.acquire(target()), 'HOST_KEY_MISMATCH');
    assert.equal(error.details.expectedFingerprint, wrong);
    assert.equal(error.details.fingerprint, expectedFingerprint);
    assert.equal(error.details.keyType, expectedKeyType);
    assert.equal(authAttempts, attemptsBefore);
    assert.equal(readyConnections, readyBefore);
  } finally {
    await pool.dispose();
  }
});

test('confirms the observed candidate, then authenticates, reuses and closes on last release', async () => {
  const file = await writeConfig({ accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } } });
  const store = new ConfigStore(file);
  const pool = new ConnectionPool(store);
  try {
    // Nothing has been observed yet, so a confirmation must be refused.
    await expectCode(pool.confirmHostKey(endpoint(), expectedFingerprint), 'HOST_KEY_UNTRUSTED');

    // Observing the candidate happens during a failed attempt.
    await expectCode(pool.acquire(target()), 'HOST_KEY_UNTRUSTED');

    // A value this instance never displayed is refused.
    await expectCode(pool.confirmHostKey(endpoint(), `SHA256:${'D'.repeat(43)}`), 'HOST_KEY_MISMATCH');

    const confirmed = await pool.confirmHostKey(endpoint(), expectedFingerprint);
    assert.deepEqual(confirmed, { changed: true, fingerprint: expectedFingerprint });
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as {
      servers: Record<string, Record<string, { hostKeyFingerprint?: string }>>;
    };
    assert.equal(persisted.servers['127.0.0.1']![String(port)]!.hostKeyFingerprint, expectedFingerprint);

    const readyBefore = readyConnections;
    const [first, second] = await Promise.all([pool.acquire(target()), pool.acquire(target())]);
    // Overlapping acquisitions share one physical authenticated connection.
    assert.equal(first.client, second.client);
    assert.equal(readyConnections, readyBefore + 1);

    await first.release();
    const third = await pool.acquire(target());
    assert.equal(third.client, first.client); // One active lease kept it alive.
    await third.release();

    const closed = new Promise<void>((resolve) => first.client.once('close', () => resolve()));
    await second.release(); // Last release closes the connection.
    await closed;
  } finally {
    await pool.dispose();
  }
});

test('loads a private key only for its own login request', async () => {
  // A nonexistent key path resolves fine but fails at connection time, proving
  // the key is not read while loading or resolving the configuration.
  const missingKey = path.join(RUN_DIR, 'missing-key.pem');
  const missingFile = await writeConfig({
    accounts: { [KEY_USERNAME]: { auth: { type: 'privateKey', privateKeyPath: missingKey } } },
  });
  const missingStore = new ConfigStore(missingFile);
  await missingStore.confirmHostKey(endpoint(), expectedFingerprint);
  const resolved = await missingStore.resolveLogin(target(KEY_USERNAME));
  assert.equal(resolved.auth.type, 'privateKey');
  const missingPool = new ConnectionPool(missingStore);
  try {
    const error = await expectCode(missingPool.acquire(target(KEY_USERNAME)), 'AUTH_FAILED');
    assert.ok(!error.message.includes('missing-key.pem'));
  } finally {
    await missingPool.dispose();
  }

  // A real key file lets the same login authenticate.
  const clientPair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await fs.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const keyFile = path.join(RUN_DIR, 'client-key.pem');
  await fs.writeFile(keyFile, clientPair.privateKey, { encoding: 'utf8', mode: 0o600 });
  const file = await writeConfig({ accounts: { [KEY_USERNAME]: { auth: { type: 'privateKey', privateKeyPath: keyFile } } } });
  const store = new ConfigStore(file);
  await store.confirmHostKey(endpoint(), expectedFingerprint);
  const pool = new ConnectionPool(store);
  try {
    const readyBefore = readyConnections;
    const lease = await pool.acquire(target(KEY_USERNAME));
    assert.equal(readyConnections, readyBefore + 1);
    await lease.release();
  } finally {
    await pool.dispose();
  }
});

test('opens a new generation for changed credentials without touching a live connection', async () => {
  const file = await writeConfig({
    hostKeyFingerprint: expectedFingerprint,
    accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } },
  });
  const pool = new ConnectionPool(new ConfigStore(file));
  try {
    const first = await pool.acquire(target());
    // Rotate the credential while the first lease is still active, then write
    // the file the way an operator would (same key, new password).
    const document = JSON.parse(await fs.readFile(file, 'utf8')) as {
      servers: Record<string, Record<string, { accounts: Record<string, { auth: { password: string } }> }>>;
    };
    document.servers['127.0.0.1']![String(port)]!.accounts[USERNAME]!.auth.password = 'rotated';
    await fs.writeFile(file, JSON.stringify(document, null, 2), { encoding: 'utf8', mode: 0o600 });

    const readyBefore = readyConnections;
    const second = await pool.acquire(target());
    assert.notEqual(second.client, first.client);
    assert.equal(readyConnections, readyBefore + 1);
    await first.release();
    await second.release();
  } finally {
    await pool.dispose();
  }
});

test('dispose closes owned connections and refuses further acquisitions', async () => {
  const file = await writeConfig({
    hostKeyFingerprint: expectedFingerprint,
    accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } },
  });
  const pool = new ConnectionPool(new ConfigStore(file), { readyTimeoutMs: 2000 });
  const lease = await pool.acquire(target());
  const closed = new Promise<void>((resolve) => lease.client.once('close', () => resolve()));
  await pool.dispose();
  await closed;
  await expectCode(pool.acquire(target()), 'CONNECTION_LOST');
});


// These races mutate only generated loopback configuration/observation fixtures.
const alternateFingerprint = `SHA256:${Buffer.alloc(32, 90).toString('base64').replace(/=+$/, '')}`;

test('R01 a stale approval cannot overwrite another instance\'s newer trust pin', async () => {
  const file = await writeConfig({ accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } } });
  const pool = new ConnectionPool(new ConfigStore(file));
  try {
    await expectCode(pool.acquire(target()), 'HOST_KEY_UNTRUSTED');
    await new ConfigStore(file).confirmHostKey(endpoint(), alternateFingerprint);
    const before = await fs.readFile(file, 'utf8');
    await expectCode(pool.confirmHostKey(endpoint(), expectedFingerprint), 'HOST_KEY_MISMATCH');
    assert.equal(await fs.readFile(file, 'utf8'), before, 'a stale approval must leave the current file byte-identical');
  } finally { await pool.dispose(); }
});

test('R01 trust changed while the configuration lock is held is revalidated under that lock', async () => {
  const file = await writeConfig({ accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } } });
  const pool = new ConnectionPool(new ConfigStore(file));
  const lockPath = `${file}.lock`;
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  let approval: Promise<unknown> | undefined;
  try {
    await expectCode(pool.acquire(target()), 'HOST_KEY_UNTRUSTED');
    lock = await fs.open(lockPath, 'wx', 0o600);
    approval = pool.confirmHostKey(endpoint(), expectedFingerprint);
    void approval.catch(() => undefined);
    // This test owns the competing writer's lock, and commits only its own fixture.
    const document = JSON.parse(await fs.readFile(file, 'utf8'));
    document.servers['127.0.0.1'][String(port)].hostKeyFingerprint = alternateFingerprint;
    await fs.writeFile(file, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
    const before = await fs.readFile(file, 'utf8');
    await lock.close(); lock = undefined; await fs.unlink(lockPath);
    await expectCode(approval, 'HOST_KEY_MISMATCH');
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally {
    if (lock) { await lock.close(); await fs.unlink(lockPath); }
    await approval?.catch(() => undefined);
    await pool.dispose();
  }
});

test('R01 a candidate changed during temporary-file sync is rejected before publication', async t => {
  const file = await writeConfig({ accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } } });
  const pool = new ConnectionPool(new ConfigStore(file));
  try {
    await expectCode(pool.acquire(target()), 'HOST_KEY_UNTRUSTED');
    const before = await fs.readFile(file, 'utf8');
    // Private observation metadata is deliberately controlled here; no real
    // host key/config is changed and no production-only testing API is added.
    const observations = (pool as unknown as { observed: Map<string, Record<string, unknown>> }).observed;
    const key = endpointKey(endpoint());
    const originalOpen = fs.open.bind(fs);
    let changed = false;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const originalSync = handle.sync.bind(handle);
        t.mock.method(handle, 'sync', async () => {
          observations.set(key, { ...observations.get(key), fingerprint: alternateFingerprint });
          changed = true;
          await originalSync();
        });
      }
      return handle;
    });
    await expectCode(pool.confirmHostKey(endpoint(), expectedFingerprint), 'HOST_KEY_MISMATCH');
    assert.equal(changed, true, 'the competing observation happened during sync');
    assert.equal(await fs.readFile(file, 'utf8'), before);
    const prefix = `.${path.basename(file)}.`;
    assert.equal((await fs.readdir(RUN_DIR)).some(name => name.startsWith(prefix) && name.endsWith('.tmp')), false, 'only the owned temporary is cleaned up');
  } finally { t.mock.restoreAll(); await pool.dispose(); }
});


test('R01 guarded repeat stays idempotent after another endpoint changes', async () => {
  const file = await writeConfig({ accounts: { [USERNAME]: { auth: { type: 'password', password: PASSWORD } } } });
  const otherPort = port === 65535 ? port - 1 : port + 1;
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.servers['127.0.0.1'][String(otherPort)] = { label: 'independent fixture endpoint', accounts: { another: { auth: { type: 'password', password: 'fixture-other-password' } } } };
  await fs.writeFile(file, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
  const pool = new ConnectionPool(new ConfigStore(file));
  try {
    await expectCode(pool.acquire(target()), 'HOST_KEY_UNTRUSTED');
    await pool.confirmHostKey(endpoint(), expectedFingerprint);
    await new ConfigStore(file).confirmHostKey({ ip: '127.0.0.1', port: otherPort }, alternateFingerprint);
    const before = await fs.readFile(file, 'utf8');
    const result = await pool.confirmHostKey(endpoint(), expectedFingerprint);
    assert.equal(result.changed, false);
    assert.equal(await fs.readFile(file, 'utf8'), before, 'no rewrite or global-generation false conflict');
  } finally { await pool.dispose(); }
});
