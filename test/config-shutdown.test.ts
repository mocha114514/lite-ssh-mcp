import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createApplication } from '../src/app.js';
import { fingerprintOf } from '../src/config/fingerprint.js';
import type { ConfigStore } from '../src/config/store.js';
import { CleanupError } from '../src/core/cleanup.js';
import { LiteSshError, publicError } from '../src/core/errors.js';
import { endpointKey } from '../src/core/targets.js';
import type { LoginTarget } from '../src/core/types.js';
import { ensurePrivateDirectory, unlinkOwnedFile } from '../src/platform/permissions.js';
import { fixtureRoot } from './helpers/workspace.js';

// Harness budgets: outer Windows 60s / other 30s; readiness Windows 30s / other 10s.
const TEST_BUDGET_MS = process.platform === 'win32' ? 60_000 : 30_000;
const NATIVE_READY_MS = process.platform === 'win32' ? 30_000 : 10_000;
const target: LoginTarget = { ip: '127.0.0.1', port: 22, username: 'synthetic' };

function makeFingerprint(seed: string): string {
  return fingerprintOf(createHash('sha256').update(seed).digest());
}
const fingerprint = makeFingerprint('owned-initial-trust-seed');
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, timeoutMs = NATIVE_READY_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Owned fixture did not reach ${label}.`);
    await delay(5);
  }
}

/** Explicit gate coordinates async boundaries without polling or timeout reliance. */
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
  release(fail = false): void {
    if (this.released) return;
    this.released = true;
    this.failed = fail;
    this.resolve();
  }
}

interface OwnedHandle {
  kind: 'reader' | 'lock' | 'temp';
  targetPath: string;
  handle: FileHandle;
  close: FileHandle['close'];
  nativeCloses: number;
  closed: boolean;
}

interface Hooks {
  directory: string;
  configPath: string;
  lockPath: string;
  metadataGate?: Gate;
  closeGates: { reader?: Gate; lock?: Gate; temp?: Gate };
  handles: OwnedHandle[];
  nativeLstatCount: number;
  nativeOpenCount: number;
  temporaryWriteFault?: { path: string; renameCalls: number; removalChecks: number };
}

// Scopes hooks strictly to active Store operations on owned paths.
const storeContext = new AsyncLocalStorage<boolean>();
const originalLstat = fs.lstat;
const originalOpen = fs.open;
const originalRename = fs.rename;
let active: Hooks | undefined;

// Wrapped fs.promises.lstat counts native calls and delegates preserving options/results/throws.
fs.lstat = (async function (this: unknown, ...args: Parameters<typeof originalLstat>) {
  const owner = active;
  const isOwned = Boolean(owner && typeof args[0] === 'string' && path.resolve(args[0]) === owner.configPath);
  const temporary = owner?.temporaryWriteFault;
  if (temporary && storeContext.getStore() === true && temporary.renameCalls > 0 &&
      typeof args[0] === 'string' && path.resolve(args[0]) === temporary.path) {
    temporary.removalChecks++;
    // Fail only the post-rename owned removal guard, on both OS branches.
    throw Object.assign(new Error('Owned temporary cleanup EIO.'), { code: 'EIO' });
  }
  const gate = owner?.metadataGate;
  if (gate && storeContext.getStore() === true && isOwned) {
    await gate.wait();
    if (gate.failed) throw Object.assign(new Error('Owned metadata EIO.'), { code: 'EIO' });
  }
  if (isOwned) owner!.nativeLstatCount++; // Count the actual delegated API call, not a held attempt.
  return Reflect.apply(originalLstat, this, args);
}) as typeof originalLstat;

// Wrapped fs.promises.open captures exact handles with strict lowercase 12-hex temp suffix.
fs.open = async function (this: unknown, ...args: Parameters<typeof originalOpen>) {
  const owner = active;
  const resolved = typeof args[0] === 'string' ? path.resolve(args[0]) : undefined;
  let kind: 'reader' | 'lock' | 'temp' | undefined;
  if (owner && resolved) {
    const dir = path.dirname(resolved);
    const base = path.basename(resolved);
    const configBase = path.basename(owner.configPath);
    if (resolved === owner.configPath) kind = 'reader';
    else if (resolved === owner.lockPath) kind = 'lock';
    else if (dir === owner.directory) {
      const prefix = `.${configBase}.${process.pid}.`;
      if (base.startsWith(prefix) && base.endsWith('.tmp') && /^[0-9a-f]{12}$/.test(base.slice(prefix.length, -4))) {
        kind = 'temp';
      }
    }
  }
  if (owner && kind) owner.nativeOpenCount++;

  const handle: FileHandle = await Reflect.apply(originalOpen, this, args);
  if (!owner || storeContext.getStore() !== true || !kind || !resolved) return handle;

  const owned: OwnedHandle = {
    kind, targetPath: resolved, handle, close: handle.close, nativeCloses: 0, closed: false
  };
  owner.handles.push(owned);
  let completion: Promise<void> | undefined;

  // Memoize outcome across repeated calls; call real FileHandle.close before synthetic rejection.
  handle.close = function (this: FileHandle, ...closeArgs: Parameters<FileHandle['close']>) {
    completion ??= (async () => {
      const gate = owner.closeGates[kind!];
      if (gate) await gate.wait();
      owned.nativeCloses++;
      await Reflect.apply(owned.close, this, closeArgs);
      owned.closed = true;
      if (gate?.failed) throw Object.assign(new Error(`Owned ${kind} post-close EIO.`), { code: 'EIO' });
    })();
    return completion;
  };
  return handle;
};

// Only this fixture's captured temporary-to-config publication may fail. All
// unrelated calls retain the original native promise/result and receiver.
fs.rename = function (this: unknown, ...args: Parameters<typeof originalRename>) {
  const owner = active;
  const temporary = owner?.temporaryWriteFault;
  if (temporary && storeContext.getStore() === true &&
      typeof args[0] === 'string' && path.resolve(args[0]) === temporary.path &&
      typeof args[1] === 'string' && path.resolve(args[1]) === owner!.configPath) {
    temporary.renameCalls++;
    return Promise.reject(Object.assign(new Error('Owned rename EIO.'), { code: 'EIO' }));
  }
  return Reflect.apply(originalRename, this, args);
};

syncBuiltinESMExports();
after(() => {
  fs.lstat = originalLstat;
  fs.open = originalOpen;
  fs.rename = originalRename;
  syncBuiltinESMExports();
});

type TaggedOutcome = { kind: 'fulfilled'; value: unknown } | { kind: 'rejected'; error: unknown };

/** Bounded rejection helper observes work to tagged outcome and asserts outside catch, never catching assert failures. */
async function expectAdmissionRejection(work: Promise<unknown>, expectedCode: string, timeoutMs = 3_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcomePromise: Promise<TaggedOutcome> = work.then(
    value => ({ kind: 'fulfilled', value }),
    error => ({ kind: 'rejected', error })
  );
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Admission must reject ${expectedCode} before held gate release.`)), timeoutMs);
  });

  let outcome: TaggedOutcome;
  try { outcome = await Promise.race([outcomePromise, timeoutPromise]); }
  finally { if (timer !== undefined) clearTimeout(timer); }

  assert.equal(outcome.kind, 'rejected', `Expected admission to reject with ${expectedCode}, but it resolved.`);
  const err = outcome.error;
  assert.ok(err instanceof LiteSshError, `Expected LiteSshError but got ${String(err)}`);
  assert.equal(err.code, expectedCode);
}

