/**
 * P4-8c: the Code Map fixtures DOM tests render — written out as literal
 * `CodeMapResult`s, so no test ever indexes anything.
 *
 * `pathTraceBasicMap()` (the default) is `fixtures/path-trace-basic` as the
 * Graph Service's `getCodeMap()` returns it when that folder is the open
 * project (`FIXTURE_PROJECT_PATH`): every `file` is POSIX-relative to it
 * (AD-19), e.g. `entry.ts`. `syntheticMap()` builds larger, deterministic
 * maps for LOD, cluster and search tests.
 *
 * Shape. The backend's raw graph of that folder has 23 entities and 34
 * relations (spec-p0-4's live run), but most are scaffolding the map never
 * carries (Project, Folder, File, Section; DEFINES, CONTAINS_*), and the
 * Module entities are folded off the map (P4-2). What reaches the renderer
 * — and so what this literal holds — is:
 * - 7 Function Nodes: `handleRequest`, `serviceA`, `serviceB`,
 *   `repository`, `cacheLookup`, and the two same-named `helper`s;
 * - 6 `CALLS` edges: the README's call graph, with its fan-in
 *   (`serviceA`/`serviceB` → `repository`) and its cycle
 *   (`repository` ↔ `cacheLookup`). The file-level `IMPORTS` relations
 *   connect File/Module entities, which aren't map Nodes, so none survive;
 * - the 7 source files' folded Modules, with no top-level uses.
 *
 * Ids use a `<file>::<name>` form, not the backend's machine-specific
 * qualified names. Line ranges are the real ones.
 */
import type {
  BlastRadiusExpansionResult,
  ChangedContract,
  CodeMapEdge,
  CodeMapNode,
  CodeMapResult,
  DiffScopeResult,
  EntryCandidate,
  EntryCandidatesResult,
  FoldedModule,
  FoldedType,
  RiskSignal,
} from '@driller/ipc-contracts';
import { listEntryCandidates } from '@driller/graph-contracts';
import { communityPositions, communityStructure } from '../communityLayout';
import { collapsedCommunityIds } from '../communityView';
import { generateSyntheticCodeMap } from '../devFixture';

function fn(file: string, name: string, startLine: number, endLine: number): CodeMapNode {
  return {
    id: `${file}::${name}`,
    name,
    file,
    startLine,
    endLine,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
  };
}

export const FIXTURE_NODES = {
  handleRequest: fn('entry.ts', 'handleRequest', 10, 13),
  serviceA: fn('serviceA.ts', 'serviceA', 3, 5),
  serviceB: fn('serviceB.ts', 'serviceB', 3, 5),
  repository: fn('repository.ts', 'repository', 9, 11),
  cacheLookup: fn('cache.ts', 'cacheLookup', 9, 11),
  helperA: fn('utilA.ts', 'helper', 12, 15),
  helperB: fn('utilB.ts', 'helper', 5, 8),
} as const satisfies Record<string, CodeMapNode>;

const calls = (source: CodeMapNode, target: CodeMapNode): CodeMapEdge => ({
  source: source.id,
  target: target.id,
  kind: 'CALLS',
});

const N = FIXTURE_NODES;

const FIXTURE_EDGES: CodeMapEdge[] = [
  calls(N.handleRequest, N.serviceA),
  calls(N.handleRequest, N.serviceB),
  calls(N.serviceA, N.repository),
  calls(N.serviceB, N.repository),
  calls(N.repository, N.cacheLookup),
  calls(N.cacheLookup, N.repository),
];

const module = (file: string, endLine: number): FoldedModule => ({
  file,
  moduleIds: [`${file}::<module>`],
  startLine: 1,
  endLine,
  uses: [],
});

const FIXTURE_FOLDED_MODULES: FoldedModule[] = [
  module('cache.ts', 12),
  module('entry.ts', 14),
  module('repository.ts', 12),
  module('serviceA.ts', 6),
  module('serviceB.ts', 6),
  module('utilA.ts', 16),
  module('utilB.ts', 9),
];

export type CodeMapOk = Extract<CodeMapResult, { status: 'ok' }>;

/** A fresh copy each call, so a test can't change another test's fixture. */
export function pathTraceBasicMap(): CodeMapOk {
  return structuredClone({
    status: 'ok',
    nodes: Object.values(FIXTURE_NODES),
    edges: FIXTURE_EDGES,
    hiddenByScope: 0,
    appliedScope: [],
    foldedTypes: [],
    foldedModules: FIXTURE_FOLDED_MODULES,
    section: null,
    sections: [],
  } satisfies CodeMapOk);
}

