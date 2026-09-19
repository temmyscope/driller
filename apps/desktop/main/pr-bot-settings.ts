/**
 * Per-project PR-bot opt-in settings persistence (Story 2.3, Phase 1).
 *
 * driller's first PER-PROJECT settings store — mirrors editor-settings.ts's
 * exact shape (Always, this story's Boundaries & Constraints: "mirroring
 * editor-settings.ts's shape"): a `Schema` interface + `defaults` object
 * passed to `new Store<Schema>({name, defaults})`, a narrow `Store*`
 * interface exposing only the methods used, `createStore()` wrapped in
 * try/catch with an in-memory fallback for a corrupted store file or an
 * unwritable `userData` directory. Persisted via its own `electron-store`
 * file under the same established `userData` convention (AD-5) — a separate
 * store from every existing global settings store (backend-settings.ts,
 * editor-settings.ts), never touching either of those (Never).
 *
 * Unlike editor-settings.ts's single global value, this store's schema is
 * `{projects: Record<projectPath, PrBotConfig>}` — one opt-in entry per
 * project, since PR-bot ingestion is inherently per-project (Intent). A
 * project with no entry yet reads back as `{codeRabbitEnabled: false,
 * qodoEnabled: false}` (opt-in is disabled by default, per epic-2-context.md)
 * rather than `undefined`.
 *
 * No `disclosureAcknowledged` flag anywhere here (Design Notes, this story's
 * spec) — `enabled: true` only ever reaches `setPrBotEnabled` via the
 * renderer's explicit confirm action (Settings.tsx); this module persists
 * whatever boolean it's given and enforces no disclosure gating of its own.
 */

import Store from 'electron-store';
import type { PrBotConfig, PrBotId } from '@driller/ipc-contracts';

interface PrBotSettingsSchema {
  projects: Record<string, PrBotConfig>;
}

const DEFAULT_PR_BOT_CONFIG: PrBotConfig = { codeRabbitEnabled: false, qodoEnabled: false };

/**
 * Coerces one project's persisted entry to a known `PrBotConfig` shape (same
 * reasoning as editor-settings.ts's `coerceEditorPreference`): the persisted
 * file is hand-editable JSON, so a syntactically-valid-but-malformed entry
 * (manual editing, a future format change, or a missing field) must not
 * silently propagate — each field individually falls back to `false` rather
 * than the whole entry being discarded.
 */
function coercePrBotConfig(value: unknown): PrBotConfig {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_PR_BOT_CONFIG };
  }
  const candidate = value as { codeRabbitEnabled?: unknown; qodoEnabled?: unknown };
  return {
    codeRabbitEnabled: candidate.codeRabbitEnabled === true,
    qodoEnabled: candidate.qodoEnabled === true,
  };
}

/**
 * Coerces the whole persisted `projects` map — same reasoning as
 * `coercePrBotConfig`, applied one level up: a non-object value (or a
 * corrupted individual entry) never propagates as-is.
 */
function coerceProjects(value: unknown): Record<string, PrBotConfig> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const result: Record<string, PrBotConfig> = {};
  for (const [projectPath, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof projectPath === 'string' && projectPath.length > 0) {
      result[projectPath] = coercePrBotConfig(entry);
    }
  }
  return result;
}

/** The subset of electron-store's API this module actually uses. */
interface PrBotSettingsStore {
  getProjectConfig(projectPath: string): PrBotConfig;
  setProjectBotEnabled(projectPath: string, bot: PrBotId, enabled: boolean): PrBotConfig;
}

function botFieldName(bot: PrBotId): keyof PrBotConfig {
  return bot === 'codeRabbit' ? 'codeRabbitEnabled' : 'qodoEnabled';
}

/**
 * Constructs the persisted PR-bot settings store. A corrupted settings file
 * (hand-edited into invalid JSON) or an unwritable `userData` directory must
 * not crash the app — fall back to an in-memory store for the session
 * instead (mirrors editor-settings.ts's/backend-settings.ts's own
 * `createStore`, this story's Boundaries & Constraints: "never a crash").
 */
function createStore(): PrBotSettingsStore {
  try {
    const store = new Store<PrBotSettingsSchema>({
      name: 'driller-pr-bot-settings',
      defaults: { projects: {} },
    });
    return {
      // Coerced through coerceProjects, not returned raw — same reasoning as
      // editor-settings.ts's getEditorPreferenceValue: the persisted file is
      // hand-editable JSON, so a corrupted-but-syntactically-valid value
      // here must not silently propagate as an invalid PrBotConfig.
      getProjectConfig: (projectPath) => {
        const projects = coerceProjects(store.get('projects', {}));
        return projects[projectPath] ?? { ...DEFAULT_PR_BOT_CONFIG };
      },
      // Merge-write (spec's Code Map: "merge-writes one project's entry") —
      // reads the current full `projects` map, replaces only this one
      // project's one field, and writes the whole map back; every other
      // project's entry is left byte-identical.
      setProjectBotEnabled: (projectPath, bot, enabled) => {
        const projects = coerceProjects(store.get('projects', {}));
        const current = projects[projectPath] ?? { ...DEFAULT_PR_BOT_CONFIG };
        const updated: PrBotConfig = { ...current, [botFieldName(bot)]: enabled };
        const nextProjects = { ...projects, [projectPath]: updated };
        // Guarded independently of the constructor's own try/catch above
        // (same precedent as editor-settings.ts's setEditorPreferenceValue):
        // a write can fail at runtime even after construction succeeded.
        try {
          store.set('projects', nextProjects);
        } catch (error) {
          console.error(
            'Failed to persist PR-bot settings.',
            error instanceof Error ? error.message : 'Unknown error',
          );
        }
        return updated;
      },
    };
  } catch (error) {
    console.error(
      'Failed to initialize persisted PR-bot settings store; falling back to an in-memory store for this session.',
      error instanceof Error ? error.message : 'Unknown error',
    );
    let inMemoryProjects: Record<string, PrBotConfig> = {};
    return {
      getProjectConfig: (projectPath) => inMemoryProjects[projectPath] ?? { ...DEFAULT_PR_BOT_CONFIG },
      setProjectBotEnabled: (projectPath, bot, enabled) => {
        const current = inMemoryProjects[projectPath] ?? { ...DEFAULT_PR_BOT_CONFIG };
        const updated: PrBotConfig = { ...current, [botFieldName(bot)]: enabled };
        inMemoryProjects = { ...inMemoryProjects, [projectPath]: updated };
        return updated;
      },
    };
  }
}

const store = createStore();

/**
 * Returns the current PR-bot opt-in config for `projectPath`. Always a
 * complete `PrBotConfig` — `{codeRabbitEnabled: false, qodoEnabled: false}`
 * when this project has no persisted entry yet (opt-in disabled by
 * default), never `undefined`/unset.
 */
export function getPrBotConfig(projectPath: string): PrBotConfig {
  return store.getProjectConfig(projectPath);
}

/**
 * Sets one bot's opt-in state for `projectPath`, merge-writing only that
 * project's entry (every other project's entry, and this project's other
 * bot field, are left untouched). Returns the project's full, updated
 * `PrBotConfig`.
 */
export function setPrBotEnabled(projectPath: string, bot: PrBotId, enabled: boolean): PrBotConfig {
  return store.setProjectBotEnabled(projectPath, bot, enabled);
}
