/**
 * P4-8i journey for tracker row **P0-5**: "Blast-radius badge equals the
 * highlighted Nodes at 2 hops".
 *
 * On the scratch repo (handleRequest edited on `review`, base `main`):
 * handleRequest's card badge reads N, and in PR Review at the default
 * 2-hop depth the toolbar's "Blast radius: N Nodes within 2 hops." and the
 * metrics table's affected rows (the same `nodesWithinDepth` slice the
 * canvas highlight paints) count the same N Nodes: serviceA, serviceB
 * (hop 1) and repository (hop 2). The canvas highlight itself is CSS-only
 * (no accessible state), so it is read through those rows.
 */
import { createScratchDiffFixture, SCRATCH_BASE_REF } from '../fixtureProject';
import type { Journey } from '../journey';
import {
  card,
  computeDiffScope,
  describeRows,
  eventually,
  landingStep,
  mapShowsStep,
  openProjectStep,
  readBlastRadiusLine,
  readMetricsRows,
  switchMode,
} from './common';

/** P0-5's rule on path-trace-basic: forward within 2 hops of handleRequest; nothing calls it. */
export const HANDLE_REQUEST_BLAST_RADIUS = ['repository', 'serviceA', 'serviceB'] as const;

const state = { badge: -1 };

export const p0_5: Journey = {
  id: 'p0-5',
  rows: ['P0-5'],
  title: 'blast-radius badge = the Nodes highlighted at 2 hops (handleRequest)',
  prepare: (env) => {
    state.badge = -1;
    return { projectPath: createScratchDiffFixture(env.fixtureSource) };
  },
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('handleRequest'),
    {
      name: "Read handleRequest's blast-radius badge (Code Map)",
      run: async ({ page }) => {
        const badge = card(page, 'handleRequest').first().getByRole('img', { name: /^Blast radius: / });
        const label = (await badge.getAttribute('aria-label')) ?? '';
        const match = /^Blast radius: (\d+) Nodes? within 2 hops \(callers and callees\)/.exec(label);
        if (match === null) throw new Error(`unexpected badge label "${label}"`);
        state.badge = Number(match[1]);
        if (state.badge !== HANDLE_REQUEST_BLAST_RADIUS.length) {
          throw new Error(`badge reads ${state.badge}, expected ${HANDLE_REQUEST_BLAST_RADIUS.length} (${HANDLE_REQUEST_BLAST_RADIUS.join(', ')})`);
        }
      },
    },
    {
      name: `PR Review against ${SCRATCH_BASE_REF}: handleRequest is the one changed Node`,
      run: async ({ page }) => {
        await switchMode(page, 'PR Review');
        await computeDiffScope(page, SCRATCH_BASE_REF);
        await page.getByRole('status').filter({ hasText: /— 1 changed Node\.$/ }).waitFor({ state: 'visible' });
        await page.getByRole('application').getByRole('button', { name: /^Function handleRequest, changed, / }).waitFor({ state: 'visible' });
      },
    },
    {
      name: 'Default depth is 2 hops; the toolbar count equals the badge',
      run: async ({ page }) => {
        await page.getByRole('group', { name: 'Blast radius depth' }).getByText('2-hops', { exact: true }).waitFor({ state: 'visible' });
        await eventually(
          () => readBlastRadiusLine(page),
          (line) => line !== undefined && line.hops === 2 && line.nodes === state.badge,
          (line) => `toolbar reads "${line?.text ?? '(no line)'}", badge ${state.badge}`,
        );
      },
    },
    {
      name: 'The highlighted (affected) Nodes at 2 hops are exactly the badge count',
      run: async ({ page }) => {
        const rows = await eventually(
          () => readMetricsRows(page),
          (r) => r.some((row) => row.hop === 'changed') && r.filter((row) => row.hop !== 'changed').length === state.badge,
          (r) => `rows ${describeRows(r)}; badge ${state.badge}`,
        );
        const affected = rows.filter((r) => r.hop !== 'changed');
        const names = affected.map((r) => r.node).sort();
        if (names.join() !== [...HANDLE_REQUEST_BLAST_RADIUS].sort().join()) {
          throw new Error(`affected ${describeRows(affected)}, expected ${HANDLE_REQUEST_BLAST_RADIUS.join(', ')}`);
        }
        if (affected.some((r) => !['1', '2'].includes(r.hop))) throw new Error(`a hop beyond 2: ${describeRows(affected)}`);
      },
    },
  ],
};
