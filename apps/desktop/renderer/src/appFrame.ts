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
import type { GraphServiceStatusMessage } from '@driller/ipc-contracts';

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

export function deriveFooterBar({ currentProjectPath, isOpening, availability, map, mode }: FooterBarInput): FooterBar {
  if (currentProjectPath === null) {
    return { left: isOpening ? 'opening…' : NO_PROJECT_OPEN, right: '' };
  }
  const right = FOOTER_BAR_MODE_NAMES[mode];
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
