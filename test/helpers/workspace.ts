import path from 'node:path';

// Windows runners provide a newly owned profile-local VB root, never a user's
// real HOME/config/key. Other platforms use an isolated project-local VB run.
const runRoot = path.resolve(
  process.env.LSSH_TEST_ROOT ?? 'vb-test/full-v2/portable',
  `${process.pid}-${Date.now()}`
);
export function fixtureRoot(...parts: string[]): string {
  return path.join(runRoot, ...parts);
}
