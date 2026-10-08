import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve('dist/cli.js');

test('shutdown during paused initialization never attaches a new stdio transport', { timeout: 12_000 }, async () => {
  const fakeHome = resolve('vb-test/m0/first-run/stdio-stop', `${process.pid}-${Date.now()}`);
  await fs.mkdir(fakeHome, { recursive: true });
  const hook = join(fakeHome, 'pause-initialization.mjs');
  // Gate only this child's first-run mkdir. Emitting its SIGTERM event works on
  // Windows too, where child.kill(SIGTERM) bypasses Node's signal handlers.
  await fs.writeFile(hook, `import { promises as fs } from 'node:fs';
import { join } from 'node:path';
const mkdir = fs.mkdir;
let release;
fs.mkdir = async (...args) => {
  if (args[0] === join(process.env.USERPROFILE, '.lite-ssh')) {
    process.send({ stage: 'initialization-paused' });
    await new Promise(resolve => { release = resolve; });
  }
  return mkdir.apply(fs, args);
};
const control = message => {
  if (message === 'stop') { process.emit('SIGTERM'); process.send({ stage: 'shutdown-emitted' }); }
  if (message === 'release') { process.removeListener('message', control); release(); process.disconnect(); }
};
process.on('message', control);
`, 'utf8');
  const child = fork(cli, [], { cwd: process.cwd(), execArgv: ['--import', pathToFileURL(hook).href], env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  await fs.writeFile(join(fakeHome, 'child-pid.json'), JSON.stringify({ pid: child.pid }), 'utf8');
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.deepEqual((await once(child, 'message'))[0], { stage: 'initialization-paused' });
    child.send('stop');
    assert.deepEqual((await once(child, 'message'))[0], { stage: 'shutdown-emitted' });
    const exited = once(child, 'exit');
    child.send('release');
    const [code, signal] = await Promise.race([
      exited,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CLI remained alive after shutdown during initialization.')), 5000); }),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(await fs.readFile(join(fakeHome, '.lite-ssh/config.json'), 'utf8')), { version: 2, servers: {} });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Only the recorded owned child may be ended if the assertion fails.
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  }
});

test('normal stdio startup initializes a fresh home and keeps examples out of live logins', { timeout: 12_000 }, async () => {
  const fakeHome = resolve('vb-test/m0/first-run/stdio', `${process.pid}-${Date.now()}`);
  await fs.mkdir(fakeHome, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], cwd: process.cwd(), env: { HOME: fakeHome, USERPROFILE: fakeHome }, stderr: 'pipe' });
  const client = new Client({ name: 'fresh-home-fixture', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    assert.deepEqual(JSON.parse(await fs.readFile(join(fakeHome, '.lite-ssh/config.json'), 'utf8')), { version: 2, servers: {} });
    const example = JSON.parse(await fs.readFile(join(fakeHome, '.lite-ssh/config.example.json'), 'utf8')) as { servers: Record<string, unknown> };
    assert.equal(Object.keys(example.servers).length, 2);
    const listing = await client.callTool({ name: 'lite_ssh_list_configurations', arguments: {} });
    assert.equal((listing.structuredContent as { total: number }).total, 0);
    await client.close();
    assert.equal(stderr, '');
  } finally { await client.close(); await transport.close(); }
});

test('startup initialization failure reports a clear stderr error and no protocol stdout', async () => {
  const fakeHome = resolve('vb-test/m0/first-run/stdio-blocked', `${process.pid}-${Date.now()}`);
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.writeFile(join(fakeHome, '.lite-ssh'), 'owned fixture blocker');
  const child = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 5000, env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome } });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, '');
  assert.match(child.stderr, /^CONFIG_INIT_FAILED: /);
  assert.ok(child.stderr.includes('permissions'));
  assert.equal(await fs.readFile(join(fakeHome, '.lite-ssh'), 'utf8'), 'owned fixture blocker');
});

test('CLI help/version neither read nor initialize user configuration', async () => {
  const fakeHome = resolve('vb-test/m0/first-run/help', `${process.pid}-${Date.now()}`);
  await fs.mkdir(fakeHome, { recursive: true });
  for (const argument of ['--version', '--help']) {
    const child = spawnSync(process.execPath, [cli, argument], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    assert.equal(child.status, 0);
    assert.ok(child.stdout.includes('lite-ssh-mcp'));
    assert.equal(child.stderr, '');
  }
  await assert.rejects(fs.lstat(join(fakeHome, '.lite-ssh')), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('subprocess stdio initialize -> tools/list -> fake-home config -> clean EOF', { timeout: 12_000 }, async () => {
  const fakeHome = resolve('vb-test/m0/stdio', `${process.pid}-${Date.now()}`);
  await fs.mkdir(join(fakeHome, '.lite-ssh'), { recursive: true });
  await fs.writeFile(join(fakeHome, '.lite-ssh/config.json'), JSON.stringify({ version: 2, servers: { '127.0.0.1': { '2222': {
    accounts: { stdio_fixture: { auth: { type: 'password', password: 'not_a_real_credential' } } }
  } } } }), 'utf8');
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], cwd: process.cwd(), env: { HOME: fakeHome, USERPROFILE: fakeHome }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-fixture', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  try {
    await client.connect(transport);
    // Track the exact child PID; the SDK owns only this child, never a process group.
    await fs.writeFile(join(fakeHome, 'child-pid.json'), JSON.stringify({ pid: transport.pid }), 'utf8');
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const list = await client.callTool({ name: 'lite_ssh_list_configurations', arguments: {} });
    const result = list.structuredContent as { configurations: Array<{ username: string }>; total: number };
    assert.equal(result.total, 1);
    assert.equal(result.configurations[0]?.username, 'stdio_fixture');
    assert.equal(JSON.stringify(list).includes('not_a_real_credential'), false);
    await client.close();
    assert.equal(stderr, '');
  } finally { await client.close(); await transport.close(); }
});
