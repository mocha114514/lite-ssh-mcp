import { createHash } from 'node:crypto';

/**
 * Fingerprint helpers shared by the configuration layer and the SSH layer.
 *
 * A fingerprint is the SHA-256 digest of the SSH host-key blob, encoded as
 * standard base64 with the padding removed and prefixed with `SHA256:`. That is
 * the same textual form OpenSSH prints, so a value can be copied between an
 * operator's terminal and this configuration without translation.
 */
export const SHA256_PREFIX = 'SHA256:';

/** True when the value looks like a `SHA256:` standard-base64 fingerprint. */
export function isFingerprint(value: string): boolean {
  return /^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/** Compute the `SHA256:` fingerprint of a raw SSH public-key blob. */
export function fingerprintOf(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
  return SHA256_PREFIX + digest;
}
