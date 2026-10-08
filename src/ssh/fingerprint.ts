import { fingerprintOf } from '../config/fingerprint.js';

/** The decoded identity of a server host key. */
export interface HostKeyDetails {
  keyType: string;
  fingerprint: string;
}

/**
 * Decode a raw SSH host-key blob (RFC 4253 section 6.6):
 * `uint32 length || method name || key material`.
 *
 * `ssh2` hands us exactly this buffer from `hostVerifier` when no `hostHash`
 * is configured, which lets us capture both the negotiated key algorithm and
 * the fingerprint before any account credential is offered to the peer.
 */
export function hostKeyDetails(keyBlob: Buffer): HostKeyDetails {
  if (!Buffer.isBuffer(keyBlob) || keyBlob.length < 5) throw new Error('The host key blob is too short.');
  const typeLength = keyBlob.readUInt32BE(0);
  if (typeLength < 1 || 4 + typeLength > keyBlob.length) throw new Error('The host key blob has an invalid key type length.');
  const keyType = keyBlob.subarray(4, 4 + typeLength).toString('ascii');
  if (keyType.length === 0) throw new Error('The host key blob has an empty key type.');
  return { keyType, fingerprint: fingerprintOf(keyBlob) };
}
