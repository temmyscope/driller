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
  INITIAL_SECTION_SHELL_STATE,
  applyDiffScopeSyncToFrame,
  applyMapReportToSectionShell,
  applyScopeSavedToSectionShell,
  applySectionActivated,
  applyUnknownSection,
  isDifferentProjectOpen,
  loadSavedSection,
  rememberSection,
  resolveSavedSection,
  restoredSectionShell,
  sectionRestoreSettled,
  sectionToRemember,
  type SectionShellState,
  applyMapReportToFrame,
  applyProjectClosedToFrame,
  applyProjectClosedToFrameSync,
  applyProjectOpenedToFrame,
  applyProjectOpenedToFrameSync,
  crossSectionEdgesLine,
  deriveFooterBar,
  deriveTitle,
  diffScopeSyncTimeFor,
  footerAvailability,
  footerBarRightTitle,
  footerCrossSectionLine,
  formatSyncAge,
  nextFooterCrossSectionLine,
  frameMapFor,
  frameSectionBarFor,
  frameSyncFor,
  mapNodesForStatusLine,
  mapFooterState,
  nextSyncAgeTickMs,
  pendingFocusForSwitch,
  pendingFocusNodeIdFor,
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

const READY: MapFooterState = { status: 'ready', nodes: 229, edges: 359, appliedScope: [], sections: [], section: null };

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
    assert.deepEqual(mapFooterState({ status: 'ready', nodes: [1, 2, 3], edges: [1, 2], appliedScope: [] }), {
      status: 'ready',
      nodes: 3,
      edges: 2,
      appliedScope: [],
      sections: [],
      section: null,
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
  const withMap: FrameMapState = { projectPath: PROJECT, map: READY, sectionBar: { appliedScope: [], sections: [] } };

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
    const closed = applyProjectClosedToFrame({ projectPath: PROJECT, map: READY, sectionBar: null });
    assert.deepEqual(
      deriveFooterBar({ ...NO_PROJECT, availability: 'live', map: frameMapFor(closed, null) }),
      { left: 'no project open', right: '' },
    );
    assert.equal(deriveTitle({ currentProjectPath: null }), 'driller — no project open');
  });

  it('Reopening the same repo: a fresh ready report shows counts again', () => {
    const closed = applyProjectClosedToFrame({ projectPath: PROJECT, map: READY, sectionBar: null });
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
    // P4-4 phase 2a: the section left the allowlist — nothing was synced.
    [{ status: 'unknown-section', section: 'docs', knownSections: ['web'] }, null],
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
      'unknown-section': true,
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

describe('mapNodesForStatusLine (FIX-3)', () => {
  it("is the ready map's Node count", () => {
    assert.equal(mapNodesForStatusLine({ ...READY, nodes: 1014, edges: 2371 }), 1014);
  });

  it('is null while no map is loaded', () => {
    assert.equal(mapNodesForStatusLine(null), null);
    assert.equal(mapNodesForStatusLine({ status: 'loading' }), null);
    assert.equal(mapNodesForStatusLine({ status: 'error' }), null);
  });
});

describe('P4-4 phase 1c: the Section bar source', () => {
  const SECTIONS = [
    { path: 'web', nodeCount: 792 },
    { path: 'api', nodeCount: 412 },
  ];
  // A section reply: 412 Nodes on screen, but `sections` stays whole-scope.
  const API_READY: MapFooterState = {
    status: 'ready',
    nodes: 412,
    edges: 900,
    appliedScope: ['web', 'api'],
    sections: SECTIONS,
    section: 'api',
  };

  it('mapFooterState carries the reply scope, sections and section', () => {
    assert.deepEqual(
      mapFooterState({ status: 'ready', nodes: [1], edges: [], appliedScope: ['web', 'api'], sections: SECTIONS, section: 'api' }),
      { status: 'ready', nodes: 1, edges: 0, appliedScope: ['web', 'api'], sections: SECTIONS, section: 'api' },
    );
  });

  it('a ready report sets the bar source; a later loading or error report keeps it', () => {
    const ready = applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, PROJECT, PROJECT, API_READY);
    assert.deepEqual(frameSectionBarFor(ready, PROJECT), { appliedScope: ['web', 'api'], sections: SECTIONS });
    const loading = applyMapReportToFrame(ready, PROJECT, PROJECT, { status: 'loading' });
    assert.equal(loading.sectionBar, ready.sectionBar);
    const errored = applyMapReportToFrame(loading, PROJECT, PROJECT, { status: 'error' });
    assert.equal(errored.sectionBar, ready.sectionBar);
    assert.equal(frameSectionBarFor(ready, OTHER), null);
    assert.equal(frameSectionBarFor(ready, null), null);
  });

  it('a project switch or Close drops the bar source', () => {
    const ready = applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, PROJECT, PROJECT, API_READY);
    assert.equal(applyProjectOpenedToFrame(ready, OTHER).sectionBar, null);
    assert.equal(applyProjectClosedToFrame(ready).sectionBar, null);
  });

  it('a report with a different section, sections or scope is not deduped away', () => {
    const ready = applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, PROJECT, PROJECT, API_READY);
    const fewer = applyMapReportToFrame(ready, PROJECT, PROJECT, { ...API_READY, appliedScope: ['api'], sections: [SECTIONS[1]!] });
    assert.notEqual(fewer, ready);
    assert.deepEqual(fewer.sectionBar?.appliedScope, ['api']);
    const recount = applyMapReportToFrame(ready, PROJECT, PROJECT, { ...API_READY, sections: [SECTIONS[0]!, { path: 'api', nodeCount: 413 }] });
    assert.notEqual(recount, ready);
    assert.notEqual(applyMapReportToFrame(ready, PROJECT, PROJECT, { ...API_READY, section: 'web' }), ready);
    assert.equal(applyMapReportToFrame(ready, PROJECT, PROJECT, { ...API_READY, sections: [...SECTIONS] }), ready);
  });
});

