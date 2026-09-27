/**
 * Diff-scoped changed-file computation from local git (Story 3.1, Phase 1,
 * FR11, AD-13).
 *
 * driller's first `git diff`/`git merge-base` subprocess computation —
 * reuses Story 2.3's safe subprocess runner (`subprocess-runner.ts`) and
 * branch-name resolver (`git-base-ref.ts`) unchanged; no second subprocess
 * mechanism (Never).
 *
 * Two-step, both steps going through `runSafeSubprocess`'s safe `execFile`
 * wrapper (never a shell string):
 *
 *  1. `git merge-base HEAD <ref>` — always run, whether `ref` was supplied
 *     by the caller or resolved via `resolveDefaultBranch` (Always). Its
 *     stdout (trimmed) is `resolvedBaseRef` — the merge-base COMMIT, never
 *     the branch/ref name standing in for it (Design Notes) — reported
 *     explicitly and used verbatim as the second step's own base, so what's
 *     reported and what's computed can never silently diverge.
 *  2. `git diff --name-only <mergeBaseCommit> HEAD` — committed state only
 *     (FR-11's "diff against a selected branch or commit"); uncommitted,
 *     staged, or unstaged changes are never part of this diff (Always/Never).
 *
 * `.git`'s absence at `projectRoot` is checked fresh at call time (not
 * cached from project-open) via a real `git rev-parse --is-inside-work-tree`
 * call — see this module's `isInsideGitWorkTree`'s own doc comment for why
 * this is a subprocess check, not a naive `fs.existsSync('.git')` test
 * (review finding, Blind Hunter: the original naive check was inconsistent
 * with `apps/desktop/main/git-detect.ts`'s own project-open-time detection,
 * which also treats a SUBDIRECTORY of a git repo as a valid project).
 *
 * Both git subprocess calls pass a short `timeoutMs` override to
 * `runSafeSubprocess` (review finding, Blind Hunter + Edge Case Hunter,
 * independently) — see `GIT_SUBPROCESS_TIMEOUT_MS`'s own doc comment.
 *
 * Returns `GitDiffScopeResult` — a local result-state type, structurally
 * identical to `@driller/ipc-contracts`'s `DiffScopeResult` for every state
 * except `'resolved'` (which carries this module's own `changedFiles: string[]`
 * rather than `DiffScopeResult`'s `nodeIds: string[]` — the Node-set match
 * itself needs `activeCodeMapNodes`, which this pure git-computation module
 * has no access to and no business holding; `services/graph-service/
 * index.ts`'s `computeDiffScopeResult` is what turns `changedFiles` into
 * `nodeIds` via `@driller/graph-contracts`'s `findChangedNodeIds`, then
 * passes every other state through unreshaped — the exact same
 * "locally-typed result, reshaped by index.ts's caller" precedent
 * `coderabbit-adapter.ts`'s own `CodeRabbitIngestionResult` already
 * establishes for `PrBotIngestionResult`).
 */

import type { ChangedLineRange, ChangedLinesByFile } from '@driller/graph-contracts';

import { resolveDefaultBranch } from './git-base-ref';
import { runSafeSubprocess, type SubprocessResult } from './subprocess-runner';

// Review finding (Blind Hunter + Edge Case Hunter, independently): local
// `git merge-base`/`git diff` calls are read-only, no-network operations
// that should complete in well under a second even on a large repo —
// `subprocess-runner.ts`'s shared 10-minute default (correctly sized for
// Phase 2/3's vendor-cloud CLI calls) left a hung local call blocking
// `activeDiffScopeComputationInFlight` for up to ~20 minutes. Generous past
// any plausible local git latency without inheriting that cloud-call sizing.
const GIT_SUBPROCESS_TIMEOUT_MS = 20 * 1000;

/**
 * Result of `computeDiffScope` — see this module's doc comment for why
 * `'resolved'` carries `changedFiles` rather than `nodeIds`; every other
 * state is structurally identical to `@driller/ipc-contracts`'s
 * `DiffScopeResult`.
 */
export type GitDiffScopeResult =
  | {
      status: 'resolved';
      resolvedBaseRef: string;
      changedFiles: string[];
      /**
       * P4-2 phase 3c: each changed file's changed line ranges in its HEAD
       * version (`parseChangedLines`), from the same merge-base..HEAD diff.
       * Absent when that listing failed (e.g. a diff too large to buffer):
       * the changed-file list above still stands.
       */
      changedLines?: ChangedLinesByFile;
    }
  | { status: 'no-changes' }
  | { status: 'not-a-git-repo' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'error'; message: string };

