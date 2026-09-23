/**
 * Per-project indexing-scope allowlist persistence (Bug fix, 2026-09-23).
 *
 * Mirrors pr-bot-settings.ts's exact shape — driller's second per-project
 * settings store (`{projects: Record<projectPath, ProjectScopeConfig>}`), a
 * `Schema` interface + `defaults` object passed to `new Store<Schema>
 * ({name, defaults})`, a narrow `Store*` interface exposing only the methods
 * used, `createStore()` wrapped in try/catch with an in-memory fallback for
 * a corrupted store file or an unwritable `userData` directory. Persisted
 * via its own `electron-store` file under the same established `userData`
 * convention (AD-5) — a separate store from every existing settings store,
 * never touching any of them.
 *
 * A project with no entry yet reads back as `{includedPaths: []}` (no
 * restriction — index everything CBM itself doesn't already exclude) rather
 * than `undefined`, same "always a complete, defaulted shape" discipline as
 * `getPrBotConfig`.
 */

import Store from 'electron-store';
import type { ProjectScopeConfig } from '@driller/ipc-contracts';

interface ProjectScopeSettingsSchema {
  projects: Record<string, ProjectScopeConfig>;
}

const DEFAULT_PROJECT_SCOPE: ProjectScopeConfig = { includedPaths: [] };

/**
 * Normalizes one raw included-path entry: trims whitespace and any leading/
 * trailing path separators (so `"web/"`, `"/web"`, and `"web"` all persist
 * identically and compare identically against `CodeMapNode.file`'s own
 * project-root-relative POSIX convention), then converts OS-native
 * separators to POSIX (mirrors `services/graph-service/index.ts`'s own
 * `toProjectRelativePosixPath` normalization, applied here at the point the
 * value is entered rather than at every later comparison).
 */
function normalizeIncludedPath(raw: string): string {
  return raw
    .trim()
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Coerces a raw `includedPaths` value to a clean `string[]`: non-string/
 * empty-after-normalization entries are dropped rather than propagated (the
 * persisted file is hand-editable JSON), and duplicates are removed —
 * order otherwise preserved.
 */
function coerceIncludedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const normalized = normalizeIncludedPath(entry);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Coerces one project's persisted entry to a known `ProjectScopeConfig` shape (same reasoning as `coerceIncludedPaths`, one level up). */
function coerceProjectScopeConfig(value: unknown): ProjectScopeConfig {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_PROJECT_SCOPE };
  }
  const candidate = value as { includedPaths?: unknown };
  return { includedPaths: coerceIncludedPaths(candidate.includedPaths) };
}

/** Coerces the whole persisted `projects` map — same reasoning as `coerceProjectScopeConfig`, applied one level up. */
function coerceProjects(value: unknown): Record<string, ProjectScopeConfig> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const result: Record<string, ProjectScopeConfig> = {};
  for (const [projectPath, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof projectPath === 'string' && projectPath.length > 0) {
      result[projectPath] = coerceProjectScopeConfig(entry);
    }
  }
  return result;
}

/** The subset of electron-store's API this module actually uses. */
interface ProjectScopeSettingsStore {
  getProjectScope(projectPath: string): ProjectScopeConfig;
  setProjectScope(projectPath: string, includedPaths: string[]): ProjectScopeConfig;
}

/**
 * Constructs the persisted project-scope settings store. A corrupted
 * settings file or an unwritable `userData` directory must not crash the
 * app — falls back to an in-memory store for the session instead (mirrors
 * pr-bot-settings.ts's own `createStore`).
 */
function createStore(): ProjectScopeSettingsStore {
  try {
    const store = new Store<ProjectScopeSettingsSchema>({
      name: 'driller-project-scope-settings',
      defaults: { projects: {} },
    });
    return {
      getProjectScope: (projectPath) => {
        const projects = coerceProjects(store.get('projects', {}));
        return projects[projectPath] ?? { ...DEFAULT_PROJECT_SCOPE };
      },
      // Merge-write, same discipline as pr-bot-settings.ts's
      // `setProjectBotEnabled`: reads the current full `projects` map,
      // replaces only this one project's entry, writes the whole map back —
      // every other project's entry is left byte-identical.
      setProjectScope: (projectPath, includedPaths) => {
        const projects = coerceProjects(store.get('projects', {}));
        const updated: ProjectScopeConfig = { includedPaths: coerceIncludedPaths(includedPaths) };
        const nextProjects = { ...projects, [projectPath]: updated };
        try {
          store.set('projects', nextProjects);
        } catch (error) {
          console.error(
            'Failed to persist project-scope settings.',
            error instanceof Error ? error.message : 'Unknown error',
          );
        }
        return updated;
      },
    };
  } catch (error) {
    console.error(
      'Failed to initialize persisted project-scope settings store; falling back to an in-memory store for this session.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    let inMemoryProjects: Record<string, ProjectScopeConfig> = {};
    return {
      getProjectScope: (projectPath) => inMemoryProjects[projectPath] ?? { ...DEFAULT_PROJECT_SCOPE },
      setProjectScope: (projectPath, includedPaths) => {
        const updated: ProjectScopeConfig = { includedPaths: coerceIncludedPaths(includedPaths) };
        inMemoryProjects = { ...inMemoryProjects, [projectPath]: updated };
        return updated;
      },
    };
  }
}

const store = createStore();

/**
 * Returns the current indexing-scope allowlist for `projectPath`. Always a
 * complete `ProjectScopeConfig` — `{includedPaths: []}` (no restriction)
 * when this project has no persisted entry yet, never `undefined`/unset.
 */
export function getProjectScope(projectPath: string): ProjectScopeConfig {
  return store.getProjectScope(projectPath);
}

/**
 * Sets `projectPath`'s indexing-scope allowlist, replacing its entry
 * wholesale (every other project's entry is left untouched). Returns the
 * project's updated, normalized `ProjectScopeConfig`.
 */
export function setProjectScope(projectPath: string, includedPaths: string[]): ProjectScopeConfig {
  return store.setProjectScope(projectPath, includedPaths);
}
