/**
 * Communities on the Code Map (`communities.ts`): that the partition finds
 * the real call-graph groups once a map is big enough to need grouping,
 * that it leaves a small map alone, that it is deterministic whatever order
 * the graph arrives in, and that Nodes with no call edge are held out
 * explicitly rather than read as one-Node modules.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectCommunities,
  MIN_COMMUNITY_MEMBERS,
  MIN_NODES_TO_PARTITION,
  UNREFERENCED_COMMUNITY_ID,
  UNREFERENCED_COMMUNITY_LABEL,
  type CommunityInputEdge,
  type CommunityInputNode,
} from './communities';

const id = (name: string) => `src/${name}.ts::${name}`;
const nodesOf = (...names: string[]): CommunityInputNode[] => names.map((name) => ({ id: id(name), name }));
const edgesOf = (...pairs: [string, string][]): CommunityInputEdge[] =>
  pairs.map(([source, target]) => ({ source: id(source), target: id(target) }));

/**
 * Two groups, each a clique (every Node in it calls every other), joined by
 * one edge — the textbook case with one obvious split. `size` is each
 * group's size, defaulting so the pair sits exactly at
 * `MIN_NODES_TO_PARTITION`, which is where grouping starts to apply.
 *
 * Cliques, not rings: maximizing modularity cuts a long cycle into arcs, so
 * a ring — even a wide band of one — is not a model of a module. A clique
 * leaves no doubt what the right answer is.
 */
function twoGroups(size = MIN_NODES_TO_PARTITION / 2): {
  nodes: CommunityInputNode[];
  edges: CommunityInputEdge[];
} {
  const name = (group: string, index: number) => `${group}${index}`;
  const nodes: CommunityInputNode[] = [];
  const edges: CommunityInputEdge[] = [];
  for (const group of ['a', 'b']) {
    for (let index = 0; index < size; index += 1) {
      nodes.push(...nodesOf(name(group, index)));
    }
    for (let from = 0; from < size; from += 1) {
      for (let to = from + 1; to < size; to += 1) {
        edges.push(...edgesOf([name(group, from), name(group, to)]));
      }
    }
  }
  edges.push(...edgesOf(['a0', 'b0']));
  return { nodes, edges };
}

