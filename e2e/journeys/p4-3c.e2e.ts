/**
 * P4-8i journey for tracker row **P4-3c**: stepping the blast-radius depth
 * updates the metrics table's affected rows with no IPC.
 *
 * On the scratch repo in PR Review (base `main`): depth 2 shows handleRequest
 * (changed) + serviceA, serviceB (hop 1) + repository (hop 2); − to depth 1
 * drops repository, + brings it back, and the toolbar's count matches the
 * rows at each depth. `window.driller` calls are counted from the page side
 * (CDP binding, `ipcCounter.ts`): no `expandBlastRadius` (or any other
 * fetch) is made by a step. A Code Map ↔ PR Review round trip keeps the same
 * rows at the same depth, also without a refetch.
 */
import { createScratchDiffFixture, SCRATCH_BASE_REF } from '../fixtureProject';
import type { Journey, JourneyContext } from '../journey';
import {
  computeDiffScope,
  describeRows,
  eventually,
  landingStep,
  mapShowsStep,
  openProjectStep,
  readBlastRadiusLine,
  readMetricsRows,
  switchMode,
  type MetricsRow,
} from './common';

const DEPTH_1 = ['handleRequest@changed', 'serviceA@1', 'serviceB@1'];
const DEPTH_2 = [...DEPTH_1, 'repository@2'];
/** Calls that would mean a refetch rather than a local re-slice. */
const FETCHES = ['expandBlastRadius', 'computeDiffScope', 'getCodeMap'] as const;

const key = (rows: readonly MetricsRow[]) => rows.map((r) => `${r.node}@${r.hop}`).sort().join(', ');
const state: { fetchCounts: Record<string, number> } = { fetchCounts: {} };

async function countFetches(ctx: JourneyContext): Promise<Record<string, number>> {
  const calls = await ctx.ipc.calls();
  return Object.fromEntries(FETCHES.map((m) => [m, calls.filter((c) => c.method === m).length]));
}

async function expectRowsAt(ctx: JourneyContext, depth: number, expected: readonly string[]): Promise<void> {
  const want = [...expected].sort().join(', ');
  await ctx.page.getByRole('group', { name: 'Blast radius depth' }).getByText(`${depth}-hop${depth === 1 ? '' : 's'}`, { exact: true }).waitFor({ state: 'visible' });
  await eventually(
    () => readMetricsRows(ctx.page),
    (rows) => key(rows) === want,
    (rows) => `at depth ${depth}: rows ${describeRows(rows)}, expected ${want}`,
  );
  // The toolbar's count matches the affected rows (well under the 50 cap here).
  await eventually(
    () => readBlastRadiusLine(ctx.page),
    (line) => line !== undefined && line.hops === depth && line.nodes === expected.length - 1,
    (line) => `toolbar "${line?.text ?? '(no line)'}" vs ${expected.length - 1} affected rows at depth ${depth}`,
  );
  if ((await ctx.page.getByText('Computing blast radius…').count()) > 0) {
    throw new Error('"Computing blast radius…" shown after a depth step');
  }
}

async function expectNoNewFetch(ctx: JourneyContext): Promise<void> {
  const now = await countFetches(ctx);
  const grew = FETCHES.filter((m) => now[m] !== state.fetchCounts[m]);
  if (grew.length > 0) {
    throw new Error(`IPC after a depth step / mode switch: ${grew.map((m) => `${m} ${state.fetchCounts[m]}→${now[m]}`).join(', ')}`);
  }
}

export const p4_3c: Journey = {
  id: 'p4-3c',
  rows: ['P4-3c'],
  title: 'depth steps re-slice the affected rows with zero IPC',
  prepare: (env) => {
    state.fetchCounts = {};
    return { projectPath: createScratchDiffFixture(env.fixtureSource) };
  },
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('handleRequest'),
    {
      name: `PR Review against ${SCRATCH_BASE_REF}: depth 2 rows (changed + hops 1, 2)`,
      run: async (ctx) => {
        await switchMode(ctx.page, 'PR Review');
        await computeDiffScope(ctx.page, SCRATCH_BASE_REF);
        await expectRowsAt(ctx, 2, DEPTH_2);
        state.fetchCounts = await countFetches(ctx);
        if (state.fetchCounts.expandBlastRadius !== 1) {
          throw new Error(`expected one expandBlastRadius call for the diff scope, saw ${state.fetchCounts.expandBlastRadius}`);
        }
      },
    },
    {
      name: 'Depth 2 → 1: repository leaves the rows, no IPC',
      run: async (ctx) => {
        await ctx.page.getByRole('button', { name: 'Show a shallower blast radius' }).click();
        await expectRowsAt(ctx, 1, DEPTH_1);
        await expectNoNewFetch(ctx);
      },
    },
    {
      name: 'Depth 1 → 2: repository returns at hop 2, no IPC',
      run: async (ctx) => {
        await ctx.page.getByRole('button', { name: 'Expand the blast radius further' }).click();
        await expectRowsAt(ctx, 2, DEPTH_2);
        await expectNoNewFetch(ctx);
      },
    },
    {
      name: 'Code Map ↔ PR Review keeps the same rows at the same depth, no IPC',
      run: async (ctx) => {
        await switchMode(ctx.page, 'Code Map');
        await switchMode(ctx.page, 'PR Review');
        await expectRowsAt(ctx, 2, DEPTH_2);
        await expectNoNewFetch(ctx);
      },
    },
  ],
};
