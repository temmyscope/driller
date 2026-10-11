/**
 * P4-8i journey for tracker rows **P4-7d** and **P4-7e**: "Revealed shows
 * candidates with reasons. Expanding reveals callees and Back undoes it,
 * keyboard-only."
 *
 * On path-trace-basic, with the keyboard only (Tab to reach, Enter / `+`
 * to act; no pointer):
 * 1. Revealed → one candidate card, handleRequest, with its reason
 *    "candidate · no callers in indexed code · reaches 4 Nodes" and the
 *    accessible name "…, entry candidate, reaches 4 Nodes, open Node
 *    detail"; no other card. Exactly one `listEntryCandidates` call.
 * 2. `+` on the candidate → two layers open: serviceA, serviceB, then
 *    repository; serviceB's edge to repository is a "↺ shown above" ref.
 * 3. Back (toolbar) → the expand is undone: handleRequest alone again.
 * 4. Full map → every card; Revealed again → the same candidate, with no
 *    second `listEntryCandidates` call.
 * `window.driller` calls are counted from the page side (`ipcCounter.ts`).
 */
import type { Page } from 'playwright-core';

import { createFixtureProject } from '../fixtureProject';
import type { Journey } from '../journey';
import { canvas, card, cardNames, eventually, landingStep, mapShowsStep, openProjectStep, tabTo, until } from './common';

const CANDIDATE_NAME = 'Function handleRequest, entry candidate, reaches 4 Nodes, open Node detail';
const CANDIDATE_REASON = 'candidate · no callers in indexed code · reaches 4 Nodes';

const viewButton = (page: Page, name: 'Revealed' | 'Full map') =>
  page.getByRole('group', { name: 'Code Map view' }).getByRole('button', { name, exact: true });

/** Card names reduced to the Node name (refs and stubs are not cards). */
const shownNodes = async (page: Page) =>
  (await cardNames(page)).map((name) => /^\S+ (\S+?)(,|$)/.exec(name)?.[1] ?? name).sort();

/** Keyboard: Fit View, so React Flow draws every revealed card (it skips off-screen ones). */
async function fitView(page: Page): Promise<void> {
  const fit = canvas(page).getByRole('button', { name: 'Fit View', exact: true });
  await tabTo(page, fit);
  await page.keyboard.press('Enter');
}

async function expectShown(page: Page, expected: readonly string[]): Promise<void> {
  await fitView(page);
  const want = [...expected].sort().join(', ');
  await eventually(
    () => shownNodes(page),
    (names) => names.join(', ') === want,
    (names) => `cards: ${names.join(', ') || '(none)'}; expected ${want}`,
    20_000,
  );
}

async function pressOn(page: Page, target: ReturnType<Page['getByRole']>, key: string): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press(key);
}

export const p4_7de: Journey = {
  id: 'p4-7de',
  rows: ['P4-7d', 'P4-7e'],
  title: 'Revealed candidates with reasons; + expands two layers, Back undoes it — keyboard only',
  prepare: (env) => ({ projectPath: createFixtureProject(env.fixtureSource) }),
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('handleRequest'),
    {
      name: 'Keyboard: Revealed → one candidate, handleRequest, with its reason; one listing call',
      run: async ({ page, ipc }) => {
        await pressOn(page, viewButton(page, 'Revealed'), 'Enter');
        await until(async () => (await viewButton(page, 'Revealed').getAttribute('aria-pressed')) === 'true', 'Revealed not pressed');
        const candidate = canvas(page).getByRole('button', { name: CANDIDATE_NAME, exact: true });
        await candidate.waitFor({ state: 'visible' });
        await candidate.getByText(CANDIDATE_REASON).waitFor({ state: 'visible' });
        await expectShown(page, ['handleRequest']);
        const listings = await ipc.count('listEntryCandidates');
        if (listings !== 1) throw new Error(`listEntryCandidates called ${listings} times`);
      },
    },
    {
      name: 'Keyboard: + on the candidate → serviceA, serviceB, then repository; a "shown above" ref',
      run: async ({ page }) => {
        const candidate = canvas(page).getByRole('button', { name: CANDIDATE_NAME, exact: true });
        await pressOn(page, candidate, '+');
        await page.getByText(/^Revealed 3 callees of handleRequest in 2 layers/).waitFor({ state: 'visible' });
        await expectShown(page, ['handleRequest', 'repository', 'serviceA', 'serviceB']);
        await canvas(page).getByRole('button', { name: 'repository is shown above, go to it' }).waitFor({ state: 'visible' });
      },
    },
    {
      name: 'Keyboard: Back → the expand is undone, handleRequest alone',
      run: async ({ page }) => {
        const back = page.getByRole('toolbar', { name: 'Map traversal history' }).getByRole('button', { name: 'Back' });
        await until(() => back.isEnabled(), 'Back is disabled after the expand');
        await pressOn(page, back, 'Enter');
        await page.getByText(/^Back: restored the view before expanding handleRequest/).waitFor({ state: 'visible' });
        await expectShown(page, ['handleRequest']);
      },
    },
    {
      name: 'Keyboard: Full map → every card; Revealed again → same candidate, no second listing',
      run: async ({ page, ipc }) => {
        await pressOn(page, viewButton(page, 'Full map'), 'Enter');
        await card(page, 'cacheLookup').first().waitFor({ state: 'visible' });
        await pressOn(page, viewButton(page, 'Revealed'), 'Enter');
        await canvas(page).getByRole('button', { name: CANDIDATE_NAME, exact: true }).waitFor({ state: 'visible' });
        await expectShown(page, ['handleRequest']);
        const listings = await ipc.count('listEntryCandidates');
        if (listings !== 1) throw new Error(`listEntryCandidates called ${listings} times (expected the first listing reused)`);
      },
    },
  ],
};
