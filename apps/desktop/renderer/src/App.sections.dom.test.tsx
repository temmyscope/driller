/**
 * P4-8d: App's section wiring, rendered for real — `App` mounting the real
 * `CodeMap` in jsdom over a fake `window.driller` — replacing the P4-4 source
 * pins on `App.tsx` (and the one on `Settings.tsx`). Every test opens a
 * two-section project (`api`, `web`) the way a user does: "Open a folder"
 * (or a Recent Projects entry), then the Graph Service's `indexed` status.
 * It asserts what the user and the IPC boundary see: the recorded
 * `getActiveSection`/`getCodeMap(section)`/`setActiveSection` calls, the
 * Section bar, the status regions' text and identity, and focus.
 *
 * - The remembered section (P4-4i): read before `CodeMap` mounts, so the
 *   first fetch carries it; read again on every open; a failed read (or a
 *   failure anywhere in the restore) still opens, in `all`; every section
 *   change saves once, after its map lands; a scope save re-validates with
 *   the persisted allowlist.
 * - The Section bar (P4-4d): only with 2+ applied entries from the reply,
 *   disabled while the Graph Service is degraded, announced in one
 *   always-mounted status region; the fallback when a section is gone.
 * - The cross-section footer line and the Node detail switch (P4-4h).
 * - An open from Recent Projects resets mode and section (P4-4i round 1).
 */
import './test/domEnv';
import { animatingElements, cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CodeMapResult, GraphServiceStatusMessage, RecentProject } from '@driller/ipc-contracts';
import { App } from './App';
import { createFakeDrillerApi, deferred, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import { SECTION_NODES, sectionedMap, type SectionName } from './test/mapFixture';

// `cleanupAfterEach` also lets a viewport animation still running finish (bounded) before the unmount.
afterEach(cleanupAfterEach);

/** Never `assert.equal(element, null)`: a failing diff of a jsdom element takes minutes (it looks like a hang). */
function assertAbsent(element: Element | null | undefined, what: string): void {
  assert.ok(element === null || element === undefined, `${what} is absent`);
}


/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const S = SECTION_NODES;

const PROJECT = '/work/two-sections';
const OTHER = '/work/other-app';

function recent(path: string): RecentProject {
  return { path, name: path.split('/').at(-1)!, lastOpenedAt: '2026-10-05T09:00:00.000Z' };
}

let indexedCount = 0;
/** A fresh `indexed` for `path` — each one is a new index (a new `at`), so it loads or refreshes the map. */
function indexed(path: string = PROJECT): GraphServiceStatusMessage {
  indexedCount += 1;
  return {
    state: 'indexed',
    path,
    at: new Date(Date.UTC(2026, 9, 6, 10, 0, indexedCount)).toISOString(),
    nodes: 4,
    edges: 3,
    elapsedMs: 1_000,
  };
}

interface AppFakeOptions {
  /** What `getActiveSection` answers: a value, or a function per call. */
  saved?: string | null | ((projectPath: string) => Promise<string | null>);
  /** The persisted allowlist `getProjectScope` answers. */
  scope?: string[];
  /** Projects already in Recent Projects (the open project is, so it lands in Code Map Mode). */
  recents?: RecentProject[];
  stubs?: DrillerStubs;
}

function appFake({ saved = null, scope = ['api', 'web'], recents = [recent(PROJECT)], stubs = {} }: AppFakeOptions = {}): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    listRecentProjects: async () => recents,
    getBackendConfig: async () => ({ activeBackend: 'local', hasCloudKey: false, isLinuxInsecureBackend: false }),
    openFolder: async () => ({ status: 'opened', project: recent(PROJECT), git: { isGitRepo: true } }),
    openRecentProject: async (path) => ({ status: 'opened', project: recent(path), git: { isGitRepo: true } }),
    getActiveSection: typeof saved === 'function' ? saved : async () => saved,
    getProjectScope: async () => ({ includedPaths: scope }),
    setActiveSection: async (_projectPath, section) => section,
    getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
    ...stubs,
  });
  fake.install();
  return fake;
}

