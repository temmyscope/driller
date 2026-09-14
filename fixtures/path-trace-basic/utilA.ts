/**
 * Story 1.9 (Phase 3) fixture addition: `helper` here and in `utilB.ts`
 * share the same exported name so a `"helper"` query hits the exact-name
 * tier with >1 match, producing `{status: 'ambiguous', ...}` — see
 * `README.md`'s "Hand-verified expected `traceCallPath` output" section.
 *
 * Deliberately standalone (uncalled by `entry.ts`'s existing call graph, and
 * calls nothing itself) so this fixture addition can't change the outcome
 * of any of the pre-existing `handleRequest`/`cacheLookup`/`doesNotExist`
 * queries documented above — it only adds a new, isolated `ambiguous` case.
 */
export function helper(): void {
  // Intentionally empty — this Node exists only to be a disambiguation
  // candidate, never to be traced through.
}