/** Explicitly typed event wrapper preserves original result/promise identity without async re-wrapping. */
function wrapWithEvents<TArgs extends unknown[], TReturn>(
  name: string,
  events: string[],
  orig: (...args: TArgs) => Promise<TReturn>,
  onStart?: () => void
): (...args: TArgs) => Promise<TReturn> {
  return (...args: TArgs): Promise<TReturn> => {
    events.push(`${name}:start`);
    onStart?.();
    let result: Promise<TReturn>;
    try { result = orig(...args); }
    catch (err: unknown) { events.push(`${name}:end`); throw err; }
    void result.then(() => { events.push(`${name}:end`); }, () => { events.push(`${name}:end`); });
    return result;
  };
}

interface ValidatedCloseRegistration { error: unknown; validator: (err: unknown) => boolean; }

async function createShutdownFixture() {
  const root = fixtureRoot('config-shutdown', randomUUID());
  const directory = path.resolve(root, 'store');
  await ensurePrivateDirectory(directory);
  const configPath = path.join(directory, 'config.json');
  const lockPath = `${configPath}.lock`;
  const initialContent = JSON.stringify({
    version: 2,
    servers: {
      [target.ip]: {
        [String(target.port)]: {
          hostKeyFingerprint: fingerprint,
          accounts: { [target.username]: { auth: { type: 'password', password: 'owned-fixture-password-literal' } } }
        }
      }
    }
  }, null, 2);
  await fs.writeFile(configPath, initialContent, { flag: 'wx', mode: 0o600 });

  const hooks: Hooks = {
    directory, configPath, lockPath, metadataGate: undefined, closeGates: {}, handles: [],
    nativeLstatCount: 0, nativeOpenCount: 0
  };
  active = hooks;

  const app = createApplication({ configPath, cacheRoot: path.join(root, 'cache') });
  const observedMap = (app.pool as unknown as { observed: Map<string, unknown> }).observed;
  observedMap.set(endpointKey(target), { fingerprint, keyType: 'ssh-ed25519', configuredFingerprint: fingerprint });

  const business = new Set<Promise<unknown>>();
  const trackBusiness = <T>(promise: Promise<T>): Promise<T> => {
    business.add(promise);
    void promise.then(() => business.delete(promise), () => business.delete(promise));
    return promise;
  };

  const origList = app.store.listConfigurations.bind(app.store);
  const origResolve = app.store.resolveLogin.bind(app.store);
  const origConfirm = app.store.confirmHostKey.bind(app.store);
  app.store.listConfigurations = function (...args) { return storeContext.run(true, () => trackBusiness(Reflect.apply(origList, this, args))); };
  app.store.resolveLogin = function (...args) { return storeContext.run(true, () => trackBusiness(Reflect.apply(origResolve, this, args))); };
  app.store.confirmHostKey = function (...args) { return storeContext.run(true, () => trackBusiness(Reflect.apply(origConfirm, this, args))); };

  const events: string[] = [];
  const stateAtServerStart = { inFlight: -1, lockClosed: false };

  const origTerminalsDispose = app.terminals.dispose.bind(app.terminals);
  app.terminals.dispose = wrapWithEvents('terminals', events, origTerminalsDispose);
  const origTransfersDispose = app.transfers.dispose.bind(app.transfers);
  app.transfers.dispose = wrapWithEvents('transfers', events, origTransfersDispose);
  const origPoolDispose = app.pool.dispose.bind(app.pool);
  app.pool.dispose = wrapWithEvents('pool', events, origPoolDispose);
  const origServerClose = app.server.close.bind(app.server);
  app.server.close = wrapWithEvents('server', events, origServerClose, () => {
    stateAtServerStart.inFlight = business.size;
    const lockHandle = hooks.handles.find(h => h.kind === 'lock');
    stateAtServerStart.lockClosed = lockHandle?.closed ?? false;
  });

  const client = new Client({ name: 'owned-shutdown-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.server.connect(serverTransport);
  await client.connect(clientTransport);

  const sdkObservers = new Set<Promise<Record<string, unknown>>>();
  const callTool = (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const work = client.callTool({ name, arguments: args }, undefined, { signal })
      .then(result => (result.structuredContent ?? {}) as Record<string, unknown>);
    sdkObservers.add(work);
    void work.then(() => sdkObservers.delete(work), () => sdkObservers.delete(work));
    return work;
  };

  const gates: Gate[] = [];
  const addGate = (): Gate => {
    const gate = new Gate();
    gates.push(gate);
    return gate;
  };

  let registeredClose: ValidatedCloseRegistration | undefined;
  const ownedRecoveries: Array<() => Promise<void>> = [];

  return {
    app, store: app.store, hooks, events, configPath, initialContent, stateAtServerStart,
    inFlight: () => business.size,
    joinBusiness: () => Promise.allSettled([...business]),
    addGate,
    recoverAfterBusiness(action: () => Promise<void>): void { ownedRecoveries.push(action); },
    // The public endpoint schema is strict: username belongs to login tools,
    // not host-key confirmation. Extra synthetic fields would stop before Store.
    confirmViaSdk: (signal?: AbortSignal) => callTool('lite_ssh_confirm_host_key', {
      ip: target.ip,
      port: target.port,
      fingerprint,
    }, signal),
    closeApp: (): Promise<void> => {
      const closing = app.close();
      void closing.catch(() => {});
      return closing;
    },
    registerExpectedCloseError(err: unknown, validator: (err: unknown) => boolean): void {
      assert.ok(validator(err), 'Initial registration must pass validator');
      registeredClose = { error: err, validator };
    },
    async cleanup(): Promise<void> {
      for (const gate of gates) gate.release(false);
      hooks.metadataGate = undefined;
      hooks.closeGates = {};
      await Promise.allSettled([...business]);
      await Promise.allSettled([...sdkObservers]);
      app.store.listConfigurations = origList;
      app.store.resolveLogin = origResolve;
      app.store.confirmHostKey = origConfirm;
      active = undefined;

      const failures: unknown[] = [];
      const attempt = async (action: () => Promise<unknown>): Promise<void> => {
        try { await action(); } catch (err) { failures.push(err); }
      };

      await attempt(() => client.close());
      await attempt(async () => {
        try {
          await app.close();
        } catch (err: unknown) {
          if (registeredClose !== undefined && err === registeredClose.error) {
            assert.ok(registeredClose.validator(err), 'Cleanup must re-validate the exact same error object');
            return;
          }
          throw err;
        }
      });

      for (const handle of hooks.handles) {
        if (!handle.closed) {
          await attempt(async () => {
            handle.nativeCloses++;
            await Reflect.apply(handle.close, handle.handle, []);
            handle.closed = true;
          });
        }
        await attempt(async () => {
          assert.equal(handle.closed, true);
          assert.equal(handle.nativeCloses, 1);
        });
      }

      // A later fixture recovery must not rewrite the first shutdown result.
      // Each registered action owns an exact acquired identity, not a glob.
      for (const recover of ownedRecoveries) await attempt(recover);

      await attempt(async () => assert.equal(business.size, 0));
      await attempt(async () => assert.equal(await fs.readFile(configPath, 'utf8'), initialContent));
      await attempt(async () => {
        const names = await fs.readdir(directory);
        assert.deepEqual(names.filter(n => n.endsWith('.lock') || n.endsWith('.tmp')), []);
      });

      if (failures.length) throw new AggregateError(failures, 'Owned shutdown fixture teardown failed.');
    }
  };
}

/** Harness helper executes body and cleanup with boxed faults, preserving thrown null/undefined and primary assertion over teardown. */
async function runWithFixture(body: (f: Awaited<ReturnType<typeof createShutdownFixture>>) => Promise<void>): Promise<void> {
  const f = await createShutdownFixture();
  let bodyFault: { error: unknown } | undefined;
  try { await body(f); } catch (err: unknown) { bodyFault = { error: err }; }
  let cleanupFault: { error: unknown } | undefined;
  try { await f.cleanup(); } catch (err: unknown) { cleanupFault = { error: err }; }
  if (bodyFault !== undefined && cleanupFault !== undefined) {
    throw new AggregateError([bodyFault.error, cleanupFault.error], 'Test body assertion and fixture teardown both failed.');
  }
  if (bodyFault !== undefined) throw bodyFault.error;
  if (cleanupFault !== undefined) throw cleanupFault.error;
}

test('pre-metadata accepted Store work is joined before any reader FD exists', {
  timeout: TEST_BUDGET_MS,
}, () => runWithFixture(async f => {
  const metadata = f.addGate();
  f.hooks.metadataGate = metadata;
  const business = f.store.listConfigurations();
  await until(() => metadata.entered, 'owned pre-metadata gate');
  assert.equal(f.hooks.handles.length, 0);
  assert.equal(f.hooks.nativeLstatCount, 0);
  assert.equal(f.hooks.nativeOpenCount, 0);
  const closing = f.closeApp();
  let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  await delay(50);
  assert.equal(settled, false, 'Close must join work accepted before its first metadata operation.');
  metadata.release(true); // Ordinary read failure, no FD or cleanup uncertainty.
  await assert.rejects(business, (error: unknown) => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'CONFIG_INVALID');
    return true;
  });
  await closing;
  assert.equal(f.hooks.handles.length, 0);
  assert.equal(f.hooks.nativeLstatCount, 0);
  assert.equal(f.hooks.nativeOpenCount, 0);
  for (const owner of ['terminals', 'transfers', 'pool', 'server']) {
    assert.ok(f.events.includes(`${owner}:start`));
  }
}));