/** Clicks "Open a folder" and lets the open land. */
async function openFolder(fake: FakeDrillerApi): Promise<void> {
  const before = fake.calls.openFolder.length;
  fireEvent.click(await screen.findByRole('button', { name: 'Open a folder' }, FIND));
  await screen.findByRole('button', { name: 'Close project' }, FIND);
  assert.equal(fake.calls.openFolder.length, before + 1);
}

/** The Graph Service reports `path` indexed: the map body replaces the landing screen. */
function reportIndexed(fake: FakeDrillerApi, path: string = PROJECT): void {
  fake.emit.onGraphServiceStatus(indexed(path));
}

/** Opens the project and its index, and waits for its first map. */
async function openAndIndex(fake: FakeDrillerApi): Promise<void> {
  await openFolder(fake);
  reportIndexed(fake);
  await waitForMap();
}

function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

function drawnIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'))
    .sort();
}

/**
 * Waits for a drawn map (exactly `ids`, when given), reporting the canvas's
 * size as a browser does once it mounts — `CodeMap`'s LOD pass folds Nodes
 * into clusters until its own observer has a size.
 */
async function waitForMap(ids?: readonly string[]): Promise<void> {
  await waitFor(() => {
    measure();
    const drawn = drawnIds();
    if (ids === undefined) {
      assert.ok(drawn.length > 0, 'a map is drawn');
    } else {
      assert.deepEqual(drawn, [...ids].sort());
    }
  }, FIND);
}

const API_IDS = [S.handler.id, S.validate.id];
const WEB_IDS = [S.render.id, S.layout.id];
const ALL_IDS = [...API_IDS, ...WEB_IDS];

function tablist(): HTMLElement | null {
  return screen.queryByRole('tablist', { name: 'Section' });
}

function tab(name: 'all' | SectionName): HTMLElement {
  return screen.getByRole('tab', { name: `${name}, ${name === 'all' ? 4 : 2} Nodes` });
}

function selectedTab(): string | undefined {
  return screen.queryAllByRole('tab').find((element) => element.getAttribute('aria-selected') === 'true')?.getAttribute('aria-label') ?? undefined;
}

/** App's one section-switch status region: the visually hidden `role="status"` paragraph. */
function sectionStatus(): HTMLElement {
  const region = document.querySelector<HTMLElement>('p.visually-hidden[role="status"]');
  assert.ok(region, 'the section status region is mounted');
  return region;
}

/** The footer's cross-section line: the `role="status"` paragraph just before the status line. */
function crossSectionLine(): HTMLElement {
  const statusLine = screen.getByRole('contentinfo', { name: 'Status line' });
  const line = statusLine.previousElementSibling;
  assert.ok(line instanceof HTMLElement && line.tagName === 'P' && line.getAttribute('role') === 'status', 'a status paragraph sits right above the status line');
  return line;
}

function codeMapSections(fake: FakeDrillerApi): (string | undefined)[] {
  return fake.calls.getCodeMap.map(([section]) => section);
}

/** Never `assert.equal` two elements: its failure message diffs both jsdom object graphs, which takes minutes. */
function assertFocused(element: Element | null, what: string): void {
  const active = document.activeElement;
  assert.ok(
    element !== null && active === element,
    `${what} has focus (it is on <${active?.tagName.toLowerCase()} class="${active?.getAttribute('class') ?? ''}">)`,
  );
}

/** Whether a d3 transition (React Flow's animated `setCenter`) is still scheduled or running. */
function viewportAnimating(): boolean {
  return animatingElements().length > 0;
}

/** Waits for React Flow's animated move to a Node to end. */
async function settleViewport(): Promise<void> {
  await waitFor(() => assert.equal(viewportAnimating(), false, 'the viewport is still animating'), FIND);
}

