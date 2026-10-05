/**
 * App-wide UI settings (P2-9) — the app zoom factor, and (P4-2 phase 3c)
 * the per-project "Show types & modules" canvas toggle.
 *
 * Free of Electron imports so it runs under `npm test` with an injected
 * store (same split as cloud-key-store.ts / backend-settings.ts):
 * ui-settings-store.ts owns the real `electron-store` file under `userData`
 * (AD-5) and the process-wide instance.
 *
 * The value is cached in memory after the first read. A store read or
 * write that throws never propagates: the zoom falls back to 1 (reads) or
 * stays in memory for the session (writes). An invalid stored value is
 * validated by app-menu.ts's `parseStoredZoomFactor`, reads as 1, is
 * warned about once, and 1 is written back so the warning doesn't repeat
 * on every launch.
 */

import { ENTRY_PINS_MAX, type EntryPinUpdateResult } from '@driller/ipc-contracts';

import { DEFAULT_ZOOM_FACTOR, parseStoredZoomFactor } from './app-menu';
import { normalizePathForComparison } from './project-path';

/** The raw persisted value, as stored — untrusted. */
export interface UiSettingsBackingStore {
  get(): unknown;
  set(value: number): void;
}

export interface UiSettingsLog {
  warn(message: string): void;
  error(message: string, detail: string): void;
}

export interface UiSettings {
  /** The zoom factor — always a valid step, 1 when unset, invalid or unreadable. */
  getZoomFactor(): number;
  /** Stores `value` snapped to a step (invalid → 1) and returns what was stored. */
  setZoomFactor(value: number): number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function createUiSettings(store: UiSettingsBackingStore, log: UiSettingsLog = console): UiSettings {
  let cached: number | undefined;

  const write = (value: number): void => {
    try {
      store.set(value);
    } catch (error) {
      log.error('Failed to persist UI settings.', errorMessage(error));
    }
  };

  return {
    getZoomFactor: () => {
      if (cached !== undefined) {
        return cached;
      }
      let raw: unknown;
      try {
        raw = store.get();
      } catch (error) {
        log.error('Failed to read UI settings; using 100% zoom.', errorMessage(error));
        cached = DEFAULT_ZOOM_FACTOR;
        return cached;
      }
      const parsed = parseStoredZoomFactor(raw);
      if (parsed === null) {
        log.warn('Ignoring an invalid persisted zoom factor; using 100%.');
        cached = DEFAULT_ZOOM_FACTOR;
        write(cached);
        return cached;
      }
      cached = parsed;
      return cached;
    },
    setZoomFactor: (value) => {
      cached = parseStoredZoomFactor(value) ?? DEFAULT_ZOOM_FACTOR;
      write(cached);
      return cached;
    },
  };
}

// ---------------------------------------------------------------------------
// P4-2 phase 3c: the per-project "Show types & modules" canvas toggle.
// ---------------------------------------------------------------------------

/** The raw persisted `{projectPath: boolean}` record, as stored — untrusted. */
export interface ShowFoldedKindsBackingStore {
  get(): unknown;
  set(value: Record<string, boolean>): void;
}

export interface ShowFoldedKindsSetting {
  /**
   * Whether `projectPath`'s canvas shows folded Types/Interfaces/Modules —
   * `false` when unset, invalid or unreadable.
   */
  get(projectPath: string): boolean;
  /** Stores `value` for `projectPath` and returns what is now in effect. */
  set(projectPath: string, value: boolean): boolean;
}

/**
 * The toggle is remembered per project in the UI settings store, keyed by
 * the project path normalised the way Recent Projects normalises it
 * (`normalizePathForComparison`), so two spellings of one folder share a
 * value. Off by default.
 *
 * The stored record is hand-editable JSON, so it is read defensively into
 * a `Map`: a non-object reads as empty, and only a `true` value turns a
 * project on. Off is stored by removing the project's entry.
 *
 * A store that throws never propagates. Until one read succeeds, the
 * persisted record is never written: overwriting it with only this
 * session's changes would erase every other project's value. Changes made
 * meanwhile are kept in memory, and merged into the record (and written)
 * once a read succeeds. A read failure is logged once; a failed write keeps
 * the value in memory for the session.
 */
export function createShowFoldedKindsSetting(
  store: ShowFoldedKindsBackingStore,
  log: UiSettingsLog = console,
): ShowFoldedKindsSetting {
  let persisted: Map<string, true> | undefined;
  const unsaved = new Map<string, boolean>();
  let readFailureLogged = false;

  /** Reads the record once; `false` while the store can't be read. */
  const ensureRead = (): boolean => {
    if (persisted !== undefined) {
      return true;
    }
    let raw: unknown;
    try {
      raw = store.get();
    } catch (error) {
      if (!readFailureLogged) {
        readFailureLogged = true;
        log.error('Failed to read the "Show types & modules" setting; keeping changes in memory.', errorMessage(error));
      }
      return false;
    }
    persisted = new Map();
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [projectPath, value] of Object.entries(raw)) {
        if (value === true) {
          persisted.set(normalizePathForComparison(projectPath), true);
        }
      }
    }
    return true;
  };

  const write = (): void => {
    const record: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
    for (const key of persisted ?? []) {
      record[key[0]] = true;
    }
    try {
      store.set({ ...record });
    } catch (error) {
      log.error('Failed to persist the "Show types & modules" setting.', errorMessage(error));
    }
  };

  return {
    get: (projectPath) => {
      const key = normalizePathForComparison(projectPath);
      const pending = unsaved.get(key);
      if (pending !== undefined) {
        return pending;
      }
      return ensureRead() && persisted?.get(key) === true;
    },
    set: (projectPath, value) => {
      const key = normalizePathForComparison(projectPath);
      unsaved.set(key, value);
      if (!ensureRead() || persisted === undefined) {
        return value;
      }
      for (const [pendingKey, pendingValue] of unsaved) {
        if (pendingValue) {
          persisted.set(pendingKey, true);
        } else {
          persisted.delete(pendingKey);
        }
      }
      unsaved.clear();
      write();
      return value;
    },
  };
}

