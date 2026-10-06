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
import type { CodeMapEdge, CodeMapNode, CodeMapResult, FoldedModule } from '@driller/ipc-contracts';
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