// ---------------------------------------------------------------------------
// P4-4 phase 3b: the footer's cross-section line
// ---------------------------------------------------------------------------

describe('crossSectionEdgesLine', () => {
  const SUFFIX = ' — not shown in this section';

  it('splits by direction: "9 edges into web/, 3 from web/"', () => {
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 9, incoming: 3 }]), `9 edges into web/, 3 edges from web/${SUFFIX}`);
  });

  it('leaves a 0 direction out', () => {
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 12, incoming: 0 }]), `12 edges into web/${SUFFIX}`);
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 0, incoming: 3 }]), `3 edges from web/${SUFFIX}`);
  });

  it('every count carries its own singular or plural noun', () => {
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 1, incoming: 0 }]), `1 edge into web/${SUFFIX}`);
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 0, incoming: 1 }]), `1 edge from web/${SUFFIX}`);
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 1, incoming: 3 }]), `1 edge into web/, 3 edges from web/${SUFFIX}`);
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 2, incoming: 1 }]), `2 edges into web/, 1 edge from web/${SUFFIX}`);
  });

  it('joins several sections with " · " in the reply\'s order, every count the field\'s own', () => {
    assert.equal(
      crossSectionEdgesLine([
        { section: 'web', outgoing: 1_204, incoming: 3 },
        { section: 'docs', outgoing: 3, incoming: 0 },
        { section: 'apps/cli', outgoing: 0, incoming: 2 },
      ]),
      `1,204 edges into web/, 3 edges from web/ · 3 edges into docs/ · 2 edges from apps/cli/${SUFFIX}`,
    );
  });

  it('is null for an absent or empty field, or one with no count above 0', () => {
    assert.equal(crossSectionEdgesLine(undefined), null);
    assert.equal(crossSectionEdgesLine([]), null);
    assert.equal(crossSectionEdgesLine([{ section: 'web', outgoing: 0, incoming: 0 }]), null);
  });
});

