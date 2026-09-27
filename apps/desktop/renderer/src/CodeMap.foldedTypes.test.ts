/**
 * P4-2 phase 3b: Type/Interface Nodes folded off the map — Node detail's
 * "Uses" list and "File top-level" type line, the type detail panel (head
 * and body), the helpers that open it and keep it current, and Path Trace's
 * "is a type" decision (`resolvePathTraceQuery`) and notice. Hookless
 * components rendered by calling them (`./testRender`), since the runner is
 * `node --test` with no DOM.
 *
 * What this cannot reach: the overlay's modal-layer wiring and focus, and
 * the panel's layout — owed in-app checks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapNode, FoldedType, PathTraceResult, TypeUse } from '@driller/ipc-contracts';

import {
  foldedTypeSourceTarget,
  foldedTypeStateAfterRefresh,
  formatUsedByCount,
  navigateFromTypeDetail,
  NODE_DETAIL_SECTION_HEADING_IDS,
  NODE_DETAIL_USES_ROWS,
  NodeDetailBody,
  openTypeFromDetail,
  PathTraceFoldedTypeNotice,
  refreshTypeDetail,
  resolvePathTraceQuery,
  TYPE_DETAIL_SECTION_HEADING_IDS,
  TYPE_DETAIL_USED_BY_ROWS,
  TYPE_GONE_NOTICE,
  TYPE_NOT_ON_CURRENT_MAP,
  TypeDetailBody,
  TypeDetailHead,
  TypeGoneNotice,
  type NodeDetailBodyProps,
  type PathTraceState,
  type TypeDetailBodyProps,
  type TypeDetailState,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

const noop = () => {};

function makeNode(overrides: Partial<CodeMapNode> = {}): CodeMapNode {
  return {
    id: 'src/pay.ts::charge',
    name: 'charge',
    file: 'src/pay.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Charges.',
    riskSignals: [],
    ...overrides,
  };
}

function makeType(overrides: Partial<FoldedType> = {}): FoldedType {
  const usedBy = overrides.usedBy ?? [];
  return {
    id: 'contracts/index.ts::CodeMapNode',
    name: 'CodeMapNode',
    kind: 'Interface',
    file: 'contracts/index.ts',
    startLine: 940,
    endLine: 1003,
    usedBy,
    usedByTotal: usedBy.length,
    usedByKinds: usedBy.length > 0 ? [{ kind: 'Function', count: usedBy.length }] : [],
    implements: [],
    implementedBy: [],
    refersTo: [],
    referencedByTypes: [],
    ...overrides,
  };
}

const TYPES = [
  makeType(),
  makeType({ id: 'contracts/index.ts::Base', name: 'Base', kind: 'Interface' }),
  makeType({ id: 'contracts/index.ts::Kind', name: 'Kind', kind: 'Type' }),
];
const TYPES_BY_ID = new Map(TYPES.map((type) => [type.id, type]));
const resolveType = (id: string) => TYPES_BY_ID.get(id);

function renderBody(overrides: Partial<NodeDetailBodyProps> = {}): RenderedElement[] {
  const props: NodeDetailBodyProps = {
    node: makeNode(),
    toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
    cloudSelectedNoKey: false,
    noSummaryBackendAvailable: false,
    summaryAction: null,
    regenerateState: { kind: 'idle' },
    graphServiceAvailable: true,
    onRegenerate: noop,
    onOpenTest: noop,
    ...overrides,
  };
  return renderTree(NodeDetailBody(props));
}

function headings(elements: RenderedElement[]): string[] {
  return elements.filter((element) => element.type === 'h3').map((heading) => textOf(heading));
}

function section(elements: RenderedElement[], id: string): RenderedElement[] {
  const found = elements.find((element) => element.type === 'section' && element.props['aria-labelledby'] === id);
  assert.ok(found, `section ${id} renders`);
  return renderTree(found.props.children);
}

function byClass(elements: RenderedElement[], className: string): RenderedElement | undefined {
  return elements.find((element) => element.props.className === className);
}

const buttons = (elements: RenderedElement[]) => elements.filter((element) => element.type === 'button');

function click(button: RenderedElement | undefined): void {
  assert.ok(button);
  (button.props.onClick as () => void)();
}

/** Elements outside any `<details>` — what shows before "+N more" is opened. */
function visible(elements: RenderedElement[]): RenderedElement[] {
  const hidden = new Set(
    elements.filter((element) => element.type === 'details').flatMap((details) => renderTree(details.props.children)),
  );
  return elements.filter((element) => !hidden.has(element));
}