describe('App: the remembered section (replaces the P4-4i App source pins)', () => {
  it('CodeMap waits for the saved section, so the first fetch carries it and the bar selects it', BUDGET, async () => {
    const read = deferred<string | null>();
    const fake = appFake({ saved: () => read.promise });
    render(<App />);
    await openFolder(fake);
    reportIndexed(fake);
    // The map body is up, but `CodeMap` isn't mounted until the read settles.
    await screen.findByRole('region', { name: 'Code Map' }, FIND);
    assert.deepEqual(fake.calls.getActiveSection, [[PROJECT]]);
    assert.equal(document.querySelector('.code-map'), null);
    assert.deepEqual(fake.calls.getCodeMap, []);

    await act(async () => {
      read.resolve('api');
    });
    await waitForMap(API_IDS);
    assert.deepEqual(codeMapSections(fake), ['api'], 'the first fetch asks for the restored section');
    assert.equal(selectedTab(), 'api, 2 Nodes');
    // A restore is quiet, and not written back.
    assert.equal(sectionStatus().textContent, '');
    assert.deepEqual(fake.calls.setActiveSection, []);
  });

  it('a failed read still opens the project, in all, and clears nothing', BUDGET, async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      const fake = appFake({ saved: async () => Promise.reject(new Error('settings store unreadable')) });
      render(<App />);
      await openAndIndex(fake);
      await waitForMap(ALL_IDS);
      assert.deepEqual(codeMapSections(fake), [undefined]);
      assert.equal(selectedTab(), 'all, 4 Nodes');
      assert.deepEqual(fake.calls.setActiveSection, []);
      assert.deepEqual(warnings, ['App: could not read the remembered section.']);
    } finally {
      console.warn = warn;
    }
  });

  it('CodeMap still mounts, in all, when the restore chain itself fails after the read', BUDGET, async () => {
    // `loadSavedSection` never rejects on its own. To reach App's last-resort
    // `.catch`, the warning it logs for the failed read throws once — a
    // failure anywhere in the chain, like a broken preload.
    const warn = console.warn;
    let thrown = false;
    console.warn = (...args: unknown[]) => {
      if (!thrown && String(args[0]).includes('could not read the remembered section')) {
        thrown = true;
        throw new Error('logging failed');
      }
    };
    try {
      const fake = appFake({ saved: async () => Promise.reject(new Error('settings store unreadable')) });
      render(<App />);
      await openAndIndex(fake);
      await waitForMap(ALL_IDS);
      assert.ok(thrown, 'the chain failed');
      assert.deepEqual(codeMapSections(fake), [undefined]);
      assert.equal(selectedTab(), 'all, 4 Nodes');
    } finally {
      console.warn = warn;
    }
  });

  it('a saved section no longer in the allowlist opens in all and is cleared once', BUDGET, async () => {
    const fake = appFake({ saved: 'docs' });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(ALL_IDS);
    assert.deepEqual(codeMapSections(fake), [undefined]);
    assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, null]]);
    assert.equal(sectionStatus().textContent, '');
  });

  it('Close then reopen reads the saved section again, and the reopened map waits for it and asks for it', BUDGET, async () => {
    const secondRead = deferred<string | null>();
    const answers = [Promise.resolve<string | null>('api'), secondRead.promise];
    const fake = appFake({ saved: () => answers.shift() ?? Promise.resolve(null) });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);

    fireEvent.click(screen.getByRole('button', { name: 'Close project' }));
    await screen.findByRole('button', { name: 'Open a folder' }, FIND);
    const fetchesBefore = fake.calls.getCodeMap.length;
    await openFolder(fake);
    reportIndexed(fake);
    await screen.findByRole('region', { name: 'Code Map' }, FIND);
    assert.deepEqual(fake.calls.getActiveSection, [[PROJECT], [PROJECT]], 'read again on reopen');
    assert.equal(fake.calls.getCodeMap.length, fetchesBefore, 'the reopened map waits for the new read');

    await act(async () => {
      secondRead.resolve('web');
    });
    await waitForMap(WEB_IDS);
    assert.deepEqual(codeMapSections(fake).slice(fetchesBefore), ['web'], 'the reopened map’s first fetch');
    assert.equal(selectedTab(), 'web, 2 Nodes');
  });

  it('every section change saves once, only after its map lands', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(ALL_IDS);
    assert.deepEqual(fake.calls.setActiveSection, []);

    // Nothing is saved while the switch waits for its map.
    const apiReply = deferred<CodeMapResult>();
    fake.stub('getCodeMap', (section) =>
      section === 'api' ? apiReply.promise : Promise.resolve(sectionedMap((section ?? null) as SectionName | null)),
    );
    fireEvent.click(tab('api'));
    assert.equal(sectionStatus().textContent, 'Loading section api…');
    assert.deepEqual(fake.calls.setActiveSection, []);
    await act(async () => {
      apiReply.resolve(sectionedMap('api'));
    });
    await waitForMap(API_IDS);
    await waitFor(() => assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, 'api']]), FIND);

    fireEvent.click(tab('web'));
    await waitForMap(WEB_IDS);
    fireEvent.click(tab('all'));
    await waitForMap(ALL_IDS);
    await waitFor(() => assert.equal(sectionStatus().textContent, 'Showing all sections — 4 Nodes'), FIND);
    assert.deepEqual(fake.calls.setActiveSection, [
      [PROJECT, 'api'],
      [PROJECT, 'web'],
      [PROJECT, null],
    ]);
    assert.deepEqual(codeMapSections(fake), [undefined, 'api', 'web', undefined]);
  });

  it('a scope save re-validates the section against the persisted allowlist Settings reports', BUDGET, async () => {
    const saves: string[][] = [];
    const persisted = new Map([
      ['api/, docs', ['api', 'docs']],
      ['web, docs', ['web', 'docs']],
    ]);
    const fake = appFake({
      saved: 'api',
      stubs: {
        getEditorPreference: async () => 'system-default',
        getPrBotConfig: async () => ({ codeRabbitEnabled: false, qodoEnabled: false }),
        setProjectScope: async (_projectPath, includedPaths) => {
          saves.push(includedPaths);
          return { config: { includedPaths: persisted.get(includedPaths.join(', ')) ?? includedPaths }, applied: true };
        },
      },
    });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);

    const saveScope = async (typed: string) => {
      const field = await screen.findByRole('textbox', { name: 'Included subfolders' }, FIND);
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.click(within(field.closest('.settings-panel__field')!).getByRole('button', { name: 'Save' }));
      await waitFor(() => assert.equal(saves.at(-1)?.join(', '), typed.split(',').map((entry) => entry.trim()).join(', ')), FIND);
    };
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    // Typed `api/`, persisted `api`: the section is still in the allowlist.
    await saveScope('api/, docs');
    await waitFor(() => assert.deepEqual(codeMapSections(fake), ['api', 'api']), FIND);
    assert.equal(sectionStatus().textContent, '');
    assert.deepEqual(fake.calls.setActiveSection, []);

    // Persisted without `api`: back to all, said so, and cleared.
    await saveScope('web, docs');
    await waitFor(() => assert.equal(sectionStatus().textContent, 'api is no longer in the indexing scope — showing all sections'), FIND);
    // The section change reloads `all`, and the scope save's refetch asks for it too.
    await waitFor(() => assert.deepEqual(codeMapSections(fake).slice(2), [undefined, undefined]), FIND);
    await waitForMap(ALL_IDS);
    assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, null]]);
  });
});

