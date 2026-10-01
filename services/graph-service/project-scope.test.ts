/**
 * P2-1: applying a saved indexing scope to a running Graph Service — adopted
 * at once for the active project, and not overwritten by an in-flight index
 * that finishes with the scope it started with.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyScopeChanged,
  isFileInScope,
  isScopeChangedRequest,
  resolveIncludedPathsOnIndexSuccess,
  sectionOfFile,
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

// P4-4 phase 1a (AD-13 "Section scope"): the nearest (longest) allowlist
// entry owns a file; path boundaries are respected.
describe('sectionOfFile', () => {
  it('maps a file to the entry that contains it, on a path boundary', () => {
    assert.equal(sectionOfFile('api/x.ts', ['web', 'api']), 'api');
    assert.equal(sectionOfFile('web/a/b.ts', ['web', 'api']), 'web');
    assert.equal(sectionOfFile('webapp/x.ts', ['web', 'api']), undefined);
    // A file that IS the entry belongs to it, like `isFileInScope`.
    assert.equal(sectionOfFile('web', ['web', 'api']), 'web');
  });

  it('nested entries: the longest containing entry wins, whatever the allowlist order', () => {
    for (const allowlist of [['apps', 'apps/web'], ['apps/web', 'apps']]) {
      assert.equal(sectionOfFile('apps/web/a.ts', allowlist), 'apps/web');
      assert.equal(sectionOfFile('apps/b.ts', allowlist), 'apps');
      // `apps/webapp` is under `apps`, not `apps/web`.
      assert.equal(sectionOfFile('apps/webapp/c.ts', allowlist), 'apps');
    }
    assert.equal(sectionOfFile('a/b/c/d.ts', ['a', 'a/b/c', 'a/b']), 'a/b/c');
  });

  it('a file outside the allowlist, and any file under an empty allowlist, has no section', () => {
    assert.equal(sectionOfFile('docs/a.md', ['web', 'api']), undefined);
    assert.equal(sectionOfFile('web/a.ts', []), undefined);
  });

  it('each in-scope file is in exactly one section, so the per-section counts sum to the in-scope total', () => {
    const allowlist = ['apps', 'apps/web', 'web', 'api'];
    const files = [
      'apps/b.ts',
      'apps/web/a.ts',
      'apps/web/deep/c.ts',
      'apps/webapp/d.ts',
      'web/a.ts',
      'webapp/x.ts',
      'api/s.ts',
      'docs/a.md',
      'apps',
    ];
    const counts = new Map<string, number>();
    for (const file of files) {
      const section = sectionOfFile(file, allowlist);
      if (section !== undefined) {
        assert.ok(isFileInScope(file, [section]), `${file} is inside its own section`);
        counts.set(section, (counts.get(section) ?? 0) + 1);
      }
    }
    assert.deepEqual(Object.fromEntries(counts), { apps: 3, 'apps/web': 2, web: 1, api: 1 });
    const inScope = files.filter((file) => isFileInScope(file, allowlist)).length;
    assert.equal([...counts.values()].reduce((sum, n) => sum + n, 0), inScope);
  });
});
