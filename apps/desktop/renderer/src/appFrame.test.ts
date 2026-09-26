/**
 * P2-3: the shared app frame — one case per row of the spec's I/O &
 * Edge-Case Matrix through `deriveFooterBar`/`deriveTitle`, plus the pure
 * rules feeding it: `mapFooterState`, the frame map-state transitions and
 * `footerAvailability`. The "short window" row is layout only (body scrolls,
 * bars stay put) and is an owed in-app check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiffScopeResult, GraphServiceStatusMessage } from '@driller/ipc-contracts';

import {
  INITIAL_FRAME_MAP_STATE,
  INITIAL_FRAME_SYNC_STATE,
  applyDiffScopeSyncToFrame,
  applyMapReportToFrame,
  applyProjectClosedToFrame,
  applyProjectClosedToFrameSync,
  applyProjectOpenedToFrame,
  applyProjectOpenedToFrameSync,
  deriveFooterBar,
  deriveTitle,
  diffScopeSyncTimeFor,
  footerAvailability,
  footerBarRightTitle,
  formatMapCounts,
  formatSyncAge,
  frameMapFor,
  frameSyncFor,
  mapFooterState,
  nextSyncAgeTickMs,
  SYNC_AGE_MAX_TICK_MS,
  projectFolderName,
  type FooterBarInput,
  type FrameMapState,
  type FrameSyncState,
  type MapFooterState,
} from './appFrame';

const PROJECT = '/Users/dev/code/my-app';
const OTHER = '/Users/dev/code/other';
const AT = '2026-09-25T00:00:00.000Z';

const READY: MapFooterState = { status: 'ready', nodes: 229, edges: 359 };

const NO_PROJECT: FooterBarInput = {
  currentProjectPath: null,
  isOpening: false,
  availability: 'refreshing',
  map: null,
  mode: 'codeMap',
  lastSyncedAt: null,
  now: 0,
};

const OPEN: FooterBarInput = { ...NO_PROJECT, currentProjectPath: PROJECT };

describe('deriveTitle', () => {
  it('names no project on the landing screen', () => {
    assert.equal(deriveTitle({ currentProjectPath: null }), 'driller — no project open');
  });

  it('names the open project by its folder name', () => {
    assert.equal(deriveTitle({ currentProjectPath: PROJECT }), 'driller — my-app');
  });
});

describe('projectFolderName', () => {
  it('matches the Recent Projects name for trailing-separator and Windows paths', () => {
    assert.equal(projectFolderName('/Users/dev/code/my-app/'), 'my-app');
    assert.equal(projectFolderName('C:\\code\\my-app\\'), 'my-app');
  });

  it('never returns an empty name for a filesystem root', () => {
    assert.equal(projectFolderName('/'), '/');
    assert.equal(projectFolderName('C:\\'), 'C:');
  });
});

describe('mapFooterState', () => {
  it('ready: the full Node and edge totals', () => {
    assert.deepEqual(mapFooterState({ status: 'ready', nodes: [1, 2, 3], edges: [1, 2] }), {
      status: 'ready',
      nodes: 3,
      edges: 2,
    });
  });

  it('loading', () => {
    assert.deepEqual(mapFooterState({ status: 'loading' }), { status: 'loading' });
  });

  it('error: no counts', () => {
    assert.deepEqual(mapFooterState({ status: 'error' }), { status: 'error' });
  });
});

describe('frame map-state transitions', () => {
  const withMap: FrameMapState = { projectPath: PROJECT, map: READY };

  it('takes a report for the current project', () => {
    assert.deepEqual(applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, PROJECT, PROJECT, READY), withMap);
  });

  it('drops a late report from another project', () => {
    assert.equal(applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, PROJECT, OTHER, READY), INITIAL_FRAME_MAP_STATE);
  });

  it('drops any report with no project open', () => {
    assert.equal(applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, null, null, READY), INITIAL_FRAME_MAP_STATE);
  });

  it('keeps the same object for an identical report', () => {
    assert.equal(applyMapReportToFrame(withMap, PROJECT, PROJECT, { ...READY }), withMap);
  });

  it('re-reports loading and error so counts are retracted', () => {
    assert.deepEqual(applyMapReportToFrame(withMap, PROJECT, PROJECT, { status: 'loading' }).map, {
      status: 'loading',
    });
    assert.deepEqual(applyMapReportToFrame(withMap, PROJECT, PROJECT, { status: 'error' }).map, { status: 'error' });
  });

  it('a switch to another project resets the map state', () => {
    assert.deepEqual(applyProjectOpenedToFrame(withMap, OTHER), INITIAL_FRAME_MAP_STATE);
  });

  it('re-selecting the open project keeps its map state', () => {
    assert.equal(applyProjectOpenedToFrame(withMap, PROJECT), withMap);
  });

  it('Close resets the map state', () => {
    assert.deepEqual(applyProjectClosedToFrame(withMap), INITIAL_FRAME_MAP_STATE);
  });

  it('frameMapFor only returns the current project’s map', () => {
    assert.deepEqual(frameMapFor(withMap, PROJECT), READY);
    assert.equal(frameMapFor(withMap, OTHER), null);
    assert.equal(frameMapFor(withMap, null), null);
  });
});

describe('footerAvailability', () => {
  it('no status yet (a fresh open) is not failed', () => {
    assert.equal(footerAvailability(null, PROJECT), 'refreshing');
  });

  it('a failure for the current project is degraded', () => {
    const status: GraphServiceStatusMessage = { state: 'exited', at: AT, code: 1 };
    assert.equal(footerAvailability(status, PROJECT), 'degraded');
  });

  it('a stale error from the previous project does not mark the new one', () => {
    const status: GraphServiceStatusMessage = { state: 'error', path: OTHER, message: 'boom', at: AT };
    assert.equal(footerAvailability(status, PROJECT), 'refreshing');
  });

  it('indexed for the current project is live', () => {
    const status: GraphServiceStatusMessage = {
      state: 'indexed',
      path: PROJECT,
      nodes: 1,
      edges: 1,
      elapsedMs: 1,
      at: AT,
    };
    assert.equal(footerAvailability(status, PROJECT), 'live');
  });
});

describe('formatMapCounts', () => {
  it('singular forms', () => {
    assert.equal(formatMapCounts(1, 1), '1 Node · 1 edge');
  });

  it('thousands separators', () => {
    assert.equal(formatMapCounts(10000, 12345), '10,000 Nodes · 12,345 edges');
  });
});

describe('deriveFooterBar', () => {
  it('Landing: no project open, right empty', () => {
    assert.deepEqual(deriveFooterBar(NO_PROJECT), { left: 'no project open', right: '' });
  });

  it('Landing: shows no mode even if one is set', () => {
    assert.deepEqual(deriveFooterBar({ ...NO_PROJECT, mode: 'healthAudit', availability: 'degraded' }), {
      left: 'no project open',
      right: '',
    });
  });

  it('Landing while an open is in flight: opening…', () => {
    assert.deepEqual(deriveFooterBar({ ...NO_PROJECT, isOpening: true }), { left: 'opening…', right: '' });
  });

  it('Opening a new project: indexing with the starting mode', () => {
    assert.deepEqual(deriveFooterBar({ ...OPEN, mode: 'healthAudit' }), {
      left: 'indexing my-app…',
      right: 'HEALTH AUDIT',
    });
    assert.deepEqual(deriveFooterBar({ ...OPEN, map: { status: 'loading' } }).left, 'indexing my-app…');
  });

  it('A failed first index says stopped', () => {
    assert.deepEqual(deriveFooterBar({ ...OPEN, availability: 'degraded' }), {
      left: 'indexing my-app stopped',
      right: 'CODE MAP',
    });
  });

  it('Map loaded: exact Node and edge counts and the mode', () => {
    assert.deepEqual(deriveFooterBar({ ...OPEN, availability: 'live', map: READY }), {
      left: '229 Nodes · 359 edges',
      right: 'CODE MAP',
    });
  });

  it('Map loaded while re-indexing: counts plus re-indexing', () => {
    assert.deepEqual(deriveFooterBar({ ...OPEN, availability: 'refreshing', map: READY, mode: 'prReview' }), {
      left: '229 Nodes · 359 edges · re-indexing…',
      right: 'PR REVIEW',
    });
  });

  it('Degraded: service down, map kept', () => {
    assert.deepEqual(deriveFooterBar({ ...OPEN, availability: 'degraded', map: READY, mode: 'healthAudit' }), {
      left: '229 Nodes · 359 edges · last completed index',
      right: 'HEALTH AUDIT',
    });
  });

  it('A failed map fetch with no map on screen points at Retry', () => {
    assert.deepEqual(deriveFooterBar({ ...OPEN, availability: 'live', map: { status: 'error' } }), {
      left: 'couldn’t load the map — use Retry',
      right: 'CODE MAP',
    });
  });

  it('Close project: back to no project open', () => {
    const closed = applyProjectClosedToFrame({ projectPath: PROJECT, map: READY });
    assert.deepEqual(
      deriveFooterBar({ ...NO_PROJECT, availability: 'live', map: frameMapFor(closed, null) }),
      { left: 'no project open', right: '' },
    );
    assert.equal(deriveTitle({ currentProjectPath: null }), 'driller — no project open');
  });

  it('Reopening the same repo: a fresh ready report shows counts again', () => {
    const closed = applyProjectClosedToFrame({ projectPath: PROJECT, map: READY });
    const reopened = applyMapReportToFrame(
      applyMapReportToFrame(closed, PROJECT, PROJECT, { status: 'loading' }),
      PROJECT,
      PROJECT,
      READY,
    );
    assert.equal(
      deriveFooterBar({ ...OPEN, availability: 'live', map: frameMapFor(reopened, PROJECT) }).left,
      '229 Nodes · 359 edges',
    );
  });
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatSyncAge (P3-10)', () => {
  it('under a minute is just now', () => {
    assert.equal(formatSyncAge(0), 'just now');
    assert.equal(formatSyncAge(59 * SEC), 'just now');
    assert.equal(formatSyncAge(MIN - 1), 'just now');
  });

  it('a clock lagging the settle time, or no number, reads just now', () => {
    assert.equal(formatSyncAge(-5 * SEC), 'just now');
    assert.equal(formatSyncAge(Number.NaN), 'just now');
  });

  it('1–59 minutes: whole minutes', () => {
    assert.equal(formatSyncAge(60 * SEC), '1 min ago');
    assert.equal(formatSyncAge(2 * MIN - 1), '1 min ago');
    assert.equal(formatSyncAge(3 * MIN), '3 min ago');
    assert.equal(formatSyncAge(59 * MIN), '59 min ago');
    assert.equal(formatSyncAge(HOUR - 1), '59 min ago');
  });

  it('1–23 hours: whole hours', () => {
    assert.equal(formatSyncAge(60 * MIN), '1 h ago');
    assert.equal(formatSyncAge(23 * HOUR), '23 h ago');
    assert.equal(formatSyncAge(DAY - 1), '23 h ago');
  });

  it('24 hours and over: whole days', () => {
    assert.equal(formatSyncAge(24 * HOUR), '1 d ago');
    assert.equal(formatSyncAge(2 * DAY - 1), '1 d ago');
    assert.equal(formatSyncAge(10 * DAY), '10 d ago');
    assert.equal(formatSyncAge(366 * DAY - 1), '365 d ago');
  });

  it('beyond 365 days, or infinite: over a year ago', () => {
    assert.equal(formatSyncAge(366 * DAY), 'over a year ago');
    assert.equal(formatSyncAge(Number.MAX_VALUE), 'over a year ago');
    assert.equal(formatSyncAge(Number.POSITIVE_INFINITY), 'over a year ago');
  });

  it('-Infinity reads just now', () => {
    assert.equal(formatSyncAge(Number.NEGATIVE_INFINITY), 'just now');
  });
});

describe('diffScopeSyncTimeFor (P3-10)', () => {
  const NOW = 1_234_567;
  const cases: ReadonlyArray<[DiffScopeResult, number | null]> = [
    [{ status: 'resolved', resolvedBaseRef: 'main', nodeIds: ['a'] }, NOW],
    [{ status: 'resolved', resolvedBaseRef: 'main', nodeIds: [] }, NOW],
    [{ status: 'no-changes' }, NOW],
    [{ status: 'not-a-git-repo' }, NOW],
    [{ status: 'no-base-ref-resolvable' }, NOW],
    [{ status: 'error', message: 'boom' }, null],
  ];
  for (const [result, expected] of cases) {
    it(`${result.status}${result.status === 'resolved' ? ` (${result.nodeIds.length} Nodes)` : ''} → ${expected === null ? 'no sync' : 'synced now'}`, () => {
      assert.equal(diffScopeSyncTimeFor(result, NOW), expected);
    });
  }

  it('covers every DiffScopeResult status', () => {
    const statuses: Record<DiffScopeResult['status'], true> = {
      resolved: true,
      'no-changes': true,
      'not-a-git-repo': true,
      'no-base-ref-resolvable': true,
      error: true,
    };
    assert.deepEqual(new Set(cases.map(([r]) => r.status)), new Set(Object.keys(statuses)));
  });

  it('an unknown status (a newer reply shape) records nothing', () => {
    assert.equal(diffScopeSyncTimeFor({ status: 'something-new' } as unknown as DiffScopeResult, NOW), null);
  });
});

describe('nextSyncAgeTickMs (P3-10)', () => {
  it('under a minute: until the 1-minute mark', () => {
    assert.equal(nextSyncAgeTickMs(0), MIN);
    assert.equal(nextSyncAgeTickMs(59 * SEC), SEC);
    assert.equal(nextSyncAgeTickMs(MIN - 1), 1);
  });

  it('minutes: until the next minute boundary', () => {
    assert.equal(nextSyncAgeTickMs(MIN), MIN);
    assert.equal(nextSyncAgeTickMs(3 * MIN + 20 * SEC), 40 * SEC);
    assert.equal(nextSyncAgeTickMs(HOUR - 1), 1);
  });

  it('hours: until the next hour boundary, capped', () => {
    assert.equal(nextSyncAgeTickMs(HOUR), SYNC_AGE_MAX_TICK_MS);
    assert.equal(nextSyncAgeTickMs(2 * HOUR - 30 * SEC), 30 * SEC);
    assert.equal(nextSyncAgeTickMs(DAY - 1), 1);
    // Just past an hour the next change is an hour away, not a minute.
    assert.equal(nextSyncAgeTickMs(HOUR + 20 * SEC), SYNC_AGE_MAX_TICK_MS);
  });

  it('days: until the next day boundary, capped', () => {
    assert.equal(nextSyncAgeTickMs(DAY), SYNC_AGE_MAX_TICK_MS);
    assert.equal(nextSyncAgeTickMs(2 * DAY - 10 * SEC), 10 * SEC);
    // Near an hour mark past a day the next change is the day boundary, not the hour.
    assert.equal(nextSyncAgeTickMs(DAY + HOUR - 10 * SEC), SYNC_AGE_MAX_TICK_MS);
  });

  it('never more than the cap, never below 1 ms', () => {
    assert.equal(SYNC_AGE_MAX_TICK_MS, MIN);
    assert.equal(nextSyncAgeTickMs(-5 * SEC), SYNC_AGE_MAX_TICK_MS);
    assert.equal(nextSyncAgeTickMs(Number.NaN), SYNC_AGE_MAX_TICK_MS);
    assert.equal(nextSyncAgeTickMs(Number.POSITIVE_INFINITY), SYNC_AGE_MAX_TICK_MS);
    assert.equal(nextSyncAgeTickMs(Number.NEGATIVE_INFINITY), SYNC_AGE_MAX_TICK_MS);
    assert.equal(nextSyncAgeTickMs(MIN - 0.5), 1);
    for (const age of [0, 1, MIN - 1, MIN, 90 * MIN, 25 * HOUR, 400 * DAY]) {
      const delay = nextSyncAgeTickMs(age);
      assert.ok(delay >= 1 && delay <= SYNC_AGE_MAX_TICK_MS, `age ${age} → ${delay}`);
    }
  });

  it('the label changes exactly at the boundary it schedules for', () => {
    for (const age of [0, 30 * SEC, 5 * MIN + 1, 3 * HOUR - 20 * SEC, 23 * HOUR + 59 * MIN + 30 * SEC]) {
      const delay = nextSyncAgeTickMs(age);
      if (delay < SYNC_AGE_MAX_TICK_MS || age < MIN) {
        assert.notEqual(formatSyncAge(age + delay), formatSyncAge(age + delay - 1), `age ${age}`);
      }
    }
  });
});

describe('frame sync state (P3-10)', () => {
  const T = 1_000_000;

  it('a sync report for the open project is held', () => {
    const next = applyDiffScopeSyncToFrame(INITIAL_FRAME_SYNC_STATE, PROJECT, PROJECT, T);
    assert.deepEqual(next, { projectPath: PROJECT, lastSyncedAt: T });
    assert.equal(frameSyncFor(next, PROJECT), T);
  });

  it('a report about another project, or with none open, is dropped', () => {
    assert.equal(applyDiffScopeSyncToFrame(INITIAL_FRAME_SYNC_STATE, PROJECT, OTHER, T), INITIAL_FRAME_SYNC_STATE);
    assert.equal(applyDiffScopeSyncToFrame(INITIAL_FRAME_SYNC_STATE, null, null, T), INITIAL_FRAME_SYNC_STATE);
  });

  it('an identical report returns the same object', () => {
    const held: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: T };
    assert.equal(applyDiffScopeSyncToFrame(held, PROJECT, PROJECT, T), held);
  });

  it('a null report when no time is held for that project is a no-op', () => {
    const other: FrameSyncState = { projectPath: OTHER, lastSyncedAt: T };
    assert.equal(applyDiffScopeSyncToFrame(other, PROJECT, PROJECT, null), other);
    const cleared: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: null };
    assert.equal(applyDiffScopeSyncToFrame(cleared, PROJECT, PROJECT, null), cleared);
    assert.equal(applyDiffScopeSyncToFrame(INITIAL_FRAME_SYNC_STATE, PROJECT, PROJECT, null), INITIAL_FRAME_SYNC_STATE);
  });

  it('a null report (map refresh after re-index) clears the time', () => {
    const held: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: T };
    assert.equal(frameSyncFor(applyDiffScopeSyncToFrame(held, PROJECT, PROJECT, null), PROJECT), null);
  });

  it('a later sync replaces the earlier time', () => {
    const held: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: T };
    assert.equal(frameSyncFor(applyDiffScopeSyncToFrame(held, PROJECT, PROJECT, T + MIN), PROJECT), T + MIN);
  });

  it('Close project clears it', () => {
    const held: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: T };
    assert.equal(applyProjectClosedToFrameSync(held), INITIAL_FRAME_SYNC_STATE);
    assert.equal(applyProjectClosedToFrameSync(INITIAL_FRAME_SYNC_STATE), INITIAL_FRAME_SYNC_STATE);
  });

  it('switching project clears it; re-opening the same one keeps it', () => {
    const held: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: T };
    assert.equal(applyProjectOpenedToFrameSync(held, OTHER), INITIAL_FRAME_SYNC_STATE);
    assert.equal(applyProjectOpenedToFrameSync(held, PROJECT), held);
    assert.equal(applyProjectOpenedToFrameSync(INITIAL_FRAME_SYNC_STATE, OTHER), INITIAL_FRAME_SYNC_STATE);
    const cleared: FrameSyncState = { projectPath: PROJECT, lastSyncedAt: null };
    assert.equal(applyProjectOpenedToFrameSync(cleared, PROJECT), cleared);
    assert.equal(frameSyncFor(cleared, PROJECT), null);
  });

  it('a time held for another project never shows', () => {
    assert.equal(frameSyncFor({ projectPath: OTHER, lastSyncedAt: T }, PROJECT), null);
    assert.equal(frameSyncFor({ projectPath: PROJECT, lastSyncedAt: T }, null), null);
  });
});

describe('deriveFooterBar sync status (P3-10)', () => {
  const T = 1_000_000;
  const LIVE: FooterBarInput = { ...OPEN, availability: 'live', map: READY };

  it('PR Review before any sync: the mode name alone', () => {
    assert.equal(deriveFooterBar({ ...LIVE, mode: 'prReview', now: T }).right, 'PR REVIEW');
  });

  it('PR Review just computed: synced just now', () => {
    assert.deepEqual(deriveFooterBar({ ...LIVE, mode: 'prReview', lastSyncedAt: T, now: T }), {
      left: '229 Nodes · 359 edges',
      right: 'PR REVIEW · synced just now',
    });
  });

  it('PR Review 3 minutes later: ages', () => {
    assert.equal(
      deriveFooterBar({ ...LIVE, mode: 'prReview', lastSyncedAt: T, now: T + 3 * MIN }).right,
      'PR REVIEW · synced 3 min ago',
    );
  });

  it('PR Review with no map yet still states the sync', () => {
    assert.equal(
      deriveFooterBar({ ...OPEN, mode: 'prReview', lastSyncedAt: T, now: T + 2 * HOUR }).right,
      'PR REVIEW · synced 2 h ago',
    );
  });

  it('other modes ignore a held sync time', () => {
    assert.equal(deriveFooterBar({ ...LIVE, mode: 'codeMap', lastSyncedAt: T, now: T }).right, 'CODE MAP');
    assert.equal(deriveFooterBar({ ...LIVE, mode: 'healthAudit', lastSyncedAt: T, now: T }).right, 'HEALTH AUDIT');
    assert.equal(deriveFooterBar({ ...LIVE, mode: 'codeMap', now: T }).right, 'CODE MAP');
    assert.equal(deriveFooterBar({ ...LIVE, mode: 'healthAudit', now: T }).right, 'HEALTH AUDIT');
  });

  it('no project open: right stays empty even with a stray sync time', () => {
    assert.deepEqual(deriveFooterBar({ ...NO_PROJECT, mode: 'prReview', lastSyncedAt: T, now: T }), {
      left: 'no project open',
      right: '',
    });
  });
});

describe('footerBarRightTitle (P3-10)', () => {
  const T = Date.UTC(2026, 8, 26, 12, 0, 0);

  it('the absolute sync time while the right span states one', () => {
    assert.equal(
      footerBarRightTitle({ currentProjectPath: PROJECT, mode: 'prReview', lastSyncedAt: T }),
      `synced ${new Date(T).toLocaleString()}`,
    );
  });

  it('none before a sync, in other modes, or with no project open', () => {
    assert.equal(footerBarRightTitle({ currentProjectPath: PROJECT, mode: 'prReview', lastSyncedAt: null }), undefined);
    assert.equal(footerBarRightTitle({ currentProjectPath: PROJECT, mode: 'codeMap', lastSyncedAt: T }), undefined);
    assert.equal(footerBarRightTitle({ currentProjectPath: PROJECT, mode: 'healthAudit', lastSyncedAt: T }), undefined);
    assert.equal(footerBarRightTitle({ currentProjectPath: null, mode: 'prReview', lastSyncedAt: T }), undefined);
  });
});
