/**
 * The Graph Service status line's text (`GraphServiceStatusBadge` in
 * `App.tsx`), as pure functions. FIX-3 moved these out of `App.tsx` so the
 * exact strings are tested (`statusLine.test.ts`) rather than read off JSX.
 */
import type { GraphServiceStatusMessage, IndexCoverageSummary } from '@driller/ipc-contracts';

import { formatCount, formatCountNumber } from './format';
import type { SessionAvailability } from './sessionView';

/**
 * Formats a millisecond duration as a short, human-readable elapsed-time
 * string ("340ms", "12s", "4m 05s", "1h 30m") — always shown, honestly,
 * regardless of how fast or slow the underlying hardware/repo made it
 * (NFR1, AD-15).
 *
 * Renders "—" for a non-finite input (e.g. a malformed `status.at`) rather
 * than a "NaNms"-shaped string — a bad timestamp should never leak into the
 * rendered text.
 *
 * The sub-second branch checks the *rounded* value, not the raw one: a raw
 * value in `[999.5, 1000)` would otherwise take the `ms` branch and
 * `Math.round` it up to a confusing "1000ms" instead of "1s".
 */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  const roundedMs = Math.round(Math.max(0, ms));
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  const totalSeconds = Math.floor(roundedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  // Unreachable under the current 30-minute indexing timeout ceiling, but
  // kept for robustness if that ceiling is ever raised independently.
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

/** "1 file" / "2 files" — the coverage gap text names its unit, correctly pluralized. */
function pluralizeFiles(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/** True when the backend's own reporting shows a genuine coverage gap. */
export function hasCoverageGap(coverage: IndexCoverageSummary): boolean {
  return coverage.skippedCount > 0 || coverage.parsePartialCount > 0;
}

/**
 * Renders the coverage summary distinctly for full vs. partial coverage
 * (FR2, UX-DR11) — sourced entirely from `coverage`, never re-derived here.
 * `not_indexed` exclusions never factor in: `coverage` only ever carries the
 * genuine `skipped`/`parse_partial` gap counts.
 *
 * Full-vs-gap is keyed on `skippedCount`/`parsePartialCount` alone (via
 * `hasCoverageGap`) — never on `nodes === expectedNodes` — because
 * `expectedNodes`/`expectedEdges` are optional enrichment on
 * `IndexCoverageSummary`, not always present (see mcp-client.ts's
 * `fetchCoverage` doc comment for why). The "x of y expected" detail below
 * is appended only when the backend's response happened to include both
 * expected-count fields; its absence never blocks the full/partial verdict
 * itself.
 */
export function formatCoverage(coverage: IndexCoverageSummary, nodes: number, edges: number): string {
  const verdict = hasCoverageGap(coverage)
    ? [
        coverage.parsePartialCount > 0
          ? `${pluralizeFiles(coverage.parsePartialCount)} partially parsed`
          : null,
        coverage.skippedCount > 0 ? `${pluralizeFiles(coverage.skippedCount)} skipped` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(', ')
    : 'full coverage';

  if (coverage.expectedNodes === undefined || coverage.expectedEdges === undefined) {
    return verdict;
  }
  // FIX-3: "indexed Nodes" — these are the index's totals, labelled so they
  // can't be mistaken for the "(N on the map)" count earlier in the line.
  return `${verdict} (${formatCountNumber(nodes)}/${formatCountNumber(coverage.expectedNodes)} indexed Nodes, ${formatCountNumber(edges)}/${formatCountNumber(coverage.expectedEdges)} edges expected)`;
}

/**
 * FIX-3: the `indexed` line's counts — "1,550 Nodes (1,014 on the map),
 * 5,763 edges". `nodes`/`edges` are everything the index holds; `mapNodes`
 * is the map-eligible count, or `null` to leave the parenthetical out.
 */
export function formatIndexedCounts(nodes: number, edges: number, mapNodes: number | null): string {
  const onMap = mapNodes === null ? '' : ` (${formatCountNumber(mapNodes)} on the map)`;
  return `${formatCount(nodes, 'Node', 'Nodes')}${onMap}, ${formatCount(edges, 'edge', 'edges')}`;
}

/**
 * FIX-3: the map count the `indexed` line may cite beside `indexedNodes`, or
 * `null` to omit it. Omitted while the session is `refreshing` (the map on
 * screen is the previous index's, so pairing it with this index's total
 * would be stale) and whenever it would exceed the indexed total (a pairing
 * that can only be a mismatch between two different indexes).
 */
export function statusLineMapNodes(
  indexedNodes: number,
  mapNodes: number | null,
  availability: SessionAvailability,
): number | null {
  if (mapNodes === null || availability === 'refreshing' || !(mapNodes <= indexedNodes)) {
    return null;
  }
  return mapNodes;
}

/**
 * FIX-3: the status line's text for `status`. `mapNodes` is the map state's
 * Node count (`mapNodesForStatusLine`) and `availability` the footer's
 * (`footerAvailability`) — together they decide whether "(N on the map)"
 * appears. `indexing` is just "Indexing…": its ticking elapsed time is a
 * separate `aria-live="off"` span the badge appends.
 */
export function statusLineText(
  status: GraphServiceStatusMessage,
  mapNodes: number | null,
  availability: SessionAvailability,
): string {
  switch (status.state) {
    case 'starting':
      return 'Graph Service starting…';
    case 'alive':
      return 'Graph Service running';
    case 'indexing':
      return 'Indexing…';
    case 'indexed': {
      const counts = formatIndexedCounts(
        status.nodes,
        status.edges,
        statusLineMapNodes(status.nodes, mapNodes, availability),
      );
      const coverage = status.coverage ? ` · ${formatCoverage(status.coverage, status.nodes, status.edges)}` : '';
      return `Indexed — ${counts} · ${formatElapsedMs(status.elapsedMs)}${coverage}`;
    }
    case 'exited':
      return 'Graph Service exited';
    case 'error':
      return `Graph Service unavailable: ${status.message}${
        status.elapsedMs !== undefined ? ` (after ${formatElapsedMs(status.elapsedMs)})` : ''
      }`;
  }
}