// (1) Accepted list/resolve remain joined on app.close, which synchronously stops Store admission with SERVER_STOPPING.
test('accepted list and resolve finalizers remain joined when app.close stops admission with SERVER_STOPPING', {
  timeout: TEST_BUDGET_MS
}, () => runWithFixture(async (f) => {
  const readerCloseGate = f.addGate();
  f.hooks.closeGates.reader = readerCloseGate;

  const missingTarget = { ...target, username: 'nonexistent-synthetic' };
  const listPromise = f.store.listConfigurations();
  const resolvePromise = f.store.resolveLogin(missingTarget);

  await until(() => readerCloseGate.waiters === 2, 'both reader-FD close waiters (2)');

  // Direct app.close synchronously stops direct new Store admission before async teardown.
  const closing = f.closeApp();

  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  await delay(50);
  assert.equal(closeSettled, false);

  // Bounded check verifies direct admission rejects SERVER_STOPPING before held gates release without new FS work.
  const lstatsBefore = f.hooks.nativeLstatCount;
  const opensBefore = f.hooks.nativeOpenCount;
  await expectAdmissionRejection(f.store.listConfigurations(), 'SERVER_STOPPING');
  await expectAdmissionRejection(f.store.resolveLogin(target), 'SERVER_STOPPING');
  await expectAdmissionRejection(f.store.confirmHostKey(target, fingerprint), 'SERVER_STOPPING');
  assert.equal(f.hooks.nativeLstatCount, lstatsBefore);
  assert.equal(f.hooks.nativeOpenCount, opensBefore);

  // Input validation takes precedence over stopping check for malformed fingerprint.
  await assert.rejects(
    f.store.confirmHostKey(target, 'not-a-valid-sha256-fingerprint'),
    (err: unknown) => (err as LiteSshError).code === 'CONFIG_INVALID'
  );

  // Releasing reader gate allows list to succeed and resolve to reject ACCOUNT_NOT_FOUND; business reject does not fail close.
  readerCloseGate.release(false);
  const listResult = await listPromise;
  assert.ok(Array.isArray(listResult));
  await assert.rejects(resolvePromise, (err: unknown) => (err as LiteSshError).code === 'ACCOUNT_NOT_FOUND');

  await closing;
  assert.equal(closeSettled, true);
}));

