import { LiteSshError } from '../core/errors.js';
import { checkCancelled, sameMetadata, type Metadata, type TransferFileSystem } from './filesystem.js';
import { TRANSFER_LIMITS, type SymlinkPolicy, type TransferIssue } from './types.js';

export interface PathGuard {
  path: string;
  metadata?: Metadata;
  linkTarget?: string;
  /** Only enumerated source directories watch child-list changes. */
  watchContents?: boolean;
  /** A missing ordinary target component must be created as a directory. */
  directoryRequired?: boolean;
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
  /** Includes syntactic directory paths and missing parents revisited as a leaf. */
  directoryRequired: boolean;
}

export class PlanningError extends LiteSshError {
  constructor(readonly issue: TransferIssue, readonly incomplete = false) {
    super(issue.code, 'The transfer path could not be safely planned.', { ...issue });
  }
}

/** Append a logical child without erasing still-unresolved link/.. components. */
export function appendLogicalPath(
  paths: TransferFileSystem['paths'],
  parent: string,
  name: string
): string {
  return parent.endsWith(paths.sep) ? `${parent}${name}` : `${parent}${paths.sep}${name}`;
}

/** Resolve every component with lstat: realpath alone would silently follow off-policy links. */
export async function resolvePath(
  fs: TransferFileSystem,
  logicalPath: string,
  side: 'source' | 'target',
  policy: SymlinkPolicy,
  signal: AbortSignal,
  maxDepth: number,
  retainGuard?: (guard: PathGuard) => PathGuard,
  retainState?: (state: string) => void
): Promise<ResolvedPath> {
  const paths = fs.paths;
  const separators = (value: string): string => fs.platform === 'windows'
    ? value.replace(/\//gu, paths.sep)
    : value;
  const partsOf = (value: string, root: string): string[] => {
    if (value.includes('\0') || value.length > 32_768) {
      throw new LiteSshError('RESOURCE_LIMIT', 'A path expansion exceeded its bounded representation.');
    }
    const parts = value.slice(root.length).split(paths.sep).filter(Boolean);
    if (parts.length > maxDepth) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The ordinary path-component depth budget was exceeded before guard expansion.');
    }
    return parts;
  };
  const input = separators(logicalPath);
  fs.validate(input);
  let current = paths.parse(input).root;
  const inputParts = partsOf(input, current);
  const finalPart = inputParts.at(-1);
  let explicitDirectory = input.endsWith(paths.sep) || finalPart === '.' || finalPart === '..';
  let remaining = inputParts.map(part => ({ part, required: false }));
  const guards: PathGuard[] = [];
  const links: LinkMapping[] = [];
  let scratchBytes = 0;
  const charge = (value: unknown): void => {
    // Execution revalidation also calls this resolver without plan callbacks.
    // Bound its temporary guards, links and complete cycle states separately;
    // a namespace race must not turn a previously small plan into huge scratch.
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8') + 128;
    if (scratchBytes + bytes > TRANSFER_LIMITS.planningBytes) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The path resolver scratch budget was exceeded.');
    }
    scratchBytes += bytes;
  };
  const retain = (guard: PathGuard): void => {
    charge(guard);
    guards.push(retainGuard ? retainGuard(guard) : guard);
  };
  const visited = new Set<string>();
  let last = await fs.lstat(current);
  retain({ path: current, metadata: last });
  while (remaining.length) {
    checkCancelled(signal);
    // .. is legal only after resolving its preceding object as a directory.
    // In particular, file/.. must not become a different sibling file.
    if (last && last.kind !== 'directory') {
      throw new PlanningError({ code: 'PATH_TYPE_CONFLICT', side, actualPath: current });
    }
    const component = remaining.shift()!;
    current = component.part === '.'
      ? current
      : component.part === '..'
        ? paths.dirname(current)
        : paths.join(current, component.part);
    if (current.length > 32_768) {
      throw new LiteSshError('RESOURCE_LIMIT', 'The resolved path representation was too long.');
    }
    fs.validate(current);
    last = await fs.lstat(current);
    const guard: PathGuard = { path: current, metadata: last };
    if (!last && (remaining.length > 0 || component.part === '.')) {
      guard.directoryRequired = true;
    }
    if (last?.kind === 'symlink') {
      guard.linkTarget = await fs.readlink(current);
      if (guard.linkTarget.includes('\0') || guard.linkTarget.length > 32_768) {
        throw new LiteSshError('RESOURCE_LIMIT', 'The link target representation exceeded its budget.');
      }
    }
    retain(guard);
    if (!last) {
      if (component.required) {
        throw new PlanningError({ code: 'BROKEN_SYMLINK', side, actualPath: current }, true);
      }
      if (side === 'source') {
        throw new PlanningError({ code: 'PATH_NOT_FOUND', side, actualPath: current }, true);
      }
      // Continue through ordinary missing target parents. They are planned
      // directories, but a later .. may return to an existing guarded object.
      // Never overwrite that object's real metadata with a missing guard.
      continue;
    }
    if (last.kind === 'symlink') {
      const issue = { code: 'SYMLINK_BLOCKED', side, actualPath: current, linkTarget: guard.linkTarget };
      if (policy === 'symlink_follow_off') throw new PlanningError(issue, true);
      // A repeated link is not necessarily a cycle: link/link/f can consume
      // its suffix each time. Include the remaining work and required flags.
      const state = JSON.stringify([fs.key(current), remaining]);
      if (visited.has(state)) {
        throw new PlanningError({ ...issue, code: 'SYMLINK_LOOP' }, true);
      }
      if (visited.size >= maxDepth) {
        throw new LiteSshError('RESOURCE_LIMIT', 'The link expansion budget was exceeded.');
      }
      charge(state);
      retainState?.(state);
      visited.add(state);
      const mapping = { side, logicalPath, linkPath: current, linkTarget: guard.linkTarget!, actualPath: '' };
      charge(mapping);
      links.push(mapping);
      const target = separators(guard.linkTarget!);
      if (!target) {
        throw new PlanningError({ ...issue, code: 'BROKEN_SYMLINK' }, true);
      }
      if (remaining.length === 0 && target.endsWith(paths.sep)) explicitDirectory = true;
      const targetRoot = paths.parse(target).root;
      // Resolve ONLY a root/drive prefix. Joining the target's components
      // here would erase nested links before the policy can inspect them.
      const base = targetRoot
        ? paths.resolve(paths.dirname(current), targetRoot)
        : paths.dirname(current);
      current = targetRoot ? paths.parse(base).root : base;
      remaining = [
        ...partsOf(base, current).map(part => ({ part, required: true })),
        ...partsOf(target, targetRoot).map(part => ({ part, required: true })),
        ...remaining
      ];
      if (remaining.length > maxDepth) {
        throw new LiteSshError('RESOURCE_LIMIT', 'The expanded path-component depth budget was exceeded.');
      }
      // This also refreshes final metadata for a link pointing exactly at /.
      last = await fs.lstat(current);
      retain({ path: current, metadata: last });
    }
  }
  const finalKey = fs.key(current);
  const directoryRequired = explicitDirectory || guards.some(guard =>
    guard.directoryRequired && fs.key(guard.path) === finalKey
  );
  if (directoryRequired && last && last.kind !== 'directory') {
    throw new PlanningError({ code: 'PATH_TYPE_CONFLICT', side, actualPath: current });
  }
  for (const link of links) link.actualPath = current;
  return { actualPath: current, metadata: last, guards, links, directoryRequired };
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

