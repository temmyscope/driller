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
  buildDiffScopeCarryRequest,
  buildExpandBlastRadiusRequest,
  buildPathTraceRequest,
  INVALID_OPERATION_SECTION_RESULT,
  parseDiffScopeCarryArgs,
  parseOperationSectionArg,
  toValidatedDiffScopeCarryResult,
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

describe('P4-4h: the diff-scope carry check (founder decision 2026-10-04)', () => {
  it('valid arguments: sections null (all) or non-empty strings; the base ref trimmed', () => {
    assert.deepEqual(parseDiffScopeCarryArgs('/p', 'web', null, ' origin/main '), {
      ok: true,
      projectPath: '/p',
      fromSection: 'web',
      toSection: null,
      baseRef: 'origin/main',
    });
  });

  it('anything malformed is answered without sending', () => {
    assert.deepEqual(parseDiffScopeCarryArgs('', 'web', 'api', 'main'), {
      ok: false,
      result: { status: 'error', message: 'Invalid project path.' },
    });
    for (const section of ['', 42, undefined, ['api']]) {
      assert.deepEqual(parseDiffScopeCarryArgs('/p', section, 'api', 'main'), { ok: false, result: INVALID_OPERATION_SECTION_RESULT });
      assert.deepEqual(parseDiffScopeCarryArgs('/p', 'web', section, 'main'), { ok: false, result: INVALID_OPERATION_SECTION_RESULT });
    }
    for (const baseRef of ['', '  ', null, 7]) {
      assert.deepEqual(parseDiffScopeCarryArgs('/p', 'web', 'api', baseRef), {
        ok: false,
        result: { status: 'error', message: 'Invalid base ref.' },
      });
    }
  });

  it('the Graph Service request', () => {
    const args = parseDiffScopeCarryArgs('/p', null, 'api', 'main');
    assert.ok(args.ok);
    assert.deepEqual(buildDiffScopeCarryRequest(args, 9), {
      type: 'graphService:diffScopeCarry',
      projectPath: '/p',
      requestId: 9,
      fromSection: null,
      toSection: 'api',
      baseRef: 'main',
    });
  });

  it('the reply is validated: known statuses pass, anything else is an error', () => {
    for (const status of ['same-repository', 'ref-exists', 'not-carried'] as const) {
      assert.deepEqual(toValidatedDiffScopeCarryResult({ status, extra: 1 }), { status });
    }
    assert.deepEqual(toValidatedDiffScopeCarryResult({ status: 'error', message: 'x' }), { status: 'error', message: 'x' });
    for (const bad of [null, 'same-repository', { status: 'maybe' }, { status: 'error' }]) {
      assert.deepEqual(toValidatedDiffScopeCarryResult(bad), { status: 'error', message: 'Malformed diff-scope carry reply.' });
    }
  });
});
