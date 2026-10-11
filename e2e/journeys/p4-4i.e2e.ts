/**
 * P4-8i journey for tracker row **P4-4i**: "a restored section is carried
 * by the first fetch; Close then reopen re-reads" — live, across a real
 * relaunch and the real `driller-ui-settings.json`.
 *
 * A two-folder repo with the allowlist `api`, `web` seeded in settings:
 * 1. Pick `api` in the Section bar → the map is api's (handleRequest, no
 *    renderPage) and `activeSectionByProject` holds the project → `api`.
 * 2. Quit and relaunch on the same userData, reopen → the first
 *    `getCodeMap` call carries `api` (no whole-scope fetch first, so no
 *    `all` flash), the `api` tab is selected, and nothing is announced.
 * 3. Close, then reopen → again the first fetch carries `api`.
 * 4. Pick `all` → the entry is removed (never stored as "all").
 * `window.driller` calls are counted from the page side (`ipcCounter.ts`).
 */
import type { Page } from 'playwright-core';

import { createSectionedFixture, readUserDataJson } from '../fixtureProject';
import { LANDING_LIMIT_MS } from '../harness';
import type { Journey, JourneyContext } from '../journey';
import { card, closeProjectButton, eventually, landingStep, openProjectStep, recentProjectButton, until } from './common';

const sectionTab = (page: Page, section: string) =>
  page.getByRole('tablist', { name: 'Section' }).getByRole('tab', { name: new RegExp(`^${section}\\b`) });

/** The stored section for the project (`undefined` when there's no entry). */
function storedSection(ctx: JourneyContext): unknown {
  const byProject = readUserDataJson(ctx.userDataDir, 'driller-ui-settings').activeSectionByProject as Record<string, unknown> | undefined;
  return byProject?.[ctx.projectPath.replace(/[\\/]+$/, '').toLowerCase()];
}

/** Section-scoped map: api's Nodes only. */
async function expectApiMap(page: Page): Promise<void> {
  await card(page, 'handleRequest').first().waitFor({ state: 'visible' });
  await until(async () => (await card(page, 'renderPage').count()) === 0, 'renderPage (web/) is on the api map');
  await until(async () => (await sectionTab(page, 'api').getAttribute('aria-selected')) === 'true', 'the api tab is not selected');
}

/** Every `getCodeMap` since `from`: the first carries `api`, and none is whole-scope. */
async function expectFetchesCarryApi(ctx: JourneyContext, from: number): Promise<void> {
  const fetches = await eventually(
    async () => (await ctx.ipc.calls()).filter((c) => c.method === 'getCodeMap').slice(from),
    (f) => f.length > 0,
    () => 'no getCodeMap call',
  );
  const sections = fetches.map((c) => (c.args?.[0] === undefined ? '(whole scope)' : String(c.args[0])));
  if (sections.some((s) => s !== 'api')) throw new Error(`getCodeMap sections in order: ${sections.join(', ')} (expected api only)`);
}

async function expectQuietRestore(page: Page): Promise<void> {
  const announced = page.getByRole('status').filter({ hasText: /^(Loading|Showing) section/ });
  if ((await announced.count()) > 0) throw new Error(`announced: "${await announced.first().textContent()}"`);
}

export const p4_4i: Journey = {
  id: 'p4-4i',
  rows: ['P4-4i'],
  title: 'the remembered section survives a relaunch and a Close/reopen; the first fetch carries it',
  prepare: (env) => ({ projectPath: createSectionedFixture(env.fixtureSource), seed: { includedPaths: ['api', 'web'] } }),
  steps: [
    landingStep,
    openProjectStep,
    {
      name: 'The Section bar lists all, api, web; all is selected',
      run: async ({ page }) => {
        for (const section of ['all', 'api', 'web']) await sectionTab(page, section).waitFor({ state: 'visible' });
        await until(async () => (await sectionTab(page, 'all').getAttribute('aria-selected')) === 'true', 'all is not selected');
        await card(page, 'renderPage').first().waitFor({ state: 'visible' });
      },
    },
    {
      name: 'Pick api: the map is api\'s, and the section is saved for the project',
      run: async (ctx) => {
        await sectionTab(ctx.page, 'api').click();
        await expectApiMap(ctx.page);
        await until(async () => storedSection(ctx) === 'api', `activeSectionByProject holds ${JSON.stringify(storedSection(ctx))}`);
      },
    },
    {
      name: 'Quit and relaunch on the same userData',
      limitMs: LANDING_LIMIT_MS,
      run: (ctx) => ctx.relaunch(),
    },
    {
      name: 'Reopen: the first fetch carries api (no all flash), api selected, nothing announced',
      run: async (ctx) => {
        await recentProjectButton(ctx.page, ctx.projectName).click();
        await expectApiMap(ctx.page);
        await expectFetchesCarryApi(ctx, 0);
        await expectQuietRestore(ctx.page);
      },
    },
    {
      name: 'Close, then reopen: the section is re-read, the first fetch carries api',
      run: async (ctx) => {
        await closeProjectButton(ctx.page).click();
        const before = (await ctx.ipc.calls()).filter((c) => c.method === 'getCodeMap').length;
        await recentProjectButton(ctx.page, ctx.projectName).click();
        await expectApiMap(ctx.page);
        await expectFetchesCarryApi(ctx, before);
        await expectQuietRestore(ctx.page);
      },
    },
    {
      name: 'Pick all: the stored entry is removed (never "all")',
      run: async (ctx) => {
        await sectionTab(ctx.page, 'all').click();
        await card(ctx.page, 'renderPage').first().waitFor({ state: 'visible' });
        await until(async () => storedSection(ctx) === undefined, `activeSectionByProject still holds ${JSON.stringify(storedSection(ctx))}`);
      },
    },
  ],
};
