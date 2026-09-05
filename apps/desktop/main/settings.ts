/**
 * App settings persistence (AD-5).
 *
 * Structured app settings — here, just the Recent Projects list — are
 * persisted via `electron-store` under `app.getPath('userData')` (its
 * default `cwd`). driller is single-repo-at-a-time (UX-DR30): this list is
 * history to reopen from, not multiple simultaneously-open projects.
 */

import Store from 'electron-store';
import type { RecentProject } from '@driller/ipc-contracts';

interface SettingsSchema {
  recentProjects: RecentProject[];
}

const MAX_RECENT_PROJECTS = 10;

/** The subset of electron-store's API this module actually uses. */
interface SettingsStore {
  get(key: 'recentProjects', defaultValue: RecentProject[]): RecentProject[];
  set(key: 'recentProjects', value: RecentProject[]): void;
}

/**
 * Constructs the persisted settings store. A corrupted settings file (e.g.
 * hand-edited into invalid JSON) or an unwritable `userData` directory must
 * not crash the app before any window opens — fall back to an in-memory
 * store for the session instead.
 */
function createStore(): SettingsStore {
  try {
    return new Store<SettingsSchema>({
      name: 'driller-settings',
      defaults: {
        recentProjects: [],
      },
    });
  } catch (error) {
    console.error(
      'Failed to initialize persisted settings store; falling back to an in-memory store for this session.',
      error,
    );
    let inMemoryRecentProjects: RecentProject[] = [];
    return {
      get: (_key, defaultValue) => inMemoryRecentProjects ?? defaultValue,
      set: (_key, value) => {
        inMemoryRecentProjects = value;
      },
    };
  }
}

const store = createStore();

/** Returns recent projects, most-recently-opened first. */
export function listRecentProjects(): RecentProject[] {
  const value = store.get('recentProjects', []);
  // Guard against a corrupted/hand-edited persisted value that isn't
  // actually an array (would otherwise throw inside recordProjectOpened's
  // .filter() below).
  return Array.isArray(value) ? value : [];
}

/** Records a project as just-opened, moving it to the front of the list. */
export function recordProjectOpened(projectPath: string): RecentProject {
  const project: RecentProject = {
    path: projectPath,
    name: pathBasename(projectPath),
    lastOpenedAt: new Date().toISOString(),
  };

  const normalizedNewPath = normalizePathForComparison(project.path);
  const withoutDuplicate = listRecentProjects().filter(
    (existing) => normalizePathForComparison(existing.path) !== normalizedNewPath,
  );
  const next = [project, ...withoutDuplicate].slice(0, MAX_RECENT_PROJECTS);
  store.set('recentProjects', next);

  return project;
}

function pathBasename(projectPath: string): string {
  // Trim a trailing separator so basename doesn't return '' for e.g. "/foo/".
  const trimmed = projectPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * Normalizes a path for de-duplication purposes: strips a trailing
 * separator and case-folds it. Case-insensitive filesystems (macOS and
 * Windows defaults) would otherwise treat differently-cased or
 * trailing-slash variants of the same folder as distinct Recent Projects
 * entries.
 */
function normalizePathForComparison(projectPath: string): string {
  return projectPath.replace(/[\\/]+$/, '').toLowerCase();
}
