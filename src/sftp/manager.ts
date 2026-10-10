import { randomUUID } from 'node:crypto';
import { LiteSshError } from '../core/errors.js';
import { loginKey, normalizeIp } from '../core/targets.js';
import type { ConnectionLease, PageOptions } from '../core/types.js';
import type { ConnectionPool } from '../ssh/pool.js';
import { fileError, type TransferFileSystem } from './filesystem.js';
import { LocalFileSystem, normalizeLocalPath } from './local.js';
import { RemoteFileSystem, normalizeRemotePath } from './remote.js';
import { planTransfer, type PlannedEntry, type TransferPlan } from './planner.js';
import { runTransfer, type CleanupResult, type RunOutcome, type TransferProgress, type EntryResult } from './runner.js';
import { isTerminalPhase, policiesOf, TRANSFER_LIMITS, type TransferDirection, type TransferLimits, type TransferPhase, type TransferPolicies, type TransferRequest } from './types.js';

export interface OwnedRemoteFileSystem extends TransferFileSystem {
  readonly effectUnknown?: boolean;
  dispose(): Promise<boolean>;
}
export interface TransferManagerOptions {
  limits?: Partial<TransferLimits>;
  /** Aggregate estimate across pending admissions, active plans and records. */
  memoryBytes?: number;
  now?: () => number;
  local?: () => TransferFileSystem;
  remote?: (client: ConnectionLease['client']) => Promise<OwnedRemoteFileSystem>;
}
interface Task {
  transferId: string;
  direction: TransferDirection;
  request: TransferRequest;
  policies: TransferPolicies;
  lease: ConnectionLease;
  remote: OwnedRemoteFileSystem;
  sourceFs: TransferFileSystem;
  targetFs: TransferFileSystem;
  controller: AbortController;
  phase: TransferPhase;
  createdAt: number;
  endedAt?: number;
  expiresAt?: number;
  plan?: TransferPlan;
  progress: TransferProgress;
  outcome?: RunOutcome;
  results?: Map<PlannedEntry, EntryResult>;
  cleanup: CleanupResult;
  error?: { code: string; message: string; details: Record<string, unknown> };
  accountedBytes: number;
  started: boolean;
  finishing?: Promise<void>;
  completion: Promise<void>;
  resolveCompletion(): void;
  channelClosed?: boolean;
}

/** Application-owned task registry, independent of PTYs and client task protocols. */
export class TransferManager {
  private readonly tasks = new Map<string, Task>();
  private readonly expired = new Set<string>();
  private readonly admitting = new Set<Promise<Record<string, unknown>>>();
  private readonly limits: TransferLimits;
  private readonly now: () => number;
  private readonly memoryMaximum: number;
  private memoryUsed = 0;
  private admitted = 0;
  private executing = 0;
  private stopping = false;
  private pumpTimer?: NodeJS.Immediate;
  private expiryTimer?: NodeJS.Timeout;
  private closing?: Promise<void>;

  constructor(private readonly pool: Pick<ConnectionPool, 'acquire'>, private readonly options: TransferManagerOptions = {}) {
    this.limits = { ...TRANSFER_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.memoryMaximum = options.memoryBytes ?? 64 * 1024 * 1024;
  }

  accept(direction: TransferDirection, input: TransferRequest): Promise<Record<string, unknown>> {
    if (this.stopping) return Promise.reject(new LiteSshError('SERVER_STOPPING', 'The MCP instance is shutting down.'));
    let request: TransferRequest;
    let policies: TransferPolicies;
    try {
      loginKey(input);
      policies = policiesOf(input);
      request = {
        ip: normalizeIp(input.ip), port: input.port, username: input.username,
        localPath: normalizeLocalPath(input.localPath),
        remotePath: normalizeRemotePath(input.remotePath), ...policies
      };
      this.prune();
      if (this.admitted >= this.limits.admitted || this.tasks.size + this.admitting.size >= this.limits.records) {
        throw new LiteSshError('RESOURCE_LIMIT', 'The active/retained transfer registry budget has been reached.');
      }
    } catch (error) { return Promise.reject(error); }
    const baseBytes = Buffer.byteLength(JSON.stringify(request)) + 4096;
    try { this.reserve(baseBytes); } catch (error) { return Promise.reject(error); }
    this.admitted++; // Reserve before asynchronous authentication/channel work.
    const operation = this.admit(direction, request, policies, baseBytes);
    this.admitting.add(operation);
    void operation.finally(() => this.admitting.delete(operation)).catch(() => {});
    return operation;
  }

  private reserve(bytes: number): void {
    if (this.memoryUsed + bytes > this.memoryMaximum) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The aggregate transfer planning/record memory budget has been reached.');
    }
    this.memoryUsed += bytes;
  }

