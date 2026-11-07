import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { resolveFixtureBase } from './helpers/workspace.js';

const home = path.resolve('synthetic-home');
const cwd = path.resolve('synthetic-checkout');

test('Windows defaults to a profile-local VB fixture base, not checkout or real SSH configuration', () => {
  assert.equal(resolveFixtureBase(undefined, 'win32', home, cwd), path.join(home, 'vb-test', 'lite-ssh-mcp'));
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`${platform} retains the isolated project-local fixture base`, () => {
    assert.equal(resolveFixtureBase(undefined, platform, home, cwd), path.join(cwd, 'vb-test/full-v2/portable'));
  });
}

for (const platform of ['win32', 'linux'] as const) {
  test(`${platform} honors an explicit absolute LSSH_TEST_ROOT`, () => {
    const override = path.resolve('synthetic-override');
    assert.equal(resolveFixtureBase(override, platform, home, cwd), override);
  });
}

test('a relative LSSH_TEST_ROOT remains relative to the invoking working directory', () => {
  assert.equal(resolveFixtureBase('fixtures', 'win32', home, cwd), path.join(cwd, 'fixtures'));
});
