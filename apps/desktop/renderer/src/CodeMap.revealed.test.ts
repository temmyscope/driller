/**
 * P4-7d: the Revealed start view in `CodeMap` — Full map stays byte-identical
 * (`layoutNodes` with and without `positionOf`), Revealed lays out exactly the
 * revealed ids at `layeredLayout`'s positions, the candidate card, the
 * toggle, the none/error notice, and the hook wiring (source pins: the
 * component's hooks can't run under `node --test`).
 *
 * What this cannot reach: the live canvas (fits, the Panel's placement, the
 * notice over the canvas, a real listing) — the P4-7d live check.
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

  it('the flowNodes memo takes today’s exact call when revealCanvas is null', () => {
    const start = codeMapSrc.indexOf('const flowNodes = useMemo(');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('const flowEdges = useMemo(', start));
    assert.match(
      body,
      /revealCanvas === null\s*\? layoutNodes\(\s*population\.riskNodes,\s*activateNode,\s*showNeighbors,\s*openSourceForNode,\s*adjacency,\s*noSummaryBackendAvailable,\s*cloudSelectedNoKey,\s*showDeterministicSignals,\s*showLlmJudgment,\s*showIngestedFindings,\s*renderChangedIds,\s*population\.foldedNodes,\s*activateFoldedNode,\s*contractDependentsById,\s*\)\s*:/,
    );
    assert.match(
      codeMapSrc,
      /toFlowEdges\(\(revealCanvas === null \? population : revealCanvas\.population\)\.canvasEdges\)/,
    );
    assert.match(
      codeMapSrc,
      /const lodInputNodes = useMemo<LODInputNode\[\]>\(\s*\(\) => flowNodes\.map\(\(flowNode\) => \(\{ id: flowNode\.id, position: flowNode\.position \}\)\),\s*\[flowNodes\],/,
    );
  });

  it('revealCanvas is null outside Revealed in Code Map mode (default Full; PR Review renders Full)', () => {
    assert.match(codeMapSrc, /const \[revealView, setRevealView\] = useState<RevealViewMode>\('full'\);/);
    assert.match(codeMapSrc, /const revealDrawn = revealView === 'revealed' && mode === 'codeMap';/);
    assert.match(codeMapSrc, /const revealCanvas = useMemo\(\(\) => \{\s*if \(!revealDrawn \|\| fetchState\.status !== 'ready'\) \{\s*return null;/);
  });
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
    const state = initialRevealState({ status: 'found', candidates: [HANDLE_REQUEST], totalQualifying: 1 });
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
    const state: RevealState = {
      candidates: [HANDLE_REQUEST],
      revealed: new Map([
        ['handleRequest', { depth: 0, parentId: null }],
        ['serviceB', { depth: 1, parentId: 'handleRequest' }],
        ['serviceA', { depth: 1, parentId: 'handleRequest' }],
      ]),
    };
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

  it('the Revealed branch passes the drawn population, positionOf and candidates', () => {
    assert.match(
      codeMapSrc,
      /: layoutNodes\(\s*revealCanvas\.population\.mapNodes,[\s\S]*?revealCanvas\.population\.foldedNodes,\s*activateFoldedNode,\s*contractDependentsById,\s*revealCanvas\.positionOf,\s*revealCanvas\.candidates,\s*\)/,
    );
    // Numbers keep reading the full map.
    assert.match(codeMapSrc, /const callEdges = useMemo\(\(\) => callEdgesOf\(population\.riskEdges\), \[population\]\);/);
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

  it('is in the canvas Panel only in Code Map mode, with an always-mounted status line', () => {
    assert.match(
      codeMapSrc,
      /\{mode === 'codeMap' && \(\s*<>\s*<RevealViewToggle view=\{revealView\} onChange=\{changeRevealView\} \/>\s*<p className="code-map__reveal-status" role="status">\s*\{revealStatus\}/,
    );
    assert.match(
      codeMapSrc,
      /const revealStatus = revealStatusText\(\{\s*switchStatus: revealSwitchStatus,\s*notice: revealNotice,\s*capText: revealDrawn \? revealCapText\(revealHeld, currentRevealKey\) : null,\s*\}\);/,
    );
    // The only role="status" for Revealed: the notices carry none.
    assert.equal(codeMapSrc.match(/className="code-map__reveal-status" role="status"/g)?.length, 1);
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
      state: initialRevealState({ status: 'found', candidates: [HANDLE_REQUEST], totalQualifying: 1 }),
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

  it('is rendered over the canvas whenever Revealed has a canvas notice, counting the cards actually drawn', () => {
    assert.match(
      codeMapSrc,
      /\{surfaces\.canvas && revealDrawn && isCanvasRevealNotice\(revealNotice\) && \(\s*<div className="code-map__notice code-map__notice--reveal">\s*<RevealListingNotice\s*notice=\{revealNotice\}\s*onShowFullMap=\{\(\) => changeRevealView\('full'\)\}\s*\/>/,
    );
    assert.match(codeMapSrc, /revealNoticeFor\(revealHeld, currentRevealKey, revealCanvas\?\.population\.mapNodes\.length \?\? 0\)/);
    // One action only (EXPERIENCE.md): no Retry in the Revealed notice.
    const notice = codeMapSrc.slice(
      codeMapSrc.indexOf('export function RevealListingNotice('),
      codeMapSrc.indexOf('export function CodeMapNodeCard('),
    );
    assert.equal(notice.match(/<button /g)?.length, 1);
  });
});

describe('CodeMap source: review round 1 wiring', () => {
  it('only an explicit toggle asks for a view, and resets cluster expansions', () => {
    const start = codeMapSrc.indexOf('const changeRevealView = useCallback((next: RevealViewMode) => {');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('}, []);', start));
    assert.match(body, /revealViewRequestForToggle\(\{\s*from: revealViewRef\.current,\s*to: next,/);
    assert.match(body, /revealViewRequestRef\.current = request;\s*fullViewportRef\.current = saved;/);
    assert.match(body, /setExpandedClusterIds\(new Set\(\)\);/);
    // Nothing else writes a view request except a refresh's re-fit and the reload's drop.
    assert.equal(codeMapSrc.match(/revealViewRequestRef\.current = /g)?.length, 5); // toggle, reload drop, refresh re-fit, apply's drop and done
    assert.match(codeMapSrc, /revealViewRequestRef\.current = \{ target: 'revealed', key, mapStamp \};/);
    assert.match(codeMapSrc, /\/\/ Review round 1: an owed view can't apply to another project or section\.\s*revealViewRequestRef\.current = null;/);
  });

  it('the apply effect goes through decideRevealView and bumps routeFitSeqRef', () => {
    const start = codeMapSrc.indexOf('const decision = decideRevealView({');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('}, [mode, revealDrawn, revealHeld, currentRevealKey', start));
    assert.ok(start >= 0);
    assert.match(body, /codeMapMode: mode === 'codeMap',/);
    assert.match(body, /if \(decision\.kind === 'drop'\) \{\s*revealViewRequestRef\.current = null;/);
    assert.match(body, /routeFitSeqRef\.current \+= 1;\s*void instance\.setViewport\(next\);/);
  });

  it('a refresh re-fits only through revealRefitOnListing; a user gesture marks the view moved', () => {
    assert.match(codeMapSrc, /revealRefitOnListing\(\{\s*revealDrawn: revealDrawnRef\.current,\s*hadPrevious: started\.listing\.status === 'loading' && started\.listing\.previous !== null,\s*userMoved: revealUserMovedRef\.current,/);
    assert.match(codeMapSrc, /if \(event\) \{\s*clearRouteClamp\(\);\s*\/\/[^\n]*\n\s*revealUserMovedRef\.current = true;/);
  });

  it('the first fit stops holding the canvas hidden when Revealed has nothing to draw', () => {
    assert.match(codeMapSrc, /if \(initialFitRetry >= INITIAL_FIT_MAX_RETRIES \|\| revealEndsFirstFitWait\(revealDrawn, lodInputNodes\.length\)\) \{\s*\/\/[^\n]*\n[^\n]*\n\s*setAwaitingFirstFit\(false\);/);
  });

  it('the switch status clears on the next navigation (not the replay), a mode change, or after a timeout', () => {
    assert.match(codeMapSrc, /if \(!replayingFullNavigationRef\.current\) \{\s*setRevealSwitchStatus\(null\);/);
    assert.match(codeMapSrc, /replayingFullNavigationRef\.current = true;\s*try \{/);
    assert.match(codeMapSrc, /const timer = setTimeout\(\(\) => setRevealSwitchStatus\(null\), REVEAL_SWITCH_STATUS_MS\);\s*return \(\) => clearTimeout\(timer\);/);
    assert.match(codeMapSrc, /if \(revealStatusModeRef\.current !== mode\) \{\s*revealStatusModeRef\.current = mode;\s*setRevealSwitchStatus\(null\);/);
  });
});

describe('CodeMap source: the listing fetch and its guard', () => {
  const start = codeMapSrc.indexOf('// P4-7d: the entry-candidate listing for the map on screen');
  const body = codeMapSrc.slice(start, codeMapSrc.indexOf('// P4-7d: a navigation to a Node Revealed', start));

  it('fetches with the section of the map on screen, once per map fetch', () => {
    assert.ok(start >= 0);
    assert.match(body, /if \(!needsRevealListing\(revealHeldRef\.current, currentRevealKey, revealMapStamp\)\) \{\s*return;/);
    assert.match(body, /window\.driller\.listEntryCandidates\(projectPath, requestedSection \?\? undefined\)/);
    assert.match(codeMapSrc, /const revealMapStamp = fetchState\.status === 'ready' \? fetchState\.edges : null;/);
    assert.match(body, /\}, \[revealDrawn, projectPath, revealMapStamp, revealSection, currentRevealKey, revealListingRequests, isDevFixtureMode\]\);/);
    // A dev-fixture session has no Graph Service map: an explicit error, never a listing of another map.
    assert.match(body, /if \(isDevFixtureMode\) \{\s*\/\/[^\n]*\n\s*settle\(\{ status: 'error', message: DEV_FIXTURE_NO_ENTRY_CANDIDATES \}\);\s*return;/);
  });

  it('drops out-of-order replies: the latest-request guard and the section on screen', () => {
    assert.match(body, /const requestId = revealListingRequests\.begin\(\);/);
    assert.match(body, /isLatest: revealListingRequests\.isLatest\(requestId\),\s*requestedSection,\s*currentSection: sectionRef\.current,/);
    assert.match(body, /if \(outcome\.kind === 'ignore'\) \{\s*return;/);
  });

  it('hands an unknown-section reply to the section fallback', () => {
    assert.match(body, /onUnknownSectionRef\.current\?\.\(outcome\.section\);/);
  });

  it('a reload or section switch drops the held state and invalidates a listing in flight', () => {
    const load = codeMapSrc.slice(
      codeMapSrc.indexOf('const loadCodeMap = useCallback(() => {'),
      codeMapSrc.indexOf('}, [fixtureNodeCount, clearDiffScopeSync]);'),
    );
    assert.match(load, /setRevealHeld\(null\);\s*revealHeldRef\.current = null;\s*revealListingRequests\.begin\(\);/);
  });

  it('a project change resets the toggle to Full', () => {
    const effectEnd = codeMapSrc.indexOf("    setRevealView('full');\n  }, [projectPath, clearDiffScopeSync]);");
    assert.ok(effectEnd >= 0);
  });
});

describe('CodeMap source: navigating to a hidden Node switches to Full', () => {
  it('every navigation entry routes through the full-map switch first', () => {
    assert.match(
      codeMapSrc,
      /const navigateToNodeImpl = useCallback\(\s*\(id: string\) => \{\s*if \(routeThroughFullMapRef\.current\(\[id\], \{ kind: 'navigate', id \}\)\) \{\s*return;/,
    );
    assert.equal(
      codeMapSrc.match(/if \(routeThroughFullMapRef\.current\(\[id\], \{ kind: 'history', id, index: nextIndex \}\)\) \{\s*return;/g)
        ?.length,
      2,
    );
    assert.match(
      codeMapSrc,
      /\(path: string\[\]\) => \{\s*\/\/ P4-7d: [^\n]*\n\s*if \(routeThroughFullMapRef\.current\(path, \{ kind: 'fit', ids: path \}\)\) \{\s*return;/,
    );
  });

  it('the switch keeps the reveal state, says so in the status line, and replays the navigation on Full', () => {
    const start = codeMapSrc.indexOf('routeThroughFullMapRef.current = (ids, action) => {');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('\n  };\n', start));
    assert.match(body, /if \(!revealDrawn \|\| fetchState\.status !== 'ready'\) \{[\s\S]*?return false;\s*\}/);
    assert.match(
      body,
      /pendingFullNavigationRef\.current = action;\s*setRevealSwitchStatus\(revealSwitchMessage\(target\.name\)\);\s*setExpandedClusterIds\(new Set\(\)\);\s*setRevealView\('full'\);/,
    );
    assert.doesNotMatch(body, /setRevealHeld/);
    assert.match(codeMapSrc, /case 'navigate':\s*navigateToNodeImplRef\.current\(pending\.id\);/);
    assert.match(codeMapSrc, /case 'fit':\s*fitViewToPath\(\[\.\.\.pending\.ids\]\);/);
  });

  it('a cross-section focus target Revealed doesn’t draw still resolves (then switches)', () => {
    assert.match(codeMapSrc, /resolveMapNode: \(id\) => mapNodeOf\(flowNodesById\.get\(id\)\) \?\? revealHiddenMapNode\(id\),/);
    assert.match(
      codeMapSrc,
      /const revealHiddenMapNode = \(id: string\): CodeMapNode \| undefined =>\s*revealDrawn && fetchState\.status === 'ready' \? fetchState\.nodes\.find\(\(node\) => node\.id === id\) : undefined;/,
    );
  });
});
