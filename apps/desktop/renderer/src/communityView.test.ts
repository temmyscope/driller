/**
 * The collapsed community view (`communityView.ts`): the default collapsed
 * state, what a card states, the counted link edges, the expand/collapse
 * steps and their announcements, and the two degenerate cases.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';

import {
  detectCommunities,
  UNREFERENCED_COMMUNITY_ID,
  type CommunityInputEdge,
  type CommunityInputNode,
  type CommunityPartition,
} from './communities';
import { communityPositions, communityStructure, type CommunityBlock } from './communityLayout';
import {
  collapsedCommunityIds,
  communityViewApplies,
  communityViewMode,
  expandedForMode,
  MIN_NODES_TO_COLLAPSE,
  partitionNodeCount,
  communityCardAriaLabel,
  communityCardCohesionText,
  communityCardNodesText,
  communityCardOutsideText,
  communityCards,
  communityLinkEdges,
  communityLinkLabel,
  communityViewNotice,
  communityViewPopulation,
  COMMUNITY_LINK_EDGE_ID_PREFIX,
  formatCommunityAnnouncement,
  formatCommunityHistoryAnnouncement,
  isCommunityCardId,
  isCommunityLinkEdgeId,
  NO_EXPANDED_COMMUNITIES,
  planCommunityToggle,
} from './communityView';
import type { CanvasPopulation } from './CodeMap';

const id = (name: string) => `src/${name}.ts::${name}`;
const nodesOf = (...names: string[]): CommunityInputNode[] =>
  // One file per Node, so these fixtures keep identifier labels rather than
  // file labels (`COMMUNITY_FILE_LABEL_MIN_SHARE`).
  names.map((name) => ({ id: id(name), name, file: `src/${name}.ts` }));
const edgesOf = (...pairs: [string, string][]): CommunityInputEdge[] =>
  pairs.map(([source, target]) => ({ source: id(source), target: id(target) }));

/** Two cliques joined by one edge, above the partition floor — two unambiguous communities. */
function twoCliques(size = 20) {
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

const TWO = twoCliques();
const PARTITION = detectCommunities(TWO.nodes, TWO.edges);

/** The blocks for a given expansion state, through the real layout. */
function blocksFor(expanded: ReadonlySet<string> = NO_EXPANDED_COMMUNITIES): readonly CommunityBlock[] {
  const structure = communityStructure(TWO.nodes, TWO.edges);
  return communityPositions(structure, [], () => undefined, collapsedCommunityIds(PARTITION, expanded)).blocks;
}

describe('isCommunityCardId tells a card id from a Node id', () => {
  it('matches every community id and no Node id', () => {
    for (const community of PARTITION.communities) {
      assert.ok(isCommunityCardId(community.id), `${community.id} is a card id`);
    }
    for (const node of TWO.nodes) {
      assert.ok(!isCommunityCardId(node.id), `${node.id} is not a card id`);
    }
    assert.ok(isCommunityCardId(UNREFERENCED_COMMUNITY_ID));
    assert.ok(!isCommunityCardId('reveal:ref:["a","b"]'));
  });
});

describe('collapsedCommunityIds: collapsed is the default', () => {
  it('collapses every community when none is expanded', () => {
    const collapsed = collapsedCommunityIds(PARTITION);
    assert.equal(collapsed.size, PARTITION.communities.length);
  });

  it('leaves an expanded community out', () => {
    const first = PARTITION.communities[0]!.id;
    const collapsed = collapsedCommunityIds(PARTITION, new Set([first]));
    assert.ok(!collapsed.has(first));
    assert.equal(collapsed.size, PARTITION.communities.length - 1);
  });

  it('collapses nothing when there is only one community — there is nothing to group', () => {
    const small = detectCommunities(nodesOf('a', 'b'), edgesOf(['a', 'b']));
    assert.equal(small.communities.length, 1);
    assert.equal(collapsedCommunityIds(small).size, 0);
  });
});

describe('communityViewPopulation draws only what is expanded', () => {
  const node = (name: string): CodeMapNode => ({
    id: id(name),
    name,
    file: `src/${name}.ts`,
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'pending',
    riskSignals: [],
  });
  const edge = (from: string, to: string): CodeMapEdge => ({ source: id(from), target: id(to), kind: 'CALLS' });
  const population: CanvasPopulation = {
    riskNodes: TWO.nodes.map((input) => node(input.name)),
    riskEdges: TWO.edges.map((input) => ({ source: input.source, target: input.target, kind: 'CALLS' })),
    canvasNodes: TWO.nodes.map((input) => node(input.name)),
    canvasEdges: TWO.edges.map((input) => ({ source: input.source, target: input.target, kind: 'CALLS' })),
    foldedNodes: [],
  };

  it('draws nothing but keeps every number when everything is collapsed', () => {
    const drawn = communityViewPopulation(population, collapsedCommunityIds(PARTITION), PARTITION.communityOfNode);
    assert.equal(drawn.mapNodes.length, 0, 'no Node card is drawn');
    assert.equal(drawn.canvasEdges.length, 0);
    assert.equal(drawn.riskNodes, population.riskNodes, 'the very same array every number reads');
    assert.equal(drawn.riskEdges, population.riskEdges);
  });

  it('draws one community’s Nodes when it is expanded, and no others', () => {
    const expandedId = PARTITION.communityOfNode.get(id('a0'))!;
    const community = PARTITION.communities.find((candidate) => candidate.id === expandedId)!;
    const drawn = communityViewPopulation(
      population,
      collapsedCommunityIds(PARTITION, new Set([expandedId])),
      PARTITION.communityOfNode,
    );
    assert.equal(drawn.mapNodes.length, community.memberIds.length);
    assert.deepEqual(
      drawn.mapNodes.map((drawnNode) => drawnNode.id).sort(),
      [...community.memberIds].sort(),
    );
    assert.equal(drawn.riskNodes, population.riskNodes, 'the numbers still read the whole map');
  });

  it('keeps only edges with both ends drawn', () => {
    const expandedId = PARTITION.communityOfNode.get(id('a0'))!;
    const drawn = communityViewPopulation(
      population,
      collapsedCommunityIds(PARTITION, new Set([expandedId])),
      PARTITION.communityOfNode,
    );
    const drawnIds = new Set(drawn.mapNodes.map((drawnNode) => drawnNode.id));
    for (const drawnEdge of drawn.canvasEdges) {
      assert.ok(drawnIds.has(drawnEdge.source) && drawnIds.has(drawnEdge.target));
    }
    assert.ok(drawn.canvasEdges.length > 0, 'the expanded community’s own calls are drawn');
  });

  it('passes everything through untouched when nothing is collapsed', () => {
    const drawn = communityViewPopulation(population, new Set(), PARTITION.communityOfNode);
    assert.equal(drawn.canvasEdges, population.canvasEdges);
    assert.equal(drawn.mapNodes.length, population.riskNodes.length);
    assert.equal(edge('a0', 'a1').kind, 'CALLS');
  });
});

describe('a community card states what it holds', () => {
  it('one card per collapsed block, at the block’s own position', () => {
    const blocks = blocksFor();
    const cards = communityCards(blocks, PARTITION);
    assert.equal(cards.length, PARTITION.communities.length);
    for (const card of cards) {
      const block = blocks.find((candidate) => candidate.communityId === card.id)!;
      assert.deepEqual(card.position, { x: block.x, y: block.y });
    }
  });

  it('no card for an expanded community — its Nodes are drawn instead', () => {
    const expandedId = PARTITION.communities[0]!.id;
    const cards = communityCards(blocksFor(new Set([expandedId])), PARTITION);
    assert.ok(!cards.some((card) => card.id === expandedId));
    assert.equal(cards.length, PARTITION.communities.length - 1);
  });

  it('names the community by a real member identifier and counts its Nodes', () => {
    const names = new Set(TWO.nodes.map((node) => node.name));
    for (const card of communityCards(blocksFor(), PARTITION)) {
      assert.ok(names.has(card.label), `${card.label} is a real identifier`);
      assert.equal(card.memberCount, 20);
    }
  });

  it('states cohesion as the real counts, never a derived percentage', () => {
    assert.equal(communityCardCohesionText(12, 3), '12 of 15 calls inside');
    assert.equal(communityCardCohesionText(1, 0), '1 of 1 calls inside');
    assert.doesNotMatch(communityCardCohesionText(12, 3), /%/);
  });

  it('says so rather than "0 of 0" when a community has no calls', () => {
    assert.equal(communityCardCohesionText(0, 0), 'no calls in indexed code');
  });

  it('shows outside traffic only when there is some — never a bare 0', () => {
    assert.equal(communityCardOutsideText(0), null);
    assert.equal(communityCardOutsideText(3), '3 out');
  });

  it('pluralizes a single Node and a single call', () => {
    assert.equal(communityCardNodesText(1), '1 Node');
    assert.equal(communityCardNodesText(2), '2 Nodes');
    assert.equal(communityLinkLabel(1), '1 call');
    assert.equal(communityLinkLabel(4), '4 calls');
  });

  it('spells the whole card out in its accessible name, including the action', () => {
    const [card] = communityCards(blocksFor(), PARTITION);
    const spoken = communityCardAriaLabel(card!);
    assert.match(spoken, /^Community /);
    assert.match(spoken, new RegExp(card!.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(spoken, /20 Nodes/);
    assert.match(spoken, /calls inside/);
    assert.match(spoken, /expand$/);
  });
});

describe('link edges carry the real call counts as text', () => {
  it('draws one edge per pair of collapsed communities with traffic, strongest first', () => {
    const collapsed = collapsedCommunityIds(PARTITION);
    const edges = communityLinkEdges(PARTITION, collapsed);
    assert.ok(edges.length >= 1);
    assert.deepEqual([...edges].sort((a, b) => b.count - a.count), edges);
    for (const edge of edges) {
      assert.ok(collapsed.has(edge.source) && collapsed.has(edge.target));
      assert.equal(edge.label, communityLinkLabel(edge.count));
      assert.ok(edge.id.startsWith(COMMUNITY_LINK_EDGE_ID_PREFIX));
      assert.match(edge.ariaLabel, /in indexed code$/);
    }
  });

  it('states the count in visible text, never width or colour alone', () => {
    for (const edge of communityLinkEdges(PARTITION, collapsedCommunityIds(PARTITION))) {
      assert.match(edge.label, /\d+ calls?$/);
    }
  });

  it('leaves out a pair with either end expanded', () => {
    const expandedId = PARTITION.communities[0]!.id;
    const collapsed = collapsedCommunityIds(PARTITION, new Set([expandedId]));
    for (const edge of communityLinkEdges(PARTITION, collapsed)) {
      assert.notEqual(edge.source, expandedId);
      assert.notEqual(edge.target, expandedId);
    }
  });

  it('draws none when every community is expanded', () => {
    const all = new Set(PARTITION.communities.map((community) => community.id));
    assert.deepEqual(communityLinkEdges(PARTITION, collapsedCommunityIds(PARTITION, all)), []);
  });
});

describe('planCommunityToggle: one step per expand or collapse', () => {
  const first = () => PARTITION.communities[0]!.id;

  it('expands a collapsed community', () => {
    const plan = planCommunityToggle(PARTITION, NO_EXPANDED_COMMUNITIES, first());
    assert.equal(plan.kind, 'step');
    assert.ok(plan.kind === 'step' && plan.step === 'expand' && plan.next.has(first()));
  });

  it('collapses an expanded one', () => {
    const plan = planCommunityToggle(PARTITION, new Set([first()]), first());
    assert.ok(plan.kind === 'step' && plan.step === 'collapse' && !plan.next.has(first()));
  });

  it('a direction given only acts that way, and says so otherwise', () => {
    const expandAgain = planCommunityToggle(PARTITION, new Set([first()]), first(), 'expand');
    assert.ok(expandAgain.kind === 'none' && /already expanded/.test(expandAgain.text));
    const collapseAgain = planCommunityToggle(PARTITION, NO_EXPANDED_COMMUNITIES, first(), 'collapse');
    assert.ok(collapseAgain.kind === 'none' && /already collapsed/.test(collapseAgain.text));
  });

  it('never collapses the only community, and says why', () => {
    const small = detectCommunities(nodesOf('a', 'b'), edgesOf(['a', 'b']));
    const plan = planCommunityToggle(small, NO_EXPANDED_COMMUNITIES, small.communities[0]!.id, 'collapse');
    assert.ok(plan.kind === 'none' && /only community/.test(plan.text));
  });

  it('an id that is not on the map is a no-op with a sentence', () => {
    const plan = planCommunityToggle(PARTITION, NO_EXPANDED_COMMUNITIES, 'community:gone');
    assert.ok(plan.kind === 'none' && /not on this map/.test(plan.text));
  });

  it('never mutates the state it was given', () => {
    const expanded = new Set([first()]);
    planCommunityToggle(PARTITION, expanded, first());
    assert.deepEqual([...expanded], [first()]);
  });
});

describe('announcements name the community and what changed', () => {
  it('states the step, the community and its Node count', () => {
    assert.equal(formatCommunityAnnouncement('expand', 'charge', 23), 'Expanded charge — 23 Nodes');
    assert.equal(formatCommunityAnnouncement('collapse', 'charge', 23), 'Collapsed charge — 23 Nodes hidden');
  });

  it('a Back over an expand announces the collapse it applied', () => {
    assert.equal(
      formatCommunityHistoryAnnouncement('undo', 'expand', 'charge', 23),
      'Back: Collapsed charge — 23 Nodes hidden',
    );
  });

  it('a Forward over an expand announces the expand again', () => {
    assert.equal(
      formatCommunityHistoryAnnouncement('redo', 'expand', 'charge', 23),
      'Forward: Expanded charge — 23 Nodes',
    );
  });

  it('returning to a step announces it without a direction prefix', () => {
    assert.equal(formatCommunityHistoryAnnouncement('return', 'collapse', 'charge', 2), 'Collapsed charge — 2 Nodes hidden');
  });
});

describe('communityViewNotice covers the degenerate cases', () => {
  it('owes no notice when there is more than one community', () => {
    assert.equal(communityViewNotice(PARTITION), null);
  });

  it('states that one community means nothing to group', () => {
    const small = detectCommunities(nodesOf('entry', 'hot'), edgesOf(['entry', 'hot']));
    const notice = communityViewNotice(small);
    assert.equal(notice?.kind, 'single-community');
    assert.match(notice!.sentence, /One community in indexed code/);
    assert.match(notice!.sentence, /nothing to group/);
    assert.match(notice!.sentence, /2 Nodes/);
  });

  it('states when the whole map is unreferenced', () => {
    const edgeless = detectCommunities(nodesOf('a', 'b', 'c'), []);
    const notice = communityViewNotice(edgeless);
    assert.equal(notice?.kind, 'all-unreferenced');
    assert.match(notice!.sentence, /No call edges in indexed code/);
    assert.match(notice!.sentence, /3 Nodes/);
  });

  it('owes no notice for an empty map — the existing empty notice has that surface', () => {
    const empty: CommunityPartition = detectCommunities([], []);
    assert.equal(communityViewNotice(empty), null);
  });
});

describe('the collapse floor: grouping only when there is enough to hide', () => {
  /**
   * A small map that still has two communities: one connected group plus
   * Nodes with no call edge, which always form their own. This is the only
   * way to be below the collapse floor with more than one community, since
   * the partition floor is the same number — and it is exactly the shape of
   * the seven-Node `path-trace-basic` fixture.
   */
  function smallWithTwo() {
    const connected = twoCliques(5);
    return { nodes: [...connected.nodes, ...nodesOf('lonely', 'alsoLonely')], edges: connected.edges };
  }

  it('does not apply below MIN_NODES_TO_COLLAPSE, even with more than one community', () => {
    const small = smallWithTwo();
    const partition = detectCommunities(small.nodes, small.edges);
    assert.ok(partition.communities.length > 1, 'the unreferenced Nodes form their own community');
    assert.ok(partitionNodeCount(partition) < MIN_NODES_TO_COLLAPSE);
    assert.equal(communityViewApplies(partition), false);
    assert.equal(collapsedCommunityIds(partition).size, 0, 'every Node is drawn');
  });

  it('applies at the floor', () => {
    const at = detectCommunities(TWO.nodes, TWO.edges);
    assert.equal(partitionNodeCount(at), MIN_NODES_TO_COLLAPSE);
    assert.equal(communityViewApplies(at), true);
    assert.ok(collapsedCommunityIds(at).size > 1);
  });

  it('states why a map below the floor shows no cards', () => {
    const small = smallWithTwo();
    const notice = communityViewNotice(detectCommunities(small.nodes, small.edges));
    assert.equal(notice?.kind, 'too-small');
    assert.match(notice!.sentence, /too few to group, so every Node is shown/);
    assert.match(notice!.sentence, /12 Nodes/);
  });

  it('counts every community’s members', () => {
    assert.equal(partitionNodeCount(PARTITION), MIN_NODES_TO_COLLAPSE);
    assert.equal(partitionNodeCount(detectCommunities([], [])), 0);
  });
});

describe('communityViewMode and expandedForMode', () => {
  it('is grouped when nothing is expanded, and all when everything is', () => {
    assert.equal(communityViewMode(PARTITION, NO_EXPANDED_COMMUNITIES), 'grouped');
    const all = expandedForMode(PARTITION, 'all');
    assert.equal(all.size, PARTITION.communities.length);
    assert.equal(communityViewMode(PARTITION, all), 'all');
  });

  it('is grouped while even one community is still collapsed', () => {
    const allButOne = new Set([...expandedForMode(PARTITION, 'all')].slice(1));
    assert.equal(communityViewMode(PARTITION, allButOne), 'grouped');
  });

  it('switching to grouped expands nothing', () => {
    assert.equal(expandedForMode(PARTITION, 'grouped').size, 0);
  });

  it('a map the view does not apply to is always all', () => {
    const small = detectCommunities(nodesOf('a', 'b'), edgesOf(['a', 'b']));
    assert.equal(communityViewMode(small, NO_EXPANDED_COMMUNITIES), 'all');
  });
});

describe('AD-2: a community id never leaves the renderer', () => {
  it('a link edge id is recognisable, so a click on one never navigates', () => {
    const edges = communityLinkEdges(PARTITION, collapsedCommunityIds(PARTITION));
    assert.ok(edges.length > 0);
    for (const edge of edges) {
      assert.ok(isCommunityLinkEdgeId(edge.id), `${edge.id} is a link edge`);
    }
  });

  it('no Node id, community card id or reveal card id looks like a link edge id', () => {
    for (const community of PARTITION.communities) {
      assert.ok(!isCommunityLinkEdgeId(community.id));
    }
    for (const node of TWO.nodes) {
      assert.ok(!isCommunityLinkEdgeId(node.id));
    }
    assert.ok(!isCommunityLinkEdgeId('reveal:ref:["a","b"]'));
    assert.ok(!isCommunityLinkEdgeId('src/a.ts::a→src/b.ts::b:CALLS:0'));
  });

  it('a link edge’s endpoints are community ids, which `isCommunityCardId` catches', () => {
    for (const edge of communityLinkEdges(PARTITION, collapsedCommunityIds(PARTITION))) {
      assert.ok(isCommunityCardId(edge.source) && isCommunityCardId(edge.target));
    }
  });
});
