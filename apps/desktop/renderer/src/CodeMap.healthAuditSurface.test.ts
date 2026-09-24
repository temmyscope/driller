/**
 * P0-2b: unit tests for Health Audit Mode's surface mapping, its Path Trace
 * submit decision, and the strings the grid renders.
 *
 * The surface mapping is the likeliest regression in this spec: the canvas and
 * the cluster grid are opposites, the Path Trace INPUT agrees with neither, and
 * its RESULT surfaces follow the canvas. Everything about that decision lives
 * in one exported pure function so the whole record can be pinned exhaustively
 * here — a single flipped field fails, rather than needing a test per
 * predicate. Likewise `resolvePathTraceSubmit`: the production handler is only
 * an interpreter of the effect list it returns, so these assertions run against
 * the real decision instead of a transcription of it.
 *
 * What these tests still cannot reach: which field each JSX gate actually
 * reads. This repo's runner is `node --test` with no DOM (see `docs/agent.md`),
 * so the wiring itself is covered by the spec's manual checks.
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`, which is what lets a
 * `.ts` test import from a `.tsx` module.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type CodeMapMode,
  type CodeMapSurfaces,
  formatHealthClusterHeat,
  formatRemainingClusters,
  formatRemainingNodes,
  heatForRiskCount,
  resolveCodeMapSurfaces,
  resolvePathTraceSubmit,
} from './CodeMap';

const ALL_MODES: CodeMapMode[] = ['codeMap', 'prReview', 'healthAudit'];

describe('resolveCodeMapSurfaces', () => {
  // The whole mapping, pinned exhaustively: three modes x both values of
  // `mapIsRenderable`. Every cell of the spec's I/O & Edge-Case Matrix that
  // concerns what renders is one of these six records, so a change to any one
  // of them has to be made here on purpose.
  const EXPECTED: Record<CodeMapMode, Record<'renderable' | 'not', CodeMapSurfaces>> = {
    // I/O Matrix: "Other modes" — unchanged; canvas, history toolbar and
    // notices exactly as before this spec, grid absent.
    codeMap: {
      renderable: { canvas: true, healthAuditGrid: false, pathTraceInput: true, pathTraceResult: true },
      not: { canvas: false, healthAuditGrid: false, pathTraceInput: false, pathTraceResult: false },
    },
    prReview: {
      renderable: { canvas: true, healthAuditGrid: false, pathTraceInput: true, pathTraceResult: true },
      not: { canvas: false, healthAuditGrid: false, pathTraceInput: false, pathTraceResult: false },
    },
    // I/O Matrix: "Health Audit, data ready" — card grid renders; no canvas,
    // no history toolbar; Path Trace still present.
    healthAudit: {
      renderable: { canvas: false, healthAuditGrid: true, pathTraceInput: true, pathTraceResult: false },
      not: { canvas: false, healthAuditGrid: false, pathTraceInput: false, pathTraceResult: false },
    },
  };

  it('maps every mode to exactly the surfaces that mode renders', () => {
    for (const mode of ALL_MODES) {
      assert.deepEqual(resolveCodeMapSurfaces(mode, true), EXPECTED[mode].renderable, mode);
    }
  });

  // I/O Matrix: "Not ready / no Nodes" — the existing notice only; no grid, no
  // empty card frame. `mapIsRenderable` is already false for a non-`ready`
  // fetch, a zero-Node map, or an active PR-Review notice, and nothing may
  // render over those notices regardless of mode.
  it('renders nothing at all when there is no showable map, in any mode', () => {
    for (const mode of ALL_MODES) {
      assert.deepEqual(resolveCodeMapSurfaces(mode, false), EXPECTED[mode].not, mode);
    }
  });

  // The three invariants, stated as relationships rather than as values — so
  // they survive a deliberate future change to any single field above.
  it('never renders both surfaces, and never neither, when the map is renderable', () => {
    for (const mode of ALL_MODES) {
      const surfaces = resolveCodeMapSurfaces(mode, true);
      assert.notEqual(surfaces.canvas, surfaces.healthAuditGrid, mode);
    }
  });

  it('keeps the Path Trace input reachable in every mode, including Health Audit', () => {
    for (const mode of ALL_MODES) {
      assert.equal(resolveCodeMapSurfaces(mode, true).pathTraceInput, true, mode);
    }
    // Stated as an inequality too, so collapsing the input back onto the canvas
    // gate fails rather than silently removing search from the mode that is the
    // app's first-open landing surface.
    const healthAudit = resolveCodeMapSurfaces('healthAudit', true);
    assert.notEqual(healthAudit.pathTraceInput, healthAudit.canvas);
  });

  it('ties the Path Trace result surfaces to the canvas, not to the input', () => {
    for (const mode of ALL_MODES) {
      const surfaces = resolveCodeMapSurfaces(mode, true);
      assert.equal(surfaces.pathTraceResult, surfaces.canvas, mode);
    }
    // A clickable route list over a grid with no canvas under it is the case
    // this exists to prevent — reachable by tracing and then switching back,
    // since nothing resets `pathTrace` on a mode change.
    assert.equal(resolveCodeMapSurfaces('healthAudit', true).pathTraceResult, false);
  });
});

describe('resolvePathTraceSubmit', () => {
  // I/O Matrix: "Trace from Health Audit" — mode switches to `codeMap`, and the
  // route renders on the canvas there. The ORDER is the assertion: the switch
  // must be requested before the trace runs, so `setMode` is flushed and
  // `<ReactFlow>` has mounted by the time the IPC round trip resolves.
  it('requests Code Map Mode before running the trace', () => {
    assert.deepEqual(resolvePathTraceSubmit('healthAudit', 'validateSession'), [
      { kind: 'requestCodeMapMode' },
      { kind: 'runPathTrace', query: 'validateSession' },
    ]);
  });

  it('does not touch the mode when the trace is submitted from another mode', () => {
    for (const mode of ['codeMap', 'prReview'] as const) {
      assert.deepEqual(
        resolvePathTraceSubmit(mode, 'validateSession'),
        [{ kind: 'runPathTrace', query: 'validateSession' }],
        mode,
      );
    }
  });

  it('trims the query it traces', () => {
    assert.deepEqual(resolvePathTraceSubmit('codeMap', '  validateSession \n'), [
      { kind: 'runPathTrace', query: 'validateSession' },
    ]);
  });

  // The pre-existing trimmed-empty guard must short-circuit everything,
  // including the mode switch — an empty submit must not silently move the user
  // off the surface they are reading.
  it('produces no effects at all for a whitespace-only query, in any mode', () => {
    for (const mode of ALL_MODES) {
      assert.deepEqual(resolvePathTraceSubmit(mode, '   \t\n'), [], mode);
      assert.deepEqual(resolvePathTraceSubmit(mode, ''), [], mode);
    }
  });
});

describe('cluster and row labelling', () => {
  // Always: "Every heat label states the count it came from ... never a bare
  // adjective, and is never color-alone". It also has to say WHAT the count is:
  // `heatCount` is the highest count on any single Node, not the module total,
  // and a card listing eight Nodes would otherwise read as if it were.
  it('states the band, the count, and that the count is one Node\'s', () => {
    assert.equal(formatHealthClusterHeat('hot', 7, 12), 'hot · 7 signals on its worst Node, 12 in the module');
    assert.equal(formatHealthClusterHeat('warm', 1, 1), 'warm · 1 signal on its worst Node');
  });

  it('drops the module total when it would only repeat the worst Node', () => {
    assert.equal(formatHealthClusterHeat('cool', 2, 2), 'cool · 2 signals on its worst Node');
  });

  // P3-9: a clean repo is ordinary output stating an explicit zero — no
  // special-case empty state, no congratulatory copy.
  it('states an explicit zero for a clean cluster', () => {
    assert.equal(formatHealthClusterHeat('healthy', 0, 0), 'healthy · 0 signals on its worst Node');
  });

  // The caps' explicit remainders (AD-13's explicit-result-state pattern
  // applied to truncation) — including the singular, which a real repo hits
  // whenever exactly one Node or one module is over the line.
  it('renders both remainders, singular and plural', () => {
    assert.equal(formatRemainingNodes(3), '+3 more Nodes');
    assert.equal(formatRemainingNodes(1), '+1 more Node');
    assert.equal(formatRemainingClusters(2), '+2 more modules');
    assert.equal(formatRemainingClusters(1), '+1 more module');
  });

  // Rows band their own `riskCount` through the same function the helper bands
  // `heatCount` with, so a card and its rows share one set of cut points. These
  // are `riskCountBucket`'s, unchanged — including 4, which is interior to the
  // `warm` band rather than on one of its edges.
  it('bands a row the same way the helper bands a cluster', () => {
    assert.equal(heatForRiskCount(0), 'healthy');
    assert.equal(heatForRiskCount(1), 'cool');
    assert.equal(heatForRiskCount(2), 'cool');
    assert.equal(heatForRiskCount(3), 'warm');
    assert.equal(heatForRiskCount(4), 'warm');
    assert.equal(heatForRiskCount(5), 'warm');
    assert.equal(heatForRiskCount(6), 'hot');
  });

  // The row renders `heatForRiskCount(riskCount)` as a word rather than a
  // separate "healthy" special case, so a Node carrying nothing reads "healthy"
  // by the same path every other row takes.
  it('gives a Node with no signals the word "healthy", by the same path', () => {
    assert.equal(heatForRiskCount(0), 'healthy');
  });
});
