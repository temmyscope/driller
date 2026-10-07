/**
 * P4-7d: the Revealed start view in `CodeMap` — Full map stays byte-identical
 * (`layoutNodes` with and without `positionOf`, and the frozen HEAD
 * snapshot), Revealed lays out exactly the revealed ids at `layeredLayout`'s
 * positions, the candidate card, the toggle and the none/error/stale notice
 * as hookless components.
 *
 * P4-8f: the hook wiring is rendered in `CodeMap.revealed.dom.test.tsx`; the
 * source pins left here are the listing guard and the unknown-section
 * hand-off (not in P4-8f's list) and the dev-fixture branch (not renderable
 * under the test loader).
 *
 * What this cannot reach: the live canvas (the Panel's placement, the
 * notice's stacking, a real listing) — the P4-7d live check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CodeMapEdge, CodeMapNode, EntryCandidate, FoldedType } from '@driller/ipc-contracts';

import {
  CandidateReasonLine,
  canvasGridSize,
  canvasPopulation,
  CodeMapNodeCard,
  foldedCanvasElements,
  layoutNodes,
  layoutPosition,
  RevealListingNotice,
  RevealViewToggle,
  type FetchState,
  type NodeAdjacency,
} from './CodeMap';
import {
  candidatesById,
  initialRevealState,
  layeredLayout,
  revealedPopulation,
  revealNoticeFor,
  revealKey,
  revealStateOf,
  type RevealState,
} from './revealView';
import { renderTree, textOf, type RenderedElement } from './testRender';

const codeMapSrc = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

function node(id: string): CodeMapNode {
  return {
    id,
    name: id.slice(id.lastIndexOf(':') + 1),
    file: 'fixtures/path-trace-basic/entry.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Does a thing.',
    riskSignals: [],
  };
}

/** P4-7e: a state from P4-7d's `{candidates, revealed}` shape — each revealed id becomes a `node` entry (reach 0 unless a candidate). */
function stateFrom(input: {
  candidates: EntryCandidate[];
  revealed: ReadonlyMap<string, { depth: number; parentId: string | null }>;
}): RevealState {
  return revealStateOf(
    input.candidates,
    [...input.revealed].map(([id, entry]) => ({ kind: 'node' as const, id, depth: entry.depth, parentId: entry.parentId, reach: 0 })),
  );
}

const edge = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });

// The `path-trace-basic` graph (P4-7b): handleRequest→serviceA,serviceB→repository↔cacheLookup; helper×2.
const IDS = ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup', 'helperOne', 'helperTwo'];
const NODES = IDS.map(node);
const EDGES = [
  edge('handleRequest', 'serviceA'),
  edge('handleRequest', 'serviceB'),
  edge('serviceA', 'repository'),
  edge('serviceB', 'repository'),
  edge('repository', 'cacheLookup'),
  edge('cacheLookup', 'repository'),
];
const HANDLE_REQUEST: EntryCandidate = {
  id: 'handleRequest',
  name: 'handleRequest',
  file: 'fixtures/path-trace-basic/entry.ts',
  startLine: 1,
  endLine: 9,
  reach: 4,
  reason: { kind: 'no-callers' },
};

const FETCH: FetchState = {
  status: 'ready',
  nodes: NODES,
  edges: EDGES,
  hiddenByScope: 0,
  appliedScope: [],
  foldedTypes: [],
};

const TYPE: FoldedType = {
  id: 'types.ts::Request',
  name: 'Request',
  kind: 'Interface',
  file: 'types.ts',
  startLine: 1,
  endLine: 4,
  usedBy: [{ id: 'handleRequest', name: 'handleRequest', kind: 'Function' }],
  usedByTotal: 1,
  usedByKinds: [{ kind: 'Function', count: 1 }],
  implements: [],
  implementedBy: [],
  refersTo: [],
  referencedByTypes: [],
} as unknown as FoldedType;

const noop = () => {};
const adjacency: NodeAdjacency = new Map();
const changed = new Set<string>();
const dependents = new Map<string, readonly string[]>();

/** `layoutNodes` as the Full branch of the `flowNodes` memo calls it (14 arguments, no `positionOf`). */
function fullLayout(population: ReturnType<typeof canvasPopulation>) {
  return layoutNodes(
    population.riskNodes,
    noop,
    noop,
    noop,
    adjacency,
    false,
    false,
    true,
    true,
    true,
    changed,
    population.foldedNodes,
    noop,
    dependents,
  );
}

const lodInput = (flowNodes: ReturnType<typeof fullLayout>) =>
  flowNodes.map((flowNode) => ({ id: flowNode.id, position: flowNode.position }));

