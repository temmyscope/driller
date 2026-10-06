/**
 * P4-8c (review round 1): the DOM tests' map fixtures — project-relative
 * paths, and a deterministic larger map.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';
import {
  FIXTURE_NODES,
  PR_REVIEW_CONTRACT,
  PR_REVIEW_HOPS,
  pathTraceBasicMap,
  prReviewDiffScope,
  prReviewMap,
  syntheticMap,
} from './mapFixture';

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

describe('the PR Review fixture (P4-8e)', () => {
  it('is path-trace-basic with risk signals; every changed, affected and dependent id is on the map', () => {
    const map = prReviewMap();
    const ids = new Set(map.nodes.map((node) => node.id));
    assert.deepEqual([...ids].sort(), pathTraceBasicMap().nodes.map((node) => node.id).sort());
    const diff = prReviewDiffScope({ withContract: true });
    assert.equal(diff.status, 'resolved');
    if (diff.status === 'resolved') {
      assert.ok(diff.nodeIds.every((id) => ids.has(id)));
      assert.ok(!Object.keys(PR_REVIEW_HOPS).some((id) => diff.nodeIds.includes(id)), 'seeds are never in their own blast radius');
      assert.deepEqual(diff.changedContracts, [PR_REVIEW_CONTRACT]);
    }
    assert.ok(Object.keys(PR_REVIEW_HOPS).every((id) => ids.has(id)));
    assert.ok(PR_REVIEW_CONTRACT.dependentIds.every((id) => ids.has(id)));
    assert.deepEqual(map.foldedTypes.map((type) => type.id), [PR_REVIEW_CONTRACT.id]);
    assert.ok(Math.max(...Object.values(PR_REVIEW_HOPS)) > BLAST_RADIUS_DEFAULT_HOPS, 'the stepper can go deeper than it starts');
    const plain = prReviewDiffScope();
    assert.ok(plain.status === 'resolved' && plain.changedContracts === undefined, 'no contract unless asked');
    assert.ok(map.nodes.find((node) => node.id === FIXTURE_NODES.repository.id)!.riskSignals.length > 0);
  });
});
