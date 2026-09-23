/**
 * Qodo Merge / PR-Agent CLI adapter (Story 2.3, Phase 3).
 *
 * driller's second PR-bot ingestion adapter — reuses Phase 2's
 * `resolveDefaultBranch` (`git-base-ref.ts`) and `runSafeSubprocess`
 * (`subprocess-runner.ts`, widened this phase with an optional `env` option)
 * unchanged, plus `@driller/graph-contracts`'s `findEnclosingNode`, exactly
 * the same grouping step Phase 2's CodeRabbit adapter uses.
 *
 * PR-Agent's CLI shape differs meaningfully from CodeRabbit's `cr`:
 *  - It's configured via an env var (`CONFIG__GIT_PROVIDER=local`), never a
 *    CLI flag, passed through `execFile`'s own `env` option (never
 *    string-interpolated into the command — Always).
 *  - It's invoked as a Python module (`python3 -m pr_agent.cli`), so this
 *    adapter tries `python3` first and falls back to `python` on `ENOENT`,
 *    mirroring `git-base-ref.ts`'s own two-candidate fallback pattern
 *    (though that module falls back between two `git` invocations, not two
 *    interpreter names).
 *  - Its `review` command does not print structured output to stdout at
 *    all — it writes a markdown file, `review.md`, into the project root
 *    (`LocalGitProvider`'s own behavior, confirmed via the Design Notes'
 *    independent research this phase). This adapter reads that file once,
 *    parses it, and deletes it — AD-17's "repo stays as the user left it"
 *    guarantee, applied to a third-party tool's own filesystem side effect
 *    rather than driller's (see `runQodoIngestion`'s own doc comment).
 *
 * P0-6 (2026-09-24): that same AD-17 guarantee cuts the other way too.
 * This adapter used to DELETE any pre-existing `review.md` at the repo root
 * before invoking PR-Agent, on the reasoning that a stale leftover must
 * never be misread as this pass's output. But driller cannot tell a stale
 * leftover from a file the user wrote themselves, and it destroyed both.
 * The pass now refuses instead: a `review.md` present before invocation
 * returns `'review-md-present'` having invoked nothing and deleted nothing.
 * Every post-invocation delete stays exactly as it was.
 *
 * Known residual window (deferred as its own item, not fixed here): the
 * pre-flight check establishes that the path was empty AT THE MOMENT OF THE
 * `lstat`, and nothing more. A PR-Agent run is not fast, and a file written
 * to that path by the user or another tool DURING the run is still unlinked
 * by the post-invocation cleanup below. That is a much narrower window than
 * the unconditional pre-invocation delete this replaced — it no longer
 * destroys a file that was simply sitting there beforehand — but it is the
 * same failure mode, and no comment in this file should be read as claiming
 * otherwise.
 *
 * PR-Agent's exact `review.md` markdown structure is unconfirmed against
 * real output (Design Notes: WebFetch against `docs.pr-agent.ai` and the
 * `LocalGitProvider` source confirmed the env-var convention, the
 * branch-not-PR-URL argument, and the file-based output, but NOT the exact
 * per-item formatting or whether individual issues carry their own
 * severity). Every part of this file that depends on that unconfirmed shape
 * is isolated inside `parseQodoReviewMarkdown` and `mapQodoSeverity` — same
 * treatment, same reasoning, as `coderabbit-adapter.ts`'s own
 * `parseCodeRabbitOutput`/`mapCodeRabbitSeverity` — so a human can correct
 * just those two functions once real `pr_agent` output is observed, without
 * touching the subprocess invocation, branch resolution, file
 * read/delete lifecycle, or Node-lookup/grouping logic around them.
 */

import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { findEnclosingNode } from '@driller/graph-contracts';
import type { CodeMapNode, IngestedRiskSignal } from '@driller/ipc-contracts';
import { resolveDefaultBranch } from './git-base-ref';
import { runSafeSubprocess, type SubprocessResult } from './subprocess-runner';

