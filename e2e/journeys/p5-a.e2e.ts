/**
 * P5-a journey for tracker row **P5-a**: "Re-index when the checkout moves"
 * (founder decision 6.1; the 2026-10-11 `seventypes` finding).
 *
 * On a scratch repo opened on `main` (`createSevenTypesFixture`: `types.ts`
 * with seven interfaces; the `seventypes` branch adds a field to each):
 * 1. `git checkout seventypes`, then main's real `browser-window-focus`
 *    handler runs (review round 1: fired by the dev-only e2e hook, SIGUSR2
 *    to Electron main, not CDP `Page.bringToFront`): the app re-indexes with
 *    no Close/reopen — the map stays mounted and is refetched once the new
 *    `indexed` arrives — the session notice says "Checkout moved … —
 *    re-indexed; compute the diff again.", and no diff notice shows.
 * 2. PR Review against `main` then reports all 7 changed contracts (the
 *    status line's count, and all 7 in the metrics table — captioned
 *    "Changed contracts" when contract-only (P4-3g) — which is not
 *    capped; the toolbar list is, at 5 + "+2 more"). Review round 1: no
 *    assertion on a "top-level code changed" line — that leftover is a
 *    separate deferred-work finding (2026-10-11) P5-a does not touch.
 * 3. A commit on the same branch, then Compute diff scope with no refocus:
 *    the explicit checkout-changed error (7-character SHAs), never a diff;
 *    the app re-indexes, the map refreshes, PR Review goes idle; computing
 *    again reports the 7 contracts.
 *
 * "Indexed" is observed as the renderer's refetch (`getCodeMap`, counted by
 * the IPC counter): it only refetches on a new `indexed` for the open project.
 * Live pass 2026-10-19: the wait is for that refetch's REPLY (`settledAt`),
 * since the Graph Service caches the Nodes a diff reads only when it lands.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { createSevenTypesFixture, git, SCRATCH_BASE_REF, SEVEN_TYPES_BRANCH, SEVEN_TYPE_NAMES } from '../fixtureProject';
import type { Journey, JourneyContext } from '../journey';
import { computeDiffScope, getCodeMapCalls, landingStep, mapShowsStep, metricsTable, openProjectStep, switchMode, until, waitForMapRefetch } from './common';

const state = { projectPath: '', mapRefetches: 0 };

/** `git rev-parse HEAD` in the fixture (the developer's config ignored). */
function headOf(dir: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD failed in ${dir}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The spec's diff-scope error for a drift from `indexed` to `current`. */
const driftError = (indexed: string, current: string) =>
  `The checkout changed since this project was indexed (HEAD ${indexed.slice(0, 7)} → ${current.slice(0, 7)}). Re-indexing now — compute the diff scope again when the map refreshes.`;

/** Waits for the refetch after a new `indexed` to land; the map stays mounted throughout. */
async function waitForReindexRefresh(ctx: JourneyContext, from: number): Promise<void> {
  await waitForMapRefetch(ctx, from);
  await until(
    async () => (await ctx.page.getByText('Re-indexing — the map shows the last completed index until it finishes.').count()) === 0,
    'still re-indexing',
  );
}

async function expectSevenContracts(ctx: JourneyContext): Promise<void> {
  await computeDiffScope(ctx.page, SCRATCH_BASE_REF);
  const line = ctx.page.getByRole('status').filter({ hasText: /— 7 contracts changed\b/ });
  await line.waitFor({ state: 'visible' });
  for (const name of SEVEN_TYPE_NAMES) {
    await metricsTable(ctx.page).getByRole('button', { name: `Open the type detail of ${name}`, exact: true }).first().waitFor({ state: 'visible' });
  }
}

export const p5_a: Journey = {
  id: 'p5-a',
  rows: ['P5-a'],
  title: 'a checkout + refocus re-indexes (and says so); a diff during drift is the explicit error; then 7 contracts',
  prepare: (env) => {
    state.projectPath = createSevenTypesFixture(env.fixtureSource);
    state.mapRefetches = 0;
    return { projectPath: state.projectPath };
  },
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('handleRequest'),
    {
      name: `git checkout ${SEVEN_TYPES_BRANCH}, refocus (main's browser-window-focus): re-indexed without Close/reopen, no diff notice`,
      run: async (ctx) => {
        await switchMode(ctx.page, 'PR Review');
        const from = await getCodeMapCalls(ctx);
        git(state.projectPath, ['checkout', '--quiet', SEVEN_TYPES_BRANCH]);
        // Review round 1: deterministic — the real `browser-window-focus`
        // handler, fired in main by the dev-only e2e hook (SIGUSR2), rather
        // than CDP `Page.bringToFront` on a window that may already be focused.
        await ctx.emitWindowFocus();
        await waitForReindexRefresh(ctx, from);
        // Never a silent reset: the session notice says why.
        await ctx.page.getByText(/^Checkout moved [0-9a-f]{7} → [0-9a-f]{7} — re-indexed; compute the diff again\.$/).waitFor({ state: 'visible' });
        if ((await ctx.page.getByText(/^The checkout changed since/).count()) > 0) throw new Error('a diff notice showed for a focus re-index');
      },
    },
    {
      name: `PR Review against ${SCRATCH_BASE_REF}: all 7 changed contracts`,
      run: expectSevenContracts,
    },
    {
      name: 'A commit, then Compute diff scope: the explicit checkout-changed error, never a diff',
      run: async (ctx) => {
        const indexed = headOf(state.projectPath);
        git(state.projectPath, ['commit', '--quiet', '--allow-empty', '--message', 'move HEAD']);
        const current = headOf(state.projectPath);
        state.mapRefetches = await getCodeMapCalls(ctx);
        await computeDiffScope(ctx.page, SCRATCH_BASE_REF);
        await ctx.page.getByRole('alert').filter({ hasText: driftError(indexed, current) }).waitFor({ state: 'visible' });
        if ((await ctx.page.getByRole('status').filter({ hasText: /contracts? changed/ }).count()) > 0) {
          throw new Error('a diff result showed alongside the checkout-changed error');
        }
      },
    },
    {
      name: 'The re-index finishes: the map refreshes in place, the checkout-moved notice shows, PR Review is idle, then 7 contracts again',
      run: async (ctx) => {
        await waitForReindexRefresh(ctx, state.mapRefetches);
        await ctx.page.getByText(/^Checkout moved [0-9a-f]{7} → [0-9a-f]{7} — re-indexed; compute the diff again\.$/).waitFor({ state: 'visible' });
        await until(async () => (await ctx.page.getByText(/^The checkout changed since/).count()) === 0, 'the error notice stayed after the refresh');
        await expectSevenContracts(ctx);
      },
    },
  ],
};
