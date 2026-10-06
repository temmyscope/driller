/**
 * P4-8c: `App` mounted in jsdom with a fake `window.driller` — the smoke
 * test that the DOM environment can render the shell's hooks for real.
 * `domEnv` must stay the first import (see its header).
 */
import './test/domEnv';
import { cleanupAfterEach } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { render, screen, within } from '@testing-library/react';
import type { RecentProject } from '@driller/ipc-contracts';
import { App } from './App';
import { MODE_SWITCHER_HINT_ID } from './ModeSwitcher';
import { createFakeDrillerApi, notStubbedMessage, type FakeDrillerApi } from './test/fakeDrillerApi';

afterEach(cleanupAfterEach);

/** Spec P4-8c: each smoke mount under 2 s; doubled under CI (P4-8b's convention). */
const MOUNT_BUDGET_MS = 2_000 * (env.CI === 'true' ? 2 : 1);
/** `findBy…` waits this long at most — the fake settles at once. */
const FIND = { timeout: 1_000 };

const RECENTS: RecentProject[] = [
  { path: '/work/alpha-service', name: 'alpha-service', lastOpenedAt: '2026-10-05T09:00:00.000Z' },
  { path: '/work/beta-web', name: 'beta-web', lastOpenedAt: '2026-10-04T09:00:00.000Z' },
];

function landingFake(): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    listRecentProjects: async () => RECENTS,
    getBackendConfig: async () => ({ activeBackend: 'local', hasCloudKey: false, isLinuxInsecureBackend: false }),
  });
  fake.install();
  return fake;
}

describe('App (DOM smoke)', () => {
  it('mounts to the landing view: Open a folder, both recents, and a disabled mode switcher with its hint', { timeout: MOUNT_BUDGET_MS }, async () => {
    const fake = landingFake();
    render(<App />);

    const recents = await screen.findByRole('region', { name: 'Recent projects' }, FIND);
    assert.ok(within(recents).getByText('alpha-service'));
    assert.ok(within(recents).getByText('beta-web'));
    assert.ok(screen.getByRole('button', { name: 'Open a folder' }));

    const switcher = screen.getByRole('radiogroup', { name: 'View mode' });
    assert.equal(switcher.getAttribute('aria-disabled'), 'true');
    assert.equal(switcher.getAttribute('aria-describedby'), MODE_SWITCHER_HINT_ID);
    const hint = document.getElementById(MODE_SWITCHER_HINT_ID);
    assert.equal(hint?.textContent, 'Open a project to switch views');
    for (const radio of within(switcher).getAllByRole('radio')) {
      assert.equal(radio.getAttribute('aria-disabled'), 'true');
    }

    assert.equal(fake.calls.listRecentProjects.length, 1);
    // No project is open, so App asked for no map.
    assert.equal(fake.calls.getCodeMap.length, 0);
  });

  it('subscribes to the Graph Service status stream on mount, and unsubscribes on unmount', { timeout: MOUNT_BUDGET_MS }, async () => {
    const fake = landingFake();
    const { unmount } = render(<App />);
    await screen.findByRole('region', { name: 'Recent projects' }, FIND);
    assert.ok(screen.getByRole('button', { name: 'Open a folder' }));
    assert.equal(fake.subscriberCount('onGraphServiceStatus'), 1);

    unmount();
    assert.equal(fake.subscriberCount('onGraphServiceStatus'), 0);
  });

  it('names an IPC call the test did not stub, even when App swallows its rejection', { timeout: MOUNT_BUDGET_MS }, async () => {
    // `listRecentProjects` is left out on purpose: App catches its failure
    // and shows no recents, so only the fake can tell.
    const fake = createFakeDrillerApi({
      getBackendConfig: async () => ({ activeBackend: 'local', hasCloudKey: false, isLinuxInsecureBackend: false }),
    });
    fake.install();
    render(<App />);
    assert.ok(await screen.findByRole('button', { name: 'Open a folder' }, FIND));

    assert.deepEqual(fake.unstubbedCalls, ['listRecentProjects']);
    assert.throws(() => fake.assertNoUnstubbedCalls(), {
      message: new RegExp(notStubbedMessage('listRecentProjects').replaceAll('.', '\\.')),
    });
    // Declared, so `cleanupAfterEach` lets this negative test pass.
    fake.expectUnstubbed('listRecentProjects');
  });
});
