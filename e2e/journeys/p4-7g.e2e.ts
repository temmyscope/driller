/**
 * P4-8i journey for tracker row **P4-7g**: "a pin survives a relaunch".
 *
 * On path-trace-basic: pin serviceB, then cacheLookup, from Node detail
 * ("Pin as entry point", pressed after). They lead the candidate listing
 * in pin order, then handleRequest, and Revealed draws each "pinned by you".
 * `driller-ui-settings.json` holds both ids in that order. Quit, relaunch on
 * the same userData, reopen: after the re-index the same three cards, in the
 * same order, both still "pinned by you". Revealed draws them top to bottom
 * in that order too (FIX-6: `layeredLayout` puts pins first, in pin order).
 */
import type { Page } from 'playwright-core';

import { createFixtureProject, readUserDataJson } from '../fixtureProject';
import { LANDING_LIMIT_MS } from '../harness';
import type { Journey, JourneyContext } from '../journey';
import { canvas, card, eventually, landingStep, mapShowsStep, openProjectStep, recentProjectButton, tabTo, until } from './common';

const PINS = ['serviceB', 'cacheLookup'] as const;

const state: { pinnedIds: string[] } = { pinnedIds: [] };

const viewButton = (page: Page, name: 'Revealed' | 'Full map') =>
  page.getByRole('group', { name: 'Code Map view' }).getByRole('button', { name, exact: true });

function storedPins(ctx: JourneyContext): unknown {
  const byProject = readUserDataJson(ctx.userDataDir, 'driller-ui-settings').entryPinsByProject as Record<string, unknown> | undefined;
  return byProject?.[ctx.projectPath.replace(/[\\/]+$/, '').toLowerCase()];
}

/** The candidate listing through the app's own API (`window.driller.listEntryCandidates`), as `name(kind)`. */
async function listing(page: Page, projectPath: string): Promise<string[]> {
  return page.evaluate(async (p) => {
    const api = (window as unknown as { driller: { listEntryCandidates: (p: string) => Promise<unknown> } }).driller;
    const r = (await api.listEntryCandidates(p)) as { status: string; candidates?: { name?: string; id: string; reason?: { kind: string } }[] };
    if (r.status !== 'found') return [`(${r.status})`];
    return (r.candidates ?? []).map((c) => `${c.name ?? c.id}(${c.reason?.kind ?? '?'})`);
  }, projectPath);
}

/**
 * The pins lead the listing in pin order, and Revealed draws each as
 * "pinned by you" (accessible name "…, pinned entry point, reaches N Nodes,
 * …"), and draws the three cards top to bottom in the listing's order:
 * serviceB, cacheLookup, then handleRequest (reach 4, above both pins
 * before FIX-6).
 */
async function expectPinnedFirst(page: Page, projectPath: string): Promise<void> {
  const want = ['serviceB(pinned)', 'cacheLookup(pinned)', 'handleRequest(no-callers)'];
  await eventually(
    () => listing(page, projectPath),
    (names) => names.join() === want.join(),
    (names) => `listing order ${names.join(', ')}; expected ${want.join(', ')}`,
    20_000,
  );
  for (const pin of PINS) {
    const pinned = canvas(page).getByRole('button', { name: new RegExp(`^Function ${pin}, pinned entry point, reaches \\d+ Nodes?, open Node detail$`) });
    await pinned.waitFor({ state: 'visible' });
    await pinned.getByText('pinned by you').waitFor({ state: 'visible' });
  }
  await canvas(page).getByRole('button', { name: /^Function handleRequest, entry candidate, reaches 4 Nodes, open Node detail$/ }).waitFor({ state: 'visible' });
  const order = ['serviceB', 'cacheLookup', 'handleRequest'];
  await eventually(
    () => canvasTopToBottom(page, order),
    (names) => names.join() === order.join(),
    (names) => `canvas order top to bottom ${names.join(', ')}; expected ${order.join(', ')}`,
    10_000,
  );
}

