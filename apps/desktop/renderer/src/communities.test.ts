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
  COMMUNITY_FILE_LABEL_MIN_SHARE,
  detectCommunities,
  isolatedCommunityLabel,
  ISOLATED_COMMUNITY_ID,
  MIN_COMMUNITY_MEMBERS,
  MIN_ISOLATED_GROUPS_TO_POOL,
  MIN_NODES_TO_PARTITION,
  UNREFERENCED_COMMUNITY_ID,
  UNREFERENCED_COMMUNITY_LABEL,
  type CommunityInputEdge,
  type CommunityInputNode,
} from './communities';

const id = (name: string) => `src/${name}.ts::${name}`;
const nodesOf = (...names: string[]): CommunityInputNode[] =>
  // One file per Node, so the modal-file share stays below
  // `COMMUNITY_FILE_LABEL_MIN_SHARE` and these fixtures keep identifier labels.
  names.map((name) => ({ id: id(name), name, file: `src/${name}.ts` }));
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
        nodes.push({ id: id(name(module, index)), name: name(module, index), file: `src/${name(module, index)}.ts` });
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
      file: `src/f${index}.ts`,
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

  it('leaves a lone island below the floor as its own community — there is no bag to pool it into', () => {
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

describe('detectCommunities pools the tail of islands', () => {
  /** `size` disconnected pairs, plus one clique big enough to partition the map. */
  function islandsBesideAModule(islandCount: number) {
    const nodes: CommunityInputNode[] = [];
    const edges: CommunityInputEdge[] = [];
    for (let index = 0; index < MIN_NODES_TO_PARTITION; index += 1) {
      nodes.push(...nodesOf(`hub${index}`));
    }
    for (let from = 0; from < MIN_NODES_TO_PARTITION; from += 1) {
      for (let to = from + 1; to < MIN_NODES_TO_PARTITION; to += 1) {
        edges.push(...edgesOf([`hub${from}`, `hub${to}`]));
      }
    }
    for (let island = 0; island < islandCount; island += 1) {
      nodes.push(...nodesOf(`i${island}a`, `i${island}b`));
      edges.push(...edgesOf([`i${island}a`, `i${island}b`]));
    }
    return { nodes, edges };
  }

  it('folds every sub-floor island into one community, named with how many', () => {
    const { nodes, edges } = islandsBesideAModule(6);
    const { communities, communityOfNode } = detectCommunities(nodes, edges);
    const pooled = communities.find((community) => community.id === ISOLATED_COMMUNITY_ID);
    assert.ok(pooled, 'the islands are pooled');
    assert.equal(pooled.label, isolatedCommunityLabel(6));
    assert.equal(pooled.memberIds.length, 12, 'all six pairs are in it');
    for (let island = 0; island < 6; island += 1) {
      assert.equal(communityOfNode.get(id(`i${island}a`)), ISOLATED_COMMUNITY_ID);
    }
    assert.equal(
      communities.filter((community) => community.memberIds.length < MIN_COMMUNITY_MEMBERS).length,
      0,
      'no sub-floor community is left drawing a card of its own',
    );
  });

  it('counts the pooled community’s own calls, and reports no traffic to anything else', () => {
    const { nodes, edges } = islandsBesideAModule(6);
    const { communities, links } = detectCommunities(nodes, edges);
    const pooled = communities.find((community) => community.id === ISOLATED_COMMUNITY_ID)!;
    assert.equal(pooled.internalEdges, 6, 'one call inside each pair');
    assert.equal(pooled.externalEdges, 0, 'islands call nothing outside — that is why they survived');
    assert.equal(
      links.filter(
        (link) =>
          link.sourceCommunityId === ISOLATED_COMMUNITY_ID || link.targetCommunityId === ISOLATED_COMMUNITY_ID,
      ).length,
      0,
    );
  });

  it('sorts after every real module, and before the unreferenced community', () => {
    const { nodes, edges } = islandsBesideAModule(6);
    const { communities } = detectCommunities([...nodes, ...nodesOf('lonely')], edges);
    const ids = communities.map((community) => community.id);
    const pooledAt = ids.indexOf(ISOLATED_COMMUNITY_ID);
    const unreferencedAt = ids.indexOf(UNREFERENCED_COMMUNITY_ID);
    assert.ok(pooledAt > 0, 'at least one real module comes first');
    assert.equal(pooledAt, ids.length - 2);
    assert.equal(unreferencedAt, ids.length - 1);
    for (const community of communities.slice(0, pooledAt)) {
      assert.ok(community.memberIds.length >= MIN_COMMUNITY_MEMBERS);
    }
  });

  it('leaves a single island alone rather than pooling one group into a bag of groups', () => {
    const { nodes, edges } = islandsBesideAModule(1);
    assert.equal(MIN_ISOLATED_GROUPS_TO_POOL, 2, 'this test encodes the threshold it is checking');
    const { communities } = detectCommunities(nodes, edges);
    assert.equal(communities.find((community) => community.id === ISOLATED_COMMUNITY_ID), undefined);
    const island = communities.find((community) => community.memberIds.includes(id('i0a')))!;
    assert.deepEqual([...island.memberIds], [id('i0a'), id('i0b')]);
  });

  it('places every Node exactly once, pooled or not', () => {
    const { nodes, edges } = islandsBesideAModule(6);
    const { communities, communityOfNode } = detectCommunities([...nodes, ...nodesOf('lonely')], edges);
    const members = communities.flatMap((community) => [...community.memberIds]);
    assert.equal(members.length, nodes.length + 1);
    assert.equal(new Set(members).size, nodes.length + 1);
    assert.equal(communityOfNode.size, nodes.length + 1);
  });

  it('states the group count in singular and plural', () => {
    assert.equal(isolatedCommunityLabel(1), '1 isolated group');
    assert.equal(isolatedCommunityLabel(14), '14 isolated groups');
  });
});

describe('detectCommunities names a community by what it can defend', () => {
  /** A clique of `size`, with `inOneFile` of its members sharing `sharedFile`. */
  function cliqueAcrossFiles(size: number, inOneFile: number, sharedFile = 'src/home.ts') {
    const nodes: CommunityInputNode[] = Array.from({ length: size }, (_unused, index) => ({
      id: id(`m${index}`),
      name: `m${index}`,
      file: index < inOneFile ? sharedFile : `src/other${index}.ts`,
    }));
    const edges: CommunityInputEdge[] = [];
    for (let from = 0; from < size; from += 1) {
      for (let to = from + 1; to < size; to += 1) {
        edges.push(...edgesOf([`m${from}`, `m${to}`]));
      }
    }
    return { nodes, edges };
  }

  it('uses the file when it holds a majority of the members', () => {
    const size = MIN_NODES_TO_PARTITION;
    const { nodes, edges } = cliqueAcrossFiles(size, Math.ceil(size * 0.8));
    const { communities } = detectCommunities(nodes, edges);
    const home = communities.find((community) => community.memberIds.includes(id('m0')))!;
    assert.equal(home.label, 'src/home.ts');
  });

  it('keeps the hub’s identifier when no file holds a majority', () => {
    const size = MIN_NODES_TO_PARTITION;
    const { nodes, edges } = cliqueAcrossFiles(size, Math.floor(size * 0.2));
    const { communities } = detectCommunities(nodes, edges);
    const community = communities.find((c) => c.memberIds.includes(id('m0')))!;
    const names = new Set(nodes.map((node) => node.name));
    assert.ok(names.has(community.label), `${community.label} is a member identifier, not a path`);
  });

  it('switches at the stated share, not somewhere near it', () => {
    assert.equal(COMMUNITY_FILE_LABEL_MIN_SHARE, 0.5, 'this test encodes the threshold it checks');
    const size = 40;
    const justUnder = detectCommunities(...Object.values(cliqueAcrossFiles(size, 19)) as [CommunityInputNode[], CommunityInputEdge[]]);
    const atShare = detectCommunities(...Object.values(cliqueAcrossFiles(size, 20)) as [CommunityInputNode[], CommunityInputEdge[]]);
    const labelFor = (result: ReturnType<typeof detectCommunities>) =>
      result.communities.find((c) => c.memberIds.includes(id('m0')))!.label;
    assert.notEqual(labelFor(justUnder), 'src/home.ts', '19 of 40 is under half');
    assert.equal(labelFor(atShare), 'src/home.ts', '20 of 40 is half');
  });

  it('never composes a name of its own — the label is always a real path or a real identifier', () => {
    const { nodes, edges } = cliqueAcrossFiles(MIN_NODES_TO_PARTITION, MIN_NODES_TO_PARTITION);
    const { communities } = detectCommunities(nodes, edges);
    const paths = new Set(nodes.map((node) => node.file));
    const names = new Set(nodes.map((node) => node.name));
    for (const community of communities) {
      assert.ok(paths.has(community.label) || names.has(community.label), community.label);
    }
  });

  it('names a community after the member its own community calls most', () => {
    // A star: every other member calls `m0`, so `m0` has an in-community
    // in-degree of 39 and everyone else 0. Each Node sits in its own file, so
    // the label is an identifier rather than a path.
    const size = MIN_NODES_TO_PARTITION;
    const nodes = nodesOf(...Array.from({ length: size }, (_unused, index) => `m${index}`));
    const edges = Array.from({ length: size - 1 }, (_unused, index) =>
      edgesOf([`m${index + 1}`, 'm0']),
    ).flat();
    const { communities, communityOfNode } = detectCommunities(nodes, edges);
    const community = communities.find((c) => c.id === communityOfNode.get(id('m0')))!;
    assert.ok(community.memberIds.length > 1, 'the star is one community, not a lone Node');
    assert.equal(community.label, 'm0', `named ${community.label}`);
  });

  it('ties on the modal file go to the first path, so the label is deterministic', () => {
    const size = MIN_NODES_TO_PARTITION;
    const nodes: CommunityInputNode[] = Array.from({ length: size }, (_unused, index) => ({
      id: id(`m${index}`),
      name: `m${index}`,
      file: index % 2 === 0 ? 'src/bbb.ts' : 'src/aaa.ts',
    }));
    const edges: CommunityInputEdge[] = [];
    for (let from = 0; from < size; from += 1) {
      for (let to = from + 1; to < size; to += 1) {
        edges.push(...edgesOf([`m${from}`, `m${to}`]));
      }
    }
    const forward = detectCommunities(nodes, edges);
    const reversed = detectCommunities([...nodes].reverse(), [...edges].reverse());
    const labelOf = (r: ReturnType<typeof detectCommunities>) =>
      r.communities.find((c) => c.memberIds.includes(id('m0')))!.label;
    // Exactly half each: under the threshold is false, so the modal file wins
    // and must be the same one whichever order the Nodes arrive in.
    assert.equal(labelOf(forward), labelOf(reversed));
    assert.equal(labelOf(forward), 'src/aaa.ts');
  });
});

describe('detectCommunities never leaves two communities reading alike', () => {
  /** `count` separate groups whose hub is called `New` in each — Go's constructor convention. */
  function groupsWithTheSameHubName(count: number) {
    const nodes: CommunityInputNode[] = [];
    const edges: CommunityInputEdge[] = [];
    const per = Math.ceil(MIN_NODES_TO_PARTITION / count) + 4;
    for (let group = 0; group < count; group += 1) {
      const dir = `pkg${group}`;
      nodes.push({ id: `${dir}/new.go::New`, name: 'New', file: `${dir}/new.go` });
      for (let index = 0; index < per; index += 1) {
        nodes.push({ id: `${dir}/f${index}.go::f${index}`, name: `f${index}`, file: `${dir}/f${index}.go` });
        edges.push({ source: `${dir}/f${index}.go::f${index}`, target: `${dir}/new.go::New` });
      }
      // A ring, so each group is cohesive enough to stay its own community.
      for (let index = 0; index < per; index += 1) {
        edges.push({
          source: `${dir}/f${index}.go::f${index}`,
          target: `${dir}/f${(index + 1) % per}.go::f${(index + 1) % per}`,
        });
      }
    }
    return { nodes, edges };
  }

  it('qualifies a repeated name with its hub’s file', () => {
    const { nodes, edges } = groupsWithTheSameHubName(3);
    const { communities } = detectCommunities(nodes, edges);
    const labels = communities.map((community) => community.label);
    assert.equal(new Set(labels).size, labels.length, `two communities read alike: ${labels.join(' / ')}`);
    const repeated = communities.filter((community) => community.label.startsWith('New ('));
    assert.ok(repeated.length >= 2, `expected qualified New labels, got ${labels.join(' / ')}`);
    for (const community of repeated) {
      // An identifier label is qualified by its hub's file.
      assert.match(community.label, /^New \(pkg\d\/new\.go\)$/);
    }
  });

  it('leaves a name alone when nothing else shares it', () => {
    const { nodes, edges } = groupsWithTheSameHubName(1);
    const { communities } = detectCommunities(nodes, edges);
    for (const community of communities) {
      assert.doesNotMatch(community.label, /\(/, `${community.label} was qualified with nothing to disambiguate`);
    }
  });
});

describe('a repeated file label is qualified by its hub, not another path', () => {
  it('names two communities sharing one big file by the hub each centres on', () => {
    // Two cohesive groups whose members mostly live in one oversized file —
    // driller's own `CodeMap.tsx` holds four such communities.
    const nodes: CommunityInputNode[] = [];
    const edges: CommunityInputEdge[] = [];
    const big = 'src/Big.tsx';
    for (const group of ['p', 'q']) {
      const size = MIN_NODES_TO_PARTITION / 2 + 2;
      for (let index = 0; index < size; index += 1) {
        nodes.push({ id: `${big}::${group}${index}`, name: `${group}${index}`, file: big });
      }
      for (let from = 0; from < size; from += 1) {
        for (let to = from + 1; to < size; to += 1) {
          edges.push({ source: `${big}::${group}${from}`, target: `${big}::${group}${to}` });
        }
      }
    }
    const { communities } = detectCommunities(nodes, edges);
    const labels = communities.map((community) => community.label);
    assert.equal(new Set(labels).size, labels.length, `two communities read alike: ${labels.join(' / ')}`);
    for (const label of labels) {
      assert.match(label, /^src\/Big\.tsx \([pq]\d+\)$/, `${label} is the file qualified by its hub identifier`);
      assert.doesNotMatch(label, /\(src\//, 'never one path qualified by another');
    }
  });
});