describe('footerCrossSectionLine', () => {
  const EDGES = [{ section: 'web', outgoing: 9, incoming: 3 }];
  const API: MapFooterState = { ...READY, appliedScope: ['api', 'web'], section: 'api', crossSectionEdges: EDGES };

  it('a ready section map with crossSectionEdges shows the line', () => {
    assert.equal(footerCrossSectionLine(API), '9 edges into web/, 3 edges from web/ — not shown in this section');
  });

  it('no line in all, while loading, on error, before a report, or without the field', () => {
    assert.equal(footerCrossSectionLine({ ...API, section: null }), null);
    assert.equal(footerCrossSectionLine({ status: 'loading' }), null);
    assert.equal(footerCrossSectionLine({ status: 'error' }), null);
    assert.equal(footerCrossSectionLine(null), null);
    assert.equal(footerCrossSectionLine({ ...READY, appliedScope: ['api', 'web'], section: 'api' }), null);
  });

  it('the report keeps a non-empty field only, and a change to it is a new report', () => {
    const fetch = { status: 'ready' as const, nodes: [], edges: [], appliedScope: ['api', 'web'], section: 'api' };
    const withEdges = mapFooterState({ ...fetch, crossSectionEdges: EDGES });
    assert.deepEqual(withEdges.status === 'ready' ? withEdges.crossSectionEdges : null, EDGES);
    const empty = mapFooterState({ ...fetch, crossSectionEdges: [] });
    assert.equal(empty.status === 'ready' && 'crossSectionEdges' in empty, false);

    const first = applyMapReportToFrame(INITIAL_FRAME_MAP_STATE, PROJECT, PROJECT, API);
    assert.equal(applyMapReportToFrame(first, PROJECT, PROJECT, { ...API, crossSectionEdges: [...EDGES] }), first);
    const changed = applyMapReportToFrame(first, PROJECT, PROJECT, {
      ...API,
      crossSectionEdges: [{ section: 'web', outgoing: 3, incoming: 9 }],
    });
    assert.notEqual(changed, first);
    assert.equal(footerCrossSectionLine(frameMapFor(changed, PROJECT)), '3 edges into web/, 9 edges from web/ — not shown in this section');
  });
});

describe('nextFooterCrossSectionLine (review round 1)', () => {
  const API: MapFooterState = {
    ...READY,
    appliedScope: ['api', 'web'],
    section: 'api',
    crossSectionEdges: [{ section: 'web', outgoing: 9, incoming: 3 }],
  };
  const LINE = '9 edges into web/, 3 edges from web/ — not shown in this section';

  it('follows the ready map when no switch is pending', () => {
    assert.equal(nextFooterCrossSectionLine(null, API, false), LINE);
    assert.equal(nextFooterCrossSectionLine(LINE, { ...API, section: null }, false), null);
    assert.equal(nextFooterCrossSectionLine(LINE, { status: 'error' }, false), null);
  });

  it('keeps the previous text while a switch is pending, even when a ready map lands', () => {
    assert.equal(nextFooterCrossSectionLine('old', API, true), 'old');
    assert.equal(nextFooterCrossSectionLine(null, API, true), null);
  });

  it('keeps it through a reload, so the same counts change no text (nothing re-announced)', () => {
    assert.equal(nextFooterCrossSectionLine(LINE, { status: 'loading' }, false), LINE);
    assert.equal(nextFooterCrossSectionLine(LINE, API, false), LINE);
  });
});

