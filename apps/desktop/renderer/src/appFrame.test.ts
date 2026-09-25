/**
 * P2-3: the shared app frame — one case per row of the spec's I/O &
 * Edge-Case Matrix through `deriveFooterBar`/`deriveTitle`, plus the pure
 * rules feeding it: `mapFooterState`, the frame map-state transitions and
 * `footerAvailability`. The "short window" row is layout only (body scrolls,
 * bars stay put) and is an owed in-app check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphServiceStatusMessage } from '@driller/ipc-contracts';

import {
  INITIAL_FRAME_MAP_STATE,
  applyMapReportToFrame,
  applyProjectClosedToFrame,
  applyProjectOpenedToFrame,
  deriveFooterBar,
  deriveTitle,
  footerAvailability,
  formatMapCounts,
  frameMapFor,
  mapFooterState,
  projectFolderName,
  type FooterBarInput,
  type FrameMapState,
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
