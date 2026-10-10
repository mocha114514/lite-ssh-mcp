import type { LoginTarget, PageOptions } from '../core/types.js';
import { LiteSshError } from '../core/errors.js';

export type ConflictPolicy = 'overwrite_merge_off' | 'overwrite_merge_on';
export type SymlinkPolicy = 'symlink_follow_off' | 'symlink_follow_on';
export type TransferDirection = 'upload' | 'download';
export type TransferPhase =
  | 'queued'
  | 'planning'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'partial_failed'
  | 'completed'
  | 'cancelling'
  | 'cancelled';

export interface TransferRequest extends LoginTarget {
  localPath: string;
  remotePath: string;
  conflictPolicy?: ConflictPolicy;
  symlinkPolicy?: SymlinkPolicy;
}

export interface TransferPolicies {
  conflictPolicy: ConflictPolicy;
  symlinkPolicy: SymlinkPolicy;
}

export interface TransferIssue {
  code: string;
  side?: 'source' | 'target';
  sourcePath?: string;
  targetPath?: string;
  actualPath?: string;
  otherSourcePath?: string;
  linkTarget?: string;
  sourceType?: string;
  targetType?: string;
}

export interface TransferLimits {
  concurrent: number;
  admitted: number;
  records: number;
  retentionMs: number;
  entries: number;
  planningBytes: number;
  depth: number;
  pageSize: number;
  pageMaximum: number;
  chunkBytes: number;
}

/** These are technical budgets, not extra public options or default accounts. */
export const TRANSFER_LIMITS: Readonly<TransferLimits> = Object.freeze({
  concurrent: 4,
  admitted: 20,
  records: 128,
  retentionMs: 15 * 60_000,
  entries: 20_000,
  planningBytes: 16 * 1024 * 1024,
  depth: 128,
  pageSize: 50,
  pageMaximum: 200,
  chunkBytes: 64 * 1024
});

export interface TransferPage extends PageOptions {}

export function policiesOf(request: TransferRequest): TransferPolicies {
  const conflictPolicy = request.conflictPolicy === undefined ? 'overwrite_merge_off' : request.conflictPolicy;
  const symlinkPolicy = request.symlinkPolicy === undefined ? 'symlink_follow_off' : request.symlinkPolicy;
  if (conflictPolicy !== 'overwrite_merge_off' && conflictPolicy !== 'overwrite_merge_on') {
    throw new LiteSshError('INVALID_TRANSFER_POLICY', 'Use the full overwrite_merge_off/on enum values; boolean and short aliases are not accepted.');
  }
  if (symlinkPolicy !== 'symlink_follow_off' && symlinkPolicy !== 'symlink_follow_on') {
    throw new LiteSshError('INVALID_TRANSFER_POLICY', 'Use the full symlink_follow_off/on enum values; boolean and short aliases are not accepted.');
  }
  return { conflictPolicy, symlinkPolicy };
}

export function isTerminalPhase(phase: TransferPhase): boolean {
  return phase === 'blocked' || phase === 'failed' || phase === 'partial_failed' ||
    phase === 'completed' || phase === 'cancelled';
}
