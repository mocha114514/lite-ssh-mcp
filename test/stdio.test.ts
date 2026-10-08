import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve('dist/cli.js');

test('CLI help/version do not load a real user configuration', () => {
  for (const argument of ['--version', '--help']) {
    const child = spawnSync(process.execPath, [cli, argument], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0);
    assert.ok(child.stdout.includes('lite-ssh-mcp'));
    assert.equal(child.stderr, '');
  }
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
