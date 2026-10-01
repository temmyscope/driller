/**
 * Story 2.1 (Phase 2): hand-parsed LCOV reader backing the deterministic
 * `'test-coverage-gap'` `RiskSignal` (FR7, AD-9). This is distinct from
 * `SummaryStatus`'s unrelated `'coverage-gap'` member (indexing/parse
 * coverage, FR-2/FR-5) — the two are unrelated concepts that happen to
 * share the word "coverage"; this module has nothing to do with that one.
 *
 * A wholly self-contained subsystem, independent of Phase 1's
 * backend-query changes: this phase's only data source is the LCOV file
 * itself, at the one fixed, auto-discovered location
 * `path.join(projectRoot, 'coverage', 'lcov.info')` — no Settings field for
 * a custom path (this phase's scoping decision, deferred). Hand-parses the
 * LCOV `SF:`/`DA:<line>,<hits>`/`end_of_record` format directly (no new npm
 * dependency, matching AD-9's minimal-dependency stance — the same call
 * Phase 1 made for complexity/hotspot).
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * POSIX-relative file path (matching `CodeMapNode.file`'s own convention,
 * AD-19) -> the set of line numbers reported with `hits > 0` anywhere in
 * that file's `SF:...end_of_record` section.
 *
 * A file present as a key here (even with an empty `Set`, i.e. an `SF:`
 * section with no covered `DA:` lines at all) is a file the LCOV report
 * covers. A file with no key at all is a file the report is silent about —
 * that silence is never evidence the file lacks coverage, just that this
 * report doesn't speak to it (e.g. a non-instrumented file type); see
 * `hasCoverageGap`.
 */
export type LcovCoverage = Map<string, Set<number>>;

/**
 * P4-3f review round 1: one file's LCOV function records, by function name.
 * `lines` holds every `FN:` start line seen for the name (a repeated `SF:`
 * block repeats the same line); `hits` sums every `FNDA:` count for it.
 */
export type LcovFunctions = Map<string, { lines: Set<number>; hits: number }>;

/**
 * P4-3f review round 1: everything one `coverage/lcov.info` read yields.
 * - `lines`: the `DA:` data, which alone decides `test-coverage-gap` and
 *   `testCoverageAvailable` (unchanged from Story 2.1 / P4-3f).
 * - `functions`: the `FN:`/`FNDA:` data per file, the only proof a Node is
 *   `testCoverageHit` — `DA:` hits alone are not, since a module load hits a
 *   declaration's own line (and an arrow's closing `};`) even when no test
 *   ever calls it.
 * - `staleFiles`: listed files whose source is newer than the report (or
 *   can't be stat'd); the report says nothing trustworthy about a Node in
 *   them being hit, so they never get `testCoverageHit`.
 */
export interface LcovReport {
  lines: LcovCoverage;
  functions: Map<string, LcovFunctions>;
  staleFiles: ReadonlySet<string>;
}

/**
 * Reads and hand-parses `path.join(projectRoot, 'coverage', 'lcov.info')`.
 * Resolves `undefined` — never throws, never rejects — both when the file
 * is missing (e.g. `ENOENT`, the common case: most projects don't run
 * coverage before every Code Map fetch) and when its content doesn't parse
 * as LCOV. Callers never need to distinguish "missing" from "malformed":
 * both mean "no `'test-coverage-gap'` signal for any Node this fetch" (I/O
 * & Edge-Case Matrix) and must never fail the whole `getCodeMap` fetch.
 */
