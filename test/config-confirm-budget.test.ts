import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createApplication } from '../src/app.js';
import type { ConfigStore } from '../src/config/store.js';
import { endpointKey } from '../src/core/targets.js';
import { ensurePrivateDirectory } from '../src/platform/permissions.js';
import { fixtureRoot } from './helpers/workspace.js';

const LIMIT = 64;
const TEST_BUDGET_MS = process.platform === 'win32' ? 60_000 : 20_000;
const NATIVE_READY_MS = process.platform === 'win32' ? 30_000 : 5_000;
const target = { ip: '127.0.0.1', port: 22 };
const fingerprint = `SHA256:${'A'.repeat(43)}`;
type Reply = Record<string, unknown>;

/** Each waiter captures its gate; a later reset cannot change its failure. */
class Gate {
  readonly promise: Promise<void>;
  waiters = 0;
  entered = false;
  failed = false;
  private released = false;
  private resolve!: () => void;

  constructor() {
    this.promise = new Promise(resolve => { this.resolve = resolve; });
  }

  async wait(): Promise<void> {
    this.entered = true;
    this.waiters++;
    try { await this.promise; }
    finally { this.waiters--; }
  }

  release(fail: boolean): void {
    if (this.released) return;
    this.released = true;
    this.failed = fail;
    this.resolve();
  }
}

interface OwnedLock {
  handle: FileHandle;
  close: FileHandle['close'];
  nativeCloses: number;
  closed: boolean;
}
interface Hooks {
  directory: string;
  lockPath: string;
  metadata: Gate | undefined;
  close: Gate | undefined;
  locks: OwnedLock[];
}

// Top-level tests are sequential and run in their own Node test-file process.
// ALS limits the metadata fault to confirmation, not readers of the same file.
const confirmContext = new AsyncLocalStorage<boolean>();
const originalLstat = fs.lstat;
const originalOpen = fs.open;
let active: Hooks | undefined;

// A throwing fault branch does not alter lstat's native overload selection;
// every delegated call preserves the original options and result unchanged.
fs.lstat = (async function (this: unknown, ...args: Parameters<typeof originalLstat>) {
  const owner = active;
  const gate = owner?.metadata;
  if (gate && confirmContext.getStore() === true && typeof args[0] === 'string' &&
      path.resolve(args[0]) === owner?.directory) {
    await gate.wait();
    // All 64 delayed calls fail before native permission helpers, avoiding a
    // subprocess storm while still exercising production error retirement.
    if (gate.failed) throw Object.assign(new Error('Owned metadata EIO.'), { code: 'EIO' });
  }
  return Reflect.apply(originalLstat, this, args);
}) as typeof originalLstat;

fs.open = async function (this: unknown, ...args: Parameters<typeof originalOpen>) {
  const handle: FileHandle = await Reflect.apply(originalOpen, this, args);
  const owner = active;
  if (!owner || args[1] !== 'wx' || typeof args[0] !== 'string' ||
      path.resolve(args[0]) !== owner.lockPath || confirmContext.getStore() !== true) {
    return handle;
  }
  const lock: OwnedLock = { handle, close: handle.close, nativeCloses: 0, closed: false };
  owner.locks.push(lock);
  let completion: Promise<void> | undefined;
  handle.close = function (this: FileHandle, ...closeArgs: Parameters<FileHandle['close']>) {
    // Keep the same result, including any real close rejection, on repeated
    // calls. The synthetic failure happens ONLY after a confirmed real close.
    completion ??= (async () => {
      const gate = owner.close;
      if (gate) await gate.wait();
      lock.nativeCloses++;
      await Reflect.apply(lock.close, this, closeArgs);
      lock.closed = true;
      if (gate?.failed) throw Object.assign(new Error('Owned post-close EIO.'), { code: 'EIO' });
    })();
    return completion;
  };
  return handle;
};
syncBuiltinESMExports();
after(() => {
  fs.lstat = originalLstat;
  fs.open = originalOpen;
  syncBuiltinESMExports();
});

