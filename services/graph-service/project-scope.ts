/**
 * P2-1: the pure half of applying a saved indexing scope to a running Graph
 * Service (`graphService:scopeChanged`). Kept out of `index.ts` so tests can
 * import it without that module's load-time side effects (record-store init,
 * MCP port bind, `parentPort` listener).
 *
 * The scope is a query-time filter (`filterCodeMapToScope`), so "applying" it
 * is only a state hand-off. The one ordering hazard is an index already in
 * flight: its request carried the scope main read when it was sent, and its
 * success branch would otherwise overwrite a newer scope saved while it ran.
 */
import path from 'node:path';

import type { GraphServiceScopeChangedRequest } from '@driller/ipc-contracts';

/** A scope saved for `path` while an index for `path` was in flight. */
export interface PendingScopeOverride {
  path: string;
  includedPaths: readonly string[];
}

/**
 * The scope an index for `projectPath` finishes with: a scope saved for this
 * same project while it was in flight wins over the one its request carried;
 * an override for any other project is ignored.
 */
export function resolveIncludedPathsOnIndexSuccess(
  projectPath: string,
  requested: readonly string[],
  override: PendingScopeOverride | undefined,
): readonly string[] {
  return override !== undefined && override.path === projectPath ? override.includedPaths : requested;
}

/** The Graph Service state a `scopeChanged` message reads and writes. */
export interface ScopeState {
  activeProjectPath: string | undefined;
  activeIncludedPaths: readonly string[];
  activeIndexPath: string | null;
  pendingScopeOverride: PendingScopeOverride | undefined;
}

/**
 * Applies a `scopeChanged` for `projectPath`: adopted immediately when it is
 * the active (last successfully indexed) project, and remembered as the
 * override whenever it is the most recently requested index
 * (`activeIndexPath`). Deliberately not gated on `activeIndexInFlight`: an
 * earlier project's superseded index clears that flag in its own `finally`
 * while a newer project's index is still running, which would drop a scope
 * saved for the newer one. An override recorded while no index runs is
 * harmless — `handleIndexRequest` clears it when the next index starts, on
 * success and on failure. A scope for any other project changes nothing
 * here — main persisted it, and the next index reads it.
 */
export function applyScopeChanged(
  state: ScopeState,
  projectPath: string,
  includedPaths: readonly string[],
): Pick<ScopeState, 'activeIncludedPaths' | 'pendingScopeOverride'> {
  return {
    activeIncludedPaths: projectPath === state.activeProjectPath ? includedPaths : state.activeIncludedPaths,
    pendingScopeOverride:
      projectPath === state.activeIndexPath ? { path: projectPath, includedPaths }
        : state.pendingScopeOverride,
  };
}

/**
 * Message-shape guard for `graphService:scopeChanged` — same untrusted-shape
 * treatment `index.ts`'s `isIndexRequest` gives `path`/`includedPaths`: a
 * non-empty absolute path and an array of strings.
 */
export function isScopeChangedRequest(data: unknown): data is GraphServiceScopeChangedRequest {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const { type, path: projectPath, includedPaths } = data as {
    type?: unknown;
    path?: unknown;
    includedPaths?: unknown;
  };
  return (
    type === 'graphService:scopeChanged' &&
    typeof projectPath === 'string' &&
    projectPath.length > 0 &&
    path.isAbsolute(projectPath) &&
    Array.isArray(includedPaths) &&
    includedPaths.every((entry) => typeof entry === 'string')
  );
}

/**
 * Whether a project-relative POSIX `file` is inside the indexing scope
 * `includedPaths`: always true for an empty scope; otherwise `file` equals
 * an included path or lies under it on a path boundary (`"web"` matches
 * `"web/x.ts"`, never `"webapp/x.ts"`). Pure — the caller normalizes
 * `file` first. `filterCodeMapToScope` (`index.ts`) and P4-2 phase 3a's
 * folded-Module scoping (`fold-modules.ts`) share it.
 */
export function isFileInScope(file: string, includedPaths: readonly string[]): boolean {
  return includedPaths.length === 0 || includedPaths.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
}

/**
 * P4-4 (AD-13 "Section scope", founder decision 3): the allowlist entry that
 * owns `file` — the longest entry `isFileInScope(file, [entry])` accepts, so
 * with nested entries (`apps`, `apps/web`) the nearest one wins and every
 * in-scope file belongs to exactly one section. Path-boundary aware like
 * `isFileInScope` (`web` never owns `webapp/x.ts`). `undefined` when no entry
 * contains `file` (always, for an empty allowlist). Pure — the caller
 * normalizes `file` first.
 */
export function sectionOfFile(file: string, includedPaths: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const entry of includedPaths) {
    if (isFileInScope(file, [entry]) && (owner === undefined || entry.length > owner.length)) {
      owner = entry;
    }
  }
  return owner;
}