describe('Full map is byte-identical (positionOf omitted)', () => {
  for (const showFolded of [false, true]) {
    it(`layoutNodes with and without an explicit undefined positionOf deep-equal today's grid (folded ${showFolded ? 'on' : 'off'})`, () => {
      const folded = showFolded ? foldedCanvasElements(NODES, [TYPE], []) : { nodes: [], edges: [] };
      const population = canvasPopulation(FETCH, folded, showFolded);
      const omitted = fullLayout(population);
      const explicit = layoutNodes(
        population.riskNodes,
        noop,
        noop,
        noop,
        adjacency,
        false,
        false,
        true,
        true,
        true,
        changed,
        population.foldedNodes,
        noop,
        dependents,
        undefined,
        undefined,
      );
      assert.deepEqual(explicit, omitted);
      // Today's grid, independently: every card at `layoutPosition(index, gridSize)`.
      const gridSize = canvasGridSize(population.riskNodes.length, population.foldedNodes.length);
      assert.deepEqual(
        lodInput(omitted),
        [...population.riskNodes, ...population.foldedNodes].map((card, index) => ({
          id: card.id,
          position: layoutPosition(index, gridSize),
        })),
      );
      // No card carries Revealed's candidate data in Full.
      assert.ok(omitted.every((flowNode) => !('candidate' in flowNode.data)));
    });
  }
});

// Review round 1: the frozen Full-map output of HEAD (46ecf2f, before P4-7d).
// `CodeMap.layoutNodes.head-46ecf2f.snapshot.json` was generated on a
// `git archive HEAD` checkout (with `layoutNodes` exported there only) from
// exactly this fixture and these arguments, functions serialized as
// `fn:<key>`. Do not regenerate it from the current code.
const SNAPSHOT_FIXTURE = {
  nodes: ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup', 'helperOne', 'helperTwo', 'render', 'format', 'parse'].map((id, index) => ({
    id: `src/${id}.ts::${id}`,
    name: id,
    file: `src/${id}.ts`,
    startLine: index + 1,
    endLine: index + 9,
    kind: 'Function',
    summaryStatus: index % 3 === 0 ? 'ready' : 'pending',
    ...(index % 3 === 0 ? { summary: `Does ${id}.` } : {}),
    riskSignals: [],
  })),
  edges: [
    ['handleRequest', 'serviceA'],
    ['handleRequest', 'serviceB'],
    ['serviceA', 'repository'],
    ['serviceB', 'repository'],
    ['repository', 'cacheLookup'],
    ['cacheLookup', 'repository'],
    ['render', 'format'],
  ].map(([source, target]) => ({ source: `src/${source}.ts::${source}`, target: `src/${target}.ts::${target}`, kind: 'CALLS' })),
  type: {
    id: 'src/types.ts::Request',
    name: 'Request',
    kind: 'Interface',
    file: 'src/types.ts',
    startLine: 1,
    endLine: 4,
    usedBy: [{ id: 'src/handleRequest.ts::handleRequest', name: 'handleRequest', kind: 'Function' }],
    usedByTotal: 1,
    usedByKinds: [{ kind: 'Function', count: 1 }],
    implements: [],
    implementedBy: [],
    refersTo: [],
    referencedByTypes: [],
  },
  adjacency: [
    ['src/handleRequest.ts::handleRequest', [], ['src/serviceA.ts::serviceA', 'src/serviceB.ts::serviceB']],
    ['src/repository.ts::repository', ['src/serviceA.ts::serviceA', 'src/serviceB.ts::serviceB', 'src/cacheLookup.ts::cacheLookup'], ['src/cacheLookup.ts::cacheLookup']],
  ] as [string, string[], string[]][],
  changed: ['src/serviceB.ts::serviceB', 'src/types.ts::Request'],
  dependents: [['src/handleRequest.ts::handleRequest', ['Request']]] as [string, readonly string[]][],
};

const HEAD_SNAPSHOT = JSON.parse(
  readFileSync(fileURLToPath(new URL('./CodeMap.layoutNodes.head-46ecf2f.snapshot.json', import.meta.url)), 'utf8'),
) as Record<'plain' | 'folded', unknown>;

describe('Full map equals the frozen HEAD output (review round 1)', () => {
  const { nodes, edges, type } = SNAPSHOT_FIXTURE as unknown as { nodes: CodeMapNode[]; edges: CodeMapEdge[]; type: FoldedType };
  const fetch = { status: 'ready', nodes, edges, hiddenByScope: 0, appliedScope: [], foldedTypes: [type] } as unknown as FetchState;
  for (const showFolded of [false, true]) {
    it(`layoutNodes with no extras is byte-identical to HEAD (folded ${showFolded ? 'on' : 'off'})`, () => {
      const population = canvasPopulation(fetch, showFolded ? foldedCanvasElements(nodes, [type], []) : { nodes: [], edges: [] }, showFolded);
      const adjacency: NodeAdjacency = new Map(
        SNAPSHOT_FIXTURE.adjacency.map(([id, callers, callees]) => [id, { callers, callees }]),
      );
      const cards = layoutNodes(
        population.riskNodes, noop, noop, noop, adjacency, false, true, true, false, true,
        new Set(SNAPSHOT_FIXTURE.changed), population.foldedNodes, noop, new Map(SNAPSHOT_FIXTURE.dependents),
      );
      const serialized = JSON.parse(JSON.stringify(cards, (key, value) => (typeof value === 'function' ? `fn:${key}` : value)));
      assert.deepEqual(serialized, HEAD_SNAPSHOT[showFolded ? 'folded' : 'plain']);
    });
  }
});