/** The project path the DOM tests open the fixture under. */
export const FIXTURE_PROJECT_PATH = '/fixture/path-trace-basic';

/**
 * A larger map for LOD, cluster and search tests: `devFixture`'s seeded
 * generator (the dev `?fixtureNodes=N` map), so the same `nodes`/`fanout`
 * always give the same map. Every Node is a `Function`, as on a real map
 * today (Types, Interfaces and Modules are folded off it); files are
 * `fixtures/module-<n>.ts`, 50 Nodes each, relative to the project.
 */
export function syntheticMap({ nodes, fanout = 2 }: { nodes: number; fanout?: number }): CodeMapOk {
  const generated = generateSyntheticCodeMap(nodes, fanout);
  return {
    status: 'ok',
    nodes: generated.nodes.map((node) => ({ ...node, kind: 'Function' })),
    edges: generated.edges,
    hiddenByScope: 0,
    appliedScope: [],
    foldedTypes: [],
    foldedModules: [],
    section: null,
    sections: [],
  };
}

// ---------------------------------------------------------------------------
// P4-8d: a project with two indexing-scope sections, `api` and `web`
// ---------------------------------------------------------------------------

/** The sections' own Nodes (two each). `handler` calls `render` across the sections. */
export const SECTION_NODES = {
  handler: fn('api/handler.ts', 'handler', 3, 9),
  validate: fn('api/validate.ts', 'validate', 1, 4),
  render: fn('web/render.ts', 'render', 2, 8),
  layout: fn('web/layout.ts', 'layout', 1, 5),
} as const satisfies Record<string, CodeMapNode>;

export type SectionName = 'api' | 'web';

/** The applied allowlist of the two-section project. */
export const SECTION_SCOPE: readonly SectionName[] = ['api', 'web'];

/**
 * The Graph Service's `getCodeMap(section)` reply for the two-section
 * project: `null` is `all` (all four Nodes, with the cross-section call as a
 * real edge), a section is its own two Nodes. A section reply carries what
 * P4-4g adds for it: `handler`'s cross-section call into `web` (on the `api`
 * map) and the edges each side's filter dropped (`crossSectionEdges`).
 * `overrides` replace fields of the reply.
 */
export function sectionedMap(section: SectionName | null, overrides: Partial<CodeMapOk> = {}): CodeMapOk {
  const S = SECTION_NODES;
  const shared = {
    status: 'ok' as const,
    hiddenByScope: 0,
    appliedScope: [...SECTION_SCOPE],
    foldedTypes: [],
    foldedModules: [],
    section,
    sections: [
      { path: 'api', nodeCount: 2 },
      { path: 'web', nodeCount: 2 },
    ],
  };
  const reply: CodeMapOk =
    section === null
      ? {
          ...shared,
          nodes: [S.handler, S.validate, S.render, S.layout],
          edges: [calls(S.handler, S.validate), calls(S.handler, S.render), calls(S.render, S.layout)],
        }
      : section === 'api'
        ? {
            ...shared,
            nodes: [
              { ...S.handler, crossSectionCalls: [{ id: S.render.id, name: S.render.name, section: 'web' }], crossSectionCallsTotal: 1 },
              S.validate,
            ],
            edges: [calls(S.handler, S.validate)],
            crossSectionEdges: [{ section: 'web', outgoing: 1, incoming: 3 }],
          }
        : {
            ...shared,
            nodes: [S.render, S.layout],
            edges: [calls(S.render, S.layout)],
            crossSectionEdges: [{ section: 'api', outgoing: 3, incoming: 1 }],
          };
  return structuredClone({ ...reply, ...overrides });
}

// ---------------------------------------------------------------------------
// P4-8e: a PR Review over `path-trace-basic` — the diff scope, its blast
// radius and the metrics the table shows
// ---------------------------------------------------------------------------

type DeterministicType = 'complexity' | 'blast-radius' | 'test-coverage-gap';

function det(node: CodeMapNode, type: DeterministicType, value: number, severity: 'moderate' | 'severe' = 'moderate'): RiskSignal {
  return { family: 'deterministic', type, value, severity, location: { file: node.file, startLine: node.startLine, endLine: node.endLine } };
}

function finding(node: CodeMapNode, severity: 'blocker' | 'major' | 'minor' | 'info', sourceTool: string): RiskSignal {
  return { family: 'ingested', severity, sourceTool, finding: 'x', location: { file: node.file, startLine: node.startLine, endLine: node.endLine } };
}