  private async admit(direction: TransferDirection, request: TransferRequest, policies: TransferPolicies, baseBytes: number): Promise<Record<string, unknown>> {
    let lease: ConnectionLease | undefined;
    let remote: OwnedRemoteFileSystem | undefined;
    let registered = false;
    try {
      lease = await this.pool.acquire(request);
      if (this.stopping) throw new LiteSshError('SERVER_STOPPING', 'The MCP instance is shutting down.');
      remote = await (this.options.remote ?? RemoteFileSystem.open)(lease.client);
      if (this.stopping) throw new LiteSshError('SERVER_STOPPING', 'The MCP instance is shutting down.');
      const local = (this.options.local ?? (() => new LocalFileSystem()))();
      let resolveCompletion!: () => void;
      const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
      const task: Task = {
        transferId: `tr_${randomUUID()}`, direction,
        request: { ...request, ...lease.target }, policies, lease, remote,
        sourceFs: direction === 'upload' ? local : remote,
        targetFs: direction === 'upload' ? remote : local,
        controller: new AbortController(), phase: 'queued', createdAt: this.now(),
        progress: { filesCommitted: 0, directoriesCreated: 0, bytesTransferred: 0, bytesCommitted: 0 },
        cleanup: { complete: true, residualPaths: [], possibleResidualPaths: [], outcomeUnknown: false },
        accountedBytes: baseBytes, started: false, completion, resolveCompletion
      };
      this.tasks.set(task.transferId, task);
      registered = true;
      this.schedule();
      return { ok: true, accepted: true, ...this.summary(task) };
    } finally {
      if (!registered) {
        try { if (remote) await remote.dispose(); }
        finally {
          try { if (lease) await lease.release(); }
          finally { this.admitted--; this.memoryUsed -= baseBytes; }
        }
      }
    }
  }

  private schedule(): void {
    if (this.stopping || this.pumpTimer) return;
    this.pumpTimer = setImmediate(() => {
      this.pumpTimer = undefined;
      for (const task of this.tasks.values()) {
        if (this.executing >= this.limits.concurrent) break;
        if (task.phase !== 'queued' || task.started || task.finishing) continue;
        task.started = true;
        this.executing++;
        void this.execute(task).finally(() => {
          this.executing--;
          this.schedule();
        }).catch(() => {});
      }
    });
  }

  private async execute(task: Task): Promise<void> {
    try {
      task.phase = 'planning';
      const source = task.direction === 'upload' ? task.request.localPath : task.request.remotePath;
      const target = task.direction === 'upload' ? task.request.remotePath : task.request.localPath;
      task.plan = await planTransfer(task.sourceFs, task.targetFs, source, target, task.policies, this.limits, task.controller.signal, bytes => {
        this.reserve(bytes);
        task.accountedBytes += bytes;
      });
      if (task.controller.signal.aborted) {
        task.phase = 'cancelling';
      } else if (task.plan.issues.length || !task.plan.planningComplete) {
        const blocked = task.plan.issues.every(issue => ['TARGET_EXISTS', 'SYMLINK_BLOCKED'].includes(issue.code));
        task.phase = blocked ? 'blocked' : 'failed';
      } else {
        task.phase = 'running';
        task.outcome = await runTransfer(task.sourceFs, task.targetFs, task.plan, task.policies, task.transferId, this.limits, task.controller.signal, (progress, results) => { task.progress = progress; task.results = results; });
        task.phase = task.outcome.phase === 'cancelled' ? 'cancelling' : task.outcome.phase;
        task.cleanup = task.outcome.cleanup;
        task.error = task.outcome.error;
      }
    } catch (error) {
      const failure = fileError(error);
      task.phase = failure.code === 'TRANSFER_CANCELLED' ? 'cancelling' : 'failed';
      if (failure.code !== 'TRANSFER_CANCELLED') task.error = { code: failure.code, message: failure.message, details: failure.details };
    } finally { await this.finish(task); }
  }