/** Each visible `<li>`'s text, in order. */
const visibleItems = (elements: RenderedElement[]) =>
  visible(elements)
    .filter((element) => element.type === 'li')
    .map((item) => textOf(item).replaceAll(` (${TYPE_NOT_ON_CURRENT_MAP})`, ''));

const use = (type: FoldedType): TypeUse => ({ id: type.id, name: type.name, kind: type.kind });

describe('NodeDetailBody: Uses', () => {
  it('is present, after Tested by, only when the Node uses a type', () => {
    assert.deepEqual(headings(renderBody({ node: makeNode({ usesTypes: [use(TYPES[0]!)] }) })), [
      'Summary',
      'Risk Overlay',
      'Tested by',
      'Uses',
      'Staleness',
      'Location',
    ]);
    for (const usesTypes of [undefined, []]) {
      assert.ok(!headings(renderBody({ node: makeNode({ usesTypes }) })).includes('Uses'));
    }
  });

  it('is a <ul> list of the types, each opening its type detail', () => {
    const opened: string[] = [];
    const elements = section(
      renderBody({
        node: makeNode({ usesTypes: [use(TYPES[0]!), use(TYPES[2]!)] }),
        resolveFoldedType: resolveType,
        onOpenType: (id) => opened.push(id),
      }),
      NODE_DETAIL_SECTION_HEADING_IDS.uses,
    );
    const list = elements.find((element) => element.type === 'ul' && element.props.className === 'code-map__node-detail-uses');
    assert.ok(list, 'a <ul>');
    assert.equal(list?.props['aria-label'], 'Types this Node uses');
    assert.deepEqual(visibleItems(elements), ['CodeMapNode', 'Kind']);
    assert.deepEqual(
      buttons(elements).map((button) => button.props['aria-label']),
      ['Open interface CodeMapNode', 'Open type Kind'],
    );
    click(buttons(elements)[0]);
    assert.deepEqual(opened, ['contracts/index.ts::CodeMapNode']);
  });

  it('a type the current map does not have is named neutrally, not a link (and without the props nothing is a link)', () => {
    const stranger: TypeUse = { id: 'gone::X', name: 'X', kind: 'Type' };
    const elements = section(
      renderBody({ node: makeNode({ usesTypes: [stranger] }), resolveFoldedType: resolveType, onOpenType: noop }),
      NODE_DETAIL_SECTION_HEADING_IDS.uses,
    );
    assert.equal(buttons(elements).length, 0);
    assert.equal(TYPE_NOT_ON_CURRENT_MAP, 'Not on the current map');
    assert.equal(byClass(elements, 'code-map__node-detail-type-id')?.props.title, TYPE_NOT_ON_CURRENT_MAP);
    const bare = section(renderBody({ node: makeNode({ usesTypes: [use(TYPES[0]!)] }) }), NODE_DETAIL_SECTION_HEADING_IDS.uses);
    assert.equal(buttons(bare).length, 0);
  });

  it(`lists ${NODE_DETAIL_USES_ROWS}, then "+N more" holding the rest in a second list`, () => {
    const many = Array.from({ length: 11 }, (_, i): TypeUse => ({ id: `t${i}`, name: `T${i}`, kind: 'Type' }));
    const elements = section(renderBody({ node: makeNode({ usesTypes: many }) }), NODE_DETAIL_SECTION_HEADING_IDS.uses);
    assert.deepEqual(visibleItems(elements), ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
    const details = elements.find((element) => element.type === 'details');
    assert.ok(details);
    const inside = renderTree(details.props.children);
    assert.equal(textOf(inside.find((element) => element.type === 'summary')), '+3 more');
    assert.equal(inside.find((element) => element.type === 'ul')?.type, 'ul');
    assert.deepEqual(
      inside.filter((element) => element.type === 'li').map((item) => textOf(item).replaceAll(` (${TYPE_NOT_ON_CURRENT_MAP})`, '')),
      ['T8', 'T9', 'T10'],
    );
  });
});

describe('NodeDetailBody: File top-level types', () => {
  it("shows the file's top-level type uses in the File top-level section, each opening its detail", () => {
    const opened: string[] = [];
    const body = renderBody({
      node: makeNode({ fileTopLevelTypes: [use(TYPES[1]!)] }),
      resolveFoldedType: resolveType,
      onOpenType: (id) => opened.push(id),
    });
    assert.ok(headings(body).includes('File top-level'));
    const elements = section(body, NODE_DETAIL_SECTION_HEADING_IDS.fileTopLevel);
    assert.equal(
      textOf(byClass(elements, 'code-map__node-detail-file-top-level code-map__node-detail-file-top-level-types')),
      'Top-level code in this file uses types: Base',
    );
    click(buttons(elements)[0]);
    assert.deepEqual(opened, ['contracts/index.ts::Base']);
  });
});

function renderTypeBody(overrides: Partial<TypeDetailBodyProps> = {}): RenderedElement[] {
  return renderTree(TypeDetailBody({ type: makeType(), ...overrides }));
}

const MAP_NAMES: Record<string, string> = { 'a::f': 'f', 'b::g': 'g' };
const resolveMapNode = (id: string) => (MAP_NAMES[id] === undefined ? undefined : { name: MAP_NAMES[id]! });

describe('TypeDetailBody', () => {
  it('shows "Used by N functions", each user navigating to that function', () => {
    const navigated: string[] = [];
    const elements = renderTypeBody({
      type: makeType({ usedBy: ['a::f', 'b::g', 'c::hidden'] }),
      resolveMapNode,
      onNavigateToNode: (id) => navigated.push(id),
    });
    assert.deepEqual(headings(elements), ['Used by', 'Location']);
    const usedBy = section(elements, TYPE_DETAIL_SECTION_HEADING_IDS.usedBy);
    assert.equal(textOf(byClass(usedBy, 'code-map__type-detail-used-by-count')), 'Used by 3 functions');
    assert.equal(byClass(usedBy, 'code-map__type-detail-used-by')?.props['aria-label'], 'Used by 3 functions');
    assert.deepEqual(
      buttons(usedBy).map((button) => button.props['aria-label']),
      ['Go to f (uses CodeMapNode)', 'Go to g (uses CodeMapNode)'],
    );
    click(buttons(usedBy)[1]);
    assert.deepEqual(navigated, ['b::g']);
    assert.match(textOf(byClass(usedBy, 'code-map__type-detail-used-by')), /c::hidden/);
    assert.equal(
      textOf(byClass(section(elements, TYPE_DETAIL_SECTION_HEADING_IDS.location), 'code-map__node-detail-location')),
      'contracts/index.ts — lines 940–1003',
    );
  });

  it(`lists ${TYPE_DETAIL_USED_BY_ROWS} users, then "+N more"; users beyond the reply's cap are counted, not dropped`, () => {
    const users = Array.from({ length: 59 }, (_, i) => `u${String(i).padStart(2, '0')}`);
    const usedBy = section(
      renderTypeBody({ type: makeType({ usedBy: users, usedByTotal: 260, usedByKinds: [{ kind: 'Function', count: 260 }] }) }),
      TYPE_DETAIL_SECTION_HEADING_IDS.usedBy,
    );
    assert.equal(textOf(byClass(usedBy, 'code-map__type-detail-used-by-count')), 'Used by 260 functions');
    assert.equal(visible(usedBy).filter((element) => element.type === 'li').length, TYPE_DETAIL_USED_BY_ROWS);
    const details = usedBy.find((element) => element.type === 'details');
    assert.ok(details);
    const inside = renderTree(details.props.children);
    assert.equal(textOf(inside.find((element) => element.type === 'summary')), '+39 more');
    assert.equal(inside.filter((element) => element.type === 'li').length, 39);
    assert.match(textOf(byClass(usedBy, 'code-map__type-detail-used-by-unlisted')), /^201 more not listed here/);
  });

  it('shows each type-link row only when it has entries, as a <ul>, each opening that type', () => {
    const opened: string[] = [];
    const base = 'contracts/index.ts::Base';
    const kind = 'contracts/index.ts::Kind';
    const elements = renderTypeBody({
      type: makeType({ implements: [base], implementedBy: [kind], refersTo: [kind], referencedByTypes: [base] }),
      resolveFoldedType: resolveType,
      onOpenType: (id) => opened.push(id),
    });
    assert.deepEqual(headings(elements), [
      'Used by',
      'Implements',
      'Implemented by / Extended by',
      'Refers to',
      'Referenced by types',
      'Location',
    ]);
    const refersTo = section(elements, TYPE_DETAIL_SECTION_HEADING_IDS.refersTo);
    assert.ok(refersTo.some((element) => element.type === 'ul' && element.props.className === 'code-map__node-detail-uses'));
    assert.deepEqual(visibleItems(refersTo), ['Kind']);
    click(buttons(refersTo)[0]);
    const impl = section(elements, TYPE_DETAIL_SECTION_HEADING_IDS.implements);
    assert.deepEqual(visibleItems(impl), ['Base']);
    click(buttons(impl)[0]);
    assert.deepEqual(visibleItems(section(elements, TYPE_DETAIL_SECTION_HEADING_IDS.implementedBy)), ['Kind']);
    assert.deepEqual(visibleItems(section(elements, TYPE_DETAIL_SECTION_HEADING_IDS.referencedByTypes)), ['Base']);
    assert.deepEqual(opened, [kind, base]);
    assert.deepEqual(headings(renderTypeBody()), ['Used by', 'Location']);
  });

  it('a type nothing uses says so', () => {
    const usedBy = section(renderTypeBody(), TYPE_DETAIL_SECTION_HEADING_IDS.usedBy);
    assert.equal(textOf(byClass(usedBy, 'code-map__type-detail-used-by-count')), 'Used by nothing on the map');
    assert.equal(usedBy.filter((element) => element.type === 'li').length, 0);
  });
});

describe('type detail helpers', () => {
  it('formatUsedByCount names the counted kinds, or stays neutral', () => {
    assert.equal(formatUsedByCount(0), 'Used by nothing on the map');
    assert.equal(formatUsedByCount(1, [{ kind: 'Function', count: 1 }]), 'Used by 1 function');
    assert.equal(formatUsedByCount(59, [{ kind: 'Function', count: 59 }]), 'Used by 59 functions');
    assert.equal(
      formatUsedByCount(59, [
        { kind: 'Function', count: 57 },
        { kind: 'Method' as never, count: 2 },
      ]),
      'Used by 59 (57 functions, 2 methods)',
    );
    assert.equal(formatUsedByCount(59), 'Used by 59');
    assert.equal(formatUsedByCount(5, [{ kind: 'Function', count: 3 }]), 'Used by 5 (3 functions, 2 other)');
  });

  it('TypeDetailHead names the type and its kind, with the close button', () => {
    let closed = false;
    const elements = renderTree(TypeDetailHead({ type: makeType(), onClose: () => (closed = true) }));
    assert.equal(textOf(byClass(elements, 'code-map__node-detail-name')), 'CodeMapNode interface');
    assert.equal(textOf(byClass(elements, 'code-map__node-detail-module')), 'contracts/');
    click(buttons(elements)[0]);
    assert.ok(closed);
  });

  it('openTypeFromDetail checks the type exists before changing anything', () => {
    const calls: string[] = [];
    const handlers = {
      resolveFoldedType: resolveType,
      openTypeDetail: (type: FoldedType) => calls.push(`open:${type.id}`),
      onMissing: () => calls.push('missing'),
    };
    assert.equal(openTypeFromDetail('contracts/index.ts::Base', handlers), true);
    assert.equal(openTypeFromDetail('gone::X', handlers), false);
    assert.deepEqual(calls, ['open:contracts/index.ts::Base', 'missing']);
  });

  it('TypeGoneNotice says the type is no longer on the map', () => {
    assert.equal(TYPE_GONE_NOTICE, 'That type is no longer on the map.');
    assert.match(textOf(renderTree(TypeGoneNotice())[0]), /That type is no longer on the map\./);
  });

  it('navigateFromTypeDetail closes the type detail and the Node detail under it, then navigates', () => {
    const calls: string[] = [];
    navigateFromTypeDetail('a::f', {
      closeTypeDetail: () => calls.push('closeType'),
      closeNodeDetail: () => calls.push('closeNode'),
      navigateToNode: (id) => calls.push(`navigate:${id}`),
    });
    assert.deepEqual(calls, ['closeType', 'closeNode', 'navigate:a::f']);
  });

  it('refreshTypeDetail follows the type to the fresh map, or closes', () => {
    const fresh = makeType({ usedBy: ['a::f'] });
    assert.deepEqual(refreshTypeDetail({ status: 'open', type: makeType() }, [fresh]), { status: 'open', type: fresh });
    assert.deepEqual(refreshTypeDetail({ status: 'open', type: makeType() }, []), { status: 'closed' });
    const closed = { status: 'closed' } as const;
    assert.equal(refreshTypeDetail(closed, [fresh]), closed);
  });

  it('foldedTypeStateAfterRefresh re-points or clears the type detail and the "is a type" notice', () => {
    const open: TypeDetailState = { status: 'open', type: TYPES[0]! };
    const notice: PathTraceState = { status: 'folded-type', query: 'x', types: [TYPES[0]!, TYPES[1]!] };
    const freshBase = { ...TYPES[1]!, usedBy: ['a::f'] };
    const applied = foldedTypeStateAfterRefresh({ kind: 'apply', foldedTypes: [freshBase] }, open, notice);
    assert.deepEqual(applied.typeDetail, { status: 'closed' }, 'its type is gone');
    assert.deepEqual(applied.pathTrace, { status: 'folded-type', query: 'x', types: [freshBase] });
    assert.deepEqual(foldedTypeStateAfterRefresh({ kind: 'apply', foldedTypes: [] }, open, notice).pathTrace, { status: 'idle' });
    const failed = foldedTypeStateAfterRefresh({ kind: 'replace-with-error' }, open, notice);
    assert.deepEqual(failed, { typeDetail: { status: 'closed' }, pathTrace: { status: 'idle' } });
    const kept = foldedTypeStateAfterRefresh({ kind: 'keep-with-error' }, open, notice);
    assert.equal(kept.typeDetail, open);
    assert.equal(kept.pathTrace, notice);
    const found: PathTraceState = { status: 'no-path-found' };
    assert.equal(foldedTypeStateAfterRefresh({ kind: 'replace-with-error' }, open, found).pathTrace, found);
  });

  it('foldedTypeSourceTarget opens its range, labelled by name', () => {
    assert.deepEqual(foldedTypeSourceTarget(makeType()), {
      file: 'contracts/index.ts',
      startLine: 940,
      endLine: 1003,
      label: 'CodeMapNode',
    });
  });
});

describe('resolvePathTraceQuery', () => {
  const nodes = [
    { id: 'src/a.ts::toCodeMapNode', name: 'toCodeMapNode' },
    { id: 'src/b.ts::Kind', name: 'Kind' },
  ];

  it('before the trace: an exact type name or id (case-insensitive) that no map Node has skips the trace', () => {
    assert.deepEqual(resolvePathTraceQuery('CodeMapNode', nodes, TYPES), {
      skipTrace: true,
      state: { status: 'folded-type', query: 'CodeMapNode', types: [TYPES[0]] },
    });
    assert.deepEqual(resolvePathTraceQuery('  codemapnode ', nodes, TYPES), {
      skipTrace: true,
      state: { status: 'folded-type', query: 'codemapnode', types: [TYPES[0]] },
    });
    const byId = resolvePathTraceQuery('contracts/index.ts::Base', nodes, TYPES);
    assert.deepEqual(byId.skipTrace ? byId.state : undefined, { status: 'folded-type', query: 'contracts/index.ts::Base', types: [TYPES[1]] });
  });

  it('before the trace: two types with the same name both go to the chooser, sorted by id', () => {
    const twin = makeType({ id: 'other/x.ts::CodeMapNode', file: 'other/x.ts' });
    const result = resolvePathTraceQuery('CodeMapNode', nodes, [TYPES[0]!, twin]);
    assert.deepEqual(result.skipTrace ? result.state : undefined, {
      status: 'folded-type',
      query: 'CodeMapNode',
      types: [TYPES[0], twin],
    });
  });

  it('before the trace: traces when a map Node matches the same way, or nothing matches exactly', () => {
    assert.deepEqual(resolvePathTraceQuery('Kind', nodes, TYPES), { skipTrace: false });
    assert.deepEqual(resolvePathTraceQuery('CodeMap', nodes, TYPES), { skipTrace: false });
    assert.deepEqual(resolvePathTraceQuery('   ', nodes, TYPES), { skipTrace: false });
    assert.deepEqual(
      resolvePathTraceQuery('src/a.ts::toCodeMapNode', nodes, [makeType({ name: 'src/a.ts::toCodeMapNode' })]),
      { skipTrace: false },
    );
  });

  it('after the trace: only a no-path-found looks for types whose name contains the query', () => {
    const none: PathTraceResult = { status: 'no-path-found' };
    assert.deepEqual(resolvePathTraceQuery('MapNo', nodes, TYPES, none), {
      status: 'folded-type',
      query: 'MapNo',
      types: [TYPES[0]],
    });
    // Several names contain it: a chooser, never a silent first pick.
    const several = resolvePathTraceQuery('a', nodes, TYPES, none);
    assert.deepEqual(several.status === 'folded-type' ? several.types.map((type) => type.name) : undefined, ['Base', 'CodeMapNode']);
    assert.equal(resolvePathTraceQuery('zzz', nodes, TYPES, none), none);
  });

  it('after the trace: found, ambiguous and error pass through unchanged, even when a type name contains the query', () => {
    const found: PathTraceResult = { status: 'found', path: ['n'], parents: { n: null }, depths: { n: 0 } };
    const ambiguous: PathTraceResult = { status: 'ambiguous', candidates: [{ id: 'a', name: 'CodeMapNodeA' }] };
    const error: PathTraceResult = { status: 'error', message: 'down' };
    for (const result of [found, ambiguous, error]) {
      assert.equal(resolvePathTraceQuery('CodeMapNode', nodes, TYPES, result), result);
    }
  });
});

describe('PathTraceFoldedTypeNotice', () => {
  it('one type: "<name> is a type — open its detail", with that action and a Dismiss', () => {
    const opened: string[] = [];
    let dismissed = false;
    const elements = renderTree(
      PathTraceFoldedTypeNotice({
        query: 'CodeMapNode',
        types: [makeType({ kind: 'Type' })],
        onOpenType: (id) => opened.push(id),
        onDismiss: () => (dismissed = true),
      }),
    );
    assert.match(textOf(elements[0]), /CodeMapNode is a type — open its detail\./);
    const [open, dismiss] = buttons(elements);
    assert.equal(textOf(open), 'Open its detail');
    click(open);
    assert.deepEqual(opened, ['contracts/index.ts::CodeMapNode']);
    click(dismiss);
    assert.ok(dismissed);
    const interfaceNotice = renderTree(
      PathTraceFoldedTypeNotice({ query: 'CodeMapNode', types: [makeType()], onOpenType: noop, onDismiss: noop }),
    );
    assert.match(textOf(interfaceNotice[0]), /CodeMapNode is an interface — open its detail\./);
  });

  it('several types: a chooser naming each by file', () => {
    const opened: string[] = [];
    const twin = makeType({ id: 'other/x.ts::CodeMapNode', file: 'other/x.ts' });
    const elements = renderTree(
      PathTraceFoldedTypeNotice({ query: 'CodeMapNode', types: [TYPES[0]!, twin], onOpenType: (id) => opened.push(id), onDismiss: noop }),
    );
    assert.match(textOf(elements[0]), /2 types match CodeMapNode — pick one/);
    const choices = byClass(elements, 'code-map__type-choices');
    assert.equal(choices?.type, 'ul');
    const picks = buttons(elements).filter((button) => String(button.props['aria-label']).startsWith('Open '));
    assert.deepEqual(
      picks.map((button) => button.props['aria-label']),
      ['Open interface CodeMapNode in contracts/index.ts', 'Open interface CodeMapNode in other/x.ts'],
    );
    click(picks[1]);
    assert.deepEqual(opened, ['other/x.ts::CodeMapNode']);
  });
});
