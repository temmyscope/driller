/**
 * P4-2 phase 3c: PR Review names changed contracts (folded Types/Interfaces
 * the diff changed) with their dependents, and marks the dependents as
 * affected; the "Show types & modules" toggle draws the folded kinds back on
 * the canvas, render only.
 *
 * Hookless helpers and components, rendered by calling them since the
 * runner is `node --test` with no DOM. Cards are walked host-elements only
 * (xyflow's `Handle` uses hooks and is not expanded).
 *
 * What this cannot reach: the checkbox's wiring to `window.driller` (the
 * helpers it calls are tested here; persistence is `main/ui-settings.test.ts`),
 * React Flow's own rendering of the cards, and the canvas layout — owed
 * in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChangedContract, CodeMapNode, FoldedModule, FoldedType } from '@driller/ipc-contracts';
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';

import {
  activateCanvasCard,
  canvasGridSize,
  canvasPopulation,
  CHANGED_CONTRACTS_APPROXIMATE_NOTE,
  CHANGED_CONTRACTS_SHOWN,
  ChangedContractList,
  clusterAriaLabel,
  CodeMapFoldedCard,
  CodeMapNodeCard,
  contractDependentAriaSuffix,
  contractDependents,
  createLatestRequestGuard,
  diffScopeStateFromResult,
  foldedCanvasElements,
  formatChangedContractsSummary,
  formatContractDependents,
  formatDiffScopeChangeCount,
  loadShowFoldedKinds,
  nodeHighlightClassName,
  PR_REVIEW_NOTICE_ID,
  PrReviewDiffScopeNoticeRegion,
  resolvePrReviewView,
  saveShowFoldedKinds,
  SHOW_FOLDED_KINDS_HINT,
  type BlastRadiusState,
  type DiffScopeState,
  type FetchState,
  type FoldedCanvasNode,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

/** P4-3c: no blast radius — these tests are about the diff scope alone. */
const IDLE_BLAST_RADIUS: BlastRadiusState = { status: 'idle' };

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const contract = (name: string, dependentIds: string[], dependentCount = dependentIds.length): ChangedContract => ({
  id: `src/types.ts::${name}`,
  name,
  kind: 'Interface',
  file: 'src/types.ts',
  dependentCount,
  dependentIds,
});

const node = (id: string, overrides: Partial<CodeMapNode> = {}): CodeMapNode => ({
  id,
  name: id,
  file: `src/${id}.ts`,
  startLine: 1,
  endLine: 5,
  kind: 'Function',
  summaryStatus: 'ready',
  summary: 'Does a thing.',
  riskSignals: [
    {
      family: 'deterministic',
      type: 'complexity',
      value: 12,
      severity: 'severe',
      location: { file: `src/${id}.ts`, startLine: 1, endLine: 5 },
    },
  ],
  ...overrides,
});

const type = (id: string, overrides: Partial<FoldedType> = {}): FoldedType => {
  const usedBy = overrides.usedBy ?? [];
  return {
    id,
    name: id,
    kind: 'Interface',
    file: 'src/types.ts',
    startLine: 3,
    endLine: 9,
    usedBy,
    usedByTotal: usedBy.length,
    usedByKinds: [],
    implements: [],
    implementedBy: [],
    refersTo: [],
    referencedByTypes: [],
    ...overrides,
  };
};

const resolved = (
  changedContracts: ChangedContract[],
  nodeIds: string[] = [],
  approximate = false,
): DiffScopeState => ({
  status: 'resolved',
  resolvedBaseRef: 'abc123',
  nodeIds: new Set(nodeIds),
  topLevelFiles: [],
  changedContracts,
  changedContractsApproximate: approximate,
});

const ready = (
  nodes: CodeMapNode[],
  foldedTypes: FoldedType[] = [],
  foldedModules: FoldedModule[] = [],
): FetchState => ({
  status: 'ready',
  nodes,
  edges: [{ source: 'w', target: 'a', kind: 'CALLS' }],
  hiddenByScope: 0,
  appliedScope: [],
  foldedTypes,
  foldedModules,
});

interface HostElement {
  type: unknown;
  props: Record<string, unknown>;
}
const isHostElement = (value: unknown): value is HostElement =>
  typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
