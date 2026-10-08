import { LiteSshError } from '../core/errors.js';
import { endpointKey, loginKey, normalizeIp } from '../core/targets.js';
import type { AuthConfig, LoginTarget } from '../core/types.js';
import { isFingerprint } from './fingerprint.js';
import type { JsonObject, JsonValue } from './json.js';

/**
 * Validation and indexing for a version-2 configuration.
 *
 * The raw parsed JSON is kept alongside an index so that a fingerprint update
 * can mutate only the target port object and re-emit the whole file, preserving
 * labels, accounts, unknown extra fields, and every other endpoint verbatim.
 */
export interface EndpointSlot {
  ipRaw: string;
  portRaw: string;
  ip: string;
  port: number;
}

export interface LoginEntry extends LoginTarget {
  auth: AuthConfig;
  hostKeyFingerprint?: string;
}

export interface ConfigurationView {
  raw: JsonObject;
  endpoints: Map<string, EndpointSlot>;
  logins: Map<string, LoginEntry>;
  list: LoginTarget[];
}

function invalid(reason: string): never {
  throw new LiteSshError('CONFIG_INVALID', reason);
}

function asObject(value: JsonValue | undefined, what: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${what} must be a JSON object.`);
  return value as JsonObject;
}

function optionalString(object: JsonObject, key: string, what: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(object, key)) return undefined;
  const value = object[key];
  if (typeof value !== 'string') invalid(`${what} must be a string.`);
  return value;
}

function normalizeServerIp(ipText: string): string {
  try {
    return normalizeIp(ipText);
  } catch {
    invalid('A server key must be a literal IPv4 or IPv6 address.');
  }
}

function parsePort(portText: string): number {
  if (!/^\d+$/.test(portText)) invalid('A port key must be a decimal integer string.');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('A port key must be an integer from 1 through 65535.');
  return port;
}

function parseAuth(value: JsonValue | undefined): AuthConfig {
  const auth = asObject(value, 'The auth entry');
  const type = auth.type;
  if (type === 'password') {
    const password = auth.password;
    if (typeof password !== 'string') invalid('A password auth entry requires a password string.');
    return { type: 'password', password };
  }
  if (type === 'privateKey') {
    const privateKeyPath = auth.privateKeyPath;
    if (typeof privateKeyPath !== 'string' || privateKeyPath.length === 0) invalid('A privateKey auth entry requires a privateKeyPath string.');
    const passphrase = optionalString(auth, 'passphrase', 'The passphrase');
    const result: AuthConfig = { type: 'privateKey', privateKeyPath };
    if (passphrase !== undefined) result.passphrase = passphrase;
    return result;
  }
  invalid('The auth type must be "password" or "privateKey".');
}

export function buildConfigurationView(raw: JsonObject): ConfigurationView {
  if (raw.version !== 2) {
    throw new LiteSshError('CONFIG_VERSION_ERROR', 'The configuration version is unsupported; exactly version 2 is required.');
  }
  const servers = asObject(raw.servers, 'The servers entry');
  const endpoints = new Map<string, EndpointSlot>();
  const logins = new Map<string, LoginEntry>();
  const list: LoginTarget[] = [];
  const seenIps = new Set<string>();

  for (const [ipRaw, portsValue] of Object.entries(servers)) {
    const ip = normalizeServerIp(ipRaw);
    if (seenIps.has(ip)) invalid('Two server keys refer to the same address after normalization.');
    seenIps.add(ip);
    const ports = asObject(portsValue, 'A server entry');
    const seenPorts = new Set<number>();

    for (const [portRaw, portValue] of Object.entries(ports)) {
      const port = parsePort(portRaw);
      if (seenPorts.has(port)) invalid('Two port keys on one server refer to the same port after normalization.');
      seenPorts.add(port);

      const portObject = asObject(portValue, 'A port entry');
      optionalString(portObject, 'label', 'A port label');
      const fingerprint = optionalString(portObject, 'hostKeyFingerprint', 'A host key fingerprint');
      if (fingerprint !== undefined && !isFingerprint(fingerprint)) {
        invalid('A host key fingerprint must use the SHA256 standard base64 form.');
      }
      const accounts = asObject(portObject.accounts, 'The accounts entry');

      const endpoint = endpointKey({ ip, port });
      if (endpoints.has(endpoint)) invalid('Two ports resolve to the same normalized endpoint.');
      endpoints.set(endpoint, { ipRaw, portRaw, ip, port });

      for (const [username, accountValue] of Object.entries(accounts)) {
        if (username.length === 0 || username.includes('\0')) invalid('An account name must be a nonempty actual account name.');
        const account = asObject(accountValue, 'An account entry');
        const auth = parseAuth(account.auth);
        const login: LoginEntry = { ip, port, username, auth };
        if (fingerprint !== undefined) login.hostKeyFingerprint = fingerprint;
        const key = loginKey({ ip, port, username });
        if (logins.has(key)) invalid('Two accounts resolve to the same login combination.');
        logins.set(key, login);
        list.push({ ip, port, username });
      }
    }
  }

  return { raw, endpoints, logins, list };
}
