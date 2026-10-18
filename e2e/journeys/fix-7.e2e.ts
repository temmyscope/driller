/**
 * FIX-7 journey: the 2026-10-11 batched live pass's regressions, checked in
 * the real app on the scratch repo (handleRequest edited on `review`, base
 * `main`) — tracker rows **P2-4**, **P3-11/12**, **P4-7e**, **FIX-5** and **P5-f**.
 *
 * 1. Path Trace `handleRequest`, then its callee pill (P2-4's neighbour
 *    trace): every lit edge's VISIBLE path (`.react-flow__edge-path`)
 *    paints `--trace-cyan` at 2px — read with `getComputedStyle`, which is
 *    the only place the paint shows (before FIX-7 the class coloured only the
 *    invisible interaction path; the visible one stayed rgb(62,62,62) 1px).
 * 2. Revealed, expand handleRequest with the mouse: no two cards' boxes
 *    overlap, and each "Expand callees" button is the topmost element at its
 *    own centre (the live pass found 3 of 12 covered by the card below).
 *    P5-f: every Node card is at most 320 px wide (layout width) with no
 *    child past its right edge, and a plain edge (handleRequest → serviceA,
 *    unlit) paints `--border-strong` at 1.5px — DESIGN.md `canvas-edge`,
 *    where it used to paint React Flow's rgb(62,62,62) 1px.
 * 3. Back pressed with the mouse at the start of history: Back disables and
 *    focus lands on handleRequest's card, not <body>.
 * 4. PR Review against `main`: every drawn edge leaving the changed handleRequest
 *    paints `--accent` at 2px (P3-11's "changed accent"); the lit trace is
 *    dismissed first, since a traced route wins over that accent by design.
 *
 * Accessible locators only: an edge is found by React Flow's accessible
 * name ("Edge from <id> to <id>") and its paint read with
 * `getComputedStyle` on its first child (the visible path); cards by their
 * accessible names and `boundingBox()`.
 */
import type { Page } from 'playwright-core';

import { createScratchDiffFixture, SCRATCH_BASE_REF } from '../fixtureProject';
import { realSleep } from '../harness';
import type { Journey } from '../journey';
import { canvas, card, computeDiffScope, eventually, isFocused, landingStep, mapShowsStep, openProjectStep, switchMode, until } from './common';

/** An edge drawn between two fixture Nodes (React Flow's accessible name, "Edge from <id> to <id>"). */
const edge = (page: Page, from: string, to: string) =>
  canvas(page).getByRole('group', { name: new RegExp(`^Edge from \\S*\\b${from} to \\S*\\b${to}$`) });

interface Paint {
  stroke: string;
  width: string;
  /** `token`'s colour, computed on a probe path in the same SVG (so both serialise alike). */
  expected: string;
}

/**
 * The computed stroke and width of an edge's VISIBLE path — the group's
 * first child; React Flow draws the transparent interaction path after it —
 * next to `token`'s computed colour.
 */
async function paintOf(page: Page, from: string, to: string, token: string): Promise<Paint> {
  return edge(page, from, to).first().evaluate((group, cssVar) => {
    const visible = group.firstElementChild;
    const svg = (group as SVGGElement).ownerSVGElement;
    let expected = '(no svg)';
    if (svg !== null) {
      const probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      probe.style.stroke = `var(${cssVar})`;
      svg.append(probe);
      expected = getComputedStyle(probe).stroke;
      probe.remove();
    }
    const style = visible === null ? null : getComputedStyle(visible);
    return { stroke: style?.stroke ?? '(no path)', width: style?.strokeWidth ?? '(no path)', expected };
  }, token);
}

const describePaint = (from: string, to: string, paint: Paint, token: string) =>
  `${from}→${to} paints ${paint.stroke} ${paint.width}; ${token} is ${paint.expected}`;

/** Waits until each `[from, to]` edge's visible path paints `token` at `width` (2px: a lit edge). */
async function expectPainted(
  page: Page,
  pairs: readonly (readonly [string, string])[],
  token: string,
  width = '2px',
): Promise<void> {
  for (const [from, to] of pairs) {
    await eventually(
      () => paintOf(page, from, to, token),
      (paint) => paint.stroke === paint.expected && paint.width === width,
      (paint) => describePaint(from, to, paint, token),
      10_000,
    );
  }
}

/** Waits until the `[from, to]` edge no longer paints `token`. */
async function expectNotPainted(page: Page, from: string, to: string, token: string): Promise<void> {
  await eventually(
    () => paintOf(page, from, to, token),
    (paint) => paint.stroke !== paint.expected,
    (paint) => `still lit: ${describePaint(from, to, paint, token)}`,
    10_000,
  );
}

