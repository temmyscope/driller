/**
 * P5-a review round 1 (never a silent reset): when the checkout moved and
 * main re-indexes the open project, the session notice says so — from the
 * `headMoved` main adds to that re-index's statuses — while the map stays
 * mounted and refreshes. The finished notice goes on the next user action;
 * one still re-indexing does not. App with the real `CodeMap` over a fake
 * `window.driller`.
 */
import './test/domEnv';
import { cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GraphServiceStatusMessage, HeadMove, RecentProject } from '@driller/ipc-contracts';
import { App } from './App';
import { createFakeDrillerApi, type FakeDrillerApi } from './test/fakeDrillerApi';
import { sectionedMap } from './test/mapFixture';

afterEach(cleanupAfterEach);

const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const PROJECT = '/work/moved-repo';
const MOVE: HeadMove = { indexedHead: 'a'.repeat(40), currentHead: 'b'.repeat(40) };
const REINDEXING = 'Checkout moved aaaaaaa → bbbbbbb — re-indexing; compute the diff again when it finishes.';
const REINDEXED = 'Checkout moved aaaaaaa → bbbbbbb — re-indexed; compute the diff again.';
const FAILED = "Checkout moved aaaaaaa → bbbbbbb — the re-index didn't complete; use Retry, then compute the diff again.";

const recent: RecentProject = { path: PROJECT, name: 'moved-repo', lastOpenedAt: '2026-10-15T09:00:00.000Z' };

let tick = 0;
const at = () => new Date(Date.UTC(2026, 9, 15, 10, 0, (tick += 1))).toISOString();
const indexing = (headMoved?: HeadMove): GraphServiceStatusMessage => ({ state: 'indexing', path: PROJECT, at: at(), ...(headMoved ? { headMoved } : {}) });
const indexed = (headMoved?: HeadMove): GraphServiceStatusMessage => ({
  state: 'indexed',
  path: PROJECT,
  at: at(),
  nodes: 4,
  edges: 3,
  elapsedMs: 1_000,
  ...(headMoved ? { headMoved } : {}),
});

function appFake(): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    listRecentProjects: async () => [recent],
    getBackendConfig: async () => ({ activeBackend: 'local', hasCloudKey: false, isLinuxInsecureBackend: false }),
    openFolder: async () => ({ status: 'opened', project: recent, git: { isGitRepo: true } }),
    getActiveSection: async () => null,
    getProjectScope: async () => ({ includedPaths: [] }),
    getCodeMap: async () => sectionedMap(null),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
  });
  fake.install();
  return fake;
}

const drawnCount = () => document.querySelectorAll('.react-flow__node[data-id]').length;

async function openAndIndex(fake: FakeDrillerApi): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Open a folder' }, FIND));
  await screen.findByRole('button', { name: 'Close project' }, FIND);
  fake.emit.onGraphServiceStatus(indexed());
  await waitFor(() => {
    resizeObservers.resizeAll(elementSize.width, elementSize.height);
    assert.ok(drawnCount() > 0, 'a map is drawn');
  }, FIND);
}

/** The session notice region (always mounted with the map). */
function sessionNotice(): HTMLElement {
  const region = document.querySelector<HTMLElement>('.session-notice[role="status"]');
  assert.ok(region, 'the session notice region is mounted');
  return region;
}

const shows = (text: string) => (sessionNotice().textContent ?? '').includes(text);

describe('App: the checkout-moved notice (P5-a review round 1)', () => {
  it('a HEAD-triggered re-index says why, keeps the map, refreshes it, and the finished notice goes on the next user action', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);
    const fetches = fake.calls.getCodeMap.length;

    act(() => fake.emit.onGraphServiceStatus(indexing(MOVE)));
    await waitFor(() => assert.ok(shows(REINDEXING), sessionNotice().textContent ?? ''), FIND);
    assert.ok(drawnCount() > 0, 'the map stays mounted');
    // A user action mid re-index keeps it.
    fireEvent.keyDown(window, { key: 'a' });
    assert.ok(shows(REINDEXING));

    act(() => fake.emit.onGraphServiceStatus(indexed(MOVE)));
    await waitFor(() => assert.ok(shows(REINDEXED), sessionNotice().textContent ?? ''), FIND);
    await waitFor(() => assert.ok(fake.calls.getCodeMap.length > fetches, 'the map was refetched'), FIND);
    assert.ok(!shows(REINDEXING));

    fireEvent.pointerDown(window);
    await waitFor(() => assert.ok(!shows('Checkout moved'), 'cleared by the next user action'), FIND);
  });

  it('a failed HEAD-triggered re-index says so; an ordinary re-index shows no checkout notice', BUDGET, async () => {
    const fake = appFake();
    render(<App />);
    await openAndIndex(fake);

    act(() => fake.emit.onGraphServiceStatus(indexing(MOVE)));
    await waitFor(() => assert.ok(shows(REINDEXING)), FIND);
    act(() =>
      fake.emit.onGraphServiceStatus({ state: 'error', path: PROJECT, at: at(), message: 'backend down', elapsedMs: 10, headMoved: MOVE }),
    );
    await waitFor(() => assert.ok(shows(FAILED), sessionNotice().textContent ?? ''), FIND);

    act(() => fake.emit.onGraphServiceStatus(indexing()));
    await waitFor(() => assert.ok(!shows('Checkout moved'), 'a re-index for another reason'), FIND);
    act(() => fake.emit.onGraphServiceStatus(indexed()));
    await waitFor(() => assert.ok(!shows('Checkout moved')), FIND);
  });
});
