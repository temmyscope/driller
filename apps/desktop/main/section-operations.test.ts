/**
 * P4-4 phase 2a: main's `section` argument for Path Trace, diff scope and
 * Blast Radius expansion (`section-operations.ts`): validated before
 * anything is sent, and carried on the Graph Service request only when
 * given — without one, each request is exactly the message main sent
 * before this phase.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildComputeDiffScopeRequest,
  buildExpandBlastRadiusRequest,
  buildPathTraceRequest,
  INVALID_OPERATION_SECTION_RESULT,
  parseOperationSectionArg,
} from './section-operations';

describe('parseOperationSectionArg', () => {
  it('absent is the whole scope; a non-empty string is a section', () => {
    assert.deepEqual(parseOperationSectionArg(undefined), { ok: true });
    assert.deepEqual(parseOperationSectionArg('api'), { ok: true, section: 'api' });
    // Whether it is an allowlist entry is the Graph Service's call.
    assert.deepEqual(parseOperationSectionArg('docs'), { ok: true, section: 'docs' });
    assert.deepEqual(parseOperationSectionArg('all'), { ok: true, section: 'all' });
  });

  it('anything else is malformed and never sent', () => {
    for (const value of [42, null, '', ['api'], { section: 'api' }, true, 0]) {
      assert.deepEqual(parseOperationSectionArg(value), { ok: false }, JSON.stringify(value));
    }
  });

  it('the malformed reply is the explicit error', () => {
    assert.deepEqual(INVALID_OPERATION_SECTION_RESULT, { status: 'error', message: 'Invalid section.' });
  });
});

describe('the Graph Service requests', () => {
  it('without a section: exactly the pre-P4-4e messages, with no section key', () => {
    const trace = buildPathTraceRequest('handleOrder', 7);
    assert.deepEqual(trace, { type: 'graphService:pathTrace', query: 'handleOrder', requestId: 7 });
    assert.ok(!('section' in trace));
    assert.deepEqual(Object.keys(trace), ['type', 'query', 'requestId']);

    const diff = buildComputeDiffScopeRequest('/p', 3, 'main');
    assert.deepEqual(Object.entries(diff), [
      ['type', 'graphService:computeDiffScope'],
      ['projectPath', '/p'],
      ['requestId', 3],
      ['baseRef', 'main'],
    ]);
    const noRef = buildComputeDiffScopeRequest('/p', 4, undefined);
    assert.deepEqual(Object.keys(noRef), ['type', 'projectPath', 'requestId']);

    const expand = buildExpandBlastRadiusRequest('/p', ['a', 'b'], 5);
    assert.deepEqual(Object.entries(expand), [
      ['type', 'graphService:expandBlastRadius'],
      ['projectPath', '/p'],
      ['nodeIds', ['a', 'b']],
      ['requestId', 5],
    ]);
  });

  it('with a section: each request carries it', () => {
    assert.equal(buildPathTraceRequest('q', 1, 'api').section, 'api');
    assert.deepEqual(buildComputeDiffScopeRequest('/p', 2, undefined, 'api'), {
      type: 'graphService:computeDiffScope',
      projectPath: '/p',
      requestId: 2,
      section: 'api',
    });
    assert.deepEqual(buildExpandBlastRadiusRequest('/p', ['a'], 3, 'apps/web'), {
      type: 'graphService:expandBlastRadius',
      projectPath: '/p',
      nodeIds: ['a'],
      requestId: 3,
      section: 'apps/web',
    });
  });
});
