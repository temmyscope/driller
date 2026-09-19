/**
 * Default-branch resolution (Story 2.3, Phase 2, AD-13's rule).
 *
 * Resolves the branch name `cr review --base <branch>` needs — scoped to
 * just that name, never AD-13's full diff-scoped Node-set operation (that's
 * Epic 3's job; Boundaries & Constraints). Two-step, both steps going
 * through `subprocess-runner.ts`'s safe `execFile` wrapper (never a shell
 * string):
 *
 *  1. `git symbolic-ref refs/remotes/origin/HEAD` — the remote's actual
 *     default branch, when a remote `origin` is configured and its HEAD ref
 *     has been fetched. Its stdout looks like
 *     `refs/remotes/origin/main\n`, so the `refs/remotes/origin/` prefix is
 *     stripped to yield the bare branch name `cr --base` expects.
 *  2. If that fails (no remote, unfetched, or any other error), falls back
 *     to checking whether a local `main` or `master` branch exists via
 *     `git show-ref --verify --quiet refs/heads/<name>` (tried in that
 *     order) — `--verify --quiet` exits 0 with empty stdout when the ref
 *     exists, non-zero when it doesn't.
 *
 * Never prompts the user and never falls back to a hardcoded branch name
 * (Always: "unresolvable returns `'no-base-ref-resolvable'`, never a silent
 * hardcoded fallback") — if neither step finds anything, this returns the
 * explicit `{resolvable: false}` state rather than guessing `'main'`.
 *
 * `git` itself not being on PATH is treated identically to every other
 * resolution failure here (falls through to the next step, then to
 * `{resolvable: false}`) — this module has no separate "git not found"
 * result state, unlike `cr`'s own `'tool-not-found'` (Boundaries &
 * Constraints scopes that distinction to the PR-bot CLI itself); git is
 * assumed to be present, since driller already depends on the project being
 * a git repo for every other feature (Epic 1's git-detect.ts).
 */

import { runSafeSubprocess } from './subprocess-runner';

/** Result of `resolveDefaultBranch` — an explicit result state (AD-13's broader pattern), never a hardcoded fallback. */
export type ResolveDefaultBranchResult = { branch: string } | { resolvable: false };

const ORIGIN_HEAD_PREFIX = 'refs/remotes/origin/';
const FALLBACK_BRANCH_CANDIDATES = ['main', 'master'] as const;

/**
 * Resolves the default branch name for `projectRoot` — see this module's
 * doc comment for the two-step resolution order. Never throws.
 */
export async function resolveDefaultBranch(projectRoot: string): Promise<ResolveDefaultBranchResult> {
  const symbolicRefResult = await runSafeSubprocess(
    'git',
    ['symbolic-ref', 'refs/remotes/origin/HEAD'],
    { cwd: projectRoot },
  );
  if ('stdout' in symbolicRefResult) {
    const branch = extractBranchFromSymbolicRef(symbolicRefResult.stdout);
    if (branch) {
      return { branch };
    }
  }

  for (const candidate of FALLBACK_BRANCH_CANDIDATES) {
    const showRefResult = await runSafeSubprocess(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`],
      { cwd: projectRoot },
    );
    if ('stdout' in showRefResult) {
      // `--verify --quiet` exiting 0 (no `error`/`notFound` state) means the
      // ref exists — its own stdout is always empty, this branch is reached
      // purely because `runSafeSubprocess` didn't resolve to `error`/`notFound`.
      return { branch: candidate };
    }
  }

  return { resolvable: false };
}

/**
 * Strips the `refs/remotes/origin/` prefix off `symbolic-ref`'s stdout to
 * yield the bare branch name `cr --base` expects (e.g. `main`, not
 * `refs/remotes/origin/main`). Returns `undefined` for any output that
 * doesn't match the expected shape (defensive — an unexpected git output
 * format falls through to the local-branch fallback rather than passing a
 * malformed value to `cr`).
 */
function extractBranchFromSymbolicRef(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(ORIGIN_HEAD_PREFIX)) {
    return undefined;
  }
  const branch = trimmed.slice(ORIGIN_HEAD_PREFIX.length);
  return branch.length > 0 ? branch : undefined;
}