  private finish(task: Task): Promise<void> {
    task.finishing ??= (async () => {
      let terminalPhase = task.phase;
      if (isTerminalPhase(terminalPhase)) {
        // File completion is not yet complete task teardown. Keep a factual
        // working phase until channel/lease cleanup settles; terminal status
        // and endedAt are published together below, without another yield.
        task.phase = task.outcome ? 'running' : task.started ? 'planning' : 'queued';
      }
      try {
        task.channelClosed = await task.remote.dispose();
        if (!task.channelClosed || task.remote.effectUnknown) {
          task.cleanup.complete = false;
          task.cleanup.outcomeUnknown = true;
          terminalPhase = task.progress.filesCommitted || task.progress.directoriesCreated ? 'partial_failed' : 'failed';
          task.error ??= { code: 'SFTP_OUTCOME_UNKNOWN', message: 'An SFTP effect or channel close was not confirmed. No operation was replayed.', details: {} };
        }
      } catch {
        task.channelClosed = false;
        task.cleanup.complete = false;
        task.cleanup.outcomeUnknown = true;
        terminalPhase = 'failed';
        task.error ??= { code: 'SFTP_CLEANUP_FAILED', message: 'The owned SFTP channel could not be closed.', details: {} };
      } finally {
        try { await task.lease.release(); }
        catch {
          task.cleanup.complete = false;
          task.cleanup.outcomeUnknown = true;
          terminalPhase = task.progress.filesCommitted || task.progress.directoriesCreated ? 'partial_failed' : 'failed';
          task.error ??= { code: 'CONNECTION_CLEANUP_FAILED', message: 'The owned connection lease could not be released.', details: {} };
        }
        this.admitted--;
        // Confirmed scheduling/channel stop is terminal even when a changed
        // temporary must be left for manual recovery. Cleanup uncertainty is
        // not an excuse to retain a stopped task in cancelling forever.
        if (terminalPhase === 'cancelling' && task.channelClosed === true) terminalPhase = 'cancelled';
        task.phase = terminalPhase;
        task.endedAt = this.now();
        task.expiresAt = task.endedAt + this.limits.retentionMs;
        task.resolveCompletion();
        this.armExpiry();
      }
    })();
    return task.finishing;
  }

  private summary(task: Task): Record<string, unknown> {
    const sourceRoot = task.direction === 'upload' ? task.request.localPath : task.request.remotePath;
    const root = task.plan?.entries.find(entry => entry.sourcePath === sourceRoot);
    let failedFiles = 0;
    for (const result of task.results?.values() ?? []) if (result.state === 'failed') failedFiles++;
    return {
      transferId: task.transferId, state: task.phase, direction: task.direction,
      ip: task.request.ip, port: task.request.port, username: task.request.username,
      localPath: task.request.localPath, remotePath: task.request.remotePath, ...task.policies,
      actualSourcePath: root?.actualSourcePath ?? null,
      actualTargetPath: root?.actualTargetPath ?? null,
      createdAt: new Date(task.createdAt).toISOString(),
      ...(task.endedAt !== undefined ? { endedAt: new Date(task.endedAt).toISOString() } : {}),
      ...(task.expiresAt !== undefined ? { recordExpiresAt: new Date(task.expiresAt).toISOString() } : {}),
      cancellationRequested: task.controller.signal.aborted,
      finishing: task.finishing !== undefined && task.endedAt === undefined,
      stopped: task.endedAt !== undefined && task.channelClosed === true,
      planningComplete: task.plan?.planningComplete ?? false,
      totalsKnown: task.plan?.planningComplete ?? false,
      filesTotal: task.plan?.planningComplete ? task.plan.filesTotal : null,
      bytesTotal: task.plan?.planningComplete ? task.plan.bytesTotal : null,
      ...task.progress, completedFiles: task.progress.filesCommitted, failedFiles,
      conflictCount: task.plan?.issues.filter(issue => ['TARGET_EXISTS', 'SYMLINK_BLOCKED', 'PATH_TYPE_CONFLICT', 'PATH_MAPPING_CONFLICT'].includes(issue.code)).length ?? 0,
      resultRetentionMs: this.limits.retentionMs,
      cleanup: task.cleanup,
      ...(task.error ? { error: { code: task.error.code, message: task.error.message, ...task.error.details } } : {}),
      guardCapabilities: { observablePathsTypesLinks: true, inodeIdentity: task.direction === 'upload' ? 'source_only' : 'target_only', crossClientTransaction: false }
    };
  }

