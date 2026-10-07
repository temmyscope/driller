/**
 * P4-7e: the drill in `CodeMap` — the expand/collapse button on a revealed
 * Node's card, the ref and stub cards (render-only), the ref connector and
 * `layoutNodes`' Revealed extras, as hookless components.
 *
 * P4-8f: the hook wiring is rendered in `CodeMap.drill.dom.test.tsx`; the
 * one source pin left here (the drill step's wiring) is not in P4-8f's list.
 *
 * What this cannot reach: the live canvas (a real expand on driller/app, the
 * ~150 ms budget, the cards' look) — the P4-7e live check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CodeMapEdge, CodeMapNode } from '@driller/ipc-contracts';

import {
  activateCanvasCard,
  CodeMapNodeCard,
  CodeMapRevealRefCard,
  CodeMapRevealStubCard,
  isRevealConnectorEdgeId,
  layoutNodes,
  revealRefConnectorEdges,
  type LayoutRevealExtras,
  type NodeAdjacency,
} from './CodeMap';
import {
  expandNode,
  initialRevealState,
  layeredLayout,
  REVEAL_LAYER_CAP,
  revealAuxCards,
  revealDrillControls,
  revealDrillGraphFor,
  revealRefCardId,
  revealStubCardId,
  type RevealAuxCard,
  type RevealDrillControl,
} from './revealView';
import { renderTree, textOf, type RenderedElement } from './testRender';

const codeMapSrc = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

function node(id: string): CodeMapNode {
  return {
    id,
    name: id,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Does a thing.',
    riskSignals: [],
  };
}

const edge = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });

const noop = () => {};

function hostElements(root: unknown): RenderedElement[] {
  return renderTree(root).filter((element) => typeof element.type === 'string');
}

function cardData(extra: Record<string, unknown> = {}) {
  return {
    node: node('handleRequest'),
    onActivate: noop,
    onShowNeighbors: noop,
    onOpenSource: noop,
    callerCount: 0,
    calleeCount: 2,
    noSummaryBackendAvailable: false,
    cloudSelectedNoKey: false,
    showDeterministicSignals: true,
    showLlmJudgment: true,
    showIngestedFindings: true,
    isChanged: false,
    ...extra,
  };
}

function stopEvent() {
  const event = { stopped: 0, stopPropagation() {
    event.stopped += 1;
  } };
  return event;
}

describe('the expand/collapse button', () => {
  const drillButton = (root: unknown) =>
    hostElements(root).find(
      (element) => element.type === 'button' && String(element.props.className).includes('code-map__node-affordance--drill'),
    );

  it('"▸ Expand callees (N)": aria-expanded false, names the Node, and expands without opening Node detail', () => {
    const calls: string[] = [];
    const root = CodeMapNodeCard({
      data: cardData({
        drill: { kind: 'expand', count: 3 } satisfies RevealDrillControl,
        onDrill: (n: CodeMapNode, action: string) => calls.push(`${action}:${n.id}`),
      }),
    } as never);
    const button = drillButton(root);
    assert.ok(button);
    assert.equal(textOf(button), '▸ Expand callees (3)');
    assert.equal(button.props['aria-expanded'], false);
    assert.equal(button.props['aria-label'], 'Expand 3 callees of handleRequest');
    for (const handler of ['onMouseDown', 'onKeyDown', 'onClick'] as const) {
      const event = stopEvent();
      (button.props[handler] as (event: unknown) => void)(event);
      assert.equal(event.stopped, 1, `${handler} must stop propagation`);
    }
    assert.deepEqual(calls, ['expand:handleRequest']);
  });

  it('"▾ Collapse": aria-expanded true, collapses', () => {
    const calls: string[] = [];
    const root = CodeMapNodeCard({
      data: cardData({
        drill: { kind: 'collapse' } satisfies RevealDrillControl,
        onDrill: (n: CodeMapNode, action: string) => calls.push(`${action}:${n.id}`),
      }),
    } as never);
    const button = drillButton(root);
    assert.ok(button);
    assert.equal(textOf(button), '▾ Collapse');
    assert.equal(button.props['aria-expanded'], true);
    (button.props.onClick as (event: unknown) => void)(stopEvent());
    assert.deepEqual(calls, ['collapse:handleRequest']);
  });

  it('no button at N = 0 (no control) — and none in Full (no drill data)', () => {
    assert.equal(drillButton(CodeMapNodeCard({ data: cardData({ onDrill: noop }) } as never)), undefined);
    assert.equal(drillButton(CodeMapNodeCard({ data: cardData() } as never)), undefined);
  });

  it('shows the cross-section note when it has one, on one line, the full text in its title', () => {
    const note = '↗ Calls 2 Nodes in other sections (not shown in this section)';
    const root = CodeMapNodeCard({ data: cardData({ crossSectionNote: note }) } as never) as unknown as RenderedElement;
    const line = hostElements(root).find((element) => element.props.className === 'code-map__node-cross-section-note');
    assert.equal(line !== undefined && textOf(line), note);
    assert.equal(line?.props.title, note);
    // The card trades the summary's second line for it (styles.css), so it is never taller.
    assert.match(String(root.props.className), /code-map__node--cross-section-note/);
    const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
    assert.match(css, /\.code-map__node--cross-section-note \.code-map__node-summary \{\s*-webkit-line-clamp: 1;/);
    assert.match(css, /\.code-map__node-cross-section-note \{[^}]*white-space: nowrap;/);
    assert.equal(
      hostElements(CodeMapNodeCard({ data: cardData() } as never)).some(
        (element) => element.props.className === 'code-map__node-cross-section-note',
      ),
      false,
    );
  });
});

describe('the ref and stub cards', () => {
  const ref: Extract<RevealAuxCard, { kind: 'ref' }> = {
    kind: 'ref',
    id: revealRefCardId('serviceB', 'repository'),
    parentId: 'serviceB',
    targetId: 'repository',
    targetName: 'repository',
  };
  const stub: Extract<RevealAuxCard, { kind: 'more' }> = {
    kind: 'more',
    id: revealStubCardId('hub'),
    parentId: 'hub',
    parentName: 'hub',
    hiddenCount: 15,
  };

  it('a ref reads "↺ repository shown above" and Enter or Space goes to it', () => {
    const calls: string[] = [];
    const root = CodeMapRevealRefCard({ data: { ref, onActivate: (r) => calls.push(r.targetId) } }) as unknown as RenderedElement;
    assert.equal(squash(textOf(root)), '↺ repository shown above');
    assert.equal(root.props.role, 'button');
    assert.equal(root.props['aria-label'], 'repository is shown above, go to it');
    for (const key of ['Enter', ' ', 'a']) {
      (root.props.onKeyDown as (event: unknown) => void)({ key, preventDefault: noop });
    }
    assert.deepEqual(calls, ['repository', 'repository']);
  });

  it('a stub reads "+15 more callees" and is activatable', () => {
    const calls: string[] = [];
    const root = CodeMapRevealStubCard({ data: { stub, onActivate: (s) => calls.push(s.parentId) } }) as unknown as RenderedElement;
    assert.equal(textOf(root), '+15 more callees');
    assert.equal(root.props.role, 'button');
    assert.equal(root.props['aria-label'], '+15 more callees of hub, show the next 15');
    (root.props.onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault: noop });
    assert.deepEqual(calls, ['hub']);
  });

  it('a click on the canvas card goes the same way (activateCanvasCard)', () => {
    const calls: string[] = [];
    activateCanvasCard(
      { id: ref.id, type: 'codeMapRevealRef', position: { x: 0, y: 0 }, data: { ref, onActivate: (r) => calls.push(`ref:${r.targetId}`) } },
      () => calls.push('cluster'),
    );
    activateCanvasCard(
      { id: stub.id, type: 'codeMapRevealStub', position: { x: 0, y: 0 }, data: { stub, onActivate: (s) => calls.push(`stub:${s.parentId}`) } },
      () => calls.push('cluster'),
    );
    assert.deepEqual(calls, ['ref:repository', 'stub:hub']);
  });

  it('the connector: parent → ref card only, its own class, labelled "shown above" (no stub connector)', () => {
    assert.deepEqual(revealRefConnectorEdges([ref, stub]), [
      {
        id: `reveal-connector:${ref.id}`,
        source: 'serviceB',
        target: ref.id,
        label: 'shown above',
        className: 'code-map__edge code-map__edge--reveal-ref',
        selectable: false,
        focusable: false,
      },
    ]);
  });

  // P4-8f: the pure half of the connector pin (its click handling is rendered in `CodeMap.drill.dom.test.tsx`).
  it('a connector id is recognised as one; a real edge id is not', () => {
    const [connector] = revealRefConnectorEdges([ref]);
    assert.ok(connector !== undefined && isRevealConnectorEdgeId(connector.id));
    assert.equal(isRevealConnectorEdgeId('src/a.ts::serviceB→src/r.ts::repository:CALLS:0'), false);
  });

  // P4-8f: the CSS halves of the connector and node-type pins (jsdom applies
  // no stylesheet); the wiring is rendered in `CodeMap.drill.dom.test.tsx`.
  it('styles.css: both cards and the connector are styled, and the connector never takes the pointer', () => {
    const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
    for (const selector of ['.code-map__reveal-ref', '.code-map__reveal-stub', '.code-map__edge--reveal-ref']) {
      assert.ok(css.includes(selector), selector);
    }
    assert.match(css, /\.code-map__edge--reveal-ref \{[^}]*pointer-events: none;/);
  });
});

describe('layoutNodes in Revealed', () => {
  /** A hub with 45 leaf callees, expanded. */
  function hub45() {
    const ids = ['hub', ...Array.from({ length: 45 }, (_, i) => `c${String(i).padStart(2, '0')}`)];
    const nodes = ids.map(node);
    const graph = revealDrillGraphFor(null, nodes, ids.slice(1).map((id) => edge('hub', id)));
    const start = initialRevealState({
      status: 'found',
      candidates: [{ id: 'hub', name: 'hub', file: 'src/a.ts', startLine: 1, endLine: 9, reach: 45, reason: { kind: 'no-callers' } }],
      totalQualifying: 1,
      relations: [],
    });
    const state = expandNode(start, graph.adjacency, graph.reachById, 'hub');
    return { nodes, graph, state };
  }

  function revealedLayout(extras: Partial<LayoutRevealExtras> = {}) {
    const { nodes, graph, state } = hub45();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const mapNodes = nodes.filter((n) => state.revealed.has(n.id));
    const positions = layeredLayout(state);
    const reveal: LayoutRevealExtras = {
      controls: revealDrillControls(state, graph.adjacency),
      onDrill: noop,
      auxCards: revealAuxCards(state, (id) => byId.get(id)?.name),
      onActivateRef: noop,
      onActivateStub: noop,
      ...extras,
    };
    return layoutNodes(
      mapNodes,
      noop,
      noop,
      noop,
      new Map() as NodeAdjacency,
      false,
      false,
      true,
      true,
      true,
      new Set(),
      [],
      noop,
      new Map(),
      (id) => positions.get(id) ?? { x: -1, y: -1 },
      undefined,
      reveal,
    );
  }

  it('a 45-callee hub: exactly 30 callee cards plus one "+15 more callees" stub, each at its layered position', () => {
    const cards = revealedLayout();
    const nodeCards = cards.filter((card) => card.type === 'codeMapNode');
    assert.equal(nodeCards.length, 1 + REVEAL_LAYER_CAP);
    assert.equal(new Set(cards.map((card) => card.id)).size, cards.length);
    const stubs = cards.filter((card) => card.type === 'codeMapRevealStub');
    assert.equal(stubs.length, 1);
    const stubCard = stubs[0]!;
    assert.ok(stubCard.type === 'codeMapRevealStub');
    assert.equal(textOf(CodeMapRevealStubCard({ data: stubCard.data })), '+15 more callees');
    assert.deepEqual(stubCard.position, { x: 260, y: 30 * 110 });
    // The hub's card carries "▾ Collapse"; a leaf callee's carries no control.
    const hubCard = nodeCards.find((card) => card.id === 'hub');
    assert.ok(hubCard?.type === 'codeMapNode');
    assert.deepEqual(hubCard.data.drill, { kind: 'collapse' });
    const leafCard = nodeCards.find((card) => card.id === 'c00');
    assert.ok(leafCard?.type === 'codeMapNode');
    assert.equal('drill' in leafCard.data, false);
  });

  it('an expanded Node with callees in other sections carries the note (P4-4g’s count); an unexpanded one doesn’t (review round 1)', () => {
    const crossSection = {
      crossSectionCalls: [{ id: 'web/r.ts::render', name: 'render', section: 'web' }],
      crossSectionCallsTotal: 3,
    };
    const cards = layoutNodes(
      [{ ...node('a'), ...crossSection }, { ...node('b'), ...crossSection }],
      noop,
      noop,
      noop,
      new Map() as NodeAdjacency,
      false,
      false,
      true,
      true,
      true,
      new Set(),
      [],
      noop,
      new Map(),
      () => ({ x: 0, y: 0 }),
      undefined,
      {
        controls: new Map<string, RevealDrillControl>([
          ['a', { kind: 'collapse' }],
          ['b', { kind: 'expand', count: 2 }],
        ]),
        onDrill: noop,
        auxCards: [],
        onActivateRef: noop,
        onActivateStub: noop,
      },
    );
    const [a, b] = cards;
    assert.ok(a?.type === 'codeMapNode' && b?.type === 'codeMapNode');
    assert.equal(a.data.crossSectionNote, '↗ Calls 3 Nodes in other sections (not shown in this section)');
    assert.equal('crossSectionNote' in b.data, false);
  });
});