describe('the pending cross-section focus', () => {
  it('a switch with a Node keeps it for that section; without one, none', () => {
    assert.deepEqual(pendingFocusForSwitch('web', 'web/r.ts#render'), { section: 'web', nodeId: 'web/r.ts#render' });
    assert.equal(pendingFocusForSwitch('web'), null);
  });

  it('is handed to CodeMap only while its section is selected', () => {
    const pending = pendingFocusForSwitch('web', 'web/r.ts#render');
    assert.equal(pendingFocusNodeIdFor(pending, 'web'), 'web/r.ts#render');
    assert.equal(pendingFocusNodeIdFor(pending, 'api'), null);
    assert.equal(pendingFocusNodeIdFor(pending, null), null);
    assert.equal(pendingFocusNodeIdFor(null, 'web'), null);
  });
});

// ---------------------------------------------------------------------------
// P4-4i: the remembered section
// ---------------------------------------------------------------------------


/** A ready map report for `section`, over the `web`, `api` allowlist by default. */
function sectionReady(section: string | null, appliedScope: string[] = ['web', 'api']): MapFooterState {
  return { status: 'ready', nodes: 10, edges: 0, appliedScope, sections: [], section };
}

/** Runs `fn` with `console.warn` silenced, returning what was warned. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: unknown[][] }> {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe('resolveSavedSection (P4-4i)', () => {
  it('relaunch: a saved section that is in an allowlist of 2 or more is used', () => {
    assert.equal(resolveSavedSection('api', ['web', 'api']), 'api');
    assert.equal(resolveSavedSection('all', ['all', 'api']), 'all', 'an entry named all is a normal section');
  });

  it('stale: a section no longer in the allowlist reads as all', () => {
    assert.equal(resolveSavedSection('docs', ['web', 'api']), null);
    assert.equal(resolveSavedSection('api/', ['web', 'api']), null, 'compared verbatim, like the Graph Service');
  });

  it('allowlist shrank below 2 entries: all, even when the section is the one left', () => {
    assert.equal(resolveSavedSection('api', ['api']), null);
    assert.equal(resolveSavedSection('api', ['api', 'api']), null, 'counted by distinct entries, like the Section bar');
    assert.equal(resolveSavedSection('api', []), null);
  });

  it('nothing saved: all', () => {
    assert.equal(resolveSavedSection(null, ['web', 'api']), null);
  });
});

describe('loadSavedSection (P4-4i)', () => {
  const scope = (includedPaths: string[]) => async () => ({ includedPaths });

  it('reads the saved section and the allowlist for the project, together', { timeout: 5_000 }, async () => {
    const asked: string[] = [];
    let scopeAskedBeforeSavedResolved = false;
    let savedResolved = false;
    const read = await loadSavedSection(
      '/p',
      async (path) => {
        asked.push(`saved:${path}`);
        await Promise.resolve();
        savedResolved = true;
        return 'api';
      },
      async (path) => {
        asked.push(`scope:${path}`);
        scopeAskedBeforeSavedResolved = !savedResolved;
        return { includedPaths: ['web', 'api'] };
      },
    );
    assert.deepEqual(read, { section: 'api', clear: false });
    assert.deepEqual(asked, ['saved:/p', 'scope:/p']);
    assert.ok(scopeAskedBeforeSavedResolved, 'one round trip: both asked at once');
  });

  it('a stale or shrunk saved section opens in all and must be cleared', { timeout: 5_000 }, async () => {
    assert.deepEqual(await loadSavedSection('/p', async () => 'docs', scope(['web', 'api'])), { section: null, clear: true });
    assert.deepEqual(await loadSavedSection('/p', async () => 'api', scope(['api'])), { section: null, clear: true });
  });

  it('nothing saved: all, nothing to clear', { timeout: 5_000 }, async () => {
    assert.deepEqual(await loadSavedSection('/p', async () => null, scope(['web', 'api'])), { section: null, clear: false });
  });

  it('a failed or malformed read opens in all without clearing; never rejects', { timeout: 5_000 }, async () => {
    const failing = async (): Promise<never> => {
      throw new Error('ipc down');
    };
    const { value: savedFailed, warnings } = await quietly(() => loadSavedSection('/p', failing, scope(['web', 'api'])));
    assert.deepEqual(savedFailed, { section: null, clear: false });
    assert.equal(warnings.length, 1);
    const { value: scopeFailed } = await quietly(() => loadSavedSection('/p', async () => 'api', failing));
    assert.deepEqual(scopeFailed, { section: null, clear: false }, 'unchecked is not stale');
    assert.deepEqual(await loadSavedSection('/p', async () => 42 as unknown as string, scope(['web', 'api'])), {
      section: null,
      clear: false,
    });
    assert.deepEqual(
      await loadSavedSection('/p', async () => 'api', async () => ({ includedPaths: 'api' }) as unknown as { includedPaths: string[] }),
      { section: null, clear: false },
    );
  });
});

describe('rememberSection (P4-4i)', () => {
  it('passes the section (null = all) through, and never rejects', { timeout: 5_000 }, async () => {
    const calls: unknown[][] = [];
    await rememberSection('/p', null, async (path, section) => {
      calls.push([path, section]);
      return section;
    });
    assert.deepEqual(calls, [['/p', null]], 'all is null, never the string "all"');
    const { warnings } = await quietly(() =>
      rememberSection('/p', 'api', async () => {
        throw new Error('ipc down');
      }),
    );
    assert.equal(warnings.length, 1);
  });
});

describe('restoring and saving the section (P4-4i)', () => {
  it('a restored section is selected quietly: no announcement, no switch pending', () => {
    assert.deepEqual(restoredSectionShell('api'), { section: 'api', announcement: '', pending: false });
    assert.equal(restoredSectionShell(null), INITIAL_SECTION_SHELL_STATE);
  });

  it('a switch is saved only once its own ready reply lands', () => {
    const loading = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'api');
    assert.equal(sectionToRemember(INITIAL_SECTION_SHELL_STATE, loading, null, null), undefined, 'not on activation');
    // A ready reply for the previous section, while pending: nothing.
    const stillLoading = applyMapReportToSectionShell(loading, sectionReady(null));
    assert.equal(sectionToRemember(loading, stillLoading, sectionReady(null), null), undefined);
    const shown = applyMapReportToSectionShell(loading, sectionReady('api'));
    assert.equal(sectionToRemember(loading, shown, sectionReady('api'), null), 'api');
    // Back to all: saved as null once its reply lands.
    const allLoading = applySectionActivated(shown, null);
    assert.equal(sectionToRemember(shown, allLoading, null, 'api'), undefined);
    const allShown = applyMapReportToSectionShell(allLoading, sectionReady(null));
    assert.equal(sectionToRemember(allLoading, allShown, sectionReady(null), 'api'), null);
  });

  it('a failed switch is not saved; the section is saved once a ready map for it lands', () => {
    const loading = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'api');
    const failed = applyMapReportToSectionShell(loading, { status: 'error' });
    assert.equal(sectionToRemember(loading, failed, { status: 'error' }, null), undefined);
    // Retry: the map reloads in api and lands.
    assert.equal(sectionToRemember(failed, failed, sectionReady('api'), null), 'api');
  });

  it('a restored section is not written again by its first map', () => {
    const restored = restoredSectionShell('api');
    assert.equal(sectionToRemember(restored, restored, sectionReady('api'), 'api'), undefined);
    assert.equal(sectionToRemember(INITIAL_SECTION_SHELL_STATE, INITIAL_SECTION_SHELL_STATE, sectionReady(null), null), undefined);
  });

  it('every fallback to all clears the saved section', () => {
    const restored = restoredSectionShell('api');
    // 4d: a reply with fewer than 2 entries resets silently.
    const shrunk = applyMapReportToSectionShell(restored, sectionReady('api', ['api']));
    assert.equal(shrunk.section, null);
    assert.equal(sectionToRemember(restored, shrunk, sectionReady('api', ['api']), 'api'), null);
    // unknown-section.
    const gone = applyUnknownSection(restored, 'api');
    assert.equal(sectionToRemember(restored, gone, null, 'api'), null);
    // A scope save without the section.
    const saved = applyScopeSavedToSectionShell(restored, ['web', 'docs']);
    assert.equal(sectionToRemember(restored, saved, null, 'api'), null);
  });

  it('the launch-path unknown-section fallback is silent; otherwise it is announced', () => {
    const restored = restoredSectionShell('api');
    assert.equal(applyUnknownSection(restored, 'api', true), INITIAL_SECTION_SHELL_STATE);
    assert.match(applyUnknownSection(restored, 'api').announcement, /no longer in the indexing scope/);
    assert.equal(applyUnknownSection(restored, 'web', true), restored, 'only for the section still selected');
  });
});

describe('applyScopeSavedToSectionShell (P4-4i)', () => {
  const api: SectionShellState = { section: 'api', announcement: 'Showing section api — 10 Nodes', pending: false };

  it('scope edited while in api: a save without api falls back to all, announced', () => {
    const next = applyScopeSavedToSectionShell(api, ['web', 'docs']);
    assert.equal(next.section, null);
    assert.match(next.announcement, /api is no longer in the indexing scope/);
  });

  it('a save leaving fewer than 2 entries falls back silently, even when it keeps api', () => {
    assert.equal(applyScopeSavedToSectionShell(api, ['api']), INITIAL_SECTION_SHELL_STATE);
    assert.equal(applyScopeSavedToSectionShell(api, []), INITIAL_SECTION_SHELL_STATE);
  });

  it('a save that keeps api (with 2 or more entries), or with all selected, changes nothing', () => {
    assert.equal(applyScopeSavedToSectionShell(api, ['web', 'api', 'docs']), api);
    assert.equal(applyScopeSavedToSectionShell(INITIAL_SECTION_SHELL_STATE, ['api']), INITIAL_SECTION_SHELL_STATE);
  });
});

describe('sectionRestoreSettled (P4-4i)', () => {
  const latest = (id: number) => (requestId: number) => requestId === id;

  it('only the latest settled read for the open project lets CodeMap mount', () => {
    assert.equal(sectionRestoreSettled(null, '/p', latest(1)), false, 'not read yet');
    assert.equal(sectionRestoreSettled({ projectPath: '/p', requestId: 1 }, '/p', latest(1)), true);
    assert.equal(sectionRestoreSettled({ projectPath: '/a', requestId: 1 }, '/p', latest(1)), false, 'another project');
    assert.equal(
      sectionRestoreSettled({ projectPath: '/p', requestId: 1 }, '/p', latest(2)),
      false,
      'superseded (Close and reopen)',
    );
    assert.equal(sectionRestoreSettled({ projectPath: '/p', requestId: 1 }, null, latest(1)), false);
  });
});

describe('P4-4i review round 1', () => {
  it('loadSavedSection: a getter that throws synchronously is a failed read, never a rejection', { timeout: 5_000 }, async () => {
    const throwsNow = (): Promise<never> => {
      throw new Error('window.driller.getActiveSection is not a function');
    };
    const { value: savedThrew } = await quietly(() =>
      loadSavedSection('/p', throwsNow, async () => ({ includedPaths: ['web', 'api'] })),
    );
    assert.deepEqual(savedThrew, { section: null, clear: false });
    const { value: scopeThrew } = await quietly(() => loadSavedSection('/p', async () => 'api', throwsNow));
    assert.deepEqual(scopeThrew, { section: null, clear: false });
  });

  it('isDifferentProjectOpen: another project resets; re-selecting the open one does not', () => {
    assert.equal(isDifferentProjectOpen(null, '/p'), true, 'first open');
    assert.equal(isDifferentProjectOpen('/a', '/p'), true);
    assert.equal(isDifferentProjectOpen('/p', '/p'), false);
  });
});
