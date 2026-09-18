/**
 * Dev-only synthetic Code Map fixture (Story 1.3 Phase 2).
 *
 * Generates a large, deterministic Node/Edge set shaped exactly like the
 * real `CodeMapResult`'s payload, so the shared LOD module
 * (`apps/desktop/renderer/map/lod/`) can be profiled against a 10,000-Node
 * fixture before this story is done (epics AC) — a small-repo "feels fine"
 * is not evidence.
 *
 * `CodeMap.tsx` substitutes this for `window.driller.getCodeMap()` only
 * when `import.meta.env.DEV` is true AND a `?fixtureNodes=N` URL param is
 * present (Always: dev-only, no new IPC surface, no production code path
 * change) — a production build's bundler dead-code-eliminates the
 * `import.meta.env.DEV` branch entirely, so this module is never reachable
 * from a shipped build.
 */

import type { CodeMapEdge, CodeMapEdgeKind, CodeMapNode, CodeMapNodeKind } from '@driller/ipc-contracts';

const NODE_KINDS: CodeMapNodeKind[] = ['Function', 'Interface', 'Type', 'Module'];
const EDGE_KINDS: CodeMapEdgeKind[] = ['CALLS', 'IMPORTS', 'USAGE'];

/**
 * Fixed seed for the fixture's PRNG (mulberry32) — `Math.random()` would
 * make the fixture non-reproducible across profiling runs, undermining
 * before/after comparisons (Code Map: "deterministic (seeded)").
 */
const FIXTURE_SEED = 0xc0de_1a3;

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `noUncheckedIndexedAccess` (tsconfig.base.json) types every array index
 * as possibly `undefined`, even when the index is provably in range (e.g.
 * `index % array.length`) — this makes that provably-safe lookup explicit
 * instead of asserting it away.
 */
function pick<T>(values: readonly T[], index: number): T {
  const value = values[((index % values.length) + values.length) % values.length];
  if (value === undefined) {
    throw new Error('pick: values must be non-empty');
  }
  return value;
}

/**
 * Deterministically assigns a realistic mix of `summaryStatus` (review
 * finding, Low — Story 1.5 Phase 2) rather than a fixed `'pending'` for
 * every synthetic Node: this fixture is the one dev tool built to validate
 * rendering at 10,000-Node scale, and a hardcoded single status meant it
 * never actually exercised the `'ready'` (real summary text + the
 * `.code-map__node-summary` CSS line-clamp) or `'coverage-gap'` (icon+text
 * indicator) rendering paths at scale — only `'pending'`. The exact ratios
 * aren't meaningful, just plausible and deterministic (seeded by `index`,
 * not `Math.random()`, matching this whole fixture's own reproducibility
 * requirement): roughly 1-in-7 coverage-gap, half of the remainder ready,
 * the rest pending.
 */
function pickSummaryState(index: number): { summaryStatus: CodeMapNode['summaryStatus']; summary?: string } {
  if (index % 7 === 0) {
    return { summaryStatus: 'coverage-gap' };
  }
  if (index % 2 === 0) {
    return {
      summaryStatus: 'ready',
      // Deliberately long enough to exercise the two-line CSS clamp
      // (`.code-map__node-summary`'s `-webkit-line-clamp: 2`) at scale, not
      // just a short placeholder that always fits on one line.
      summary: `Synthetic summary for node ${index}: a deterministic, plain-language placeholder sentence long enough to wrap across two lines in the Node card, exercising the real summary rendering and clamp styling at fixture scale.`,
    };
  }
  return { summaryStatus: 'pending' };
}

export interface SyntheticCodeMap {
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
}

/**
 * Deterministically generates `nodeCount` Nodes and, per Node, up to
 * `edgeFanout` outgoing edges to an earlier Node (chosen pseudo-randomly
 * from the fixed seed) — enough graph structure to exercise edge rendering
 * at scale without every Node fanning out to every other one.
 */
export function generateSyntheticCodeMap(nodeCount: number, edgeFanout: number): SyntheticCodeMap {
  const random = mulberry32(FIXTURE_SEED);
  const safeNodeCount = Math.max(0, Math.floor(nodeCount));
  const safeFanout = Math.max(0, Math.floor(edgeFanout));

  const nodes: CodeMapNode[] = [];
  for (let index = 0; index < safeNodeCount; index += 1) {
    const line = (index % 200) + 1;
    nodes.push({
      id: `fixture://node-${index}`,
      name: `syntheticNode${index}`,
      file: `fixtures/module-${Math.floor(index / 50)}.ts`,
      startLine: line,
      endLine: line + 4,
      kind: pick(NODE_KINDS, index),
      // Story 1.5 Phase 2: never real generation (no fake Node record store
      // wired into this dev-only path) — but a deterministic mix of all
      // three states, not a fixed 'pending', so scale-testing actually
      // covers the real/ready and coverage-gap rendering paths too (review
      // finding, Low — see `pickSummaryState`).
      ...pickSummaryState(index),
      // Story 2.1 (Phase 1): always `[]` here — matches
      // `CodeMapNode.riskSignals`'s required-array contract (never
      // omitted/undefined). This phase has no rendering consumer yet (Phase
      // 3 does); populating this fixture's synthetic edges into a real
      // blast-radius signal so 10k-Node profiling exercises the signal-strip
      // path too is deferred to Phase 3, once that path exists to profile
      // (`deferred-work.md`).
      riskSignals: [],
    });
  }

  const edges: CodeMapEdge[] = [];
  for (let index = 1; index < safeNodeCount; index += 1) {
    const sourceNode = nodes[index];
    if (!sourceNode) {
      continue;
    }
    for (let fanIndex = 0; fanIndex < safeFanout; fanIndex += 1) {
      const targetNode = nodes[Math.floor(random() * index)];
      if (!targetNode) {
        continue;
      }
      edges.push({
        source: sourceNode.id,
        target: targetNode.id,
        kind: pick(EDGE_KINDS, Math.floor(random() * EDGE_KINDS.length)),
      });
    }
  }

  return { nodes, edges };
}
