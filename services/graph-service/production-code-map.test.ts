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
