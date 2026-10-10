import type { Client } from 'ssh2';
import { LiteSshError } from '../core/errors.js';

/** Owns a physical client, not a single PTY/SFTP lease. Close is confirmed only
 * by ssh2's actual close event. Grace expiry requests destruction but never
 * synthesizes a successful close; the second bound reports uncertainty.
 */
export class ClientOwner {
  closed = false;
  private closing?: Promise<void>;

  constructor(
    readonly client: Client,
    onClosed: () => void,
    private readonly graceMs = 2000,
    private readonly forceMs = 2000
  ) {
    client.on('error', () => undefined);
    client.once('close', () => {
      this.closed = true;
      onClosed();
    });
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closing ??= new Promise<void>((resolve, reject) => {
      let settled = false;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let forced: ReturnType<typeof setTimeout> | undefined;
      const finish = (confirmed: boolean): void => {
        if (settled) return;
        settled = true;
        if (grace) clearTimeout(grace);
        if (forced) clearTimeout(forced);
        this.client.removeListener('close', done);
        if (confirmed) resolve();
        else reject(new LiteSshError('CONNECTION_CLEANUP_FAILED',
          'The owned SSH client did not confirm closure after end and destroy.'));
      };
      const done = (): void => finish(true);
      const force = (): void => {
        if (settled || forced) return;
        if (grace) clearTimeout(grace);
        forced = setTimeout(() => finish(false), this.forceMs);
        try { this.client.destroy(); }
        catch { /* A thrown destroy is not a close event; keep the deadline. */ }
      };
      this.client.once('close', done);
      grace = setTimeout(force, this.graceMs);
      try { this.client.end(); }
      catch { force(); }
    });
    return this.closing;
  }
}
