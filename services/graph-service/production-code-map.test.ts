/**
 * P4-2 phase 1: `fetchProductionCodeMap` — the one fetch both Code Map
 * consumers use — normalizes paths, drops test code and test files' hotspot
 * rows, and only classifies segments inside the project.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { CodeMapEdge } from '@driller/ipc-contracts';

import { joinHotspotChangeCounts, type CodeMapNodeWithSignalSources, type FetchCodeMapOptions } from './mcp-client';
import { fetchProductionCodeMap } from './production-code-map';

function node(id: string, file: string): CodeMapNodeWithSignalSources {
  return { id, name: id, file, startLine: 1, endLine: 2, kind: 'Function', summaryStatus: 'pending', riskSignals: [] };
}

/** A `fetchCodeMap` stand-in that applies `excludeFile` to `fileRows` the way the real one does. */
function fakeFetch(
  nodes: CodeMapNodeWithSignalSources[],
  edges: CodeMapEdge[],
  fileRows: { file: string; changeCount?: number }[] = [],
) {
  return async (_project: string, _timeoutMs?: number, options?: FetchCodeMapOptions) => ({
    nodes: joinHotspotChangeCounts(nodes, fileRows, options?.excludeFile),
    edges,
  });
}

describe('fetchProductionCodeMap', () => {
  it('a project stored under /home/u/tests/myproj keeps its production Nodes', async () => {
    const root = '/home/u/tests/myproj';
    const nodes = [
      node('a', `${root}/src/a.ts`),
      node('b', 'src/b.ts'),
      node('t', `${root}/src/a.test.ts`),
      node('u', `${root}/test/util.ts`),
    ];
    const edges: CodeMapEdge[] = [
      { source: 'a', target: 'b', kind: 'CALLS' },
      { source: 't', target: 'a', kind: 'CALLS' },
      { source: 'u', target: 'b', kind: 'CALLS' },
    ];
    const result = await fetchProductionCodeMap('p', root, 'test', { fetch: fakeFetch(nodes, edges) });
    assert.deepEqual(
      result.nodes.map((n) => [n.id, n.file]),
      [
        ['a', 'src/a.ts'],
        ['b', 'src/b.ts'],
      ],
    );
    assert.deepEqual(result.edges, [edges[0]]);
  });

  it("drops test files' hotspot rows, matched by their project-relative path", async () => {
    const root = '/home/u/tests/myproj';
    const nodes = [node('a', `${root}/src/a.ts`), node('t', `${root}/src/__tests__/a.ts`)];
    const excluded: string[] = [];
    const fetch = async (_project: string, _timeoutMs?: number, options?: FetchCodeMapOptions) => {
      for (const file of [`${root}/src/a.ts`, `${root}/src/__tests__/a.ts`]) {
        if (options?.excludeFile?.(file)) {
          excluded.push(file);
        }
      }
      return fakeFetch(nodes, [], [
        { file: `${root}/src/a.ts`, changeCount: 3 },
        { file: `${root}/src/__tests__/a.ts`, changeCount: 50 },
      ])(_project, _timeoutMs, options);
    };
    const result = await fetchProductionCodeMap('p', root, 'test', { fetch });
    assert.deepEqual(excluded, [`${root}/src/__tests__/a.ts`]);
    assert.deepEqual(
      result.nodes.map((n) => [n.id, n.hotspotChangeCount]),
      [['a', 3]],
    );
  });

  it('P4-2 phase 2: attaches testedBy from test Nodes before removing them, with every evidence path normalized', async () => {
    const root = '/home/u/proj-tested-by';
    const nodes = [
      node('prod', `${root}/src/a.ts`),
      node('t', `${root}/src/a.test.ts`),
      { ...node('mod:a.test', `${root}/src/a.test.ts`), kind: 'Module' as const, endLine: 40 },
    ];
    const caller = (source: string, sourceFile: string) => ({
      source,
      sourceName: source,
      sourceFile,
      sourceStartLine: 1,
      sourceEndLine: 2,
      sourceKind: 'Function' as const,
      target: 'prod',
      strategy: 'import_map',
      confidence: 0.95,
    });
    let asked: FetchCodeMapOptions | undefined;
    const fetch = async (_project: string, _timeoutMs?: number, options?: FetchCodeMapOptions) => {
      asked = options;
      return {
        nodes,
        edges: [],
        testEvidence: {
          calls: [caller('t', `${root}/src/a.test.ts`), caller('renderTree', `${root}/src/testRender.ts`)],
          testFiles: [{ testFile: `${root}/src/a.test.ts`, file: `${root}/src/a.ts` }],
        },
      };
    };
    const result = await fetchProductionCodeMap('p', root, 'test', { fetch, includeTestedBy: true });
    assert.equal(asked?.includeTestEvidence, true);
    assert.deepEqual(result.nodes.map((n) => n.id), ['prod']);
    assert.deepEqual(result.nodes[0]?.testedBy, {
      tests: [{ id: 't', name: 't', file: 'src/a.test.ts', startLine: 1, endLine: 2 }],
      totalTests: 1,
      files: [{ file: 'src/a.test.ts', startLine: 1, endLine: 40 }],
    });
    assert.equal('testEvidence' in result, false, 'raw evidence never leaves the fetch');

    // Path Trace's fetch doesn't ask for evidence, and gets no testedBy.
    const plain = await fetchProductionCodeMap('p', root, 'test', { fetch });
    assert.equal(asked?.includeTestEvidence, undefined);
    assert.equal(plain.nodes[0]?.testedBy, undefined);
  });

  it('P4-2 phase 3a: folds production Module Nodes after test exclusion, keeping their top-level uses', async () => {
    const root = '/home/u/proj-fold';
    const module = (id: string, file: string) => ({ ...node(id, file), kind: 'Module' as const });
    const nodes = [
      module('mod:x', `${root}/src/x.ts`),
      node('f', `${root}/src/x.ts`),
      node('g', `${root}/src/y.ts`),
      module('mod:boot', `${root}/src/boot.ts`),
      // A test file's Module is test code: removed, never folded.
      module('mod:x.test', `${root}/src/x.test.ts`),
    ];
    const edges: CodeMapEdge[] = [
      { source: 'mod:x', target: 'g', kind: 'CALLS' },
      { source: 'mod:boot', target: 'f', kind: 'USAGE' },
      { source: 'mod:x.test', target: 'f', kind: 'CALLS' },
      { source: 'f', target: 'g', kind: 'CALLS' },
    ];
    const result = await fetchProductionCodeMap('p', root, 'test', { fetch: fakeFetch(nodes, edges) });
    assert.deepEqual(result.nodes.map((n) => n.id), ['f', 'g']);
    assert.deepEqual(result.edges, [{ source: 'f', target: 'g', kind: 'CALLS' }]);
    assert.deepEqual(result.foldedModules, [
      { file: 'src/boot.ts', moduleIds: ['mod:boot'], startLine: 1, endLine: 2, uses: [{ id: 'f', kind: 'USAGE' }] },
      { file: 'src/x.ts', moduleIds: ['mod:x'], startLine: 1, endLine: 2, uses: [{ id: 'g', kind: 'CALLS' }] },
    ]);
    assert.deepEqual(result.nodes.find((n) => n.id === 'f')?.fileTopLevel, [{ id: 'g', kind: 'CALLS' }]);
    assert.equal(result.nodes.find((n) => n.id === 'g')?.fileTopLevel, undefined);
    // The reverse link; the test Module's call into f is not a load-time caller.
    assert.deepEqual(result.nodes.find((n) => n.id === 'f')?.calledAtLoadBy, ['src/boot.ts']);
    assert.deepEqual(result.nodes.find((n) => n.id === 'g')?.calledAtLoadBy, ['src/x.ts']);
  });

  it('P4-2 phase 3b: folds production Type/Interface Nodes after Modules, from real USAGE edges only', async () => {
    const root = '/home/u/proj-fold-types';
    const typed = (id: string, file: string, kind: 'Type' | 'Interface'): CodeMapNodeWithSignalSources => ({ ...node(id, file), kind });
    const nodes = [
      node('f', `${root}/src/x.ts`),
      node('g', `${root}/src/y.ts`),
      { ...node('mod:x', `${root}/src/x.ts`), kind: 'Module' as const },
      typed('T', `${root}/src/types.ts`, 'Interface'),
      typed('Base', `${root}/src/types.ts`, 'Interface'),
      // Test-file types are test code: removed, never folded.
      typed('Fixture', `${root}/src/x.test.ts`, 'Type'),
    ];
    const edges: CodeMapEdge[] = [
      { source: 'f', target: 'g', kind: 'CALLS' },
      { source: 'f', target: 'T', kind: 'USAGE' },
      { source: 'g', target: 'T', kind: 'USAGE' },
      { source: 'g', target: 'Fixture', kind: 'USAGE' },
      // A file's top-level use of a type is kept as a type use.
      { source: 'mod:x', target: 'T', kind: 'USAGE' },
      { source: 'mod:x', target: 'g', kind: 'CALLS' },
    ];
    let askedImplements: boolean | undefined;
    const fetch = async (project: string, timeoutMs?: number, options?: FetchCodeMapOptions) => {
      askedImplements = options?.includeImplements;
      return { ...(await fakeFetch(nodes, edges)(project, timeoutMs, options)), implementsLinks: [{ source: 'T', target: 'Base' }] };
    };
    const result = await fetchProductionCodeMap('p', root, 'test', { fetch, includeImplements: true });
    assert.equal(askedImplements, true);
    assert.deepEqual(result.nodes.map((n) => n.id), ['f', 'g']);
    assert.deepEqual(result.edges, [{ source: 'f', target: 'g', kind: 'CALLS' }]);
    const common = { kind: 'Interface', file: 'src/types.ts', startLine: 1, endLine: 2, refersTo: [], referencedByTypes: [] };
    assert.deepEqual(result.foldedTypes, [
      { ...common, id: 'Base', name: 'Base', usedBy: [], usedByTotal: 0, usedByKinds: [], implements: [], implementedBy: ['T'] },
      {
        ...common,
        id: 'T',
        name: 'T',
        usedBy: ['f', 'g'],
        usedByTotal: 2,
        usedByKinds: [{ kind: 'Function', count: 2 }],
        implements: ['Base'],
        implementedBy: [],
      },
    ]);
    assert.deepEqual(result.nodes.find((n) => n.id === 'f')?.usesTypes, [{ id: 'T', name: 'T', kind: 'Interface' }]);
    // The file's top-level use of T moves from `uses` to `usesTypes`, and
    // Nodes in that file carry it.
    assert.deepEqual(result.foldedModules.map((m) => [m.uses, m.usesTypes]), [
      [[{ id: 'g', kind: 'CALLS' }], [{ id: 'T', name: 'T', kind: 'Interface' }]],
    ]);
    assert.deepEqual(result.nodes.find((n) => n.id === 'f')?.fileTopLevelTypes, [{ id: 'T', name: 'T', kind: 'Interface' }]);
    assert.equal(result.nodes.find((n) => n.id === 'g')?.fileTopLevelTypes, undefined);

    await fetchProductionCodeMap('p', root, 'test', { fetch });
    assert.equal(askedImplements, undefined);
  });

  it('P4-2 phase 4: attaches similarTo only when asked, between production Functions in different files (normalized paths)', async () => {
    const root = '/home/u/proj-similar';
    const nodes = [
      node('a.withTimeout', `${root}/src/a.ts`),
      node('b.withTimeout', `${root}/src/b.ts`),
      // Same file as a.withTimeout once normalized (one absolute, one relative).
      node('a.twin', 'src/a.ts'),
      node('t.withTimeout', `${root}/src/a.test.ts`),
      { ...node('T', `${root}/src/types.ts`), kind: 'Interface' as const },
    ];
    const pairs = [
      { source: 'a.withTimeout', target: 'b.withTimeout', score: 1 },
      { source: 'a.withTimeout', target: 'a.twin', score: 1 },
      { source: 'a.withTimeout', target: 't.withTimeout', score: 1 },
      { source: 'b.withTimeout', target: 'T', score: 1 },
      { source: 'a.twin', target: 'b.withTimeout', score: 0.85 },
    ];
    let askedSimilar: boolean | undefined;
    const fetch = async (project: string, timeoutMs?: number, options?: FetchCodeMapOptions) => {
      askedSimilar = options?.includeSimilar;
      return { ...(await fakeFetch(nodes, [])(project, timeoutMs, options)), similarPairs: pairs };
    };
    const result = await fetchProductionCodeMap('p', root, 'test', { fetch, includeSimilar: true });
    assert.equal(askedSimilar, true);
    assert.deepEqual(result.similarPairs, pairs);
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    assert.deepEqual(byId.get('a.withTimeout')?.similarTo, [
      { id: 'b.withTimeout', name: 'b.withTimeout', file: 'src/b.ts', score: 1 },
    ]);
    assert.equal(byId.get('a.withTimeout')?.similarToTotal, 1);
    assert.deepEqual(byId.get('b.withTimeout')?.similarTo?.map((entry) => entry.id), ['a.withTimeout']);
    assert.equal(byId.get('a.twin')?.similarTo, undefined);

    const plain = await fetchProductionCodeMap('p', root, 'test', { fetch });
    assert.equal(askedSimilar, undefined);
    assert.deepEqual(plain.similarPairs, []);
    assert.ok(plain.nodes.every((n) => n.similarTo === undefined));
  });

  it('warns once per distinct out-of-project path, not once per Node per fetch', async (t) => {
    const warn = mock.method(console, 'warn', () => {});
    t.after(() => warn.mock.restore());
    const nodes = [node('x', '/elsewhere/x.ts'), node('y', '/elsewhere/x.ts'), node('z', '/elsewhere/z.ts')];
    const fetch = fakeFetch(nodes, []);
    const first = await fetchProductionCodeMap('p', '/home/u/proj-warn-once', 'test', { fetch });
    await fetchProductionCodeMap('p', '/home/u/proj-warn-once', 'test', { fetch });
    // Both odd paths are kept (best-effort), none fails the fetch.
    assert.equal(first.nodes.length, 3);
    const warned = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(warned.filter((m) => m.includes('/elsewhere/x.ts')).length, 1);
    assert.equal(warned.filter((m) => m.includes('/elsewhere/z.ts')).length, 1);
  });
});
