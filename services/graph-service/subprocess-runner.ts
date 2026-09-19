/**
 * Safe subprocess runner (Story 2.3, Phase 2).
 *
 * driller's first subprocess execution of an external, user-installed CLI
 * (`cr`, and Phase 3's PR-Agent) rather than a bundled/vendored dependency.
 * Wraps Node's `execFile` — never `exec`/`spawn` with `shell: true` and
 * never a string-interpolated shell command (Always/security audit finding,
 * 2026-09-05): `command` and every element of `args` are passed as separate
 * argv entries, so a value containing shell metacharacters (a branch name
 * with spaces, a project path with `;`/`&&`, etc.) can never be
 * reinterpreted by a shell — there is no shell in the loop at all.
 *
 * Every result is an explicit state (AD-13's broader pattern), never a
 * thrown exception a caller must remember to catch:
 *  - `{stdout, stderr}`: the process ran and exited 0.
 *  - `{notFound: true}`: `command` itself couldn't be found/executed
 *    (`ENOENT` — the CLI isn't installed/on PATH). Distinguished from any
 *    other failure so callers (`git-base-ref.ts`, `coderabbit-adapter.ts`)
 *    can report a specific "tool not found" result instead of a generic
 *    error.
 *  - `{error}`: any other failure — a non-zero exit code, a signal kill, a
 *    timeout, or any other `execFile` rejection. `error.message` is used
 *    as-is; it is Node's own diagnostic text (which may include the failed
 *    command and its args) and is treated as safe-enough operator-facing
 *    text the same way every other `error instanceof Error` fallback in
 *    this codebase already does — never re-interpolated into a shell or
 *    logged with secrets attached (none of this call's inputs are secrets).
 *
 * `maxBuffer` is raised well past Node's 1 MB default (execFile's own
 * default is sized for typical short CLI output, not a code-review tool's
 * potentially large JSON report) and a generous `timeout` is applied so a
 * hung or runaway subprocess can't block an ingestion pass forever — neither
 * is part of this function's documented `{cwd}` options parameter (the spec's
 * Code Map only calls for `{cwd}`), so both are fixed internal constants
 * rather than caller-configurable knobs.
 *
 * Story 2.3 (Phase 3) widens `options` with an optional `env` — additive
 * only: Phase 2's call sites (`coderabbit-adapter.ts`, `git-base-ref.ts`),
 * which never pass it, are unaffected, and `execFile` itself already treats
 * an omitted `env` option as "inherit `process.env`" (Node's own default),
 * so leaving it `undefined` here preserves the exact behavior every existing
 * caller already depends on. When present, it's passed straight through to
 * `execFile`'s own `env` option — never merged/mutated here — so a caller
 * that wants `process.env` plus one extra var (Phase 3's `qodo-adapter.ts`,
 * for `CONFIG__GIT_PROVIDER`) builds that merged object itself and passes it
 * whole, keeping this module's only responsibility "run this command safely,"
 * never "decide what a caller's environment should look like."
 */

import { execFile } from 'node:child_process';

/** Result of a `runSafeSubprocess` call — see this module's doc comment for each state's meaning. */
export type SubprocessResult =
  | { stdout: string; stderr: string }
  | { notFound: true }
  | { error: string };

// A CodeRabbit/PR-Agent JSON report can run well past Node's 1 MB
// `execFile` default for a repo with many findings — 20 MB comfortably
// covers a large report without unbounded growth.
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

// Generous enough for a real code-review pass (which itself calls out to a
// vendor cloud) without leaving a hung subprocess running indefinitely.
const SUBPROCESS_TIMEOUT_MS = 10 * 60 * 1000;

// Grace period after SUBPROCESS_TIMEOUT_MS's SIGTERM before escalating to
// SIGKILL (review finding, Edge Case Hunter) — long enough for a
// well-behaved process to finish exiting in response to SIGTERM, short
// enough that a non-cooperative one isn't left running much longer.
const SIGKILL_GRACE_MS = 5 * 1000;

/**
 * Runs `command` with `args` as an array (never a shell string) in `cwd`,
 * resolving to one of three explicit states — see this module's doc comment.
 * Never rejects: every failure path, including `command` not existing at
 * all, resolves rather than throws, so callers never need a try/catch around
 * this call.
 */
export function runSafeSubprocess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: SUBPROCESS_TIMEOUT_MS,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        clearTimeout(escalateToSigkillTimer);
        if (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({ notFound: true });
            return;
          }
          resolve({ error: error.message });
          return;
        }
        resolve({ stdout, stderr });
      },
    );

    // Review finding (Edge Case Hunter): `execFile`'s own `timeout` option
    // only ever sends SIGTERM (its default `killSignal`) — if the child
    // traps or ignores it, the child never actually exits, the callback
    // above never fires (it waits for the process to exit, not just for the
    // signal to be sent), and both this promise and the subprocess itself
    // leak indefinitely, past every timeout in this codebase. Escalate to
    // an unignorable SIGKILL a grace period after our own timeout should
    // already have terminated it, if it's still alive by then.
    const escalateToSigkillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, SUBPROCESS_TIMEOUT_MS + SIGKILL_GRACE_MS);
  });
}