const viewButton = (page: Page, name: 'Revealed' | 'Full map') =>
  page.getByRole('group', { name: 'Code Map view' }).getByRole('button', { name, exact: true });

interface CardBox {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every drawn card's on-screen box: Node cards and "shown above" ref cards. */
async function cardBoxes(page: Page): Promise<CardBox[]> {
  const cards = await canvas(page).getByRole('button', { name: /(, open Node detail| is shown above, go to it)$/ }).all();
  const boxes: CardBox[] = [];
  for (const c of cards) {
    const box = await c.boundingBox();
    if (box !== null) boxes.push({ name: (await c.getAttribute('aria-label')) ?? '?', ...box });
  }
  return boxes;
}

/** P5-f: DESIGN.md `node-card.maxWidth`, plus a pixel for subpixel rounding. */
const CARD_MAX_WIDTH = 321;

interface CardFit {
  name: string;
  /** The card's layout width in CSS px (`offsetWidth`: unscaled by the canvas zoom, unlike `boundingBox()`). */
  width: number;
  /** Each child whose right edge passes the card's, as `<tag>.<class> +Npx`. */
  overflowing: string[];
}

/** Every drawn Node card's layout width and any child that overflows its right edge (P5-f, 7.2). */
async function cardFits(page: Page): Promise<CardFit[]> {
  const cards = await canvas(page).getByRole('button', { name: /, open Node detail$/ }).all();
  const fits: CardFit[] = [];
  for (const c of cards) {
    fits.push(
      await c.evaluate((element) => {
        const right = element.getBoundingClientRect().right;
        const overflowing: string[] = [];
        // Every descendant, so a chip inside the wrapping strip counts too.
        const walk = (parent: Element): void => {
          for (const child of Array.from(parent.children)) {
            const past = child.getBoundingClientRect().right - right;
            if (past > 1) overflowing.push(`${child.tagName.toLowerCase()}.${child.getAttribute('class') ?? ''} +${past.toFixed(1)}px`);
            walk(child);
          }
        };
        walk(element);
        return { name: element.getAttribute('aria-label') ?? '?', width: (element as HTMLElement).offsetWidth, overflowing };
      }),
    );
  }
  return fits;
}

function overlaps(boxes: readonly CardBox[]): string[] {
  const found: string[] = [];
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      // A pixel of tolerance for subpixel rounding of borders.
      if (a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1) {
        found.push(`"${a.name}" ∩ "${b.name}"`);
      }
    }
  }
  return found;
}

/** The "Expand callees" buttons whose centre is covered by something else (a mouse can't press them). */
async function coveredExpandButtons(page: Page): Promise<string[]> {
  const covered: string[] = [];
  for (const button of await canvas(page).getByRole('button', { name: /^Expand \d+ callees? of / }).all()) {
    const hidden = await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === null || (hit !== element && !element.contains(hit));
    });
    if (hidden) covered.push((await button.getAttribute('aria-label')) ?? '?');
  }
  return covered;
}

/** path-trace-basic's traced route from handleRequest (`fixtures/path-trace-basic/README.md`). */
const ROUTE = [
  ['handleRequest', 'serviceA'],
  ['handleRequest', 'serviceB'],
  ['serviceA', 'repository'],
  ['serviceB', 'repository'],
  ['repository', 'cacheLookup'],
] as const;

