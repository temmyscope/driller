/**
 * P4-4 phase 2a: the renderer sends Path Trace, diff scope and Blast Radius
 * expansion with the section on screen, and a reply for any other section
 * never applies.
 *
 * `settleSectionScopedReply` (the one settle rule all three use) is pinned
 * directly. The hooks that call it can't be rendered without a DOM, so —
 * like `CodeMap.prReviewMetrics.test.ts`'s wiring checks — their wiring is
 * pinned on the source: each call passes `requestedSection ?? undefined`,
 * captured from `sectionRef` when the request is sent, and each settle (and
 * each rejection) checks it against `sectionRef.current` again. The preload
 * bridge is checked the same way (it imports Electron).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { PathTraceResult } from '@driller/ipc-contracts';

import { blastRadiusStateOnUnknownSection, settleSectionScopedReply } from './CodeMap';

type Settled = { kind: 'apply'; result: unknown } | { kind: 'unknown'; section: string };

function settle(result: PathTraceResult, requested: string | null, current: string | null): Settled[] {
  const calls: Settled[] = [];
  settleSectionScopedReply(result, requested, current, {
    apply: (applied) => calls.push({ kind: 'apply', result: applied }),
    unknownSection: (section) => calls.push({ kind: 'unknown', section }),
  });
  return calls;
}

const FOUND: PathTraceResult = { status: 'found', path: ['a'], parents: { a: null }, depths: { a: 0 } };
const UNKNOWN: PathTraceResult = { status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] };

describe('settleSectionScopedReply', () => {
  it('applies a reply for the section still on screen (or the whole scope)', () => {
    assert.deepEqual(settle(FOUND, 'api', 'api'), [{ kind: 'apply', result: FOUND }]);
    assert.deepEqual(settle(FOUND, null, null), [{ kind: 'apply', result: FOUND }]);
    const error: PathTraceResult = { status: 'error', message: 'x' };
    assert.deepEqual(settle(error, 'api', 'api'), [{ kind: 'apply', result: error }]);
  });

  it('drops a reply for a section that is no longer on screen', () => {
    assert.deepEqual(settle(FOUND, 'api', 'web'), []);
    assert.deepEqual(settle(FOUND, 'api', null), []);
    assert.deepEqual(settle(FOUND, null, 'api'), []);
    // Even its unknown-section: the shell already moved on.
    assert.deepEqual(settle(UNKNOWN, 'docs', null), []);
  });

  it('hands an unknown-section reply to the fallback, never to apply', () => {
    assert.deepEqual(settle(UNKNOWN, 'docs', 'docs'), [{ kind: 'unknown', section: 'docs' }]);
  });

  it('P4-4d review round 1: hands over the requested section, never the reply echo', () => {
    assert.deepEqual(settle({ ...UNKNOWN, section: 'echo' } as PathTraceResult, 'docs', 'docs'), [{ kind: 'unknown', section: 'docs' }]);
  });
});

describe('CodeMap source: the section reaches all three operations', () => {
  const src = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');

  it('the section prop defaults to the whole scope and is mirrored into a ref before any reply settles', () => {
    assert.match(src, /\n {2}section = null,\n {2}onUnknownSection,\n\}: CodeMapProps\)/);
    assert.match(src, /useLayoutEffect\(\(\) => \{\s*sectionRef\.current = section;\s*\}, \[section\]\);/);
  });

  const calls: [string, RegExp][] = [
    ['tracePath', /\.tracePath\(query, requestedSection \?\? undefined\)/],
    [
      'computeDiffScope',
      /\.computeDiffScope\(projectPath, trimmedBaseRef\.length > 0 \? trimmedBaseRef : undefined, requestedSection \?\? undefined\)/,
    ],
    ['expandBlastRadius', /\.expandBlastRadius\(projectPath, seedNodeIds, requestedSection \?\? undefined\)/],
  ];
  for (const [name, call] of calls) {
    it(`${name} is sent with the section and settled against the current one`, () => {
      const at = src.search(call);
      assert.ok(at >= 0, `${name} passes the section`);
      assert.equal(src.match(new RegExp(`^\\s+\\.${name}\\(`, 'gm'))?.length, 1, `one ${name} call`);
      const before = src.slice(Math.max(0, at - 600), at);
      assert.match(before, /const requestedSection = sectionRef\.current;/, 'captured when the request is sent');
      const after = src.slice(at, at + 3000);
      assert.match(after, /settleSectionScopedReply\(reply, requestedSection, sectionRef\.current, \{/);
      assert.match(
        after,
        /unknownSection: \(gone\) => \{[\s\S]{0,900}(onUnknownSectionRef\.current\?\.\(gone\);|blastRadiusStateOnUnknownSection\(gone, onUnknownSectionRef\.current\))/,
      );
      assert.match(after, /\.catch\(\(error: unknown\) => \{\s*if \([^)]*RequestIdRef\.current !== requestId \|\| requestedSection !== sectionRef\.current\) \{\s*return;/);
    });
  }
});

describe('preload: the section crosses the bridge only when given', () => {
  const src = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8');
  it('each operation omits the argument for the whole scope and passes it otherwise', () => {
    assert.match(
      src,
      /tracePath: \(query: string, section\?: string\)[^=]*=>\s*section === undefined\s*\? ipcRenderer\.invoke\(IpcChannels\.pathTrace, query\)\s*: ipcRenderer\.invoke\(IpcChannels\.pathTrace, query, section\)/,
    );
    assert.match(
      src,
      /section === undefined\s*\? ipcRenderer\.invoke\(IpcChannels\.diffScopeCompute, projectPath, baseRef\)\s*: ipcRenderer\.invoke\(IpcChannels\.diffScopeCompute, projectPath, baseRef, section\)/,
    );
    assert.match(
      src,
      /section === undefined\s*\? ipcRenderer\.invoke\(IpcChannels\.blastRadiusExpand, projectPath, nodeIds\)\s*: ipcRenderer\.invoke\(IpcChannels\.blastRadiusExpand, projectPath, nodeIds, section\)/,
    );
  });
});

describe('blastRadiusStateOnUnknownSection (P4-4e review round 1)', () => {
  it('with a fallback: calls it and leaves the state to the reload it triggers', () => {
    const called: string[] = [];
    assert.equal(blastRadiusStateOnUnknownSection('docs', (section) => called.push(section)), null);
    assert.deepEqual(called, ['docs']);
  });

  it('without one: an explicit error naming the section, never loading or idle', () => {
    assert.deepEqual(blastRadiusStateOnUnknownSection('docs', undefined), {
      status: 'error',
      message: 'The section "docs" is not in this project\'s included subfolders.',
    });
  });

  it('the expansion effect applies it', () => {
    const src = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');
    assert.match(
      src,
      /const next = blastRadiusStateOnUnknownSection\(gone, onUnknownSectionRef\.current\);\s*if \(next !== null\) \{\s*setBlastRadiusState\(next\);/,
    );
  });
});
