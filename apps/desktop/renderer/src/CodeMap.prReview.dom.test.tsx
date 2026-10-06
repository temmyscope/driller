/**
 * P4-8e: the PR Review metrics table's wiring inside `CodeMap`, rendered for
 * real (jsdom, a fake `window.driller`) — replacing the P4-3 source pins on
 * `CodeMap.tsx` and the `topLevelHooks` dependency-array parser. Each test
 * drives what a user drives (the base ref, the depth stepper, the mode, a
 * header sort, a row, the divider) and asserts what the user and the IPC
 * boundary see: the rows, the canvas highlight, the caption, focus, the
 * dialogs, the inline table height and the recorded `window.driller` calls.
 *
 * The fixture (`prReviewMap`, `prReviewDiffScope`, `prReviewBlastRadius`):
 * `path-trace-basic` with risk signals; the diff changed `repository`; its
 * blast radius reaches `serviceA`, `serviceB`, `cacheLookup` (1 hop),
 * `handleRequest` (2) and `helperA` (3). The stepper starts at 2.
 */
import './test/domEnv';
import { assertSameElement, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { Profiler, type ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BlastRadiusExpansionResult, CodeMapResult, DiffScopeResult } from '@driller/ipc-contracts';
import { CodeMap, METRICS_TABLE_DRAGGING_ATTRIBUTE, type CodeMapProps } from './CodeMap';
import { createFakeDrillerApi, deferred, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import {
  FIXTURE_NODES,
  FIXTURE_PROJECT_PATH,
  PR_REVIEW_CONTRACT,
  PR_REVIEW_HOPS,
  prReviewBlastRadius,
  prReviewDiffScope,
  prReviewMap,
} from './test/mapFixture';

afterEach(cleanupAfterEach);

/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const N = FIXTURE_NODES;

/** The rows in the default order at each depth: changed first, then hop, blast radius descending, id. */
const DEFAULT_ROWS = {
  1: [N.repository.id, N.serviceB.id, N.cacheLookup.id, N.serviceA.id],
  2: [N.repository.id, N.serviceB.id, N.cacheLookup.id, N.serviceA.id, N.handleRequest.id],
  3: [N.repository.id, N.serviceB.id, N.cacheLookup.id, N.serviceA.id, N.handleRequest.id, N.helperA.id],
} as const;
/** Sorted by complexity, descending (`—` last): 42, 20, 5, 3, then serviceB with none. */
const BY_COMPLEXITY_AT_2 = [N.repository.id, N.handleRequest.id, N.cacheLookup.id, N.serviceA.id, N.serviceB.id];

function prReviewFake(stubs: DrillerStubs = {}): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async () => prReviewMap(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
    computeDiffScope: async () => prReviewDiffScope(),
    expandBlastRadius: async () => prReviewBlastRadius(),
    ...stubs,
  });
  fake.install();
  return fake;
}

function props(overrides: Partial<CodeMapProps> = {}): CodeMapProps {
  const noop = () => {};
  return {
    projectPath: FIXTURE_PROJECT_PATH,
    noSummaryBackendAvailable: false,
    cloudSelectedNoKey: false,
    mode: 'prReview',
    onRequestCodeMapMode: noop,
    graphServiceAvailable: true,
    dataVersion: 0,
    onMapState: noop,
    onDiffScopeSynced: noop,
    onOpenSettings: noop,
    onReindex: async () => true,
    onSwitchSection: noop,
    ...overrides,
  };
}

/** Every `window.driller` call so far, as `member:count` — a step, a sort or a mode toggle must leave it unchanged. */
function ipcCalls(fake: FakeDrillerApi): string[] {
  return Object.entries(fake.calls)
    .filter(([name, calls]) => !name.startsWith('on') && calls.length > 0)
    .map(([name, calls]) => `${name}:${calls.length}`);
}

function drawnIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'))
    .sort();
}

function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

/** Waits until every fixture Node is drawn as a card, measuring the (re)mounted canvas meanwhile. */
async function waitForMap(): Promise<void> {
  const all = Object.values(N)
    .map((node) => node.id)
    .sort();
  await waitFor(() => {
    measure();
    assert.deepEqual(drawnIds(), all);
  }, FIND);
}

