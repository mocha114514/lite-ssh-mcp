import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import ssh2 from 'ssh2';
import { RemoteFileSystem } from '../src/sftp/remote.js';
import { packet, uint32, wireString, WireReader } from './helpers/sftp-wire.js';

test('real ssh2: a dot-only NAME batch is not EOF and later entries remain enumerable', { timeout: 10000 }, async () => {
  // Entirely synthetic loopback identity; no real account, config or key file.
  const key = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const parsed = ssh2.utils.parseKey(key.privateKey);
  if (parsed instanceof Error) throw parsed;
  let reads = 0;
  let handles = 0;
  let closes = 0;
  const directory = Buffer.from('owned-directory');
  const connections = new Set<ssh2.Connection>();
  const server = new ssh2.Server({ hostKeys: [key.privateKey] }, connection => {
    connections.add(connection);
    connection.on('error', () => undefined);
    connection.on('close', () => connections.delete(connection));
    connection.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'directory-user' && auth.password === 'synthetic-password') {
        auth.accept();
      } else {
        auth.reject();
      }
    });
    connection.on('ready', () => connection.on('session', accept => {
      const session = accept();
      session.on('subsystem', (acceptSubsystem, reject, info) => {
        if (info.name !== 'sftp') { reject(); return; }
        const channel = acceptSubsystem();
        channel.on('error', () => undefined);
        let input = Buffer.alloc(0);
        channel.on('data', (chunk: Buffer) => {
          input = Buffer.concat([input, chunk]);
          while (input.length >= 4 && input.length >= 4 + input.readUInt32BE(0)) {
            const length = input.readUInt32BE(0);
            const reader = new WireReader(input.subarray(4, 4 + length));
            input = input.subarray(4 + length);
            const type = reader.byte();
            if (type === 1) {
              assert.equal(reader.uint32(), 3);
              reader.end();
              channel.write(packet(2, uint32(3)));
              continue;
            }
            const id = reader.uint32();
            if (type === 11) {
              assert.equal(reader.string(), '/synthetic');
              reader.end();
              handles++;
              channel.write(packet(102, uint32(id), wireString(directory)));
            } else if (type === 12) {
              assert.deepEqual(reader.buffer(), directory);
              reader.end();
              reads++;
              // ssh2's public readdir(handle) removes '.' and '..' from this
              // valid NAME response, delivering [] to the real adapter.
              const names = reads === 1 ? ['.', '..'] : reads === 2 ? ['late.txt', '中文.txt'] : [];
              if (names.length > 0) {
                channel.write(packet(104, uint32(id), uint32(names.length),
                  ...names.map(name => Buffer.concat([wireString(name), wireString(name), uint32(0)]))));
              } else {
                channel.write(packet(101, uint32(id), uint32(1), wireString('EOF'), wireString('')));
              }
            } else if (type === 4) {
              assert.deepEqual(reader.buffer(), directory);
              reader.end();
              handles--;
              closes++;
              channel.write(packet(101, uint32(id), uint32(0), wireString('OK'), wireString('')));
            } else {
              assert.fail(`Unexpected synthetic SFTP request ${type}`);
            }
          }
        });
      });
    }));
  });
  server.on('error', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new ssh2.Client();
  client.on('error', () => undefined);
  let clientClosed = false;
  client.on('close', () => { clientClosed = true; });
  let remote: RemoteFileSystem | undefined;
  try {
    const ready = once(client, 'ready');
    client.connect({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'directory-user',
      password: 'synthetic-password',
      hostVerifier: (hostKey: Buffer) => hostKey.equals(parsed.getPublicSSH())
    });
    await ready;
    remote = await RemoteFileSystem.open(client);
    const names: string[] = [];
    for await (const name of remote.entries('/synthetic')) {
      names.push(name);
    }
    assert.deepEqual(names, ['late.txt', '中文.txt']);
    assert.equal(reads, 3);
    assert.equal(handles, 0);
    assert.equal(closes, 1);
  } finally {
    const failures: unknown[] = [];
    if (remote) {
      try { assert.equal(await remote.dispose(), true); }
      catch (error) { failures.push(error); }
    }
    if (!clientClosed) {
      const closed = once(client, 'close');
      client.end();
      await closed;
    }
    for (const connection of connections) connection.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (failures.length > 0) throw new AggregateError(failures, 'Owned directory protocol cleanup failed');
  }
});