async function until(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Owned fixture did not reach ${label}.`);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function expectLimit(work: Promise<Reply>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Quota must reject before the metadata gate is released.')), 3_000);
      })
    ]);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'RESOURCE_LIMIT');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function expectMetadataFailure(reply: Reply): void {
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'FILE_PERMISSION_ERROR');
}

async function fixture() {
  const root = fixtureRoot('config-confirm-budget', randomUUID());
  const directory = path.resolve(root, 'store');
  await ensurePrivateDirectory(directory);
  const configPath = path.join(directory, 'config.json');
  const initial = JSON.stringify({
    version: 2,
    servers: {
      [target.ip]: {
        [String(target.port)]: {
          hostKeyFingerprint: fingerprint,
          accounts: { synthetic: { auth: { type: 'password', password: 'owned-fixture-only' } } }
        }
      }
    }
  }, null, 2);
  await fs.writeFile(configPath, initial, { flag: 'wx', mode: 0o600 });
  const hooks: Hooks = {
    directory, lockPath: `${configPath}.lock`, metadata: undefined, close: undefined, locks: []
  };
  active = hooks;
  const app = createApplication({ configPath, cacheRoot: path.join(root, 'cache') });
  // This fixture seeds an already-observed candidate, not a live SSH handshake.
  const observed = (app.pool as unknown as { observed: Map<string, unknown> }).observed;
  observed.set(endpointKey(target), {
    fingerprint, keyType: 'ssh-ed25519', configuredFingerprint: fingerprint
  });
  const business = new Set<Promise<unknown>>();
  const originalConfirm = app.store.confirmHostKey;
  app.store.confirmHostKey = function (this: ConfigStore, ...args: Parameters<ConfigStore['confirmHostKey']>) {
    return confirmContext.run(true, () => {
      const work = Reflect.apply(originalConfirm, this, args) as ReturnType<ConfigStore['confirmHostKey']>;
      business.add(work);
      void work.then(() => business.delete(work), () => business.delete(work));
      return work; // Original promise; no source quota counter is changed.
    });
  };
  const client = new Client({ name: 'owned-confirmation-budget', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);
  const pending = new Set<Promise<Reply>>();
  const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Reply> => {
    const work = client.callTool({ name, arguments: args }, undefined, { signal })
      .then(result => result.structuredContent as Reply);
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const gates: Gate[] = [];
  const blockMetadata = (): Gate => {
    assert.equal(hooks.metadata, undefined);
    const gate = new Gate();
    gates.push(gate);
    hooks.metadata = gate;
    return gate;
  };
  const releaseMetadata = (): void => {
    hooks.metadata?.release(true);
    hooks.metadata = undefined;
  };
  const blockClose = (): Gate => {
    assert.equal(hooks.close, undefined);
    const gate = new Gate();
    gates.push(gate);
    hooks.close = gate;
    return gate;
  };
  return {
    store: app.store, hooks, blockMetadata, releaseMetadata, blockClose,
    confirm: (signal?: AbortSignal) => call('lite_ssh_confirm_host_key', { ...target, fingerprint }, signal),
    list: () => call('lite_ssh_list_configurations', {}),
    inFlight: () => business.size,
    joinBusiness: () => Promise.allSettled([...business]),
    assertUnchanged: async () => assert.equal(await fs.readFile(configPath, 'utf8'), initial),
    async cleanup(): Promise<void> {
      // Even a RED assertion releases every gate and joins real work separately
      // from aborted SDK observations. Roots remain for authorized final cleanup.
      for (const gate of gates) gate.release(gate !== hooks.close);
      hooks.metadata = undefined;
      hooks.close = undefined;
      await Promise.allSettled([...business]);
      await Promise.allSettled([...pending]);
      app.store.confirmHostKey = originalConfirm;
      active = undefined;
      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); } catch (error) { failures.push(error); }
      };
      await attempt(() => client.close());
      await attempt(() => app.close());
      for (const lock of hooks.locks) {
        if (!lock.closed) {
          await attempt(async () => {
            lock.nativeCloses++;
            await Reflect.apply(lock.close, lock.handle, []);
            lock.closed = true;
          });
        }
        await attempt(async () => {
          assert.equal(lock.closed, true);
          assert.equal(lock.nativeCloses, 1);
        });
      }
      await attempt(async () => assert.equal(business.size, 0));
      await attempt(() => assert.rejects(originalLstat(hooks.lockPath), { code: 'ENOENT' }));
      await attempt(async () => {
        const names = await fs.readdir(directory);
        assert.deepEqual(names.filter(name => name.endsWith('.lock') || name.includes('.tmp')), []);
      });
      await attempt(async () => assert.equal(await fs.readFile(configPath, 'utf8'), initial));
      if (failures.length) throw new AggregateError(failures, 'Owned confirmation fixture cleanup failed.');
    }
  };
}

test('F14 confirmation 64/65 rejects before metadata; invalid input and readers stay independent', { timeout: TEST_BUDGET_MS }, async () => {
  const f = await fixture();
  try {
    const gate = f.blockMetadata();
    const calls = Array.from({ length: LIMIT }, () => f.confirm());
    await until(() => gate.waiters === LIMIT, '64 metadata waiters');
    await expectLimit(f.confirm());
    await expectLimit(f.confirm());
    assert.equal(gate.waiters, LIMIT);
    assert.equal(f.hooks.locks.length, 0);
    // Public schema/Pool also validate inputs. This checks STORE validation
    // precedence directly, rather than inventing a malformed observed key.
    await assert.rejects(f.store.confirmHostKey(target, 'malformed-fingerprint'), { code: 'CONFIG_INVALID' });
    await expectLimit(f.confirm());
    const list = await f.list();
    assert.equal(list.ok, true);
    assert.deepEqual(list.configurations, [{ ...target, username: 'synthetic' }]);
    f.releaseMetadata();
    for (const reply of await Promise.all(calls)) expectMetadataFailure(reply);
    await f.joinBusiness();
    assert.equal(f.inFlight(), 0);
    const freshGate = f.blockMetadata();
    const fresh = f.confirm();
    await until(() => freshGate.waiters === 1, 'fresh admitted confirmation');
    f.releaseMetadata();
    expectMetadataFailure(await fresh);
  } finally { await f.cleanup(); }
});

test('F14 SDK cancellation retains all 64 actual confirmation credits until work retires', { timeout: TEST_BUDGET_MS }, async () => {
  const f = await fixture();
  try {
    const gate = f.blockMetadata();
    const controllers = Array.from({ length: LIMIT }, () => new AbortController());
    const reasons = controllers.map(() => new McpError(ErrorCode.RequestTimeout, 'Owned observer cancellation.'));
    const calls = controllers.map(controller => f.confirm(controller.signal));
    await until(() => gate.waiters === LIMIT, '64 metadata waiters');
    for (let index = 0; index < LIMIT; index++) controllers[index]!.abort(reasons[index]);
    for (let index = 0; index < LIMIT; index++) {
      await assert.rejects(calls[index]!, error => error === reasons[index]);
    }
    assert.equal(gate.waiters, LIMIT);
    assert.equal(f.inFlight(), LIMIT);
    await expectLimit(f.confirm());
    f.releaseMetadata();
    await f.joinBusiness();
    assert.equal(f.inFlight(), 0);
    const freshGate = f.blockMetadata();
    const fresh = f.confirm();
    await until(() => freshGate.waiters === 1, 'post-cancel admitted confirmation');
    f.releaseMetadata();
    expectMetadataFailure(await fresh);
  } finally { await f.cleanup(); }
});

for (const failClose of [false, true]) {
  test(`F14 lock cleanup holds its credit until ${failClose ? 'failure' : 'success'} retires`, { timeout: TEST_BUDGET_MS }, async () => {
    const f = await fixture();
    try {
      const close = f.blockClose();
      const first = f.confirm();
      await until(() => close.entered, 'owned lock-close finalizer', NATIVE_READY_MS);
      assert.equal(f.inFlight(), 1);
      const metadata = f.blockMetadata();
      const calls = Array.from({ length: LIMIT - 1 }, () => f.confirm());
      await until(() => metadata.waiters === LIMIT - 1, '63 metadata waiters');
      assert.equal(f.inFlight(), LIMIT);
      await expectLimit(f.confirm());
      close.release(failClose);
      const result = await first;
      if (failClose) {
        assert.equal(result.ok, false);
        assert.equal(result.code, 'CONFIG_LOCK_CLEANUP_FAILED');
        assert.equal(result.confirmationCompleted, true);
        assert.equal(result.configurationChanged, false);
        assert.deepEqual(result.lockCleanup, {
          complete: false, removalConfirmed: true, handleCloseConfirmed: false
        });
      } else {
        assert.equal(result.ok, true);
        assert.equal(result.changed, false);
        assert.equal(result.fingerprint, fingerprint);
      }
      assert.equal(f.hooks.locks.length, 1);
      assert.equal(f.hooks.locks[0]!.closed, true);
      assert.equal(f.hooks.locks[0]!.nativeCloses, 1);
      await f.assertUnchanged();
      const fresh = f.confirm();
      await until(() => metadata.waiters === LIMIT, 'reused cleanup credit');
      f.releaseMetadata();
      for (const reply of await Promise.all([...calls, fresh])) expectMetadataFailure(reply);
      await f.joinBusiness();
      assert.equal(f.inFlight(), 0);
    } finally { await f.cleanup(); }
  });
}

test('F14 control: 128 failed metadata acquisitions retire credits without a cumulative cap', { timeout: TEST_BUDGET_MS }, async () => {
  const f = await fixture();
  try {
    for (let batch = 0; batch < 2; batch++) {
      const gate = f.blockMetadata();
      const calls = Array.from({ length: LIMIT }, () => f.confirm());
      await until(() => gate.waiters === LIMIT, '64 failing acquisitions');
      f.releaseMetadata();
      for (const reply of await Promise.all(calls)) expectMetadataFailure(reply);
      await f.joinBusiness();
      assert.equal(f.inFlight(), 0);
    }
    assert.equal(f.hooks.locks.length, 0);
  } finally { await f.cleanup(); }
});

test('F14 control: normal idempotent confirmation preserves the file and closes its one lock', { timeout: TEST_BUDGET_MS }, async () => {
  const f = await fixture();
  try {
    const reply = await f.confirm();
    assert.equal(reply.ok, true);
    assert.equal(reply.state, 'host_key_confirmed');
    assert.equal(reply.changed, false);
    assert.equal(reply.fingerprint, fingerprint);
    assert.equal(f.hooks.locks.length, 1);
    assert.equal(f.hooks.locks[0]!.closed, true);
    assert.equal(f.hooks.locks[0]!.nativeCloses, 1);
    await f.assertUnchanged();
  } finally { await f.cleanup(); }
});