/** Types `baseRef` and presses "Compute diff scope", in `act` so the replies it starts land inside it. */
async function computeDiffScope(baseRef = 'main'): Promise<void> {
  const input = await screen.findByRole('textbox', { name: 'Base ref' }, FIND);
  await act(async () => {
    fireEvent.change(input, { target: { value: baseRef } });
    fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
  });
}

function table(): HTMLElement | null {
  return document.querySelector<HTMLElement>('section.code-map__metrics-table');
}

/** The table's Node rows' ids, in the order shown (each node cell's `title`). */
function rowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('tr.code-map__metrics-table-row > th[title]')].map(
    (cell) => cell.getAttribute('title') ?? '',
  );
}

function affectedRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('tr.code-map__metrics-table-row:not(.code-map__metrics-table-row--changed) > th[title]')]
    .map((cell) => cell.getAttribute('title') ?? '')
    .sort();
}

function changedRowIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('tr.code-map__metrics-table-row--changed > th[title]')]
    .map((cell) => cell.getAttribute('title') ?? '')
    .sort();
}

/** The canvas Nodes lit as the blast radius. */
function litIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node.code-map__blast-radius-highlight')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .sort();
}

/** The canvas cards marked changed. */
function changedCardIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
    .filter((node) => node.querySelector('.code-map__node--changed') !== null)
    .map((node) => node.getAttribute('data-id') ?? '')
    .sort();
}

async function waitForRows(ids: readonly string[]): Promise<void> {
  await waitFor(() => assert.deepEqual(rowIds(), [...ids]), FIND);
}

function depthLabel(): string {
  return document.querySelector('.code-map__blast-radius-stepper-depth')?.textContent ?? '';
}

function stepDeeper(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Expand the blast radius further' }));
}

function stepShallower(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Show a shallower blast radius' }));
}

/** A header's sort button (its name also carries the bar note). */
function sortButton(label: RegExp): HTMLElement {
  return within(table()!).getByRole('button', { name: label });
}

function sortedColumn(): string | null {
  const header = table()?.querySelector('th[aria-sort]');
  return header === null || header === undefined ? null : `${header.textContent?.split(' (')[0]?.replace(/[↑↓]/, '').trim()} ${header.getAttribute('aria-sort')}`;
}

/** Mounts PR Review, computes the diff scope and waits for the table at the starting depth (2). */
async function openTable(fake: FakeDrillerApi, overrides: Partial<CodeMapProps> = {}) {
  const view = render(<CodeMap {...props(overrides)} />);
  await waitForMap();
  await computeDiffScope();
  await waitForRows(DEFAULT_ROWS[2]);
  assert.equal(fake.calls.expandBlastRadius.length, 1);
  return view;
}

describe('PR Review: the depth stepper slices one blast radius (replaces the shared-slice and memo pins)', () => {
  it('at each depth the canvas lights exactly the table’s affected rows, with no IPC call per step', BUDGET, async () => {
    const fake = prReviewFake();
    await openTable(fake);
    assert.deepEqual(fake.calls.expandBlastRadius, [[FIXTURE_PROJECT_PATH, [N.repository.id], undefined]]);
    const before = ipcCalls(fake);

    const expect = (depth: 1 | 2 | 3) => {
      assert.deepEqual(rowIds(), [...DEFAULT_ROWS[depth]], `rows at depth ${depth}`);
      assert.deepEqual(litIds(), affectedRowIds(), `the canvas highlight is the affected rows at depth ${depth}`);
      assert.deepEqual(changedCardIds(), changedRowIds(), 'the changed card is the changed row');
      assert.equal(depthLabel(), depth === 1 ? '1-hop' : `${depth}-hops`);
    };
    expect(2);
    stepShallower();
    expect(1);
    stepDeeper();
    expect(2);
    stepDeeper();
    expect(3);
    assert.deepEqual(litIds(), Object.keys(PR_REVIEW_HOPS).sort(), 'depth 3: the whole blast radius');
    assert.deepEqual(ipcCalls(fake), before, 'a step makes no window.driller call');
  });
});