describe('Revealed lays out exactly the revealed ids', () => {
  it('path-trace-basic: one candidate card in column 0; lodInputNodes = the revealed ids at layeredLayout positions', () => {
    const state = initialRevealState({ status: 'found', candidates: [HANDLE_REQUEST], totalQualifying: 1, relations: [] });
    const population = canvasPopulation(FETCH, foldedCanvasElements(NODES, [TYPE], []), true);
    const drawn = revealedPopulation(population, state);
    const positions = layeredLayout(state);
    const flowNodes = layoutNodes(
      drawn.mapNodes,
      noop,
      noop,
      noop,
      adjacency,
      false,
      false,
      true,
      true,
      true,
      changed,
      drawn.foldedNodes,
      noop,
      dependents,
      (id, index) => positions.get(id) ?? layoutPosition(index, 1),
      candidatesById(state),
    );
    assert.deepEqual(lodInput(flowNodes), [{ id: 'handleRequest', position: { x: 0, y: 0 } }]);
    assert.deepEqual(drawn.canvasEdges, []);
    const card = flowNodes[0];
    assert.ok(card !== undefined && card.type === 'codeMapNode');
    assert.equal(card.data.candidate, HANDLE_REQUEST);
    // Every number still reads the full map.
    assert.equal(drawn.riskNodes, population.riskNodes);
    assert.equal(drawn.riskEdges, population.riskEdges);
  });

  it('a deeper reveal draws its edges and positions by column', () => {
    const state: RevealState = stateFrom({
      candidates: [HANDLE_REQUEST],
      revealed: new Map([
        ['handleRequest', { depth: 0, parentId: null }],
        ['serviceB', { depth: 1, parentId: 'handleRequest' }],
        ['serviceA', { depth: 1, parentId: 'handleRequest' }],
      ]),
    });
    const drawn = revealedPopulation(canvasPopulation(FETCH, { nodes: [], edges: [] }, false), state);
    const positions = layeredLayout(state);
    const flowNodes = layoutNodes(
      drawn.mapNodes,
      noop,
      noop,
      noop,
      adjacency,
      false,
      false,
      true,
      true,
      true,
      changed,
      drawn.foldedNodes,
      noop,
      dependents,
      (id, index) => positions.get(id) ?? layoutPosition(index, 1),
    );
    assert.deepEqual(new Map(lodInput(flowNodes).map((entry) => [entry.id, entry.position])), positions);
    assert.deepEqual(drawn.canvasEdges, [edge('handleRequest', 'serviceA'), edge('handleRequest', 'serviceB')]);
  });
});

function hostElements(root: unknown): RenderedElement[] {
  return renderTree(root).filter((element) => typeof element.type === 'string');
}

describe('the candidate card', () => {
  const data = {
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
  };

  it('shows "◎ candidate · no callers in indexed code · reaches 4 Nodes" and says so in its accessible name', () => {
    const root = CodeMapNodeCard({ data: { ...data, candidate: HANDLE_REQUEST } }) as unknown as RenderedElement;
    assert.equal(root.props['aria-label'], 'Function handleRequest, entry candidate, reaches 4 Nodes, open Node detail');
    const line = hostElements(root).find((element) => element.props.className === 'code-map__node-candidate');
    assert.ok(line);
    assert.equal(squash(textOf(line)), '◎ candidate · no callers in indexed code · reaches 4 Nodes');
    // The glyph is decoration; the text "candidate" carries the meaning.
    const glyph = hostElements(line).find((element) => textOf(element) === '◎');
    assert.equal(glyph?.props['aria-hidden'], 'true');
  });

  it('a non-candidate card is unchanged', () => {
    const root = CodeMapNodeCard({ data }) as unknown as RenderedElement;
    assert.equal(root.props['aria-label'], 'Function handleRequest, open Node detail');
    assert.equal(
      hostElements(root).some((element) => element.props.className === 'code-map__node-candidate'),
      false,
    );
  });

  it('names the files that run it at load, in code', () => {
    const loaded: EntryCandidate = {
      ...HANDLE_REQUEST,
      reason: { kind: 'no-callers', loadedBy: ['main/index.ts', 'main/menu.ts'], loadedByTotal: 4 },
    };
    const line = CandidateReasonLine({ candidate: loaded });
    assert.equal(
      squash(textOf(line)),
      '◎ candidate · no callers in indexed code · reaches 4 Nodes · run at load by main/index.ts, main/menu.ts and 2 more',
    );
    assert.deepEqual(
      hostElements(line)
        .filter((element) => element.type === 'code')
        .map((element) => textOf(element)),
      ['main/index.ts', 'main/menu.ts'],
    );
  });
});