describe('App: the Section bar (replaces the P4-4d App source pins)', () => {
  it('shows under the header only when the reply applied 2 or more entries', BUDGET, async () => {
    // The persisted allowlist has two entries, but the reply applied one:
    // the bar follows the reply.
    const fake = appFake({ stubs: { getCodeMap: async () => sectionedMap(null, { appliedScope: ['api'], sections: [{ path: 'api', nodeCount: 4 }] }) } });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(ALL_IDS);
    assert.equal(tablist(), null);
    // Without the bar, the map region is a plain labelled region, not a tabpanel.
    assert.ok(screen.getByRole('region', { name: 'Code Map' }));
    assert.equal(screen.queryByRole('tabpanel'), null);
  });

  it('with 2 entries: all, then one tab per section, all selected, right under the header', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);
    const bar = tablist();
    assert.ok(bar);
    assert.deepEqual(
      within(bar).getAllByRole('tab').map((element) => element.getAttribute('aria-label')),
      ['all, 4 Nodes', 'api, 2 Nodes', 'web, 2 Nodes'],
    );
    assert.equal(selectedTab(), 'all, 4 Nodes');
    const header = document.querySelector('header.app__header');
    assert.ok(header?.nextElementSibling?.contains(bar), 'the bar follows the header');
  });

  it('is disabled while the Graph Service is degraded, and a tab does nothing until it is live again', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(ALL_IDS);
    fake.emit.onGraphServiceStatus({ state: 'exited', at: '2026-10-06T10:05:00.000Z', code: 1 });
    const bar = tablist();
    assert.equal(bar?.getAttribute('aria-disabled'), 'true');
    assert.ok(within(bar!).getAllByRole('tab').every((element) => element.getAttribute('aria-disabled') === 'true'));
    assert.ok(screen.getByText('Sections switch once the map is live again'));
    fireEvent.click(tab('api'));
    assert.deepEqual(codeMapSections(fake), [undefined]);
    assert.equal(selectedTab(), 'all, 4 Nodes');

    reportIndexed(fake);
    await waitFor(() => assert.equal(tablist()?.getAttribute('aria-disabled'), null), FIND);
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 2), FIND);
    fireEvent.click(tab('api'));
    await waitForMap(API_IDS);
    assert.deepEqual(codeMapSections(fake), [undefined, undefined, 'api']);
  });

  it('announces each switch in one always-mounted status region', BUDGET, async () => {
    const fake = appFake();
    const reply = deferred<CodeMapResult>();
    fake.stub('getCodeMap', (section) => (section === 'api' ? reply.promise : Promise.resolve(sectionedMap(null))));
    render(<App />);
    await openAndIndex(fake);
    const region = sectionStatus();
    assert.equal(region.textContent, '');

    fireEvent.click(tab('api'));
    assert.ok(region.isConnected && sectionStatus() === region, 'the same region announces the switch');
    assert.equal(region.textContent, 'Loading section api…');
    await act(async () => {
      reply.resolve(sectionedMap('api'));
    });
    await waitForMap(API_IDS);
    assert.ok(sectionStatus() === region);
    assert.equal(region.textContent, 'Showing section api — 2 Nodes');
  });

  it('a saved section the Graph Service rejects at launch falls back to all silently, and is cleared', BUDGET, async () => {
    const fake = appFake({
      saved: 'api',
      stubs: {
        getCodeMap: async (section) =>
          section === 'api' ? { status: 'unknown-section', section: 'api', knownSections: ['web'] } : sectionedMap(null),
      },
    });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(ALL_IDS);
    assert.deepEqual(codeMapSections(fake), ['api', undefined]);
    assert.equal(sectionStatus().textContent, '', 'a stale remembered section never produces a notice (P4-4i)');
    assert.equal(screen.queryByRole('alert'), null);
    assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, null]]);
  });

  it('a picked section the Graph Service rejects falls back to all and says so', BUDGET, async () => {
    const fake = appFake({
      stubs: {
        getCodeMap: async (section) =>
          section === 'web' ? { status: 'unknown-section', section: 'web', knownSections: ['api'] } : sectionedMap((section ?? null) as SectionName | null),
      },
    });
    render(<App />);
    await openAndIndex(fake);
    fireEvent.click(tab('web'));
    await waitFor(() => assert.equal(sectionStatus().textContent, 'web is no longer in the indexing scope — showing all sections'), FIND);
    await waitForMap(ALL_IDS);
    assert.deepEqual(codeMapSections(fake), [undefined, 'web', undefined]);
    assert.equal(selectedTab(), 'all, 4 Nodes');
    assert.equal(screen.queryByRole('alert'), null, 'status text, never an error notice');
    // The rejected section was never saved; only the fallback clears.
    assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, null]]);
  });
});

