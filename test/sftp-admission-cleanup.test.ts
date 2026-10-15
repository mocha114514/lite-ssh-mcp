import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LiteSshError, publicError } from '../src/core/errors.js';
import type { ConnectionLease } from '../src/core/types.js';
import { TransferManager, type OwnedRemoteFileSystem } from '../src/sftp/manager.js';
import { LocalFileSystem } from '../src/sftp/local.js';

const login = { ip: '127.0.0.1', port: 2222, username: 'synthetic' };
const request = {
  ...login,
  localPath: path.resolve(process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2', 'admission-cleanup', 'file'),
  remotePath: '/synthetic'
};

function fixture(
  open: () => Promise<OwnedRemoteFileSystem>,
  release: () => Promise<void>,
  local?: () => LocalFileSystem
) {
  let releases = 0;
  const lease: ConnectionLease = {
    client: {} as ConnectionLease['client'],
    target: login,
    release: async () => {
      releases++;
      await release();
    }
  };
  const manager = new TransferManager(
    { acquire: async () => lease },
    { remote: open, local, limits: { admitted: 1 } }
  );
  return { manager, releases: () => releases };
}

function failures(error: LiteSshError): Array<{ resource: string; code: string }> {
  assert.ok(Array.isArray(error.details.cleanupFailures));
  return error.details.cleanupFailures as Array<{ resource: string; code: string }>;
}

test('F12 failed lease release cannot replace SFTP admission failure and budget settles once', async () => {
  const f = fixture(
    async () => { throw new LiteSshError('SFTP_UNAVAILABLE', 'Synthetic SFTP unavailable.', { reason: 'VERSION' }); },
    async () => { throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic lease cleanup failed.'); }
  );
  try {
    // A second attempt proves the failed admission released its slot exactly
    // once, rather than leaving it full or making the accounting negative.
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(f.manager.accept('upload', request), error => {
        assert.ok(error instanceof LiteSshError);
        assert.equal(error.code, 'SFTP_UNAVAILABLE');
        assert.equal(error.details.reason, 'VERSION');
        assert.deepEqual(failures(error), [
          { resource: 'connection', code: 'CONNECTION_CLEANUP_FAILED' }
        ]);
        return true;
      });
    }
    assert.equal(f.releases(), 2);
  } finally {
    await f.manager.dispose();
  }
});

test('F12 successful release preserves the original admission error without a cleanup failure', async () => {
  const primary = new LiteSshError('SFTP_UNAVAILABLE', 'Synthetic SFTP unavailable.');
  const f = fixture(async () => { throw primary; }, async () => {});
  try {
    await assert.rejects(f.manager.accept('upload', request), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, primary.code);
      assert.equal(error.message, primary.message);
      assert.equal(error.details.cleanupFailures, undefined);
      return true;
    });
    assert.equal(f.releases(), 1);
  } finally {
    await f.manager.dispose();
  }
});

test('F12 both owned finalizers are attempted and neither hides the local construction failure', async () => {
  let channelCloses = 0;
  const remote = Object.assign(new LocalFileSystem(), {
    dispose: async (): Promise<boolean> => {
      channelCloses++;
      throw new LiteSshError('SFTP_CLEANUP_FAILED', 'Synthetic channel cleanup failed.');
    }
  });
  const f = fixture(
    async () => remote,
    async () => { throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic lease cleanup failed.'); },
    () => { throw new LiteSshError('LOCAL_INIT_FAILED', 'Synthetic local construction failed.'); }
  );
  try {
    await assert.rejects(f.manager.accept('upload', request), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, 'LOCAL_INIT_FAILED');
      assert.deepEqual(failures(error), [
        { resource: 'sftp', code: 'SFTP_CLEANUP_FAILED' },
        { resource: 'connection', code: 'CONNECTION_CLEANUP_FAILED' }
      ]);
      return true;
    });
    assert.equal(channelCloses, 1);
    assert.equal(f.releases(), 1);
  } finally {
    await f.manager.dispose();
  }
});

test('F12 unknown primary and cleanup exceptions are safe and not raw secret-bearing errors', async () => {
  const f = fixture(
    async () => { throw new Error('synthetic_primary_secret'); },
    async () => { throw new Error('synthetic_cleanup_secret'); }
  );
  try {
    await assert.rejects(f.manager.accept('upload', request), error => {
      assert.ok(error instanceof LiteSshError);
      assert.equal(error.code, 'INTERNAL_ERROR');
      assert.deepEqual(failures(error), [
        { resource: 'connection', code: 'CONNECTION_CLEANUP_FAILED' }
      ]);
      const serialized = JSON.stringify(publicError(error));
      assert.ok(!serialized.includes('synthetic_primary_secret'));
      assert.ok(!serialized.includes('synthetic_cleanup_secret'));
      assert.ok(!serialized.includes('stack'));
      return true;
    });
  } finally {
    await f.manager.dispose();
  }
});

test('F12 cleanup decoration cannot override the primary error classification through details', async () => {
  const f = fixture(
    async () => {
      throw new LiteSshError('SFTP_UNAVAILABLE', 'Authoritative primary message.', {
        code: 'WRONG', message: 'Wrong projected message.', ok: true, state: 'completed'
      });
    },
    async () => { throw new LiteSshError('CONNECTION_CLEANUP_FAILED', 'Synthetic lease cleanup failed.'); }
  );
  try {
    await assert.rejects(f.manager.accept('upload', request), error => {
      assert.ok(error instanceof LiteSshError);
      const result = publicError(error);
      assert.equal(result.code, 'SFTP_UNAVAILABLE');
      assert.equal(result.message, 'Authoritative primary message.');
      assert.equal(result.ok, false);
      assert.equal(result.state, 'error');
      return true;
    });
  } finally {
    await f.manager.dispose();
  }
});
