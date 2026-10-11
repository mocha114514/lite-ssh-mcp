import { randomBytes } from 'node:crypto';
import { LiteSshError } from '../core/errors.js';
import { checkCancelled, fileError, sameMetadata, type Metadata, type ReadHandle, type TransferFileSystem, type WriteHandle } from './filesystem.js';
import { assertGuards, assertObservedGuards, resolvePath, type PathGuard } from './paths.js';
import type { PlannedEntry, TransferPlan } from './planner.js';
import type { TransferLimits, TransferPhase, TransferPolicies } from './types.js';

export interface EntryResult {
  state: 'planned' | 'merged' | 'directory_created' | 'copying' | 'committed' | 'failed';
  bytesTransferred: number;
  errorCode?: string;
}
export interface TransferProgress {
  filesCommitted: number;
  directoriesCreated: number;
  bytesTransferred: number;
  bytesCommitted: number;
}
export interface CleanupResult {
  complete: boolean;
  residualPaths: string[];
  possibleResidualPaths: string[];
  /** An acquired temporary or publication could not be safely identified. */
  outcomeUnknown: boolean;
}
export interface RunOutcome extends TransferProgress {
  phase: TransferPhase;
  results: Map<PlannedEntry, EntryResult>;
  cleanup: CleanupResult;
  error?: { code: string; message: string; details: Record<string, unknown> };
}

function selected(map: Map<string, PathGuard>, keys: string[]): PathGuard[] {
  return keys.map(key => map.get(key)!);
}

