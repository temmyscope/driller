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

import { readFile } from 'node:fs/promises';
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
 * Reads and hand-parses `path.join(projectRoot, 'coverage', 'lcov.info')`.
 * Resolves `undefined` — never throws, never rejects — both when the file
 * is missing (e.g. `ENOENT`, the common case: most projects don't run
 * coverage before every Code Map fetch) and when its content doesn't parse
 * as LCOV. Callers never need to distinguish "missing" from "malformed":
 * both mean "no `'test-coverage-gap'` signal for any Node this fetch" (I/O
 * & Edge-Case Matrix) and must never fail the whole `getCodeMap` fetch.
 */
export async function loadLcovCoverage(projectRoot: string): Promise<LcovCoverage | undefined> {
  const lcovPath = path.join(projectRoot, 'coverage', 'lcov.info');
  let raw: string;
  try {
    raw = await readFile(lcovPath, 'utf8');
  } catch {
    return undefined;
  }

  try {
    return parseLcov(raw, projectRoot);
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
function parseLcov(raw: string, projectRoot: string): LcovCoverage {
  const coverage: LcovCoverage = new Map();
  let currentLines: Set<number> | undefined;

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
    }
  }

  return coverage;
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