/** The community most of `group`'s Nodes landed in, and how many of them did. */
function dominantCommunity(
  communityOfNode: ReadonlyMap<string, string>,
  group: string,
  size: number,
): { community: string; count: number } {
  const counts = new Map<string, number>();
  for (let index = 0; index < size; index += 1) {
    const community = communityOfNode.get(id(`${group}${index}`))!;
    counts.set(community, (counts.get(community) ?? 0) + 1);
  }
  const [community, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
  return { community, count };
}

describe('detectCommunities finds the call graph’s own groups', () => {
  it('splits two densely-connected groups joined by one edge', () => {
    const { nodes, edges } = twoGroups();
    const { communities, communityOfNode } = detectCommunities(nodes, edges);
    assert.ok(communities.length >= 2, `found ${communities.length} communities`);
    const groupSize = MIN_NODES_TO_PARTITION / 2;
    const a = dominantCommunity(communityOfNode, 'a', groupSize);
    const b = dominantCommunity(communityOfNode, 'b', groupSize);
    assert.notEqual(a.community, b.community, 'the two groups do not end up as one community');
    assert.equal(a.count, groupSize, 'every Node of a sat together');
    assert.equal(b.count, groupSize, 'every Node of b sat together');
    assert.equal(communities.length, 2, 'two cliques are exactly two communities');
  });

  it('puts every Node in exactly one community, and names each by a real member identifier', () => {
    const { nodes, edges } = twoGroups();
    const { communities, communityOfNode } = detectCommunities(nodes, edges);
    const allMembers = communities.flatMap((community) => [...community.memberIds]);
    assert.equal(allMembers.length, nodes.length, 'no Node is in two communities or none');
    assert.equal(new Set(allMembers).size, nodes.length);
    assert.equal(communityOfNode.size, nodes.length);
    const names = new Set(nodes.map((node) => node.name));
    for (const community of communities) {
      assert.ok(names.has(community.label), `${community.label} is a real identifier`);
      assert.ok(community.memberIds.some((member) => community.id.endsWith(member)), 'the id names its representative');
    }
  });

  it('counts internal and external edges, and reports cohesion from them', () => {
    const { nodes, edges } = twoGroups();
    const { communities } = detectCommunities(nodes, edges);
    for (const community of communities) {
      const total = community.internalEdges + community.externalEdges;
      assert.ok(total > 0, `${community.label} has edges`);
      assert.equal(community.cohesion, community.internalEdges / total);
      assert.ok(community.cohesion > 0.5, `${community.label} is mostly internal (${community.cohesion})`);
    }
  });

  it('counts the traffic between communities as a link', () => {
    const { nodes, edges } = twoGroups();
    const { communities, links } = detectCommunities(nodes, edges);
    assert.ok(links.length >= 1);
    const ids = new Set(communities.map((community) => community.id));
    for (const link of links) {
      assert.ok(ids.has(link.sourceCommunityId) && ids.has(link.targetCommunityId));
      assert.notEqual(link.sourceCommunityId, link.targetCommunityId);
      assert.ok(link.count >= 1);
    }
    assert.deepEqual(
      [...links].sort((a, b) => b.count - a.count),
      [...links],
      'links come strongest first',
    );
  });

  it('orders communities largest first', () => {
    const { nodes, edges } = twoGroups();
    const { communities } = detectCommunities(nodes, edges);
    const sizes = communities.map((community) => community.memberIds.length);
    assert.deepEqual([...sizes].sort((a, b) => b - a), sizes);
  });
});

describe('detectCommunities leaves a small map alone', () => {
  it('below the floor, every connected Node is one community', () => {
    // `path-trace-basic`'s own shape: five connected Nodes, one of them a cycle.
    const nodes = nodesOf('handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup');
    const edges = edgesOf(
      ['handleRequest', 'serviceA'],
      ['handleRequest', 'serviceB'],
      ['serviceA', 'repository'],
      ['serviceB', 'repository'],
      ['repository', 'cacheLookup'],
      ['cacheLookup', 'repository'],
    );
    const { communities, communityOfNode } = detectCommunities(nodes, edges);
    assert.equal(communities.length, 1, 'a five-Node call graph is not split into modules');
    assert.equal(communities[0]!.memberIds.length, 5);
    assert.equal(new Set(communityOfNode.values()).size, 1);
  });

  it('a group just under the floor stays whole, and splitting starts at it', () => {
    const under = twoGroups(Math.floor((MIN_NODES_TO_PARTITION - 1) / 2));
    assert.ok(under.nodes.length < MIN_NODES_TO_PARTITION);
    assert.equal(detectCommunities(under.nodes, under.edges).communities.length, 1);

    const at = twoGroups();
    assert.ok(detectCommunities(at.nodes, at.edges).communities.length >= 2);
  });

  it('labels the one community by its most-called member', () => {
    const nodes = nodesOf('entry', 'middle', 'hot');
    const edges = edgesOf(['entry', 'hot'], ['middle', 'hot'], ['entry', 'middle']);
    const { communities } = detectCommunities(nodes, edges);
    assert.equal(communities.length, 1);
    assert.equal(communities[0]!.label, 'hot');
  });
});

describe('detectCommunities holds out Nodes with no call edge', () => {
  it('collects them into one unreferenced community, last, never as singleton modules', () => {
    const { nodes, edges } = twoGroups();
    const withLonely = [...nodes, ...nodesOf('lonely', 'alsoLonely')];
    const { communities, communityOfNode } = detectCommunities(withLonely, edges);
    assert.equal(communities.at(-1)?.id, UNREFERENCED_COMMUNITY_ID);
    assert.equal(communities.at(-1)?.label, UNREFERENCED_COMMUNITY_LABEL);
    assert.deepEqual(communities.at(-1)?.memberIds, [id('alsoLonely'), id('lonely')]);
    assert.equal(communityOfNode.get(id('lonely')), UNREFERENCED_COMMUNITY_ID);
  });

  it('holds them out below the partition floor too', () => {
    const nodes = [...nodesOf('a', 'b'), ...nodesOf('lonely')];
    const { communities } = detectCommunities(nodes, edgesOf(['a', 'b']));
    assert.equal(communities.length, 2);
    assert.equal(communities.at(-1)?.id, UNREFERENCED_COMMUNITY_ID);
  });

  it('an edgeless graph is entirely unreferenced, not one community per Node', () => {
    const { communities } = detectCommunities(nodesOf('a', 'b', 'c'), []);
    assert.equal(communities.length, 1);
    assert.equal(communities[0]!.id, UNREFERENCED_COMMUNITY_ID);
    assert.equal(communities[0]!.memberIds.length, 3);
  });

  it('no Nodes at all is empty, never a community of nothing', () => {
    const partition = detectCommunities([], []);
    assert.deepEqual(partition.communities, []);
    assert.equal(partition.communityOfNode.size, 0);
    assert.deepEqual(partition.links, []);
  });
});

describe('detectCommunities is deterministic', () => {
  // A fixed rotation: order-changing, and a real permutation for every
  // length — `(index * k) % n` is not one unless k and n are coprime, which
  // silently drops items instead of reordering them.
  const rotated = <T>(items: readonly T[]): T[] =>
    items.map((_unused, index) => items[(index + 3) % items.length]!);

  const serialize = (partition: ReturnType<typeof detectCommunities>) =>
    JSON.stringify({
      communities: partition.communities,
      communityOfNode: [...partition.communityOfNode.entries()].sort(),
      links: partition.links,
    });

  it('gives the same partition however the nodes and edges are ordered', () => {
    const { nodes, edges } = twoGroups();
    const baseline = serialize(detectCommunities(nodes, edges));
    for (const [label, orderedNodes, orderedEdges] of [
      ['reversed', [...nodes].reverse(), [...edges].reverse()],
      ['rotated', rotated(nodes), rotated(edges)],
    ] as [string, CommunityInputNode[], CommunityInputEdge[]][]) {
      assert.equal(serialize(detectCommunities(orderedNodes, orderedEdges)), baseline, `${label} input`);
    }
  });

  it('repeating the same call gives a byte-identical result', () => {
    const { nodes, edges } = twoGroups();
    assert.equal(serialize(detectCommunities(nodes, edges)), serialize(detectCommunities(nodes, edges)));
  });
});

describe('detectCommunities ignores what cannot be a call between two mapped Nodes', () => {
  it('drops self-calls, repeated edges and edges naming an unmapped Node', () => {
    const nodes = nodesOf('a1', 'a2');
    const edges = [
      ...edgesOf(['a1', 'a2'], ['a1', 'a2'], ['a1', 'a1']),
      { source: id('a1'), target: 'src/gone.ts::gone' },
      { source: 'src/gone.ts::gone', target: id('a2') },
    ];
    const { communities } = detectCommunities(nodes, edges);
    assert.equal(communities.length, 1);
    assert.equal(communities[0]!.internalEdges, 1, 'the repeated pair counts once');
    assert.equal(communities[0]!.externalEdges, 0);
    assert.equal(communities[0]!.cohesion, 1);
  });
});

describe('detectCommunities on a graph with known module structure', () => {
  // Eight modules of twenty functions: a ring inside each module plus a few
  // chords, and one call from each module into the next. The structure is
  // known, so a partition that collapses it into one community — or shatters
  // it into dozens — is a real failure, not a judgement call.
  const MODULES = 8;
  const PER_MODULE = 20;
  const built = (() => {
    const nodes: CommunityInputNode[] = [];
    const edges: CommunityInputEdge[] = [];
    const name = (module: number, index: number) => `m${module}f${index}`;
    for (let module = 0; module < MODULES; module += 1) {
      for (let index = 0; index < PER_MODULE; index += 1) {
        nodes.push({ id: id(name(module, index)), name: name(module, index) });
      }
      for (let index = 0; index < PER_MODULE; index += 1) {
        const next = (index + 1) % PER_MODULE;
        const chord = (index + 5) % PER_MODULE;
        edges.push({ source: id(name(module, index)), target: id(name(module, next)) });
        edges.push({ source: id(name(module, index)), target: id(name(module, chord)) });
      }
      const neighbour = (module + 1) % MODULES;
      edges.push({ source: id(name(module, 0)), target: id(name(neighbour, 0)) });
    }
    return { nodes, edges };
  })();

  it('recovers close to the real modules, never one blob and never dozens of fragments', () => {
    const { communities, communityOfNode } = detectCommunities(built.nodes, built.edges);
    assert.ok(
      communities.length >= MODULES / 2 && communities.length <= MODULES * 2,
      `found ${communities.length} communities for ${MODULES} planted modules`,
    );
    assert.equal(communityOfNode.size, MODULES * PER_MODULE, 'every function is placed');

    let agreeing = 0;
    for (let module = 0; module < MODULES; module += 1) {
      const members = Array.from({ length: PER_MODULE }, (_unused, index) =>
        communityOfNode.get(id(`m${module}f${index}`)),
      );
      const counts = new Map<string | undefined, number>();
      for (const community of members) {
        counts.set(community, (counts.get(community) ?? 0) + 1);
      }
      agreeing += Math.max(...counts.values());
    }
    const agreement = agreeing / (MODULES * PER_MODULE);
    assert.ok(agreement >= 0.9, `only ${(agreement * 100).toFixed(0)}% of functions sat with their own module`);
  });

  it('reports every community as more internally than externally connected', () => {
    const { communities } = detectCommunities(built.nodes, built.edges);
    for (const community of communities) {
      assert.ok(community.cohesion > 0.5, `${community.label} has cohesion ${community.cohesion}`);
    }
  });
});

describe('detectCommunities keeps the map readable on a leaf-heavy graph', () => {
  /**
   * Real call graphs are sparse: on driller's own repository the commonest
   * Function-to-Function degree is 1. Maximizing modularity over such a
   * graph leaves a long tail of two- and three-member communities, which is
   * what `MIN_COMMUNITY_MEMBERS` folds away.
   */
  function leafHeavy(nodeCount: number) {
    const nodes: CommunityInputNode[] = Array.from({ length: nodeCount }, (_unused, index) => ({
      id: id(`f${index}`),
      name: `f${index}`,
    }));
    const edges: CommunityInputEdge[] = [];
    const hubs = Math.max(1, Math.floor(nodeCount / 12));
    let seed = 12345;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    for (let index = hubs; index < nodeCount; index += 1) {
      edges.push({ source: id(`f${next(hubs)}`), target: id(`f${index}`) });
      if (index % 3 === 0) {
        edges.push({ source: id(`f${index}`), target: id(`f${next(hubs)}`) });
      }
    }
    for (let hub = 0; hub + 1 < hubs; hub += 1) {
      if (hub % 4 !== 0) {
        edges.push({ source: id(`f${hub}`), target: id(`f${hub + 1}`) });
      }
    }
    return { nodes, edges };
  }

  it('leaves no small community that had a neighbour to join', () => {
    const { nodes, edges } = leafHeavy(1334);
    const { communities, links } = detectCommunities(nodes, edges);
    const linked = new Set(links.flatMap((link) => [link.sourceCommunityId, link.targetCommunityId]));
    for (const community of communities) {
      if (community.id === UNREFERENCED_COMMUNITY_ID || community.memberIds.length >= MIN_COMMUNITY_MEMBERS) {
        continue;
      }
      assert.ok(!linked.has(community.id), `${community.label} is under the floor but still has a neighbour`);
    }
  });

  it('gives a readable number of communities rather than hundreds of pairs', () => {
    const { nodes, edges } = leafHeavy(1334);
    const { communities, communityOfNode } = detectCommunities(nodes, edges);
    assert.ok(communities.length < 120, `${communities.length} communities is too many to read`);
    assert.ok(communities.length > 1, 'and more than one, so the map is actually grouped');
    assert.equal(communityOfNode.size, nodes.length, 'every Node is still placed');
  });

  it('leaves an island below the floor alone — it has no neighbour to join', () => {
    const { nodes, edges } = leafHeavy(1334);
    const island = nodesOf('islandA', 'islandB');
    const { communities } = detectCommunities(
      [...nodes, ...island],
      [...edges, ...edgesOf(['islandA', 'islandB'])],
    );
    const found = communities.find((community) => community.memberIds.includes(id('islandA')));
    assert.ok(found, 'the island is a community of its own');
    assert.deepEqual([...found.memberIds], [id('islandA'), id('islandB')]);
    assert.notEqual(found.id, UNREFERENCED_COMMUNITY_ID, 'it has an edge, so it is not unreferenced');
  });
});
