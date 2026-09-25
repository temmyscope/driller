/**
 * P0-3: unit tests for sessionView.ts — the view derivation (one case per row
 * of the spec's I/O & Edge-Case Matrix), the status/open/close transitions
 * that produce `loadedProjectPath`/`dataVersion`, and the map-refresh outcome.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapNode, GraphServiceStatusMessage } from '@driller/ipc-contracts';

import {
  INITIAL_SESSION_MAP_STATE,
  applyBackendSwitchedToSessionMap,
  applyProjectScopeAppliedToSessionMap,
  applyProjectClosedToSessionMap,
  applyProjectOpenedToSessionMap,
  applyStatusToSessionMap,
  deriveSessionView,
  isStatusForCurrentProject,
  resolveRefreshOutcome,
  type SessionAvailability,
  type SessionMapState,
} from './sessionView';

const PROJECT = '/repo/a';
const OTHER = '/repo/b';
const AT = '2026-09-24T00:00:00.000Z';
const LATER = '2026-09-24T00:05:00.000Z';

const status = {
  starting: { state: 'starting', at: AT },
  alive: { state: 'alive', at: AT },
  indexing: { state: 'indexing', at: AT, path: PROJECT },
  indexed: { state: 'indexed', at: AT, path: PROJECT, nodes: 1, edges: 0, elapsedMs: 5 },
  exited: { state: 'exited', at: AT, code: 1 },
  error: { state: 'error', at: AT, message: 'boom' },
} satisfies Record<string, GraphServiceStatusMessage>;

function indexed(path: string, at: string): GraphServiceStatusMessage {
  return { state: 'indexed', at, path, nodes: 1, edges: 0, elapsedMs: 5 };
}

function node(id: string): CodeMapNode {
  return { id } as unknown as CodeMapNode;
}

describe('deriveSessionView', () => {
  it('maps each status to its availability and Retry visibility', () => {
    const expected: Record<keyof typeof status, [SessionAvailability, boolean]> = {
      starting: ['refreshing', false],
      alive: ['refreshing', false],
      indexing: ['refreshing', false],
      indexed: ['live', false],
      exited: ['degraded', true],
      error: ['degraded', true],
    };
    for (const [key, [availability, showRetry]] of Object.entries(expected)) {
      const view = deriveSessionView({
        currentProjectPath: PROJECT,
        loadedProjectPath: PROJECT,
        status: status[key as keyof typeof status],
      });
      assert.equal(view.availability, availability, key);
      assert.equal(view.showRetry, showRetry, key);
    }
  });

  it('treats a missing status with a shown map as refreshing, never degraded', () => {
    const view = deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: PROJECT, status: null });
    assert.deepEqual(view, { showMap: true, availability: 'refreshing', showRetry: false });
  });

  it('crash with map loaded: keeps the map, degraded, Retry shown', () => {
    assert.deepEqual(
      deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: PROJECT, status: status.exited }),
      { showMap: true, availability: 'degraded', showRetry: true },
    );
  });

  it('retry in progress then succeeds: refreshing, then live, map throughout', () => {
    for (const s of [status.starting, status.alive, status.indexing]) {
      assert.deepEqual(
        deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: PROJECT, status: s }),
        { showMap: true, availability: 'refreshing', showRetry: false },
      );
    }
    assert.deepEqual(
      deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: PROJECT, status: status.indexed }),
      { showMap: true, availability: 'live', showRetry: false },
    );
  });

  it('project never indexes: no map, Retry on the pre-load screen', () => {
    assert.deepEqual(
      deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: null, status: status.error }),
      { showMap: false, availability: 'degraded', showRetry: true },
    );
  });

  it('closed project: no map regardless of status', () => {
    for (const s of Object.values(status)) {
      assert.equal(
        deriveSessionView({ currentProjectPath: null, loadedProjectPath: null, status: s }).showMap,
        false,
      );
    }
  });

  it('no current project: no map even if a loaded path lingers', () => {
    assert.equal(
      deriveSessionView({ currentProjectPath: null, loadedProjectPath: PROJECT, status: status.indexed }).showMap,
      false,
    );
  });

  it('reopened project: no map until its fresh indexed sets loadedProjectPath', () => {
    assert.equal(
      deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: null, status: status.indexing }).showMap,
      false,
    );
    assert.equal(
      deriveSessionView({ currentProjectPath: PROJECT, loadedProjectPath: PROJECT, status: status.indexed }).showMap,
      true,
    );
  });

  it('never shows a map loaded for a different project', () => {
    assert.equal(
      deriveSessionView({ currentProjectPath: OTHER, loadedProjectPath: PROJECT, status: status.indexed }).showMap,
      false,
    );
  });
});

describe('isStatusForCurrentProject', () => {
  it('passes path-less statuses and the current project, drops any other path', () => {
    assert.equal(isStatusForCurrentProject(status.exited, null), true);
    assert.equal(isStatusForCurrentProject(status.indexed, PROJECT), true);
    assert.equal(isStatusForCurrentProject(status.indexed, OTHER), false);
  });

  it('drops a late status for a closed project', () => {
    assert.equal(isStatusForCurrentProject(status.indexing, null), false);
    assert.equal(isStatusForCurrentProject(status.indexed, null), false);
  });
});

describe('session map transitions', () => {
  it('a new indexed loads the map and bumps the version once', () => {
    const next = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    assert.equal(next.loadedProjectPath, PROJECT);
    assert.equal(next.dataVersion, 1);
  });

  it('a re-delivered identical indexed does not bump the version', () => {
    const once = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const twice = applyStatusToSessionMap(once, indexed(PROJECT, AT));
    assert.equal(twice, once);
    assert.equal(twice.dataVersion, 1);
  });

  it('each genuinely new indexed for the same project bumps the version exactly once', () => {
    const first = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const second = applyStatusToSessionMap(first, indexed(PROJECT, LATER));
    assert.equal(second.dataVersion, 2);
    assert.equal(second.loadedProjectPath, PROJECT);
  });

  it('non-indexed statuses change nothing', () => {
    const loaded = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    for (const s of [status.starting, status.alive, status.indexing, status.exited, status.error]) {
      assert.equal(applyStatusToSessionMap(loaded, s), loaded);
    }
  });

  it('an A→B switch clears A’s map until B indexes', () => {
    const a = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const opened = applyProjectOpenedToSessionMap(a, OTHER);
    assert.equal(opened.loadedProjectPath, null);
    const b = applyStatusToSessionMap(opened, indexed(OTHER, LATER));
    assert.equal(b.loadedProjectPath, OTHER);
  });

  it('an early indexed for B survives B’s open result', () => {
    const a = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const earlyB = applyStatusToSessionMap(a, indexed(OTHER, LATER));
    const opened = applyProjectOpenedToSessionMap(earlyB, OTHER);
    assert.equal(opened.loadedProjectPath, OTHER);
    assert.equal(opened.dataVersion, earlyB.dataVersion);
  });

  it('re-opening the already-open project keeps its map', () => {
    const a = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    assert.equal(applyProjectOpenedToSessionMap(a, PROJECT), a);
  });

  it('close clears the map; reopening waits for a fresh indexed', () => {
    const a = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const closed: SessionMapState = applyProjectClosedToSessionMap(a);
    assert.equal(closed.loadedProjectPath, null);
    assert.equal(closed.lastIndexedKey, null);
    assert.equal(applyProjectOpenedToSessionMap(closed, PROJECT).loadedProjectPath, null);
    // Even a re-delivery of the pre-close indexed counts as the reopened
    // project's fresh load — the dedupe key was forgotten on close.
    const reloaded = applyStatusToSessionMap(closed, indexed(PROJECT, LATER));
    assert.equal(reloaded.loadedProjectPath, PROJECT);
    assert.equal(reloaded.dataVersion, a.dataVersion + 1);
  });

  it('each reported backend switch with a map loaded bumps dataVersion once', () => {
    const a = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const once = applyBackendSwitchedToSessionMap(a);
    assert.equal(once.dataVersion, a.dataVersion + 1);
    assert.equal(once.loadedProjectPath, PROJECT);
    assert.equal(once.lastIndexedKey, a.lastIndexedKey);
    // A local→cloud→local round trip is two reported switches, two bumps —
    // never netted to "unchanged".
    assert.equal(applyBackendSwitchedToSessionMap(once).dataVersion, a.dataVersion + 2);
  });

  it('a backend switch with no map loaded is a no-op', () => {
    assert.equal(applyBackendSwitchedToSessionMap(INITIAL_SESSION_MAP_STATE), INITIAL_SESSION_MAP_STATE);
  });

  it('an applied scope save with a map loaded bumps dataVersion once, map kept', () => {
    const a = applyStatusToSessionMap(INITIAL_SESSION_MAP_STATE, indexed(PROJECT, AT));
    const next = applyProjectScopeAppliedToSessionMap(a);
    assert.equal(next.dataVersion, a.dataVersion + 1);
    assert.equal(next.loadedProjectPath, PROJECT);
    assert.equal(next.lastIndexedKey, a.lastIndexedKey);
  });

  it('an applied scope save with no map loaded is a no-op', () => {
    assert.equal(applyProjectScopeAppliedToSessionMap(INITIAL_SESSION_MAP_STATE), INITIAL_SESSION_MAP_STATE);
  });
});

describe('resolveRefreshOutcome', () => {
  const ok = { kind: 'ok' as const, nodes: [node('n1'), node('n2')], edges: [] };

  it('ignores a reply superseded by a newer load or refresh', () => {
    assert.deepEqual(
      resolveRefreshOutcome({ requestId: 1, latestRequestId: 2, reply: ok, hasReadyData: true, openDetailNodeId: null }),
      { kind: 'ignore' },
    );
    assert.deepEqual(
      resolveRefreshOutcome({
        requestId: 1,
        latestRequestId: 2,
        reply: { kind: 'failed', message: 'x' },
        hasReadyData: true,
        openDetailNodeId: null,
      }),
      { kind: 'ignore' },
    );
  });

  it('ok with Node Detail closed: new data, detail unchanged', () => {
    assert.deepEqual(
      resolveRefreshOutcome({ requestId: 3, latestRequestId: 3, reply: ok, hasReadyData: true, openDetailNodeId: null }),
      { kind: 'apply', nodes: ok.nodes, edges: [], nodeDetail: { kind: 'unchanged' } },
    );
  });

  it('ok with Node Detail open on a surviving Node: re-pointed at the fresh copy', () => {
    const outcome = resolveRefreshOutcome({
      requestId: 3,
      latestRequestId: 3,
      reply: ok,
      hasReadyData: true,
      openDetailNodeId: 'n2',
    });
    assert.equal(outcome.kind, 'apply');
    assert.deepEqual(outcome.kind === 'apply' && outcome.nodeDetail, { kind: 'repoint', node: ok.nodes[1] });
  });

  it('ok with Node Detail open on a vanished Node: closed', () => {
    const outcome = resolveRefreshOutcome({
      requestId: 3,
      latestRequestId: 3,
      reply: ok,
      hasReadyData: true,
      openDetailNodeId: 'gone',
    });
    assert.deepEqual(outcome.kind === 'apply' && outcome.nodeDetail, { kind: 'close' });
  });

  it('failure with a completed map on screen keeps it and reports the error', () => {
    assert.deepEqual(
      resolveRefreshOutcome({
        requestId: 3,
        latestRequestId: 3,
        reply: { kind: 'failed', message: 'down' },
        hasReadyData: true,
        openDetailNodeId: 'n1',
      }),
      { kind: 'keep-with-error', message: 'down' },
    );
  });

  it('failure with no completed map falls back to the full error state', () => {
    assert.deepEqual(
      resolveRefreshOutcome({
        requestId: 3,
        latestRequestId: 3,
        reply: { kind: 'failed', message: 'down' },
        hasReadyData: false,
        openDetailNodeId: null,
      }),
      { kind: 'replace-with-error', message: 'down' },
    );
  });
});
