/**
 * P3-11: unit tests for the PR Review changed-source highlight surviving LOD
 * clustering — `isChangedSource`, `changedMemberCount`, `changedClusterEdges`,
 * `highlightEdge`, `assembleRenderedEdges`, `edgeNodeEndpoints`,
 * `edgeClickTarget`, `clusterAriaLabel` and `CodeMapClusterCard`.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`, which is what lets a
 * `.ts` test import from a `.tsx` module.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Edge as FlowEdge } from '@xyflow/react';

import type { Cluster } from '../map/lod';
import {
  CHANGED_CLUSTER_EDGE,
  CodeMapClusterCard,
  MIXED_EDGE_LABEL,
  assembleRenderedEdges,
  changedClusterEdges,
  changedMemberCount,
  clusterAriaLabel,
  edgeClickTarget,
  edgeNodeEndpoints,
  edgeNodePairs,
  highlightEdge,
  isChangedSource,
  pathTraceHighlight,
} from './CodeMap';

const NO_CLUSTERS: ReadonlyMap<string, readonly string[]> = new Map();
const NO_PATH = pathTraceHighlight({ status: 'idle' });
const CHANGED = 'code-map__edge--changed-source';
const PATH = 'code-map__edge--path-highlight';

function edge(source: string, target: string, kind = 'CALLS'): FlowEdge {
  return {
    id: `${source}→${target}:${kind}:0`,
    source,
    target,
    label: kind,
    className: `code-map__edge code-map__edge--${kind.toLowerCase()}`,
  };
}

function classesOf(e: FlowEdge): string[] {
  return (e.className ?? '').split(' ').filter(Boolean);
}

describe('isChangedSource', () => {
  it('is true for a directly rendered changed Node', () => {
    assert.equal(isChangedSource('a', new Set(['a']), NO_CLUSTERS), true);
  });

  it('is true for a cluster with a changed member', () => {
    const clusters = new Map([['cluster:0:0', ['x', 'a', 'y']]]);
    assert.equal(isChangedSource('cluster:0:0', new Set(['a']), clusters), true);
  });

  it('is false for a cluster with no changed member', () => {
    const clusters = new Map([['cluster:0:0', ['x', 'y']]]);
    assert.equal(isChangedSource('cluster:0:0', new Set(['a']), clusters), false);
  });

  it('is false for an unchanged Node, and for an unknown id', () => {
    const clusters = new Map([['cluster:0:0', ['a']]]);
    assert.equal(isChangedSource('b', new Set(['a']), clusters), false);
    assert.equal(isChangedSource('cluster:9:9', new Set(['a']), clusters), false);
  });

  it('is false for everything outside PR Review (empty changed set)', () => {
    const clusters = new Map([['cluster:0:0', ['a']]]);
    assert.equal(isChangedSource('a', new Set(), clusters), false);
    assert.equal(isChangedSource('cluster:0:0', new Set(), clusters), false);
  });
});

describe('changedMemberCount', () => {
  it('counts only changed members', () => {
    assert.equal(changedMemberCount(['a', 'b', 'c'], new Set(['a', 'c', 'z'])), 2);
    assert.equal(changedMemberCount(['a', 'b'], new Set(['z'])), 0);
    assert.equal(changedMemberCount(['a'], new Set()), 0);
  });
});

describe('changedClusterEdges', () => {
  // cluster:A holds a, b; cluster:B holds c, d; v and w render as cards.
  const memberToCluster = new Map([
    ['a', 'cluster:A'],
    ['b', 'cluster:A'],
    ['c', 'cluster:B'],
    ['d', 'cluster:B'],
  ]);
  const visible = new Set(['v', 'w']);

  it('re-anchors a clustered changed source on its cluster, target a card or a cluster', () => {
    const out = changedClusterEdges([edge('a', 'v'), edge('a', 'c')], new Set(['a']), memberToCluster, visible);
    assert.deepEqual(
      out.map((e) => [e.source, e.target]),
      [
        ['cluster:A', 'v'],
        ['cluster:A', 'cluster:B'],
      ],
    );
    const [first] = out;
    assert.ok(first);
    assert.deepEqual(edgeNodeEndpoints(first), { source: 'a', target: 'v' });
    assert.equal(first.data?.kind, CHANGED_CLUSTER_EDGE);
  });

  it('re-anchors a changed card whose target is clustered', () => {
    const out = changedClusterEdges([edge('v', 'c')], new Set(['v']), memberToCluster, visible);
    assert.deepEqual(
      out.map((e) => [e.source, e.target]),
      [['v', 'cluster:B']],
    );
    const [only] = out;
    assert.ok(only);
    assert.deepEqual(edgeNodeEndpoints(only), { source: 'v', target: 'c' });
  });

  it('collapses two changed members pointing at different members of one target cluster into one edge', () => {
    const out = changedClusterEdges([edge('a', 'c'), edge('b', 'd')], new Set(['a', 'b']), memberToCluster, visible);
    assert.equal(out.length, 1);
    const [only] = out;
    assert.ok(only);
    assert.deepEqual([only.source, only.target], ['cluster:A', 'cluster:B']);
    assert.deepEqual(
      edgeNodePairs(only).map((pair) => [pair.source, pair.target]),
      [
        ['a', 'c'],
        ['b', 'd'],
      ],
    );
  });

  it('skips unchanged sources, same-cluster edges, card-to-card edges and unresolvable ends', () => {
    const out = changedClusterEdges(
      [edge('b', 'v'), edge('a', 'b'), edge('a', 'ghost'), edge('a', 'a'), edge('v', 'w'), edge('ghost', 'c')],
      new Set(['a', 'v', 'ghost']),
      memberToCluster,
      visible,
    );
    assert.deepEqual(out, []);
  });

  it('keeps a shared kind, and labels mixed kinds "mixed" with no kind class', () => {
    const [same] = changedClusterEdges(
      [edge('a', 'v', 'IMPORTS'), edge('b', 'v', 'IMPORTS')],
      new Set(['a', 'b']),
      memberToCluster,
      visible,
    );
    assert.ok(same);
    assert.equal(same.label, 'IMPORTS');
    assert.deepEqual(classesOf(same), ['code-map__edge', 'code-map__edge--imports']);

    const [mixed] = changedClusterEdges(
      [edge('a', 'v', 'CALLS'), edge('b', 'v', 'USAGE')],
      new Set(['a', 'b']),
      memberToCluster,
      visible,
    );
    assert.ok(mixed);
    assert.equal(mixed.label, MIXED_EDGE_LABEL);
    assert.deepEqual(classesOf(mixed), ['code-map__edge']);
  });

  it('gives each rendered pair a unique id', () => {
    const out = changedClusterEdges(
      [edge('a', 'v'), edge('a', 'w'), edge('a', 'c'), edge('v', 'd')],
      new Set(['a', 'v']),
      memberToCluster,
      visible,
    );
    assert.equal(out.length, 4);
    assert.equal(new Set(out.map((e) => e.id)).size, 4);
  });

  it('is empty outside PR Review', () => {
    assert.deepEqual(changedClusterEdges([edge('a', 'v')], new Set(), memberToCluster, visible), []);
  });
});

describe('highlightEdge', () => {
  it('accents an edge leaving a directly rendered changed Node, as before', () => {
    const out = highlightEdge(edge('a', 'b'), NO_PATH, new Set(['a']), NO_CLUSTERS);
    assert.ok(classesOf(out).includes(CHANGED));
  });

  it('leaves an edge from an unchanged source untouched', () => {
    const input = edge('b', 'a');
    assert.equal(highlightEdge(input, NO_PATH, new Set(['a']), NO_CLUSTERS), input);
  });

  const memberToCluster = new Map([['a', 'cluster:A']]);
  const clusters = new Map([['cluster:A', ['a', 'x']]]);

  it('lets the path highlight win on a synthetic edge on a found path (real endpoints, CALLS only)', () => {
    const found = pathTraceHighlight({ status: 'found', path: ['a', 'v'] });
    const [calls] = changedClusterEdges([edge('a', 'v')], new Set(['a']), memberToCluster, new Set(['v']));
    assert.ok(calls);
    const out = highlightEdge(calls, found, new Set(['a']), clusters);
    assert.ok(classesOf(out).includes(PATH));
    assert.ok(!classesOf(out).includes(CHANGED));

    // A same-pair IMPORTS edge is not a CALLS step: it keeps the changed accent.
    const [imports] = changedClusterEdges(
      [edge('a', 'v', 'IMPORTS')],
      new Set(['a']),
      memberToCluster,
      new Set(['v']),
    );
    assert.ok(imports);
    const importsOut = highlightEdge(imports, found, new Set(['a']), clusters);
    assert.ok(classesOf(importsOut).includes(CHANGED));
    assert.ok(!classesOf(importsOut).includes(PATH));
  });

  it('lets the path highlight win on a synthetic edge in a neighbors trace, any kind', () => {
    const neighbors = pathTraceHighlight({
      status: 'neighbors',
      originId: 'a',
      direction: 'callees',
      nodeIds: ['a', 'v'],
      edgeKeys: ['a→v'],
      neighborIds: ['v'],
    });
    const [imports] = changedClusterEdges(
      [edge('a', 'v', 'IMPORTS')],
      new Set(['a']),
      memberToCluster,
      new Set(['v']),
    );
    assert.ok(imports);
    const out = highlightEdge(imports, neighbors, new Set(['a']), clusters);
    assert.ok(classesOf(out).includes(PATH));
    assert.ok(!classesOf(out).includes(CHANGED));
  });
});

describe('assembleRenderedEdges', () => {
  const clusters: Cluster[] = [
    { id: 'cluster:A', nodeIds: ['a', 'b'], position: { x: 0, y: 0 } },
    { id: 'cluster:B', nodeIds: ['c'], position: { x: 500, y: 0 } },
  ];
  const flowEdges = [edge('a', 'v'), edge('v', 'w'), edge('b', 'c')];
  const base = {
    flowEdges,
    clusters,
    expandedClusterIds: new Set<string>(),
    visibleNodeIds: new Set(['v', 'w']),
    pathHighlight: NO_PATH,
  };

  it('gives a changed Node inside an unexpanded cluster a changed-source edge from its cluster (PR Review)', () => {
    const out = assembleRenderedEdges({ ...base, changedNodeIds: new Set(['a']) });
    const fromCluster = out.filter((e) => e.source === 'cluster:A');
    assert.equal(fromCluster.length, 1);
    const [only] = fromCluster;
    assert.ok(only);
    assert.equal(only.target, 'v');
    assert.ok(classesOf(only).includes(CHANGED));
    // The ordinary card-to-card edge still renders, unaccented.
    const cardEdge = out.find((e) => e.source === 'v' && e.target === 'w');
    assert.ok(cardEdge);
    assert.ok(!classesOf(cardEdge).includes(CHANGED));
    // `b` is unchanged, so its cluster-to-cluster edge is not drawn.
    assert.equal(
      out.some((e) => e.target === 'cluster:B'),
      false,
    );
  });

  it('adds no synthetic edges outside PR Review (empty changed set)', () => {
    const out = assembleRenderedEdges({ ...base, changedNodeIds: new Set() });
    assert.deepEqual(
      out.map((e) => [e.source, e.target]),
      [['v', 'w']],
    );
  });

  it('treats an expanded cluster’s members as cards, not as a cluster', () => {
    const out = assembleRenderedEdges({
      ...base,
      expandedClusterIds: new Set(['cluster:A']),
      visibleNodeIds: new Set(['v', 'w', 'a', 'b']),
      changedNodeIds: new Set(['a']),
    });
    const fromA = out.find((e) => e.source === 'a' && e.target === 'v');
    assert.ok(fromA);
    assert.ok(classesOf(fromA).includes(CHANGED));
    assert.equal(
      out.some((e) => e.source === 'cluster:A'),
      false,
    );
  });
});

describe('edgeClickTarget', () => {
  const memberToCluster = new Map([
    ['a', 'cluster:A'],
    ['b', 'cluster:A'],
    ['c', 'cluster:B'],
    ['d', 'cluster:B'],
  ]);
  const [collapsed] = changedClusterEdges(
    [edge('a', 'c'), edge('b', 'd')],
    new Set(['a', 'b']),
    memberToCluster,
    new Set(),
  );

  it('resolves a synthetic edge on the pair touching the focused Node', () => {
    assert.ok(collapsed);
    assert.equal(edgeClickTarget(collapsed, 'b'), 'd');
    assert.equal(edgeClickTarget(collapsed, 'd'), 'b');
  });

  it('falls back to the first pair, never a cluster id', () => {
    assert.ok(collapsed);
    assert.equal(edgeClickTarget(collapsed, null), 'c');
    assert.equal(edgeClickTarget(collapsed, 'unrelated'), 'c');
  });

  it('keeps an ordinary edge’s behavior', () => {
    assert.equal(edgeClickTarget(edge('a', 'b'), 'a'), 'b');
    assert.equal(edgeClickTarget(edge('a', 'b'), 'b'), 'a');
    assert.equal(edgeClickTarget(edge('a', 'b'), null), 'b');
  });

  it('ignores data without the changed-cluster marker', () => {
    const forged: FlowEdge = { ...edge('a', 'b'), data: { nodePairs: [{ source: 'x', target: 'y' }] } };
    assert.deepEqual(edgeNodeEndpoints(forged), { source: 'a', target: 'b' });
    assert.equal(edgeClickTarget(forged, null), 'b');
  });
});

describe('clusterAriaLabel', () => {
  it('appends ", N changed" only when a member changed', () => {
    assert.equal(clusterAriaLabel(4, false, 0), 'Cluster of 4 nodes, expand');
    assert.equal(clusterAriaLabel(4, false, 2), 'Cluster of 4 nodes, expand, 2 changed');
    assert.equal(clusterAriaLabel(900, true, 1), 'Cluster of 900 nodes, too many to expand — zoom in, 1 changed');
  });
});

interface HostElement {
  type: unknown;
  props: Record<string, unknown>;
}

function isHostElement(value: unknown): value is HostElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

/** Host elements only — `Handle` (a hook-using xyflow component) is not expanded. */
function hostTree(node: unknown, out: HostElement[] = []): HostElement[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      hostTree(child, out);
    }
    return out;
  }
  if (!isHostElement(node)) {
    return out;
  }
  out.push(node);
  if (typeof node.type === 'string') {
    hostTree(node.props.children, out);
  }
  return out;
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('');
  }
  return isHostElement(node) && typeof node.type === 'string' ? textContent(node.props.children) : '';
}