/**
 * Each Node's risk signals in the PR Review fixture — the values
 * `CodeMap.prReviewMetrics.test.ts` builds its tables from (complexity 42
 * severe, blast radius 120 severe, Qodo and CodeRabbit findings, …), spread
 * so that sorting by complexity or blast radius reorders the default rows.
 */
const PR_REVIEW_SIGNALS: Record<keyof typeof FIXTURE_NODES, (node: CodeMapNode) => RiskSignal[]> = {
  repository: (node) => [
    det(node, 'complexity', 42, 'severe'),
    det(node, 'blast-radius', 9),
    det(node, 'test-coverage-gap', 1),
    finding(node, 'minor', 'Qodo'),
    finding(node, 'blocker', 'CodeRabbit'),
  ],
  serviceA: (node) => [det(node, 'complexity', 3)],
  serviceB: (node) => [det(node, 'blast-radius', 120, 'severe')],
  cacheLookup: (node) => [det(node, 'complexity', 5), det(node, 'blast-radius', 10)],
  handleRequest: (node) => [det(node, 'complexity', 20, 'severe'), det(node, 'blast-radius', 50)],
  helperA: (node) => [det(node, 'complexity', 1), det(node, 'blast-radius', 50)],
  helperB: () => [],
};

/** The changed contract of the PR Review fixture: `Request`, used by `handleRequest`. */
export const PR_REVIEW_CONTRACT: ChangedContract = {
  id: 'types.ts::Request',
  name: 'Request',
  kind: 'Interface',
  file: 'types.ts',
  dependentCount: 1,
  dependentIds: [FIXTURE_NODES.handleRequest.id],
};

const PR_REVIEW_FOLDED_TYPE: FoldedType = {
  id: PR_REVIEW_CONTRACT.id,
  name: PR_REVIEW_CONTRACT.name,
  kind: PR_REVIEW_CONTRACT.kind,
  file: PR_REVIEW_CONTRACT.file,
  startLine: 1,
  endLine: 4,
  usedBy: [FIXTURE_NODES.handleRequest.id],
  usedByTotal: 1,
  usedByKinds: [{ kind: 'Function', count: 1 }],
  implements: [],
  implementedBy: [],
  refersTo: [],
  referencedByTypes: [],
};

/**
 * `path-trace-basic` as PR Review sees it: every Node carries its
 * `PR_REVIEW_SIGNALS`, and `Request` (the changed contract) is folded off
 * the map.
 */
export function prReviewMap(): CodeMapOk {
  const map = pathTraceBasicMap();
  const byId = new Map(Object.entries(FIXTURE_NODES).map(([key, node]) => [node.id, key as keyof typeof FIXTURE_NODES]));
  return {
    ...map,
    nodes: map.nodes.map((node) => ({ ...node, riskSignals: PR_REVIEW_SIGNALS[byId.get(node.id)!](node) })),
    foldedTypes: [structuredClone(PR_REVIEW_FOLDED_TYPE)],
  };
}

/** The diff changed `repository`; `withContract` adds the changed `Request` contract. */
export function prReviewDiffScope({ withContract = false }: { withContract?: boolean } = {}): DiffScopeResult {
  return {
    status: 'resolved',
    resolvedBaseRef: 'abc123',
    nodeIds: [FIXTURE_NODES.repository.id],
    ...(withContract ? { changedContracts: [structuredClone(PR_REVIEW_CONTRACT)] } : {}),
  };
}

/**
 * The blast radius of `repository` (`expandBlastRadius`'s hop distances):
 * its two callers and `cacheLookup` at 1 hop, `handleRequest` at 2 and
 * `helperA` at 3. `helperB` is out of reach. Its max depth is 3, so the
 * stepper starts at `BLAST_RADIUS_DEFAULT_HOPS` (2) and can go both ways.
 */
export const PR_REVIEW_HOPS: Readonly<Record<string, number>> = {
  [FIXTURE_NODES.serviceA.id]: 1,
  [FIXTURE_NODES.serviceB.id]: 1,
  [FIXTURE_NODES.cacheLookup.id]: 1,
  [FIXTURE_NODES.handleRequest.id]: 2,
  [FIXTURE_NODES.helperA.id]: 3,
};

export function prReviewBlastRadius(): BlastRadiusExpansionResult {
  return { status: 'resolved', hopDistances: { ...PR_REVIEW_HOPS } };
}

// ---------------------------------------------------------------------------
// P4-8f: Revealed — entry-candidate listings and drill maps
// ---------------------------------------------------------------------------