/** File-level atomic publication, not a directory-wide transaction or rollback. */
export async function runTransfer(
  sourceFs: TransferFileSystem,
  targetFs: TransferFileSystem,
  plan: TransferPlan,
  policies: TransferPolicies,
  transferId: string,
  limits: TransferLimits,
  signal: AbortSignal,
  onProgress: (progress: TransferProgress, results: Map<PlannedEntry, EntryResult>) => void = () => {}
): Promise<RunOutcome> {
  if (!plan.planningComplete || plan.issues.length) {
    throw new LiteSshError('PLAN_BLOCKED', 'A complete issue-free plan is required before any target mutation.');
  }
  const outcome: RunOutcome = {
    phase: 'running', filesCommitted: 0, directoriesCreated: 0,
    bytesTransferred: 0, bytesCommitted: 0,
    results: new Map(), cleanup: { complete: true, residualPaths: [], possibleResidualPaths: [], outcomeUnknown: false }
  };
  const buffer = Buffer.alloc(limits.chunkBytes);
  const report = (): void => onProgress({
    filesCommitted: outcome.filesCommitted, directoriesCreated: outcome.directoriesCreated,
    bytesTransferred: outcome.bytesTransferred, bytesCommitted: outcome.bytesCommitted
  }, outcome.results);
  const verifyEntry = async (entry: PlannedEntry): Promise<void> => {
    await assertGuards(sourceFs, selected(plan.sourceGuards, entry.sourceGuardKeys), true, signal);
    await assertGuards(targetFs, selected(plan.targetGuards, entry.targetGuardKeys), false, signal);
    const source = await resolvePath(sourceFs, entry.sourcePath, 'source', policies.symlinkPolicy, signal, limits.depth);
    const target = await resolvePath(targetFs, entry.targetPath, 'target', policies.symlinkPolicy, signal, limits.depth);
    if (sourceFs.key(source.actualPath) !== sourceFs.key(entry.actualSourcePath) ||
        targetFs.key(target.actualPath) !== targetFs.key(entry.actualTargetPath)) {
      throw new LiteSshError('PATH_CHANGED', 'A logical-to-actual path mapping changed after planning.');
    }
    // Newly observed metadata and guards cannot be discarded: any change in
    // identity, size, mtime or link target observed during path resolution
    // must be reconciled with expected guards and halt execution immediately.
    assertObservedGuards(sourceFs, source.guards, plan.sourceGuards, true);
    assertObservedGuards(targetFs, target.guards, plan.targetGuards, false);
  };
  const cleanupTemporary = async (entry: PlannedEntry, temporary: string, expected?: Metadata): Promise<void> => {
    try {
      // Cleanup must recheck the retained ancestor/link boundary too. Remote
      // v3 metadata has no inode: matching a file stat through a substituted
      // parent is not proof of ownership. Cancellation does not skip this.
      const boundary = selected(plan.targetGuards, entry.targetGuardKeys)
        .filter(guard => targetFs.key(guard.path) !== targetFs.key(entry.actualTargetPath));
      try { await assertGuards(targetFs, boundary, false, new AbortController().signal); }
      catch {
        outcome.cleanup.outcomeUnknown = true;
        throw new LiteSshError('TEMP_BOUNDARY_CHANGED', 'The temporary parent boundary changed; no redirected name was deleted.');
      }
      const current = await targetFs.lstat(temporary);
      if (!current) return;
      if (!expected || !sameMetadata(expected, current)) {
        outcome.cleanup.outcomeUnknown = true;
        throw new LiteSshError('TEMP_IDENTITY_CHANGED', 'The owned temporary could not be safely identified for removal.');
      }
      await targetFs.unlink(temporary);
    } catch (error) {
      outcome.cleanup.complete = false;
      if (outcome.cleanup.outcomeUnknown) outcome.cleanup.possibleResidualPaths.push(temporary);
      else outcome.cleanup.residualPaths.push(temporary);
      throw new LiteSshError('TEMP_CLEANUP_FAILED', 'An owned temporary could not be removed. Its exact residual path is reported.', { reason: fileError(error).code });
    }
  };

  try {
    checkCancelled(signal);
    if (plan.filesTotal > 0) {
      await targetFs.checkCommit?.(policies.conflictPolicy === 'overwrite_merge_on');
    }
    // Revalidate the entire preflight once before the first mkdir/temp/write.
    await assertGuards(sourceFs, plan.sourceGuards.values(), true, signal);
    await assertGuards(targetFs, plan.targetGuards.values(), false, signal);
    for (const directory of plan.directories.sort((a, b) => a.split(targetFs.paths.sep).length - b.split(targetFs.paths.sep).length)) {
      checkCancelled(signal);
      const guards: PathGuard[] = [];
      let current = directory;
      for (;;) {
        const guard = plan.targetGuards.get(targetFs.key(current));
        if (guard) guards.push(guard);
        const parent = targetFs.paths.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      await assertGuards(targetFs, guards, false, signal);
      await targetFs.mkdir(directory); // Non-recursive and exclusive; races fail.
      // The acknowledgement already confirms a mutation. Publish that fact
      // before the fallible post-check; a later disconnect cannot erase it.
      outcome.directoriesCreated++;
      report();
      const created = await targetFs.lstat(directory);
      if (created?.kind !== 'directory') throw new LiteSshError('PATH_CHANGED', 'A newly created directory changed type.');
      plan.targetGuards.set(targetFs.key(directory), { path: directory, metadata: created });
    }
    for (const entry of plan.entries) {
      checkCancelled(signal);
      await verifyEntry(entry);
      if (entry.kind === 'directory') {
        outcome.results.set(entry, { state: plan.directories.includes(entry.actualTargetPath) ? 'directory_created' : 'merged', bytesTransferred: 0 });
        report();
        continue;
      }
      const result: EntryResult = { state: 'copying', bytesTransferred: 0 };
      outcome.results.set(entry, result);
      report();
      const temporary = targetFs.paths.join(
        targetFs.paths.dirname(entry.actualTargetPath),
        `.lite-ssh-${transferId}-${randomBytes(8).toString('hex')}.tmp`
      );
      let input: ReadHandle | undefined;
      let output: WriteHandle | undefined;
      let acquired = false;
      let published = false;
      let remains = true;
      let temporaryMetadata: Metadata | undefined;
      let primary: unknown;
      try {
        input = await sourceFs.openRead(entry.actualSourcePath);
        if (!sameMetadata(entry.source, await input.stat())) {
          throw new LiteSshError('PATH_CHANGED', 'The opened source file does not match its planned identity.');
        }
        await verifyEntry(entry);
        checkCancelled(signal);
        output = await targetFs.createExclusive(temporary);
        acquired = true;
          temporaryMetadata = await output.stat();
        let position = 0;
        for (;;) {
          checkCancelled(signal);
          const read = await input.read(buffer, position);
          checkCancelled(signal);
          if (!Number.isInteger(read) || read < 0 || read > buffer.length || position + read > entry.source.size) {
            throw new LiteSshError('PATH_CHANGED', 'The source length changed or the filesystem returned an invalid read.');
          }
          if (read === 0) break;
          await output.write(buffer, read, position);
          position += read;
          result.bytesTransferred = position;
          outcome.bytesTransferred += read;
          report();
        }
        if (position !== entry.source.size || !sameMetadata(entry.source, await input.stat())) {
          throw new LiteSshError('PATH_CHANGED', 'The source changed while being copied.');
        }
        temporaryMetadata = await output.stat();
        if (temporaryMetadata.kind !== 'file' || temporaryMetadata.size !== position) {
          throw new LiteSshError('FILE_IO_FAILED', 'The temporary file did not have the written size.');
        }
        await output.close();
        output = undefined;
        await input.close();
        input = undefined;
        await verifyEntry(entry);
        await assertGuards(targetFs, [{ path: temporary, metadata: temporaryMetadata }], false, signal);
        checkCancelled(signal);
        // off uses hard-link create-only; on uses reliable replacement. Never
        // unlink the old final object as an emulated replacement operation.
        remains = await targetFs.commit(temporary, entry.actualTargetPath, policies.conflictPolicy === 'overwrite_merge_on');
        published = true;
        result.state = 'committed';
        outcome.filesCommitted++;
        outcome.bytesCommitted += position;
        report();
        const committed = await targetFs.lstat(entry.actualTargetPath);
        if (!sameMetadata(temporaryMetadata, committed)) {
          throw new LiteSshError('PATH_CHANGED', 'The published file changed before its post-commit check. Already committed content is retained.');
        }
        plan.targetGuards.set(targetFs.key(entry.actualTargetPath), { path: entry.actualTargetPath, metadata: committed });
      } catch (error) {
        primary = error;
        if (!acquired && fileError(error).details.possibleResidualPath === temporary) {
          outcome.cleanup.complete = false;
          outcome.cleanup.outcomeUnknown = true;
          outcome.cleanup.possibleResidualPaths.push(temporary);
        }
        if (!published) { result.state = 'failed'; result.errorCode = fileError(error).code; }
      } finally {
        if (output) {
          try { temporaryMetadata = await output.stat(); } catch { /* Ownership may be uncertain: no guessed deletion. */ }
          try { await output.close(); } catch (error) { primary ??= error; }
        }
        if (input) { try { await input.close(); } catch (error) { primary ??= error; } }
        if (acquired && remains) {
          try { await cleanupTemporary(entry, temporary, temporaryMetadata); }
          catch (error) { primary ??= error; }
        }
      }
      if (primary) throw primary;
    }
    outcome.phase = 'completed';
  } catch (error) {
    const failure = fileError(error);
    outcome.phase = failure.code === 'TRANSFER_CANCELLED' ? 'cancelled'
      : outcome.filesCommitted || outcome.directoriesCreated ? 'partial_failed' : 'failed';
    if (failure.code !== 'TRANSFER_CANCELLED') {
      outcome.error = { code: failure.code, message: failure.message, details: failure.details };
    }
  }
  return outcome;
}