describe('App: cross-section honesty (replaces the P4-4h App source pins)', () => {
  it('the footer line is one always-mounted status, held through a pending switch and a reload', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);
    const line = crossSectionLine();
    assert.equal(line.textContent, '', 'empty in all');

    // Load path: a section map's reply carries its dropped edges.
    fireEvent.click(tab('api'));
    await waitFor(() => assert.equal(line.textContent, '1 edge into web/, 3 edges from web/ — not shown in this section'), FIND);

    // A pending switch keeps the line.
    const webReply = deferred<CodeMapResult>();
    fake.stub('getCodeMap', (section) => (section === 'web' ? webReply.promise : Promise.resolve(sectionedMap('api'))));
    fireEvent.click(tab('web'));
    assert.equal(sectionStatus().textContent, 'Loading section web…');
    assert.equal(line.textContent, '1 edge into web/, 3 edges from web/ — not shown in this section');
    await act(async () => {
      webReply.resolve(sectionedMap('web'));
    });
    await waitForMap(WEB_IDS);
    assert.equal(line.textContent, '3 edges into api/, 1 edge from api/ — not shown in this section');

    // Refresh path (a new index): held while reloading, then the new counts.
    const refreshed = deferred<CodeMapResult>();
    fake.stub('getCodeMap', () => refreshed.promise);
    reportIndexed(fake);
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 4), FIND);
    assert.equal(line.textContent, '3 edges into api/, 1 edge from api/ — not shown in this section');
    await act(async () => {
      refreshed.resolve(sectionedMap('web', { crossSectionEdges: [{ section: 'api', outgoing: 5, incoming: 0 }] }));
    });
    await waitFor(() => assert.equal(line.textContent, '5 edges into api/ — not shown in this section'), FIND);
    assert.ok(crossSectionLine() === line, 'still the same region');
  });

  it('Node detail’s switch lands on the callee in the new section, once', BUDGET, async () => {
    const fake = appFake({ saved: 'api' });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    fireEvent.click(await screen.findByText(S.handler.name, { selector: '.react-flow__node .code-map__node *' }, FIND));
    const detail = await screen.findByRole('dialog', { name: `Node detail: ${S.handler.name}` }, FIND);
    fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));

    await waitForMap(WEB_IDS);
    const card = () => document.querySelector(`.react-flow__node[data-id="${CSS.escape(S.render.id)}"] .code-map__node`);
    await waitFor(() => assertFocused(card(), 'the render card'), FIND);
    assert.deepEqual(codeMapSections(fake), ['api', 'web']);
    assert.equal(selectedTab(), 'web, 2 Nodes');
    await waitFor(() => assert.equal(sectionStatus().textContent, 'Showing section web — 2 Nodes'), FIND);
    await settleViewport();

    // One-shot: once consumed, a later map of the same section (a new
    // index) doesn't pull focus back to the card.
    const webTab = tab('web');
    act(() => webTab.focus());
    reportIndexed(fake);
    await waitFor(() => assert.equal(fake.calls.getCodeMap.length, 3), FIND);
    await waitForMap(WEB_IDS);
    await settleViewport();
    assertFocused(webTab, 'the web tab');
  });
});

