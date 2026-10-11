/**
 * P4-8i journey for tracker row **P2-1**: "Node Detail closes when its Node
 * falls out of scope; not-applied sentence with the service down".
 *
 * On a two-folder repo (`api/` = path-trace-basic, `web/` = renderPage →
 * formatTitle), with no scope:
 * 1. Node Detail open on renderPage; Settings → Indexing scope `api` → Save
 *    → "Saved — the map now shows only api."; closing Settings shows Node
 *    Detail gone and renderPage off the map, handleRequest still on it.
 * 2. The Graph Service is killed (SIGKILL of its utility process, as the
 *    P0-3 live check did); saving an empty scope then says "Saved — applies
 *    when the Graph Service is running again."; "Retry the Graph Service"
 *    brings the whole project back (renderPage returns).
 */
import type { Page } from 'playwright-core';

import { createSectionedFixture } from '../fixtureProject';
import type { Journey } from '../journey';
import { card, landingStep, mapShowsStep, openProjectStep, until } from './common';

const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'Settings' });

async function saveScope(page: Page, value: string, confirmation: string, stillOpenBeneath?: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsDialog(page).waitFor({ state: 'visible' });
  if (stillOpenBeneath !== undefined && (await page.getByRole('dialog', { name: stillOpenBeneath }).count()) === 0) {
    throw new Error(`"${stillOpenBeneath}" closed when Settings opened, before the save`);
  }
  const scope = settingsDialog(page).getByRole('group', { name: 'Indexing scope' });
  await scope.getByRole('textbox', { name: 'Included subfolders' }).fill(value);
  await scope.getByRole('button', { name: 'Save', exact: true }).click();
  await scope.getByText(confirmation, { exact: true }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await settingsDialog(page).waitFor({ state: 'hidden' });
}

export const p2_1: Journey = {
  id: 'p2-1',
  rows: ['P2-1'],
  title: 'Node Detail closes when its Node leaves the scope; scope saved while the service is down',
  prepare: (env) => ({ projectPath: createSectionedFixture(env.fixtureSource) }),
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('renderPage'),
    mapShowsStep('handleRequest'),
    {
      name: 'Open Node Detail on renderPage',
      run: async ({ page }) => {
        // Enter on the card (the canvas's layer controls can overlap it at this size).
        await card(page, 'renderPage').first().press('Enter');
        await page.getByRole('dialog', { name: 'Node detail: renderPage' }).waitFor({ state: 'visible' });
      },
    },
    {
      name: 'Save scope "api": confirmation; Node Detail closes, renderPage leaves the map',
      run: async ({ page }) => {
        await saveScope(page, 'api', 'Saved — the map now shows only api.', 'Node detail: renderPage');
        await page.getByRole('dialog', { name: 'Node detail: renderPage' }).waitFor({ state: 'hidden' });
        await card(page, 'renderPage').first().waitFor({ state: 'detached' });
        await card(page, 'handleRequest').first().waitFor({ state: 'visible' });
        if ((await page.getByText(/^Indexing/).count()) > 0) throw new Error('an Indexing state showed for a scope save');
      },
    },
    {
      name: 'Graph Service killed: the degraded notice offers "Retry the Graph Service"',
      run: async ({ page, killGraphService }) => {
        await killGraphService();
        await page.getByRole('button', { name: 'Retry the Graph Service' }).first().waitFor({ state: 'visible' });
      },
    },
    {
      name: 'Save an empty scope while down: "applies when the Graph Service is running again"',
      run: async ({ page }) => {
        await saveScope(page, '', 'Saved — applies when the Graph Service is running again.');
      },
    },
    {
      name: 'Retry the Graph Service: the saved (empty) scope applies, renderPage returns',
      run: async ({ page }) => {
        await page.getByRole('button', { name: 'Retry the Graph Service' }).first().click();
        await card(page, 'renderPage').first().waitFor({ state: 'visible' });
        await card(page, 'handleRequest').first().waitFor({ state: 'visible' });
        await until(async () => (await page.getByRole('button', { name: 'Retry the Graph Service' }).count()) === 0, 'still degraded');
      },
    },
  ],
};
