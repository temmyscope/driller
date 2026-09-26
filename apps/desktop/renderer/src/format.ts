/**
 * The one number format every user-facing Node or edge count uses (P2-3's
 * formatter, moved here by FIX-3 so `appFrame.ts`, `statusLine.ts` and
 * `CodeMap.tsx` share it without importing each other). DOM-free; tested in
 * `format.test.ts`.
 */

/**
 * An `en-US` thousands separator ("1,014"). A count that can't be one — a
 * negative, `NaN` or an infinity — renders "—" rather than leaking "NaN" or
 * "-3" into the UI.
 */
export function formatCountNumber(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return '—';
  }
  return count.toLocaleString('en-US');
}

/** "1 Node" / "1,014 Nodes" / "— Nodes" — `formatCountNumber` plus the singular/plural noun. */
export function formatCount(count: number, singular: string, plural: string): string {
  return `${formatCountNumber(count)} ${count === 1 ? singular : plural}`;
}

/** "229 Nodes · 359 edges" — "Node" is capitalised as the glossary term; "edge" is not one. */
export function formatMapCounts(nodes: number, edges: number): string {
  return `${formatCount(nodes, 'Node', 'Nodes')} · ${formatCount(edges, 'edge', 'edges')}`;
}
