/**
 * P2-1: the `settingsSetProjectScope` handler's logic — validate, persist,
 * then decide whether to hand the scope to the running Graph Service
 * (`graphService:scopeChanged`) and what to reply. Persistence is injected,
 * so this is unit-tested without Electron or `electron-store`; the handler in
 * `index.ts` only supplies live state and posts the message.
 */
import type { GraphServiceScopeChangedRequest, ProjectScopeConfig, ProjectScopeSaveResult } from '@driller/ipc-contracts';

export interface ProjectScopeSaveDeps {
  /** Persists and returns the normalized config — `project-scope-settings.ts`'s `setProjectScope`. */
  persist: (projectPath: string, includedPaths: string[]) => ProjectScopeConfig;
  /** Whether a Graph Service subprocess exists right now. */
  serviceRunning: boolean;
  /** The project currently open in main, or `null`. */
  currentProjectPath: string | null;
}

export interface ProjectScopeSaveDecision {
  /** The message to post to the Graph Service, or `null` to post nothing. */
  post: GraphServiceScopeChangedRequest | null;
  result: ProjectScopeSaveResult;
}

/**
 * Throws (persisting nothing) on a malformed call, so the renderer's
 * save-error notice shows a specific sentence rather than a reply Settings
 * would read as a successful save.
 *
 * The posted `includedPaths` are the persisted, normalized value `persist`
 * returns, never the renderer's raw input — the Graph Service filters with
 * exactly what a later index would read back. Applied only for the open
 * project with a running service; otherwise it applies on the next index.
 */
export function resolveProjectScopeSave(
  projectPath: unknown,
  includedPaths: unknown,
  { persist, serviceRunning, currentProjectPath }: ProjectScopeSaveDeps,
): ProjectScopeSaveDecision {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    throw new Error("Couldn't save the indexing scope: no project was given.");
  }
  if (!Array.isArray(includedPaths) || !includedPaths.every((entry) => typeof entry === 'string')) {
    throw new Error("Couldn't save the indexing scope: the folder list wasn't a list of folder names.");
  }
  const config = persist(projectPath, includedPaths);
  if (!serviceRunning || projectPath !== currentProjectPath) {
    return { post: null, result: { config, applied: false } };
  }
  return {
    post: { type: 'graphService:scopeChanged', path: projectPath, includedPaths: [...config.includedPaths] },
    result: { config, applied: true },
  };
}