/** Host elements only — function components (xyflow's hook-using `Handle` among them) are not expanded. */
function hostTree(root: unknown, out: HostElement[] = []): HostElement[] {
  if (Array.isArray(root)) {
    root.forEach((child) => hostTree(child, out));
    return out;
  }
  if (!isHostElement(root)) {
    return out;
  }
  out.push(root);
  if (typeof root.type === 'string') {
    hostTree(root.props.children, out);
  }
  return out;
}
const hostText = (root: unknown): string =>
  typeof root === 'string' || typeof root === 'number'
    ? String(root)
    : Array.isArray(root)
      ? root.map(hostText).join('')
      : isHostElement(root) && typeof root.type === 'string'
        ? hostText(root.props.children)
        : '';
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const isInfoNotice = (element: RenderedElement) =>
  element.props.className === 'actionable-notice actionable-notice--info';

// ---------------------------------------------------------------------------
// PR Review: changed contracts
// ---------------------------------------------------------------------------

describe('PR Review: changed contracts', () => {
  const codeMapNode = contract(
    'CodeMapNode',
    Array.from({ length: 59 }, (_, i) => `f${i}`),
  );

  it('diffScopeStateFromResult keeps changedContracts and the approximate flag, defaulting to [] and false', () => {
    const state = diffScopeStateFromResult({
      status: 'resolved',
      resolvedBaseRef: 'abc',
      nodeIds: [],
      changedContracts: [codeMapNode],
      changedContractsApproximate: true,
    });
    assert.deepEqual(
      state.status === 'resolved' ? [state.changedContracts, state.changedContractsApproximate] : undefined,
      [[codeMapNode], true],
    );
    const without = diffScopeStateFromResult({ status: 'resolved', resolvedBaseRef: 'abc', nodeIds: [] });
    assert.deepEqual(
      without.status === 'resolved' ? [without.changedContracts, without.changedContractsApproximate] : undefined,
      [[], false],
    );
  });

  it('resolvePrReviewView passes them through in PR Review with a map only', () => {
    const showable = ready([node('a')]);
    const view = resolvePrReviewView('prReview', showable, resolved([codeMapNode], [], true), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS);
    assert.deepEqual([view.changedContracts, view.changedContractsApproximate], [[codeMapNode], true]);
    assert.deepEqual(resolvePrReviewView('codeMap', showable, resolved([codeMapNode]), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).changedContracts, []);
    assert.deepEqual(
      resolvePrReviewView('prReview', { status: 'loading' }, resolved([codeMapNode]), IDLE_BLAST_RADIUS, BLAST_RADIUS_DEFAULT_HOPS).changedContracts,
      [],
    );
  });

  it('a type-only PR reads "Contract changed: CodeMapNode → 59 dependents", and the name opens its type detail', () => {
    const opened: string[] = [];
    const elements = renderTree(
      PrReviewDiffScopeNoticeRegion({
        status: null,
        changedContracts: [codeMapNode],
        onOpenType: (id) => opened.push(id),
      }),
    );
    const lines = elements.filter(isInfoNotice);
    assert.equal(lines.length, 1);
    assert.equal(squash(textOf(lines[0])).replace(/^ⓘ ?/, ''), 'Contract changed: CodeMapNode → 59 dependents');
    const button = elements.find((element) => element.type === 'button');
    assert.equal(button?.props['aria-label'], 'Open the type detail of CodeMapNode');
    (button?.props.onClick as () => void)();
    assert.deepEqual(opened, ['src/types.ts::CodeMapNode']);
  });

  it('the live region announces a one-line summary only; the interactive lines sit beside it, outside it', () => {
    const rendered = PrReviewDiffScopeNoticeRegion({
      status: null,
      changedContracts: [codeMapNode, contract('B', ['x'])],
    });
    assert.ok(Array.isArray(rendered));
    const live = renderTree(rendered[0]);
    assert.equal(live[0]?.props.id, PR_REVIEW_NOTICE_ID);
    assert.equal(live[0]?.props.role, 'status');
    assert.equal(squash(textOf(live[0])), '2 contracts changed.');
    assert.equal(
      live.some((element) => element.type === 'button'),
      false,
      'no button inside the live region',
    );
    const list = renderTree(rendered[1]);
    assert.equal(list.filter((element) => element.type === 'button').length, 2);
    assert.equal(
      list.some((element) => element.props.role === 'status'),
      false,
    );
  });

  it(`shows one line per contract, capped at ${CHANGED_CONTRACTS_SHOWN}, then "+N more" holding the rest, each openable`, () => {
    const contracts = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name, i) =>
      contract(
        name,
        Array.from({ length: 7 - i }, (_, j) => `n${j}`),
      ),
    );
    const opened: string[] = [];
    const elements = renderTree(
      ChangedContractList({ contracts, approximate: false, onOpenType: (id) => opened.push(id) }),
    );
    const lines = elements.filter(isInfoNotice);
    assert.equal(CHANGED_CONTRACTS_SHOWN, 5);
    assert.equal(lines.length, 5);
    assert.match(textOf(lines[4]), /Contract changed: E → 3 dependents/);
    const details = elements.find((element) => element.type === 'details');
    assert.ok(details);
    const inside = renderTree(details.props.children);
    assert.equal(textOf(inside.find((element) => element.type === 'summary')), '+2 more');
    const moreButtons = inside.filter((element) => element.type === 'button');
    assert.deepEqual(
      moreButtons.map((button) => button.props['aria-label']),
      ['Open the type detail of F', 'Open the type detail of G'],
    );
    (moreButtons[1]?.props.onClick as () => void)();
    assert.deepEqual(opened, ['src/types.ts::G']);
    assert.match(textOf(details), /F \(2 dependents\), G \(1 dependent\)/);
  });

  it('says "approximate: couldn\'t read line ranges" when the contracts were found without them', () => {
    assert.equal(CHANGED_CONTRACTS_APPROXIMATE_NOTE, "approximate: couldn't read line ranges");
    const rendered = PrReviewDiffScopeNoticeRegion({
      status: null,
      changedContracts: [codeMapNode],
      changedContractsApproximate: true,
    }) as unknown[];
    assert.match(textOf(rendered[0]), /1 contract changed \(approximate: couldn't read line ranges\)\./);
    const list = renderTree(rendered[1]);
    assert.ok(list.some((element) => element.props.className === 'actionable-notice actionable-notice--warning'));
    assert.match(textOf(rendered[1]), /approximate: couldn't read line ranges/);
    assert.equal(formatChangedContractsSummary(0, true), null);
  });

  it('shows no contract line, list or summary without changed contracts', () => {
    const rendered = PrReviewDiffScopeNoticeRegion({ status: null, changedContracts: [] }) as unknown[];
    assert.equal(textOf(rendered[0]), '');
    assert.equal(rendered[1], false);
  });

  it('the status line leads with the contracts and leaves out a zero Node count beside them', () => {
    assert.equal(formatDiffScopeChangeCount(0, 0, 1), '1 contract changed');
    assert.equal(formatDiffScopeChangeCount(0, 1, 1), '1 contract changed · top-level code changed in 1 file');
    assert.equal(
      formatDiffScopeChangeCount(2, 1, 3),
      '3 contracts changed · 2 changed Nodes · top-level code changed in 1 file',
    );
    assert.equal(formatDiffScopeChangeCount(3, 0), '3 changed Nodes');
    assert.equal(formatDiffScopeChangeCount(0, 0), '0 changed Nodes');
    assert.equal(formatContractDependents({ dependentCount: 1 }), '1 dependent');
    assert.equal(formatContractDependents({ dependentCount: 1204 }), '1,204 dependents');
  });
});

// ---------------------------------------------------------------------------
// Dependents: their own treatment
// ---------------------------------------------------------------------------

describe('PR Review: changed-contract dependents', () => {
  it('marks exactly the real dependents, with the contracts they use — never a changed Node', () => {
    const byNode = contractDependents([contract('A', ['f1', 'f2']), contract('B', ['f2', 'f3'])], new Set(['f3']));
    assert.deepEqual([...byNode].sort(), [
      ['f1', ['A']],
      ['f2', ['A', 'B']],
    ]);
    assert.equal(contractDependents([], new Set()).size, 0);
  });

  it('gives a dependent its own class — not the blast radius’s — alongside any other highlight', () => {
    const none = new Set<string>();
    const dependents = contractDependents([contract('A', ['f1'])], none);
    assert.equal(nodeHighlightClassName('f1', none, none, dependents), 'code-map__contract-dependent');
    assert.equal(
      nodeHighlightClassName('f1', new Set(['f1']), new Set(['f1']), dependents),
      'code-map__path-highlight code-map__blast-radius-highlight code-map__contract-dependent',
    );
    assert.equal(nodeHighlightClassName('f9', none, none, dependents), null);
    assert.equal(nodeHighlightClassName('f9', none, new Set(['f9']), dependents), 'code-map__blast-radius-highlight');
  });

  it('a dependent card carries a ⧉ marker naming the contract, and says so in its accessible name', () => {
    const data = {
      node: node('f1'),
      onActivate: () => {},
      onShowNeighbors: () => {},
      onOpenSource: () => {},
      callerCount: 0,
      calleeCount: 0,
      noSummaryBackendAvailable: false,
      cloudSelectedNoKey: false,
      showDeterministicSignals: true,
      showLlmJudgment: true,
      showIngestedFindings: true,
      isChanged: false,
      affectedByContracts: ['CodeMapNode'],
    };
    const root = CodeMapNodeCard({ data }) as unknown;
    assert.ok(isHostElement(root));
    assert.equal(root.props['aria-label'], 'Function f1, affected by changed contract CodeMapNode, open Node detail');
    const marker = hostTree(root).find((element) => element.props.className === 'code-map__node-contract-dependent');
    assert.ok(marker);
    assert.equal(squash(hostText(marker)), '⧉ Uses changed contract CodeMapNode');
    const plain = CodeMapNodeCard({ data: { ...data, affectedByContracts: undefined } }) as unknown as HostElement;
    assert.equal(plain.props['aria-label'], 'Function f1, open Node detail');
    assert.equal(
      hostTree(plain).some((element) => element.props.className === 'code-map__node-contract-dependent'),
      false,
    );
  });

  it('names several contracts compactly', () => {
    assert.equal(contractDependentAriaSuffix(['A', 'B']), ', affected by changed contracts A and B');
    assert.equal(contractDependentAriaSuffix(['A', 'B', 'C', 'D']), ', affected by changed contracts A, B and 2 more');
    assert.equal(contractDependentAriaSuffix(undefined), '');
  });

  it('a cluster holding dependents says how many in its accessible name', () => {
    assert.equal(
      clusterAriaLabel(4, false, 1, 2),
      'Cluster of 4 Nodes, expand, 1 changed, 2 affected by changed contracts',
    );
    assert.equal(clusterAriaLabel(4, false, 0, 3), 'Cluster of 4 Nodes, expand, 3 affected by changed contracts');
    assert.equal(clusterAriaLabel(4, false, 0), 'Cluster of 4 Nodes, expand');
  });
});

// ---------------------------------------------------------------------------
// "Show types & modules"
// ---------------------------------------------------------------------------

describe('"Show types & modules": the folded kinds, drawn back render-only', () => {
  const mapNodes = [node('w'), node('a')];
  const types = [
    type('T', { usedBy: ['a', 'w', 'gone'], refersTo: ['U'] }),
    type('U', { kind: 'Type', usedBy: ['w'] }),
    // An id already on the map is never drawn twice.
    type('w'),
  ];
  const modules: FoldedModule[] = [
    {
      file: 'lib/boot.ts',
      moduleIds: ['mod:boot'],
      startLine: 1,
      endLine: 4,
      uses: [
        { id: 'a', kind: 'CALLS' },
        { id: 'gone', kind: 'USAGE' },
      ],
      usesTypes: [{ id: 'U', name: 'U', kind: 'Type' }],
    },
  ];

  it('draws each folded type and Module once, as folded cards — no summary, no risk signals', () => {
    const folded = foldedCanvasElements(mapNodes, types, modules);
    assert.deepEqual(folded.nodes, [
      {
        folded: true,
        id: 'T',
        name: 'T',
        kind: 'Interface',
        file: 'src/types.ts',
        startLine: 3,
        endLine: 9,
        usedByTotal: 3,
      },
      {
        folded: true,
        id: 'U',
        name: 'U',
        kind: 'Type',
        file: 'src/types.ts',
        startLine: 3,
        endLine: 9,
        usedByTotal: 1,
      },
      { folded: true, id: 'mod:boot', name: 'boot.ts', kind: 'Module', file: 'lib/boot.ts', startLine: 1, endLine: 4 },
    ]);
  });

  it("rebuilds edges from the folded indexes' real links only, both ends drawn", () => {
    assert.deepEqual(foldedCanvasElements(mapNodes, types, modules).edges, [
      { source: 'a', target: 'T', kind: 'USAGE' },
      { source: 'w', target: 'T', kind: 'USAGE' },
      { source: 'T', target: 'U', kind: 'USAGE' },
      { source: 'w', target: 'U', kind: 'USAGE' },
      { source: 'mod:boot', target: 'a', kind: 'CALLS' },
      { source: 'mod:boot', target: 'U', kind: 'USAGE' },
    ]);
  });

  it('with the toggle on, the canvas gains the folded cards; the risk sets never include a folded id', () => {
    const fetchState = ready(mapNodes, types, modules);
    const folded = foldedCanvasElements(mapNodes, types, modules);
    const on = canvasPopulation(fetchState, folded, true);
    const foldedIds = new Set(folded.nodes.map((card) => card.id));
    assert.deepEqual(
      on.canvasNodes.map((card) => card.id),
      ['w', 'a', 'T', 'U', 'mod:boot'],
    );
    assert.equal(on.canvasEdges.length, 1 + folded.edges.length);
    assert.deepEqual(on.foldedNodes, folded.nodes);
    assert.equal(
      on.riskNodes.some((riskNode) => foldedIds.has(riskNode.id)),
      false,
    );
    assert.equal(
      on.riskEdges.some((edge) => foldedIds.has(edge.source) || foldedIds.has(edge.target)),
      false,
    );
    assert.equal(on.riskNodes, fetchState.status === 'ready' ? fetchState.nodes : undefined, 'the fetched map as-is');
    // Toggle off: the canvas is the risk population.
    const off = canvasPopulation(fetchState, folded, false);
    assert.deepEqual([off.canvasNodes, off.canvasEdges, off.foldedNodes], [off.riskNodes, off.riskEdges, []]);
    assert.deepEqual(canvasPopulation({ status: 'loading' }, folded, true).canvasNodes, []);
  });

  it('lays folded cards after the map Nodes without moving them, and in their own grid on an empty map', () => {
    assert.equal(canvasGridSize(9, 4), 9);
    assert.equal(canvasGridSize(0, 4), 4);
  });

  it('a folded card shows kind, name, file and "Used by N" — no summary, no pills — and activates itself', () => {
    const card: FoldedCanvasNode = {
      folded: true,
      id: 'T',
      name: 'CodeMapNode',
      kind: 'Interface',
      file: 'src/types.ts',
      startLine: 3,
      endLine: 9,
      usedByTotal: 59,
    };
    const activated: FoldedCanvasNode[] = [];
    const root = CodeMapFoldedCard({
      data: { folded: card, onActivate: (f) => activated.push(f), isChanged: false },
    }) as unknown;
    assert.ok(isHostElement(root));
    assert.equal(root.props['aria-label'], 'Folded Interface CodeMapNode, open type detail');
    const text = squash(hostText(root));
    assert.equal(text, 'Interface · foldedCodeMapNodesrc/types.tsUsed by 59');
    assert.equal(
      hostTree(root).some((element) => element.type === 'button'),
      false,
      'no pills',
    );
    (root.props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({
      key: 'Enter',
      preventDefault() {},
    });
    assert.deepEqual(activated, [card]);
    const moduleCard = CodeMapFoldedCard({
      data: {
        folded: {
          folded: true,
          id: 'm',
          name: 'boot.ts',
          kind: 'Module',
          file: 'lib/boot.ts',
          startLine: 1,
          endLine: 4,
        },
        onActivate: () => {},
        isChanged: true,
      },
    }) as unknown as HostElement;
    assert.equal(moduleCard.props['aria-label'], 'Folded Module boot.ts, changed, open its top-level code');
    assert.match(hostText(moduleCard), /File top-level code/);
  });

  it("the toggle's hint says the risk numbers don't change", () => {
    assert.match(SHOW_FOLDED_KINDS_HINT, /canvas only/);
    assert.match(SHOW_FOLDED_KINDS_HINT, /Blast radius, severity and Health Audit always use the folded map/);
    assert.match(SHOW_FOLDED_KINDS_HINT, /no risk number changes/);
  });
});

// ---------------------------------------------------------------------------
// Card activation
// ---------------------------------------------------------------------------

describe('activateCanvasCard', () => {
  it('an ordinary card reaches its onActivate (activateNode) with its Node; a folded card and a cluster go their own way', () => {
    const calls: string[] = [];
    const mapNode = node('f1');
    activateCanvasCard(
      {
        id: 'f1',
        type: 'codeMapNode',
        position: { x: 0, y: 0 },
        data: { node: mapNode, onActivate: (n: CodeMapNode) => calls.push(`node:${n.id}`) },
      } as unknown as Parameters<typeof activateCanvasCard>[0],
      () => calls.push('expand'),
    );
    activateCanvasCard(
      {
        id: 'T',
        type: 'codeMapFolded',
        position: { x: 0, y: 0 },
        data: {
          folded: { id: 'T' },
          onActivate: (f: FoldedCanvasNode) => calls.push(`folded:${f.id}`),
          isChanged: false,
        },
      } as unknown as Parameters<typeof activateCanvasCard>[0],
      () => calls.push('expand'),
    );
    activateCanvasCard(
      {
        id: 'c',
        type: 'codeMapCluster',
        position: { x: 0, y: 0 },
        data: { cluster: { id: 'c' } },
      } as unknown as Parameters<typeof activateCanvasCard>[0],
      (cluster) => calls.push(`expand:${cluster.id}`),
    );
    assert.deepEqual(calls, ['node:f1', 'folded:T', 'expand:c']);
  });
});

// ---------------------------------------------------------------------------
// Toggle persistence helpers
// ---------------------------------------------------------------------------

describe('"Show types & modules" persistence helpers', () => {
  it('loadShowFoldedKinds returns the stored value for the project', { timeout: 5_000 }, async () => {
    const asked: string[] = [];
    assert.equal(
      await loadShowFoldedKinds('/p', async (path) => {
        asked.push(path);
        return true;
      }),
      true,
    );
    assert.equal(await loadShowFoldedKinds('/p', async () => false), false);
    assert.deepEqual(asked, ['/p']);
  });

  it(
    'loadShowFoldedKinds: off with no project; null (keep what is shown) on a failed or malformed read',
    { timeout: 5_000 },
    async () => {
      assert.equal(await loadShowFoldedKinds(null, async () => true), false);
      assert.equal(
        await loadShowFoldedKinds('/p', async () => {
          throw new Error('ipc down');
        }),
        null,
      );
      assert.equal(await loadShowFoldedKinds('/p', async () => 'yes' as unknown as boolean), null);
    },
  );

  it('saveShowFoldedKinds resolves with the value main stored, not the one asked for', { timeout: 5_000 }, async () => {
    const sent: unknown[] = [];
    assert.equal(
      await saveShowFoldedKinds('/p', true, async (path, show) => {
        sent.push([path, show]);
        return false;
      }),
      false,
    );
    assert.deepEqual(sent, [['/p', true]]);
    assert.equal(
      await saveShowFoldedKinds('/p', true, async () => {
        throw new Error('ipc down');
      }),
      null,
    );
  });

  it('createLatestRequestGuard: only the latest request may apply', () => {
    const guard = createLatestRequestGuard();
    const read = guard.begin();
    assert.equal(guard.isLatest(read), true);
    const userChoice = guard.begin();
    assert.equal(guard.isLatest(read), false, 'a read in flight is superseded by a user choice');
    assert.equal(guard.isLatest(userChoice), true);
  });
});