/** The `sourceTool` value every finding this adapter produces carries — exported so `index.ts` can filter by it during the clear-prior-findings step, same role `CODERABBIT_SOURCE_TOOL` plays for Phase 2. */
export const QODO_SOURCE_TOOL = 'Qodo';

/**
 * Result of a full Qodo/PR-Agent ingestion pass — structurally identical to
 * (and consumed the same way as) Phase 2's `CodeRabbitIngestionResult`,
 * mirroring `PrBotIngestionResult`'s own explicit-result-state shape
 * (AD-13's broader pattern).
 */
export type QodoIngestionResult =
  | { status: 'ok'; findingsByNodeId: Record<string, IngestedRiskSignal[]> }
  | { status: 'tool-not-found' }
  | { status: 'no-base-ref-resolvable' }
  // P0-6 (2026-09-24): a `review.md` driller did not create was already at
  // the repo root, so the pass refused — nothing invoked, nothing deleted.
  // `reviewMdPath` is the absolute path, so the surface that reports this
  // can name the exact file rather than leaving the user hunting for it.
  | { status: 'review-md-present'; reviewMdPath: string }
  | { status: 'error'; message: string };

/**
 * Runs one Qodo/PR-Agent ingestion pass for `projectRoot` against the
 * already-fetched Code Map `nodes` (mirrors `runCodeRabbitIngestion`'s own
 * signature and caller contract exactly — `index.ts`'s ingestion handler
 * passes the same `activeCodeMapNodes`, never a fresh fetch). Never throws —
 * every failure path resolves to an explicit result state.
 *
 * Sequence (Always/I-O matrix):
 *  1. Resolve the base branch (`resolveDefaultBranch`) — `python` is never
 *     invoked when this fails (`'no-base-ref-resolvable'`).
 *  2. Refuse outright if a `review.md` already exists at the expected path
 *     (`'review-md-present'`) — nothing is invoked and nothing is deleted.
 *     driller cannot distinguish a stale leftover from the user's own file,
 *     so it destroys neither (P0-6; AD-17 cuts both ways). This also means
 *     a stale leftover can still never be misread as this pass's output,
 *     which is what the old pre-invocation delete was there for.
 *  3. Invoke `python3 -m pr_agent.cli --pr_url <branch> review` with
 *     `CONFIG__GIT_PROVIDER=local` in `env` (falling back to `python` on
 *     `ENOENT`; `ENOENT` on both, or a non-`ENOENT` failure whose message
 *     contains `"no module named"`, both resolve to `'tool-not-found'`).
 *  4. On a successful run, read `review.md` once, parse it, then delete it
 *     regardless of parse outcome (best-effort — a deletion failure is
 *     logged, never fails the result) — restores the repo to its
 *     pre-ingestion state per AD-17.
 */