// (2) Cancelled SDK observer retains business confirmation; app.close joins Store before MCP detach.
test('accepted confirm retains business work on SDK cancel; app.close joins Store before MCP detach', {
  timeout: TEST_BUDGET_MS
}, () => runWithFixture(async (f) => {
  const lockCloseGate = f.addGate();
  f.hooks.closeGates.lock = lockCloseGate;

  const abortController = new AbortController();
  const cancelReason = new McpError(ErrorCode.RequestTimeout, 'Owned unique observer cancel.');
  const sdkCall = f.confirmViaSdk(abortController.signal);

  await until(() => lockCloseGate.entered, 'owned lock-close finalizer', NATIVE_READY_MS);
  abortController.abort(cancelReason);
  await assert.rejects(sdkCall, err => err === cancelReason);

  // The underlying Store confirmation business work remains held.
  assert.equal(f.inFlight(), 1);

  const closing = f.closeApp();
  await delay(50);

  // Terminal and transfer teardown start immediately, but server detach waits for Store.
  assert.ok(f.events.includes('terminals:start'));
  assert.ok(f.events.includes('transfers:start'));
  assert.equal(f.events.includes('server:start'), false);

  let closeSettled = false;
  void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
  await delay(50);
  assert.equal(closeSettled, false);

  // Releasing lock close allows Store and app.close to complete.
  lockCloseGate.release(false);
  await closing;
  assert.equal(closeSettled, true);

  // Pool disposal occurs after terminals/transfers finish; server detach follows pool completion.
  const poolStart = f.events.indexOf('pool:start');
  const terminalsEnd = f.events.indexOf('terminals:end');
  const transfersEnd = f.events.indexOf('transfers:end');
  assert.ok(poolStart > terminalsEnd, 'pool:start must be after terminals:end');
  assert.ok(poolStart > transfersEnd, 'pool:start must be after transfers:end');

  const serverStart = f.events.indexOf('server:start');
  const poolEnd = f.events.indexOf('pool:end');
  assert.ok(serverStart > poolEnd, 'server:start must be after pool:end');

  // Business was completely drained and lock was closed at the exact moment server.close started.
  assert.equal(f.stateAtServerStart.inFlight, 0, 'Store business must be 0 at server:start');
  assert.equal(f.stateAtServerStart.lockClosed, true, 'Lock must be closed at server:start');

  const lockHandle = f.hooks.handles.find(h => h.kind === 'lock');
  assert.ok(lockHandle !== undefined);
  assert.equal(lockHandle.closed, true);
  assert.equal(lockHandle.nativeCloses, 1);
  await assert.rejects(originalLstat(f.hooks.lockPath), { code: 'ENOENT' });
  assert.equal(f.inFlight(), 0);
}));