  private page(options: Pick<PageOptions, 'offset' | 'limit'>): { offset: number; limit: number } {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? this.limits.pageSize;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > this.limits.pageMaximum) {
      throw new LiteSshError('INVALID_PAGE', 'Use a nonnegative offset and a limit within the result page budget.');
    }
    return { offset, limit };
  }

  list(options: PageOptions = {}): Record<string, unknown> {
    this.prune();
    const { offset, limit } = this.page(options);
    let tasks = [...this.tasks.values()];
    if (options.ip !== undefined) tasks = tasks.filter(task => task.request.ip === normalizeIp(options.ip!));
    if (options.port !== undefined) tasks = tasks.filter(task => task.request.port === options.port);
    if (options.username !== undefined) tasks = tasks.filter(task => task.request.username === options.username);
    return {
      ok: true, state: 'listed', transfers: tasks.slice(offset, offset + limit).map(task => this.summary(task)),
      total: tasks.length, offset, limit, hasMore: offset + limit < tasks.length,
      ...(offset + limit < tasks.length ? { nextOffset: offset + limit } : {})
    };
  }

  private find(transferId: string): Task {
    this.prune();
    const task = this.tasks.get(transferId);
    if (!task) {
      throw new LiteSshError(this.expired.has(transferId) ? 'TRANSFER_EXPIRED' : 'TRANSFER_NOT_FOUND', 'No retained transfer matches this ID in this MCP instance. Expired or restarted registries are not restored.');
    }
    return task;
  }

  status(transferId: string, options: Pick<PageOptions, 'offset' | 'limit'> = {}): Record<string, unknown> {
    const task = this.find(transferId);
    const { offset, limit } = this.page(options);
    const issues = task.plan?.issues ?? [];
    const links = task.plan?.links ?? [];
    const entries = task.plan?.entries ?? [];
    const total = issues.length + links.length + entries.length;
    const results: Record<string, unknown>[] = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      if (i < issues.length) results.push({ kind: 'issue', ...issues[i]! });
      else if (i < issues.length + links.length) results.push({ kind: 'link', ...links[i - issues.length]! });
      else {
        const entry = entries[i - issues.length - links.length]!;
        results.push({
          kind: entry.kind, sourcePath: entry.sourcePath, targetPath: entry.targetPath,
          actualSourcePath: entry.actualSourcePath, actualTargetPath: entry.actualTargetPath,
          size: entry.source.size,
          ...((task.results ?? task.outcome?.results)?.get(entry) ?? { state: 'planned', bytesTransferred: 0 })
        });
      }
    }
    return {
      ok: true, ...this.summary(task), results, total, offset, limit,
      hasMore: offset + limit < total,
      ...(offset + limit < total ? { nextOffset: offset + limit } : {})
    };
  }

  cancel(transferId: string): Record<string, unknown> {
    const task = this.find(transferId);
    if (isTerminalPhase(task.phase) || task.finishing) {
      return { ok: true, ...this.summary(task), alreadyTerminal: task.endedAt !== undefined, cancellationAccepted: false };
    }
    task.controller.abort();
    task.phase = 'cancelling';
    if (!task.started) void this.finish(task);
    return { ok: true, ...this.summary(task), cancellationAccepted: true, nextAction: 'Poll transfer_status until actual stop and cleanup are reported.' };
  }

  private prune(): void {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (task.expiresAt !== undefined && task.expiresAt <= now) {
        this.tasks.delete(id);
        this.memoryUsed -= task.accountedBytes;
        this.expired.add(id);
        if (this.expired.size > this.limits.records) this.expired.delete(this.expired.values().next().value!);
      }
    }
  }
  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.stopping) return;
    let next = Infinity;
    for (const task of this.tasks.values()) if (task.expiresAt !== undefined) next = Math.min(next, task.expiresAt);
    if (next !== Infinity) {
      this.expiryTimer = setTimeout(() => { this.expiryTimer = undefined; this.prune(); this.armExpiry(); }, Math.max(1, next - this.now()));
      this.expiryTimer.unref();
    }
  }

  dispose(): Promise<void> {
    this.stopping = true; // Admission closes before the first asynchronous yield.
    if (this.pumpTimer) clearImmediate(this.pumpTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.closing ??= (async () => {
      await Promise.allSettled([...this.admitting]);
      for (const task of this.tasks.values()) {
        if (!isTerminalPhase(task.phase) && !task.finishing) this.cancel(task.transferId);
      }
      await Promise.all([...this.tasks.values()].map(task => task.completion));
      this.tasks.clear();
      this.expired.clear();
      this.memoryUsed = 0;
    })();
    return this.closing;
  }
}
