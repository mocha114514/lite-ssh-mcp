import { LiteSshError } from '../core/errors.js';
import { checkCancelled, sameMetadata, type Metadata, type TransferFileSystem } from './filesystem.js';
import type { SymlinkPolicy, TransferIssue } from './types.js';

export interface PathGuard {
  path: string;
  metadata?: Metadata;
  linkTarget?: string;
  /** Only enumerated source directories watch child-list changes. */
  watchContents?: boolean;
}
export interface LinkMapping {
  side: 'source' | 'target';
  logicalPath: string;
  linkPath: string;
  linkTarget: string;
  actualPath: string;
}
export interface ResolvedPath {
  actualPath: string;
  metadata?: Metadata;
  guards: PathGuard[];
  links: LinkMapping[];
}

export class PlanningError extends LiteSshError {
  constructor(readonly issue: TransferIssue, readonly incomplete = false) {
    super(issue.code, 'The transfer path could not be safely planned.', { ...issue });
  }
}

/** Resolve every component with lstat: realpath alone would silently follow off-policy links. */
export async function resolvePath(
  fs: TransferFileSystem,
  logicalPath: string,
  side: 'source' | 'target',
  policy: SymlinkPolicy,
  signal: AbortSignal,
  maxDepth: number,
  retainGuard?: (guard: PathGuard) => PathGuard
): Promise<ResolvedPath> {
  fs.validate(logicalPath);
  const paths = fs.paths;
  const partsOf = (value: string, root: string): string[] => {
    const parts = value.slice(root.length).split(paths.sep).filter(Boolean);
    if (parts.length > maxDepth) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The ordinary path-component depth budget was exceeded before guard expansion.');
    }
    return parts;
  };
  let current = paths.parse(logicalPath).root;
  let remaining = partsOf(logicalPath, current)
    .map(part => ({ part, required: false }));
  const guards: PathGuard[] = [];
  const links: LinkMapping[] = [];
  const retain = (guard: PathGuard): void => { guards.push(retainGuard ? retainGuard(guard) : guard); };
  const visited = new Set<string>();
  let last = await fs.lstat(current);
  retain({ path: current, metadata: last });
  while (remaining.length) {
    checkCancelled(signal);
    const component = remaining.shift()!;
    current = paths.join(current, component.part);
    fs.validate(current);
    last = await fs.lstat(current);
    const guard: PathGuard = { path: current, metadata: last };
    if (last?.kind === 'symlink') guard.linkTarget = await fs.readlink(current);
    retain(guard);
    if (!last) {
      if (component.required) throw new PlanningError({ code: 'BROKEN_SYMLINK', side, actualPath: current }, true);
      // Nonexistent target parents are ordinary planned directories, not
      // overwrite conflicts. Retain a guard for every missing component.
      for (const next of remaining) {
        current = paths.join(current, next.part);
        fs.validate(current);
        retain({ path: current });
      }
      remaining = [];
      break;
    }
    if (last.kind === 'symlink') {
      const issue = { code: 'SYMLINK_BLOCKED', side, actualPath: current, linkTarget: guard.linkTarget };
      if (policy === 'symlink_follow_off') throw new PlanningError(issue, true);
      if (visited.has(fs.key(current)) || visited.size >= maxDepth) {
        throw new PlanningError({ ...issue, code: 'SYMLINK_LOOP' }, true);
      }
      visited.add(fs.key(current));
      links.push({ side, logicalPath, linkPath: current, linkTarget: guard.linkTarget!, actualPath: '' });
      const resolved = paths.resolve(paths.dirname(current), guard.linkTarget!);
      current = paths.parse(resolved).root;
      remaining = [
        ...partsOf(resolved, current).map(part => ({ part, required: true })),
        ...remaining
      ];
      if (remaining.length > maxDepth) throw new LiteSshError('RESOURCE_LIMIT', 'The expanded path-component depth budget was exceeded.');
      retain({ path: current, metadata: await fs.lstat(current) });
      continue;
    }
    if (remaining.length && last.kind !== 'directory') {
      throw new PlanningError({ code: 'PATH_TYPE_CONFLICT', side, actualPath: current });
    }
  }
  for (const link of links) link.actualPath = current;
  return { actualPath: current, metadata: last, guards, links };
}

export async function assertGuards(
  fs: TransferFileSystem,
  guards: Iterable<PathGuard>,
  source: boolean,
  signal: AbortSignal
): Promise<void> {
  for (const guard of guards) {
    checkCancelled(signal);
    const current = await fs.lstat(guard.path);
    const directoryChanged = source && guard.watchContents === true && guard.metadata?.kind === 'directory' && current?.kind === 'directory' &&
      (current.mtime !== guard.metadata.mtime || current.mtimeExact !== guard.metadata.mtimeExact || current.size !== guard.metadata.size);
    if (!sameMetadata(guard.metadata, current) || directoryChanged ||
        (guard.linkTarget !== undefined && await fs.readlink(guard.path) !== guard.linkTarget)) {
      throw new LiteSshError('PATH_CHANGED', 'An observable path, type, identity or link changed after planning. Scheduling stopped.', { side: source ? 'source' : 'target', actualPath: guard.path });
    }
  }
}
