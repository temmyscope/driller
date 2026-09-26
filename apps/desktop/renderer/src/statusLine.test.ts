/**
 * FIX-3: the Graph Service status line's exact text (`statusLine.ts`).
 * `GraphServiceStatusBadge` holds hooks (its ticking elapsed clock), so it
 * can't be called as a plain function under `renderTree`; it renders
 * `statusLineText` verbatim, which is what is pinned here.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphServiceStatusMessage, IndexCoverageSummary } from '@driller/ipc-contracts';

import { deriveFooterBar, mapNodesForStatusLine } from './appFrame';
import { formatCoverage, formatIndexedCounts, statusLineMapNodes, statusLineText } from './statusLine';

const AT = '2026-09-26T00:00:00.000Z';
const PROJECT = '/repo/app';

function indexed(coverage?: IndexCoverageSummary): GraphServiceStatusMessage {
  return {
    state: 'indexed',
    at: AT,
    path: PROJECT,
    nodes: 1550,
    edges: 5763,
    elapsedMs: 123_000,
    ...(coverage ? { coverage } : {}),
  };
}

const FULL: IndexCoverageSummary = {
  skippedCount: 0,
  parsePartialCount: 0,
  expectedNodes: 1550,
  expectedEdges: 5763,
} as IndexCoverageSummary;

describe('statusLineText: indexed (FIX-3)', () => {
  it('states the indexed totals, the map count, the elapsed time and coverage', () => {
    assert.equal(
      statusLineText(indexed(FULL), 1014, 'live'),
      'Indexed — 1,550 Nodes (1,014 on the map), 5,763 edges · 2m 03s · full coverage (1,550/1,550 indexed Nodes, 5,763/5,763 edges expected)',
    );
  });

  it('omits the map count before the map has loaded', () => {
    assert.equal(statusLineText(indexed(), null, 'live'), 'Indexed — 1,550 Nodes, 5,763 edges · 2m 03s');
  });

  it('omits it while refreshing, and when it exceeds the indexed total', () => {
    assert.equal(statusLineText(indexed(), 1014, 'refreshing'), 'Indexed — 1,550 Nodes, 5,763 edges · 2m 03s');
    assert.equal(statusLineText(indexed(), 1551, 'live'), 'Indexed — 1,550 Nodes, 5,763 edges · 2m 03s');
  });

  it('keeps it when degraded (the map on screen is the last completed index)', () => {
    assert.equal(
      statusLineText(indexed(), 1550, 'degraded'),
      'Indexed — 1,550 Nodes (1,550 on the map), 5,763 edges · 2m 03s',
    );
  });

  it('names a coverage gap', () => {
    const gap = { skippedCount: 2, parsePartialCount: 1 } as IndexCoverageSummary;
    assert.equal(
      statusLineText(indexed(gap), 1014, 'live'),
      'Indexed — 1,550 Nodes (1,014 on the map), 5,763 edges · 2m 03s · 1 file partially parsed, 2 files skipped',
    );
  });
});

describe('statusLineText: other states', () => {
  it('reads each state', () => {
    assert.equal(statusLineText({ state: 'starting', at: AT }, null, 'refreshing'), 'Graph Service starting…');
    assert.equal(statusLineText({ state: 'alive', at: AT }, null, 'refreshing'), 'Graph Service running');
    assert.equal(statusLineText({ state: 'indexing', at: AT, path: PROJECT }, 5, 'refreshing'), 'Indexing…');
    assert.equal(statusLineText({ state: 'exited', at: AT, code: 1 }, 5, 'degraded'), 'Graph Service exited');
    assert.equal(
      statusLineText({ state: 'error', at: AT, message: 'boom', elapsedMs: 4000 }, 5, 'degraded'),
      'Graph Service unavailable: boom (after 4s)',
    );
    assert.equal(
      statusLineText({ state: 'error', at: AT, message: 'boom' }, 5, 'degraded'),
      'Graph Service unavailable: boom',
    );
  });
});

describe('statusLineMapNodes (FIX-3)', () => {
  it('cites the map count only when live or degraded and not above the indexed total', () => {
    assert.equal(statusLineMapNodes(1550, 1014, 'live'), 1014);
    assert.equal(statusLineMapNodes(1550, 1550, 'live'), 1550);
    assert.equal(statusLineMapNodes(1550, 1014, 'degraded'), 1014);
    assert.equal(statusLineMapNodes(1550, 1014, 'refreshing'), null);
    assert.equal(statusLineMapNodes(1550, 1551, 'live'), null);
    assert.equal(statusLineMapNodes(1550, null, 'live'), null);
    assert.equal(statusLineMapNodes(1550, Number.NaN, 'live'), null);
  });
});

describe('formatIndexedCounts (FIX-3)', () => {
  it('states the indexed totals and how many are on the map', () => {
    assert.equal(formatIndexedCounts(1550, 5763, 1014), '1,550 Nodes (1,014 on the map), 5,763 edges');
    assert.equal(formatIndexedCounts(1550, 5763, null), '1,550 Nodes, 5,763 edges');
    assert.equal(formatIndexedCounts(1, 1, 0), '1 Node (0 on the map), 1 edge');
  });
});

describe('formatCoverage', () => {
  it('labels its totals as indexed Nodes', () => {
    assert.equal(formatCoverage(FULL, 1500, 5000), 'full coverage (1,500/1,550 indexed Nodes, 5,000/5,763 edges expected)');
    assert.equal(formatCoverage({ skippedCount: 0, parsePartialCount: 0 } as IndexCoverageSummary, 1, 1), 'full coverage');
  });
});

describe('status line and footer agree (FIX-3)', () => {
  it('cites the same map count the footer shows', () => {
    const map = { status: 'ready', nodes: 1014, edges: 2371 } as const;
    const footer = deriveFooterBar({
      currentProjectPath: PROJECT,
      isOpening: false,
      availability: 'live',
      map,
      mode: 'codeMap',
      lastSyncedAt: null,
      now: 0,
    }).left;
    assert.ok(footer.startsWith('1,014 Nodes'), footer);
    assert.ok(statusLineText(indexed(), mapNodesForStatusLine(map), 'live').includes('(1,014 on the map)'));
  });
});
