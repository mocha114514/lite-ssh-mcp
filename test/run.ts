/** Common test entry: all child test files receive the same isolated base. */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRoot } from './helpers/workspace.js';

const requested = process.argv.slice(2);
if (requested.some(file => !file.endsWith('.test.js') || file.startsWith('-'))) {
  throw new Error('Pass compiled .test.js file paths, or no arguments to run all tests.');
}
const directory = fileURLToPath(new URL('.', import.meta.url));
const files = requested.length > 0
  ? requested
  : (await readdir(directory))
    .filter(file => file.endsWith('.test.js'))
    .sort()
    .map(file => path.join(directory, file));
const root = process.env.LSSH_TEST_ROOT === undefined
  ? fixtureRoot()
  : path.resolve(process.env.LSSH_TEST_ROOT);

// Files are created only by the tests that need them. Log the exact run root
// for cleanup; never point fixtures at the real .lite-ssh or private-key tree.
console.error(`Test fixture root: ${root}`);
const child = spawn(process.execPath, ['--test', ...files], {
  cwd: process.cwd(),
  env: { ...process.env, LSSH_TEST_ROOT: root },
  stdio: 'inherit',
  windowsHide: true,
});
child.once('error', error => {
  console.error(`Unable to start test process: ${error.message}`);
  process.exitCode = 1;
});
child.once('close', code => { process.exitCode = code ?? 1; });