export const fix_7: Journey = {
  id: 'fix-7',
  rows: ['P2-4', 'P3-11/12', 'P4-7e', 'FIX-5', 'P5-f'],
  title: 'lit edges paint their token; Revealed cards never overlap; Back at the start focuses the card',
  prepare: (env) => ({ projectPath: createScratchDiffFixture(env.fixtureSource) }),
  steps: [
    landingStep,
    openProjectStep,
    mapShowsStep('handleRequest'),
    {
      name: 'Path Trace "handleRequest": the route’s edges paint --trace-cyan at 2px',
      run: async ({ page }) => {
        const search = page.getByRole('search', { name: 'Search a traced path' });
        await search.getByRole('textbox', { name: 'Path Trace query' }).fill('handleRequest');
        await search.getByRole('button', { name: 'Trace', exact: true }).click();
        await page.getByRole('region', { name: 'Call tree' }).getByRole('button', { name: /^cacheLookup\b/ }).waitFor({ state: 'visible' });
        await expectPainted(page, ROUTE, '--trace-cyan');
      },
    },
    {
      name: 'P2-4: handleRequest’s callee pill lights its call edges, painted --trace-cyan at 2px',
      run: async ({ page }) => {
        await card(page, 'handleRequest').first().getByRole('button', { name: /^\d+ calls? — show the callees of handleRequest$/ }).click();
        await expectPainted(page, ROUTE.slice(0, 2), '--trace-cyan');
        // The neighbour trace replaced the route: serviceA → repository is no longer lit.
        await expectNotPainted(page, 'serviceA', 'repository', '--trace-cyan');
        // Dismiss it: a lit route wins over PR Review's changed accent on the same edge (by design).
        await page.getByRole('region', { name: /^Callees of handleRequest/ }).getByRole('button', { name: 'Dismiss', exact: true }).click();
        await expectNotPainted(page, 'handleRequest', 'serviceA', '--trace-cyan');
      },
    },
    {
      name: 'P4-7e / P5-f: Revealed, expand handleRequest with the mouse → no two cards overlap; no Expand button is covered; cards ≤ 320 px; a plain edge paints --border-strong 1.5px',
      run: async ({ page }) => {
        await viewButton(page, 'Revealed').click();
        await until(async () => (await viewButton(page, 'Revealed').getAttribute('aria-pressed')) === 'true', 'Revealed not pressed');
        await canvas(page).getByRole('button', { name: /^Expand \d+ callees? of handleRequest$/ }).click();
        await page.getByText(/^Revealed 3 callees of handleRequest in 2 layers/).waitFor({ state: 'visible' });
        await canvas(page).getByRole('button', { name: 'Fit View', exact: true }).click();
        await eventually(
          async () => ({ boxes: await cardBoxes(page), covered: await coveredExpandButtons(page) }),
          ({ boxes, covered }) => boxes.length >= 4 && overlaps(boxes).length === 0 && covered.length === 0,
          ({ boxes, covered }) =>
            `${boxes.length} cards; overlapping: ${overlaps(boxes).join(', ') || 'none'}; covered: ${covered.join(', ') || 'none'}`,
          10_000,
        );
        // P5-f (7.2): no card is wider than the 320 px cap, and nothing inside one overflows it.
        await eventually(
          () => cardFits(page),
          (fits) => fits.length >= 3 && fits.every((fit) => fit.width <= CARD_MAX_WIDTH && fit.overflowing.length === 0),
          (fits) =>
            fits
              .filter((fit) => fit.width > CARD_MAX_WIDTH || fit.overflowing.length > 0)
              .map((fit) => `"${fit.name}" ${fit.width}px${fit.overflowing.length > 0 ? `, overflowing: ${fit.overflowing.join(', ')}` : ''}`)
              .join('; ') || `${fits.length} cards`,
          10_000,
        );
        // P5-f (7.1): a plain (unlit) edge paints DESIGN.md `canvas-edge` on its visible path.
        await expectPainted(page, [['handleRequest', 'serviceA']], '--border-strong', '1.5px');
      },
    },
    {
      name: 'FIX-5: Back with the mouse at the start of history → Back disables, focus on handleRequest’s card',
      run: async ({ page }) => {
        const back = page.getByRole('toolbar', { name: 'Map traversal history' }).getByRole('button', { name: 'Back' });
        // Back over the expand, the neighbour trace's and the trace's Node steps, until it disables.
        for (let presses = 0; presses < 10 && (await back.isEnabled()); presses += 1) {
          await back.click();
          await realSleep(400);
        }
        await until(async () => !(await back.isEnabled()), 'Back never reached the start of history');
        await until(
          () => isFocused(card(page, 'handleRequest')),
          `focus is on ${await page.evaluate(() => {
            const active = document.activeElement;
            return active === null ? 'nothing' : `${active.tagName} ${active.getAttribute('aria-label') ?? ''}`;
          })}, not handleRequest’s card`,
          5_000,
        );
      },
    },
    {
      name: `P3-11: PR Review against ${SCRATCH_BASE_REF} → the edges leaving the changed handleRequest paint --accent at 2px`,
      run: async ({ page }) => {
        await switchMode(page, 'PR Review');
        await computeDiffScope(page, SCRATCH_BASE_REF);
        await page.getByRole('status').filter({ hasText: /— 1 changed Node\.$/ }).waitFor({ state: 'visible' });
        const leaving = await canvas(page).getByRole('group', { name: /^Edge from \S*\bhandleRequest to / }).all();
        if (leaving.length === 0) throw new Error('no edge leaving handleRequest is drawn');
        const targets = await Promise.all(
          leaving.map(async (e) => /\b(\w+)$/.exec((await e.getAttribute('aria-label')) ?? '')?.[1] ?? '?'),
        );
        await expectPainted(page, targets.map((to) => ['handleRequest', to] as const), '--accent');
      },
    },
  ],
};
