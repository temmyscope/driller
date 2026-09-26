/**
 * P2-3: the text of the one app-level frame both screens share — the
 * titlebar and the tmux-style footer bar (DESIGN.md, terminal-native
 * direction) — and the pure state rules that feed it. DOM-free so every
 * I/O-matrix row is testable under `node --test` (`appFrame.test.ts`).
 *
 * Every string here states a fact the app already has; nothing is invented
 * (EXPERIENCE.md: "never specify data the product cannot produce"). That is
 * why there is no git branch in the titlebar — nothing supplies it.
 */
import type { DiffScopeResult, GraphServiceStatusMessage } from '@driller/ipc-contracts';

import type { CodeMapMode } from './CodeMap';
import { deriveSessionView, isStatusForCurrentProject, type SessionAvailability } from './sessionView';

// ---------------------------------------------------------------------------
// The map's state, as reported by `CodeMap` (`onMapState`)
// ---------------------------------------------------------------------------

/** What the footer needs of `CodeMap`'s fetch: whether a map is on screen, and its totals. */
export type MapFooterState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; nodes: number; edges: number };

/**
 * `CodeMap`'s `FetchState` reduced to the footer's view of it — the ready
 * map's full Node and edge totals. Structurally typed so this module needn't
 * import `CodeMap`'s runtime. A failed *refresh* keeps `fetchState` `ready`
 * (the last completed map stays mounted), so it keeps its counts here too.
 */
export function mapFooterState(
  fetchState:
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; nodes: readonly unknown[]; edges: readonly unknown[] },
): MapFooterState {
  switch (fetchState.status) {
    case 'loading':
      return { status: 'loading' };
    case 'error':
      return { status: 'error' };
    case 'ready':
      return { status: 'ready', nodes: fetchState.nodes.length, edges: fetchState.edges.length };
  }
}

function sameMapFooterState(a: MapFooterState, b: MapFooterState): boolean {
  if (a.status !== b.status) {
    return false;
  }
  return a.status !== 'ready' || (b.status === 'ready' && a.nodes === b.nodes && a.edges === b.edges);
}

/** App's copy of the last map report, tagged with the project it describes. */
export interface FrameMapState {
  projectPath: string | null;
  map: MapFooterState | null;
}

export const INITIAL_FRAME_MAP_STATE: FrameMapState = { projectPath: null, map: null };

/**
 * A report from `CodeMap`. Ignored unless it is about the project currently
 * open — a late report from a previous project must never label this one.
 * Returns the same object when nothing changed, so React skips the render.
 */
export function applyMapReportToFrame(
  state: FrameMapState,
  currentProjectPath: string | null,
  reportPath: string | null,
  map: MapFooterState,
): FrameMapState {
  if (currentProjectPath === null || reportPath !== currentProjectPath) {
    return state;
  }
  if (state.projectPath === reportPath && state.map !== null && sameMapFooterState(state.map, map)) {
    return state;
  }
  return { projectPath: reportPath, map };
}

/** Opening a different project drops the previous project's map state; re-opening the same one keeps it. */
export function applyProjectOpenedToFrame(state: FrameMapState, openedPath: string): FrameMapState {
  return state.projectPath === openedPath || state === INITIAL_FRAME_MAP_STATE ? state : INITIAL_FRAME_MAP_STATE;
}

/** Close always returns to no map. */
export function applyProjectClosedToFrame(state: FrameMapState): FrameMapState {
  return state === INITIAL_FRAME_MAP_STATE ? state : INITIAL_FRAME_MAP_STATE;
}

/** The map state for the open project, or `null` if what's held belongs to another. */
export function frameMapFor(state: FrameMapState, currentProjectPath: string | null): MapFooterState | null {
  return currentProjectPath !== null && state.projectPath === currentProjectPath ? state.map : null;
}

// ---------------------------------------------------------------------------
// P3-10: when the diff scope last synced, as reported by `CodeMap`
// (`onDiffScopeSynced`)
// ---------------------------------------------------------------------------

/**
 * App's copy of the last diff-scope sync time (epoch ms), tagged with the
 * project it belongs to. Session-only — never persisted across launches.
 */
export interface FrameSyncState {
  projectPath: string | null;
  lastSyncedAt: number | null;
}

export const INITIAL_FRAME_SYNC_STATE: FrameSyncState = { projectPath: null, lastSyncedAt: null };

/**
 * The sync time a settled `computeDiffScope` result records: `now` for every
 * completed sync — `resolved`, `no-changes`, `not-a-git-repo`,
 * `no-base-ref-resolvable` — and `null` for `error` (or any status this
 * build doesn't know), which records nothing, so the previous time is kept.
 */