/** One entry candidate for `node`, as `listEntryCandidates` reports it (no callers in indexed code). */
export function entryCandidate(node: CodeMapNode, reach: number): EntryCandidate {
  return {
    id: node.id,
    name: node.name,
    file: node.file,
    startLine: node.startLine,
    endLine: node.endLine,
    reach,
    reason: { kind: 'no-callers' },
  };
}

/** A `listEntryCandidates` reply that found candidates. */
export type FoundListing = Extract<EntryCandidatesResult, { status: 'found' }>;

/** A `found` listing of `candidates` (no shared reach: `relations: []`). */
export function foundListing(candidates: readonly EntryCandidate[], totalQualifying = candidates.length): FoundListing {
  return { status: 'found', candidates: structuredClone([...candidates]), totalQualifying, relations: [] };
}

/** `path-trace-basic`'s listing: `handleRequest`, reaching the other 4 Nodes of its call graph (P4-7b). */
export function pathTraceBasicListing(): FoundListing {
  return foundListing([entryCandidate(FIXTURE_NODES.handleRequest, 4)]);
}

/**
 * A drill hub's shape: `hub<N>` (`hub<N>.ts`) calls N callees
 * (`hub<N>/c<k>.ts::hub<N>_c<k>`, k from 01); with `grandchildren`, each
 * callee calls one leaf of its own (`…_leaf`), so a two-layer reveal has
 * something to open.
 */
export interface DrillHub {
  readonly hub: CodeMapNode;
  readonly callees: readonly CodeMapNode[];
  readonly leaves: readonly CodeMapNode[];
  /** Its candidate, with the reach its edges give it. */
  readonly candidate: EntryCandidate;
}

export function drillHub(size: number, { grandchildren }: { grandchildren: boolean }): DrillHub {
  const name = `hub${size}`;
  const hub = fn(`${name}.ts`, name, 1, 9);
  const callees = Array.from({ length: size }, (_, index) => {
    const k = String(index + 1).padStart(2, '0');
    return fn(`${name}/c${k}.ts`, `${name}_c${k}`, 1, 5);
  });
  const leaves = grandchildren ? callees.map((callee) => fn(callee.file, `${callee.name}_leaf`, 6, 9)) : [];
  return { hub, callees, leaves, candidate: entryCandidate(hub, callees.length + leaves.length) };
}

/**
 * A map of drill hubs (each a root with no callers in indexed code). The
 * tests size them from the thresholds (`REVEAL_TWO_LAYER_MAX`,
 * `REVEAL_LAYER_CAP`) to hit 12, 13, 30 and 31 callees.
 */
export function drillMap(hubs: readonly DrillHub[]): CodeMapOk {
  const nodes = hubs.flatMap(({ hub, callees, leaves }) => [hub, ...callees, ...leaves]);
  const edges = hubs.flatMap(({ hub, callees, leaves }) => [
    ...callees.map((callee) => calls(hub, callee)),
    ...leaves.map((leaf, index) => calls(callees[index]!, leaf)),
  ]);
  return structuredClone({
    status: 'ok',
    nodes,
    edges,
    hiddenByScope: 0,
    appliedScope: [],
    foldedTypes: [],
    foldedModules: [],
    section: null,
    sections: [],
  } satisfies CodeMapOk);
}

// ---------------------------------------------------------------------------
// P4-8g: shared reach between candidates, and entry pins
// ---------------------------------------------------------------------------

/**
 * The shared-reach candidates: five roots with no callers in indexed code,
 * each calling the Nodes of the pools it shares directly. Ids sort `alpha`
 * < `beta` < `delta` < `eps` < `gamma`, so a relation's `a`/`b` order is
 * not its strength order.
 */
export const SHARED_REACH_CANDIDATES = {
  alpha: fn('alpha.ts', 'alpha', 1, 20),
  beta: fn('beta.ts', 'beta', 1, 20),
  gamma: fn('gamma.ts', 'gamma', 1, 20),
  delta: fn('delta.ts', 'delta', 1, 20),
  eps: fn('eps.ts', 'eps', 1, 20),
} as const satisfies Record<string, CodeMapNode>;

type SharedReachName = keyof typeof SHARED_REACH_CANDIDATES;

/** A pool of `size` leaf Nodes (`shared/<name>.ts::<name><k>`) its `owners` all call. */
function pool(name: string, size: number): CodeMapNode[] {
  return Array.from({ length: size }, (_, index) => fn(`shared/${name}.ts`, `${name}${index + 1}`, index * 3 + 1, index * 3 + 2));
}