describe('PR Review: while the blast radius computes (replaces the loading-caption pin)', () => {
  it('the table shows the changed row, and its caption and the toolbar both say "Computing blast radius…"', BUDGET, async () => {
    const reply = deferred<BlastRadiusExpansionResult>();
    prReviewFake({ expandBlastRadius: () => reply.promise });
    render(<CodeMap {...props()} />);
    await waitForMap();
    await computeDiffScope();
    await waitForRows([N.repository.id]);
    const caption = table()!.querySelector('caption')!;
    assert.match(caption.textContent ?? '', /Computing blast radius…$/);
    assert.notEqual(caption.className, 'visually-hidden', 'the caption shows while loading');
    const toolbarLine = screen.getAllByRole('status').find((line) => line.textContent === 'Computing blast radius…');
    assert.ok(toolbarLine, 'the toolbar line has the same wording');
    assert.deepEqual(litIds(), []);

    await act(async () => reply.resolve(prReviewBlastRadius()));
    await waitForRows(DEFAULT_ROWS[2]);
    assert.doesNotMatch(table()!.textContent ?? '', /Computing blast radius/);
    assert.equal(screen.queryByText('Computing blast radius…'), null);
  });
});

describe('PR Review: a mode toggle keeps the table (replaces the topLevelHooks mode pins)', () => {
  it('PR Review → Code Map → PR Review keeps the rows, the depth and the sort, with no new IPC call', BUDGET, async () => {
    const fake = prReviewFake();
    const { rerender } = await openTable(fake);
    stepDeeper();
    fireEvent.click(sortButton(/^complexity/));
    const sorted = rowIds();
    assert.deepEqual(sorted, [N.repository.id, N.handleRequest.id, N.cacheLookup.id, N.serviceA.id, N.helperA.id, N.serviceB.id]);
    const before = ipcCalls(fake);

    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    assert.equal(table(), null, 'no table outside PR Review');
    assert.deepEqual(litIds(), [], 'no blast-radius highlight outside PR Review');
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);

    await waitForRows(sorted);
    assert.equal(depthLabel(), '3-hops');
    assert.equal(sortedColumn(), 'complexity descending');
    assert.deepEqual(litIds(), affectedRowIds());
    assert.deepEqual(ipcCalls(fake), before, 'no re-expansion, no refetch');
  });

  it('a diff that resolves while away expands once on the way back — and never again on a step', BUDGET, async () => {
    const diff = deferred<DiffScopeResult>();
    const fake = prReviewFake({ computeDiffScope: () => diff.promise });
    const { rerender } = render(<CodeMap {...props()} />);
    await waitForMap();
    await computeDiffScope();
    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    await act(async () => diff.resolve(prReviewDiffScope()));
    assert.equal(fake.calls.expandBlastRadius.length, 0, 'not outside PR Review');

    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    await waitForRows(DEFAULT_ROWS[2]);
    assert.equal(fake.calls.expandBlastRadius.length, 1);
    stepShallower();
    stepDeeper();
    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    await waitForRows(DEFAULT_ROWS[2]);
    assert.equal(fake.calls.expandBlastRadius.length, 1, 'only from an idle blast radius');
  });
});

