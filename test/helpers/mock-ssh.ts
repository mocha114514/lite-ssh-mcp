import { generateKeyPairSync, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import { attachMockSftp, emptySftpStats, type MockSftpOptions } from './mock-sftp.js';

/** Real SSH protocol, simulated shell. Host keys stay in memory; never use ~/.ssh. */
export async function startMockSsh(options: {
  lateSecondShellMs?: number;
  sftpRoot?: string;
  sftp?: MockSftpOptions;
} = {}) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const parsed = ssh2.utils.parseKey(key.privateKey);
  if (parsed instanceof Error) throw parsed;
  const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  let authAttempts = 0;
  let authenticatedConnections = 0;
  let queryReplies = 0;
  let shellRequests = 0;
  let openChannels = 0;
  const clients = new Set<ssh2.Connection>();
  const sftpStats = emptySftpStats();
  const sftpChannels: Array<{ close(): Promise<void> }> = [];
  const windows: Array<{ rows: number; cols: number }> = [];
  const server = new ssh2.Server({ hostKeys: [key.privateKey] }, client => {
    clients.add(client);
    client.on('error', () => undefined); // Rejected host-key handshakes are expected.
    client.on('close', () => clients.delete(client));
    client.on('authentication', auth => {
      authAttempts++;
      if (auth.method === 'password' && auth.username === 'fixture_user' && auth.password === 'fixture_password') auth.accept();
      else auth.reject();
    });
    client.on('ready', () => {
      authenticatedConnections++;
      client.on('session', accept => {
        const session = accept();
        if (options.sftpRoot) {
          session.on('subsystem', (ok, reject, info) => {
            if (info.name !== 'sftp') { reject(); return; }
            const channel = ok();
            sftpChannels.push(attachMockSftp(channel, options.sftpRoot!, sftpStats, options.sftp));
          });
        }
        session.on('pty', (ok, _reject, info) => { windows.push({ rows: info.rows, cols: info.cols }); ok?.(); });
        session.on('window-change', (_ok, _reject, info) => { windows.push({ rows: info.rows, cols: info.cols }); });
        session.on('shell', ok => {
          const initialize = (): void => {
          const channel = ok();
          openChannels++;
          channel.on('close', () => { openChannels--; });
          channel.on('error', () => undefined);
          let input = '';
          let nonce = '';
          let hidden = false;
          let tui = false;
          const marker = (event: string, value = '') => channel.write(`\x1b]777;LSSH;${nonce};${event}${value ? `;${value}` : ''}\x07`);
          const end = (code = 0) => { marker('END', String(code)); channel.write('fixture$ '); };
          const line = (command: string): void => {
            if (command.includes('/proc/$PPID/comm')) {
              nonce = /LSSH;([A-Za-z0-9_.-]+);/.exec(command)?.[1] ?? '';
              marker('STTY', '0:0:0:0'); marker('PROBE', 'bash'); return;
            }
            if (command.includes('READY;bash')) { marker('READY', 'bash'); channel.write('fixture$ '); return; }
            if (hidden) { hidden = false; channel.write('\r\naccepted\r\n'); end(); return; }
            if (tui) { if (command === ':q') { tui = false; channel.write('\x1b[?2004l\x1b[?1049l'); end(); } return; }
            channel.write(`${command}\r\n`); // Echo is visible; input is not mirrored by the recorder.
            if (command === 'syntax error') { channel.write('bash: syntax error\r\n'); end(2); return; }
            marker('BEGIN');
            if (command === 'emit small') { channel.write('short readable output\r\n'); end(); }
            else if (command === 'emit large') { channel.write('界'.repeat(1200) + '\r\n'); end(); }
            else if (command === 'emit unbroken') { channel.write('x'.repeat(1201)); end(); }
            else if (command === 'transient tui') { channel.write('\x1b[?1049htransient_view_text\x1b[?1049l'); end(); }
            else if (command === 'emit many') { channel.write(Array.from({ length: 2500 }, (_, i) => `line_${i}\r\n`).join('')); end(); }
            else if (command === 'ask hidden') { hidden = true; channel.write('Password: '); }
            else if (command === 'enter tui') { tui = true; channel.write('\x1b[?1049h\x1b[?2004h\x1b[Hfake editor\r\n'); }
            else if (command === 'query cursor') { channel.write('\x1b[6n'); }
            else if (command === 'hang') { channel.write('still running\r\n'); }
            else { channel.write('fixture command\r\n'); end(); }
          };
          channel.on('data', (chunk: Buffer) => {
            input += chunk.toString('utf8');
            const reply = /^\x1b\[\d+;\d+R/.exec(input);
            if (reply) { input = input.slice(reply[0].length); queryReplies++; channel.write('cursor reply received\r\n'); end(); }
            if (input.includes('\x03')) { input = ''; hidden = false; tui = false; channel.write('^C\r\n'); end(130); return; }
            let delimiter: number;
            while ((delimiter = input.indexOf('\r')) >= 0) { const command = input.slice(0, delimiter); input = input.slice(delimiter + 1); line(command); }
          });
          channel.on('close', () => { if (!channel.destroyed) channel.end(); });
          channel.write('fixture$ ');
          };
          shellRequests++;
          if (shellRequests === 2 && options.lateSecondShellMs) setTimeout(initialize, options.lateSecondShellMs);
          else initialize();
        });
      });
    });
  });
  server.on('error', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    ip: '127.0.0.1', port, username: 'fixture_user', password: 'fixture_password', fingerprint,
    get authAttempts() { return authAttempts; },
    get authenticatedConnections() { return authenticatedConnections; },
    get queryReplies() { return queryReplies; },
    get openChannels() { return openChannels; }, windows, sftpStats,
    async close() {
      for (const client of clients) client.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all(sftpChannels.map(channel => channel.close()));
    }
  };
}
