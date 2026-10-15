/**
 * P4-8i: what a journey is, and the pure parts of running several.
 *
 * A journey is one tracker row group (`live-ui-test-tracker.md`'s item id,
 * e.g. `P0-5`) checked end to end against the real dev app. Each journey
 * gets its own app on a fresh temp userData and its own fixture copy, so
 * journeys never depend on each other; `run.ts` starts, drives and tears
 * down one at a time. The harness never writes the tracker: `--report`
 * prints one line per row for a human to copy.
 */
import type { Page } from 'playwright-core';

import type { Step, StepResult } from './harness';
import type { IpcCounter } from './ipcCounter';

/** The whole `npm run e2e` run: every journey together (P4-8i: 15 minutes). */
export const E2E_RUN_LIMIT_MS = 15 * 60_000;

/** What a journey's `prepare` may seed into its fresh userData before the app starts. */
export interface UserDataSeed {
  /** `driller-project-scope-settings.json`: the project's indexing-scope allowlist. */
  includedPaths?: readonly string[];
  /** Extra keys merged into `driller-ui-settings.json`. */
  uiSettings?: Record<string, unknown>;
  /** More Recent Projects entries after the journey's project (each a temp dir the journey made). */
  extraRecentProjects?: readonly string[];
}

/** The project a journey opens (from the seeded Recent Projects list). */
export interface PreparedProject {
  /** Absolute path; a temp dir the runner removes in teardown. */
  projectPath: string;
  seed?: UserDataSeed;
}

/** Temp-dir and fixture helpers `prepare` builds its project with. Every dir it makes is torn down. */
export interface PrepareEnv {
  /** `fixtures/path-trace-basic` in this checkout (never modified). */
  fixtureSource: string;
  /** A fresh `driller-e2e-fixture-*` dir, tracked for teardown. */
  makeFixtureDir: () => string;
  /** Registers a dir `prepare` made itself, so teardown removes it. */
  track: (dir: string) => string;
}

export interface JourneyContext {
  page: Page;
  projectPath: string;
  /** The Recent Projects entry's name (the folder's basename). */
  projectName: string;
  userDataDir: string;
  /** Counts `window.driller` calls from the page side (CDP binding); reset on relaunch. */
  ipc: IpcCounter;
  /** Quits the app (process group, own CBM) and starts it again on the same userData and project. */
  relaunch: () => Promise<void>;
  /** SIGKILLs the app's Graph Service utility process (and only it), as P0-3's live check did. */
  killGraphService: () => Promise<void>;
  /** P5-a review round 1: fires main's real `browser-window-focus` path (SIGUSR2 to Electron main, the dev-only e2e hook). */
  emitWindowFocus: () => Promise<void>;
}

export interface Journey {
  /** A short id for `--only` and the artifacts dir, e.g. `p0-5`. */
  id: string;
  /** The tracker item ids this journey checks, e.g. `['P0-5']`. */
  rows: readonly string[];
  /** One line: what the journey proves. */
  title: string;
  prepare: (env: PrepareEnv) => PreparedProject;
  /** The first step is the landing; it shares the app start's 90 s budget. */
  steps: readonly Step<JourneyContext>[];
}

export interface JourneyOutcome {
  journey: Pick<Journey, 'id' | 'rows' | 'title'>;
  ok: boolean;
  ms: number;
  steps: StepResult[];
  /** Teardown and real-userData checks that failed (empty when clean). */
  checkFailures: string[];
  artifacts?: string;
}

export interface CliOptions {
  report: boolean;
  /** Lower-cased journey ids or row ids; empty = every journey. */
  only: string[];
}

/** Parses `npm run e2e -- [--report] [--only <row>[,<row>…]]…`. Throws on anything else. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { report: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--report') {
      options.report = true;
    } else if (arg === '--only' || arg.startsWith('--only=')) {
      const value = arg === '--only' ? argv[(i += 1)] : arg.slice('--only='.length);
      if (value === undefined || value.trim() === '') throw new Error('--only needs a row id, e.g. --only P0-5');
      options.only.push(...value.split(',').map((v) => v.trim().toLowerCase()).filter((v) => v !== ''));
    } else {
      throw new Error(`unknown option ${arg} (expected --report or --only <row>)`);
    }
  }
  return options;
}

/**
 * The journeys `--only` picks: a journey matches by its id or any of its
 * row ids, case-insensitively. An unmatched filter value throws (a typo
 * must not pass as "nothing to run").
 */
export function selectJourneys<J extends Pick<Journey, 'id' | 'rows'>>(journeys: readonly J[], only: readonly string[]): J[] {
  if (only.length === 0) return [...journeys];
  const keys = (j: J) => [j.id, ...j.rows].map((k) => k.toLowerCase());
  const unknown = only.filter((value) => !journeys.some((j) => keys(j).includes(value)));
  if (unknown.length > 0) {
    const known = journeys.flatMap((j) => j.rows).join(', ');
    throw new Error(`--only ${unknown.join(', ')}: no such row (known: ${known})`);
  }
  return journeys.filter((j) => keys(j).some((k) => only.includes(k)));
}

/** The first failing step's name (or the failed check), for a ❌ line. */
export function firstFailure(outcome: JourneyOutcome): string {
  const failed = outcome.steps.find((s) => !s.ok && !s.skipped);
  if (failed !== undefined) return failed.error === undefined ? failed.name : `${failed.name}: ${failed.error}`;
  const skipped = outcome.steps.find((s) => !s.ok);
  if (skipped !== undefined) return `${skipped.name}: ${skipped.error ?? 'not run'}`;
  return outcome.checkFailures[0] ?? 'failed';
}

/**
 * `--report`: one line per tracker row, `✅ <date> (e2e)` or `❌ <step>`.
 * A human copies these into `live-ui-test-tracker.md`; nothing here writes it.
 */
export function formatReport(outcomes: readonly JourneyOutcome[], date: string): string {
  const rows = outcomes.flatMap((o) => o.journey.rows.map((row) => ({ row, outcome: o })));
  const width = Math.max(3, ...rows.map((r) => r.row.length));
  return rows
    .map(({ row, outcome }) => {
      const verdict = outcome.ok ? `✅ ${date} (e2e)` : `❌ ${firstFailure(outcome)}`;
      return `${row.padEnd(width)}  ${verdict}  [${outcome.journey.id}, ${(outcome.ms / 1000).toFixed(1)} s]`;
    })
    .join('\n');
}

/** A local `YYYY-MM-DD` for the report. */
export function reportDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