describe('the toggle', () => {
  it('two buttons, the active one aria-pressed; each calls onChange with its view', () => {
    const calls: string[] = [];
    const root = RevealViewToggle({ view: 'full', onChange: (view) => calls.push(view) });
    const buttons = hostElements(root).filter((element) => element.type === 'button');
    assert.deepEqual(
      buttons.map((button) => [textOf(button), button.props['aria-pressed']]),
      [
        ['Revealed', false],
        ['Full map', true],
      ],
    );
    for (const button of buttons) {
      (button.props.onClick as () => void)();
    }
    assert.deepEqual(calls, ['revealed', 'full']);
  });
});

describe('the none/error/stale notice', () => {
  const key = revealKey('/repo', null);
  const stamp: CodeMapEdge[] = [];
  const buttonsOf = (root: unknown) => hostElements(root).filter((element) => element.type === 'button');
  const ready = {
    key,
    mapStamp: stamp,
    listing: {
      status: 'ready' as const,
      state: initialRevealState({ status: 'found', candidates: [HANDLE_REQUEST], totalQualifying: 1, relations: [] }),
      totalQualifying: 1,
    },
  };
  const cases = [
    ['none', revealNoticeFor({ key, mapStamp: stamp, listing: { status: 'none' } }, key, 0), /No entry candidates found in indexed code \(every Node has a caller, or reaches fewer than 3 Nodes\)\./],
    ['error', revealNoticeFor({ key, mapStamp: stamp, listing: { status: 'error', message: 'boom' } }, key, 0), /Couldn’t list entry candidates: boom/],
    ['stale', revealNoticeFor(ready, key, 0), /Couldn’t show the entry candidates: none of them is on the map on screen\./],
  ] as const;

  for (const [kind, notice, sentence] of cases) {
    it(`${kind}: its sentence and one action, "Show full map", which flips the toggle; no live-region role`, () => {
      let shown = 0;
      const root = RevealListingNotice({ notice, onShowFullMap: () => (shown += 1) });
      assert.ok(root !== null);
      assert.match(squash(textOf(root)), sentence);
      assert.deepEqual(buttonsOf(root).map((button) => textOf(button)), ['Show full map']);
      (buttonsOf(root)[0]?.props.onClick as () => void)();
      assert.equal(shown, 1);
      assert.equal((root as unknown as RenderedElement).props.role, undefined);
    });
  }

  it('ready or loading: no notice', () => {
    assert.equal(RevealListingNotice({ notice: null, onShowFullMap: noop }), null);
    assert.equal(RevealListingNotice({ notice: { kind: 'loading', text: '…' }, onShowFullMap: noop }), null);
  });
});

describe('CodeMap source: the listing fetch and its guard', () => {
  const start = codeMapSrc.indexOf('// P4-7d: the entry-candidate listing for the map on screen');
  const body = codeMapSrc.slice(start, codeMapSrc.indexOf('// P4-7d: a navigation to a Node Revealed', start));

  it('drops out-of-order replies: the latest-request guard and the section on screen', () => {
    assert.match(body, /const requestId = revealListingRequests\.begin\(\);/);
    assert.match(body, /isLatest: revealListingRequests\.isLatest\(requestId\),\s*requestedSection,\s*currentSection: sectionRef\.current,/);
    assert.match(body, /if \(outcome\.kind === 'ignore'\) \{\s*return;/);
  });

  it('hands an unknown-section reply to the section fallback', () => {
    assert.match(body, /onUnknownSectionRef\.current\?\.\(outcome\.section\);/);
  });

  // P4-8f: kept from the listing-fetch pin, which `CodeMap.revealed.dom.test.tsx`
  // otherwise replaces. A dev-fixture session can't be rendered under the test
  // loader (`import.meta.env.DEV` is compiled to `false`, so
  // `readFixtureNodeCount` never reads `?fixtureNodes=`).
  it('a dev-fixture session has no Graph Service map: an explicit error, never a listing of another map', () => {
    assert.ok(start >= 0);
    assert.match(body, /if \(isDevFixtureMode\) \{\s*\/\/[^\n]*\n\s*settle\(\{ status: 'error', message: DEV_FIXTURE_NO_ENTRY_CANDIDATES \}\);\s*return;/);
  });
});

