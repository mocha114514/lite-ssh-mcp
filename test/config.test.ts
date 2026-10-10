import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fixtureRoot } from './helpers/workspace.js';
import { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';

/**
 * Fixtures live only under the private `vb-test/m0/<run>` tree (git-ignored).
 * The files are intentionally left behind on success so a failing run can be
 * inspected; nothing outside this run directory is ever removed.
 */
const RUN_DIR = fixtureRoot('config');
const FP_A = `SHA256:${'A'.repeat(43)}`;
const FP_B = `SHA256:${'B'.repeat(43)}`;

let serial = 0;

async function writeFixture(name: string, content: string): Promise<string> {
  await fs.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUN_DIR, `${String(serial += 1).padStart(3, '0')}-${name}.json`);
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  return file;
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

const HIERARCHY = JSON.stringify({
  version: 2,
  servers: {
    '192.0.2.10': {
      '22': {
        label: 'primary',
        hostKeyFingerprint: FP_A,
        accounts: {
          deploy: { auth: { type: 'password', password: 'SUPERSECRET0' } },
          builder: { auth: { type: 'privateKey', privateKeyPath: '~/.ssh/id_ed25519', passphrase: 'PASSPHRASE0' } },
        },
      },
      '2222': { label: 'alt', accounts: { admin: { auth: { type: 'password', password: 'SUPERSECRET1' } } } },
    },
    '192.0.2.11': { '22': { accounts: { deploy: { auth: { type: 'password', password: 'SUPERSECRET2' } } } } },
  },
}, null, 2);

test('lists every configured login combination without credentials', async () => {
  const store = new ConfigStore(await writeFixture('hierarchy', HIERARCHY));
  const listing = await store.listConfigurations();
  const seen = new Set(listing.map((target) => JSON.stringify([target.ip, target.port, target.username])));
  assert.equal(listing.length, 4);
  assert.ok(seen.has(JSON.stringify(['192.0.2.10', 22, 'deploy'])));
  assert.ok(seen.has(JSON.stringify(['192.0.2.10', 22, 'builder'])));
  assert.ok(seen.has(JSON.stringify(['192.0.2.10', 2222, 'admin'])));
  assert.ok(seen.has(JSON.stringify(['192.0.2.11', 22, 'deploy'])));
  for (const target of listing) {
    // A public projection carries addressing only: no password, passphrase or key path.
    assert.deepEqual(Object.keys(target).sort(), ['ip', 'port', 'username']);
    assert.ok(!JSON.stringify(target).includes('SUPERSECRET'));
  }
});

test('loads lazily and reports a missing configuration', async () => {
  const store = new ConfigStore(path.join(RUN_DIR, 'absent', 'config.json'));
  await expectCode(store.listConfigurations(), 'CONFIG_NOT_FOUND');
});

test('rejects duplicate keys, including escaped spellings', async () => {
  await expectCode(
    new ConfigStore(await writeFixture('dup-top', '{"version":2,"servers":{},"servers":{}}')).listConfigurations(),
    'CONFIG_INVALID',
  );
  const escaped = '{"version":2,"servers":{"192.0.2.10":{"22":{"accounts":{'
    + '"acct":{"auth":{"type":"password","password":"x"}},'
    + '"\\u0061cct":{"auth":{"type":"password","password":"x"}}}}}}}';
  const error = await expectCode(new ConfigStore(await writeFixture('dup-escaped', escaped)).listConfigurations(), 'CONFIG_INVALID');
  assert.ok(error.message.toLowerCase().includes('duplicate'));
});

test('rejects an unsupported configuration version', async () => {
  const store = new ConfigStore(await writeFixture('version', '{"version":1,"servers":{}}'));
  await expectCode(store.listConfigurations(), 'CONFIG_VERSION_ERROR');
});

test('rejects canonical IP and port collisions', async () => {
  const ipCollision = '{"version":2,"servers":{'
    + '"::1":{"22":{"accounts":{}}},'
    + '"0:0:0:0:0:0:0:1":{"22":{"accounts":{}}}}}';
  await expectCode(new ConfigStore(await writeFixture('ip-collision', ipCollision)).listConfigurations(), 'CONFIG_INVALID');

  const portCollision = '{"version":2,"servers":{"192.0.2.10":{'
    + '"22":{"accounts":{}},"022":{"accounts":{}}}}}';
  await expectCode(new ConfigStore(await writeFixture('port-collision', portCollision)).listConfigurations(), 'CONFIG_INVALID');
});

test('rejects malformed structure without echoing credentials', async () => {
  const store = new ConfigStore(await writeFixture('malformed', '{"version":2,"servers":[]}'));
  await expectCode(store.listConfigurations(), 'CONFIG_INVALID');

  const missingPassword = '{"version":2,"servers":{"192.0.2.10":{"22":{"accounts":{"deploy":{"auth":{"type":"password"}}}}}}}';
  const error = await expectCode(new ConfigStore(await writeFixture('missing-password', missingPassword)).listConfigurations(), 'CONFIG_INVALID');
  assert.ok(!error.message.includes('deploy'));
});

test('resolves one login and derives an opaque revision from auth and trust pin', async () => {
  const store = new ConfigStore(await writeFixture('resolve', HIERARCHY));
  const resolved = await store.resolveLogin({ ip: '192.0.2.10', port: 22, username: 'deploy' });
  assert.deepEqual(resolved.target, { ip: '192.0.2.10', port: 22, username: 'deploy' });
  assert.deepEqual(resolved.auth, { type: 'password', password: 'SUPERSECRET0' });
  assert.equal(resolved.hostKeyFingerprint, FP_A);
  assert.match(resolved.revision, /^[0-9a-f]{64}$/);

  const keyed = await store.resolveLogin({ ip: '192.0.2.10', port: 22, username: 'builder' });
  assert.equal(keyed.auth.type, 'privateKey');
  assert.equal((keyed.auth as { privateKeyPath: string }).privateKeyPath, '~/.ssh/id_ed25519');
  assert.notEqual(keyed.revision, resolved.revision);
});

test('derives a different revision when the credential or trust pin changes', async () => {
  const base = new ConfigStore(await writeFixture('rev-base', HIERARCHY));
  const changedPassword = new ConfigStore(await writeFixture('rev-password', HIERARCHY.replace('SUPERSECRET0', 'ROTATED')));
  const changedFingerprint = new ConfigStore(await writeFixture('rev-fingerprint', HIERARCHY.replace(FP_A, FP_B)));
  const target = { ip: '192.0.2.10', port: 22, username: 'deploy' };
  const baseRevision = (await base.resolveLogin(target)).revision;
  assert.notEqual((await changedPassword.resolveLogin(target)).revision, baseRevision);
  assert.notEqual((await changedFingerprint.resolveLogin(target)).revision, baseRevision);
});

test('does not guess or fall back to another account or endpoint', async () => {
  const store = new ConfigStore(await writeFixture('no-fallback', HIERARCHY));
  await expectCode(store.resolveLogin({ ip: '192.0.2.10', port: 22, username: 'root' }), 'ACCOUNT_NOT_FOUND');
  await expectCode(store.resolveLogin({ ip: '192.0.2.10', port: 2200, username: 'deploy' }), 'CONFIG_NOT_FOUND');
});

test('confirm preserves every unrelated field and is idempotent', async () => {
  const file = await writeFixture('confirm', HIERARCHY);
  const store = new ConfigStore(file);

  const result = await store.confirmHostKey({ ip: '192.0.2.10', port: 22 }, FP_B);
  assert.deepEqual(result, { changed: true, fingerprint: FP_B });

  const expected = JSON.parse(HIERARCHY) as Record<string, unknown>;
  ((expected.servers as Record<string, Record<string, Record<string, unknown>>>)['192.0.2.10']!['22']!).hostKeyFingerprint = FP_B;
  const afterFirst = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  assert.deepEqual(afterFirst, expected);
  const firstText = await fs.readFile(file, 'utf8');

  const again = await store.confirmHostKey({ ip: '192.0.2.10', port: 22 }, FP_B);
  assert.deepEqual(again, { changed: false, fingerprint: FP_B });
  assert.equal(await fs.readFile(file, 'utf8'), firstText);

  // The trust pin stays scoped to the chosen port.
  await expectCode(Promise.resolve(store.confirmHostKey({ ip: '192.0.2.10', port: 22 }, 'not-a-fingerprint')), 'CONFIG_INVALID');
});

test('confirm matches a non-canonical server key by normalized endpoint', async () => {
  const nonCanonical = '{"version":2,"servers":{'
    + '"0:0:0:0:0:0:0:1":{"22":{"label":"loopback","accounts":{"a":{"auth":{"type":"password","password":"x"}}}}}}}';
  const file = await writeFixture('non-canonical', nonCanonical);
  const store = new ConfigStore(file);
  const result = await store.confirmHostKey({ ip: '::1', port: 22 }, FP_A);
  assert.equal(result.changed, true);
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  const servers = parsed.servers!;
  assert.deepEqual(Object.keys(servers), ['0:0:0:0:0:0:0:1']);
  assert.equal(servers['0:0:0:0:0:0:0:1']!['22']!.hostKeyFingerprint, FP_A);
  assert.equal(servers['0:0:0:0:0:0:0:1']!['22']!.label, 'loopback');
});

test('confirm refuses an endpoint that is absent and never writes the file', async () => {
  const file = await writeFixture('confirm-absent', HIERARCHY);
  const store = new ConfigStore(file);
  const before = await fs.readFile(file, 'utf8');

  // Same address, unconfigured port.
  await expectCode(store.confirmHostKey({ ip: '192.0.2.10', port: 2223 }, FP_B), 'CONFIG_NOT_FOUND');
  // Entirely absent address.
  await expectCode(store.confirmHostKey({ ip: '192.0.2.99', port: 22 }, FP_B), 'CONFIG_NOT_FOUND');

  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(JSON.parse(before), JSON.parse(HIERARCHY));
});

test('confirm reports a missing configuration file', async () => {
  const store = new ConfigStore(path.join(RUN_DIR, 'absent', 'config.json'));
  await expectCode(store.confirmHostKey({ ip: '127.0.0.1', port: 22 }, FP_A), 'CONFIG_NOT_FOUND');
});