/**
 * P4-2 phase 3c: the `settings:getShowFoldedKinds` IPC handler's logic. The
 * arguments cross the contextBridge untyped: a missing or empty project
 * path reads as off.
 */
export function handleGetShowFoldedKinds(setting: ShowFoldedKindsSetting, projectPath: unknown): boolean {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return false;
  }
  return setting.get(projectPath);
}

/**
 * P4-2 phase 3c: the `settings:setShowFoldedKinds` IPC handler's logic. A
 * missing or empty project path stores nothing and reads as off; a
 * non-boolean value stores nothing and returns the project's current value.
 */
export function handleSetShowFoldedKinds(setting: ShowFoldedKindsSetting, projectPath: unknown, show: unknown): boolean {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return false;
  }
  if (typeof show !== 'boolean') {
    return setting.get(projectPath);
  }
  return setting.set(projectPath, show);
}

// ---------------------------------------------------------------------------
// P4-4i: the last Section bar selection per project.
// ---------------------------------------------------------------------------

/** The raw persisted `{projectPath: section}` record, as stored — untrusted. */
export interface ActiveSectionBackingStore {
  get(): unknown;
  set(value: Record<string, string>): void;
}

export interface ActiveSectionSetting {
  /**
   * `projectPath`'s last selected section — `null` (the whole scope, `all`)
   * when unset, invalid or unreadable. Whether it is still in the project's
   * allowlist is the renderer's check, not this store's.
   */
  get(projectPath: string): string | null;
  /** Stores `section` (`null` = `all`) for `projectPath` and returns what is now in effect. */
  set(projectPath: string, section: string | null): string | null;
}

