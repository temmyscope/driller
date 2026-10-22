/**
 * The one number format every user-facing Node or edge count uses (P2-3's
 * formatter, moved here by FIX-3 so `appFrame.ts`, `statusLine.ts` and
 * `CodeMap.tsx` share it without importing each other). DOM-free; tested in
 * `format.test.ts`.
 */

import type { ChangedContract, FoldedType } from '@driller/ipc-contracts';

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

/**
 * Review fix (Story 1.9, Phase 3): every candidate in one `ambiguous`
 * result shares the exact same `name` by construction (that's why they're
 * ambiguous) — rendering `candidate.name` alone would make two candidates
 * indistinguishable, defeating the point of disambiguation. `candidate.id`
 * is the Node's qualified name (path + symbol, AD-19), so this strips just
 * the trailing `.<name>` symbol segment (when present) to surface the
 * distinguishing file/location part alone, e.g. an id of
 * `…fixtures/path-trace-basic.utilA.helper` for a `helper` candidate
 * becomes `…fixtures/path-trace-basic.utilA` — falls back to the full `id`
 * verbatim if it doesn't end with that exact suffix (a defensive case, not
 * one the current qualified-name scheme is expected to hit).
 */
export function formatCandidateLocation(candidate: { id: string; name: string }): string {
  const symbolSuffix = `.${candidate.name}`;
  return candidate.id.endsWith(symbolSuffix) ? candidate.id.slice(0, -symbolSuffix.length) : candidate.id;
}

/**
 * P2-12: Node Detail's module line — the directory of the Node's `file`, with
 * its trailing slash (`billing/pay.ts` → `billing/`), or `null` for a file at
 * the project root, whose module line is omitted rather than rendered empty.
 * Defensive about the path's shape even though AD-19 promises POSIX-relative:
 * backslashes become `/`, a leading `./` or `/` and a trailing `/` are
 * ignored, so it never returns `./` or the whole path.
 */
export function nodeModuleLine(file: string): string | null {
  const normalized = file
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/|\/)+/, '')
    .replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash + 1) : null;
}

/** P4-2 phase 3c: "59 dependents" / "1 dependent" — a changed contract's dependent count. */
export function formatContractDependents(contract: Pick<ChangedContract, 'dependentCount'>): string {
  return formatCount(contract.dependentCount, 'dependent', 'dependents');
}

/** P4-2 phase 3b: "interface" / "type", for accessible names and the type detail head. */
export function foldedTypeNoun(kind: FoldedType['kind']): string {
  return kind === 'Interface' ? 'interface' : 'type';
}
