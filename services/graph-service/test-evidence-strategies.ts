/**
 * P4-2 phase 2: which backend `CALLS` edges count as "Tested by" evidence.
 * Plain constants with no imports, shared by the evidence query
 * (`mcp-client.ts`) and its TypeScript re-check (`tested-by.ts`), so the
 * client never depends on the domain module.
 *
 * Strategies seen on driller/app's CALLS edges (`r.strategy` with its
 * `r.confidence`, live `query_graph`, 2026-09-27):
 *
 *   import_map 0.95, lsp_ts_import 0.95, lsp_ts_jsx_import 0.95 — counted
 *   lsp_ts_local 0.95, lsp_ts_jsx 0.95, same_module 0.90 — same-file
 *     resolutions; they can't link a test file to production code
 *   unique_name 0.38-0.75, callee_suffix 0.50, suffix_match 0.28-0.55 —
 *     name-only matches, never evidence
 *
 * Only strategies that resolve a call through an import statement count.
 * The backend's binary also names `lsp_import_alias` (listed beside its PHP
 * strategies) and `lsp_static_import` / `lsp_static_import_text` (beside its
 * Java strategies; the `_text` variant is a textual fallback). Neither has
 * appeared on a live index here, and nothing documents whether they resolve
 * through the imported declaration or by the imported name's text, so they
 * are left out: precision over recall. Add one only after seeing its edges
 * on a real index. Every name-only or fuzzy strategy (`unique_name`,
 * `suffix_match`, `callee_suffix`, `import_map_suffix`, `fuzzy`, ...) stays
 * out for good.
 */
export const IMPORT_RESOLVED_CALL_STRATEGIES: readonly string[] = ['import_map', 'lsp_ts_import', 'lsp_ts_jsx_import'];

/**
 * A `CALLS` edge is evidence only when it reports a `confidence` at or above
 * this. A missing confidence is not evidence.
 */
export const MIN_TEST_EVIDENCE_CONFIDENCE = 0.9;

/**
 * Path fragments that pre-select test-side callers in the evidence query,
 * alongside the backend's own `is_test` flag. A deliberately loose superset
 * of `test-code.ts`'s `isTestPath` (a fragment like `test/` also matches
 * `latest/`): it only trims production→production edges from the fetch,
 * and `tested-by.ts` still classifies every caller with `isTestNode`.
 * `CONTAINS` is case-sensitive, hence both `Test.`/`Tests.` (Java, .NET)
 * and the lower-case forms.
 */
export const TEST_CALLER_PATH_FRAGMENTS: readonly string[] = [
  '.test.',
  '.spec.',
  '_test.',
  'test_',
  '_spec.',
  'Test.',
  'Tests.',
  'IT.',
  '__tests__/',
  'tests/',
  'test/',
  'spec/',
  'e2e/',
  'cypress/',
  'playwright/',
];