/**
 * The last section is remembered per project in the UI settings store (AD-5,
 * "Remembered section"), with the same discipline as
 * `createShowFoldedKindsSetting`: keys normalised with
 * `normalizePathForComparison`, a defensive read into a `Map` (a non-object
 * reads as empty; only a non-empty string value is a section), and no write
 * until one read has succeeded — changes made meanwhile wait in memory and
 * are merged in once a read succeeds. A read failure is logged once; a failed
 * write keeps the value in memory for the session.
 *
 * `all` is stored by removing the project's entry, never as the string
 * `"all"` — so an entry whose value is `"all"` is an ordinary section named
 * `all`.
 */
export function createActiveSectionSetting(
  store: ActiveSectionBackingStore,
  log: UiSettingsLog = console,
): ActiveSectionSetting {
  let persisted: Map<string, string> | undefined;
  // `null` = removed (back to `all`), waiting to be merged in.
  const unsaved = new Map<string, string | null>();
  let readFailureLogged = false;

  /** Reads the record once; `false` while the store can't be read. */
  const ensureRead = (): boolean => {
    if (persisted !== undefined) {
      return true;
    }
    let raw: unknown;
    try {
      raw = store.get();
    } catch (error) {
      if (!readFailureLogged) {
        readFailureLogged = true;
        log.error('Failed to read the remembered sections; keeping changes in memory.', errorMessage(error));
      }
      return false;
    }
    persisted = new Map();
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [projectPath, value] of Object.entries(raw)) {
        if (typeof value === 'string' && value.length > 0) {
          persisted.set(normalizePathForComparison(projectPath), value);
        }
      }
    }
    return true;
  };

  const write = (): void => {
    const record: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of persisted ?? []) {
      record[key] = value;
    }
    try {
      store.set({ ...record });
    } catch (error) {
      log.error('Failed to persist the remembered sections.', errorMessage(error));
    }
  };

  return {
    get: (projectPath) => {
      const key = normalizePathForComparison(projectPath);
      if (unsaved.has(key)) {
        return unsaved.get(key) ?? null;
      }
      return ensureRead() ? (persisted?.get(key) ?? null) : null;
    },
    set: (projectPath, section) => {
      const key = normalizePathForComparison(projectPath);
      unsaved.set(key, section);
      if (!ensureRead() || persisted === undefined) {
        return section;
      }
      for (const [pendingKey, pendingSection] of unsaved) {
        if (pendingSection === null) {
          persisted.delete(pendingKey);
        } else {
          persisted.set(pendingKey, pendingSection);
        }
      }
      unsaved.clear();
      write();
      return section;
    },
  };
}

/**
 * P4-4i: the `settings:getActiveSection` IPC handler's logic. The argument
 * crosses the contextBridge untyped: a missing or empty project path reads
 * as `null` (`all`).
 */
export function handleGetActiveSection(setting: ActiveSectionSetting, projectPath: unknown): string | null {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return null;
  }
  return setting.get(projectPath);
}

/**
 * P4-4i: the `settings:setActiveSection` IPC handler's logic. A missing or
 * empty project path stores nothing and returns `null`; a value that is
 * neither `null` nor a non-empty string stores nothing and returns the
 * project's current value.
 */
export function handleSetActiveSection(
  setting: ActiveSectionSetting,
  projectPath: unknown,
  section: unknown,
): string | null {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return null;
  }
  if (section !== null && (typeof section !== 'string' || section.length === 0)) {
    return setting.get(projectPath);
  }
  return setting.set(projectPath, section);
}

// ---------------------------------------------------------------------------
// P4-7g: the Nodes pinned as entry points, per project (AD-5 "Entry pins").
// ---------------------------------------------------------------------------

/** The raw persisted `{projectPath: nodeIds}` record, as stored — untrusted. */
export interface EntryPinsBackingStore {
  get(): unknown;
  set(value: Record<string, string[]>): void;
}