export async function loadLcovCoverage(projectRoot: string): Promise<LcovReport | undefined> {
  const lcovPath = path.join(projectRoot, 'coverage', 'lcov.info');
  let raw: string;
  let reportMtimeMs: number;
  try {
    // P4-3f review round 1: the report's mtime is read before its content,
    // so a report rewritten between the two reads looks older, never newer —
    // the staleness check below can only err towards "stale" (no claim).
    reportMtimeMs = (await stat(lcovPath)).mtimeMs;
    raw = await readFile(lcovPath, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed = parseLcov(raw, projectRoot);
    return { ...parsed, staleFiles: await findStaleFiles(projectRoot, parsed.lines.keys(), reportMtimeMs) };
  } catch {
    // Defensive: keeps a genuinely corrupt/unexpected input from ever
    // propagating out of this module as a partial parse or a crash
    // (Boundaries & Constraints) — the line-based parser below is already
    // lenient about unrecognized content (see its own doc comment), so this
    // is a last-resort backstop rather than the primary defense.
    return undefined;
  }
}

/**
 * Line-based LCOV parser. Only `SF:`, `DA:`, and `end_of_record` are
 * meaningful here; every other LCOV directive (`TN:`, `FN:`, `FNDA:`,
 * `FNF:`, `FNH:`, `BRDA:`, `BRF:`, `BRH:`, `LH:`, `LF:`, blank lines, …) is
 * silently ignored rather than treated as an error — a real-world
 * `lcov.info` is full of them, and this phase only needs line-hit data. A
 * `DA:` line encountered before any `SF:` (or after `end_of_record`) is
 * likewise ignored rather than throwing, and a `DA:` line whose fields
 * don't parse as numbers is skipped — malformed content degrades to
 * "fewer covered lines recorded", never a thrown exception (the outer
 * `loadLcovCoverage` catch is a backstop, not the primary defense).
 */
function parseLcov(raw: string, projectRoot: string): Omit<LcovReport, 'staleFiles'> {
  const coverage: LcovCoverage = new Map();
  const functions = new Map<string, LcovFunctions>();
  let currentLines: Set<number> | undefined;
  let currentFunctions: LcovFunctions | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const file = normalizeLcovPath(line.slice('SF:'.length).trim(), projectRoot);
      // Review round (patch): reuse the Set already recorded for this file,
      // if any, rather than replacing it — a merged/aggregated lcov.info
      // (multiple test runs concatenated, e.g. by `genhtml`/nyc's own merge
      // step) commonly repeats an `SF:...end_of_record` block per file. An
      // unconditional `coverage.set(file, new Set())` here silently dropped
      // every earlier block's covered lines, producing a false
      // `test-coverage-gap` for lines actually covered elsewhere in the
      // report (Blind Hunter + Edge Case Hunter review, independently).
      currentLines = coverage.get(file) ?? new Set<number>();
      coverage.set(file, currentLines);
      // P4-3f review round 1: function records merge across repeated blocks
      // the same way.
      currentFunctions = functions.get(file) ?? new Map();
      functions.set(file, currentFunctions);
    } else if (line.startsWith('FN:') && currentFunctions !== undefined) {
      const fn = parseFnLine(line.slice('FN:'.length));
      if (fn !== undefined) {
        const entry = currentFunctions.get(fn.name) ?? { lines: new Set<number>(), hits: 0 };
        entry.lines.add(fn.line);
        currentFunctions.set(fn.name, entry);
      }
    } else if (line.startsWith('FNDA:') && currentFunctions !== undefined) {
      const body = line.slice('FNDA:'.length);
      const comma = body.indexOf(',');
      const hits = Number(body.slice(0, comma));
      const name = body.slice(comma + 1).trim();
      if (comma > 0 && name.length > 0 && Number.isFinite(hits) && hits >= 0) {
        const entry = currentFunctions.get(name) ?? { lines: new Set<number>(), hits: 0 };
        entry.hits += hits;
        currentFunctions.set(name, entry);
      }
    } else if (line.startsWith('DA:') && currentLines !== undefined) {
      const [lineNoRaw, hitsRaw] = line.slice('DA:'.length).split(',');
      const lineNo = Number(lineNoRaw);
      const hits = Number(hitsRaw);
      if (Number.isFinite(lineNo) && Number.isFinite(hits) && hits > 0) {
        currentLines.add(lineNo);
      }
    } else if (line.trim() === 'end_of_record') {
      // Review round (patch): trimmed, not a bare `===` — a stray trailing
      // space (some LCOV writers, or a manually-edited fixture) would
      // otherwise never clear `currentLines`, silently attributing the next
      // file's `DA:` lines to the previous file's coverage set (Edge Case
      // Hunter review).
      currentLines = undefined;
      currentFunctions = undefined;
    }
  }

  return { lines: coverage, functions };
}

/**
 * P4-3f review round 1: an `FN:` body — `<line>,<name>` (lcov 1.x, Node's
 * `--test-reporter=lcov`, Istanbul) or `<line>,<endLine>,<name>` (lcov 2.x).
 * `undefined` for anything else, so a malformed record proves nothing.
 */
function parseFnLine(body: string): { line: number; name: string } | undefined {
  const parts = body.split(',');
  const line = Number(parts[0]);
  if (!Number.isInteger(line) || line < 1 || parts.length < 2) {
    return undefined;
  }
  const hasEnd = parts.length >= 3 && /^\d+$/.test(parts[1]!.trim());
  const name = parts
    .slice(hasEnd ? 2 : 1)
    .join(',')
    .trim();
  return name.length > 0 ? { line, name } : undefined;
}

/**
 * P4-3f review round 1: the listed files whose source is newer than the
 * report, or that can't be stat'd (moved, deleted, outside the project).
 */
async function findStaleFiles(
  projectRoot: string,
  files: Iterable<string>,
  reportMtimeMs: number,
): Promise<Set<string>> {
  const stale = new Set<string>();
  await Promise.all(
    [...files].map(async (file) => {
      try {
        if ((await stat(path.resolve(projectRoot, file))).mtimeMs > reportMtimeMs) {
          stale.add(file);
        }
      } catch {
        stale.add(file);
      }
    }),
  );
  return stale;
}

