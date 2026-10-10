import { LiteSshError } from '../core/errors.js';
import { checkCancelled, fileError, type Metadata, type TransferFileSystem } from './filesystem.js';
import { PlanningError, resolvePath, type LinkMapping, type PathGuard } from './paths.js';
import type { TransferIssue, TransferLimits, TransferPolicies } from './types.js';

export interface PlannedEntry {
  kind: 'file' | 'directory';
  sourcePath: string;
  targetPath: string;
  actualSourcePath: string;
  actualTargetPath: string;
  source: Metadata;
  sourceGuardKeys: string[];
  targetGuardKeys: string[];
}
export interface TransferPlan {
  planningComplete: boolean;
  entries: PlannedEntry[];
  issues: TransferIssue[];
  links: LinkMapping[];
  sourceGuards: Map<string, PathGuard>;
  targetGuards: Map<string, PathGuard>;
  directories: string[];
  filesTotal: number;
  bytesTotal: number;
  retainedBytes: number;
}

/** Hard bounds fail the task. We never truncate and then claim a complete plan. */
export class PlanningBudget {
  entries = 0;
  bytes = 0;
  constructor(private readonly limits: TransferLimits, private readonly reserve?: (bytes: number) => void) {}
  object(): void {
    if (++this.entries > this.limits.entries) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The source entry budget was exceeded; no target writes were performed.');
    }
  }
  retain(value: unknown): void {
    const size = Buffer.byteLength(JSON.stringify(value), 'utf8') + 128;
    if (this.bytes + size > this.limits.planningBytes) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The planning/result memory budget was exceeded; the plan is incomplete.');
    }
    this.reserve?.(size);
    this.bytes += size;
  }
}