/** In `api`: opens `handler`'s Node detail and presses "Switch to web and show render" (web's map waits on `webReply`). */
async function switchToWebFromDetail(fake: FakeDrillerApi, webReply: Promise<CodeMapResult>): Promise<void> {
  fake.stub('getCodeMap', (section) => (section === 'web' ? webReply : Promise.resolve(sectionedMap((section ?? null) as SectionName | null))));
  fireEvent.click(await screen.findByText(S.handler.name, { selector: '.react-flow__node .code-map__node *' }, FIND));
  const detail = await screen.findByRole('dialog', { name: `Node detail: ${S.handler.name}` }, FIND);
  fireEvent.click(within(detail).getByRole('button', { name: 'Switch to web and show render' }));
}

function renderCard(): Element | null {
  return document.querySelector(`.react-flow__node[data-id="${CSS.escape(S.render.id)}"] .code-map__node`);
}

/** Moves to the web tab and waits for its map; asserts the render card never takes focus from the tab. */
async function webByTabKeepsFocus(fake: FakeDrillerApi): Promise<void> {
  fake.stub('getCodeMap', async (section) => sectionedMap((section ?? null) as SectionName | null));
  const webTab = tab('web');
  act(() => webTab.focus());
  fireEvent.click(webTab);
  await waitForMap(WEB_IDS);
  await settleViewport();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  });
  assert.ok(document.activeElement !== renderCard(), 'the render card never takes focus');
  assertFocused(tab('web'), 'the web tab');
}