export function diffScopeSyncTimeFor(result: { status: DiffScopeResult['status'] }, now: number): number | null {
  const status = result.status;
  switch (status) {
    case 'resolved':
    case 'no-changes':
    case 'not-a-git-repo':
    case 'no-base-ref-resolvable':
      return now;
    case 'error':
      return null;
    default: {
      const unknownStatus: never = status;
      void unknownStatus;
      return null;
    }
  }
}

/**
 * A report from `CodeMap`: `at` is the settle time of a completed sync, or
 * `null` when the diff scope was reset (a map refresh after re-index, a
 * reload, a project change). Ignored unless it is about the project currently
 * open, and a `null` report is a no-op unless a time is held for that
 * project. An errored computation is never reported (`diffScopeSyncTimeFor`),
 * so it keeps whatever time was held. Returns the same object when nothing
 * changed.
 */
export function applyDiffScopeSyncToFrame(
  state: FrameSyncState,
  currentProjectPath: string | null,
  reportPath: string | null,
  at: number | null,
): FrameSyncState {
  if (currentProjectPath === null || reportPath !== currentProjectPath) {
    return state;
  }
  if (at === null && frameSyncFor(state, reportPath) === null) {
    return state;
  }
  if (state.projectPath === reportPath && state.lastSyncedAt === at) {
    return state;
  }
  return { projectPath: reportPath, lastSyncedAt: at };
}

/** Opening a different project drops the previous project's sync time; re-opening the same one keeps it. */
export function applyProjectOpenedToFrameSync(state: FrameSyncState, openedPath: string): FrameSyncState {
  return state.projectPath === openedPath || state === INITIAL_FRAME_SYNC_STATE ? state : INITIAL_FRAME_SYNC_STATE;
}

/** Close always clears the sync time. */
export function applyProjectClosedToFrameSync(state: FrameSyncState): FrameSyncState {
  return state === INITIAL_FRAME_SYNC_STATE ? state : INITIAL_FRAME_SYNC_STATE;
}