export async function planTransfer(
  sourceFs: TransferFileSystem,
  targetFs: TransferFileSystem,
  sourcePath: string,
  targetPath: string,
  policies: TransferPolicies,
  limits: TransferLimits,
  signal: AbortSignal,
  reserve?: (bytes: number) => void
): Promise<TransferPlan> {
  const budget = new PlanningBudget(limits, reserve);
  const plan: TransferPlan = {
    planningComplete: true, entries: [], issues: [], links: [],
    sourceGuards: new Map(), targetGuards: new Map(), directories: [],
    filesTotal: 0, bytesTotal: 0, retainedBytes: 0
  };
  const targetFiles = new Map<string, PlannedEntry>();
  const targetKinds = new Map<string, string>();
  const directories = new Set<string>();
  const addIssue = (issue: TransferIssue): void => { budget.retain(issue); plan.issues.push(issue); };
  const retainResolvedGuard = (fs: TransferFileSystem, map: Map<string, PathGuard>, guard: PathGuard): PathGuard => {
    const key = fs.key(guard.path);
    const previous = map.get(key);
    if (previous) return previous;
    // Charge while resolving, not after an unbounded prefix list exists.
    budget.retain(guard);
    map.set(key, guard);
    return guard;
  };
  const retainGuards = (fs: TransferFileSystem, guards: PathGuard[], map: Map<string, PathGuard>): string[] => {
    const keys: string[] = [];
    for (const guard of guards) {
      const key = fs.key(guard.path);
      if (!map.has(key)) { budget.retain(guard); map.set(key, guard); }
      keys.push(key);
    }
    return keys;
  };
  const addLinks = (links: LinkMapping[]): void => {
    for (const link of links) { budget.retain(link); plan.links.push(link); }
  };

  const walk = async (logicalSource: string, logicalTarget: string, ancestors: Set<string>, depth: number): Promise<void> => {
    checkCancelled(signal);
    budget.object();
    if (depth > limits.depth) throw new LiteSshError('RESOURCE_LIMIT', 'The traversal depth budget was exceeded.');
    let source;
    try {
      source = await resolvePath(sourceFs, logicalSource, 'source', policies.symlinkPolicy, signal, limits.depth, guard => retainResolvedGuard(sourceFs, plan.sourceGuards, guard));
    } catch (error) {
      if (!(error instanceof PlanningError)) throw error;
      addIssue({ ...error.issue, sourcePath: logicalSource, targetPath: logicalTarget });
      if (error.incomplete) plan.planningComplete = false;
      return;
    }
    addLinks(source.links);
    if (!source.metadata || source.metadata.kind === 'special') {
      addIssue({ code: source.metadata ? 'SPECIAL_FILE_UNSUPPORTED' : 'PATH_NOT_FOUND', side: 'source', sourcePath: logicalSource, targetPath: logicalTarget, actualPath: source.actualPath });
      plan.planningComplete = false;
      return;
    }
    const sourceKey = sourceFs.key(source.actualPath);
    if (source.metadata.kind === 'directory' && ancestors.has(sourceKey)) {
      addIssue({ code: 'SYMLINK_LOOP', side: 'source', sourcePath: logicalSource, targetPath: logicalTarget, actualPath: source.actualPath });
      plan.planningComplete = false;
      return;
    }
    if (source.metadata.kind === 'directory') {
      const directoryGuard = source.guards.find(guard => sourceFs.key(guard.path) === sourceKey);
      if (directoryGuard) directoryGuard.watchContents = true;
    }
    const sourceGuardKeys = retainGuards(sourceFs, source.guards, plan.sourceGuards);
    if (source.metadata.kind === 'directory') plan.sourceGuards.get(sourceKey)!.watchContents = true;
    let target;
    try {
      target = await resolvePath(targetFs, logicalTarget, 'target', policies.symlinkPolicy, signal, limits.depth, guard => retainResolvedGuard(targetFs, plan.targetGuards, guard));
      addLinks(target.links);
    } catch (error) {
      if (!(error instanceof PlanningError)) throw error;
      addIssue({ ...error.issue, sourcePath: logicalSource, targetPath: logicalTarget });
      if (error.incomplete) plan.planningComplete = false;
    }
    if (target) {
      const targetGuardKeys = retainGuards(targetFs, target.guards, plan.targetGuards);
      const kind = source.metadata.kind as 'file' | 'directory';
      const entry: PlannedEntry = {
        kind, sourcePath: logicalSource, targetPath: logicalTarget,
        actualSourcePath: source.actualPath, actualTargetPath: target.actualPath,
        source: source.metadata, sourceGuardKeys, targetGuardKeys
      };
      if (target.metadata) {
        if (target.metadata.kind !== kind) {
          addIssue({ code: 'PATH_TYPE_CONFLICT', side: 'target', sourcePath: logicalSource, targetPath: logicalTarget, actualPath: target.actualPath, sourceType: kind, targetType: target.metadata.kind });
        } else if (policies.conflictPolicy === 'overwrite_merge_off') {
          addIssue({ code: 'TARGET_EXISTS', side: 'target', sourcePath: logicalSource, targetPath: logicalTarget, actualPath: target.actualPath, sourceType: kind, targetType: target.metadata.kind });
        }
      }
      const key = targetFs.key(target.actualPath);
      const previousKind = targetKinds.get(key);
      if (previousKind && previousKind !== kind) {
        addIssue({ code: 'PATH_MAPPING_CONFLICT', sourcePath: logicalSource, targetPath: logicalTarget, actualPath: target.actualPath });
      }
      targetKinds.set(key, kind);
      if (kind === 'file') {
        if (!Number.isSafeInteger(entry.source.size) || entry.source.size < 0 || !Number.isSafeInteger(plan.bytesTotal + entry.source.size)) {
          throw new LiteSshError('RESOURCE_LIMIT', 'The file-size precision budget was exceeded.');
        }
        const fileKeys = [key];
        if (target.metadata?.kind === 'file' && target.metadata.identity) {
          // Local download targets expose exact inode IDs, so detect known
          // hard-link aliases too. SFTP v3 cannot promise this remote identity.
          fileKeys.push(`\0identity:${target.metadata.identity}`);
        }
        const previous = fileKeys.map(fileKey => targetFiles.get(fileKey)).find(value => value !== undefined);
        const sameSource = previous && (previous.source.identity && entry.source.identity
          ? previous.source.identity === entry.source.identity
          : sourceFs.key(previous.actualSourcePath) === sourceKey);
        if (previous && !sameSource) {
          addIssue({ code: 'PATH_MAPPING_CONFLICT', sourcePath: logicalSource, otherSourcePath: previous.sourcePath, targetPath: logicalTarget, actualPath: target.actualPath });
        } else { for (const fileKey of fileKeys) targetFiles.set(fileKey, entry); }
        plan.filesTotal++;
        plan.bytesTotal += entry.source.size;
      }
      // Include missing ordinary ancestors, but never mkdir a file leaf.
      for (const guard of target.guards) {
        if (!guard.metadata && (guard.path !== target.actualPath || kind === 'directory') && !directories.has(targetFs.key(guard.path))) {
          budget.retain(guard.path);
          directories.add(targetFs.key(guard.path));
          plan.directories.push(guard.path);
        }
      }
      budget.retain(entry);
      plan.entries.push(entry);
    }
    if (source.metadata.kind === 'directory') {
      const nested = new Set(ancestors);
      nested.add(sourceKey);
      const seen = new Set<string>();
      for await (const name of sourceFs.entries(source.actualPath)) {
        checkCancelled(signal);
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') ||
            (targetFs.platform === 'windows' && name.includes('\\')) || seen.has(name)) {
          throw new LiteSshError('INVALID_DIRECTORY_ENTRY', 'An entry name is unsafe, duplicate or not representable at the target. Names are not silently changed.');
        }
        // This enumeration set is bounded too; malicious duplicate batches
        // must not consume unlimited memory before the entry limit fires.
        budget.retain(name);
        seen.add(name);
        await walk(sourceFs.paths.join(logicalSource, name), targetFs.paths.join(logicalTarget, name), nested, depth + 1);
      }
    }
  };
  try {
    await walk(sourcePath, targetPath, new Set(), 0);
  } catch (error) {
    if ((error as LiteSshError).code === 'TRANSFER_CANCELLED') throw error;
    plan.planningComplete = false;
    const failure = fileError(error);
    // A final diagnostic must survive an exhausted result budget without
    // retaining another unbounded list. Only a fixed-size error code is added.
    plan.issues.push({ code: failure.code });
  }
  plan.retainedBytes = budget.bytes;
  return plan;
}