describe('PR Review: the sort (replaces the sort-wiring and sort-reset pins)', () => {
  it('a header sort reorders the rows locally — no IPC call — and announces itself', BUDGET, async () => {
    const fake = prReviewFake();
    await openTable(fake);
    const before = ipcCalls(fake);
    fireEvent.click(sortButton(/^complexity/));
    assert.deepEqual(rowIds(), BY_COMPLEXITY_AT_2);
    assert.equal(sortedColumn(), 'complexity descending');
    assert.ok(within(table()!).getByText('Sorted by complexity, descending.'));
    fireEvent.click(sortButton(/^complexity/));
    assert.equal(sortedColumn(), 'complexity ascending');
    assert.deepEqual(rowIds(), [N.serviceA.id, N.cacheLookup.id, N.handleRequest.id, N.repository.id, N.serviceB.id]);
    assert.deepEqual(ipcCalls(fake), before, 'a sort is never a fetch');
  });

  it('survives everything but a new diff scope: a depth step, a mode toggle, Node detail, the Graph Service going down and back', BUDGET, async () => {
    const fake = prReviewFake();
    const { rerender } = await openTable(fake);
    fireEvent.click(sortButton(/^complexity/));
    const kept = () => assert.equal(sortedColumn(), 'complexity descending');

    stepDeeper();
    kept();
    assert.deepEqual(rowIds(), [N.repository.id, N.handleRequest.id, N.cacheLookup.id, N.serviceA.id, N.helperA.id, N.serviceB.id], 'the new row lands where the sort puts it');
    stepShallower();
    kept();
    assert.deepEqual(rowIds(), BY_COMPLEXITY_AT_2);

    rerender(<CodeMap {...props({ mode: 'codeMap' })} />);
    rerender(<CodeMap {...props({ mode: 'prReview' })} />);
    await waitForRows(BY_COMPLEXITY_AT_2);
    kept();

    fireEvent.click(within(table()!).getByRole('button', { name: /^repository/ }));
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.repository.name}` }, FIND);
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    kept();

    rerender(<CodeMap {...props({ graphServiceAvailable: false })} />);
    rerender(<CodeMap {...props({ graphServiceAvailable: true })} />);
    kept();
    assert.deepEqual(rowIds(), BY_COMPLEXITY_AT_2);
  });

  /** Sorts by complexity, runs `reset`, recomputes the diff scope, and expects the default order. */
  async function sortThenReset(fake: FakeDrillerApi, reset: (rerender: (ui: ReactElement) => void) => Promise<void>) {
    const { rerender } = await openTable(fake);
    fireEvent.click(sortButton(/^complexity/));
    assert.deepEqual(rowIds(), BY_COMPLEXITY_AT_2);
    await reset(rerender);
    await waitFor(() => assert.equal(table(), null, 'the reset drops the diff scope'), FIND);
    await computeDiffScope('develop');
    await waitForRows(DEFAULT_ROWS[2]);
    assert.equal(sortedColumn(), null, 'the default order: no aria-sort');
  }

  it('a new base ref opens in the default order', BUDGET, async () => {
    const fake = prReviewFake();
    await openTable(fake);
    fireEvent.click(sortButton(/^complexity/));
    await computeDiffScope('develop');
    await waitForRows(DEFAULT_ROWS[2]);
    assert.equal(sortedColumn(), null);
    assert.deepEqual(
      fake.calls.computeDiffScope.map(([, baseRef]) => baseRef),
      ['main', 'develop'],
    );
  });

  it('a project change resets it', BUDGET, async () => {
    const fake = prReviewFake();
    await sortThenReset(fake, async (rerender) => {
      rerender(<CodeMap {...props({ projectPath: '/work/other' })} />);
    });
  });

  it('a re-index (a new data version, refreshed in place) resets it', BUDGET, async () => {
    const fake = prReviewFake();
    await sortThenReset(fake, async (rerender) => {
      rerender(<CodeMap {...props({ dataVersion: 1 })} />);
      await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 2), FIND);
    });
  });

  it('a failed refresh’s Retry resets it', BUDGET, async () => {
    let fail = false;
    const fake = prReviewFake({
      getCodeMap: async () => {
        if (fail) {
          fail = false;
          return { status: 'error', message: 'index unavailable' } satisfies CodeMapResult;
        }
        return prReviewMap();
      },
    });
    const { rerender } = await openTable(fake);
    fail = true;
    rerender(<CodeMap {...props({ dataVersion: 1 })} />);
    await screen.findByRole('button', { name: 'Retry the map refresh' }, FIND);
    await computeDiffScope('main');
    await waitForRows(DEFAULT_ROWS[2]);
    fireEvent.click(sortButton(/^complexity/));
    fireEvent.click(screen.getByRole('button', { name: 'Retry the map refresh' }));
    await waitFor(() => assert.equal(table(), null), FIND);
    await waitFor(() => assert.equal(screen.queryByRole('button', { name: 'Retry the map refresh' }), null), FIND);
    await computeDiffScope('develop');
    await waitForRows(DEFAULT_ROWS[2]);
    assert.equal(sortedColumn(), null);
  });

  it('a map reload (a section switch) resets it', BUDGET, async () => {
    const fake = prReviewFake({
      getCodeMap: async (section) => ({ ...prReviewMap(), section: section ?? null }),
      checkDiffScopeCarry: async () => ({ status: 'not-carried' }),
    });
    await sortThenReset(fake, async (rerender) => {
      rerender(<CodeMap {...props({ section: 'api' })} />);
      await waitFor(() => assert.deepEqual(fake.calls.getCodeMap.at(-1), ['api']), FIND);
      await waitForMap();
    });
  });
});

describe('PR Review: row activation (replaces the openNodeDetail / openType wiring pins)', () => {
  it('a Node row opens Node detail for that Node, keeps the mode and returns focus to the row on close', BUDGET, async () => {
    const fake = prReviewFake();
    let modeRequests = 0;
    await openTable(fake, { onRequestCodeMapMode: () => (modeRequests += 1) });
    const before = ipcCalls(fake);
    const button = within(table()!).getByRole('button', { name: /^cacheLookup/ });
    // Enter on the focused row button (a click focuses it in a browser).
    button.focus();
    fireEvent.click(button);
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.cacheLookup.name}` }, FIND);
    assert.equal(modeRequests, 0);
    assert.ok(table(), 'still PR Review: the table stays');
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null), FIND);
    assertSameElement(document.activeElement, button, 'focus after closing Node detail');
    assert.deepEqual(ipcCalls(fake), before, 'opening Node detail asks main for nothing');
  });

  it('a row activation is not a canvas activation: an edge click still resolves from the last canvas focus', BUDGET, async () => {
    await openTable(prReviewFake());
    // `serviceA → repository`. With no canvas focus an edge click goes to its
    // target (repository), which becomes the canvas focus; a second click
    // then goes to the other end (serviceA) — a new history entry, so Back
    // turns on. Had the row activation below made `serviceA` the canvas
    // focus, that second click would go back to `repository`: no new entry.
    const back = screen.getByRole('button', { name: 'Back' });
    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await waitFor(() => assert.equal(animating(), false), FIND);
    assert.equal(back.hasAttribute('disabled'), true, 'one entry: nothing to go back to');

    const row = within(table()!).getByRole('button', { name: /^serviceA/ });
    row.focus();
    fireEvent.click(row);
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${N.serviceA.name}` }, FIND);
    fireEvent.click(within(detail).getByRole('button', { name: /close/i }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null), FIND);

    fireEvent.click(await findEdge(N.serviceA.id, N.repository.id));
    await waitFor(() => assert.equal(back.hasAttribute('disabled'), false, 'the edge moved on to serviceA'), FIND);
    await waitFor(() => assert.equal(animating(), false), FIND);
  });

  it('a contract row opens the type detail, as the toolbar’s contract list (still mounted) does', BUDGET, async () => {
    const fake = prReviewFake({ computeDiffScope: async () => prReviewDiffScope({ withContract: true }) });
    render(<CodeMap {...props()} />);
    await waitForMap();
    await computeDiffScope();
    await waitFor(() => assert.ok(table()?.querySelector('tr.code-map__metrics-contract')), FIND);
    const name = `Open the type detail of ${PR_REVIEW_CONTRACT.name}`;
    const toolbar = screen.getByRole('group', { name: 'Changed contracts' });
    assert.ok(within(toolbar).getByRole('button', { name }), 'the toolbar list is mounted beside the table');

    const tableButton = within(table()!).getByRole('button', { name });
    fireEvent.click(tableButton);
    const typeDetail = await screen.findByRole('dialog', { name: `Type detail: ${PR_REVIEW_CONTRACT.name}` }, FIND);
    fireEvent.click(within(typeDetail).getByRole('button', { name: /close/i }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null), FIND);

    // A click on another cell of the contract row does the same.
    fireEvent.click(table()!.querySelector('tr.code-map__metrics-contract td')!);
    await screen.findByRole('dialog', { name: `Type detail: ${PR_REVIEW_CONTRACT.name}` }, FIND);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    await waitFor(() => assert.equal(screen.queryByRole('dialog'), null), FIND);

    fireEvent.click(within(screen.getByRole('group', { name: 'Changed contracts' })).getByRole('button', { name }));
    await screen.findByRole('dialog', { name: `Type detail: ${PR_REVIEW_CONTRACT.name}` }, FIND);
    assert.equal(fake.calls.getCodeMap.length, 1, 'the type comes from the map on screen');
  });
});

describe('PR Review: the divider (replaces the onResize wiring pin)', () => {
  it('a drag sets the table height; the canvas size it deferred is applied once, on release', BUDGET, async () => {
    prReviewFake();
    let commits = 0;
    const onRender = () => {
      commits += 1;
    };
    render(
      <Profiler id="code-map" onRender={onRender}>
        <CodeMap {...props()} />
      </Profiler>,
    );
    await waitForMap();
    await computeDiffScope();
    await waitForRows(DEFAULT_ROWS[2]);
    await act(async () => measure());

    const map = document.querySelector<HTMLElement>('.code-map')!;
    const canvas = document.querySelector<HTMLElement>('.code-map__canvas')!;
    const divider = screen.getByRole('separator', { name: 'Resize metrics table' });
    const height = () => map.style.getPropertyValue('--code-map-table-height');
    assert.equal(height(), '280px', '35% of the 800px map');
    assert.equal(divider.getAttribute('aria-valuenow'), '280');
    const drawnBefore = drawnIds();
    assert.equal(drawnBefore.length, 7);

    commits = 0;
    fireEvent.pointerDown(divider, { pointerId: 1, button: 0, clientY: 500 });
    assert.equal(map.hasAttribute(METRICS_TABLE_DRAGGING_ATTRIBUTE), true);
    fireEvent.pointerMove(divider, { pointerId: 1, clientY: 400 });
    assert.equal(height(), '380px', 'dragging up 100px grows the table');
    assert.equal(divider.getAttribute('aria-valuenow'), '380');
    // The canvas shrinks under the growing table; mid-drag that is deferred.
    act(() => resizeObservers.resizeElement(canvas, 1200, 40));
    assert.equal(commits, 0, 'no React render while dragging');
    assert.deepEqual(drawnIds(), drawnBefore, 'the map still draws for the committed canvas size');

    fireEvent.pointerUp(divider, { pointerId: 1, clientY: 400 });
    assert.equal(map.hasAttribute(METRICS_TABLE_DRAGGING_ATTRIBUTE), false);
    await waitFor(() => assert.notDeepEqual(drawnIds(), drawnBefore, 'the released canvas size reaches the map'), FIND);
    const drawnAfter = drawnIds();
    assert.equal(height(), '380px');

    commits = 0;
    act(() => resizeObservers.resizeElement(canvas, 1200, 40));
    assert.equal(commits, 0, 'applied once: the same size again changes nothing');
    assert.deepEqual(drawnIds(), drawnAfter);

    // The height is the table's own now: a taller map keeps 380px (the
    // untouched default would follow the map, to 350px).
    act(() => resizeObservers.resizeElement(map, 1200, 1000));
    await waitFor(() => assert.equal(divider.getAttribute('aria-valuemax'), '600'), FIND);
    assert.equal(height(), '380px');
    assert.equal(divider.getAttribute('aria-valuenow'), '380');
  });
});

/** The drawn edge `source → target`, measuring the cards first (React Flow draws edges between measured cards). */
async function findEdge(source: string, target: string): Promise<HTMLElement> {
  return waitFor(() => {
    measure();
    const found = [...document.querySelectorAll<HTMLElement>('.react-flow__edge')].find((element) =>
      (element.getAttribute('data-id') ?? '').startsWith(`${source}→${target}:`),
    );
    assert.ok(found, `the edge ${source} → ${target} is drawn`);
    return found;
  }, FIND);
}

function animating(): boolean {
  return [...document.querySelectorAll('*')].some((element) => '__transition' in element);
}
