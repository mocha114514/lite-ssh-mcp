import type { Client } from 'ssh2';

export interface Endpoint { ip: string; port: number }
export interface LoginTarget extends Endpoint { username: string }
export interface TerminalTarget extends Endpoint { codename: string }
export interface TerminalIdentity extends TerminalTarget { username: string }

export type AuthConfig =
  | { type: 'password'; password: string }
  | { type: 'privateKey'; privateKeyPath: string; passphrase?: string };
export interface PortConfig {
  label?: string;
  hostKeyFingerprint?: string;
  accounts: Record<string, { auth: AuthConfig }>;
}
export interface Configuration { version: 2; servers: Record<string, Record<string, PortConfig>> }
export interface ResolvedLogin {
  target: LoginTarget;
  auth: AuthConfig;
  hostKeyFingerprint?: string;
  /** Internal generation only; never expose it in tool results or logs. */
  revision: string;
}
export interface ConnectionLease {
  client: Client;
  target: LoginTarget;
  release(): Promise<void>;
}

export type ShellKind = 'bash' | 'zsh' | 'fish';
export type ShellMarker = { nonce: string } & (
  | { kind: 'probe'; shell: string }
  | { kind: 'stty'; value: string }
  | { kind: 'ready'; shell: ShellKind }
  | { kind: 'begin' }
  | { kind: 'end'; exitCode: number }
  | { kind: 'unsupported'; reason: string }
);
export interface ScreenModes {
  bracketedPaste: boolean;
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
}
export interface CellStyle {
  bold: boolean; italic: boolean; dim: boolean; underline: boolean;
  inverse: boolean; invisible: boolean; strikethrough: boolean;
  foreground: { mode: 'default' | 'palette' | 'rgb'; value: number };
  background: { mode: 'default' | 'palette' | 'rgb'; value: number };
}
export interface StyleSpan { row: number; start: number; end: number; style: CellStyle }
export interface ScreenSnapshot {
  revision: number; cols: number; rows: number; buffer: 'normal' | 'alternate';
  cursor: { x: number; y: number };
  lines: string[];
  styles: StyleSpan[];
  modes: ScreenModes;
}
export type InputAction =
  | { type: 'text'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'key'; key: string };
/** wrapped means soft visual wrap; newline=false denotes a partial row/rewrite boundary. */
export interface ParsedLine { text: string; buffer: 'normal' | 'alternate'; wrapped: boolean; newline?: boolean }
export interface ScreenOptions {
  nonce: string; cols?: number; rows?: number;
  onLine?: (line: ParsedLine) => void;
  onMarker?: (marker: ShellMarker) => void;
  /** Readable state before destructive buffer/erase transitions within one input chunk. */
  onFrame?: (screen: ScreenSnapshot, label?: string) => void;
  onReply?: (data: string) => void;
}

export interface RoundResult {
  /** false when the shell handled/rejected submitted input without starting execution. */
  commandStarted?: boolean;
  round: string; exitCode: number; outputCharacters: number;
  output: string | null; outputOmitted: boolean;
  cacheRange: { beginMarker: string; endMarker: string };
}
export type TerminalStatus = 'opening' | 'open' | 'closing' | 'closed' | 'error';
export interface PageOptions { ip?: string; port?: number; username?: string; offset?: number; limit?: number }