// (3) Reader and lock close uncertainty in first-close cohort aggregates safely with resource configuration.
test('reader and lock close uncertainty in firstclose cohort aggregates with resource configuration', {
  timeout: TEST_BUDGET_MS
}, () => runWithFixture(async (f) => {
  const readerCloseGate = f.addGate();
  f.hooks.closeGates.reader = readerCloseGate;
  const lockCloseGate = f.addGate();
  f.hooks.closeGates.lock = lockCloseGate;

  // Concurrent accepted list and direct idempotent confirm hold reader close gates.
  const listPromise = f.store.listConfigurations();
  const confirmPromise = f.store.confirmHostKey(target, fingerprint);
  await until(() => readerCloseGate.waiters === 2, 'both reader close finalizers (2)');

  // Calling handle.close repeatedly preserves identity and memoizes outcome across repeated calls.
  const readerHandle = f.hooks.handles.find(h => h.kind === 'reader')!;
  const p1 = readerHandle.handle.close();
  const p2 = readerHandle.handle.close();
  assert.equal(p1, p2);

  // First-close cohort captured while both operations are active.
  const closing = f.closeApp();

  // Release reader close with post-real-close failure and observe p1 rejection.
  readerCloseGate.release(true);
  await assert.rejects(p1);

  // Confirm proceeds to lock cleanup; release lock close with post-real-close failure.
  await until(() => lockCloseGate.entered, 'owned lock-close finalizer', NATIVE_READY_MS);
  lockCloseGate.release(true);

  await assert.rejects(listPromise);
  await assert.rejects(confirmPromise);

  const validator3 = (error: unknown): boolean => {
    assert.ok(error instanceof CleanupError && error instanceof LiteSshError);
    assert.equal(error.code, 'CONFIG_INVALID');
    const details = error.details as Record<string, unknown>;
    assert.equal(details.cleanupFailureCount, 2);
    assert.equal(details.cleanupFailuresComplete, true);
    const failures = details.cleanupFailures as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(failures) && failures.length === 2 && failures.every(item => item.resource === 'configuration'));

    assert.ok(failures.some(
      item => (item.facts as Record<string, unknown> | undefined)?.configurationHandleCloseConfirmed === false
    ), 'Must contain failure with configurationHandleCloseConfirmed: false');

    assert.ok(failures.some(item => {
      const lockCleanup = (item.facts as Record<string, unknown> | undefined)?.lockCleanup as Record<string, unknown> | undefined;
      return lockCleanup?.handleCloseConfirmed === false;
    }), 'Must contain failure with lockCleanup.handleCloseConfirmed: false');

    assert.ok(!JSON.stringify(publicError(error)).includes('post-close EIO'));
    return true;
  };

  let capturedError: unknown;
  await assert.rejects(closing, (error: unknown) => {
    capturedError = error;
    assert.ok(validator3(error));
    assert.ok(f.events.includes('terminals:start'));
    assert.ok(f.events.includes('transfers:start'));
    assert.ok(f.events.includes('pool:start'));
    assert.ok(f.events.includes('server:start'));
    return true;
  });
  f.registerExpectedCloseError(capturedError, validator3);

  for (const h of f.hooks.handles) {
    assert.equal(h.closed, true);
    assert.equal(h.nativeCloses, 1);
  }
}));

