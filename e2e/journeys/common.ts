/**
 * P4-8i: steps and locators the journeys share. Accessible locators only
 * (`getByRole`, `getByText`, `getByLabel`), never CSS classes, so each
 * check reads like its tracker row.
 */
import type { Locator, Page } from 'playwright-core';

import { LANDING_LIMIT_MS, realSleep, STEP_LIMIT_MS, type Step } from '../harness';
import type { JourneyContext } from '../journey';

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Polls `check` until it holds; throws `message` (or a generic line) after `limitMs`. */
export async function until(check: () => Promise<boolean>, message?: string, limitMs = STEP_LIMIT_MS): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message ?? `still false after ${Math.round(limitMs / 1000)} s`);
    await realSleep(200);
  }
}

/** Polls `read` until `accept` holds; returns the last value, or throws with it. */
export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  describe: (value: T) => string,
  limitMs = STEP_LIMIT_MS,
): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(describe(value));
    await realSleep(200);
  }
}

export const openFolderButton = (page: Page) => page.getByRole('button', { name: 'Open a folder', exact: true });
export const closeProjectButton = (page: Page) => page.getByRole('button', { name: 'Close project', exact: true });

/** A canvas card (`<kind> <name>[, changed][…], open Node detail`). */
export const card = (page: Page, name: string) =>
  page.getByRole('application').getByRole('button', { name: new RegExp(`^\\S+ ${escapeRegExp(name)}(,[^]*)?, open Node detail$`) });

export const recentProjectButton = (page: Page, projectName: string) =>
  page.getByRole('region', { name: 'Recent projects' }).getByRole('button', { name: new RegExp(`^${escapeRegExp(projectName)}\\b`) });

export const modeRadio = (page: Page, mode: 'Code Map' | 'PR Review' | 'Health Audit') =>
  page.getByRole('radio', { name: new RegExp(`^${escapeRegExp(mode)}\\b`) });

export const landingStep: Step<JourneyContext> = {
  name: 'Landing shows "Open a folder"',
  limitMs: LANDING_LIMIT_MS,
  run: async ({ page }) => {
    await openFolderButton(page).waitFor({ state: 'visible', timeout: LANDING_LIMIT_MS });
  },
};

export const openProjectStep: Step<JourneyContext> = {
  name: 'Open the project from Recent Projects',
  run: async ({ page, projectName }) => {
    await recentProjectButton(page, projectName).click();
    await closeProjectButton(page).waitFor({ state: 'visible' });
  },
};

/** A step that waits for a card to be drawn. */
export const mapShowsStep = (name: string): Step<JourneyContext> => ({
  name: `The map shows ${name}`,
  run: async ({ page }) => {
    await card(page, name).first().waitFor({ state: 'visible' });
  },
});

/** Text content of a locator, trimmed ('' when it isn't there). */
export async function textOf(locator: Locator): Promise<string> {
  if ((await locator.count()) === 0) return '';
  return ((await locator.first().textContent()) ?? '').trim();
}

/**
 * Presses Tab until `target` has keyboard focus (a real keyboard path, not
 * `focus()`); throws after `maxPresses`.
 */