/**
 * LCOV `SF:` paths are assumed POSIX-relative to the project root
 * (`CodeMapNode.file`'s own convention, AD-19) — the common case for JS/TS
 * coverage tooling. Review round (patch): also handles an absolute `SF:`
 * path (converted via `path.relative(projectRoot, ...)`) and backslash
 * separators (converted to `/`) — Istanbul/nyc, a very common JS/TS coverage
 * tool, frequently emits absolute paths by default, and a report generated
 * on Windows may use `\` (Blind Hunter review). A path that still doesn't
 * resolve to something inside `projectRoot` (`path.relative` starting with
 * `..` or itself absolute, e.g. a different drive on Windows) is returned
 * unchanged — it simply won't match any Node's `file`, degrading to "no
 * signal" for that file rather than a wrong one (Design Notes).
 */
function normalizeLcovPath(rawPath: string, projectRoot: string): string {
  const slashed = rawPath.replace(/\\/g, '/');
  if (path.isAbsolute(slashed)) {
    const relative = path.relative(projectRoot, slashed).split(path.sep).join('/');
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return relative;
    }
    return slashed;
  }
  return slashed.startsWith('./') ? slashed.slice(2) : slashed;
}

/**
 * True when `file`'s `[startLine, endLine]` range has zero covered lines
 * per `coverage` — both "some `DA:` lines present in range but all
 * `hits === 0`" and "no `DA:` lines in range at all" collapse to the same
 * binary gap/no-gap result (Design Notes: no partial-coverage threshold,
 * this phase is binary per AD-9/epics.md's "flag" framing).
 *
 * A `file` entirely absent from `coverage` (no `SF:` section for it in the
 * report) is never a gap — LCOV's own silence about a file isn't evidence
 * that file lacks coverage, just that this report doesn't cover it (e.g. a
 * non-instrumented file type).
 *
 * Review round (patch): an inverted range (`startLine > endLine`) returns
 * `false` (no gap) rather than falling through to the scan below, where it
 * would never match any line and silently report a false gap — every
 * legitimate `CodeMapNode` has `startLine <= endLine` by construction, but a
 * silently wrong signal is worse than a defensive no-op here (Edge Case
 * Hunter review). Also review round: scans `[startLine, endLine]` (bounded
 * by the Node's own size, typically small) rather than `coveredLines` (bounded
 * by the whole file's covered-line count, which can be large) — the same
 * "don't rebuild/rescan the larger structure per Node" fix Phase 1 already
 * applied to blast radius (Blind Hunter + Verification Gap review,
 * independently).
 */
export function hasCoverageGap(coverage: LcovCoverage, file: string, startLine: number, endLine: number): boolean {
  if (startLine > endLine) {
    return false;
  }
  // P4-3 phase 5: the same "does the report list this file?" test that
  // `hasCoverageData` answers, so a Node never has a gap without the flag.
  const coveredLines = coverage.get(file);
  if (coveredLines === undefined) {
    return false;
  }
  for (let line = startLine; line <= endLine; line++) {
    if (coveredLines.has(line)) {
      return false;
    }
  }
  return true;
}

/**
 * P4-3 phase 5: true when `coverage` has an `SF:` section for `file` — the
 * report instruments this file, so "no `test-coverage-gap`" for a Node in it
 * is a real "at least one line in range was hit", not LCOV's silence. Backs
 * `CodeMapNode.testCoverageAvailable`. Keyed exactly as `hasCoverageGap`
 * reads it: `file` is the Node's POSIX-relative path, matched against the
 * keys `normalizeLcovPath` wrote. An empty `Set` (an `SF:` section with no
 * hit lines) still counts: the file is listed, and every Node in it gets a
 * gap. Says nothing about a percentage.
 */
export function hasCoverageData(coverage: LcovCoverage, file: string): boolean {
  return coverage.has(file);
}

/**
 * P4-3f review round 1: true only when the report PROVES a test entered this
 * Node — backs `CodeMapNode.testCoverageHit` and the table's `covered`.
 * - Never for an inverted or non-integer range, a file the report omits, or
 *   a file newer than the report (`staleFiles`).
 * - A function record starting exactly at `startLine` decides alone: hit
 *   when its `FNDA:` count is above 0.
 * - Otherwise any record starting inside `[startLine, endLine]` with a count
 *   above 0 proves it: a nested function only runs once its enclosing one
 *   has (and a Node's range may start on a decorator or comment line above
 *   the function's own `FN:` line).
 * - A name with more than one `FN:` start line in the file is ambiguous
 *   (its `FNDA:` can't be attributed) and proves nothing.
 * - No function record in range → no proof. `DA:` hits never count here.
 */
export function hasFunctionHit(report: LcovReport, file: string, startLine: number, endLine: number): boolean {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || startLine > endLine) {
    return false;
  }
  if (report.staleFiles.has(file)) {
    return false;
  }
  const functions = report.functions.get(file);
  if (functions === undefined) {
    return false;
  }
  let exact: boolean | undefined;
  let inRangeHit = false;
  for (const { lines, hits } of functions.values()) {
    if (lines.size !== 1) {
      continue;
    }
    const [line] = lines;
    if (line === startLine) {
      exact = (exact ?? false) || hits > 0;
    } else if (line! > startLine && line! <= endLine && hits > 0) {
      inRangeHit = true;
    }
  }
  return exact ?? inRangeHit;
}