const SHARED_POOLS: { owners: readonly SharedReachName[]; nodes: CodeMapNode[] }[] = [
  { owners: ['alpha', 'beta'], nodes: pool('ab', 5) },
  { owners: ['alpha', 'gamma'], nodes: pool('ag', 4) },
  { owners: ['alpha', 'delta'], nodes: pool('ad', 3) },
  { owners: ['alpha', 'eps'], nodes: pool('ae', 1) },
  { owners: ['beta', 'gamma'], nodes: pool('bg', 2) },
  { owners: ['eps'], nodes: pool('e', 2) },
];

/**
 * `mid` (`mid.ts::mid`), called by `alpha`, calls the first two Nodes `alpha`
 * and `beta` share — so it is no candidate until it is pinned, and then it
 * shares reach 2 with `alpha` and with `beta`.
 */
export const SHARED_REACH_MID = fn('mid.ts', 'mid', 1, 9);

/**
 * The shared-reach map. Its listing (`sharedReachListing`) relates
 * `alpha`–`beta` 5, `alpha`–`gamma` 4, `alpha`–`delta` 3, `beta`–`gamma` 2
 * and `alpha`–`eps` 1: `alpha`'s three strongest partners are `beta`,
 * `gamma` and `delta` (never `eps`), and `beta`'s are `alpha` and `gamma`.
 */
export function sharedReachMap(): CodeMapOk {
  const C = SHARED_REACH_CANDIDATES;
  const poolNodes = SHARED_POOLS.flatMap(({ nodes }) => nodes);
  const edges = SHARED_POOLS.flatMap(({ owners, nodes }) =>
    owners.flatMap((owner) => nodes.map((node) => calls(C[owner], node))),
  );
  const ab = SHARED_POOLS[0]!.nodes;
  edges.push(calls(C.alpha, SHARED_REACH_MID), calls(SHARED_REACH_MID, ab[0]!), calls(SHARED_REACH_MID, ab[1]!));
  return structuredClone({
    status: 'ok',
    nodes: [...Object.values(C), SHARED_REACH_MID, ...poolNodes],
    edges,
    hiddenByScope: 0,
    appliedScope: [],
    foldedTypes: [],
    foldedModules: [],
    section: null,
    sections: [],
  } satisfies CodeMapOk);
}

/**
 * The listing the Graph Service answers for `map` with `pinnedIds` — the
 * real pure ranking (`@driller/graph-contracts`' `listEntryCandidates`):
 * pins first, in pin order, then the heuristic candidates, with every
 * shared-reach relation between them. Test-only: app code never ranks.
 */
export function rankedListing(map: CodeMapOk, pinnedIds: readonly string[] = []): EntryCandidatesResult {
  return structuredClone(listEntryCandidates(map.nodes, map.edges, { pinnedIds: [...pinnedIds] }));
}

/** `sharedReachMap`'s listing (with `pinnedIds`, if any). */
export function sharedReachListing(pinnedIds: readonly string[] = []): FoundListing {
  const listing = rankedListing(sharedReachMap(), pinnedIds);
  if (listing.status !== 'found') {
    throw new Error(`the shared-reach map lists ${listing.status}`);
  }
  return listing;
}

/**
 * Where Full lays each card of `map` out — the community layout
 * (`communityLayout.ts`), exactly as `positionOf` hands it to `layoutNodes`.
 *
 * Use this rather than `layoutPosition` to build an expected position or an
 * expected first fit: Full stopped laying cards out in a grid of the fetched
 * order when the community layout landed, and a test that still computes
 * the old grid is asserting a layout the app no longer has.
 *
 * `view` says which of Full's two states to lay out. No card size is passed because the DOM tests measure every card at
 * `NODE_CARD_FALLBACK_WIDTH`×`NODE_CARD_FALLBACK_HEIGHT`, which is exactly
 * the grid pitch, so a measured card sits where an unmeasured one does
 * (`communityLayout.test.ts` pins that).
 */
export function fullMapPositions(
  map: CodeMapOk,
  foldedCardIds: readonly string[] = [],
  view: 'all-nodes' | 'default' = 'all-nodes',
): ReadonlyMap<string, { x: number; y: number }> {
  const structure = communityStructure(map.nodes, map.edges);
  // `'default'`: the collapsed community view the canvas opens in, whose
  // cards are one per community. `'all-nodes'`: every Node laid out, which is
  // what the "All Nodes" toggle shows and what Full drew before the
  // collapsed view existed. They are the same on a map too small to group.
  const collapsed = view === 'default' ? collapsedCommunityIds(structure.partition) : new Set<string>();
  return communityPositions(structure, foldedCardIds, () => undefined, collapsed).positions;
}
