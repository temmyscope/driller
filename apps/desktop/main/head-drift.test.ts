/**
 * P5-a (founder decision 6.1): main's side of re-indexing when the checkout
 * moves — the `graphService:headChanged` validation and routing decision
 * (pure, `head-drift.ts`), the focus-time `graphService:checkHead` request,
 * and how `index.ts` wires both (source).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { GraphServiceHeadChangedMessage, GraphServiceStatusMessage } from '@driller/ipc-contracts';

import { buildCheckHeadRequest } from './graph-service-requests';
import { e2eHooksEnabled, headChangedAction, isHeadChangedMessage, tagHeadMove, type PendingHeadMove } from './head-drift';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const message: GraphServiceHeadChangedMessage = { type: 'graphService:headChanged', path: '/repo/a', indexedHead: A, currentHead: B };

describe('P5-a: isHeadChangedMessage', () => {
  it('accepts a well-formed message (SHA-1 or SHA-256 heads)', () => {
    assert.equal(isHeadChangedMessage(message), true);
    assert.equal(isHeadChangedMessage({ ...message, currentHead: 'c'.repeat(64) }), true);
  });

  it('rejects anything else', () => {
    for (const bad of [
      null,
      'graphService:headChanged',
      { ...message, type: 'graphService:status' },
      { ...message, path: '' },
      { ...message, path: 3 },
      { ...message, indexedHead: undefined },
      { ...message, indexedHead: 'abc1234' },
      { ...message, currentHead: 'HEAD' },
      { ...message, currentHead: B.toUpperCase() },
    ]) {
      assert.equal(isHeadChangedMessage(bad), false, JSON.stringify(bad));
    }
  });
});

describe('P5-a: headChangedAction', () => {
  it('the open project, with the Graph Service running: reindex', () => {
    assert.equal(headChangedAction(message, '/repo/a', true), 'reindex');
  });

  it('a project no longer open, none open, or no running Graph Service: ignore', () => {
    assert.equal(headChangedAction(message, '/repo/b', true), 'ignore', 'switched project');
    assert.equal(headChangedAction(message, '/repo/a/sub', true), 'ignore', 'a subfolder is another project');
    assert.equal(headChangedAction(message, null, true), 'ignore', 'closed');
    assert.equal(headChangedAction(message, '/repo/a', false), 'ignore', 'not running');
  });
});

describe('P5-a: the focus check', () => {
  it('buildCheckHeadRequest names the open project', () => {
    assert.deepEqual(buildCheckHeadRequest('/repo/a'), { type: 'graphService:checkHead', path: '/repo/a' });
  });
});

describe('P5-a review round 1: tagHeadMove', () => {
  const AT = '2026-10-15T00:00:00.000Z';
  const pending: PendingHeadMove = { path: '/repo/a', indexedHead: A, currentHead: B };
  const headMoved = { indexedHead: A, currentHead: B };
  const indexing: GraphServiceStatusMessage = { state: 'indexing', path: '/repo/a', at: AT };
  const indexed: GraphServiceStatusMessage = { state: 'indexed', path: '/repo/a', at: AT, nodes: 1, edges: 0, elapsedMs: 1 };
  const failed: GraphServiceStatusMessage = { state: 'error', path: '/repo/a', at: AT, message: 'x', elapsedMs: 1 };

  it("tags the re-index's indexing (still pending), then its indexed or error (no longer pending)", () => {
    assert.deepEqual(tagHeadMove(indexing, pending, '/repo/a'), { status: { ...indexing, headMoved }, pending });
    assert.deepEqual(tagHeadMove(indexed, pending, '/repo/a'), { status: { ...indexed, headMoved }, pending: undefined });
    assert.deepEqual(tagHeadMove(failed, pending, '/repo/a'), { status: { ...failed, headMoved }, pending: undefined });
  });

  it('nothing pending, another path, a project no longer open, an exit, or a path-less status: never tagged', () => {
    assert.deepEqual(tagHeadMove(indexing, undefined, '/repo/a'), { status: indexing, pending: undefined });
    assert.deepEqual(tagHeadMove({ ...indexing, path: '/repo/b' }, pending, '/repo/a'), { status: { ...indexing, path: '/repo/b' }, pending });
    assert.deepEqual(tagHeadMove(indexing, pending, '/repo/b'), { status: indexing, pending: undefined });
    assert.deepEqual(tagHeadMove(indexing, pending, null), { status: indexing, pending: undefined });
    const exited: GraphServiceStatusMessage = { state: 'exited', at: AT, code: 1 };
    assert.deepEqual(tagHeadMove(exited, pending, '/repo/a'), { status: exited, pending: undefined });
    const alive: GraphServiceStatusMessage = { state: 'alive', at: AT };
    assert.deepEqual(tagHeadMove(alive, pending, '/repo/a'), { status: alive, pending });
    const crash: GraphServiceStatusMessage = { state: 'error', at: AT, message: 'spawn failed' };
    assert.deepEqual(tagHeadMove(crash, pending, '/repo/a'), { status: crash, pending });
  });
});

describe('P5-a review round 1: the e2e focus hook', () => {
  it('only in an unpackaged app with DRILLER_E2E_HOOKS=1', () => {
    assert.equal(e2eHooksEnabled(false, { DRILLER_E2E_HOOKS: '1' }), true);
    assert.equal(e2eHooksEnabled(true, { DRILLER_E2E_HOOKS: '1' }), false, 'never packaged');
    assert.equal(e2eHooksEnabled(false, {}), false);
    assert.equal(e2eHooksEnabled(false, { DRILLER_E2E_HOOKS: 'true' }), false);
  });
});

describe('P5-a: index.ts wiring (source)', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('a validated headChanged is routed to handleHeadChanged, which re-indexes through sendIndexRequest', () => {
    assert.match(src, /if \(isHeadChangedMessage\(message\)\) \{\s*handleHeadChanged\(message\);\s*return;/);
    const handler = /function handleHeadChanged\([^)]*\): void \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    assert.match(handler, /const running = graphService !== null && !isGraphServiceShuttingDown;/);
    assert.match(handler, /headChangedAction\(message, currentProjectPath, running\) === 'reindex'/);
    assert.match(
      handler,
      /pendingHeadMove = \{ path: currentProjectPath, indexedHead: message\.indexedHead, currentHead: message\.currentHead \};\s*sendIndexRequest\(currentProjectPath\);/,
    );
    assert.match(handler, /console\.warn\(/, 'an ignored one is logged');
  });

  it('a window regaining focus posts the check for the open project, only while the Graph Service runs', () => {
    assert.match(src, /app\.on\('browser-window-focus', \(\) => \{\s*checkHeadOnFocus\(\);/);
    const check = /function checkHeadOnFocus\(\): void \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
    assert.match(check, /if \(graphService === null \|\| isGraphServiceShuttingDown \|\| currentProjectPath === null\) \{\s*return;/);
    assert.match(check, /graphService\.postMessage\(buildCheckHeadRequest\(currentProjectPath\)\);/);
  });

  it('review round 1: Graph Service statuses go to the renderer through tagHeadMove; an exit drops the pending move', () => {
    assert.match(
      src,
      /const tagged = tagHeadMove\(message, pendingHeadMove, currentProjectPath\);\s*pendingHeadMove = tagged\.pending;\s*sendGraphServiceStatus\(tagged\.status\);/,
    );
    assert.match(src, /graphService\.on\('exit', \(code: number\) => \{\s*graphService = null;[\s\S]{0,200}pendingHeadMove = undefined;/);
  });

  it('review round 1: SIGUSR2 emits the real browser-window-focus, only behind e2eHooksEnabled', () => {
    assert.match(
      src,
      /if \(e2eHooksEnabled\(app\.isPackaged, process\.env\)\) \{\s*process\.on\('SIGUSR2', \(\) => \{\s*app\.emit\('browser-window-focus', undefined, mainWindow\);/,
    );
    assert.equal(src.match(/process\.on\('SIGUSR2'/g)?.length, 1);
  });
});
