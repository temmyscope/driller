/**
 * Project-relative POSIX path normalization for backend-reported paths.
 */
import path from 'node:path';

/**
 * Converts a raw path reported by the backend — either a gap-file path
 * (`GapFile.path`, as `index_status` reports it) or a Code Map Node's `file`
 * (`n.file_path`, as `fetchCodeMap`'s `query_graph` reports it) — into the
 * same POSIX-relative-to-project-root format `CodeMapNode.file` is documented
 * to always carry (AD-19), so `coverageGapFileSet` membership can be checked
 * with a plain `Set.has(node.file)` rather than re-resolving paths on every
 * Node.
 *
 * Handles both shapes defensively rather than trusting either caller's raw
 * value at face value: live verification against the real backend (Story
 * 1.7's own verification pass, following the same pattern this helper was
 * originally built for on the gap-path side) found `index_status` actually
 * reporting a bare relative path (e.g. `"broken.js"`, matching
 * `CodeMapNode.file` directly) for at least this backend build/invocation
 * shape — `path.relative(projectRoot, "broken.js")` on an already-relative
 * second argument silently resolves it against `process.cwd()` instead,
 * producing a garbage path that never matches any real Node's `file` and
 * letting an ineligible Node's file slip through the gap filter to generate
 * a confident-looking summary anyway (a real, live-caught bug — see this
 * spec's Verification section for the concrete before/after). Only an
 * actually-absolute `rawPath` is resolved relative to `projectRoot`; an
 * already-relative one is used as-is (after separator normalization), so
 * this is correct regardless of which shape a given backend build/response
 * reports — for either caller.
 *
 * Two review-finding hardenings (Low ×2) on top of that live-verified fix:
 *  - The resolved-absolute branch's result is checked for actually landing
 *    inside `projectRoot` (never starting with `..`, never itself absolute
 *    — the latter possible on Windows when `rawPath` names a different
 *    drive). A path that escapes silently never matches any Node's `file`
 *    either way, but previously left no diagnostic trail explaining why —
 *    logged now so a genuine backend anomaly here is traceable instead of
 *    looking identical to "no coverage gap for this Node" (gap-path caller)
 *    or silently corrupting `readSourceRange`/coverage-gap matching for the
 *    affected Node (Code Map `file` caller, Story 1.7) — best-effort passed
 *    through either way, never thrown, so one bad Node's `file` never blanks
 *    the whole map.
 *  - Separator normalization (`split`+`join` to POSIX `/`) is applied via a
 *    regex matching either `/` or `\`, not `path.sep` — `path.sep` is this
 *    *process's* own OS separator (`/` on macOS/Linux), so splitting on it
 *    alone left a literal `\` untouched on a POSIX host even though it was
 *    already being applied to both branches. A backend reporting a
 *    Windows-style `\`-separated relative path (the already-relative
 *    branch) or a resolved-absolute path that happens to retain a `\`
 *    would otherwise silently fail to match `CodeMapNode.file`'s POSIX
 *    format regardless of which branch produced it.
 *
 * `context` (review finding, Low) names which caller/field is being
 * normalized (e.g. `'coverage gap file'` vs. `'Code Map node file'`) and is
 * folded into the outside-project-root warning below — generalizing this
 * helper to two callers lost that diagnosability when the warning text was
 * genericized to plain "path", leaving no way to tell which caller/field
 * triggered a given warning beyond the raw path string itself.
 *
 * P4-2 phase 1: moved out of `index.ts` (which has load-time side effects)
 * so `production-code-map.ts` can share it and be tested. `warn` lets a
 * caller deduplicate the outside-project-root warning.
 */
export function toProjectRelativePosixPath(
  projectRoot: string,
  rawPath: string,
  context: string,
  warn: (message: string) => void = console.warn,
): string {
  let relative: string;
  if (path.isAbsolute(rawPath)) {
    relative = path.relative(projectRoot, rawPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      warn(
        `[graph-service] ${context} "${rawPath}" resolved outside the project root "${projectRoot}" (got "${relative}"); it will be passed through best-effort rather than corrected, so it will not match any Node's file for coverage-gap purposes and may fail to resolve for source-reading purposes.`,
      );
    }
  } else {
    relative = rawPath;
  }
  return relative.split(/[\\/]+/).join('/');
}
