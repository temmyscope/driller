/**
 * The Code Map's shared shapes — the types its sibling modules need.
 *
 * Why these seven and no others. Before this module, four siblings
 * (`appFrame.ts`, `modalStack.ts`, `revealView.ts`, `communityView.ts`) and
 * `ModeSwitcher.tsx` imported a type back from `CodeMap.tsx` while
 * `CodeMap.tsx` imported values from them: four import cycles, type-only and
 * so erased at compile time, but real cycles in the graph that any later
 * extraction had to reason around. These seven declarations were their only
 * cause, so moving them here removes every one of them.
 *
 * A true leaf, deliberately: it imports nothing but `@driller/ipc-contracts`,
 * holds no values, and must stay that way. A value here could be imported in
 * both directions and reintroduce exactly what this module exists to remove.
 * `CodeMap.tsx` re-exports all seven under their original names, so every
 * test that reads them from there is untouched.
 */
import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';

/**
 * What the in-app source viewer opens: a file and line range. A Node is one;
 * P4-2 phase 2's "Tested by" rows open a test, which is not a map Node, and
 * name it with `label` (the test's name, or the test file for a file row)
 * so the viewer's header says what it is showing.
 */
export type SourceTarget = Pick<CodeMapNode, 'file' | 'startLine' | 'endLine'> & { label?: string };

export type SourceViewState =
  | { status: 'closed' }
  | { status: 'loading'; node: SourceTarget }
  | { status: 'open'; node: SourceTarget; content: string }
  | { status: 'error'; node: SourceTarget; message: string };

/**
 * The Node Detail panel's own state (Story 1.8, Phase 4) — mirrors
 * `SourceViewState`'s shape, but simpler: opening it never involves an async
 * fetch (everything it shows is already on the fetched `CodeMapNode`), so
 * there's no `'loading'`/`'error'` state of its own here — only whether it's
 * open, and for which Node. `node` is replaced in place (not just read once
 * at open time) once a regenerate succeeds, so the panel reflects the fresh
 * summary/staleness without needing a second lookup.
 */
export type NodeDetailState = { status: 'closed' } | { status: 'open'; node: CodeMapNode };

/**
 * P4-2 phase 3c: a folded Type/Interface/Module as a render-only canvas
 * card ("Show types & modules"). Deliberately not a `CodeMapNode`: it has
 * no summary, no risk signals, no callers or callees — nothing that could
 * be mistaken for, or counted as, a map Node. `usedByTotal` is a type's
 * full user count (absent for a Module).
 */
export interface FoldedCanvasNode {
  folded: true;
  id: string;
  name: string;
  kind: 'Type' | 'Interface' | 'Module';
  file: string;
  startLine: number;
  endLine: number;
  usedByTotal?: number;
}

/**
 * P4-2 phase 3c: the folded kinds as render-only canvas elements. `edges`
 * are rebuilt from the folded indexes' real links only — a type's `usedBy`
 * and `refersTo` as `USAGE` edges, a Module's `uses` (with their own kind)
 * and `usesTypes` (`USAGE`) — and only where both ends are drawn. A type's
 * `usedBy` may be capped (`FOLDED_TYPE_IPC_MAX_USED_BY`), so a heavily used
 * type draws at most that many use edges.
 *
 * Nothing here feeds a number: see `canvasPopulation`.
 */
export interface FoldedCanvasElements {
  nodes: FoldedCanvasNode[];
  edges: CodeMapEdge[];
}

/**
 * P4-2 phase 3c: what the canvas draws versus what every number is
 * computed from. `riskNodes`/`riskEdges` are the fetched map as-is — the
 * only input to adjacency, Path Trace, Health Audit and anything else that
 * counts — whatever the toggle says. `canvasNodes`/`canvasEdges` add the
 * folded cards and their edges when `showFolded` is on; they feed only the
 * card layout, LOD (so folded cards cluster and un-cluster like any card)
 * and the rendered edges. Pure.
 */
export interface CanvasPopulation {
  riskNodes: readonly CodeMapNode[];
  riskEdges: readonly CodeMapEdge[];
  canvasNodes: readonly (CodeMapNode | FoldedCanvasNode)[];
  canvasEdges: readonly CodeMapEdge[];
  /** The folded cards drawn (`canvasNodes` minus `riskNodes`); `[]` with the toggle off. */
  foldedNodes: readonly FoldedCanvasNode[];
}

/** The three modes `App.tsx` switches between, as one name both `CodeMap`'s prop and its render gates use. */
export type CodeMapMode = 'codeMap' | 'prReview' | 'healthAudit';
