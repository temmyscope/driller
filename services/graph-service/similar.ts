/**
 * P4-2 phase 4: "Similar implementations" for production Functions.
 *
 * The backend already finds near-duplicate implementations: a `SIMILAR_TO`
 * edge with a jaccard token-overlap score (e.g. `withTimeout`, copied into
 * five files at 1.0 on driller/app, 2026-09-27). This attaches them to each
 * production map Function as `CodeMapNode.similarTo` — the data base for a
 * future "these could share an abstraction" recommendation, which is not
 * made here. Facts only:
 *
 *  - only the backend's own `SIMILAR_TO` edges count, never a name match or
 *    any other inferred similarity;
 *  - both ends must be production Functions on the Code Map (phase 1's test
 *    rules: `isTestNode`), in different files — a same-file pair is dropped,
 *    by the backend's `same_file` flag and by the Nodes' own files;
 *  - the score must be at least `SIMILAR_TO_MIN_JACCARD`.
 *
 * Nothing here feeds risk signals or severity.
 */
import {
  SIMILAR_TO_MAX_ENTRIES,
  SIMILAR_TO_MIN_JACCARD,
  type SimilarImplementation,
} from '@driller/graph-contracts';

import type { SimilarPair } from './mcp-client';
import { isTestNode } from './test-code';

interface SimilarNode {
  id: string;
  name: string;
  file: string;
  kind: string;
  isTest?: boolean;
  similarTo?: SimilarImplementation[];
  similarToTotal?: number;
}

/** Whether a pair's score admits it: a finite jaccard at or above the floor. */
export function isSimilarEnough(score: number): boolean {
  return Number.isFinite(score) && score >= SIMILAR_TO_MIN_JACCARD && score <= 1;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Highest score first, then name, file and id — a stable, readable order. */
export function compareSimilar(a: SimilarImplementation, b: SimilarImplementation): number {
  return b.score - a.score || compareStrings(a.name, b.name) || compareStrings(a.file, b.file) || compareStrings(a.id, b.id);
}

/**
 * Sets each production Function's `similarTo` (sorted by `compareSimilar`,
 * capped at `SIMILAR_TO_MAX_ENTRIES`) and `similarToTotal` from `pairs`,
 * read both ways. A pair is used only when both ends are eligible Nodes in
 * `nodes` (a production `Function`, its id carried by exactly one such Node),
 * in different files, not flagged `sameFile`, and at least
 * `SIMILAR_TO_MIN_JACCARD`. A pair seen twice keeps its higher score.
 *
 * Re-derives from scratch: a Node's existing `similarTo`/`similarToTotal`
 * is replaced, or removed when nothing qualifies — so calling it again on a
 * scope-filtered subset names only Nodes in that subset. `nodes`' `file`
 * must already be project-relative. Pure; returns Nodes unchanged (the same
 * objects) where nothing changes.
 */
export function attachSimilar<TNode extends SimilarNode>(nodes: TNode[], pairs: readonly SimilarPair[]): TNode[] {
  const eligible = new Map<string, TNode>();
  const ambiguous = new Set<string>();
  for (const node of nodes) {
    if (node.kind !== 'Function' || isTestNode(node)) {
      continue;
    }
    if (eligible.has(node.id)) {
      ambiguous.add(node.id);
    }
    eligible.set(node.id, node);
  }
  for (const id of ambiguous) {
    eligible.delete(id);
  }

  const byNode = new Map<string, Map<string, SimilarImplementation>>();
  const add = (from: TNode, to: TNode, score: number) => {
    let entries = byNode.get(from.id);
    if (entries === undefined) {
      entries = new Map();
      byNode.set(from.id, entries);
    }
    const existing = entries.get(to.id);
    if (existing === undefined || existing.score < score) {
      entries.set(to.id, { id: to.id, name: to.name, file: to.file, score });
    }
  };
  for (const pair of pairs) {
    if (pair.source === pair.target || pair.sameFile === true || !isSimilarEnough(pair.score)) {
      continue;
    }
    const a = eligible.get(pair.source);
    const b = eligible.get(pair.target);
    if (a === undefined || b === undefined || a.file === b.file) {
      continue;
    }
    add(a, b, pair.score);
    add(b, a, pair.score);
  }

  return nodes.map((node) => {
    const entries = eligible.get(node.id) === node ? byNode.get(node.id) : undefined;
    if (entries === undefined && node.similarTo === undefined && node.similarToTotal === undefined) {
      return node;
    }
    const { similarTo: _oldSimilar, similarToTotal: _oldTotal, ...rest } = node;
    if (entries === undefined) {
      return rest as TNode;
    }
    const similar = [...entries.values()].sort(compareSimilar);
    return {
      ...rest,
      similarTo: similar.slice(0, SIMILAR_TO_MAX_ENTRIES),
      similarToTotal: similar.length,
    } as TNode;
  });
}
