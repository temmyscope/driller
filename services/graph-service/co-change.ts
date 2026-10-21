/**
 * Which files a Node's own file has a history of changing alongside.
 *
 * The backend already derives this from git history: a `FILE_CHANGES_WITH`
 * edge between two File nodes, carrying how many commits touched both
 * (`co_changes`) and how often one changed when the other did
 * (`coupling_score`). This attaches the qualifying partners to each
 * production map Node as `CodeMapNode.coChangesWith`.
 *
 * Why it is worth carrying: it is the one relationship a diff cannot show.
 * Structure says what calls what; history says what *moves* with what, and
 * the reviewer's question is about the file that did NOT change this time.
 * On driller's own repository (2026-10-21) `main/index.ts` and
 * `preload/index.ts` have never changed apart, and both move with
 * `packages/ipc-contracts` — so a change to the contract that leaves preload
 * alone is worth a second look, and nothing structural would say so.
 *
 * Facts only, like `attachSimilar`:
 *
 *  - only the backend's own `FILE_CHANGES_WITH` edges count, never an
 *    inferred or computed coupling, and never a `git log` of driller's own
 *    (AD-19 keeps these values the backend's);
 *  - both floors must hold (`CO_CHANGE_MIN_COMMITS`, `CO_CHANGE_MIN_SCORE`);
 *  - test files are excluded on either side. A file changing with its own
 *    test is not news, and on driller's own repository those pairs would
 *    otherwise dominate — the same reason P4-2 took test code off the map.
 *
 * Nothing here feeds risk signals or severity.
 */
import {
  CO_CHANGE_MAX_ENTRIES,
  CO_CHANGE_MIN_COMMITS,
  CO_CHANGE_MIN_SCORE,
  type CoChangingFile,
} from '@driller/graph-contracts';

import type { CoChangePair } from './mcp-client';
import { isTestNode, isTestPath } from './test-code';

interface CoChangeNode {
  file: string;
  isTest?: boolean;
  coChangesWith?: CoChangingFile[];
  coChangesWithTotal?: number;
}

/** Whether a pair clears both floors: enough shared history, and coupling rather than coincidence. */
export function isCoChangeStrongEnough(coChanges: number, score: number): boolean {
  return (
    Number.isFinite(coChanges) &&
    coChanges >= CO_CHANGE_MIN_COMMITS &&
    Number.isFinite(score) &&
    score >= CO_CHANGE_MIN_SCORE &&
    score <= 1
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Most shared commits first, then the stronger score, then the path — stable and readable. */
export function compareCoChanges(a: CoChangingFile, b: CoChangingFile): number {
  return b.coChanges - a.coChanges || b.score - a.score || compareStrings(a.file, b.file);
}

/**
 * Sets each production Node's `coChangesWith` (sorted by
 * `compareCoChanges`, capped at `CO_CHANGE_MAX_ENTRIES`) and
 * `coChangesWithTotal` from `pairs`, read both ways — a pair names two files
 * and each learns about the other.
 *
 * A pair is used only when it clears both floors, neither side is a test
 * file, and the two paths differ. A pair seen twice keeps its higher commit
 * count. Every Node in the same file gets the same partners, because the
 * relation is between files.
 *
 * Re-derives from scratch: an existing `coChangesWith`/`coChangesWithTotal`
 * is replaced, or removed when nothing qualifies — so calling it again on a
 * scope-filtered subset cannot leave a stale partner behind. `nodes`' `file`
 * must already be project-relative. Pure; returns the same objects where
 * nothing changes.
 */
export function attachCoChanges<TNode extends CoChangeNode>(
  nodes: TNode[],
  pairs: readonly CoChangePair[],
): TNode[] {
  const byFile = new Map<string, Map<string, CoChangingFile>>();
  const remember = (file: string, partner: string, coChanges: number, score: number) => {
    const partners = byFile.get(file) ?? new Map<string, CoChangingFile>();
    const existing = partners.get(partner);
    if (existing === undefined || coChanges > existing.coChanges) {
      partners.set(partner, { file: partner, coChanges, score });
    }
    byFile.set(file, partners);
  };

  for (const pair of pairs) {
    if (
      pair.file === pair.partner ||
      !isCoChangeStrongEnough(pair.coChanges, pair.score) ||
      isTestPath(pair.file) ||
      isTestPath(pair.partner)
    ) {
      continue;
    }
    remember(pair.file, pair.partner, pair.coChanges, pair.score);
    remember(pair.partner, pair.file, pair.coChanges, pair.score);
  }

  return nodes.map((node) => {
    const partners = isTestNode(node) ? undefined : byFile.get(node.file);
    if (partners === undefined || partners.size === 0) {
      if (node.coChangesWith === undefined && node.coChangesWithTotal === undefined) {
        return node;
      }
      const { coChangesWith: _dropped, coChangesWithTotal: _droppedTotal, ...rest } = node;
      return rest as TNode;
    }
    const sorted = [...partners.values()].sort(compareCoChanges);
    return {
      ...node,
      coChangesWith: sorted.slice(0, CO_CHANGE_MAX_ENTRIES),
      coChangesWithTotal: sorted.length,
    };
  });
}
