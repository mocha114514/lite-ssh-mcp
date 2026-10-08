import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ensureConfigurationFiles } from '../src/config/bootstrap.js';
import { EMPTY_CONFIG_TEXT, EXAMPLE_CONFIG_TEXT } from '../src/config/templates.js';
import { ConfigStore } from '../src/config/store.js';
import { LiteSshError } from '../src/core/errors.js';

// All files and injected failures stay in this run's owned private fixture tree.
const RUN = path.resolve('vb-test/m0/first-run/unit', `${process.pid}-${Date.now()}`);
let serial = 0;
const fixture = (name: string): string => path.join(RUN, `${++serial}-${name}`, '.lite-ssh', 'config.json');
const examplePath = (config: string): string => path.join(path.dirname(config), 'config.example.json');
const leftovers = async (config: string): Promise<string[]> => (await fs.readdir(path.dirname(config))).filter(name => name.endsWith('.init.tmp'));

async function expectInitializationFailure(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, error => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'CONFIG_INIT_FAILED');
    assert.ok(error.message.includes('permissions'));
    return true;
  });
}

test('first run creates complete valid empty config and a separate example', async () => {
  const config = fixture('fresh');
  assert.deepEqual(await ensureConfigurationFiles(config), { configCreated: true, exampleCreated: true });
  assert.equal(await fs.readFile(config, 'utf8'), EMPTY_CONFIG_TEXT);
  assert.equal(await fs.readFile(examplePath(config), 'utf8'), EXAMPLE_CONFIG_TEXT);
  assert.deepEqual(await new ConfigStore(config).listConfigurations(), []);
  assert.deepEqual(await leftovers(config), []);
});

test('example demonstrates two IPs, two ports per IP and two accounts per port', async () => {
  const config = fixture('hierarchy');
  await ensureConfigurationFiles(config);
  const example = JSON.parse(await fs.readFile(examplePath(config), 'utf8')) as {
    version: number; servers: Record<string, Record<string, { accounts: Record<string, { auth: { type: string; password: string } }>; hostKeyFingerprint?: string }>>;
  };
  assert.equal(example.version, 2);
  assert.equal(Object.keys(example.servers).length, 2);
  for (const ports of Object.values(example.servers)) {
    assert.equal(Object.keys(ports).length, 2);
    for (const port of Object.values(ports)) {
      assert.equal(Object.keys(port.accounts).length, 2);
      assert.equal(port.hostKeyFingerprint, undefined);
      for (const account of Object.values(port.accounts)) {
        assert.equal(account.auth.type, 'password');
        assert.match(account.auth.password, /^<.+>$/u);
      }
    }
  }
  const logins = await new ConfigStore(examplePath(config)).listConfigurations();
  assert.equal(logins.length, 8); // Same strict V2 parser, not an approximate test validator.
  assert.equal(new Set(logins.map(login => JSON.stringify(login))).size, 8);
  assert.deepEqual(await new ConfigStore(config).listConfigurations(), []);
});

test('a second initialization preserves both file bytes and modification times', async () => {
  const config = fixture('repeat');
  await ensureConfigurationFiles(config);
  const files = [config, examplePath(config)];
  const historical = new Date('2010-01-02T03:04:05Z');
  for (const file of files) await fs.utimes(file, historical, historical);
  const before = await Promise.all(files.map(async file => ({ bytes: await fs.readFile(file), modified: (await fs.stat(file)).mtimeMs })));
  assert.deepEqual(await ensureConfigurationFiles(config), { configCreated: false, exampleCreated: false });
  for (let i = 0; i < files.length; i++) {
    assert.deepEqual(await fs.readFile(files[i]!), before[i]!.bytes);
    assert.equal((await fs.stat(files[i]!)).mtimeMs, before[i]!.modified);
  }
});

test('existing files are never read or parsed during initialization', async () => {
  const config = fixture('no-read');
  await fs.mkdir(path.dirname(config), { recursive: true });
  const original = Buffer.from([0xff, 0x00, 0x01]); // Deliberately not JSON/UTF-8.
  await fs.writeFile(config, original);
  await fs.writeFile(examplePath(config), 'user-owned example');
  const spy = mock.method(fs, 'readFile', async () => { throw new Error('Unexpected bootstrap content read.'); });
  try {
    assert.deepEqual(await ensureConfigurationFiles(config), { configCreated: false, exampleCreated: false });
    assert.equal(spy.mock.calls.length, 0);
  } finally { spy.mock.restore(); }
  assert.deepEqual(await fs.readFile(config), original);
  assert.equal(await fs.readFile(examplePath(config), 'utf8'), 'user-owned example');
});

test('missing example is created without changing an existing config', async () => {
  const config = fixture('only-example');
  await fs.mkdir(path.dirname(config), { recursive: true });
  const original = 'existing user content, even if invalid';
  await fs.writeFile(config, original);
  assert.deepEqual(await ensureConfigurationFiles(config), { configCreated: false, exampleCreated: true });
  assert.equal(await fs.readFile(config, 'utf8'), original);
  assert.equal(await fs.readFile(examplePath(config), 'utf8'), EXAMPLE_CONFIG_TEXT);
});

test('missing live config is created without changing an existing example', async () => {
  const config = fixture('only-config');
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(examplePath(config), 'edited example');
  assert.deepEqual(await ensureConfigurationFiles(config), { configCreated: true, exampleCreated: false });
  assert.equal(await fs.readFile(config, 'utf8'), EMPTY_CONFIG_TEXT);
  assert.equal(await fs.readFile(examplePath(config), 'utf8'), 'edited example');
});

test('concurrent initializers publish once and never expose partial live JSON', async () => {
  const config = fixture('concurrent');
  const results = await Promise.all(Array.from({ length: 20 }, async () => {
    const result = await ensureConfigurationFiles(config);
    assert.deepEqual(await new ConfigStore(config).listConfigurations(), []);
    return result;
  }));
  assert.equal(results.filter(result => result.configCreated).length, 1);
  assert.equal(results.filter(result => result.exampleCreated).length, 1);
  assert.equal(await fs.readFile(examplePath(config), 'utf8'), EXAMPLE_CONFIG_TEXT);
  assert.deepEqual(await leftovers(config), []);
});

test('a blocked directory reports an initialization error without altering the blocker', async () => {
  const config = fixture('blocked');
  await fs.mkdir(path.dirname(path.dirname(config)), { recursive: true });
  await fs.writeFile(path.dirname(config), 'owned fixture blocker');
  await expectInitializationFailure(ensureConfigurationFiles(config));
  assert.equal(await fs.readFile(path.dirname(config), 'utf8'), 'owned fixture blocker');
});

test('a publication failure is reported and removes only its owned temporary file', async () => {
  const config = fixture('publication-failure');
  await fs.mkdir(path.dirname(config), { recursive: true });
  const unrelated = path.join(path.dirname(config), '.unrelated.init.tmp');
  await fs.writeFile(unrelated, 'not owned by bootstrap');
  const spy = mock.method(fs, 'link', async () => { throw Object.assign(new Error('fake unsupported publication'), { code: 'ENOTSUP' }); });
  try { await expectInitializationFailure(ensureConfigurationFiles(config)); }
  finally { spy.mock.restore(); }
  assert.deepEqual(await fs.readdir(path.dirname(config)), ['.unrelated.init.tmp']);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'not owned by bootstrap');
});