describe('App: Node detail’s switch and its pending focus (P4-8l: replaces the App switch-handler pins)', () => {
  it('goes through the Section bar’s path: announced, then saved once its map lands — and the callee is focused', BUDGET, async () => {
    const fake = appFake({ saved: 'api' });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    const webReply = deferred<CodeMapResult>();
    await switchToWebFromDetail(fake, webReply.promise);
    await waitFor(() => assert.equal(sectionStatus().textContent, 'Loading section web…'), FIND);
    assert.equal(selectedTab(), 'web, 2 Nodes');
    assert.deepEqual(fake.calls.setActiveSection, [], 'not saved while the switch waits');
    await act(async () => webReply.resolve(sectionedMap('web')));
    await waitForMap(WEB_IDS);
    await waitFor(() => assertFocused(renderCard(), 'the render card'), FIND);
    await waitFor(() => assert.equal(sectionStatus().textContent, 'Showing section web — 2 Nodes'), FIND);
    assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, 'web']]);
    await settleViewport();
  });

  it('a Section bar tab before the callee’s map lands cancels the focus — for good', BUDGET, async () => {
    const fake = appFake({ saved: 'api' });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    const webReply = deferred<CodeMapResult>();
    await switchToWebFromDetail(fake, webReply.promise);
    fireEvent.click(tab('api'));
    await waitForMap(API_IDS);
    await act(async () => webReply.resolve(sectionedMap('web')));
    await webByTabKeepsFocus(fake);
  });

  it('the section rejected before the callee’s map lands cancels the focus too', BUDGET, async () => {
    const fake = appFake({ saved: 'api' });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    const webReply = deferred<CodeMapResult>();
    await switchToWebFromDetail(fake, webReply.promise);
    await act(async () => webReply.resolve({ status: 'unknown-section', section: 'web', knownSections: ['api'] }));
    await waitFor(() => assert.equal(sectionStatus().textContent, 'web is no longer in the indexing scope — showing all sections'), FIND);
    await waitForMap(ALL_IDS);
    await webByTabKeepsFocus(fake);
  });

  it('a scope save that drops the section cancels the focus as well', BUDGET, async () => {
    const fake = appFake({
      saved: 'api',
      stubs: {
        getEditorPreference: async () => 'system-default',
        getPrBotConfig: async () => ({ codeRabbitEnabled: false, qodoEnabled: false }),
        setProjectScope: async (_projectPath, includedPaths) => ({ config: { includedPaths }, applied: true }),
      },
    });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    const webReply = deferred<CodeMapResult>();
    await switchToWebFromDetail(fake, webReply.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const field = await screen.findByRole('textbox', { name: 'Included subfolders' }, FIND);
    const save = (typed: string) => {
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.click(within(field.closest('.settings-panel__field')!).getByRole('button', { name: 'Save' }));
    };
    save('api');
    await waitFor(() => assert.equal(selectedTab(), 'all, 4 Nodes'), FIND);
    // The section is re-validated first, so the scope save's refetch already asks for all.
    await waitFor(() => assert.deepEqual(codeMapSections(fake).slice(2), [undefined, undefined]), FIND);
    await act(async () => webReply.resolve(sectionedMap('web')));
    save('api, web');
    await waitFor(() => assert.equal(fake.calls.setProjectScope.length, 2), FIND);
    fireEvent.click(document.querySelector<HTMLElement>('.settings-panel__close')!);
    await waitForMap(ALL_IDS);
    await webByTabKeepsFocus(fake);
  });
});