// (4) Atomic write temp FD close failure prevents publication and reports diagnostic on active cohort.
test('atomicWrite temp FD close failure prevents publication and diagnostics report temporaryHandleCloseConfirmed false', {
  timeout: TEST_BUDGET_MS
}, () => runWithFixture(async (f) => {
  const newFingerprint = makeFingerprint('owned-updated-trust-seed');
  const tempCloseGate = f.addGate();
  f.hooks.closeGates.temp = tempCloseGate;

  // Direct confirm call without pool guard exercises atomicWrite directly.
  const confirmPromise = f.store.confirmHostKey(target, newFingerprint);
  await until(() => tempCloseGate.entered, 'temporary file close finalizer');

  const closing = f.closeApp();
  tempCloseGate.release(true); // Fail temp close before publication rename.

  await assert.rejects(confirmPromise, (error: unknown) => {
    assert.ok(error instanceof LiteSshError);
    const details = (error as LiteSshError).details as Record<string, unknown>;
    assert.equal(details.temporaryHandleCloseConfirmed, false);
    return true;
  });

  const validator4 = (error: unknown): boolean => {
    assert.ok(error instanceof CleanupError && error instanceof LiteSshError);
    assert.equal(error.code, 'CONFIG_WRITE_FAILED');
    const details = error.details as Record<string, unknown>;
    assert.equal(details.cleanupFailureCount, 1);
    assert.equal(details.cleanupFailuresComplete, true);
    const failures = details.cleanupFailures as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(failures) && failures.length === 1 && failures[0]?.resource === 'configuration');
    const facts = failures[0]?.facts as Record<string, unknown> | undefined;
    assert.equal(facts?.temporaryHandleCloseConfirmed, false);
    assert.ok(!JSON.stringify(publicError(error)).includes('post-close EIO'));
    return true;
  };

  let capturedError: unknown;
  await assert.rejects(closing, (error: unknown) => {
    capturedError = error;
    assert.ok(validator4(error));
    return true;
  });
  f.registerExpectedCloseError(capturedError, validator4);

  // Publication was prevented: configuration remains byte-for-byte unchanged.
  assert.equal(await fs.readFile(f.configPath, 'utf8'), f.initialContent);

  // Temporary file was cleaned up.
  const files = await fs.readdir(f.hooks.directory);
  assert.deepEqual(files.filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), []);
}));

