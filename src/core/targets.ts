import { isIP } from 'node:net';
import { LiteSshError } from './errors.js';
import type { Endpoint, LoginTarget, TerminalTarget } from './types.js';

export function normalizeIp(ip: string): string {
  if (!isIP(ip)) throw new LiteSshError('INVALID_IP', 'ip must be a literal IPv4 or IPv6 address.');
  if (isIP(ip) === 4) return ip;
  const [address, ...zone] = ip.split('%');
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return zone.length ? `${normalized}%${zone.join('%')}` : normalized;
}
export function endpointKey(target: Endpoint): string {
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new LiteSshError('INVALID_PORT', 'port must be an integer from 1 through 65535.');
  }
  return JSON.stringify([normalizeIp(target.ip), target.port]);
}
export function loginKey(target: LoginTarget): string {
  if (!target.username || target.username.includes('\0')) throw new LiteSshError('INVALID_USERNAME', 'username must be a nonempty actual account name.');
  return JSON.stringify([endpointKey(target), target.username]);
}
export function validateTerminalTarget(target: TerminalTarget): void {
  endpointKey(target);
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(target.codename) || target.codename.length > 64) {
    throw new LiteSshError('INVALID_CODENAME', 'Provide an independent snake_case codename, at most 64 characters.');
  }
}
