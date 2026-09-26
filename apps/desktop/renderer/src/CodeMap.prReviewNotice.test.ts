/**
 * P1-5 + P1-6: a PR Review diff-scope notice ("No changes to review", "not a
 * git repository", "no base ref resolvable") sits ABOVE the map instead of
 * replacing it.
 *
 * `resolvePrReviewView` is the one derivation `CodeMap` reads for both the
 * notice and the surfaces, so these tests pin the regression directly: with a
 * showable map, every notice status leaves the canvas (and the Back/Forward
 * history drawn over it), the Path Trace input and the Path Trace results on.
 * Gating the surfaces on the notice again fails the first suite.
 *
 * `PrReviewDiffScopeNoticeRegion` / `PrReviewDiffScopeNotice` are hookless and
 * rendered here by calling them and walking the returned elements — the same
 * `renderTree` approach as `CodeMap.healthAuditRow.test.ts`, since the runner
 * is `node --test` with no DOM (`docs/agent.md`).
 *
 * What this cannot reach: that the JSX mounts the region inside the PR Review
 * block above the canvas, and that the gates read these values. That wiring
 * is the spec's owed in-app check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACTIONABLE_NOTICE_GLYPHS, ACTIONABLE_NOTICE_SPOKEN_PREFIX } from './ActionableNotice';
import {
  type CodeMapMode,
  DIFF_SCOPE_NOTICE_TONES,
  type DiffScopeNoticeStatus,
  type DiffScopeState,
  type FetchState,
  PR_REVIEW_NOTICE_ID,
  PrReviewDiffScopeNotice,
  PrReviewDiffScopeNoticeRegion,
  hasShowableMap,
  resolvePrReviewView,
} from './CodeMap';
import { renderTree, textOf, type RenderedElement } from './testRender';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ReadyNode = Extract<FetchState, { status: 'ready' }>['nodes'][number];

const SHOWABLE: FetchState = {
  status: 'ready',
  nodes: [{ id: 'src/a.ts#a', name: 'a' } as unknown as ReadyNode],
  edges: [],
  hiddenByScope: 0,
  appliedScope: [],
};

const NOT_SHOWABLE: Record<string, FetchState> = {
  loading: { status: 'loading' },
  error: { status: 'error', message: 'boom' },
  empty: { status: 'ready', nodes: [], edges: [], hiddenByScope: 0, appliedScope: [] },
};

const NOTICE_STATUSES: DiffScopeNoticeStatus[] = ['no-changes', 'not-a-git-repo', 'no-base-ref-resolvable'];

const NON_NOTICE_STATES: DiffScopeState[] = [
  { status: 'idle' },
  { status: 'loading' },
  { status: 'resolved', resolvedBaseRef: 'main', nodeIds: new Set(['src/a.ts#a']) },
  { status: 'error', message: 'git failed' },
];

const ALL_SURFACES_OFF = { canvas: false, healthAuditGrid: false, pathTraceInput: false, pathTraceResult: false };

// ---------------------------------------------------------------------------
// hasShowableMap
// ---------------------------------------------------------------------------

describe('hasShowableMap', () => {
  it('is true for a loaded map with at least one Node', () => {
    assert.equal(hasShowableMap(SHOWABLE), true);
  });

  for (const [name, state] of Object.entries(NOT_SHOWABLE)) {
    it(`is false when ${name}`, () => {
      assert.equal(hasShowableMap(state), false);
    });
  }
});

// ---------------------------------------------------------------------------
// resolvePrReviewView
// ---------------------------------------------------------------------------

describe('resolvePrReviewView: a PR Review notice keeps the map', () => {
  for (const status of NOTICE_STATUSES) {
    it(`"${status}" with a showable map: notice on, canvas + Path Trace input + results on`, () => {
      const view = resolvePrReviewView('prReview', SHOWABLE, { status });
      assert.equal(view.noticeStatus, status);
      assert.equal(view.surfaces.canvas, true, 'canvas (and the history toolbar over it)');
      assert.equal(view.surfaces.pathTraceInput, true, 'Path Trace input');
      assert.equal(view.surfaces.pathTraceResult, true, 'Path Trace results (a traced route can draw)');
      assert.equal(view.surfaces.healthAuditGrid, false);
    });
  }
});

describe('resolvePrReviewView: when there is no notice', () => {
  for (const state of NON_NOTICE_STATES) {
    it(`PR Review, diff scope "${state.status}": no notice, surfaces on`, () => {
      const view = resolvePrReviewView('prReview', SHOWABLE, state);
      assert.equal(view.noticeStatus, null);
      assert.equal(view.surfaces.canvas, true);
      assert.equal(view.surfaces.pathTraceInput, true);
    });
  }

  const otherModes: CodeMapMode[] = ['codeMap', 'healthAudit'];
  for (const mode of otherModes) {
    for (const status of NOTICE_STATUSES) {
      it(`${mode} with a leftover "${status}" diff scope (after a mode switch): no notice`, () => {
        assert.equal(resolvePrReviewView(mode, SHOWABLE, { status }).noticeStatus, null);
      });
    }
  }

  for (const [name, fetchState] of Object.entries(NOT_SHOWABLE)) {
    for (const status of NOTICE_STATUSES) {
      it(`PR Review "${status}" with no showable map (${name}): no notice, no surfaces`, () => {
        const view = resolvePrReviewView('prReview', fetchState, { status });
        assert.equal(view.noticeStatus, null);
        assert.deepEqual(view.surfaces, ALL_SURFACES_OFF);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// The notice itself
// ---------------------------------------------------------------------------

describe('PrReviewDiffScopeNotice', () => {
  it('renders nothing for a null status', () => {
    assert.equal(PrReviewDiffScopeNotice({ status: null }), null);
  });

  it('gives each of the three statuses its own non-empty sentence', () => {
    const sentences = NOTICE_STATUSES.map((status) => textOf(PrReviewDiffScopeNotice({ status })));
    for (const sentence of sentences) {
      assert.ok(sentence.length > 0);
    }
    assert.equal(new Set(sentences).size, NOTICE_STATUSES.length, 'sentences are distinct');
  });

  it('renders the shared Actionable Notice shape, not the "resolved" status line (P1-7)', () => {
    for (const status of NOTICE_STATUSES) {
      const elements = renderTree(PrReviewDiffScopeNotice({ status }));
      const tone = DIFF_SCOPE_NOTICE_TONES[status];
      const root = elements.find((element) => element.type === 'div');
      assert.equal(root?.props.className, `actionable-notice actionable-notice--${tone}`);
      const glyph = elements.find((element) => element.props.className === 'actionable-notice__glyph');
      assert.equal(glyph && textOf(glyph), ACTIONABLE_NOTICE_GLYPHS[tone]);
      assert.equal(
        elements.some((element) => element.props.className === 'actionable-notice__action'),
        false,
        'no action slot: the base-ref toolbar is the next action',
      );
      assert.equal(
        elements.some((element) => element.props.className === 'code-map__pr-review-resolved'),
        false,
      );
    }
  });

  it('marks "no changes" as info and the two blocking states as warnings', () => {
    assert.equal(DIFF_SCOPE_NOTICE_TONES['no-changes'], 'info');
    assert.equal(DIFF_SCOPE_NOTICE_TONES['not-a-git-repo'], 'warning');
    assert.equal(DIFF_SCOPE_NOTICE_TONES['no-base-ref-resolvable'], 'warning');
  });
});

describe('PrReviewDiffScopeNoticeRegion', () => {
  function region(status: DiffScopeNoticeStatus | null): RenderedElement {
    const root = renderTree(PrReviewDiffScopeNoticeRegion({ status }))[0];
    assert.ok(root);
    return root;
  }

  it('is a role="status" live region with the id the base-ref input describes itself by', () => {
    const root = region('no-changes');
    assert.equal(root.props.role, 'status');
    assert.equal(root.props.id, PR_REVIEW_NOTICE_ID);
  });

  it('stays mounted, empty, for a null status', () => {
    const root = region(null);
    assert.equal(root.props.role, 'status');
    assert.equal(textOf(root), '');
  });

  it('carries the notice sentence for each status', () => {
    for (const status of NOTICE_STATUSES) {
      assert.equal(textOf(region(status)), textOf(PrReviewDiffScopeNotice({ status })));
    }
  });

  it('speaks the tone prefix before a warning sentence, and none for info (P1-7)', () => {
    for (const status of NOTICE_STATUSES) {
      const text = textOf(region(status));
      const glyph = ACTIONABLE_NOTICE_GLYPHS[DIFF_SCOPE_NOTICE_TONES[status]];
      const prefix = ACTIONABLE_NOTICE_SPOKEN_PREFIX[DIFF_SCOPE_NOTICE_TONES[status]];
      assert.ok(text.startsWith(prefix === null ? glyph : `${glyph}${prefix} `), text);
    }
  });
});