/**
 * Checks whether `projectRoot` is inside a git working tree, via `git
 * rev-parse --is-inside-work-tree` — not a naive `fs.existsSync('.git')`
 * test (review finding, Blind Hunter). A naive `.git`-at-`projectRoot` check
 * would wrongly report `'not-a-git-repo'` for a project opened as a
 * SUBDIRECTORY of a git repo — `apps/desktop/main/git-detect.ts`'s own
 * `detectGitRepo` already treats that as a valid project at open time (its
 * parent-search logic), so this check must agree with that at every later
 * call too. `git rev-parse` itself already walks up to find the repo root
 * the same way git's own CLI does for any command run from a subdirectory,
 * so this needs no directory-walking logic of its own — re-checked fresh on
 * every call (not cached from project-open), since `.git` could be removed
 * mid-session.
 */
async function isInsideGitWorkTree(projectRoot: string): Promise<boolean> {
  const result = await runSafeSubprocess('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: projectRoot,
    timeoutMs: GIT_SUBPROCESS_TIMEOUT_MS,
  });
  return 'stdout' in result && result.stdout.trim() === 'true';
}

/** Turns a non-`stdout` `SubprocessResult` into safe, user-facing error text. */
function describeSubprocessFailure(result: Exclude<SubprocessResult, { stdout: string; stderr: string }>): string {
  if ('notFound' in result) {
    // `git-base-ref.ts`'s own doc comment: git is assumed present, since
    // driller already depends on the project being a git repo for every
    // other feature — this is a defensive fallback message, not a modeled
    // result state of its own (no separate `'tool-not-found'` state exists
    // on `GitDiffScopeResult`/`DiffScopeResult`, unlike the PR-bot ingestion
    // contract's own `cr`-specific `'tool-not-found'`).
    return 'git is not installed or not on PATH.';
  }
  return result.error;
}

/**
 * Computes the diff-scoped changed-file list for `projectRoot` against
 * `baseRef` (a caller-supplied branch/commit name), or a resolved default
 * when `baseRef` is omitted. Never throws — every failure path resolves to
 * an explicit `GitDiffScopeResult` state.
 */
export async function computeDiffScope(
  projectRoot: string,
  baseRef: string | undefined,
): Promise<GitDiffScopeResult> {
  if (!(await isInsideGitWorkTree(projectRoot))) {
    // Checked before any other git subprocess call — defensive: normal
    // operation can't reach this from a non-git project (open-folder
    // already gates on it), but `.git` could be removed mid-session
    // (Always).
    return { status: 'not-a-git-repo' };
  }

  let ref: string;
  if (baseRef !== undefined) {
    ref = baseRef;
  } else {
    const resolution = await resolveDefaultBranch(projectRoot);
    if ('resolvable' in resolution) {
      // `{resolvable: false}` — never a silent hardcoded fallback (Always);
      // no git diff/merge-base call is made in this case.
      return { status: 'no-base-ref-resolvable' };
    }
    ref = resolution.branch;
  }

  // Always run, whether `ref` was supplied or resolved — its commit output
  // is `resolvedBaseRef`, reported explicitly, never the raw branch/ref name
  // standing in for it.
  const mergeBaseResult = await runSafeSubprocess('git', ['merge-base', 'HEAD', ref], {
    cwd: projectRoot,
    timeoutMs: GIT_SUBPROCESS_TIMEOUT_MS,
  });
  if (!('stdout' in mergeBaseResult)) {
    return { status: 'error', message: describeSubprocessFailure(mergeBaseResult) };
  }
  const resolvedBaseRef = mergeBaseResult.stdout.trim();
  if (resolvedBaseRef.length === 0) {
    return { status: 'error', message: '`git merge-base` produced no commit.' };
  }

  // Committed state only (FR-11's "diff against a selected branch or
  // commit") — uncommitted/staged/unstaged changes are never in scope
  // (Always/Never). `-c core.quotePath=false` (review finding, Edge Case
  // Hunter): git's default `core.quotePath=true` wraps and backslash-escapes
  // any path containing non-ASCII or other "unusual" characters in
  // `--name-only` output — without disabling it, such a path would never
  // exact-string-match `node.file` in `findChangedNodeIds`, silently
  // excluding that Node from the diff-scoped result.
  const diffResult = await runSafeSubprocess(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--name-only', resolvedBaseRef, 'HEAD'],
    { cwd: projectRoot, timeoutMs: GIT_SUBPROCESS_TIMEOUT_MS },
  );
  if (!('stdout' in diffResult)) {
    return { status: 'error', message: describeSubprocessFailure(diffResult) };
  }

  const changedFiles = diffResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (changedFiles.length === 0) {
    // Never an empty-but-unexplained Node set (Always).
    return { status: 'no-changes' };
  }

  // P4-2 phase 3c: the changed line ranges, for changed-contract detection.
  // The same basis as the changed-file list above: `resolvedBaseRef` is the
  // merge-base commit, so this is `merge-base..HEAD` (what `base...HEAD`
  // means) and commits the base branch gained after the fork never count.
  // `-U0` so each hunk header is exactly the changed lines. Explicit
  // prefixes and no external diff/color, so a user's `diff.noprefix`/
  // `diff.external`/`color.ui` config can't change the shape parsed.
  // Best-effort: a failure leaves `changedLines` out.
  const hunksResult = await runSafeSubprocess(
    'git',
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--unified=0',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      resolvedBaseRef,
      'HEAD',
    ],
    { cwd: projectRoot, timeoutMs: GIT_SUBPROCESS_TIMEOUT_MS },
  );
  if (!('stdout' in hunksResult)) {
    console.warn(
      `Could not read the diff's changed line ranges (${describeSubprocessFailure(hunksResult)}); ` +
        'every type in a changed file will count as changed (approximate).',
    );
    return { status: 'resolved', resolvedBaseRef, changedFiles };
  }

  return { status: 'resolved', resolvedBaseRef, changedFiles, changedLines: parseChangedLines(hunksResult.stdout) };
}

