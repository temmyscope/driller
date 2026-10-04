/**
 * P4-4 phase 3b: cross-section honesty in the UI — PR Review's "changed
 * elsewhere" line, Node detail's "Calls into other sections" and its
 * switch-and-select, and the plumbing that carries P4-4g's counts to the
 * footer line (its formatter is pinned in `appFrame.test.ts`).
 *
 * The pure helpers and hookless components are rendered by calling them and
 * walking the returned elements (`./testRender`; the runner is `node --test`
 * with no DOM). The hook wiring in `CodeMap.tsx` and `App.tsx` is pinned on
 * the source, like `CodeMap.sectionBar.test.ts`.
 *
 * What this cannot reach: the card actually receiving DOM focus after the
 * switch, a screen reader announcing the footer line, and the layout — the
 * P4-4h live check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CodeMapNode, CrossSectionCall, DiffScopeResult, SectionChangeCount } from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS, CROSS_SECTION_CALLS_MAX } from '@driller/ipc-contracts';

import { SECTION_SWITCH_UNAVAILABLE_HINT } from './SectionBar';
import {
  CHANGED_ELSEWHERE_HINT_ID,
  CROSS_SECTION_CALLS_HINT_ID,
  CARD_FOCUS_MAX_FRAMES,
  CROSS_SECTION_MISS_DISMISS_ID,
  CROSS_SECTION_MISS_TEXT_ID,
  ChangedElsewhereLine,
  CrossSectionMissNotice,
  cardFocusStep,
  diffScopeCarryAnnouncement,
  diffScopeCarryCandidate,
  diffScopeCarryDecision,
  diffScopeCarryReplyApplies,
  applyDiffScopeCarryReply,
  diffScopeCarryCheckingText,
  diffScopeCarrySettleAction,
  prReviewSwitchFocusTarget,
  NODE_DETAIL_SECTION_HEADING_IDS,
  NOT_ON_CURRENT_MAP,
  NodeDetailBody,
  changedElsewhereAnnouncement,
  changedElsewhereLine,
  crossSectionCallsCount,
  crossSectionCallsMore,
  decidePendingFocus,
  diffScopeStateFromResult,
  resolvePrReviewView,
  switchSectionFromDetail,
  type BlastRadiusState,
  type FetchState,
  type NodeDetailBodyProps,
} from './CodeMap';
import { mapFooterState } from './appFrame';
import { resolveRefreshOutcome } from './sessionView';
import { renderTree, textOf, type RenderedElement } from './testRender';

const codeMapSrc = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');
const appSrc = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

const IDLE_BLAST_RADIUS: BlastRadiusState = { status: 'idle' };

function mapNode(id: string, extra: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id,
    name: id.split('#')[1] ?? id,
    file: id.split('#')[0] ?? id,
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Does a thing.',
    riskSignals: [],
    ...extra,
  } as CodeMapNode;
}

function ready(section: string | null, nodes: CodeMapNode[] = [mapNode('api/a.ts#a')]): FetchState {
  return {
    status: 'ready',
    nodes,
    edges: [],
    hiddenByScope: 0,
    appliedScope: ['api', 'web'],
    foldedTypes: [],
    section,
  };
}

function calls(count: number): CrossSectionCall[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `web/r${index}.ts#render${index}`,
    name: `render${index}`,
    section: 'web',
  }));
}

function buttons(elements: RenderedElement[]): RenderedElement[] {
  return elements.filter((element) => element.type === 'button');
}

// ---------------------------------------------------------------------------
// PR Review: "changed elsewhere"
// ---------------------------------------------------------------------------

describe('changedElsewhereLine', () => {
  it('says "api/: 3 changed Nodes" (section first), every count the field\'s own', () => {
    assert.deepEqual(changedElsewhereLine([{ section: 'api', changedNodes: 3, changedContracts: 0, topLevelFiles: 0 }]), [
      { section: 'api', counts: '3 changed Nodes', text: 'api/: 3 changed Nodes' },
    ]);
  });

  it('is singular for 1 and plural otherwise', () => {
    assert.equal(
      changedElsewhereLine([{ section: 'api', changedNodes: 1, changedContracts: 1, topLevelFiles: 1 }])?.[0]?.text,
      'api/: 1 changed Node · 1 contract changed · top-level code changed in 1 file',
    );
    assert.equal(
      changedElsewhereLine([{ section: 'api', changedNodes: 2, changedContracts: 2, topLevelFiles: 2 }])?.[0]?.text,
      'api/: 2 changed Nodes · 2 contracts changed · top-level code changed in 2 files',
    );
  });

  it('covers changed contracts and top-level-only files, leaving a 0 count out', () => {
    assert.deepEqual(
      changedElsewhereLine([
        { section: 'docs', changedNodes: 0, changedContracts: 2, topLevelFiles: 0 },
        { section: 'web', changedNodes: 0, changedContracts: 0, topLevelFiles: 1_204 },
      ])?.map((entry) => entry.text),
      ['docs/: 2 contracts changed', 'web/: top-level code changed in 1,204 files'],
    );
  });

  it('is null for an absent or empty field, and drops an all-zero entry', () => {
    assert.equal(changedElsewhereLine(undefined), null);
    assert.equal(changedElsewhereLine([]), null);
    assert.equal(changedElsewhereLine([{ section: 'api', changedNodes: 0, changedContracts: 0, topLevelFiles: 0 }]), null);
  });
});

describe('ChangedElsewhereLine', () => {
  const API: SectionChangeCount[] = [{ section: 'api', changedNodes: 3, changedContracts: 0, topLevelFiles: 0 }];

  it('renders "api/: 3 changed Nodes — Switch to api", whose button switches with no Node to select', () => {
    const switched: unknown[][] = [];
    const tree = ChangedElsewhereLine({
      changedInOtherSections: API,
      onSwitchSection: (...args: unknown[]) => switched.push(args),
      graphServiceAvailable: true,
    });
    assert.equal(textOf(tree), 'api/: 3 changed Nodes — Switch to api');
    const [button] = buttons(renderTree(tree));
    assert.ok(button);
    assert.equal(button.props.disabled, undefined);
    assert.equal(button.props['aria-disabled'], undefined);
    (button.props.onClick as () => void)();
    assert.deepEqual(switched, [['api']]);
  });

  it('is informational — no Actionable Notice icon', () => {
    const elements = renderTree(
      ChangedElsewhereLine({ changedInOtherSections: API, onSwitchSection: () => {}, graphServiceAvailable: true }),
    );
    assert.equal(
      elements.some((element) => typeof element.type === 'function' && element.type.name === 'ActionableNotice'),
      false,
    );
  });

  it('one button per other section; while not live they are aria-disabled (focusable), hinted, and do nothing', () => {
    const switched: unknown[] = [];
    const elements = renderTree(
      ChangedElsewhereLine({
        changedInOtherSections: [...API, { section: 'docs', changedNodes: 1, changedContracts: 0, topLevelFiles: 0 }],
        onSwitchSection: (section) => switched.push(section),
        graphServiceAvailable: false,
      }),
    );
    const found = buttons(elements);
    assert.deepEqual(found.map(textOf), ['Switch to api', 'Switch to docs']);
    for (const button of found) {
      assert.equal(button.props.disabled, undefined);
      assert.equal(button.props['aria-disabled'], true);
      assert.equal(button.props['aria-describedby'], CHANGED_ELSEWHERE_HINT_ID);
      (button.props.onClick as () => void)();
    }
    assert.deepEqual(switched, []);
    const hint = elements.find((element) => element.props.id === CHANGED_ELSEWHERE_HINT_ID);
    assert.equal(textOf(hint), SECTION_SWITCH_UNAVAILABLE_HINT);
  });

  it('renders nothing for no entries', () => {
    assert.equal(
      ChangedElsewhereLine({ changedInOtherSections: [], onSwitchSection: () => {}, graphServiceAvailable: true }),
      null,
    );
  });

  it('the change count announces it, or says nothing for none', () => {
    assert.equal(changedElsewhereAnnouncement(API), ' Also changed in api/: 3 changed Nodes.');
    assert.equal(
      changedElsewhereAnnouncement([...API, { section: 'docs', changedNodes: 0, changedContracts: 1, topLevelFiles: 0 }]),
      ' Also changed in api/: 3 changed Nodes; in docs/: 1 contract changed.',
    );
    assert.equal(changedElsewhereAnnouncement([]), '');
  });
});

describe('the changed-elsewhere data path', () => {
  const RESULT: DiffScopeResult = {
    status: 'resolved',
    resolvedBaseRef: 'main',
    nodeIds: [],
    changedInOtherSections: [{ section: 'api', changedNodes: 3, changedContracts: 0, topLevelFiles: 0 }],
  };

  it('a resolved diff keeps changedInOtherSections; none when absent', () => {
    const state = diffScopeStateFromResult(RESULT);
    assert.equal(state.status, 'resolved');
    assert.deepEqual(state.status === 'resolved' ? state.changedInOtherSections : null, RESULT.changedInOtherSections);
    const plain = diffScopeStateFromResult({ status: 'resolved', resolvedBaseRef: 'main', nodeIds: [] });
    assert.equal(plain.status === 'resolved' && 'changedInOtherSections' in plain, false);
  });

  it('PR Review in a section shows it; never in all, nor outside PR Review', () => {
    const state = diffScopeStateFromResult(RESULT);
    const view = (mode: 'prReview' | 'codeMap', section: string | null) =>
      resolvePrReviewView(mode, ready(section), state, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).changedInOtherSections;
    assert.deepEqual(view('prReview', 'web'), RESULT.changedInOtherSections);
    assert.deepEqual(view('prReview', null), []);
    assert.deepEqual(view('codeMap', 'web'), []);
    assert.deepEqual(
      resolvePrReviewView('prReview', ready('web'), { status: 'idle' }, IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS)
        .changedInOtherSections,
      [],
    );
  });

  it('is rendered beneath the change count, outside its live region, switching through onSwitchSection', () => {
    const count = codeMapSrc.indexOf('{formatDiffScopeChangeCount(');
    const line = codeMapSrc.indexOf('<ChangedElsewhereLine', count);
    assert.ok(count >= 0 && line > count);
    const closeCount = codeMapSrc.indexOf('</p>', count);
    assert.ok(closeCount < line, 'the line sits after the count paragraph');
    const between = codeMapSrc.slice(count, closeCount);
    assert.match(between, /changedElsewhereAnnouncement\(prReviewChangedInOtherSections\)/);
    const props = codeMapSrc.slice(line, codeMapSrc.indexOf('/>', line));
    assert.match(props, /changedInOtherSections=\{prReviewChangedInOtherSections\}/);
    assert.match(props, /onSwitchSection=\{handleSwitchSectionFromPrReview\}/);
  });
});

// ---------------------------------------------------------------------------
// Node detail: "Calls into other sections"
// ---------------------------------------------------------------------------

function bodyProps(node: CodeMapNode, extra: Partial<NodeDetailBodyProps> = {}): NodeDetailBodyProps {
  return {
    node,
    toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
    cloudSelectedNoKey: false,
    noSummaryBackendAvailable: false,
    summaryAction: null,
    regenerateState: { kind: 'idle' },
    graphServiceAvailable: true,
    onRegenerate: () => {},
    onOpenTest: () => {},
    ...extra,
  };
}

function crossSection(elements: RenderedElement[]): RenderedElement | undefined {
  return elements.find(
    (element) =>
      element.type === 'section' && element.props['aria-labelledby'] === NODE_DETAIL_SECTION_HEADING_IDS.crossSectionCalls,
  );
}

const HANDLE_ORDER = mapNode('api/o.ts#handleOrder', {
  crossSectionCalls: [{ id: 'web/r.ts#render', name: 'render', section: 'web' }],
  crossSectionCallsTotal: 1,
});

describe('NodeDetailBody — Calls into other sections', () => {
  it('lists "render · web/" with "Switch to web", named "Switch to web and show render"', () => {
    const switched: unknown[][] = [];
    const elements = renderTree(
      NodeDetailBody(
        bodyProps(HANDLE_ORDER, { mapSection: 'api', onSwitchSection: (...args: unknown[]) => switched.push(args) }),
      ),
    );
    const section = crossSection(elements);
    assert.ok(section);
    const inside = renderTree(section.props.children);
    const heading = inside.find((element) => element.type === 'h3');
    assert.equal(heading?.props.id, NODE_DETAIL_SECTION_HEADING_IDS.crossSectionCalls);
    assert.equal(textOf(heading), 'Calls into other sections');
    const row = inside.find((element) => element.type === 'li');
    assert.equal(textOf(row), 'render · web/ Switch to web');
    const [button] = buttons(inside);
    assert.equal(button?.props['aria-label'], 'Switch to web and show render');
    (button?.props.onClick as () => void)();
    assert.deepEqual(switched, [['web', 'web/r.ts#render']]);
  });

  it('sits after Similar implementations and before Staleness', () => {
    const ids = renderTree(NodeDetailBody(bodyProps(HANDLE_ORDER, { mapSection: 'api' })))
      .filter((element) => element.type === 'section')
      .map((element) => element.props['aria-labelledby']);
    assert.equal(ids.indexOf(NODE_DETAIL_SECTION_HEADING_IDS.crossSectionCalls) + 1, ids.indexOf(NODE_DETAIL_SECTION_HEADING_IDS.staleness));
  });

  it('is absent in all, and with no cross-section calls', () => {
    assert.equal(crossSection(renderTree(NodeDetailBody(bodyProps(HANDLE_ORDER)))), undefined);
    assert.equal(crossSection(renderTree(NodeDetailBody(bodyProps(HANDLE_ORDER, { mapSection: null })))), undefined);
    assert.equal(crossSection(renderTree(NodeDetailBody(bodyProps(mapNode('api/a.ts#a'), { mapSection: 'api' })))), undefined);
    assert.equal(
      crossSection(
        renderTree(NodeDetailBody(bodyProps(mapNode('api/a.ts#a', { crossSectionCalls: [] }), { mapSection: 'api' }))),
      ),
      undefined,
    );
  });

  it('25 cross calls: the 20 carried as rows, then "+5 more" from crossSectionCallsTotal', () => {
    const node = mapNode('api/h.ts#hub', { crossSectionCalls: calls(CROSS_SECTION_CALLS_MAX), crossSectionCallsTotal: 25 });
    const inside = renderTree(crossSection(renderTree(NodeDetailBody(bodyProps(node, { mapSection: 'api' }))))?.props.children);
    assert.equal(inside.filter((element) => element.type === 'li').length, 20);
    const more = inside.find((element) => element.type === 'p');
    assert.equal(textOf(more), '+5 more');
    assert.equal(crossSectionCallsMore(node), 5);
  });

  it('no "+N more" when every callee is listed; the total never reads below the list', () => {
    const inside = renderTree(crossSection(renderTree(NodeDetailBody(bodyProps(HANDLE_ORDER, { mapSection: 'api' }))))?.props.children);
    assert.equal(inside.some((element) => element.type === 'p'), false);
    assert.equal(crossSectionCallsMore({ crossSectionCalls: calls(3) }), 0);
    assert.equal(crossSectionCallsMore({ crossSectionCalls: calls(3), crossSectionCallsTotal: 2 }), 0);
  });

  it('while not live the switch is aria-disabled (focusable), hinted, and does nothing', () => {
    const switched: unknown[] = [];
    const inside = renderTree(
      crossSection(
        renderTree(
          NodeDetailBody(
            bodyProps(HANDLE_ORDER, {
              mapSection: 'api',
              graphServiceAvailable: false,
              onSwitchSection: (...args: unknown[]) => switched.push(args),
            }),
          ),
        ),
      )?.props.children,
    );
    const [button] = buttons(inside);
    assert.equal(button?.props.disabled, undefined);
    assert.equal(button?.props['aria-disabled'], true);
    assert.equal(button?.props['aria-describedby'], CROSS_SECTION_CALLS_HINT_ID);
    (button?.props.onClick as () => void)();
    assert.deepEqual(switched, []);
    assert.equal(textOf(inside.find((element) => element.props.id === CROSS_SECTION_CALLS_HINT_ID)), SECTION_SWITCH_UNAVAILABLE_HINT);
  });

  it('shows with a total but no listed rows, as "+N more" (review round 1)', () => {
    const node = mapNode('api/h.ts#hub', { crossSectionCallsTotal: 3 });
    const section = crossSection(renderTree(NodeDetailBody(bodyProps(node, { mapSection: 'api' }))));
    assert.ok(section);
    assert.equal(textOf(renderTree(section.props.children).find((element) => element.type === 'p')), '+3 more');
    assert.equal(crossSectionCallsCount(node), 3);
    assert.equal(crossSectionCallsCount({ crossSectionCalls: calls(2), crossSectionCallsTotal: 1 }), 2);
  });
});

describe('switchSectionFromDetail', () => {
  it('closes Node detail, then asks for the switch with the callee to select', () => {
    const calls: string[] = [];
    switchSectionFromDetail('web', 'web/r.ts#render', {
      closeNodeDetail: () => calls.push('close'),
      onSwitchSection: (section, focusNodeId) => calls.push(`switch ${section} ${focusNodeId}`),
    });
    assert.deepEqual(calls, ['close', 'switch web web/r.ts#render']);
  });

  it('CodeMap wires the panel to it, with the map section, and remembers the callee name', () => {
    assert.match(codeMapSrc, /mapSection=\{fetchState\.status === 'ready' \? \(fetchState\.section \?\? null\) : null\}/);
    assert.match(codeMapSrc, /onSwitchSection=\{handleSwitchSectionFromDetail\}/);
    const start = codeMapSrc.indexOf('const handleSwitchSectionFromDetail = useCallback(');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('[closeNodeDetail, onSwitchSection]', start));
    assert.match(body, /crossSectionTargetRef\.current = \{ id: focusNodeId/);
    assert.match(body, /switchSectionFromDetail\(targetSection, focusNodeId, \{ closeNodeDetail, onSwitchSection \}\)/);
  });
});

// ---------------------------------------------------------------------------
// The callee selected once the new section's map is ready
// ---------------------------------------------------------------------------

describe('decidePendingFocus', () => {
  const RENDER = mapNode('web/r.ts#render');
  const onMap = (id: string) => (id === RENDER.id ? RENDER : undefined);
  const base = {
    pendingFocusNodeId: RENDER.id,
    section: 'web',
    fetchState: ready('web', [RENDER]),
    canvas: true,
    canvasReady: true,
    resolveMapNode: onMap,
  };

  it('none without a pending Node', () => {
    assert.deepEqual(decidePendingFocus({ ...base, pendingFocusNodeId: null }), { kind: 'none' });
  });

  it('waits while the map is loading, failed, or still the previous section\'s', () => {
    assert.deepEqual(decidePendingFocus({ ...base, fetchState: { status: 'loading' } }), { kind: 'wait' });
    assert.deepEqual(decidePendingFocus({ ...base, fetchState: { status: 'error', message: 'x' } }), { kind: 'wait' });
    assert.deepEqual(decidePendingFocus({ ...base, fetchState: ready('api', [RENDER]) }), { kind: 'wait' });
    assert.deepEqual(decidePendingFocus({ ...base, fetchState: ready(null, [RENDER]) }), { kind: 'wait' });
  });

  it('waits for the canvas\'s first fit, then focuses the callee', () => {
    assert.deepEqual(decidePendingFocus({ ...base, canvasReady: false }), { kind: 'wait' });
    assert.deepEqual(decidePendingFocus(base), { kind: 'focus', id: RENDER.id });
  });

  it('with no canvas (Health Audit), opens its Node detail', () => {
    assert.deepEqual(decidePendingFocus({ ...base, canvas: false, canvasReady: false }), { kind: 'open-detail', node: RENDER });
  });

  it('a callee the ready map lacks is missing — never a silent no-op', () => {
    assert.deepEqual(decidePendingFocus({ ...base, resolveMapNode: () => undefined }), { kind: 'missing', id: RENDER.id });
    assert.deepEqual(decidePendingFocus({ ...base, resolveMapNode: () => undefined, canvasReady: false }), {
      kind: 'missing',
      id: RENDER.id,
    });
  });
});

describe('CrossSectionMissNotice', () => {
  it('names the callee and its section with the NOT_ON_CURRENT_MAP wording, and dismisses', () => {
    let dismissed = 0;
    const tree = CrossSectionMissNotice({ name: 'render', section: 'web', onDismiss: () => (dismissed += 1) });
    assert.match(textOf(tree), new RegExp(`render in web/ — ${NOT_ON_CURRENT_MAP.replace(/[()]/g, '\\$&')}`));
    const dismiss = buttons(renderTree(tree)).find((button) => textOf(button) === 'Dismiss');
    (dismiss?.props.onClick as () => void)();
    assert.equal(dismissed, 1);
  });
});

describe('CodeMap consumes pendingFocusNodeId (source)', () => {
  const start = codeMapSrc.indexOf('const decision = decidePendingFocus({');
  const effect = codeMapSrc.slice(start, codeMapSrc.indexOf('const handleSwitchSectionFromDetail', start));

  it('decides with the section prop, the fetch, the canvas and its first fit', () => {
    assert.ok(start >= 0);
    assert.match(effect, /pendingFocusNodeId,\n\s+section,\n\s+fetchState,/);
    assert.match(effect, /canvasReady: reactFlowInstanceRef\.current !== null && !awaitingFirstFit/);
    assert.match(effect, /resolveMapNode: \(id\) => mapNodeOf\(flowNodesById\.get\(id\)\)/);
  });

  it('does nothing until the decision is final, then reports it consumed once', () => {
    const early = effect.indexOf("if (decision.kind === 'none' || decision.kind === 'wait') {");
    const consumed = effect.indexOf('onPendingFocusConsumedRef.current?.();');
    assert.ok(early >= 0 && consumed > early);
  });

  it('selects through navigateToNode, opens Node detail without a canvas, and says when it is missing', () => {
    assert.match(effect, /case 'focus': \{\n\s+navigateToNode\(decision\.id\);/);
    assert.match(effect, /\.focus\(\{ preventScroll: true \}\)/);
    assert.match(effect, /case 'open-detail':[\s\S]*openNodeDetail\(decision\.node\);/);
    assert.match(effect, /case 'missing': \{[\s\S]*setCrossSectionMiss\(/);
  });

  it('a new load clears the missing notice', () => {
    const load = codeMapSrc.slice(
      codeMapSrc.indexOf('const loadCodeMap = useCallback(() => {'),
      codeMapSrc.indexOf('}, [fixtureNodeCount, clearDiffScopeSync]);'),
    );
    assert.match(load, /setCrossSectionMiss\(null\);/);
  });
});

describe('App switches through the Section bar path (source)', () => {
  it('handleSwitchSection uses the Section bar\'s transition and keeps the callee', () => {
    const start = appSrc.indexOf('const handleSwitchSection = useCallback(');
    assert.ok(start >= 0);
    const body = appSrc.slice(start, appSrc.indexOf('}, []);', start));
    assert.match(body, /setSectionShell\(\(current\) => applySectionActivated\(current, next\)\);/);
    assert.match(body, /setPendingSectionFocus\(pendingFocusForSwitch\(next, focusNodeId\)\);/);
  });

  it('a Section bar tab cancels a pending focus', () => {
    const start = appSrc.indexOf('const handleSectionChange = useCallback(');
    const body = appSrc.slice(start, appSrc.indexOf('}, []);', start));
    assert.match(body, /setPendingSectionFocus\(null\);/);
  });

  it('hands CodeMap the switch, the one-shot pending Node and its consumer', () => {
    assert.match(appSrc, /onSwitchSection=\{handleSwitchSection\}/);
    assert.match(appSrc, /pendingFocusNodeId=\{pendingFocusNodeIdFor\(pendingSectionFocus, section\)\}/);
    assert.match(appSrc, /onPendingFocusConsumed=\{handlePendingFocusConsumed\}/);
  });

  it('renders the footer line as a polite status above the footer bar', () => {
    const line = appSrc.indexOf('<p className="app__cross-section-line" role="status">');
    const bar = appSrc.indexOf('<footer className="app__footerbar"');
    assert.ok(line >= 0 && bar > line);
    assert.match(appSrc, /\{nextCrossSectionLine\}\s*<\/p>/);
  });

  it('holds the line through a pending switch or reload (review round 1)', () => {
    assert.match(
      appSrc,
      /nextFooterCrossSectionLine\(crossSectionLine, frameMapFor\(frameMap, currentProjectPath\), sectionShell\.pending\)/,
    );
    assert.match(appSrc, /if \(nextCrossSectionLine !== crossSectionLine\) \{\s*setCrossSectionLine\(nextCrossSectionLine\);/);
  });

  it('the unknown-section fallback drops a pending focus (review round 1)', () => {
    const start = appSrc.indexOf('const handleUnknownSection = useCallback(');
    const body = appSrc.slice(start, appSrc.indexOf('}, []);', start));
    assert.match(body, /setPendingSectionFocus\(null\);/);
  });
});

// ---------------------------------------------------------------------------
// The footer's counts reach App unchanged
// ---------------------------------------------------------------------------

describe('crossSectionEdges plumbing', () => {
  const EDGES = [{ section: 'web', outgoing: 9, incoming: 3 }];

  it('a refresh carries the reply\'s crossSectionEdges', () => {
    const outcome = resolveRefreshOutcome({
      requestId: 1,
      latestRequestId: 1,
      reply: {
        kind: 'ok',
        nodes: [],
        edges: [],
        hiddenByScope: 0,
        appliedScope: [],
        foldedTypes: [],
        section: 'api',
        crossSectionEdges: EDGES,
      },
      hasReadyData: true,
      openDetailNodeId: null,
    });
    assert.equal(outcome.kind, 'apply');
    assert.deepEqual(outcome.kind === 'apply' ? outcome.crossSectionEdges : null, EDGES);
  });

  it('the map report carries them to the footer', () => {
    const state = mapFooterState({ ...(ready('api') as Extract<FetchState, { status: 'ready' }>), crossSectionEdges: EDGES });
    assert.deepEqual(state.status === 'ready' ? state.crossSectionEdges : null, EDGES);
  });

  it('every fetch site keeps the field', () => {
    assert.equal(codeMapSrc.match(/crossSectionEdges: result\.crossSectionEdges/g)?.length, 2);
    assert.match(codeMapSrc, /crossSectionEdges: outcome\.crossSectionEdges/);
  });
});

// ---------------------------------------------------------------------------
// Review round 1: focus never falls to <body> after a switch
// ---------------------------------------------------------------------------

describe('cardFocusStep', () => {
  it('focuses the card once rendered, retries, then falls back to the canvas', () => {
    assert.equal(cardFocusStep(true, 0), 'focus-card');
    assert.equal(cardFocusStep(true, CARD_FOCUS_MAX_FRAMES - 1), 'focus-card');
    assert.equal(cardFocusStep(false, 0), 'retry');
    assert.equal(cardFocusStep(false, CARD_FOCUS_MAX_FRAMES - 2), 'retry');
    assert.equal(cardFocusStep(false, CARD_FOCUS_MAX_FRAMES - 1), 'focus-canvas');
  });
});

describe('prReviewSwitchFocusTarget', () => {
  const base = { targetSection: 'api', section: 'api', fetchState: ready('api'), baseRefFocusable: true };

  it('waits for the target section\'s ready map', () => {
    assert.equal(prReviewSwitchFocusTarget({ ...base, fetchState: { status: 'loading' } }), 'wait');
    assert.equal(prReviewSwitchFocusTarget({ ...base, fetchState: ready('web') }), 'wait');
  });

  it('then the base-ref input, or the selected tab when it can\'t take focus', () => {
    assert.equal(prReviewSwitchFocusTarget(base), 'base-ref');
    assert.equal(prReviewSwitchFocusTarget({ ...base, baseRefFocusable: false }), 'section-tab');
  });

  it('is cancelled by a switch elsewhere', () => {
    assert.equal(prReviewSwitchFocusTarget({ ...base, section: 'docs' }), 'cancel');
  });
});

describe('focus wiring (source)', () => {
  it('the card wait falls back to the canvas wrapper, which can take focus', () => {
    assert.match(codeMapSrc, /switch \(cardFocusStep\(card !== null, frames\)\) \{/);
    assert.match(codeMapSrc, /case 'focus-canvas':\s*canvasElement\?\.focus\(\{ preventScroll: true \}\);/);
    assert.match(codeMapSrc, /<div className="code-map__canvas" ref=\{canvasRef\} style=\{\{ height: CODE_MAP_CANVAS_HEIGHT \}\} tabIndex=\{-1\}>/);
  });

  it('Health Audit: the selected Section bar tab is focused before Node detail opens (its opener)', () => {
    const start = codeMapSrc.indexOf("case 'open-detail': {");
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('return;', start));
    const tab = body.indexOf('document.getElementById(tabId)?.focus();');
    const open = body.indexOf('openNodeDetail(decision.node);');
    assert.ok(tab >= 0 && open > tab);
  });

  it('a missed callee focuses the notice\'s Dismiss; dismissing focuses the selected tab', () => {
    assert.match(
      codeMapSrc,
      /if \(crossSectionMiss !== null\) \{\s*document\.getElementById\(CROSS_SECTION_MISS_DISMISS_ID\)\?\.focus\(\);/,
    );
    const start = codeMapSrc.indexOf('const dismissCrossSectionMiss = useCallback(');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('}, [fetchState, section]);', start));
    assert.match(body, /setCrossSectionMiss\(null\);[\s\S]*document\.getElementById\(tabId\)\?\.focus\(\);/);
  });

  it('the miss notice also shows with no Path Trace wrapper (an empty section)', () => {
    assert.match(codeMapSrc, /\{!surfaces\.pathTraceInput && crossSectionMiss !== null && \(/);
  });

  it('PR Review\'s switch remembers its section and focuses by prReviewSwitchFocusTarget', () => {
    const start = codeMapSrc.indexOf('const handleSwitchSectionFromPrReview = useCallback(');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('[onSwitchSection]', start));
    assert.match(body, /prReviewSwitchFocusRef\.current = targetSection;\s*onSwitchSection\(targetSection\);/);
    assert.match(codeMapSrc, /baseRefFocusable: mode === 'prReview' && input !== null && !input\.disabled,/);
    assert.match(codeMapSrc, /if \(target === 'base-ref'\) \{\s*input\?\.focus\(\);/);
    assert.match(codeMapSrc, /ref=\{baseRefInputRef\}/);
  });
});

describe('CrossSectionMissNotice is described by its text', () => {
  it('the Dismiss button carries the id the focus effect uses and is described by the notice', () => {
    const dismiss = buttons(renderTree(CrossSectionMissNotice({ name: 'render', section: 'web', onDismiss: () => {} })))[0];
    assert.equal(dismiss?.props.id, CROSS_SECTION_MISS_DISMISS_ID);
    assert.equal(dismiss?.props['aria-describedby'], CROSS_SECTION_MISS_TEXT_ID);
  });
});

// ---------------------------------------------------------------------------
// Founder decision (2026-10-04): a switch out of PR Review carries the diff
// ---------------------------------------------------------------------------

describe('diffScopeCarryCandidate', () => {
  const RESOLVED = diffScopeStateFromResult({ status: 'resolved', resolvedBaseRef: 'abc123', nodeIds: [] });
  const base = { mode: 'prReview' as const, diffScopeState: RESOLVED, baseRefInput: 'origin/main', from: 'web', to: 'api' };

  it('carries an entered base ref (checked as entered)', () => {
    assert.deepEqual(diffScopeCarryCandidate(base), { from: 'web', to: 'api', ref: 'origin/main', input: 'origin/main' });
    assert.deepEqual(diffScopeCarryCandidate({ ...base, diffScopeState: { status: 'idle' }, baseRefInput: ' main ' }), {
      from: 'web',
      to: 'api',
      ref: 'main',
      input: 'main',
    });
  });

  it('a resolved diff with a blank input re-runs blank, checked by its base commit', () => {
    assert.deepEqual(diffScopeCarryCandidate({ ...base, baseRefInput: '' }), { from: 'web', to: 'api', ref: 'abc123', input: '' });
    assert.deepEqual(diffScopeCarryCandidate({ ...base, to: null }), { from: 'web', to: null, ref: 'origin/main', input: 'origin/main' });
  });

  it('nothing to carry: no ref and no resolved diff, outside PR Review, or no real switch', () => {
    assert.equal(diffScopeCarryCandidate({ ...base, baseRefInput: '  ', diffScopeState: { status: 'no-changes' } }), null);
    assert.equal(diffScopeCarryCandidate({ ...base, mode: 'codeMap' }), null);
    assert.equal(diffScopeCarryCandidate({ ...base, to: 'web' }), null);
  });
});

describe('diffScopeCarryDecision', () => {
  it('re-runs in the same repository, or where the ref exists; otherwise resets (incl. a failed check)', () => {
    assert.equal(diffScopeCarryDecision({ status: 'same-repository' }), 'rerun');
    assert.equal(diffScopeCarryDecision({ status: 'ref-exists' }), 'rerun');
    assert.equal(diffScopeCarryDecision({ status: 'not-carried' }), 'reset');
    assert.equal(diffScopeCarryDecision({ status: 'error', message: 'Timed out' }), 'reset');
  });

  it('announces the re-run', () => {
    assert.equal(
      diffScopeCarryAnnouncement({ input: 'origin/main', to: 'api' }),
      'Recomputing the diff against origin/main in api/…',
    );
    assert.equal(
      diffScopeCarryAnnouncement({ input: '', to: null }),
      'Recomputing the diff against the auto-resolved base ref in all sections…',
    );
  });
});

describe('diffScopeCarryReplyApplies (stale replies)', () => {
  it('only the latest check, for the section still on screen', () => {
    assert.equal(diffScopeCarryReplyApplies(3, 3, 'api', 'api'), true);
    assert.equal(diffScopeCarryReplyApplies(2, 3, 'api', 'api'), false);
    assert.equal(diffScopeCarryReplyApplies(3, 3, 'api', 'web'), false);
    assert.equal(diffScopeCarryReplyApplies(3, 3, null, null), true);
  });
});

describe('the carry flow (source)', () => {
  const start = codeMapSrc.indexOf('const startDiffScopeCarry = useCallback(');
  const body = codeMapSrc.slice(start, codeMapSrc.indexOf('startDiffScopeCarryRef.current = startDiffScopeCarry;', start));

  it('keeps the base ref, marks the check pending, checks it, and settles through applyDiffScopeCarryReply', () => {
    assert.match(body, /const carryId = \+\+diffCarryRequestIdRef\.current;\s*setBaseRefInput\(carry\.input\);\s*setDiffCarryPending\(carry\);/);
    assert.match(body, /\.checkDiffScopeCarry\(projectPath, carry\.from, carry\.to, carry\.ref\)/);
    assert.match(body, /latestCarryId: diffCarryRequestIdRef\.current,\s*carryTo: carry\.to,\s*currentSection: sectionRef\.current,\s*mode: diffCarrySourceRef\.current\.mode,/);
    assert.match(body, /done: \(\) => setDiffCarryPending\(null\),/);
    assert.match(body, /rerun: \(\) => \{\s*setDiffCarryNote\(diffScopeCarryAnnouncement\(carry\)\);\s*runDiffScope\(carry\.input\);/);
    assert.match(body, /reset: \(\) => setBaseRefInput\(''\),/);
    assert.match(body, /\.catch\(\(error: unknown\) =>\s*settle\(\{ status: 'error'/);
  });

  it('typing in the base-ref input cancels a check in flight', () => {
    assert.match(
      codeMapSrc,
      /onChange=\{\(event\) => \{[^}]*diffCarryRequestIdRef\.current \+= 1;\s*setDiffCarryPending\(null\);\s*setBaseRefInput\(event\.target\.value\);/,
    );
  });

  it('while a check runs, the idle line says so', () => {
    assert.match(codeMapSrc, /\{diffCarryPending !== null\s*\? diffScopeCarryCheckingText\(diffCarryPending\)\s*: 'Enter a base ref/);
  });

  it('unmount moves both request ids on', () => {
    assert.match(
      codeMapSrc,
      /const carryIds = diffCarryRequestIdRef;\s*const diffIds = diffScopeRequestIdRef;\s*return \(\) => \{\s*carryIds\.current \+= 1;\s*diffIds\.current \+= 1;/,
    );
  });

  it('runDiffScope is the button\'s own path (the same stale-reply guards)', () => {
    assert.match(codeMapSrc, /const runDiffScope = useCallback\(\(rawBaseRef: string\) => \{/);
    assert.match(
      codeMapSrc,
      /setDiffCarryNote\(null\);\s*diffCarryRequestIdRef\.current \+= 1;\s*setDiffCarryPending\(null\);\s*runDiffScope\(baseRefInput\);/,
    );
  });

  it('a load or refresh drops a check in flight', () => {
    const load = codeMapSrc.slice(
      codeMapSrc.indexOf('const loadCodeMap = useCallback(() => {'),
      codeMapSrc.indexOf('}, [fixtureNodeCount, clearDiffScopeSync]);'),
    );
    assert.match(load, /setDiffCarryNote\(null\);\s*diffCarryRequestIdRef\.current \+= 1;\s*setDiffCarryPending\(null\);/);
    const refresh = codeMapSrc.slice(codeMapSrc.indexOf('const refreshCodeMap = useCallback(() => {'));
    assert.match(refresh.slice(0, 2000), /setDiffCarryNote\(null\);\s*diffCarryRequestIdRef\.current \+= 1;\s*setDiffCarryPending\(null\);/);
  });

  it('the section effect starts the carry after the reset', () => {
    const start = codeMapSrc.indexOf('const carry = diffScopeCarryCandidate({ ...diffCarrySourceRef.current, from, to: section });');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('}, [loadCodeMap, section]);', start));
    assert.match(body, /loadCodeMap\(\);\s*if \(carry !== null\) \{\s*startDiffScopeCarryRef\.current\(carry\);/);
  });

  it('the re-run is announced in the loading line', () => {
    assert.match(codeMapSrc, /\{diffCarryNote \?\? 'Computing diff scope…'\}/);
  });
});

describe('applyDiffScopeCarryReply (carry review: the settle, behaviourally)', () => {
  const base = { carryId: 4, latestCarryId: 4, carryTo: 'api', currentSection: 'api', mode: 'prReview' as const };
  function run(input: Parameters<typeof applyDiffScopeCarryReply>[0]) {
    const calls: string[] = [];
    const action = applyDiffScopeCarryReply(input, {
      done: () => calls.push('done'),
      rerun: () => calls.push('rerun'),
      reset: () => calls.push('reset'),
    });
    return { action, calls };
  }

  it('a carried ref re-runs the diff exactly once', () => {
    assert.deepEqual(run({ ...base, result: { status: 'same-repository' } }), { action: 'rerun', calls: ['done', 'rerun'] });
    assert.deepEqual(run({ ...base, result: { status: 'ref-exists' } }), { action: 'rerun', calls: ['done', 'rerun'] });
  });

  it('not carried, or a failed check, resets (clears the base ref)', () => {
    assert.deepEqual(run({ ...base, result: { status: 'not-carried' } }), { action: 'reset', calls: ['done', 'reset'] });
    assert.deepEqual(run({ ...base, result: { status: 'error', message: 'x' } }), { action: 'reset', calls: ['done', 'reset'] });
  });

  it('a stale reply does nothing at all (typing, a later switch, load, refresh or unmount bumped the id; or another section)', () => {
    assert.deepEqual(run({ ...base, latestCarryId: 5, result: { status: 'not-carried' } }), { action: 'ignore', calls: [] });
    assert.deepEqual(run({ ...base, latestCarryId: 5, result: { status: 'same-repository' } }), { action: 'ignore', calls: [] });
    assert.deepEqual(run({ ...base, currentSection: 'web', result: { status: 'same-repository' } }), { action: 'ignore', calls: [] });
  });

  it('PR Review left during the check: no re-run', () => {
    assert.deepEqual(run({ ...base, mode: 'codeMap', result: { status: 'same-repository' } }), { action: 'skip', calls: ['done'] });
    assert.equal(diffScopeCarrySettleAction({ ...base, mode: 'healthAudit', result: { status: 'ref-exists' } }), 'skip');
  });
});

describe('diffScopeCarryCheckingText', () => {
  it('"Checking whether origin/main applies in api/…", or the base commit for a blank input', () => {
    assert.equal(diffScopeCarryCheckingText({ ref: 'origin/main', to: 'api' }), 'Checking whether origin/main applies in api/…');
    assert.equal(diffScopeCarryCheckingText({ ref: 'abc123', to: null }), 'Checking whether abc123 applies in all sections…');
  });
});