/** `names`' Revealed cards, sorted by their drawn top edge. */
async function canvasTopToBottom(page: Page, names: readonly string[]): Promise<string[]> {
  const tops = await Promise.all(
    names.map(async (name) => {
      const box = await canvas(page).getByRole('button', { name: new RegExp(`^Function ${name}, `) }).boundingBox();
      return { name, top: box?.y };
    }),
  );
  const missing = tops.filter(({ top }) => top === undefined).map(({ name }) => `${name} (not drawn)`);
  if (missing.length > 0) return missing;
  return (tops as { name: string; top: number }[]).sort((a, b) => a.top - b.top).map(({ name }) => name);
}

async function enterRevealed(page: Page): Promise<void> {
  await viewButton(page, 'Revealed').press('Enter');
  await until(async () => (await viewButton(page, 'Revealed').getAttribute('aria-pressed')) === 'true', 'Revealed not pressed');
}

export const p4_7g: Journey = {
  id: 'p4-7g',
  rows: ['P4-7g'],
  title: 'two pins lead the candidates in pin order, and survive a relaunch',
  prepare: (env) => {
    state.pinnedIds = [];
    return { projectPath: createFixtureProject(env.fixtureSource) };
  },
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('serviceB'),
    {
      name: `Pin ${PINS.join(', then ')} from Node detail`,
      run: async (ctx) => {
        const { page } = ctx;
        for (const name of PINS) {
          await card(page, name).first().press('Enter');
          const detail = page.getByRole('dialog', { name: `Node detail: ${name}` });
          await detail.waitFor({ state: 'visible' });
          const pin = detail.getByRole('region', { name: 'Entry point' }).getByRole('button', { name: 'Pin as entry point' });
          await until(() => pin.isEnabled(), 'the pin toggle stays disabled');
          if ((await pin.getAttribute('aria-pressed')) !== 'false') throw new Error(`${name} already pinned`);
          await tabTo(page, pin);
          await page.keyboard.press('Enter');
          await until(async () => (await pin.getAttribute('aria-pressed')) === 'true', `${name}'s pin toggle never pressed`);
          await page.keyboard.press('Escape');
          await detail.waitFor({ state: 'hidden' });
        }
        const calls = (await ctx.ipc.calls()).filter((c) => c.method === 'setEntryPins');
        state.pinnedIds = calls.map((c) => String(c.args?.[1]));
        if (calls.length !== 2 || calls.some((c) => c.args?.[2] !== true)) throw new Error(`setEntryPins calls: ${JSON.stringify(calls.map((c) => c.args))}`);
        await until(
          async () => JSON.stringify(storedPins(ctx)) === JSON.stringify(state.pinnedIds),
          `entryPinsByProject holds ${JSON.stringify(storedPins(ctx))}, expected ${JSON.stringify(state.pinnedIds)}`,
        );
      },
    },
    {
      name: `Revealed: the listing and the canvas lead with ${PINS.join(', ')} in pin order; both cards "pinned by you"`,
      run: async ({ page, projectPath }) => {
        await enterRevealed(page);
        await expectPinnedFirst(page, projectPath);
      },
    },
    {
      name: 'Quit and relaunch on the same userData',
      limitMs: LANDING_LIMIT_MS,
      run: (ctx) => ctx.relaunch(),
    },
    {
      name: 'Reopen, Revealed: both pins still first, in the same order',
      run: async (ctx) => {
        await recentProjectButton(ctx.page, ctx.projectName).click();
        await card(ctx.page, 'serviceB').first().waitFor({ state: 'visible' });
        await enterRevealed(ctx.page);
        await expectPinnedFirst(ctx.page, ctx.projectPath);
        if (JSON.stringify(storedPins(ctx)) !== JSON.stringify(state.pinnedIds)) {
          throw new Error(`entryPinsByProject now ${JSON.stringify(storedPins(ctx))}`);
        }
      },
    },
  ],
};
