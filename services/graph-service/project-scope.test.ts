/**
 * P2-1: applying a saved indexing scope to a running Graph Service — adopted
 * at once for the active project, and not overwritten by an in-flight index
 * that finishes with the scope it started with.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyScopeChanged,
  isScopeChangedRequest,
  resolveIncludedPathsOnIndexSuccess,
  type ScopeState,
} from './project-scope';

const A = '/repo/a';
const B = '/repo/b';

const idle: ScopeState = {
  activeProjectPath: A,
  activeIncludedPaths: [],
  activeIndexPath: B,
  pendingScopeOverride: undefined,
};

describe('resolveIncludedPathsOnIndexSuccess', () => {
  it('uses the request scope when nothing was saved mid-index', () => {
    assert.deepEqual(resolveIncludedPathsOnIndexSuccess(A, ['web'], undefined), ['web']);
  });

  it('adopts a scope saved for the same project while the index ran', () => {
    assert.deepEqual(resolveIncludedPathsOnIndexSuccess(A, ['web'], { path: A, includedPaths: ['app'] }), ['app']);
  });

  it('adopts an emptied scope saved mid-index', () => {
    assert.deepEqual(resolveIncludedPathsOnIndexSuccess(A, ['web'], { path: A, includedPaths: [] }), []);
  });

  it("ignores another project's override", () => {
    assert.deepEqual(resolveIncludedPathsOnIndexSuccess(A, ['web'], { path: B, includedPaths: ['app'] }), ['web']);
  });
});

describe('applyScopeChanged', () => {
  it('adopts the scope immediately for the active project', () => {
    assert.deepEqual(applyScopeChanged(idle, A, ['web']), {
      activeIncludedPaths: ['web'],
      pendingScopeOverride: undefined,
    });
  });

  it('an empty list restores the whole project', () => {
    assert.deepEqual(applyScopeChanged({ ...idle, activeIncludedPaths: ['web'] }, A, []).activeIncludedPaths, []);
  });

  it('re-index of the active project: adopts now and remembers the override', () => {
    const next = applyScopeChanged({ ...idle, activeIndexPath: A }, A, ['web']);
    assert.deepEqual(next, { activeIncludedPaths: ['web'], pendingScopeOverride: { path: A, includedPaths: ['web'] } });
  });

  it('first index of a project: override only, the active scope is untouched', () => {
    const next = applyScopeChanged(idle, B, ['web']);
    assert.deepEqual(next.activeIncludedPaths, []);
    assert.deepEqual(next.pendingScopeOverride, { path: B, includedPaths: ['web'] });
    // ...and that index then finishes with the saved scope, not its own.
    assert.deepEqual(resolveIncludedPathsOnIndexSuccess(B, [], next.pendingScopeOverride), ['web']);
  });

  it("overlapping indexes: an earlier project's finished index doesn't drop the newer one's override", () => {
    // A's superseded index ran its `finally` (no in-flight flag any more)
    // while B's index — the most recently requested — is still running. The
    // state carries no in-flight flag at all, so this can't regress to
    // gating on one.
    const next = applyScopeChanged({ ...idle, activeIndexPath: B }, B, ['app']);
    assert.deepEqual(next.pendingScopeOverride, { path: B, includedPaths: ['app'] });
    assert.deepEqual(resolveIncludedPathsOnIndexSuccess(B, ['docs'], next.pendingScopeOverride), ['app']);
  });

  it('a newer save for the same project replaces the earlier override', () => {
    const first = applyScopeChanged(idle, B, ['web']);
    const second = applyScopeChanged({ ...idle, ...first }, B, ['app']);
    assert.deepEqual(second.pendingScopeOverride, { path: B, includedPaths: ['app'] });
  });

  it('a scope for a project that is neither active nor indexing changes nothing', () => {
    const state: ScopeState = { ...idle, activeIncludedPaths: ['api'] };
    assert.deepEqual(applyScopeChanged(state, '/repo/c', ['web']), {
      activeIncludedPaths: ['api'],
      pendingScopeOverride: undefined,
    });
  });
});

describe('isScopeChangedRequest', () => {
  it('accepts an absolute path with a string array', () => {
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: A, includedPaths: ['web'] }), true);
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: A, includedPaths: [] }), true);
  });

  it('rejects a relative or empty path', () => {
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: 'repo/a', includedPaths: [] }), false);
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: '', includedPaths: [] }), false);
  });

  it('rejects non-string entries', () => {
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: A, includedPaths: ['web', 1] }), false);
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: A, includedPaths: 'web' }), false);
  });

  it('rejects a missing field, another type, or a non-object', () => {
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', path: A }), false);
    assert.equal(isScopeChangedRequest({ type: 'graphService:scopeChanged', includedPaths: [] }), false);
    assert.equal(isScopeChangedRequest({ type: 'graphService:index', path: A, includedPaths: [] }), false);
    assert.equal(isScopeChangedRequest(null), false);
    assert.equal(isScopeChangedRequest('graphService:scopeChanged'), false);
  });
});