// A healthy FD close is not evidence that a failed publication removed its
// credential-bearing temporary. The removal guard fault is exact-path/ALS
// scoped; real locks/readers and the later identity-bound recovery stay healthy.
test('rename failure with retained temporary cleanup uncertainty rejects Store and app close', {
  timeout: TEST_BUDGET_MS,
}, t => runWithFixture(async f => {
  const temporaryClose = f.addGate();
  f.hooks.closeGates.temp = temporaryClose;
  const operation = f.store.confirmHostKey(target, makeFingerprint('owned-removal-failure-seed'));
  void operation.catch(() => {});
  await until(() => temporaryClose.entered, 'healthy temporary close before failed publication');
  const temporary = f.hooks.handles.find(handle => handle.kind === 'temp');
  assert.ok(temporary);
  assert.equal(temporary.closed, false);
  assert.equal(temporary.nativeCloses, 0);
  assert.equal(f.inFlight(), 1);
  const identity = await temporary.handle.stat({ bigint: true });
  f.recoverAfterBusiness(() => unlinkOwnedFile(temporary.targetPath, identity));
  const fault = { path: temporary.targetPath, renameCalls: 0, removalChecks: 0 };
  f.hooks.temporaryWriteFault = fault;

  // First close captures this unsettled confirmation before its native close.
  const closing = f.closeApp();
  temporaryClose.release(false);
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof LiteSshError);
    assert.equal(error.code, 'CONFIG_WRITE_FAILED');
    const details = error.details as Record<string, unknown>;
    assert.equal(details.cleanupComplete, false);
    assert.deepEqual(details.possibleResidualPaths, [temporary.targetPath]);
    assert.notEqual(details.temporaryHandleCloseConfirmed, false);
    return true;
  });

  // Establish the precise counterexample before testing shutdown rejection.
  assert.equal(fault.renameCalls, 1);
  assert.equal(fault.removalChecks, 1);
  assert.equal(temporary.closed, true);
  assert.equal(temporary.nativeCloses, 1);
  assert.ok((await originalLstat(temporary.targetPath)).isFile());
  const lock = f.hooks.handles.find(handle => handle.kind === 'lock');
  assert.ok(lock);
  assert.equal(lock.closed, true);
  assert.equal(lock.nativeCloses, 1);
  await assert.rejects(originalLstat(f.hooks.lockPath), { code: 'ENOENT' });
  assert.ok(f.hooks.handles.filter(handle => handle.kind === 'reader').every(handle => handle.closed));
  assert.equal(await fs.readFile(f.configPath, 'utf8'), f.initialContent);
  t.diagnostic(JSON.stringify({
    phase: 'temporary-cleanup-counterexample',
    renameCalls: fault.renameCalls,
    failedRemovalGuards: fault.removalChecks,
    temporaryFdClosed: temporary.closed,
    nativeTemporaryCloses: temporary.nativeCloses,
    ownedTemporaryStillPresent: true,
    lockClosedAndRemoved: true,
    originalConfigurationUnpublished: true,
  }));

  const validateClose = (error: unknown): boolean => {
    assert.ok(error instanceof CleanupError);
    const data = publicError(error);
    assert.equal(data.code, 'CONFIG_WRITE_FAILED');
    assert.equal(data.cleanupFailureCount, 1);
    assert.equal(data.cleanupFailuresComplete, true);
    const failures = data.cleanupFailures as Array<{ resource: string; code: string; facts: Record<string, unknown> }>;
    assert.equal(failures[0]?.resource, 'configuration');
    assert.equal(failures[0]?.code, 'CONFIG_WRITE_FAILED');
    assert.deepEqual(failures[0]?.facts, { temporaryCleanupComplete: false });
    assert.equal(JSON.stringify(data).includes('owned-fixture-password-literal'), false);
    assert.equal(JSON.stringify(data).includes('Owned rename EIO.'), false);
    for (const owner of ['terminals', 'transfers', 'pool', 'server']) {
      assert.ok(f.events.includes(owner + ':start'));
    }
    return true;
  };
  let closeError: unknown;
  await assert.rejects(closing, (error: unknown) => {
    closeError = error;
    return validateClose(error);
  });
  f.registerExpectedCloseError(closeError, validateClose);
  await assert.rejects(f.store.close(), validateClose);
}));