export interface EntryPinsSetting {
  /** `projectPath`'s pinned Node ids, in pin order — `[]` when unset, invalid or unreadable. */
  get(projectPath: string): string[];
  /**
   * Stores `nodeIds` (in pin order; a repeated id kept at its first place)
   * for `projectPath` and returns what is now in effect. More than
   * `ENTRY_PINS_MAX` distinct ids is refused: nothing is stored and the
   * current pins are returned. An empty list removes the project's entry.
   */
  set(projectPath: string, nodeIds: readonly string[]): string[];
  /**
   * Review round 1: pins (appended) or unpins `nodeId` against the list
   * stored for `projectPath` — never a whole list from a caller that may
   * hold a stale one. A pin past `ENTRY_PINS_MAX` is `limit` (nothing
   * changed). While the store can't be read, `error`: a list that was never
   * read is never overwritten.
   */
  update(projectPath: string, nodeId: string, pinned: boolean): EntryPinUpdateResult;
}

/** Review round 1: the explicit refusal while the stored pins can't be read. */
export const ENTRY_PINS_UNREADABLE_MESSAGE = 'The stored entry pins couldn’t be read, so nothing was changed.';

/** Distinct non-empty strings of `values`, first place kept. */
function distinctIds(values: readonly unknown[]): { ids: string[]; dropped: boolean } {
  const ids: string[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || seen.has(value)) {
      dropped = true;
      continue;
    }
    seen.add(value);
    ids.push(value);
  }
  return { ids, dropped };
}

/**
 * The pins are remembered per project in the UI settings store (AD-5,
 * "Entry pins"), with the same discipline as `createShowFoldedKindsSetting`
 * and `createActiveSectionSetting`: keys normalised with
 * `normalizePathForComparison`, and no write until one read has succeeded
 * (changes made meanwhile wait in memory and are merged in once a read
 * succeeds; a read failure is logged once; a failed write keeps the value in
 * memory for the session).
 *
 * The record is hand-editable JSON, so it is read defensively: a non-object
 * reads as empty; a value that is not an array reads as no pins; a non-string
 * or empty id and a repeated id are dropped; a list longer than
 * `ENTRY_PINS_MAX` keeps its first `ENTRY_PINS_MAX`. Anything dropped is
 * warned about once. A pin whose Node is gone is never removed here — the
 * Node may return after a scope change or a re-index.
 */
