import path from 'node:path';
import os from 'node:os';

/** Pure selection: never repair an existing directory's permissions or read
 * the user's real configuration/keys. Explicit roots retain their meaning. */
export function resolveFixtureBase(
  override: string | undefined,
  platform: NodeJS.Platform,
  home: string,
  cwd: string,
): string {
  if (override !== undefined) return path.resolve(cwd, override);
  return platform === 'win32'
    ? path.join(home, 'vb-test', 'lite-ssh-mcp')
    : path.resolve(cwd, 'vb-test/full-v2/portable');
}

const runRoot = path.join(
  resolveFixtureBase(process.env.LSSH_TEST_ROOT, process.platform, os.homedir(), process.cwd()),
  `${process.pid}-${Date.now()}`,
);
export function fixtureRoot(...parts: string[]): string {
  return path.join(runRoot, ...parts);
}