/** The sync time for the open project, or `null` if what's held belongs to another. */
export function frameSyncFor(state: FrameSyncState, currentProjectPath: string | null): number | null {
  return currentProjectPath !== null && state.projectPath === currentProjectPath ? state.lastSyncedAt : null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Ages of more than this many whole days read "over a year ago". */
const MAX_DAYS = 365;

/**
 * P3-10: plain relative time for the footer's "synced …" — under a minute is
 * "just now", then whole minutes, hours, days (floored), capped at "over a
 * year ago" past 365 days (which also covers `Infinity`). A negative age (a
 * render clock that lags the settle time by a moment), `-Infinity` or `NaN`
 * reads "just now".
 */
export function formatSyncAge(ms: number): string {
  if (!(ms >= MINUTE_MS)) {
    return 'just now';
  }
  if (ms >= (MAX_DAYS + 1) * DAY_MS) {
    return 'over a year ago';
  }
  if (ms < HOUR_MS) {
    return `${Math.floor(ms / MINUTE_MS)} min ago`;
  }
  if (ms < DAY_MS) {
    return `${Math.floor(ms / HOUR_MS)} h ago`;
  }
  return `${Math.floor(ms / DAY_MS)} d ago`;
}

/** The longest the footer waits between sync-age re-renders, so a missed or late tick recovers. */
export const SYNC_AGE_MAX_TICK_MS = 60_000;

/**
 * P3-10: how long until `formatSyncAge`'s text can next change for an age of
 * `ageMs` — the next minute boundary under an hour, the next hour boundary
 * under a day, the next day boundary after — capped at
 * `SYNC_AGE_MAX_TICK_MS`, never below 1 ms. A negative age waits until it
 * reaches one minute; a non-finite one just waits the cap.
 */
export function nextSyncAgeTickMs(ageMs: number): number {
  if (!Number.isFinite(ageMs)) {
    return SYNC_AGE_MAX_TICK_MS;
  }
  let delay: number;
  if (ageMs < MINUTE_MS) {
    delay = MINUTE_MS - ageMs;
  } else if (ageMs < HOUR_MS) {
    delay = MINUTE_MS - (ageMs % MINUTE_MS);
  } else if (ageMs < DAY_MS) {
    delay = HOUR_MS - (ageMs % HOUR_MS);
  } else {
    delay = DAY_MS - (ageMs % DAY_MS);
  }
  return Math.max(1, Math.min(SYNC_AGE_MAX_TICK_MS, delay));
}

// ---------------------------------------------------------------------------
// The Graph Service availability the footer reports
// ---------------------------------------------------------------------------

/**
 * `degraded` only after a real error/exit that belongs to the open project.
 * No status yet (a fresh open) is "not failed" — `deriveSessionView` reads it
 * as `degraded` without a map, which is moot for its notice but would make
 * the footer say "stopped" here. A status for another project (the one just
 * switched away from) is equally not this project's failure.
 */
export function footerAvailability(
  status: GraphServiceStatusMessage | null,
  currentProjectPath: string | null,
): SessionAvailability {
  if (status === null || !isStatusForCurrentProject(status, currentProjectPath)) {
    return 'refreshing';
  }
  return deriveSessionView({ currentProjectPath, loadedProjectPath: currentProjectPath, status }).availability;
}

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

export interface FooterBarInput {
  currentProjectPath: string | null;
  /** True while an open is in flight (folder picker or Recent Projects). */
  isOpening: boolean;
  /** From `footerAvailability`. */
  availability: SessionAvailability;
  /** From `frameMapFor`: `null` until the open project's map reports. */
  map: MapFooterState | null;
  mode: CodeMapMode;
  /** P3-10: from `frameSyncFor` — when the diff scope last synced (epoch ms), or `null`. */
  lastSyncedAt: number | null;
  /** P3-10: the render clock (epoch ms) the sync age is measured against. */
  now: number;
}

export interface FooterBar {
  left: string;
  right: string;
}

/** The mode's status-line name — tmux's upper-case mode indicator idiom. */
export const FOOTER_BAR_MODE_NAMES = {
  codeMap: 'CODE MAP',
  prReview: 'PR REVIEW',
  healthAudit: 'HEALTH AUDIT',
} as const satisfies Record<CodeMapMode, string>;

export const NO_PROJECT_OPEN = 'no project open';

/**
 * The project folder's display name — mirrors `apps/desktop/main/settings.ts`'s
 * `pathBasename` (the Recent Projects `name`), duplicated because the renderer
 * can't import across the main/renderer process boundary. A root (`/`,
 * `C:\`) falls back to the trimmed path, or the path itself, never `''`.
 */
export function projectFolderName(projectPath: string): string {
  const trimmed = projectPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed || projectPath;
}

/** `driller — <project folder name>`, or `driller — no project open`. */
export function deriveTitle({ currentProjectPath }: { currentProjectPath: string | null }): string {
  return `driller — ${currentProjectPath === null ? NO_PROJECT_OPEN : projectFolderName(currentProjectPath)}`;
}

function countOf(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

/** "229 Nodes · 359 edges" — "Node" is capitalised as the glossary term; "edge" is not one. */
export function formatMapCounts(nodes: number, edges: number): string {
  return `${countOf(nodes, 'Node', 'Nodes')} · ${countOf(edges, 'edge', 'edges')}`;
}

/**
 * The right span's tooltip: the absolute sync time, whenever the right span
 * states one (PR Review, a project open, a sync held); `undefined` otherwise.
 */
export function footerBarRightTitle({
  currentProjectPath,
  mode,
  lastSyncedAt,
}: Pick<FooterBarInput, 'currentProjectPath' | 'mode' | 'lastSyncedAt'>): string | undefined {
  if (currentProjectPath === null || mode !== 'prReview' || lastSyncedAt === null) {
    return undefined;
  }
  return `synced ${new Date(lastSyncedAt).toLocaleString()}`;
}

/**
 * The right span: the mode's name, plus — in PR Review only, once a diff
 * scope has synced — how recent that scope is ("PR REVIEW · synced 2 min ago").
 */
function footerBarRight(mode: CodeMapMode, lastSyncedAt: number | null, now: number): string {
  const name = FOOTER_BAR_MODE_NAMES[mode];
  if (mode !== 'prReview' || lastSyncedAt === null) {
    return name;
  }
  return `${name} · synced ${formatSyncAge(now - lastSyncedAt)}`;
}

export function deriveFooterBar({
  currentProjectPath,
  isOpening,
  availability,
  map,
  mode,
  lastSyncedAt,
  now,
}: FooterBarInput): FooterBar {
  if (currentProjectPath === null) {
    return { left: isOpening ? 'opening…' : NO_PROJECT_OPEN, right: '' };
  }
  const right = footerBarRight(mode, lastSyncedAt, now);
  if (map?.status === 'ready') {
    // A map is on screen: its counts stay visible whatever the service is doing.
    const counts = formatMapCounts(map.nodes, map.edges);
    switch (availability) {
      case 'live':
        return { left: counts, right };
      case 'refreshing':
        return { left: `${counts} · re-indexing…`, right };
      case 'degraded':
        return { left: `${counts} · last completed index`, right };
    }
  }
  if (map?.status === 'error') {
    return { left: 'couldn’t load the map — use Retry', right };
  }
  // No map yet (not reported, or loading).
  const name = projectFolderName(currentProjectPath);
  return { left: availability === 'degraded' ? `indexing ${name} stopped` : `indexing ${name}…`, right };
}
