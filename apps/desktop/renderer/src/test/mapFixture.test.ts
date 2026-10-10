/**
 * P4-8c (review round 1): the DOM tests' map fixtures — project-relative
 * paths, and a deterministic larger map.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BLAST_RADIUS_DEFAULT_HOPS, type EntryCandidate } from '@driller/ipc-contracts';
import { revealDrillGraphFor } from '../revealView';
import {
  drillHub,
  drillMap,
  FIXTURE_NODES,
  pathTraceBasicListing,
  pathTraceBasicMap,
  PR_REVIEW_CONTRACT,
  PR_REVIEW_HOPS,
  prReviewDiffScope,
  prReviewMap,
  rankedListing,
  SHARED_REACH_CANDIDATES,
  SHARED_REACH_MID,
  sharedReachListing,
  sharedReachMap,
  syntheticMap,
  type CodeMapOk,
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

describe('P4-8f: the Revealed fixtures', () => {
  it('each listed reach is the reach the renderer’s drill computes from the same map', () => {
    const hubs = [drillHub(12, { grandchildren: true }), drillHub(31, { grandchildren: false })];
    const cases: [CodeMapOk, EntryCandidate[]][] = [
      [drillMap(hubs), hubs.map((hub) => hub.candidate)],
      [pathTraceBasicMap(), pathTraceBasicListing().candidates],
    ];
    for (const [map, candidates] of cases) {
      const graph = revealDrillGraphFor(null, map.nodes, map.edges);
      for (const candidate of candidates) {
        assert.equal(graph.reachById.get(candidate.id), candidate.reach, candidate.id);
      }
      const ids = new Set(map.nodes.map((node) => node.id));
      assert.equal(ids.size, map.nodes.length, 'no id twice');
      assert.ok(map.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target)));
    }
  });

  it('a hub has exactly its callees (and one leaf each, with grandchildren), every file project-relative', () => {
    const hub = drillHub(13, { grandchildren: true });
    const map = drillMap([hub]);
    assert.equal(hub.callees.length, 13);
    assert.equal(hub.leaves.length, 13);
    assert.equal(map.nodes.length, 1 + 13 + 13);
    assert.equal(map.edges.filter((edge) => edge.source === hub.hub.id).length, 13);
    assert.equal(drillHub(30, { grandchildren: false }).leaves.length, 0);
    for (const node of map.nodes) {
      assert.match(node.file, /^hub13(\/c\d\d)?\.ts$/);
    }
  });
});

describe('P4-8g: the shared-reach fixture', () => {
  it('lists the five roots with the relations the DOM tests read, counted from the map’s own edges', () => {
    const listing = sharedReachListing();
    const C = SHARED_REACH_CANDIDATES;
    assert.deepEqual(
      listing.candidates.map((candidate) => candidate.name).sort(),
      ['alpha', 'beta', 'delta', 'eps', 'gamma'],
    );
    assert.deepEqual(listing.relations, [
      { a: C.alpha.id, b: C.beta.id, sharedReach: 5 },
      { a: C.alpha.id, b: C.gamma.id, sharedReach: 4 },
      { a: C.alpha.id, b: C.delta.id, sharedReach: 3 },
      { a: C.beta.id, b: C.gamma.id, sharedReach: 2 },
      { a: C.alpha.id, b: C.eps.id, sharedReach: 1 },
    ]);
    // Each listed reach is the renderer drill's reach of the same map.
    const map = sharedReachMap();
    const graph = revealDrillGraphFor(null, map.nodes, map.edges);
    for (const candidate of listing.candidates) {
      assert.equal(graph.reachById.get(candidate.id), candidate.reach, candidate.id);
    }
    assert.equal(new Set(map.nodes.map((node) => node.id)).size, map.nodes.length);
  });

  it('pinning mid lists it first, "pinned", sharing 2 with alpha and with beta', () => {
    const listing = sharedReachListing([SHARED_REACH_MID.id]);
    assert.equal(listing.candidates[0]?.id, SHARED_REACH_MID.id);
    assert.deepEqual(listing.candidates[0]?.reason, { kind: 'pinned' });
    const withMid = listing.relations.filter((relation) => relation.a === SHARED_REACH_MID.id || relation.b === SHARED_REACH_MID.id);
    assert.deepEqual(withMid.map((relation) => relation.sharedReach), [2, 2]);
    assert.deepEqual(rankedListing(pathTraceBasicMap()), pathTraceBasicListing());
  });
});
