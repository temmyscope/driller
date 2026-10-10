/**
 * P4-7h: Revealed's shared-reach edges between candidate cards, after the
 * founder decisions (2026-10-05): drawn only for the hovered or focused
 * candidate, to its 3 strongest partners, as an arc through the gutter left
 * of column 0 with the label at its apex; every pair listed in Node detail.
 * Pure parts: `sharedReachPartners`, `relationEdges`, `sharedReachArc`,
 * `formatSharedReachList`, `sharedReachFlowEdges`, `SharedReachEdge`,
 * `withSharedReachEdges`, the click exclusion and Node detail's section.
 * P4-8g: the wiring inside `CodeMap` (hover and focus, Full, the click, the
 * legend, the Node detail list, a pin change's relations) is rendered in
 * `CodeMap.sharedReach.dom.test.tsx`.
 *
 * What this cannot reach: the live canvas (the arcs and labels as drawn,
 * hover and focus, a hand count against expanding both candidates) — the
 * P4-7h live check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CodeMapEdge, CodeMapNode, EntryCandidate, EntryCandidateRelation } from '@driller/ipc-contracts';

import {
  assembleRenderedEdges,
  callEdgesOf,
  isRevealConnectorEdgeId,
  NODE_DETAIL_SECTION_HEADING_IDS,
  NodeDetailBody,
  pathTraceHighlight,
  SharedReachEdge,
  sharedReachFlowEdges,
  withSharedReachEdges,
} from './CodeMap';
import {
  collapseNode,
  expandNode,
  formatSharedReachList,
  initialRevealState,
  pruneRevealState,
  refreshRevealState,
  relationEdges,
  revealDrillGraphFor,
  SHARED_REACH_ARC_OFFSET,
  SHARED_REACH_ARC_STEP,
  SHARED_REACH_DRAWN_MAX,
  sharedReachArc,
  sharedReachAriaLabel,
  sharedReachLabel,
  sharedReachPartners,
  type RevealState,
} from './revealView';
import { renderTree, textOf } from './testRender';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

function candidate(id: string, reach: number): EntryCandidate {
  return { id, name: id, file: `src/${id}.ts`, startLine: 1, endLine: 2, reach, reason: { kind: 'no-callers' } };
}

const calls = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });

// A -> r, c; B -> r, x; C -> y. A and B share r; C shares nothing.
const NODE_IDS = ['A', 'B', 'C', 'r', 'c', 'x', 'y'];
const EDGES: CodeMapEdge[] = [calls('A', 'r'), calls('A', 'c'), calls('B', 'r'), calls('B', 'x'), calls('C', 'y')];
const RELATIONS: EntryCandidateRelation[] = [{ a: 'A', b: 'B', sharedReach: 1 }];

function stateWith(candidates: EntryCandidate[], relations: EntryCandidateRelation[]): RevealState {
  return initialRevealState({ status: 'found', candidates, totalQualifying: candidates.length, relations });
}

function startState(relations: EntryCandidateRelation[] = RELATIONS): RevealState {
  return stateWith([candidate('A', 2), candidate('B', 2), candidate('C', 1)], relations);
}

// Hub h shares reach with five others: p4 9, p2 5, p3 5, p1 2, p5 1 (id order is
// not strength order); p1 and p2 also share 4.
const HUB = stateWith(
  ['h', 'p1', 'p2', 'p3', 'p4', 'p5'].map((id) => candidate(id, 9)),
  [
    { a: 'h', b: 'p4', sharedReach: 9 },
    { a: 'h', b: 'p3', sharedReach: 5 },
    { a: 'h', b: 'p2', sharedReach: 5 },
    { a: 'p1', b: 'p2', sharedReach: 4 },
    { a: 'h', b: 'p1', sharedReach: 2 },
    { a: 'h', b: 'p5', sharedReach: 1 },
  ],
);

const GRAPH = revealDrillGraphFor(
  null,
  NODE_IDS.map((id) => ({ id, name: id })),
  EDGES,
);

const classesOf = (edge: { className?: string }) => (edge.className ?? '').split(/\s+/);

describe('sharedReachPartners and relationEdges (P4-7h)', () => {
  it('nothing active: no edge at all — the canvas is clean', () => {
    assert.deepEqual(relationEdges(HUB, null), []);
  });

  it('the active candidate gets edges to its 3 strongest partners only (ties by id), labelled "shares N"', () => {
    assert.equal(SHARED_REACH_DRAWN_MAX, 3);
    assert.deepEqual(relationEdges(HUB, 'h'), [
      { id: 'shared-reach:["h","p4"]', source: 'h', target: 'p4', sharedReach: 9, rank: 0, label: 'shares 9', ariaLabel: 'h and p4 both reach 9 Nodes in indexed code' },
      { id: 'shared-reach:["h","p2"]', source: 'h', target: 'p2', sharedReach: 5, rank: 1, label: 'shares 5', ariaLabel: 'h and p2 both reach 5 Nodes in indexed code' },
      { id: 'shared-reach:["h","p3"]', source: 'h', target: 'p3', sharedReach: 5, rank: 2, label: 'shares 5', ariaLabel: 'h and p3 both reach 5 Nodes in indexed code' },
    ]);
    // From a partner's side, the relation is read the other way round.
    assert.deepEqual(
      relationEdges(HUB, 'p2').map((edge) => [edge.source, edge.target, edge.sharedReach]),
      [
        ['p2', 'h', 5],
        ['p2', 'p1', 4],
      ],
    );
    assert.equal(sharedReachLabel(7), 'shares 7');
    assert.equal(sharedReachAriaLabel('handleRequest', 'cron', 1), 'handleRequest and cron both reach 1 Node in indexed code');
  });

  it('every partner, uncapped, strongest first, for Node detail', () => {
    assert.deepEqual(
      sharedReachPartners(HUB, 'h').map((partner) => [partner.id, partner.sharedReach]),
      [
        ['p4', 9],
        ['p2', 5],
        ['p3', 5],
        ['p1', 2],
        ['p5', 1],
      ],
    );
    assert.equal(
      formatSharedReachList(sharedReachPartners(HUB, 'h')),
      'Shares reach with: p4 (9), p2 (5), p3 (5), p1 (2), p5 (1) — Nodes both reach in indexed code.',
    );
    assert.equal(formatSharedReachList([]), 'Shares reach with no other candidate in indexed code.');
  });

  it('disjoint reach: no relation, so no edge and no partner', () => {
    const state = startState([]);
    assert.deepEqual(relationEdges(state, 'A'), []);
    assert.deepEqual(sharedReachPartners(state, 'C'), []);
  });

  it('never a 0 overlap, a self pair, or a partner that is not a shown candidate; a non-candidate is never active', () => {
    const state = startState([
      { a: 'A', b: 'C', sharedReach: 0 },
      { a: 'A', b: 'A', sharedReach: 2 },
      { a: 'A', b: 'r', sharedReach: 1 },
      { a: 'B', b: 'ghost', sharedReach: 1 },
    ]);
    assert.deepEqual(relationEdges(state, 'A'), []);
    assert.deepEqual(relationEdges(startState(), 'r'), []);
    assert.deepEqual(relationEdges(startState(), 'ghost'), []);
  });

  it('a drilled candidate keeps its edge while both cards are shown; a drill step never changes the relations', () => {
    const start = startState();
    const expanded = expandNode(start, GRAPH.adjacency, GRAPH.reachById, 'A');
    assert.notEqual(expanded, start);
    assert.ok(expanded.revealed.has('r'));
    assert.equal(expanded.relations, start.relations);
    assert.deepEqual(
      relationEdges(expanded, 'A').map((edge) => edge.id),
      ['shared-reach:["A","B"]'],
    );
    // A drilled Node that isn't a candidate is never a partner, even if a relation named it.
    assert.deepEqual(relationEdges({ ...expanded, relations: [{ a: 'A', b: 'r', sharedReach: 1 }] }, 'A'), []);
    const collapsed = collapseNode(expanded, 'A');
    assert.equal(collapsed.relations, start.relations);
    assert.equal(relationEdges(collapsed, 'B').length, 1);
    const pruned = pruneRevealState(expanded, new Set(['A', 'B', 'C', 'c']), GRAPH.adjacency);
    assert.equal(pruned.relations, start.relations);
  });

  it('a new listing brings its own relations (refresh or pin change), never the old ones', () => {
    const previous = expandNode(startState(), GRAPH.adjacency, GRAPH.reachById, 'A');
    const fresh = startState([{ a: 'B', b: 'C', sharedReach: 4 }]);
    const rebased = refreshRevealState(previous, fresh, GRAPH);
    assert.deepEqual(rebased.relations, [{ a: 'B', b: 'C', sharedReach: 4 }]);
    assert.deepEqual(
      relationEdges(rebased, 'C').map((edge) => edge.label),
      ['shares 4'],
    );
  });
});

describe('sharedReachArc: readable routing (P4-7h)', () => {
  it('leaves and re-enters column 0 on its left side, swinging into the gutter; label at the apex', () => {
    const arc = sharedReachArc(100, 50, 350, 0);
    assert.equal(arc.path, `M 100,50 C ${100 - SHARED_REACH_ARC_OFFSET},50 ${100 - SHARED_REACH_ARC_OFFSET},350 100,350`);
    // The cubic at t = 0.5: (P0 + 3P1 + 3P2 + P3) / 8.
    assert.equal(arc.labelX, (100 + 3 * (100 - SHARED_REACH_ARC_OFFSET) * 2 + 100) / 8);
    assert.equal(arc.labelY, 200);
  });

  it('labels never sit on a card or on each other: each rank swings further out, past a label’s width', () => {
    const labelHalfWidth = 30; // "shares 1234" at 10px
    const xs = [0, 1, 2].map((rank) => sharedReachArc(0, 0, 220, rank).labelX);
    for (const x of xs) {
      assert.ok(x + labelHalfWidth < 0, `label at ${x} reaches column 0`);
    }
    for (let rank = 1; rank < xs.length; rank += 1) {
      assert.ok(xs[rank - 1]! - xs[rank]! >= 2 * labelHalfWidth, `ranks ${rank - 1} and ${rank} overlap`);
    }
    assert.equal(SHARED_REACH_ARC_STEP, 100);
  });

  it('SharedReachEdge draws that arc from the partner’s left handle, with the label at its apex', () => {
    const element = SharedReachEdge({
      id: 'shared-reach:["h","p1"]',
      source: 'h',
      target: 'p1',
      sourceX: 220,
      sourceY: 40,
      targetX: 0,
      targetY: 260,
      data: { rank: 1, label: 'shares 9' },
    } as unknown as Parameters<typeof SharedReachEdge>[0]) as { props: Record<string, unknown> };
    const arc = sharedReachArc(0, 40, 260, 1);
    assert.equal(element.props.path, arc.path);
    assert.equal(element.props.labelX, arc.labelX);
    assert.equal(element.props.labelY, arc.labelY);
    assert.equal(element.props.label, 'shares 9');
  });
});

describe('sharedReachFlowEdges and the canvas (P4-7h)', () => {
  const [flowEdge] = sharedReachFlowEdges(relationEdges(startState(), 'A'));

  it('its own edge type and class (never an edge kind’s), label data and accessible name; not selectable or focusable', () => {
    assert.deepEqual(flowEdge, {
      id: 'shared-reach:["A","B"]',
      type: 'sharedReach',
      source: 'A',
      target: 'B',
      data: { rank: 0, label: 'shares 1' },
      ariaLabel: 'A and B both reach 1 Node in indexed code',
      className: 'code-map__edge code-map__edge--shared-reach',
      selectable: false,
      focusable: false,
    });
    for (const kind of ['calls', 'usage', 'imports', 'reveal-ref']) {
      assert.ok(!classesOf(flowEdge!).includes(`code-map__edge--${kind}`));
    }
  });

  it('styled apart from the ref connector: its own token, round dots, and no pointer', () => {
    assert.match(css, /--shared-reach-edge: #[0-9a-f]{6};/);
    assert.match(
      css,
      /\.code-map__edge--shared-reach \.react-flow__edge-path \{[^}]*stroke: var\(--shared-reach-edge\);[^}]*stroke-dasharray: 0\.5 4;[^}]*stroke-linecap: round;/,
    );
    assert.match(css, /\.code-map__edge--shared-reach \{[^}]*pointer-events: none;/);
    assert.doesNotMatch(css.match(/\.code-map__edge--reveal-ref \{[^}]*\}/)?.[0] ?? '', /shared-reach-edge|0\.5 4/);
  });

  it('the edge-click guard recognises a shared-reach edge id, never a map edge’s (P4-8g: the click itself is rendered in the DOM test)', () => {
    assert.ok(flowEdge !== undefined && isRevealConnectorEdgeId(flowEdge.id));
    assert.equal(isRevealConnectorEdgeId('A→B:CALLS:0'), false);
  });

  it('added only when both cards are drawn; the edge list is untouched when there is nothing to add', () => {
    const map = [{ id: 'A→c:CALLS:0', source: 'A', target: 'c' }];
    assert.deepEqual(withSharedReachEdges(map, [flowEdge!], new Set(['A', 'B', 'c'])), [...map, flowEdge]);
    // B clustered away: no edge to a card that isn't drawn.
    assert.equal(withSharedReachEdges(map, [flowEdge!], new Set(['A', 'c'])), map);
    assert.equal(withSharedReachEdges(map, [], new Set(['A', 'B'])), map);
  });

  it('never a map edge: never path-highlighted, never in callEdgesOf (pure; P4-8g: the canvas is rendered in the DOM test)', () => {
    // The map's edges go through the highlight; the shared-reach ones never do.
    const neighbors = pathTraceHighlight(
      { status: 'neighbors', originId: 'A', direction: 'callees', nodeIds: ['A', 'B'], edgeKeys: ['A→B'], neighborIds: ['B'] },
      [],
    );
    const rendered = assembleRenderedEdges({
      flowEdges: [],
      clusters: [],
      expandedClusterIds: new Set<string>(),
      visibleNodeIds: new Set(['A', 'B']),
      changedNodeIds: new Set<string>(),
      pathHighlight: neighbors,
    });
    const withShared = withSharedReachEdges(rendered, [flowEdge!], new Set(['A', 'B']));
    assert.deepEqual(withShared.map((edge) => edge.className), ['code-map__edge code-map__edge--shared-reach']);
    assert.deepEqual(callEdgesOf(sharedReachFlowEdges(relationEdges(HUB, 'h')).map((edge) => ({ ...edge, kind: String(edge.type) }))), []);
    const found = pathTraceHighlight({ status: 'found', path: ['A', 'B'], parents: { A: null, B: 'A' }, depths: { A: 0, B: 1 } }, callEdgesOf(EDGES));
    assert.equal(found.edgeKeys.size, 0, 'A and B share reach, but no CALLS edge joins them');
  });
});

describe('Node detail (P4-7h)', () => {
  const node: CodeMapNode = {
    id: 'h',
    name: 'h',
    file: 'src/h.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Does a thing.',
    riskSignals: [],
  };
  const bodyProps = {
    node,
    toggles: { deterministic: true, llmJudgment: true, ingested: true },
    cloudSelectedNoKey: false,
    noSummaryBackendAvailable: false,
    summaryAction: null,
    regenerateState: { status: 'idle' },
    graphServiceAvailable: true,
    onRegenerate: () => {},
    onOpenTest: () => {},
  } as unknown as Parameters<typeof NodeDetailBody>[0];

  it('Node detail lists every partner of a candidate in one line — the accessible, uncapped form', () => {
    const section = renderTree(NodeDetailBody({ ...bodyProps, sharedReach: sharedReachPartners(HUB, 'h') })).find(
      (element) => element.type === 'section' && element.props['aria-labelledby'] === NODE_DETAIL_SECTION_HEADING_IDS.sharedReach,
    );
    assert.ok(section);
    assert.equal(
      textOf(section),
      'Shared reachShares reach with: p4 (9), p2 (5), p3 (5), p1 (2), p5 (1) — Nodes both reach in indexed code.',
    );
    const without = renderTree(NodeDetailBody(bodyProps)).find(
      (element) => element.props?.['aria-labelledby'] === NODE_DETAIL_SECTION_HEADING_IDS.sharedReach,
    );
    assert.equal(without, undefined);
  });
});