describe('App: the map region and the section shell (P4-8l: replaces the App shell pins)', () => {
  it('while the bar shows, the map region is the tabpanel, named by the selected tab', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(ALL_IDS);
    assert.ok(screen.getByRole('tabpanel', { name: 'all, 4 Nodes' }));
    assertAbsent(screen.queryByRole('region', { name: 'Code Map' }), 'screen.queryByRole(region, { name: Code Map })');
    fireEvent.click(tab('api'));
    await waitForMap(API_IDS);
    const panel = screen.getByRole('tabpanel', { name: 'api, 2 Nodes' });
    assert.ok(panel.contains(document.querySelector('.code-map')), 'the panel holds the map');
    assert.equal(tab('api').getAttribute('aria-controls'), panel.id);
  });

  it('a restored section is what this session saved: going back to all clears it', BUDGET, async () => {
    const fake = appFake({ saved: 'api' });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    fireEvent.click(tab('all'));
    await waitForMap(ALL_IDS);
    await waitFor(() => assert.deepEqual(fake.calls.setActiveSection, [[PROJECT, null]]), FIND);
  });

  it('a read superseded by Close and a reopen is dropped: its late section restores nothing', BUDGET, async () => {
    const firstRead = deferred<string | null>();
    const answers = [firstRead.promise, Promise.resolve<string | null>('web')];
    const fake = appFake({ saved: () => answers.shift() ?? Promise.resolve(null) });
    render(<App />);
    await openFolder(fake);
    reportIndexed(fake);
    fireEvent.click(screen.getByRole('button', { name: 'Close project' }));
    await screen.findByRole('button', { name: 'Open a folder' }, FIND);
    await openAndIndex(fake);
    await waitForMap(WEB_IDS);
    await act(async () => firstRead.resolve('api'));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    });
    assert.deepEqual(codeMapSections(fake), ['web'], 'the late read fetches nothing');
    assert.equal(selectedTab(), 'web, 2 Nodes');
  });

  it('the launch path ends when the restored map lands: a later rejection of that section is said', BUDGET, async () => {
    let refreshed = false;
    const fake = appFake({
      saved: 'api',
      stubs: {
        getCodeMap: async (section) =>
          refreshed && section === 'api'
            ? { status: 'unknown-section', section: 'api', knownSections: ['web'] }
            : sectionedMap((section ?? null) as SectionName | null),
      },
    });
    render(<App />);
    await openAndIndex(fake);
    await waitForMap(API_IDS);
    refreshed = true;
    reportIndexed(fake);
    await waitFor(() => assert.equal(sectionStatus().textContent, 'api is no longer in the indexing scope — showing all sections'), FIND);
    await waitForMap(ALL_IDS);
  });
});

describe('App: an open from Recent Projects (replaces the P4-4i round 1 App source pin)', () => {
  it('resets the mode to the first-open rule and the section to all, even while the previous project is open', BUDGET, async () => {
    // The open project has never been opened before (Health Audit), its
    // saved section is `api`; `other-app` is a known Recent Project.
    const fake = appFake({
      recents: [recent(OTHER)],
      saved: async (projectPath) => (projectPath === PROJECT ? 'api' : null),
    });
    render(<App />);
    await openFolder(fake);
    const modes = screen.getByRole('radiogroup', { name: 'View mode' });
    assert.ok((within(modes).getByRole('radio', { name: 'Health Audit Mode' }) as HTMLInputElement).checked, 'a first open lands in Health Audit');
    fireEvent.click(within(modes).getByRole('radio', { name: 'PR Review Mode' }));
    assert.ok((within(modes).getByRole('radio', { name: 'PR Review Mode' }) as HTMLInputElement).checked);

    // Still indexing, so Recent Projects is on screen.
    const recents = screen.getByRole('region', { name: 'Recent projects' });
    fireEvent.click(within(recents).getByRole('button', { name: /other-app/ }));
    await waitFor(() => assert.deepEqual(fake.calls.openRecentProject, [[OTHER]]), FIND);
    await waitFor(() => assert.ok((within(modes).getByRole('radio', { name: 'Code Map' }) as HTMLInputElement).checked, 'a known project lands in Code Map'), FIND);

    reportIndexed(fake, OTHER);
    await waitForMap(ALL_IDS);
    assert.deepEqual(fake.calls.getActiveSection, [[PROJECT], [OTHER]]);
    assert.deepEqual(codeMapSections(fake), [undefined]);
    assert.equal(selectedTab(), 'all, 4 Nodes');
  });
});