describe('the hook wiring (source pins)', () => {
  const sliceFrom = (start: string, end: string) => {
    const from = codeMapSrc.indexOf(start);
    assert.ok(from >= 0, start);
    return codeMapSrc.slice(from, codeMapSrc.indexOf(end, from));
  };

  it('a drill step is renderer-local: applied to the held state, never through window.driller', () => {
    const body = sliceFrom('const applyRevealDrill = useCallback(', 'const revealCanvas = useMemo(');
    assert.doesNotMatch(body, /window\.driller/);
    // P4-7f: the transition is planned against the held state (`planRevealDrill`).
    assert.match(body, /applyRevealTransition\(revealHeldRef\.current, key, \(state\) => \{\s*const planned = plan\(state, graph\);/);
    assert.match(body, /if \(graph === null \|\| graph\.edges !== mapStamp \|\| key === null\) \{\s*return;/);
    assert.match(body, /revealHeldRef\.current = applied\.held;\s*setRevealHeld\(applied\.held\);/);
    assert.match(body, /const planned = planRevealDrill\(state, graph, node\.id, action\);/);
    assert.match(body, /expandStub\(state, graph\.adjacency, graph\.reachById, stub\.parentId\)/);
    // A ref goes to its target through the existing navigation.
    assert.match(body, /\(ref: Extract<RevealAuxCard, \{ kind: 'ref' \}>\) => navigateToNode\(ref\.targetId\)/);
  });
});
