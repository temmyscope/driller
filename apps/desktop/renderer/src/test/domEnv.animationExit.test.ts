/**
 * P4-8d: a DOM test that fails mid-animation must not hold its file open.
 * Runs `fixtures/failsMidAnimation.fixture.tsx` in a child Node process (as
 * the runner runs a test file) and checks it fails that one test and exits
 * well inside the per-test limit. Without `cleanupAfterEach`'s animation
 * guard, the child never exits (d3 waits on a frame from the closed window)
 * and is killed at the timeout below.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execPath } from 'node:process';

const APP_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const LOADER = fileURLToPath(new URL('../../../../../scripts/register-ts-test-loader.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/failsMidAnimation.fixture.tsx', import.meta.url));

/** The child loads jsdom, React and CodeMap (~1–2 s); a hung one is killed here. */
const CHILD_LIMIT_MS = 12_000;

describe('domEnv: a test that fails mid-animation (P4-8d)', () => {
  it('still lets its file exit promptly, reporting the failure', { timeout: 18_000 }, () => {
    const started = Date.now();
    const child = spawnSync(execPath, ['--import', LOADER, FIXTURE], {
      cwd: APP_ROOT,
      encoding: 'utf8',
      timeout: CHILD_LIMIT_MS,
      killSignal: 'SIGKILL',
    });
    const elapsed = Date.now() - started;
    const output = `${child.stdout}\n${child.stderr}`;
    assert.equal(child.signal, null, `the file exited on its own (killed after ${elapsed} ms)`);
    assert.equal(child.status, 1, 'one failing test');
    assert.match(output, /deliberate failure while the viewport is animating/);
    assert.match(output, /fail 1/);
    assert.ok(elapsed < CHILD_LIMIT_MS, `${elapsed} ms`);
  });
});