function renderClusterCard(changedCount: number): HostElement {
  const cluster: Cluster = { id: 'cluster:A', nodeIds: ['a', 'b', 'c', 'd'], position: { x: 0, y: 0 } };
  const props = { data: { cluster, onExpand: () => {}, changedCount } } as unknown as Parameters<
    typeof CodeMapClusterCard
  >[0];
  const root = CodeMapClusterCard(props) as unknown;
  assert.ok(isHostElement(root));
  return root;
}

describe('CodeMapClusterCard', () => {
  it('marks a cluster with 2 changed members', () => {
    const root = renderClusterCard(2);
    assert.ok(String(root.props.className).split(' ').includes('code-map__cluster--changed'));
    assert.equal(root.props['aria-label'], 'Cluster of 4 nodes, expand, 2 changed');
    const marker = hostTree(root).find((el) => el.props.className === 'code-map__cluster-changed');
    assert.ok(marker);
    assert.equal(marker.props['aria-hidden'], 'true');
    assert.equal(textContent(marker), '2 changed');
  });

  it('carries no changed marker at 0', () => {
    const root = renderClusterCard(0);
    assert.ok(!String(root.props.className).split(' ').includes('code-map__cluster--changed'));
    assert.equal(root.props['aria-label'], 'Cluster of 4 nodes, expand');
    assert.equal(
      hostTree(root).some((el) => el.props.className === 'code-map__cluster-changed'),
      false,
    );
  });
});
