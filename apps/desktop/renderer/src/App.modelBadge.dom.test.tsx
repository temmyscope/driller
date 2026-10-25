/**
 * P5-c review round 1: under Cloud the footer never shows a model badge —
 * not even for model status that still arrives (late progress from a
 * download a Local session started). Under Local it shows as before. App
 * over a fake `window.driller`; `visibleModelStatus` (pure) covers a badge
 * left from an earlier Local session.
 */
import './test/domEnv';
import { cleanupAfterEach } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BackendConfig, ModelStatusMessage, RecentProject } from '@driller/ipc-contracts';
import { App } from './App';
import { createFakeDrillerApi, type FakeDrillerApi } from './test/fakeDrillerApi';
import { sectionedMap } from './test/mapFixture';

afterEach(cleanupAfterEach);

const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
// `[2026-10-25]` Scaled for CI like the test budget beside it. A flat inner
// budget gave every `waitFor` half the allowance, relative to machine speed,
// that the test around it got — see `4a1c48b` and status.md's row on it.
const FIND = { timeout: 1_500 * (env.CI === 'true' ? 2 : 1) };
const PROJECT = '/work/badge-repo';
const recent: RecentProject = { path: PROJECT, name: 'badge-repo', lastOpenedAt: '2026-10-18T09:00:00.000Z' };
const AT = '2026-10-18T10:00:00.000Z';
const DOWNLOADING: ModelStatusMessage = { type: 'graphService:modelStatus', state: 'downloading', at: AT, downloadedBytes: 512, totalBytes: 2048 };
const READY: ModelStatusMessage = { type: 'graphService:modelStatus', state: 'ready', at: AT, model: 'fixture.gguf' };

function appFake(activeBackend: BackendConfig['activeBackend']): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    listRecentProjects: async () => [recent],
    getBackendConfig: async () => ({ activeBackend, hasCloudKey: activeBackend === 'cloud', isLinuxInsecureBackend: false }),
    openFolder: async () => ({ status: 'opened', project: recent, git: { isGitRepo: true } }),
    getActiveSection: async () => null,
    getProjectScope: async () => ({ includedPaths: [] }),
    getCodeMap: async () => sectionedMap(null),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
  });
  fake.install();
  return fake;
}

async function openProject(fake: FakeDrillerApi): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Open a folder' }, FIND));
  await screen.findByRole('button', { name: 'Close project' }, FIND);
  await waitFor(() => assert.equal(fake.calls.getBackendConfig.length > 0, true), FIND);
}

const badge = () => document.querySelector('footer.model-status');

describe('App: the model badge under Cloud (P5-c review round 1)', () => {
  it('Local: download progress and ready show in the footer', BUDGET, async () => {
    const fake = appFake('local');
    render(<App />);
    await openProject(fake);
    fake.emit.onModelStatus(DOWNLOADING);
    await waitFor(() => assert.match(badge()?.textContent ?? '', /Downloading model/), FIND);
    fake.emit.onModelStatus(READY);
    await waitFor(() => assert.match(badge()?.textContent ?? '', /Model ready/), FIND);
  });

  it('Cloud: model status that still arrives never shows a badge', BUDGET, async () => {
    const fake = appFake('cloud');
    render(<App />);
    await openProject(fake);
    fake.emit.onModelStatus(DOWNLOADING);
    fake.emit.onModelStatus(READY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(badge(), null);
    assert.equal(screen.queryByText(/Downloading model|Model ready/), null);
  });
});
