/** Physical close, not a disposal timeout, releases the admission budget. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import type { Client } from 'ssh2';
import { CleanupError } from '../src/core/cleanup.js';
import { LiteSshError } from '../src/core/errors.js';
import { LocalFileSystem } from '../src/sftp/local.js';
import { TransferManager } from '../src/sftp/manager.js';

const target = { ip: '127.0.0.1', port: 2222, username: 'synthetic' };
const request = {
  ...target,
  localPath: path.resolve('vb-test/fix-20261107/f3/not-created'),
  remotePath: '/synthetic/not-created',
};

function fixture(failLocal = false) {
  let now = 1_000_000;
  let released = 0;
  let clientEnds = 0;
  const client = Object.assign(new EventEmitter(), { end() { clientEnds++; } });
  const channels: Array<{ close(): void }> = [];
  const manager = new TransferManager({
    acquire: async () => ({
      client: client as unknown as Client,
      target,
      // Another terminal still owns this connection: release must not close it.
      release: async () => { released++; },
    }),
  }, {
    limits: { admitted: 1, concurrent: 0, retentionMs: 60_000 },
    now: () => now,
    local: () => {
      if (failLocal) throw new LiteSshError('LOCAL_INIT_FAILED', 'Fixture local initialization failed.');
      return new LocalFileSystem();
    },
    remote: async () => {
      let closed = false;
      let resolveClosed!: () => void;
      const whenClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
      const close = (): void => {
        closed = true;
        client.removeListener('close', close);
        resolveClosed();
      };
      client.once('close', close);
      channels.push({ close });
      // No planner can run (concurrent=0), so this fixture performs no file I/O.
      return Object.assign(new LocalFileSystem(), {
        whenClosed,
        dispose: async () => closed,
      });
    },
  });
  return {
    manager,
    client,
    channels,
    advance: (milliseconds: number) => { now += milliseconds; },
    now: () => now,
    released: () => released,
    clientEnds: () => clientEnds,
    budget: () => manager as unknown as { admitted: number; memoryUsed: number },
    async cleanup() {
      for (const channel of channels) channel.close();
      await tick();
      // Earlier disposal uncertainty remains an honest historical failure.
      await manager.dispose().catch(error => {
        if (!(error instanceof CleanupError)) throw error;
      });
    },
  };
}

for (const closure of ['channel', 'client'] as const) {
  test(`unconfirmed task keeps its slot and record until actual ${closure} close`, async () => {
    const f = fixture();
    try {
      const accepted = await f.manager.accept('upload', request);
      const id = String(accepted.transferId);
      f.manager.cancel(id);
      await tick();
      assert.equal(f.manager.status(id).stopped, false);
      assert.equal(f.manager.status(id).recordExpiresAt, undefined);
      assert.equal(f.released(), 1);
      assert.equal(f.clientEnds(), 0);
      f.advance(60_001);
      assert.equal(f.manager.list().total, 1, 'retention must not discard the live channel owner');
      await assert.rejects(f.manager.accept('upload', request), { code: 'RESOURCE_LIMIT' });

      if (closure === 'channel') f.channels[0]!.close();
      else f.client.emit('close');
      await tick();
      assert.equal(f.manager.status(id).stopped, true);
      assert.equal(f.manager.status(id).state, 'failed', 'late close must not rewrite the failed result as success');
      assert.equal(f.manager.status(id).recordExpiresAt, new Date(f.now() + 60_000).toISOString());
      assert.equal(f.budget().admitted, 0);
      const second = await f.manager.accept('upload', request);
      assert.equal(second.accepted, true);
      f.manager.cancel(String(second.transferId));
      await tick();
      f.channels[1]!.close();
      await tick();
      assert.equal(f.budget().admitted, 0, 'release is once per owned channel');
      f.advance(60_001);
      assert.equal(f.manager.list().total, 0);
      assert.equal(f.budget().memoryUsed, 0);
    } finally { await f.cleanup(); }
  });
}

test('post-open admission failure retains its budget until the channel actually closes', async () => {
  const f = fixture(true);
  try {
    await assert.rejects(f.manager.accept('upload', request), { code: 'LOCAL_INIT_FAILED' });
    assert.equal(f.budget().admitted, 1);
    assert.ok(f.budget().memoryUsed > 0);
    await assert.rejects(f.manager.accept('upload', request), { code: 'RESOURCE_LIMIT' });
    f.channels[0]!.close();
    await tick();
    assert.equal(f.budget().admitted, 0);
    assert.equal(f.budget().memoryUsed, 0);
    assert.equal(f.clientEnds(), 0);
  } finally { await f.cleanup(); }
});

test('shutdown reports uncertain cleanup without dropping its later close owner', async () => {
  const f = fixture();
  try {
    const accepted = await f.manager.accept('upload', request);
    f.manager.cancel(String(accepted.transferId));
    await tick();
    await assert.rejects(f.manager.dispose(), CleanupError);
    assert.equal(f.budget().admitted, 1);
    assert.ok(f.budget().memoryUsed > 0);
    f.client.emit('close');
    await tick();
    assert.equal(f.budget().admitted, 0);
    assert.equal(f.budget().memoryUsed, 0);
    assert.equal(f.clientEnds(), 0);
  } finally { await f.cleanup(); }
});