export async function runQodoIngestion(
  projectRoot: string,
  nodes: CodeMapNode[],
): Promise<QodoIngestionResult> {
  const branchResult = await resolveDefaultBranch(projectRoot);
  if ('resolvable' in branchResult) {
    return { status: 'no-base-ref-resolvable' };
  }

  const reviewMdPath = resolveReviewMdPath(projectRoot);

  // P0-6 (2026-09-24): the pre-flight check that replaced an unconditional
  // delete. This used to be `deleteReviewMdBestEffort(reviewMdPath, 'stale
  // pre-existing')` — silently destroying a file at the user's own repo
  // root that driller never created, on the theory that it could only be a
  // leftover from a crashed pass. Nothing about a file on disk tells driller
  // which it is, so the pass refuses instead; the refusal is an explicit
  // result state the user sees, naming the file, not a silent skip.
  //
  // Refusing is also strictly stronger than deleting for the thing the old
  // step actually guaranteed: a stale `review.md` can't be misread as this
  // pass's output if PR-Agent is never invoked at all.
  //
  // What this check does and does not establish: it proves the path held no
  // entry at the instant of the `lstat`. It says nothing about the path for
  // the duration of the PR-Agent run that follows — see the module header's
  // "Known residual window".
  const presence = await reviewMdPresence(reviewMdPath);
  if (presence.status === 'present') {
    return { status: 'review-md-present', reviewMdPath };
  }
  if (presence.status === 'undetermined') {
    // Can't prove absence (a permissions quirk, an EISDIR, a transient
    // failure). Reporting it honestly is the only safe option: claiming
    // `'review-md-present'` would name a file that may not exist, and
    // proceeding would put us right back to deleting something unknown.
    return {
      status: 'error',
      message: `Couldn't check whether ${reviewMdPath} already exists: ${presence.message}`,
    };
  }

  const invokeResult = await invokePrAgent(projectRoot, branchResult.branch);
  if ('notFound' in invokeResult) {
    return { status: 'tool-not-found' };
  }
  if ('error' in invokeResult) {
    if (isMissingModuleError(invokeResult.error)) {
      // Always: "A non-ENOENT failure whose stderr contains 'No module
      // named' (case-insensitive) is ALSO reported as 'tool-not-found'" —
      // `runSafeSubprocess`'s `{error}` state carries Node's own
      // `error.message`, which live-verified (this environment: python3
      // present, `pr_agent` uninstalled) concatenates the failing command's
      // stderr onto that message rather than exposing it as a separate
      // field, so checking `invokeResult.error` here — not a nonexistent
      // separate `stderr` field — is what actually reaches the real text.
      //
      // Review finding (Verification Gap): a `ModuleNotFoundError` happens
      // at Python import time, before `LocalGitProvider` ever runs, so this
      // branch could only ever see a review.md written after invocation —
      // but that safety rested on an unstated assumption about PR-Agent's
      // import order, not something this branch enforced itself. Delete
      // unconditionally here too, same best-effort reasoning as the sibling
      // branch below, so this branch's own correctness doesn't depend on
      // that assumption staying true. P0-6 (2026-09-24): kept as an
      // unconditional delete. The pre-flight check above found the path
      // empty immediately before invocation, so in the ordinary case
      // anything here is this pass's own output — but that is a strong
      // likelihood, not a proof: a file written to the path during the run
      // would be unlinked here too (module header, "Known residual
      // window").
      await deleteReviewMdBestEffort(reviewMdPath, "a tool-not-found pass's own");
      return { status: 'tool-not-found' };
    }
    // Never: "Leaving review.md behind after a pass completes (success or
    // failure)." A genuine (non-missing-module) subprocess failure could
    // still have left a partial `review.md` behind depending on when/how
    // PR-Agent failed — best-effort cleanup here for the same reason the
    // pre-invocation delete is best-effort (a cleanup failure must never
    // mask/replace the real, more actionable subprocess error below).
    await deleteReviewMdBestEffort(reviewMdPath, "a failed pass's own");
    return { status: 'error', message: invokeResult.error };
  }

  // Success: "review.md is read once, parsed, then deleted regardless of
  // parse outcome" (Always) — read first, delete in `finally` so deletion
  // always happens after the read/parse attempt whether parsing succeeds or
  // degrades to an 'error' result.
  let raw: string;
  try {
    raw = await readFile(reviewMdPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // I/O matrix: "Subprocess exits 0 but review.md is absent -> 'error'
      // result with a message; nothing persisted" — assumed output-location
      // wrong, e.g. PR-Agent version/config writing somewhere else. Nothing
      // to delete: the file doesn't exist by construction of this branch.
      return {
        status: 'error',
        message: `PR-Agent's "review" command exited successfully, but ${reviewMdPath} was not found afterward.`,
      };
    }
    // Review finding (Blind Hunter, major; independently confirmed by
    // Verification Gap): this branch is reached only when `review.md`
    // genuinely exists (the subprocess exited 0) but some other failure
    // (permissions, a transient lock, EISDIR) prevented reading it — unlike
    // every other error branch in this function, this one returned without
    // ever attempting a delete, leaving a real file behind and violating
    // the unconditional Never constraint. Best-effort cleanup here too.
    await deleteReviewMdBestEffort(reviewMdPath, "an unreadable pass's own");
    return {
      status: 'error',
      message: `Failed to read ${reviewMdPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: ParseQodoReviewMarkdownResult;
  try {
    parsed = parseQodoReviewMarkdown(raw);
  } finally {
    await deleteReviewMdBestEffort(reviewMdPath, "this pass's own");
  }

  if (parsed.status === 'error') {
    return { status: 'error', message: parsed.message };
  }

  // Always: "each finding this pass produces is assigned that [PR-level]
  // severity uniformly" — computed once, applied to every finding below,
  // never a per-finding lookup (PR-Agent's `review` output isn't confirmed
  // to carry per-finding severity at all — Design Notes).
  const uniformSeverity = mapQodoSeverity(parsed.prLevelRiskNative);

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const findingsByNodeId: Record<string, IngestedRiskSignal[]> = {};

  for (const finding of parsed.findings) {
    // Same "dropped, never attached to a synthetic pseudo-Node" convention
    // as `runCodeRabbitIngestion` — a finding whose best-effort-extracted
    // file+line matches no known Node's range is silently excluded.
    const nodeId = findEnclosingNode(nodes, finding.file, finding.line);
    if (nodeId === undefined) {
      continue;
    }
    const node = nodesById.get(nodeId);
    if (!node) {
      // Unreachable in practice — same reasoning as
      // `runCodeRabbitIngestion`'s identical defensive skip.
      continue;
    }

    const signal: IngestedRiskSignal = {
      family: 'ingested',
      severity: uniformSeverity,
      sourceTool: QODO_SOURCE_TOOL,
      finding: finding.message,
      // Mirrors `runCodeRabbitIngestion`'s own convention: the owning
      // Node's own {file, startLine, endLine} range, not the finding's raw
      // (best-effort-parsed, unconfirmed-format) coordinates.
      location: { file: node.file, startLine: node.startLine, endLine: node.endLine },
    };

    const existing = findingsByNodeId[nodeId];
    if (existing) {
      existing.push(signal);
    } else {
      findingsByNodeId[nodeId] = [signal];
    }
  }

  return { status: 'ok', findingsByNodeId };
}

/** The expected on-disk location of PR-Agent's `review` output — `LocalGitProvider` writes `review.md` directly into the repo root (Design Notes, confirmed via the `LocalGitProvider` source). */
export function resolveReviewMdPath(projectRoot: string): string {
  return path.join(projectRoot, 'review.md');
}

/**
 * P0-6 (2026-09-24): three-valued on purpose. `'absent'` (an `ENOENT`
 * `lstat`) is the only state that lets the pass proceed; `'present'`
 * refuses; and anything else is `'undetermined'` rather than being
 * collapsed into either — driller must not act on a guess about a file it
 * did not create. Never throws.
 *
 * `lstat`, not `stat`: a dangling symlink at `review.md` reads as `ENOENT`
 * to `stat`, which would let the pass proceed, let PR-Agent write straight
 * through the link into whatever it points at, and then "clean up" by
 * unlinking only the link — leaving a file behind somewhere the user never
 * asked for one. `lstat` sees the link itself, so any entry at that path at
 * all, of any kind, refuses.
 */
async function reviewMdPresence(
  reviewMdPath: string,
): Promise<{ status: 'present' } | { status: 'absent' } | { status: 'undetermined'; message: string }> {
  try {
    await lstat(reviewMdPath);
    return { status: 'present' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent' };
    }
    return {
      status: 'undetermined',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Deletes `reviewMdPath` if present. `label` only affects the log message on
 * an unexpected (non-`ENOENT`) failure. Never throws: a missing file is
 * silently fine, and any other failure is logged, never propagated —
 * Always: "a deletion failure is logged, never fails the ingestion result."
 *
 * P0-6 (2026-09-24): every remaining caller is POST-invocation. The
 * pre-flight check in `runQodoIngestion` found the path empty immediately
 * before invocation, so in the ordinary case what this deletes is what
 * PR-Agent wrote during this pass — which is what the removed
 * pre-invocation call site could never say, since it ran against whatever
 * was already sitting there. It is NOT a guarantee: a file written to the
 * path by anything else during the run is still deleted here (see
 * `runQodoIngestion`'s module header, "Known residual window").
 */
async function deleteReviewMdBestEffort(reviewMdPath: string, label: string): Promise<void> {
  try {
    await unlink(reviewMdPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    console.error(
      `[graph-service] failed to delete ${label} ${reviewMdPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Invokes PR-Agent's `review` tool against `branch` in `projectRoot`'s
 * `local` git-provider mode (Always: `execFile('python3'|'python', ['-m',
 * 'pr_agent.cli', '--pr_url', branch, 'review'], {cwd, env: {...process.env,
 * CONFIG__GIT_PROVIDER: 'local'}})` — array args, the env var passed via
 * `execFile`'s own `env` option, never string-interpolated). Tries `python3`
 * first; falls back to `python` only on that first call's own `ENOENT`
 * (mirrors `git-base-ref.ts`'s two-candidate fallback shape). No other
 * PR-Agent flags/tools are ever invoked (Always/Never: "`review` only").
 */
async function invokePrAgent(projectRoot: string, branch: string): Promise<SubprocessResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, CONFIG__GIT_PROVIDER: 'local' };
  const args = ['-m', 'pr_agent.cli', '--pr_url', branch, 'review'];

  const primaryResult = await runSafeSubprocess('python3', args, { cwd: projectRoot, env });
  if (!('notFound' in primaryResult)) {
    return primaryResult;
  }
  return runSafeSubprocess('python', args, { cwd: projectRoot, env });
}

/**
 * The documented heuristic (Always) for distinguishing "no `pr_agent` pip
 * package installed" from any other subprocess failure: `message` contains
 * `"no module named"`, case-insensitive. Not a schema-confirmed contract —
 * Python's own `ModuleNotFoundError`/`ImportError` text ("No module named
 * 'pr_agent'") is stable across CPython versions in practice (live-verified
 * this environment, Python 3.9.6: `python3 -m pr_agent.cli ...` with
 * `pr_agent` uninstalled fails with exactly this text), but this is CPython's
 * own error-message convention, not something PR-Agent itself documents or
 * guarantees.
 */
function isMissingModuleError(message: string): boolean {
  return message.toLowerCase().includes('no module named');
}

// ---------------------------------------------------------------------------
// Schema-uncertain boundary (Design Notes) — everything below this point
// depends on PR-Agent's unconfirmed `review.md` markdown structure. Isolated
// in these two functions (both exported for direct hand-testing — see this
// story's Verification section) so a human can correct just this section
// once real `review.md` output is observed, without touching anything above
// it.
//
// Confirmed via this phase's own research (WebFetch against
// docs.pr-agent.ai and the LocalGitProvider source): the `review` tool's
// documented output includes a "key issues to review" list, a security-
// concerns note, a risk-assessment level (low/medium/high), and an effort
// estimate (1-5). NOT confirmed: the exact per-item markdown formatting
// (heading text/level, bullet vs. numbered list, whether an issue's
// file/line appears as a backtick-quoted path, an inline `file:line`, a
// separate "Line: N" phrase, or something else entirely), and NOT confirmed
// whether individual issues carry their own severity at all (Always assumes
// they don't, applying the PR-level risk uniformly).
// ---------------------------------------------------------------------------

/** One finding as `parseQodoReviewMarkdown`'s best-effort assumed shape produces it. */
export interface RawQodoFinding {
  file: string;
  line: number;
  message: string;
}

/** Result of `parseQodoReviewMarkdown` — an explicit result state, never a thrown exception or a silently-empty array standing in for "didn't parse." */
export type ParseQodoReviewMarkdownResult =
  | { status: 'ok'; findings: RawQodoFinding[]; prLevelRiskNative: string | undefined }
  | { status: 'error'; message: string };

/**
 * Parses PR-Agent's raw `review.md` markdown into `{file, line, message}`
 * findings plus the PR-level risk-assessment word (`low`/`medium`/`high`,
 * best-effort-extracted; `undefined` when no recognizable risk phrase is
 * found, which `mapQodoSeverity` maps to `'info'` under its own
 * never-unmapped contract — never a thrown error just because the risk
 * assessment couldn't be located).
 *
 * Only truly degenerate input — empty or whitespace-only content — degrades
 * to `{status: 'error'}` (Always: "a shape mismatch... degrades to 'error',
 * never throws uncaught or silently drops findings"). Non-empty markdown
 * that simply has no "Key issues to review" section is treated as `'ok'`
 * with zero findings, not an error: unlike CodeRabbit's structured JSON
 * (where a shape that doesn't match at all signals a genuinely broken/
 * unparseable report), PR-Agent's own documented behavior is to omit a
 * findings section entirely on a review with nothing to flag — treating
 * that as an error would misreport a genuinely clean pass as a parse
 * failure, the exact confusion the CodeRabbit parser's own doc comment
 * warns against in the opposite direction.
 *
 * Best-effort file/line extraction (`extractFileLine`) tries, in order: a
 * backtick-quoted `` `path/to/file.ext:123` ``; a backtick-quoted
 * `` `path/to/file.ext` `` followed somewhere in the same bullet by a
 * `line 123`/`Line: 123` phrase; or a bare `path/to/file.ext:123` with no
 * backticks. A bullet matching none of these is dropped — same reasoning as
 * `coderabbit-adapter.ts`'s "one malformed entry among otherwise-valid ones
 * shouldn't discard every other genuine finding."
 */
export function parseQodoReviewMarkdown(raw: string): ParseQodoReviewMarkdownResult {
  if (raw.trim().length === 0) {
    return { status: 'error', message: 'review.md was empty.' };
  }

  const findings: RawQodoFinding[] = [];
  for (const bullet of extractKeyIssuesBullets(raw)) {
    const location = extractFileLine(bullet);
    if (!location) {
      continue;
    }
    findings.push({ file: location.file, line: location.line, message: bullet });
  }

  return { status: 'ok', findings, prLevelRiskNative: extractPrLevelRisk(raw) };
}

/**
 * Extracts the bullet/numbered-list items under a "key issues to review"
 * heading (case-insensitive substring match — PR-Agent's real heading level/
 * markup is unconfirmed, so this matches the phrase wherever it appears on
 * its own line rather than assuming a specific `#`/`**`/HTML wrapper).
 * Collection stops at the next markdown heading (`#`...) or an HTML
 * `</details>` closing tag, whichever comes first — both are plausible
 * section-boundary markers for PR-Agent's collapsible-section style output
 * (Design Notes references PR-Agent's documented use of `<details>` blocks),
 * without assuming either is definitely present.
 *
 * Review finding (Edge Case Hunter, minor): fenced code blocks (```...```)
 * are excluded from both the heading search and the bullet scan — PR-Agent's
 * own output can plausibly echo example/template markdown inside a fence,
 * and without this guard a heading phrase or list-shaped line inside one
 * would be misread as a real section/finding.
 *
 * Review finding (Edge Case Hunter, minor): only bullets indented 0-3 spaces
 * are collected (same "not indented enough to count as nested" threshold
 * this file's own heading regex already uses) — a deeper-indented sub-bullet
 * is a continuation/detail of its parent line, not an independent finding,
 * and was previously misread as one.
 */
function extractKeyIssuesBullets(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const insideFence = computeFenceMask(lines);

  const headingIndex = lines.findIndex((line, i) => !insideFence[i] && /key issues to review/i.test(line));
  if (headingIndex === -1) {
    return [];
  }

  const bullets: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (insideFence[i]) {
      continue;
    }
    if (/^\s{0,3}#{1,6}\s/.test(line) || /<\/details>/i.test(line)) {
      break;
    }
    const bulletMatch = line.match(/^\s{0,3}(?:[-*]|\d+\.)\s+(\S.*)$/);
    if (bulletMatch) {
      bullets.push(bulletMatch[1]!.trim());
    }
  }
  return bullets;
}

/**
 * Marks each line as inside (`true`) or outside (`false`) a fenced code
 * block (``` ... ```) — a line consisting of (optionally indented) triple
 * backticks toggles the fence state; the fence-marker line itself counts as
 * "inside" (excluded from heading/bullet matching either way).
 */
function computeFenceMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s{0,3}```/.test(line)) {
      inFence = !inFence;
      mask.push(true);
      continue;
    }
    mask.push(inFence);
  }
  return mask;
}

/**
 * Best-effort file+line extraction from one finding's raw bullet text — see
 * `parseQodoReviewMarkdown`'s doc comment for the three patterns tried, in
 * order. Returns `undefined` (finding dropped by the caller) when none
 * match.
 */
function extractFileLine(text: string): { file: string; line: number } | undefined {
  const backtickWithLine = text.match(/`([^`\s]+\.[A-Za-z0-9]+):(\d+)`/);
  if (backtickWithLine) {
    return { file: backtickWithLine[1]!, line: Number(backtickWithLine[2]) };
  }

  const backtickFile = text.match(/`([^`\s]+\.[A-Za-z0-9]+)`/);
  if (backtickFile) {
    const lineMatch = text.match(/\bline[s]?\s*[:#]?\s*(\d+)\b/i);
    if (lineMatch) {
      return { file: backtickFile[1]!, line: Number(lineMatch[1]) };
    }
  }

  // Review finding (Edge Case Hunter, minor): the file portion uses the same
  // `[^\s:]` (non-whitespace, non-colon) character class the two
  // backtick-quoted patterns above use via `[^`\s]+` — previously this used
  // `\w`, which (no Unicode flag) only matches ASCII and silently mis-parsed
  // or dropped a non-ASCII bare file path, unlike its backtick-quoted
  // siblings. Kept ASCII-only for the extension itself, since every
  // plausible source extension is ASCII.
  const bareFileLine = text.match(/\b([^\s:]+\.[A-Za-z0-9]+):(\d+)\b/);
  if (bareFileLine) {
    return { file: bareFileLine[1]!, line: Number(bareFileLine[2]) };
  }

  return undefined;
}

/**
 * Best-effort extraction of PR-Agent's PR-level risk-assessment word
 * (`low`/`medium`/`high` — the documented scale per Design Notes) from
 * anywhere in `raw`. Looks for the word "risk" followed, within the same
 * line, by one of the three known level words (allowing emoji/markup
 * between them, e.g. "🔴 High" or "**Risk level**: Medium"). Returns
 * `undefined` when no such phrase is found — `mapQodoSeverity(undefined)`
 * still resolves to `'info'` under its own never-unmapped contract, so this
 * is never a hard failure.
 */
function extractPrLevelRisk(raw: string): string | undefined {
  const match = raw.match(/risk[^\n]*?\b(low|medium|high)\b/i);
  return match?.[1]?.toLowerCase();
}

/**
 * Maps PR-Agent's native PR-level risk word onto the canonical
 * `'blocker'|'major'|'minor'|'info'` scale (Always: "mapped through the same
 * never-unmapped, default-to-'info' contract Phase 2 established").
 *
 * The table below is a best-effort guess (Design Notes: schema unconfirmed)
 * at how PR-Agent's documented low/medium/high risk scale should collapse
 * onto driller's four-level severity scale — `undefined` (no risk phrase
 * found) and any unrecognized word both fall through to `'info'`, never
 * throwing or leaving severity unmapped. Correct this table once real
 * `review.md` output is observed, same correction stance as
 * `mapCodeRabbitSeverity`'s own table.
 */
export function mapQodoSeverity(native: string | undefined): IngestedRiskSignal['severity'] {
  if (native === undefined) {
    return 'info';
  }
  const normalized = native.trim().toLowerCase();
  return RISK_SEVERITY_TABLE[normalized] ?? 'info';
}

const RISK_SEVERITY_TABLE: Record<string, IngestedRiskSignal['severity']> = {
  high: 'blocker',
  critical: 'blocker',
  medium: 'major',
  moderate: 'major',
  low: 'minor',
  minimal: 'info',
};