export function createEntryPinsSetting(store: EntryPinsBackingStore, log: UiSettingsLog = console): EntryPinsSetting {
  let persisted: Map<string, string[]> | undefined;
  // `[]` = removed, waiting to be merged in.
  const unsaved = new Map<string, string[]>();
  let readFailureLogged = false;
  // Review round 1: projects whose stored list was cut to `ENTRY_PINS_MAX`
  // on read — saving it drops the rest for good, which is warned about.
  const cutOnRead = new Set<string>();

  /** Reads the record once; `false` while the store can't be read. */
  const ensureRead = (): boolean => {
    if (persisted !== undefined) {
      return true;
    }
    let raw: unknown;
    try {
      raw = store.get();
    } catch (error) {
      if (!readFailureLogged) {
        readFailureLogged = true;
        log.error('Failed to read the entry pins; keeping changes in memory.', errorMessage(error));
      }
      return false;
    }
    persisted = new Map();
    let corrupt = false;
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [projectPath, value] of Object.entries(raw)) {
        if (!Array.isArray(value)) {
          corrupt = true;
          continue;
        }
        const { ids, dropped } = distinctIds(value);
        if (dropped || ids.length > ENTRY_PINS_MAX) {
          corrupt = true;
        }
        if (ids.length > 0) {
          const key = normalizePathForComparison(projectPath);
          persisted.set(key, ids.slice(0, ENTRY_PINS_MAX));
          if (ids.length > ENTRY_PINS_MAX) {
            cutOnRead.add(key);
          }
        }
      }
    } else if (raw !== undefined) {
      corrupt = true;
    }
    if (corrupt) {
      log.warn('Ignoring invalid persisted entry pins.');
    }
    return true;
  };

  const write = (): void => {
    const record: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const [key, ids] of persisted ?? []) {
      record[key] = [...ids];
    }
    for (const key of cutOnRead) {
      if (key in record) {
        log.warn(`Saving the entry pins drops those past the first ${ENTRY_PINS_MAX} for one project.`);
      }
    }
    cutOnRead.clear();
    try {
      store.set({ ...record });
    } catch (error) {
      log.error('Failed to persist the entry pins.', errorMessage(error));
    }
  };

  const current = (key: string): string[] => {
    const pending = unsaved.get(key);
    if (pending !== undefined) {
      return [...pending];
    }
    return ensureRead() ? [...(persisted?.get(key) ?? [])] : [];
  };

  const storeIds = (key: string, ids: string[]): string[] => {
    unsaved.set(key, ids);
    if (!ensureRead() || persisted === undefined) {
      return [...ids];
    }
    for (const [pendingKey, pendingIds] of unsaved) {
      if (pendingIds.length === 0) {
        persisted.delete(pendingKey);
      } else {
        persisted.set(pendingKey, pendingIds);
      }
    }
    unsaved.clear();
    write();
    return [...ids];
  };

  return {
    get: (projectPath) => current(normalizePathForComparison(projectPath)),
    set: (projectPath, nodeIds) => {
      const key = normalizePathForComparison(projectPath);
      const { ids } = distinctIds(nodeIds);
      if (ids.length > ENTRY_PINS_MAX) {
        return current(key);
      }
      return storeIds(key, ids);
    },
    update: (projectPath, nodeId, pinned) => {
      if (!ensureRead()) {
        return { status: 'error', message: ENTRY_PINS_UNREADABLE_MESSAGE };
      }
      const key = normalizePathForComparison(projectPath);
      const stored = current(key);
      if (pinned === stored.includes(nodeId)) {
        return { status: 'stored', pins: stored };
      }
      if (pinned && stored.length >= ENTRY_PINS_MAX) {
        return { status: 'limit', pins: stored };
      }
      const next = pinned ? [...stored, nodeId] : stored.filter((id) => id !== nodeId);
      return { status: 'stored', pins: storeIds(key, next) };
    },
  };
}

/**
 * P4-7g: the `settings:getEntryPins` IPC handler's logic. The argument
 * crosses the contextBridge untyped: a missing or empty project path reads
 * as no pins, without touching the store.
 */
export function handleGetEntryPins(setting: EntryPinsSetting, projectPath: unknown): string[] {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return [];
  }
  return setting.get(projectPath);
}

/**
 * P4-7g (review round 1): the `settings:setEntryPins` IPC handler's logic —
 * one id pinned or unpinned by main against its stored list. The arguments
 * cross the contextBridge untyped: a missing or empty project path or Node
 * id, or a non-boolean `pinned`, is an explicit `error` and stores nothing.
 * When a list was stored, `onStored` gets the project path and that list
 * (main hands it to the Graph Service).
 */
export function handleSetEntryPins(
  setting: EntryPinsSetting,
  projectPath: unknown,
  nodeId: unknown,
  pinned: unknown,
  onStored: (projectPath: string, pinnedIds: string[]) => void = () => {},
): EntryPinUpdateResult {
  if (
    typeof projectPath !== 'string' ||
    projectPath.length === 0 ||
    typeof nodeId !== 'string' ||
    nodeId.length === 0 ||
    typeof pinned !== 'boolean'
  ) {
    return { status: 'error', message: 'Invalid entry pin request.' };
  }
  const result = setting.update(projectPath, nodeId, pinned);
  if (result.status === 'stored') {
    onStored(projectPath, [...result.pins]);
  }
  return result;
}