export async function tabTo(page: Page, target: Locator, maxPresses = 120): Promise<void> {
  for (let i = 0; i < maxPresses; i += 1) {
    if (await target.evaluate((element) => element === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached the target in ${maxPresses} presses`);
}

/** Whether `locator` (first match) has keyboard focus. */
export const isFocused = (locator: Locator) =>
  locator.first().evaluate((element) => element === document.activeElement).catch(() => false);

/** Switches the view mode and waits for its radio to be checked. */
export async function switchMode(page: Page, mode: 'Code Map' | 'PR Review' | 'Health Audit'): Promise<void> {
  const radio = modeRadio(page, mode);
  await radio.click();
  await until(() => radio.isChecked(), `the ${mode} radio never became checked`);
}

/** PR Review: enter `baseRef` ('' = auto-resolve) and press Compute diff scope. */
export async function computeDiffScope(page: Page, baseRef: string): Promise<void> {
  const toolbar = page.getByRole('toolbar', { name: 'PR Review base ref' });
  await toolbar.getByRole('textbox', { name: 'Base ref' }).fill(baseRef);
  await toolbar.getByRole('button', { name: 'Compute diff scope', exact: true }).click();
}

/**
 * PR Review's metrics table, by its caption (`prReviewMetricsCaption`): "…risk
 * metrics…", or "Changed contracts" for a contract-only table (P4-3g).
 */
export const metricsTable = (page: Page) => page.getByRole('table', { name: /risk metrics|^Changed contracts$/ });

export interface MetricsRow {
  node: string;
  /** `changed`, or the hop number as text. */
  hop: string;
}

/** The PR Review metrics table's body rows: each row's Node name and hop cell. */
export async function readMetricsRows(page: Page): Promise<MetricsRow[]> {
  const table = metricsTable(page);
  if ((await table.count()) === 0) return [];
  const rows: MetricsRow[] = [];
  for (const row of await table.getByRole('row').all()) {
    const header = row.getByRole('rowheader');
    if ((await header.count()) === 0) continue; // the column-header row
    const node = ((await header.getByRole('code').first().textContent()) ?? '').trim();
    const hop = ((await row.getByRole('cell').first().textContent()) ?? '').trim();
    rows.push({ node, hop });
  }
  return rows;
}

export const describeRows = (rows: readonly MetricsRow[]) => rows.map((r) => `${r.node}@${r.hop}`).join(', ') || '(none)';

/** PR Review's "Blast radius: N Nodes within D hops." line, parsed (undefined while absent). */
export async function readBlastRadiusLine(page: Page): Promise<{ nodes: number; hops: number; text: string } | undefined> {
  const line = page.getByRole('status').filter({ hasText: /^Blast radius: [\d,]+ Nodes? within \d+ hops?\.$/ });
  const text = await textOf(line);
  const match = /^Blast radius: ([\d,]+) Nodes? within (\d+) hops?\.$/.exec(text);
  if (match === null) return undefined;
  return { nodes: Number(match[1]!.replace(/,/g, '')), hops: Number(match[2]), text };
}

/** The React Flow canvas (`role="application"`). */
export const canvas = (page: Page) => page.getByRole('application');

/** Every canvas card's accessible name (`<kind> <name>…, open Node detail`), in DOM order. */
export async function cardNames(page: Page): Promise<string[]> {
  const cards = canvas(page).getByRole('button', { name: /, open Node detail$/ });
  return Promise.all((await cards.all()).map(async (c) => (await c.getAttribute('aria-label')) ?? ''));
}

/** How many `getCodeMap` calls the renderer has made so far. */
export async function getCodeMapCalls(ctx: JourneyContext): Promise<number> {
  return (await ctx.ipc.calls()).filter((call) => call.method === 'getCodeMap').length;
}

/**
 * Waits until a `getCodeMap` call after the first `from` has SETTLED (its
 * reply landed), with the map mounted throughout. Live pass 2026-10-19: the
 * renderer refetches on `indexed`, and the Graph Service caches the Nodes a
 * diff is computed against only when that fetch lands (~4 s on the fixture);
 * a diff in between is "No project has finished indexing yet."
 */
export async function waitForMapRefetch(ctx: JourneyContext, from: number, mountedCard = 'handleRequest'): Promise<void> {
  await until(async () => {
    // `includeHidden`: when the refetched map lands, React Flow re-measures
    // its cards with `visibility: hidden` for one frame (~7 ms, live pass
    // 2026-10-19) — still mounted, which is what P0-3 asks.
    const mounted = canvas(ctx.page).getByRole('button', {
      name: new RegExp(`^\\S+ ${escapeRegExp(mountedCard)}(,[^]*)?, open Node detail$`),
      includeHidden: true,
    });
    if ((await mounted.count()) === 0) throw new Error('the map unmounted during the re-index');
    const fetches = (await ctx.ipc.calls()).filter((call) => call.method === 'getCodeMap').slice(from);
    return fetches.some((call) => call.settledAt !== undefined);
  }, 'no settled map refetch: the re-index never reached `indexed`, or its map never arrived');
}