/**
 * Verify that guards and metadata newly observed during resolvePath match
 * the plan's expected guards. Newly observed metadata cannot be discarded:
 * an external modification between assertGuards and resolvePath (or during
 * path resolution) must be recognized and stopped with PATH_CHANGED.
 */
export function assertObservedGuards(
  fs: TransferFileSystem,
  observedGuards: Iterable<PathGuard>,
  expectedGuards: Map<string, PathGuard>,
  source: boolean
): void {
  for (const observed of observedGuards) {
    const key = fs.key(observed.path);
    const expected = expectedGuards.get(key);
    if (!expected) {
      throw new LiteSshError(
        'PATH_CHANGED',
        'An observable path, type, identity or link changed after planning. Scheduling stopped.',
        { side: source ? 'source' : 'target', actualPath: observed.path }
      );
    }
    const directoryChanged = source && expected.watchContents === true &&
      expected.metadata?.kind === 'directory' && observed.metadata?.kind === 'directory' &&
      (observed.metadata.mtime !== expected.metadata.mtime ||
       observed.metadata.mtimeExact !== expected.metadata.mtimeExact ||
       observed.metadata.size !== expected.metadata.size);
    if (!sameMetadata(expected.metadata, observed.metadata) || directoryChanged ||
        (expected.linkTarget !== undefined && observed.linkTarget !== expected.linkTarget)) {
      throw new LiteSshError(
        'PATH_CHANGED',
        'An observable path, type, identity or link changed after planning. Scheduling stopped.',
        { side: source ? 'source' : 'target', actualPath: observed.path }
      );
    }
  }
}