/**
 * The path of a `diff --git a/P b/P` header whose two sides are the same
 * path — unambiguous even with spaces in `P`, since both halves must match.
 * `null` for a rename/copy header (two paths) or a quoted one.
 */
function samePathFromGitHeader(rest: string): string | null {
  if (rest.length % 2 === 0) {
    return null;
  }
  const half = (rest.length - 1) / 2;
  const left = rest.slice(0, half);
  const right = rest.slice(half + 1);
  if (rest[half] !== ' ' || !left.startsWith('a/') || !right.startsWith('b/') || left.slice(2) !== right.slice(2)) {
    return null;
  }
  return right.slice(2);
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * P4-2 phase 3c: parses `git diff --unified=0 --src-prefix=a/
 * --dst-prefix=b/` output into each post-change file's changed line ranges
 * (`ChangedLineRange`: a pure deletion is the empty range between its
 * neighbours). Hunk bodies are skipped by their header's line counts, so a
 * changed line that itself reads `+++ b/…` is never taken for a file
 * header.
 *
 * Every file the diff names is listed, so an absent file means "couldn't
 * read" (`findChangedContracts` then counts all its types): a file whose
 * header names it with no hunks (a mode change, a binary file, a pure
 * rename's `rename to`) is listed with `[]`. A deleted file (`+++
 * /dev/null`) is not listed. A path git still C-quotes (control
 * characters, a double quote) is not parsed, so it stays absent. Pure.
 */
export function parseChangedLines(diff: string): Record<string, ChangedLineRange[]> {
  const result: Record<string, ChangedLineRange[]> = Object.create(null) as Record<string, ChangedLineRange[]>;
  const lines = diff.split('\n');
  let file: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    if (line.startsWith('diff --git ')) {
      file = samePathFromGitHeader(line.slice('diff --git '.length));
      if (file !== null) {
        result[file] ??= [];
      }
      continue;
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      file = line.slice(line.indexOf(' to ') + 4);
      result[file] ??= [];
      continue;
    }
    if (line.startsWith('+++ ')) {
      // git appends a tab to a header path containing a space.
      const name = line.slice(4).replace(/\t$/, '');
      if (name === '/dev/null') {
        // A deleted file: nothing of it is left to change.
        if (file !== null && result[file]?.length === 0) {
          delete result[file];
        }
        file = null;
        continue;
      }
      file = name.startsWith('b/') ? name.slice(2) : null;
      if (file !== null) {
        result[file] ??= [];
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk === null) {
      continue;
    }
    let oldCount = hunk[1] === undefined ? 1 : Number(hunk[1]);
    const newStart = Number(hunk[2]);
    let newCount = hunk[3] === undefined ? 1 : Number(hunk[3]);
    if (file !== null) {
      const ranges = result[file] ?? [];
      ranges.push(newCount === 0 ? { start: newStart + 1, end: newStart } : { start: newStart, end: newStart + newCount - 1 });
      result[file] = ranges;
    }
    // Skip the hunk body: `oldCount` '-' lines, `newCount` '+' lines, and any
    // "\ No newline at end of file" markers among them.
    while (index < lines.length && (oldCount > 0 || newCount > 0 || (lines[index] ?? '').startsWith('\\'))) {
      const body = lines[index] ?? '';
      index += 1;
      if (body.startsWith('-')) {
        oldCount -= 1;
      } else if (body.startsWith('+')) {
        newCount -= 1;
      } else if (!body.startsWith('\\')) {
        // Not a -U0 body line: stop skipping rather than eat a header.
        index -= 1;
        break;
      }
    }
  }
  return { ...result };
}
