/**
 * P4-8c (review round 1): the DOM tests' map fixtures — project-relative
 * paths, and a deterministic larger map.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_NODES, pathTraceBasicMap, syntheticMap } from './mapFixture';

describe('pathTraceBasicMap', () => {
  it('is path-trace-basic as getCodeMap returns it: 7 Function Nodes, 6 CALLS edges, project-relative files', () => {
    const map = pathTraceBasicMap();
    assert.equal(map.nodes.length, 7);
    assert.equal(map.edges.length, 6);
    assert.ok(map.edges.every((edge) => edge.kind === 'CALLS'));
    assert.equal(FIXTURE_NODES.handleRequest.file, 'entry.ts');
    for (const node of map.nodes) {
      assert.match(node.file, /^[\w.]+\.ts$/, `${node.file} is relative to the project root`);
    }
    for (const module of map.foldedModules) {
      assert.doesNotMatch(module.file, /\//);
    }
    const ids = new Set(map.nodes.map((node) => node.id));
    assert.ok(map.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
  });

  it('returns a fresh copy each call', () => {
    const first = pathTraceBasicMap();
    first.nodes.length = 0;
    assert.equal(pathTraceBasicMap().nodes.length, 7);
  });
});

describe('syntheticMap', () => {
  it('builds the same map for the same size, every Node a Function on a relative path', () => {
    const map = syntheticMap({ nodes: 120, fanout: 3 });
    assert.deepEqual(map, syntheticMap({ nodes: 120, fanout: 3 }));
    assert.equal(map.nodes.length, 120);
    assert.ok(map.edges.length > 120);
    assert.ok(map.nodes.every((node) => node.kind === 'Function' && !node.file.startsWith('/')));
    const ids = new Set(map.nodes.map((node) => node.id));
    assert.equal(ids.size, 120);
    assert.ok(map.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
  });
});
