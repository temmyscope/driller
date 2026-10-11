/**
 * MCP client wrapper around the real `codebase-memory-mcp` graph backend
 * (AD-3, AD-6).
 *
 * Per the Intent, the Graph Service connects to this backend as an MCP
 * client over stdio rather than reimplementing graph indexing itself. The
 * backend is spawned as a second-level subprocess that THIS module owns and
 * tears down — never main (AD-1's process boundary applies one level down
 * too).
 *
 * The backend is launched by resolving `codebase-memory-mcp`'s own `bin`
 * entry through Node's module resolution and running it with the current
 * Node executable — never a shell `npx` invocation. `npx` without `-y` can
 * hit an interactive install-confirmation prompt with no way to answer it
 * (stdin is dedicated to the MCP JSON-RPC channel), can resolve a different
 * version than the one pinned in `package.json`, and on Windows is a `.cmd`
 * shim that a direct transport spawn commonly fails to launch without
 * `shell: true`. Resolving the real installed dependency and invoking it
 * via `process.execPath` sidesteps all three.
 *
 * `persistence` is omitted on the `index_repository` call so driller never
 * writes into the user's project folder (AD-17); the backend keeps its own
 * state in its own global cache (AD-6), which this module never touches.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { IMPORT_RESOLVED_CALL_STRATEGIES, TEST_CALLER_PATH_FRAGMENTS } from './test-evidence-strategies';
import type { ImplementsLink } from './fold-types';
import { SIMILAR_TO_MIN_JACCARD } from '@driller/graph-contracts';
import type {
  CodeMapEdge,
  CodeMapEdgeKind,
  CodeMapNode,
  CodeMapNodeKind,
  GapFile,
  IndexCoverageSummary,
} from '@driller/ipc-contracts';

export interface IndexRepositoryResult {
  nodes: number;
  edges: number;
  /**
   * Sourced from the backend's own `index_repository`/`index_status`
   * responses; omitted when the best-effort `index_status` follow-up call
   * fails (see `fetchCoverage`'s doc comment) — never re-derived or
   * inferred locally (Always: FR2).
   */
  coverage?: IndexCoverageSummary;
  /**
   * The backend's own project identifier for this repo (the same value
   * `fetchCoverage` uses to call `index_status`), needed by Story 1.3's
   * `fetchCodeMap` to run its `query_graph` calls against the right project.
   * Undefined under the same conditions `fetchCoverage`'s `project` gate
   * is — an older/degraded backend response that didn't report it.
   */
  project?: string;
}

/** Result of `fetchCodeMap`'s two `query_graph` calls. */
export interface CodeMapFetchResult {
  nodes: CodeMapNodeWithSignalSources[];
  edges: CodeMapEdge[];
  /**
   * P4-2 phase 2: raw test-link evidence, present only when
   * `FetchCodeMapOptions.includeTestEvidence` asked for it.
   * `production-code-map.ts` turns it into `CodeMapNode.testedBy`.
   */
  testEvidence?: TestEvidence;
  /**
   * P4-2 phase 3b: backend `IMPLEMENTS` edges between Type/Interface Nodes,
   * present only when `FetchCodeMapOptions.includeImplements` asked for it.
   * `fold-types.ts` turns them into `FoldedType.implements`.
   */
  implementsLinks?: ImplementsLink[];
  /**
   * P4-2 phase 4: backend `SIMILAR_TO` edges between Functions at or above
   * `SIMILAR_TO_MIN_JACCARD`, present only when
   * `FetchCodeMapOptions.includeSimilar` asked for it. `similar.ts` turns
   * them into `CodeMapNode.similarTo`.
   */
  similarPairs?: SimilarPair[];
}

/**
 * P4-2 phase 4: one backend `SIMILAR_TO` edge, straight off
 * `SIMILAR_TO_QUERY`. The edge is stored once per pair; `similar.ts` reads
 * it both ways. Everything is kept, not trusted: `attachSimilar` re-checks
 * the score, the files and that both ends are production map Functions.
 */
export interface SimilarPair {
  /** One end's `qualified_name`. */
  source: string;
  /** The other end's `qualified_name`. */
  target: string;
  /** The backend's `r.jaccard`. */
  score: number;
  /** The backend's `r.same_file`, set only when true. */
  sameFile?: true;
}

/**
 * P4-2 phase 2: one `CALLS` edge from a test-side caller whose strategy is
 * in `IMPORT_RESOLVED_CALL_STRATEGIES`, straight off
 * `TEST_EVIDENCE_CALLS_QUERY`. It carries its caller's own details because a
 * caller need not be a map Node (a `Method`, e.g. a JUnit test method, never
 * is). `tested-by.ts` makes the final test/production call.
 */
export interface TestCallEvidence {
  /** Caller's `qualified_name`. */
  source: string;
  /** Caller's `name` (a Module's is its file path). */
  sourceName: string;
  /** Caller's `file_path`, as the backend reports it. */
  sourceFile: string;
  sourceStartLine: number;
  sourceEndLine: number;
  /** Caller's label. A `Module` caller is a test file's top level. */
  sourceKind: 'Function' | 'Method' | 'Module';
  /** Caller's backend `is_test`, set only when true. */
  sourceIsTest?: boolean;
  /** Callee's `qualified_name`. */
  target: string;
  /** The backend's `r.strategy`. */
  strategy: string;
  /** The backend's `r.confidence`, when reported. */
  confidence?: number;
  /** The call's own line (`r.line`), when reported. */
  line?: number;
}

/** P4-2 phase 2: one `TESTS_FILE` File→File edge, paths as the backend reports them. */
export interface TestFileEvidence {
  testFile: string;
  file: string;
}

/** P4-2 phase 2: everything `attachTestedBy` reads. */
export interface TestEvidence {
  calls: TestCallEvidence[];
  testFiles: TestFileEvidence[];
}

/**
 * Story 2.1 (Phase 1): `CodeMapNode` plus the raw FR7 complexity/cognitive/
 * hotspot numbers straight off `CODE_MAP_NODES_QUERY`'s extended `RETURN`
 * clause — this module's own per-node shape, never the public wire
 * `RiskSignal` shape itself. This module only ever sources structural graph
 * data from the backend (same discipline as `summaryStatus: 'pending'`
 * below); it is `index.ts`'s `handleGetCodeMapRequest` that turns these raw
 * numbers into `RiskSignal`s (and adds blast radius) and attaches the result
 * as `CodeMapNode.riskSignals` — `riskSignals` itself is always `[]` here,
 * a placeholder for the same reason `summaryStatus` is.
 */
export interface CodeMapNodeWithSignalSources extends CodeMapNode {
  /** `n.complexity`, when the backend reported one for this Node's language/grammar. */
  complexity?: number;
  /** `n.cognitive`, when the backend reported one for this Node's language/grammar. */
  cognitiveComplexity?: number;
  /** `f.change_count` off the Node's own File (via the query's `OPTIONAL MATCH`), when present. */
  hotspotChangeCount?: number;
  /**
   * P4-2 phase 1: the backend's `n.is_test` (see `parseTestFlag`), set only
   * when true. Never reaches the wire: `excludeTestCode` removes every Node
   * that carries it, and `attachProjectRiskSignals` strips the field anyway.
   */
  isTest?: boolean;
}

const CLIENT_INFO = { name: 'driller-graph-service', version: '0.1.0' };

// A genuine hang-only safety net (Phase 2), not a bound on legitimate
// large-repo indexing time: 30 minutes is well past AD-15's ~3min full-index
// budget at the confirmed 1,000-1,300 file target, so a repo that
// legitimately runs long (e.g. a large monorepo opened by mistake) is never
// mistaken for a stuck backend. Only a genuinely hung MCP call (backend
// wedged) should ever actually hit this ceiling.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// Independent of DEFAULT_TIMEOUT_MS on purpose (review round 2, High): the
// `index_status` follow-up in `fetchCoverage` used to share the outer
// `indexRepository` timeout, so a follow-up call that merely hung (never
// resolved or rejected) after `index_repository` had already succeeded would
// eventually trip the 30-minute *outer* timeout and discard the successful
// `nodes`/`edges` — reporting `error` instead of `indexed`, directly
// violating the Always constraint that the gap-check's failure must never
// turn a successful index into an error status. A short, independent timeout
// here means a hung follow-up call degrades to `coverage: undefined` well
// before it could ever threaten the outer call.
const INDEX_STATUS_TIMEOUT_MS = 30 * 1000;

/**
 * FIX-6: the bound on the MCP handshake (spawning the backend and its
 * `initialize` reply) in `indexRepository` and `fetchCodeMap`. Not a new budget: the MCP
 * SDK already gives every request, `initialize` included, a 60 s default
 * timeout, which ended a silent backend with a bare "Request timed out".
 * Making it explicit, at the same 60 s, lets the error say what failed and
 * what to do. A healthy handshake takes ~4 s (a cold CBM daemon start),
 * ~8 s while a previous daemon is stopping. `DEFAULT_TIMEOUT_MS` (the index
 * itself) is unchanged.
 */
export const BACKEND_CONNECT_TIMEOUT_MS = 60 * 1000;

/**
 * FIX-6: every MCP request gets an explicit SDK timeout from its own budget.
 * The SDK otherwise caps each request at its 60 s default
 * (`DEFAULT_REQUEST_TIMEOUT_MSEC`), so a real index over 60 s failed with
 * "Request timed out", long before the intended budget (AD-15: ~3 min,
 * `DEFAULT_TIMEOUT_MS` as the hang net). The SDK's timer is set this much
 * past the budget, so the budget's own `withTimeout`, with its descriptive
 * message, is the one that fires. Progress notifications don't reset it:
 * the budget is the bound.
 */
const SDK_TIMEOUT_SLACK_MS = 1_000;

/** FIX-6: the SDK request options for a call whose intended budget is `budgetMs`. */
export function requestOptions(budgetMs: number): { timeout: number } {
  return { timeout: budgetMs + SDK_TIMEOUT_SLACK_MS };
}

/** FIX-6: how much of the backend's stderr `indexRepository` keeps for its error message. */
const BACKEND_STDERR_TAIL_CHARS = 4_000;

/**
 * Resolves `codebase-memory-mcp`'s own installed `bin` entry via Node's
 * module resolution (starting from this module's location, so it always
 * finds the exact version pinned in `services/graph-service/package.json`
 * — never a different version npx might resolve from elsewhere on PATH).
 * Returns a `{command, args}` pair that runs it via the current Node
 * executable rather than relying on the file's shebang (which Windows
 * doesn't support) or a shell.
 *
 * Uses the ambient CJS `require.resolve` (like `main/index.ts`'s use of
 * `__dirname`) rather than `createRequire(import.meta.url)`: this module
 * ships as a CJS bundle (forge.config.ts's 'main' build target), and
 * `import.meta.url` is not reliably populated under CJS output — some
 * bundlers leave it `undefined`, which makes `createRequire` throw at
 * module load. The resolved package.json's content is then read directly
 * (`readFileSync` + `JSON.parse`) rather than via a second `require(...)`,
 * which the lint config forbids as an import pattern.
 */
/**
 * The `CBM_*` variables of this process, passed to the CBM backend child.
 * The MCP SDK's stdio transport otherwise gives the child only a small
 * fixed set (HOME, PATH, …), which silently drops settings such as
 * `CBM_CACHE_DIR` (found by the P4-8h e2e harness, whose temp CBM cache
 * was ignored).
 */
export function cbmEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CBM_') && typeof value === 'string') picked[key] = value;
  }
  return picked;
}

function resolveBackendCommand(): { command: string; args: string[] } {
  const packageJsonPath = require.resolve('codebase-memory-mcp/package.json');
  const packageDir = path.dirname(packageJsonPath);
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };

  const binField = pkg.bin;
  let binRelativePath: string | undefined;
  if (typeof binField === 'string') {
    binRelativePath = binField;
  } else if (binField && typeof binField === 'object') {
    binRelativePath = binField['codebase-memory-mcp'] ?? Object.values(binField)[0];
  }

  if (!binRelativePath) {
    throw new Error(
      "codebase-memory-mcp's package.json has no usable \"bin\" entry to resolve.",
    );
  }

  return {
    command: process.execPath,
    args: [path.join(packageDir, binRelativePath)],
  };
}

/**
 * Best-effort, fire-and-forget request for CBM to retire its own background
 * daemon (Bug fix, 2026-09-23).
 *
 * Every other call in this module (`indexRepository`, `fetchCodeMap`, ...)
 * is deliberately ephemeral per-call and only ever closes its own immediate
 * MCP transport (`client.close()`) — which, per a live investigation of a
 * "conflicting CBM process is active" startup failure, SIGTERMs only the
 * directly-spawned Node wrapper (`resolveBackendCommand`'s `bin.js` shim),
 * not the native daemon it launches underneath via a blocking `spawnSync`.
 * That daemon is designed to outlive any single client session — CBM's own
 * CLI help says as much ("it survives idle periods and session ends; run
 * `daemon stop` first if you want a permanent one" / "`codebase-memory-mcp
 * daemon stop` retires it") — so nothing in this module's normal per-call
 * teardown was ever going to stop it. This is the one call site that
 * actually asks CBM to retire it, by forwarding `daemon stop` as extra argv
 * to the same bin shim `resolveBackendCommand` already resolves (confirmed
 * via that shim's own source: it forwards `process.argv.slice(2)` straight
 * through to the native binary).
 *
 * Deliberately synchronous and detached rather than awaited: this exists to
 * run from `finishShutdown` (index.ts) during the Graph Service subprocess's
 * own shutdown, which main's `teardownGraphService` bounds with a 2s
 * fallback kill — waiting on this spawn could race that kill and either
 * delay app quit or get killed mid-flight. `detached: true` + `unref()`
 * means the spawned `daemon stop` process is not part of this subprocess's
 * process group and keeps running to completion independently even if this
 * subprocess itself is force-killed a moment later — the app quitting
 * promptly and the daemon actually stopping are not coupled. Never throws:
 * a failure here just leaves the daemon running, the pre-existing behavior,
 * so it's logged and swallowed rather than surfaced as an error anywhere.
 */
export function stopCbmDaemon(): void {
  try {
    const { command, args } = resolveBackendCommand();
    const child = spawn(command, [...args, 'daemon', 'stop'], {
      stdio: 'ignore',
      detached: true,
    });
    child.once('error', (error) => {
      console.warn(
        `[graph-service] couldn't stop the CBM daemon on shutdown (it may be left running): ${error.message}`,
      );
    });
    child.unref();
  } catch (error) {
    console.warn(
      `[graph-service] couldn't stop the CBM daemon on shutdown (it may be left running): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Connects to `codebase-memory-mcp` over stdio, calls `index_repository` for
 * `repoPath`, and returns the backend's raw node/edge counts plus (when the
 * best-effort `index_status` follow-up succeeds) a coverage summary. The MCP
 * client and its backing subprocess are ephemeral — spun up fresh and always
 * torn down again before this function returns (success, failure, or
 * timeout) — so a long-running or hung call never leaks a dangling backend
 * process.
 *
 * Both calls run over the same connection before it's closed — never a
 * second spawn, per the Always constraint on the backend's machine-wide
 * single-instance lock.
 *
 * Throws on any failure (backend fails to spawn, the MCP handshake fails,
 * the `index_repository` call rejects or reports `isError`, the combined
 * call exceeds `timeoutMs`, or the result can't be parsed into
 * `{nodes, edges}`) — callers surface that through the existing error/retry
 * status path rather than a bespoke failure shape. The `index_status`
 * follow-up call is best-effort and never throws — see `fetchCoverage`.
 */
export async function indexRepository(
  repoPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options: IndexRepositoryOptions = {},
): Promise<IndexRepositoryResult> {
  const { command, args } = options.backend ?? resolveBackendCommand();
  // FIX-6: stderr is piped (not inherited) so a failure can quote the
  // backend's own explanation — CBM's start-up refusals go only there. Each
  // chunk is still echoed to this process's stderr, as before.
  const transport = new StdioClientTransport({ command, args, env: cbmEnvironment(), stderr: 'pipe' });
  const stderr = captureBackendStderr(transport.stderr);
  const client = new Client(CLIENT_INFO);
  const connectTimeoutMs = options.connectTimeoutMs ?? BACKEND_CONNECT_TIMEOUT_MS;

  try {
    return await withTimeout(
      runIndex(client, transport, repoPath, connectTimeoutMs, timeoutMs),
      timeoutMs,
      `index_repository (${repoPath})`,
    );
  } catch (error) {
    throw withBackendExplanation(error, stderr.lastLine());
  } finally {
    // Best-effort: the transport's child process may already be gone (e.g.
    // it crashed before/during connect, or the call above timed out), in
    // which case close() rejecting is not itself an error worth surfacing
    // over the original failure/result.
    await client.close().catch(() => {});
  }
}

/**
 * FIX-6: connects `client` over `transport` (spawn plus `initialize`) within
 * `connectTimeoutMs`, rejecting with an actionable message when the backend
 * never answers. The SDK's own `initialize` timeout is lifted past ours
 * (`requestOptions`), so this one fires.
 */
async function connectBackend(client: Client, transport: StdioClientTransport, connectTimeoutMs: number): Promise<void> {
  try {
    await withTimeout(client.connect(transport, requestOptions(connectTimeoutMs)), connectTimeoutMs, 'start');
  } catch (error) {
    if (error instanceof Error && error.message === `start timed out after ${connectTimeoutMs}ms`) {
      throw new Error(
        `the code-graph backend (codebase-memory-mcp) didn't answer within ${Math.round(connectTimeoutMs / 1000)} s of starting. ` +
          'Close other codebase-memory-mcp sessions, then retry.',
      );
    }
    throw error;
  }
}

async function runIndex(
  client: Client,
  transport: StdioClientTransport,
  repoPath: string,
  connectTimeoutMs: number,
  timeoutMs: number,
): Promise<IndexRepositoryResult> {
  await connectBackend(client, transport, connectTimeoutMs);
  const result = await client.callTool({
    name: 'index_repository',
    arguments: {
      repo_path: repoPath,
      // Explicit false, not merely omitted: this is the one call in the
      // codebase that could write into the backend's persistence layer,
      // and AD-17 requires driller never write into the user's project
      // folder. Being explicit here is defense against the backend's
      // default ever silently flipping.
      persistence: false,
    },
  }, requestOptions(timeoutMs));

  if (result.isError) {
    throw new Error(`index_repository reported an error: ${extractErrorText(result)}`);
  }

  const fields = parseIndexResult(result);
  const coverage = await fetchCoverage(client, fields);
  return { nodes: fields.nodes, edges: fields.edges, coverage, project: fields.project };
}

// ---------------------------------------------------------------------------
// Story 1.3 (Phase 1): Code Map data fetch (AD-3, FR3/FR4).
//
// Same per-call MCP connection pattern as `indexRepository` above: a fresh
// client+transport spun up for this call and always torn down before
// returning, never a lingering connection reused across renders. Both
// `query_graph` calls (nodes, then edges) run over the one connection before
// it's closed, mirroring `runIndex`'s two-calls-one-connection shape.
//
// Node/edge selection here is a judgment call (Design Notes): Function /
// Interface / Type / Module labels only (EXPERIENCE.md's "function/method/
// module name" atomic map unit) — never Variable/Section (too granular) or
// File/Folder/Project/Branch (scaffolding). CALLS/USAGE edges only (IMPORTS
// never matches; see CODE_MAP_EDGES_QUERY) — never DEFINES/CONTAINS_*
// containment edges (FR4 is call/dependency edges).
// ---------------------------------------------------------------------------

const CODE_MAP_NODE_KINDS: readonly CodeMapNodeKind[] = [
  'Function',
  'Interface',
  'Type',
  'Module',
];

// P4-2 phase 1: `IMPORTS` stays an accepted kind here and in the
// `CodeMapEdgeKind` contract, because the backend may emit symbol-level
// IMPORTS edges later. `CODE_MAP_EDGES_QUERY` currently omits it: today every
// IMPORTS edge starts at a `File` node, so it could never match.
const CODE_MAP_EDGE_KINDS: readonly CodeMapEdgeKind[] = ['CALLS', 'IMPORTS', 'USAGE'];

// Live-verified against a real codebase-memory-mcp instance (this story's
// verification pass) — the Code Map's Design Notes explicitly pre-authorize
// "a one-line query change if this reads wrong once real maps are seen."
// The spec's original text (`any(l IN labels(n) WHERE l IN [...])` /
// `type(r) IN [...]` in WHERE) reliably errors on the tested build:
// `unsupported function 'any'/'type' in WHERE (supported: coalesce,
// substring, replace, left, right)` — this engine's WHERE evaluator only
// supports that fixed function allowlist, distinct from its RETURN
// expression evaluator (`type(r)` works fine in RETURN, confirmed below).
//
// Also live-verified: `labels(n)[0] AS kind` (list-indexing a function
// result) silently breaks alias assignment on this engine — the response
// column comes back named `labels(n)` (not `kind`) holding the whole
// JSON-array-as-string value (`"[\"Module\"]"`), not the first element.
// Replaced with an explicit `CASE WHEN n:Function THEN 'Function' ... END AS
// kind`, which returns a plain, unquoted, already-exactly-one-of-our-four-
// literals string — simpler than double-JSON-decoding an array string, and
// confirmed working.
//
// Label filtering itself uses `(x:A|B|C|D)` pattern-position label
// alternation exclusively, on every node variable in both queries — NOT a
// `WHERE x:A OR x:B ...` boolean disjunction. A second live-verification
// round (review finding #7's fix) found this engine's WHERE-clause label
// test only works for a pattern's first/anchor variable: `WHERE a:Function
// OR ...` behaved correctly, but the exact same construct on the *second*
// pattern variable (`WHERE b:Function OR ...`) silently matched nothing —
// `rows: 0`, even for edges independently confirmed to exist via a direct
// query. `(b:Function|Interface|Type|Module)` written directly in the
// pattern, by contrast, worked correctly in both positions — confirmed by
// re-running the edges query below and getting the expected row count back
// (184, matching a manual cross-check of valid edges). The nodes query was
// also switched to this same pattern-based form for consistency, even
// though its single-variable WHERE form already worked — so neither query
// depends on the WHERE-based label test's positional limitation.
// Story 2.1 (Phase 1), AD-9 corrected: extended with two more RETURN
// columns — `n.complexity`/`n.cognitive` (per-Function/Interface/Type/Module
// properties the backend's own indexing pass already computes). No new
// tree-sitter parsing pass (Boundaries & Constraints) — these are
// exclusively `codebase-memory-mcp`'s own already-computed properties.
//
// Review round (patch): an earlier version of this query also tried to pull
// `File.change_count` (hotspot) in the same call via
// `OPTIONAL MATCH (f:File {file_path: n.file_path})`. Live-verified against
// a real codebase-memory-mcp instance (this review round) that this fails
// outright — `expected token type 86, got 85 at pos 76` — and the
// WHERE-based equivalent (`OPTIONAL MATCH (f:File) WHERE f.file_path =
// n.file_path`) also fails (`expected value at pos 85`): this engine's
// property-map/WHERE evaluator accepts only literal values, never another
// bound variable's property, so a same-query cross-entity join can never
// work here. `f.change_count` is fetched via its own standalone
// `CODE_MAP_FILES_QUERY` below instead and joined in TypeScript by
// `file_path` (`runFetchCodeMap`) — the same "separate query, join in code"
// shape this function already uses for nodes+edges, not a new pattern.
//
// Bug fix (2026-09-23): `WHERE NOT n.file_path STARTS WITH '<'` excludes
// CBM's own synthetic builtin/stdlib symbol nodes (e.g. Python's
// `builtins.len`/`builtins.print`, Kotlin's stdlib equivalents), which CBM
// represents with a bracketed sentinel `file_path` like `<python-builtins>`
// rather than a real on-disk path — live-verified via `strings` on CBM's
// binary (`<python-builtins>`, `<kotlin-builtins>`) and confirmed live
// against an indexed project (`query_graph`, `STARTS WITH` supported by
// this engine). These aren't part of the user's own codebase, so they don't
// belong in the Code Map's Node set at all: summary generation was
// otherwise trying (and failing, every run) to `fs.readFile` this sentinel
// as a real path, spamming `couldn't read source for ...: ENOENT`
// indefinitely. Filtering here, at the one source of the Code Map's Node
// set, means every downstream consumer (summary generation, risk signals,
// the renderer) simply never sees these Nodes — no new `SummaryStatus`
// state or renderer change needed. `CODE_MAP_EDGES_QUERY` needs no matching
// filter: it already requires both endpoints' `qualified_name IS NOT NULL`
// for the same "no dangling edges to entities outside the fetched node set"
// reason, and this file's own comment on that query already establishes
// that a dangling edge to a Node this query drops is harmless (React Flow
// silently discards it).
//
// P4-2 phase 1: `n.is_test AS isTest` is the backend's own test flag, read so
// `test-code.ts`'s `excludeTestCode` can drop test Nodes (along with its path
// rules, since the flag is false on Interfaces/Types inside test files).
// Live-verified: it comes back as `"true"`/`"false"`, and a Node without the
// property reports `-`, so the column count never changes.
// Exported for `mcp-client.test.ts`'s column-count check.
export const CODE_MAP_NODES_QUERY = `MATCH (n:Function|Interface|Type|Module) WHERE NOT n.file_path STARTS WITH '<' RETURN n.qualified_name AS id, n.name AS name, n.file_path AS file, n.start_line AS startLine, n.end_line AS endLine, CASE WHEN n:Function THEN 'Function' WHEN n:Interface THEN 'Interface' WHEN n:Type THEN 'Type' ELSE 'Module' END AS kind, n.complexity AS complexity, n.cognitive AS cognitive, n.is_test AS isTest`;

// Story 2.1 (Phase 1), review round: hotspot data, fetched standalone (see
// `CODE_MAP_NODES_QUERY`'s comment for why it can't be joined in one Cypher
// call on this engine). No `WHERE`/label-alternation quirk applies — this is
// a single-label, no-join match, live-verified to return real per-file
// counts (e.g. a file with 3 recorded changes: `f.change_count` = `"3"`).
const CODE_MAP_FILES_QUERY = `MATCH (f:File) RETURN f.file_path AS file, f.change_count AS changeCount`;

// Both endpoints are filtered to the same Function/Interface/Type/Module
// label set as the nodes query (review finding #7): without this, the
// query happily returns edges to/from Variable/File/etc. entities that
// were never going to be in the fetched node set anyway. Live testing
// confirmed React Flow silently drops such dangling edges (harmless), but
// fetching and parsing rows only to discard them is wasteful and was
// inconsistent with the nodes query's own filtering — this makes the two
// consistent. See the comment above `CODE_MAP_NODES_QUERY` for why both
// `a` and `b` use pattern-position `(x:A|B|C|D)` label alternation rather
// than a `WHERE` boolean disjunction.
//
// P4-2 phase 1: `IMPORTS` is deliberately not in the relationship list. Every
// IMPORTS edge in the backend starts at a `File` node, never a
// Function/Interface/Type/Module, so it could never match here; the map's
// edges are CALLS and USAGE only.
const CODE_MAP_EDGES_QUERY = `MATCH (a:Function|Interface|Type|Module)-[r:CALLS|USAGE]->(b:Function|Interface|Type|Module) WHERE a.qualified_name IS NOT NULL AND b.qualified_name IS NOT NULL RETURN a.qualified_name AS source, b.qualified_name AS target, type(r) AS kind`;

// P4-2 phase 2: "Tested by" evidence. Property names confirmed with
// `get_graph_schema` on the indexed driller/app project (2026-09-27): `CALLS`
// carries `strategy`, `confidence`, `line` (plus `args`, `callee`,
// `candidates`); `TESTS_FILE` is File→File with no properties of its own;
// `is_test` exists on Function, Method and Module. Which strategies count is
// `test-evidence-strategies.ts`'s `IMPORT_RESOLVED_CALL_STRATEGIES`.
//
// Live-verified on driller/app (2026-09-27): a parenthesized
// `(... OR ...) AND (... OR ...)` WHERE mixing a node flag, `CONTAINS` on a
// node path and the relationship's `strategy` evaluates as written on this
// engine (an impossible path clause returns 0 rows; the full query returns
// 275 rows, 225 of them into production code). The caller side is limited
// to test code in Cypher — the backend's `is_test`, or a path fragment from
// `TEST_CALLER_PATH_FRAGMENTS` — so production→production edges are never
// fetched; `tested-by.ts` still re-checks every row.
//
// Callers are Function|Method|Module. Most test calls are made at a test
// file's top level (inside `test(...)`), which the backend attributes to the
// file's Module: `formatSyncAge` is called by the `appFrame.test` Module
// (import_map, 0.95, line 381). `Method` covers class-based test frameworks
// (JUnit, xUnit, unittest). Targets stay the map's own labels: `Method` is
// not a map Node (`CODE_MAP_NODES_QUERY`), so there is nothing to attach a
// "Tested by" row to — a Method target could never be shown. Exported for
// tests.
export const TEST_EVIDENCE_CALLS_QUERY = `MATCH (a:Function|Method|Module)-[r:CALLS]->(b:Function|Interface|Type|Module) WHERE (${[
  'a.is_test = true',
  ...TEST_CALLER_PATH_FRAGMENTS.map((fragment) => `a.file_path CONTAINS '${fragment}'`),
].join(' OR ')}) AND (${IMPORT_RESOLVED_CALL_STRATEGIES.map((strategy) => `r.strategy = '${strategy}'`).join(
  ' OR ',
)}) RETURN a.qualified_name AS source, a.name AS sourceName, a.file_path AS sourceFile, a.start_line AS sourceStartLine, a.end_line AS sourceEndLine, a.is_test AS sourceIsTest, CASE WHEN a:Module THEN 'Module' WHEN a:Method THEN 'Method' ELSE 'Function' END AS sourceKind, b.qualified_name AS target, r.strategy AS strategy, r.confidence AS confidence, r.line AS line`;

// Live-verified: 18 rows on driller/app (2026-09-27), all same-stem
// (`x.test.ts`→`x.ts`). An unknown relationship type returns `rows: 0` on
// this engine rather than an error, so an older backend without TESTS_FILE
// simply yields none. (File nodes report `start_line`/`end_line` 0, so a
// test file's range comes from its Module Node instead; see `tested-by.ts`.)
// P4-2 phase 3b: a folded type's "Implements" row. Live-verified on
// driller/app (2026-09-27): 4 rows, all Interface→Interface (TS `extends`),
// e.g. `CodeMapNodeWithSignalSources` → `CodeMapNode`. Pattern-position
// label alternation on both ends, like `CODE_MAP_EDGES_QUERY`. Exported for
// tests.
export const IMPLEMENTS_QUERY = `MATCH (a:Interface|Type)-[r:IMPLEMENTS]->(b:Interface|Type) WHERE a.qualified_name IS NOT NULL AND b.qualified_name IS NOT NULL RETURN a.qualified_name AS source, b.qualified_name AS target`;

export const TEST_EVIDENCE_FILES_QUERY = `MATCH (t:File)-[r:TESTS_FILE]->(f:File) RETURN t.file_path AS testFile, f.file_path AS file`;

// P4-2 phase 4: "Similar implementations". Property names confirmed with
// `get_graph_schema` on the indexed driller/app project (2026-09-27):
// `SIMILAR_TO` carries `jaccard` and `same_file` (plus `source_id`/
// `target_id`); all 91 edges are Function→Function, stored once per pair
// (`withTimeout`'s 5 copies give 10 edges, not 20). Live-verified: `jaccard`
// comes back as `"1.000"`/`"0.953"` and compares numerically in WHERE
// (`>= 0.96` drops the one 0.953 pair); `same_file` comes back as
// `"true"`/`"false"` (70 same-file, 21 cross-file). Only the score is
// filtered here: an older backend without `same_file` would drop every row
// under `r.same_file = false`, so `similar.ts` excludes same-file pairs by
// the flag and by the Nodes' own files, and re-checks the score. An unknown
// relationship type returns `rows: 0`, so a backend without `SIMILAR_TO`
// simply yields none. Exported for tests.
export const SIMILAR_TO_QUERY = `MATCH (a:Function)-[r:SIMILAR_TO]->(b:Function) WHERE r.jaccard >= ${SIMILAR_TO_MIN_JACCARD} AND a.qualified_name IS NOT NULL AND b.qualified_name IS NOT NULL RETURN a.qualified_name AS source, b.qualified_name AS target, r.jaccard AS jaccard, r.same_file AS sameFile`;

/**
 * P4-2 phase 2: each evidence query's own bound, independent of the whole
 * fetch's `DEFAULT_TIMEOUT_MS`: evidence is a detail row, so a hung query
 * must give up long before it could threaten the map itself.
 */
export const EVIDENCE_TIMEOUT_MS = 30 * 1000;

/**
 * `query_graph`'s documented hard row ceiling ("a hard 100k row ceiling" in
 * its own tool description). A result that reaches it may be cut short.
 */
const QUERY_GRAPH_ROW_CEILING = 100_000;

/**
 * Connects to `codebase-memory-mcp` over stdio and runs the Code Map's two
 * `query_graph` Cypher calls against `project` (the backend's own project
 * identifier — see `IndexRepositoryResult.project`'s doc comment, this is
 * NOT the filesystem repo path). Ephemeral connection, same lifecycle as
 * `indexRepository`: always torn down (success, failure, or timeout) before
 * this function returns, never leaking a dangling backend process.
 *
 * Throws on any failure (backend fails to spawn, the MCP handshake fails,
 * either `query_graph` call rejects or reports `isError`, or the combined
 * call exceeds `timeoutMs`) — the caller (`index.ts`) surfaces that as an
 * explicit error state (matrix: "Map data fetch fails"), never a blank/
 * crashed map. A malformed *individual row* is dropped rather than failing
 * the whole fetch (see `parseCodeMapNodeRow`/`parseCodeMapEdgeRow`) — one
 * bad row shouldn't blank the entire map when the rest parsed fine.
 */
export async function fetchCodeMap(
  project: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  options: FetchCodeMapOptions = {},
): Promise<CodeMapFetchResult> {
  const { command, args } = resolveBackendCommand();
  const transport = new StdioClientTransport({ command, args, env: cbmEnvironment() });
  const client = new Client(CLIENT_INFO);

  try {
    return await withTimeout(
      runFetchCodeMap(client, transport, project, options, timeoutMs),
      timeoutMs,
      `query_graph (${project})`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/** Options for `fetchCodeMap`. */
export interface FetchCodeMapOptions {
  /**
   * P4-2 phase 1: files (as the backend reports them) whose
   * `CODE_MAP_FILES_QUERY` row is dropped before the hotspot join, so test
   * files never feed the per-file hotspot population.
   */
  excludeFile?: (file: string) => boolean;
  /**
   * P4-2 phase 2: also fetch test-link evidence (`TEST_EVIDENCE_*_QUERY`)
   * over the same connection. Best-effort: a failed evidence query is logged
   * and leaves that part empty, never failing the map.
   */
  includeTestEvidence?: boolean;
  /**
   * P4-2 phase 3b: also fetch `IMPLEMENTS_QUERY` over the same connection.
   * Best-effort, like test evidence: a failure leaves it empty.
   */
  includeImplements?: boolean;
  /**
   * P4-2 phase 4: also fetch `SIMILAR_TO_QUERY` over the same connection.
   * Best-effort, like test evidence: a failure leaves it empty.
   */
  includeSimilar?: boolean;
}

async function runFetchCodeMap(
  client: Client,
  transport: StdioClientTransport,
  project: string,
  options: FetchCodeMapOptions,
  timeoutMs: number,
): Promise<CodeMapFetchResult> {
  await connectBackend(client, transport, BACKEND_CONNECT_TIMEOUT_MS);
  return runCodeMapQueries(client, project, options, EVIDENCE_TIMEOUT_MS, timeoutMs);
}

/** The one method of the MCP `Client` the Code Map queries use — a seam, so tests can drive them with a stub. */
export type QueryGraphClient = Pick<Client, 'callTool'>;

/**
 * Runs the Code Map's `query_graph` calls over an already-connected client:
 * nodes, edges and files (any failure throws), then — only as asked — the
 * best-effort evidence queries, in parallel, each under its own timeout:
 * test evidence (two queries), `IMPLEMENTS` (P4-2 phase 3b) and
 * `SIMILAR_TO` (P4-2 phase 4). Exported for tests; `evidenceTimeoutMs` is a
 * test seam too. FIX-6: `requestTimeoutMs` is the fetch's own budget, given
 * to the SDK for the three map queries (see `requestOptions`).
 */
export async function runCodeMapQueries(
  client: QueryGraphClient,
  project: string,
  options: FetchCodeMapOptions,
  evidenceTimeoutMs: number = EVIDENCE_TIMEOUT_MS,
  requestTimeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<CodeMapFetchResult> {
  const nodesResult = await client.callTool({
    name: 'query_graph',
    arguments: { project, query: CODE_MAP_NODES_QUERY },
  }, requestOptions(requestTimeoutMs));
  if (nodesResult.isError) {
    throw new Error(`query_graph (Code Map nodes) reported an error: ${extractErrorText(nodesResult)}`);
  }
  const nodes = parseCodeMapRows(nodesResult, parseCodeMapNodeRow, 'Code Map nodes');

  const edgesResult = await client.callTool({
    name: 'query_graph',
    arguments: { project, query: CODE_MAP_EDGES_QUERY },
  }, requestOptions(requestTimeoutMs));
  if (edgesResult.isError) {
    throw new Error(`query_graph (Code Map edges) reported an error: ${extractErrorText(edgesResult)}`);
  }
  const edges = parseCodeMapRows(edgesResult, parseCodeMapEdgeRow, 'Code Map edges');

  // Story 2.1 (Phase 1), review round: hotspot data fetched as its own
  // third `query_graph` call (see `CODE_MAP_FILES_QUERY`'s comment) and
  // joined onto `nodes` here in TypeScript by `file_path` — never a same-
  // query Cypher join, which this engine can't evaluate. A File this query
  // doesn't return (e.g. no git history) simply leaves every Node in that
  // file without a `hotspotChangeCount` — never an error, matches this
  // query's own "malformed/absent row is dropped" discipline.
  const filesResult = await client.callTool({
    name: 'query_graph',
    arguments: { project, query: CODE_MAP_FILES_QUERY },
  }, requestOptions(requestTimeoutMs));
  if (filesResult.isError) {
    throw new Error(`query_graph (Code Map files) reported an error: ${extractErrorText(filesResult)}`);
  }
  const fileRows = parseCodeMapRows(filesResult, parseCodeMapFileRow, 'Code Map files');
  const joinedNodes = joinHotspotChangeCounts(nodes, fileRows, options.excludeFile);
  const includeTestEvidence = options.includeTestEvidence === true;
  const includeImplements = options.includeImplements === true;
  const includeSimilar = options.includeSimilar === true;
  if (!includeTestEvidence && !includeImplements && !includeSimilar) {
    return { nodes: joinedNodes, edges };
  }
  const [calls, testFiles, implementsLinks, similarPairs] = await Promise.all([
    includeTestEvidence
      ? queryTestEvidence(client, project, TEST_EVIDENCE_CALLS_QUERY, parseTestCallEvidenceRow, 'test calls', evidenceTimeoutMs)
      : undefined,
    includeTestEvidence
      ? queryTestEvidence(client, project, TEST_EVIDENCE_FILES_QUERY, parseTestFileEvidenceRow, 'test files', evidenceTimeoutMs)
      : undefined,
    includeImplements
      ? queryTestEvidence(client, project, IMPLEMENTS_QUERY, parseImplementsRow, 'implements', evidenceTimeoutMs, 'Implements')
      : undefined,
    includeSimilar
      ? queryTestEvidence(
          client,
          project,
          SIMILAR_TO_QUERY,
          parseSimilarPairRow,
          'SIMILAR_TO',
          evidenceTimeoutMs,
          'Similar implementations',
        )
      : undefined,
  ]);
  return {
    nodes: joinedNodes,
    edges,
    ...(calls !== undefined && testFiles !== undefined ? { testEvidence: { calls, testFiles } } : {}),
    ...(implementsLinks !== undefined ? { implementsLinks } : {}),
    ...(similarPairs !== undefined ? { similarPairs } : {}),
  };
}

/**
 * P4-2 phase 4: parses a `SIMILAR_TO_QUERY` row. A row without both ids or
 * without a finite, non-negative score is dropped; the score is not checked
 * against the threshold here (`attachSimilar` does). Exported for tests.
 */
export function parseSimilarPairRow(row: Record<string, string>): SimilarPair | undefined {
  const { source, target } = row;
  const score = toOptionalSignalValue(row.jaccard);
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    typeof target !== 'string' ||
    target.length === 0 ||
    score === undefined
  ) {
    return undefined;
  }
  return { source, target, score, ...(parseTestFlag(row.sameFile) ? { sameFile: true as const } : {}) };
}

/** P4-2 phase 3b: parses an `IMPLEMENTS_QUERY` row. Exported for tests. */
export function parseImplementsRow(row: Record<string, string>): ImplementsLink | undefined {
  const { source, target } = row;
  if (typeof source !== 'string' || source.length === 0 || typeof target !== 'string' || target.length === 0) {
    return undefined;
  }
  return { source, target };
}

/**
 * P4-2 phase 2: runs one evidence query under its own `timeoutMs`. Never
 * throws: evidence is a detail row, so an error or a timeout logs one
 * warning and yields no rows for this part, and the map still returns. The
 * UI's wording ("No test link found") stays true either way. A result that
 * may be cut short (see `queryGraphTruncation`) is used as-is, with a
 * warning.
 */
async function queryTestEvidence<T>(
  client: QueryGraphClient,
  project: string,
  query: string,
  parseRow: (row: Record<string, string>) => T | undefined,
  label: string,
  timeoutMs: number,
  // P4-2 phase 3b: the detail row this evidence feeds, for log lines.
  section = 'Tested by',
): Promise<T[]> {
  try {
    // `withTimeout` clears its timer as soon as the call settles, and a timed-out
    // call leaves no timer behind, so nothing here keeps the process alive.
    const result = await withTimeout(
      client.callTool({ name: 'query_graph', arguments: { project, query } }, requestOptions(timeoutMs)),
      timeoutMs,
      `query_graph (${section} ${label})`,
    );
    if (result.isError) {
      throw new Error(extractErrorText(result));
    }
    const rows = parseCodeMapRows(result, parseRow, `${section} (${label})`);
    const text = extractQueryGraphText(result);
    const truncation = text !== undefined ? queryGraphTruncation(text) : undefined;
    if (truncation !== undefined) {
      console.warn(`[graph-service] ${section} (${label}) evidence may be incomplete: ${truncation}`);
    }
    return rows;
  } catch (error) {
    console.warn(
      `[graph-service] ${section} (${label}) evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * P4-2 phase 2: why a `query_graph` text result may be cut short, or
 * `undefined` when nothing says so. `query_graph` has no offset or cursor
 * (its tool description: "No offset support"), so the signals are: a
 * `total:` above the header's `rows:`, a row count at the documented
 * 100k ceiling, or an explicit `has_more`/`truncated`/cursor marker should
 * a future backend build add one. Pure; exported for tests.
 */
export function queryGraphTruncation(text: string): string | undefined {
  const rows = /^rows:\s*(\d+)/m.exec(text);
  const total = /^total:\s*(\d+)/m.exec(text);
  const rowCount = rows?.[1] !== undefined ? Number(rows[1]) : undefined;
  const totalCount = total?.[1] !== undefined ? Number(total[1]) : undefined;
  if (rowCount !== undefined && totalCount !== undefined && totalCount > rowCount) {
    return `${rowCount} of ${totalCount} rows returned`;
  }
  if (rowCount !== undefined && rowCount >= QUERY_GRAPH_ROW_CEILING) {
    return `${rowCount} rows, at query_graph's ${QUERY_GRAPH_ROW_CEILING}-row ceiling`;
  }
  if (/\b(has_more|truncated)\b["']?\s*[:=]\s*["']?true\b|\bnext_?cursor\b/i.test(text)) {
    return 'the backend reported more rows than it returned';
  }
  return undefined;
}

/**
 * P4-2 phase 2: parses a `TEST_EVIDENCE_CALLS_QUERY` row. The strategy and
 * confidence are kept, not trusted: `attachTestedBy` re-checks both, so a
 * backend that ignored the WHERE could still never admit a name-only edge.
 * Exported for tests.
 */
export function parseTestCallEvidenceRow(row: Record<string, string>): TestCallEvidence | undefined {
  const { source, sourceName, sourceFile, sourceKind, target, strategy } = row;
  const sourceStartLine = toLineNumber(row.sourceStartLine);
  const sourceEndLine = toLineNumber(row.sourceEndLine);
  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    typeof sourceName !== 'string' ||
    typeof sourceFile !== 'string' ||
    sourceFile.length === 0 ||
    sourceStartLine === undefined ||
    sourceEndLine === undefined ||
    (sourceKind !== 'Function' && sourceKind !== 'Method' && sourceKind !== 'Module') ||
    typeof target !== 'string' ||
    target.length === 0 ||
    typeof strategy !== 'string' ||
    strategy.length === 0
  ) {
    return undefined;
  }
  const confidence = toOptionalSignalValue(row.confidence);
  const line = toLineNumber(row.line);
  return {
    source,
    sourceName,
    sourceFile,
    sourceStartLine,
    sourceEndLine,
    sourceKind,
    ...(parseTestFlag(row.sourceIsTest) ? { sourceIsTest: true } : {}),
    target,
    strategy,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

/** P4-2 phase 2: parses a `TEST_EVIDENCE_FILES_QUERY` row. Exported for tests. */
export function parseTestFileEvidenceRow(row: Record<string, string>): TestFileEvidence | undefined {
  const { testFile, file } = row;
  if (typeof testFile !== 'string' || testFile.length === 0 || typeof file !== 'string' || file.length === 0) {
    return undefined;
  }
  return { testFile, file };
}

/**
 * Joins each File row's `changeCount` onto the Nodes in that file, by the
 * backend's own `file` string. P4-2 phase 1: rows `excludeFile` rejects are
 * dropped first, so an excluded (test) file never contributes a hotspot
 * value. Pure; exported for tests.
 */
export function joinHotspotChangeCounts<TNode extends { file: string }>(
  nodes: readonly TNode[],
  fileRows: readonly { file: string; changeCount?: number }[],
  excludeFile?: (file: string) => boolean,
): (TNode & { hotspotChangeCount: number | undefined })[] {
  const hotspotChangeCountByFile = new Map<string, number>();
  for (const row of fileRows) {
    if (row.changeCount !== undefined && !excludeFile?.(row.file)) {
      hotspotChangeCountByFile.set(row.file, row.changeCount);
    }
  }
  return nodes.map((node) => ({
    ...node,
    hotspotChangeCount: hotspotChangeCountByFile.get(node.file),
  }));
}

/**
 * Extracts `query_graph`'s rows from a `CallToolResult` and hands each one
 * (as a `{columnName: string}` record) to `parseRow`. Live-verified against
 * a real codebase-memory-mcp instance (this story's verification pass):
 * `query_graph` carries NO `structuredContent` and NO JSON at all — its only
 * payload is a plain-text table in the first `content` text block:
 *
 *   rows: N  (cols: col1 col2 ...)
 *     <row 1 tokens, space-separated>
 *     ...
 *     <row N tokens>
 *   total: N
 *   hint: "..."            (only ever seen when N is 0)
 *
 * This is a genuinely different shape from `index_repository`/`index_status`
 * (both real JSON, handled above by `extractFromCallResult`) — a distinct
 * tool with a human-readable-table response convention, not an
 * inconsistency in this file's parsing. `parseQueryGraphRows` is the primary
 * path; `extractFromCallResult`'s JSON-based extraction is kept as a
 * fallback purely in case a future backend build ever does emit structured
 * JSON for this tool, but every real response seen returns to
 * `parseQueryGraphRows` below.
 *
 * Throws only when the header itself can't be found/parsed — an empty
 * `rows: 0 (...)` result is a legitimate "no map-eligible nodes/edges"
 * result (matrix: "Indexed project has zero map-eligible nodes"), not a
 * parse failure. A malformed *individual row* (wrong token count, or one
 * `parseRow` rejects) is dropped with a warning rather than failing the
 * whole fetch.
 */
function parseCodeMapRows<T>(
  result: unknown,
  parseRow: (row: Record<string, string>) => T | undefined,
  label: string,
): T[] {
  const text = extractQueryGraphText(result);
  const rawRows =
    text !== undefined
      ? parseQueryGraphRows(text, label)
      : extractFromCallResult(result, extractJsonRowList)?.map(coerceToStringRecord);
  if (rawRows === undefined) {
    throw new Error(`query_graph (${label}) did not return a recognizable row list.`);
  }

  const parsed: T[] = [];
  for (const row of rawRows) {
    const item = parseRow(row);
    if (item === undefined) {
      console.warn(
        `[graph-service] ${label}: dropped a row with an unrecognized shape: ${JSON.stringify(row)}`,
      );
      continue;
    }
    parsed.push(item);
  }
  return parsed;
}

/** Returns the first text content block's raw text, if any. */
function extractQueryGraphText(result: unknown): string | undefined {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const textBlock = content.find(
    (block) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  ) as { text: string } | undefined;
  return textBlock?.text;
}

/**
 * Parses `query_graph`'s real plain-text table format (see
 * `parseCodeMapRows`'s doc comment) into `{columnName: string}` records —
 * every value is still a string at this point (numeric columns come back
 * quoted, e.g. `"94"`; `parseCodeMapNodeRow`/`parseCodeMapEdgeRow` are what
 * convert/validate per-field). Reads exactly the `rows: N` header's `N`
 * lines that follow it, rather than trying to distinguish data rows from
 * the trailing `total:`/`hint:` lines by shape — those lines are simply
 * never reached when `N` data lines have already been consumed.
 */
export function parseQueryGraphRows(text: string, label: string): Record<string, string>[] {
  const lines = text.split(/\r\n|\r|\n/);
  const headerIndex = lines.findIndex((line) => /^rows:\s*\d+\s*\(cols:/.test(line));
  const headerLine = headerIndex >= 0 ? lines[headerIndex] : undefined;
  const headerMatch = headerLine !== undefined ? /^rows:\s*(\d+)\s*\(cols:\s*([^)]*)\)/.exec(headerLine) : null;
  const rowCountText = headerMatch?.[1];
  const colsText = headerMatch?.[2];
  if (rowCountText === undefined || colsText === undefined) {
    throw new Error(
      `query_graph (${label}) response did not match the expected "rows: N (cols: ...)" header: ${JSON.stringify(text)}`,
    );
  }

  const rowCount = Number(rowCountText);
  const columns = colsText.trim().length > 0 ? colsText.trim().split(/\s+/) : [];

  const rows: Record<string, string>[] = [];
  for (let i = 0; i < rowCount; i++) {
    const line = lines[headerIndex + 1 + i];
    if (line === undefined) {
      console.warn(
        `[graph-service] ${label}: header claimed ${rowCount} rows but only ${i} line(s) followed.`,
      );
      break;
    }
    const tokens = tokenizeQueryGraphRowLine(line.trim());
    if (tokens.length !== columns.length) {
      console.warn(
        `[graph-service] ${label}: dropped a row with ${tokens.length} token(s), expected ${columns.length}: ${JSON.stringify(line)}`,
      );
      continue;
    }
    const row: Record<string, string> = {};
    columns.forEach((col, idx) => {
      // `tokens.length === columns.length` was just checked above, so this
      // index is always in range.
      row[col] = tokens[idx] as string;
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Splits one already-trimmed row line into its space-separated column
 * values. A `"..."` run is a JSON-string-literal-quoted value — decoded via
 * `JSON.parse` on just that run, which is how numeric (`"94"`) and
 * array-shaped values round-trip through this text format; anything else is
 * a bare run of non-space characters used as-is (identifiers/paths/edge
 * kinds never contain internal spaces in this graph's data model). A plain
 * `line.split(/\s+/)` would break if a quoted value ever contained an
 * internal space — this doesn't assume it can't.
 */
function tokenizeQueryGraphRowLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line.charAt(i) === ' ') {
      i++;
    }
    if (i >= line.length) {
      break;
    }
    if (line.charAt(i) === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line.charAt(j) === '\\' && j + 1 < line.length) {
          j += 2;
          continue;
        }
        if (line.charAt(j) === '"') {
          j++;
          break;
        }
        j++;
      }
      const raw = line.slice(i, j);
      try {
        const decoded: unknown = JSON.parse(raw);
        tokens.push(typeof decoded === 'string' ? decoded : raw);
      } catch {
        tokens.push(raw);
      }
      i = j;
    } else {
      let j = i;
      while (j < line.length && line.charAt(j) !== ' ') {
        j++;
      }
      tokens.push(line.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

/** Fallback-path helper: coerces a JSON row object's values to strings, matching `parseQueryGraphRows`'s output shape. */
function coerceToStringRecord(row: unknown): Record<string, string> {
  if (!row || typeof row !== 'object') {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Fallback-only JSON row-list extractor (see `parseCodeMapRows`'s doc
 * comment) — never observed live, kept only in case a future backend build
 * emits structured JSON for `query_graph` the way it already does for
 * `index_repository`/`index_status`.
 */
function extractJsonRowList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  for (const key of ['rows', 'results', 'records', 'data']) {
    if (Array.isArray(v[key])) {
      return v[key] as unknown[];
    }
  }
  return undefined;
}

/**
 * Live-verified: the backend's `query_graph` returns `start_line`/
 * `end_line` (here aliased `startLine`/`endLine`) as numeric-looking
 * strings, not numbers — this parses either shape. Anything else (missing,
 * non-numeric, non-finite) fails the row.
 *
 * Line numbers are 1-indexed, so `0` is rejected here too, not just
 * negatives (review finding): `0` used to pass the shared
 * `isFiniteNonNegative` helper's `>= 0` check, parsing fine at this layer
 * while `handleReadSourceRange`'s own `startLine < 1` guard rejected it
 * downstream — a Node that parsed successfully here but could never open
 * its source, failing later with a generic, unhelpful error instead of
 * being dropped now like any other malformed row.
 */
function toLineNumber(value: unknown): number | undefined {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    parsed = Number(value);
  }
  return parsed !== undefined && isFiniteNonNegative(parsed) && parsed >= 1 ? parsed : undefined;
}

/**
 * Story 2.1 (Phase 1): parses one of the extended query's FR7 signal-source
 * columns (`complexity`/`cognitive`/`hotspotChangeCount`) — unlike
 * `toLineNumber`, these are never required: a present-but-unparseable value
 * (missing, non-numeric, negative, non-finite) is dropped for that
 * Node/signal only (Boundaries & Constraints — "never crashes the row"),
 * distinct from a bad `startLine`/`endLine`, which drops the whole row.
 * Same numeric-looking-string tolerance as `toLineNumber` (this engine's
 * `query_graph` returns numeric columns as quoted strings).
 */
function toOptionalSignalValue(value: unknown): number | undefined {
  let parsed: number | undefined;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    parsed = Number(value);
  }
  return parsed !== undefined && isFiniteNonNegative(parsed) ? parsed : undefined;
}

export function parseCodeMapNodeRow(row: Record<string, string>): CodeMapNodeWithSignalSources | undefined {
  const { id, name, file, kind } = row;
  const startLine = toLineNumber(row.startLine);
  const endLine = toLineNumber(row.endLine);

  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof name !== 'string' ||
    typeof file !== 'string' ||
    startLine === undefined ||
    endLine === undefined ||
    typeof kind !== 'string' ||
    !CODE_MAP_NODE_KINDS.includes(kind as CodeMapNodeKind)
  ) {
    return undefined;
  }

  // `summaryStatus` is a placeholder here (Story 1.5 Phase 2) — this module
  // only ever sources structural graph data from the backend, which has no
  // concept of summaries. `index.ts`'s `handleGetCodeMapRequest` always
  // re-derives the real per-Node status (coverage-gap/ready/pending) from
  // the coverage-gap set and the Node record store before this ever reaches
  // main/the renderer — see `annotateNodesWithSummaryState` in
  // `summary-generator.ts`. `riskSignals: []` is the equivalent placeholder
  // for Story 2.1 (Phase 1) — see `CodeMapNodeWithSignalSources`'s doc
  // comment. `hotspotChangeCount` is not set here — it's not one of this
  // query's own columns (review round: see `CODE_MAP_FILES_QUERY`'s
  // comment) — `runFetchCodeMap` joins it on afterward by `file`.
  return {
    id,
    name,
    file,
    startLine,
    endLine,
    kind: kind as CodeMapNodeKind,
    summaryStatus: 'pending',
    riskSignals: [],
    complexity: toOptionalSignalValue(row.complexity),
    cognitiveComplexity: toOptionalSignalValue(row.cognitive),
    ...(parseTestFlag(row.isTest) ? { isTest: true } : {}),
  };
}

/**
 * P4-2 phase 1: reads the `isTest` column (`n.is_test`). `true`, `"true"`
 * (any case) and `1` are true; anything else — `false`, `-` (the backend's
 * absent-property marker), empty, missing — is false, i.e. absent.
 */
export function parseTestFlag(value: unknown): boolean {
  if (value === true || value === 1) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function parseCodeMapEdgeRow(row: Record<string, string>): CodeMapEdge | undefined {
  const { source, target, kind } = row;

  if (
    typeof source !== 'string' ||
    source.length === 0 ||
    typeof target !== 'string' ||
    target.length === 0 ||
    typeof kind !== 'string' ||
    !CODE_MAP_EDGE_KINDS.includes(kind as CodeMapEdgeKind)
  ) {
    return undefined;
  }

  return { source, target, kind: kind as CodeMapEdgeKind };
}

/**
 * Story 2.1 (Phase 1), review round: parses `CODE_MAP_FILES_QUERY`'s rows —
 * `file` is required (an unnamed file is useless for the join), `changeCount`
 * is optional (a File with no recorded git history reports none) via the
 * same tolerant `toOptionalSignalValue` every other FR7 signal column uses.
 */
function parseCodeMapFileRow(row: Record<string, string>): { file: string; changeCount?: number } | undefined {
  const { file } = row;
  if (typeof file !== 'string' || file.length === 0) {
    return undefined;
  }
  return { file, changeCount: toOptionalSignalValue(row.changeCount) };
}

/**
 * Best-effort follow-up: calls `index_status({project})` on the same
 * still-open connection to get the actual gap file *paths* (Design Notes —
 * `index_repository`'s own response already carries the aggregate coverage
 * signal, but only `index_status` returns `parse_partial.files`/
 * `skipped.files`).
 *
 * Per the Always constraint, this step's failure (rejects, times out, or
 * returns a shape that doesn't parse) never turns an already-successful
 * `index_repository` result into an `error` — it returns `undefined` and
 * the caller simply omits `coverage` from the posted `indexed` message. The
 * `index_status` call below has its own short `INDEX_STATUS_TIMEOUT_MS`,
 * independent of the outer `indexRepository` timeout (review round 2, High)
 * — a hung follow-up call must degrade to `coverage: undefined`, never
 * threaten the already-successful outer result.
 *
 * The gate below requires only `project` + `skippedCount` +
 * `parsePartialCount` — NOT `expectedNodes`/`expectedEdges`. Live testing
 * (this story's verification pass) found the backend's MCP
 * `index_repository` response intermittently omits `expected_nodes`/
 * `expected_edges` even on an otherwise-healthy call, while
 * `skipped_count`/`parse_partial_count` (the fields that actually determine
 * whether there's a genuine gap) are always present. Gating on all four
 * fields made `coverage` — including the "full coverage" case — vanish on
 * healthy runs, which worked against the Always constraint's intent (an
 * honest, backend-sourced signal that's never silently hidden).
 * `expectedNodes`/`expectedEdges` are still carried through when the
 * backend happens to include them (optional enrichment on
 * `IndexCoverageSummary`), just never required.
 */
async function fetchCoverage(
  client: Client,
  fields: IndexRepositoryFields,
): Promise<IndexCoverageSummary | undefined> {
  const { project, expectedNodes, expectedEdges, skippedCount, parsePartialCount } = fields;
  if (project === undefined || skippedCount === undefined || parsePartialCount === undefined) {
    // The backend didn't report even the minimal gap-detection fields on
    // this call. This is a routine, expected condition (e.g. an older
    // backend build) — not a call failure — so it's a `warn`, not an
    // `error` (review round 2, Low; `error` is reserved for the two actual
    // call-failure branches below). Coverage is sourced from the backend's
    // own reporting only, never inferred locally. Logged (local-only;
    // matches the matrix's "Error Handling: Logged, not surfaced as an
    // index failure"), never thrown — the caller still posts `indexed` with
    // `coverage` simply omitted.
    console.warn(
      '[graph-service] coverage summary skipped: index_repository response did not include the minimal coverage fields (project/skipped_count/parse_partial_count).',
    );
    return undefined;
  }

  let statusResult: unknown;
  try {
    statusResult = await withTimeout(
      client.callTool({ name: 'index_status', arguments: { project } }, requestOptions(INDEX_STATUS_TIMEOUT_MS)),
      INDEX_STATUS_TIMEOUT_MS,
      `index_status(${project})`,
    );
  } catch (error) {
    console.error(
      `[graph-service] coverage summary skipped: index_status(${project}) follow-up call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (!statusResult || (statusResult as { isError?: unknown }).isError) {
    console.error(
      `[graph-service] coverage summary skipped: index_status(${project}) reported an error: ${extractErrorText(statusResult)}`,
    );
    return undefined;
  }

  const gapPaths = parseIndexStatusResult(statusResult);
  if (!gapPaths) {
    console.error(
      `[graph-service] coverage summary skipped: index_status(${project}) response did not parse into a recognizable {parse_partial, skipped} shape.`,
    );
    return undefined;
  }

  return { expectedNodes, expectedEdges, skippedCount, parsePartialCount, gapPaths };
}

/** FIX-6: `indexRepository`'s test seams. */
export interface IndexRepositoryOptions {
  /** The backend to spawn instead of `codebase-memory-mcp` (a stub, in tests). */
  backend?: { command: string; args: string[] };
  /** The handshake bound; `BACKEND_CONNECT_TIMEOUT_MS` when omitted. */
  connectTimeoutMs?: number;
}

/**
 * FIX-6: echoes the backend's stderr to this process's stderr (what the
 * inherited stream used to do) and keeps a bounded tail of it.
 * `lastLine()` is the last non-empty line that isn't a routine
 * `level=info`/`level=debug` log line — for CBM, its one-line explanation
 * of why it stopped — or `undefined`.
 */
export function captureBackendStderr(stream: Pick<NodeJS.EventEmitter, 'on'> | null): { lastLine: () => string | undefined } {
  let tail = '';
  stream?.on('data', (chunk: Buffer | string) => {
    process.stderr.write(chunk);
    tail = (tail + String(chunk)).slice(-BACKEND_STDERR_TAIL_CHARS);
  });
  // A stream error here must never crash the Graph Service; the call's own outcome reports the failure.
  stream?.on('error', () => {});
  return {
    lastLine: () =>
      tail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^level=(info|debug)\b/.test(line))
        .at(-1),
  };
}

/**
 * FIX-6: `error` with the backend's own last word appended — "…: Connection
 * closed — codebase-memory-mcp said: CBM could not start because …". Kept
 * as is when the backend said nothing, or when the message already has it.
 */
export function withBackendExplanation(error: unknown, backendLine: string | undefined): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (backendLine === undefined) return base;
  const said = backendLine.replace(/^codebase-memory-mcp:\s*/, '');
  if (base.message.includes(said)) return base;
  return new Error(`${base.message} — codebase-memory-mcp said: ${said}`, { cause: base });
}

/**
 * Races `promise` against a timeout, rejecting with a descriptive error if
 * `ms` elapses first. This does not (and per the MCP transport, cannot)
 * cancel the underlying call — `promise` keeps running in the background —
 * it only stops the caller from waiting on it forever.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Raw fields parsed off the `index_repository` response, before the
 * coverage-aggregate ones are known to be present. `project`/`expected*`/
 * `*Count` are optional here because a backend that only returns
 * `{nodes, edges}` (or an older version) must still let indexing succeed —
 * `fetchCoverage` is what decides whether there's enough to build a
 * `coverage` summary from.
 */
interface IndexRepositoryFields {
  nodes: number;
  edges: number;
  project?: string;
  expectedNodes?: number;
  expectedEdges?: number;
  skippedCount?: number;
  parsePartialCount?: number;
}

/**
 * Extracts a value out of a `CallToolResult` via `extractor`. The live
 * backend may return its payload as `structuredContent` (the modern MCP
 * shape) or as a JSON string in the first text content block (the common
 * fallback shape) — this checks both rather than assuming one, for both the
 * `index_repository` and `index_status` responses.
 */
function extractFromCallResult<T>(
  result: unknown,
  extractor: (value: unknown) => T | undefined,
): T | undefined {
  const structured = extractor(
    (result as { structuredContent?: unknown } | null | undefined)?.structuredContent,
  );
  if (structured !== undefined) {
    return structured;
  }

  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        const parsed = tryParseJson((block as { text: string }).text);
        const extracted = extractor(parsed);
        if (extracted !== undefined) {
          return extracted;
        }
      }
    }
  }

  return undefined;
}

/**
 * Parses `index_repository`'s response into `{nodes, edges}` (required) plus
 * whatever coverage-aggregate fields (`project`, `expected_nodes`,
 * `expected_edges`, `skipped_count`, `parse_partial_count`) it also reports.
 * Throws only when `nodes`/`edges` themselves can't be found — the
 * coverage-aggregate fields are best-effort within this same parse.
 */
function parseIndexResult(result: unknown): IndexRepositoryFields {
  const fields = extractFromCallResult(result, extractIndexFields);
  if (!fields) {
    throw new Error(
      'index_repository did not return recognizable {nodes, edges} counts.',
    );
  }
  return fields;
}

/**
 * True for a value that's a genuinely usable count: a `number`, finite (not
 * `NaN`/`Infinity`), and non-negative. Backend-supplied numeric fields are
 * untrusted input over an MCP/JSON boundary — a malformed or adversarial
 * response could otherwise smuggle a `NaN`/negative/`Infinity` value all the
 * way into the posted `indexed` message and the rendered UI (review round 2,
 * Medium).
 */
function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function extractIndexFields(value: unknown): IndexRepositoryFields | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const { nodes, edges } = v;
  if (typeof nodes !== 'number' || typeof edges !== 'number') {
    return undefined;
  }
  return {
    nodes,
    edges,
    project: typeof v.project === 'string' ? v.project : undefined,
    expectedNodes: isFiniteNonNegative(v.expected_nodes) ? v.expected_nodes : undefined,
    expectedEdges: isFiniteNonNegative(v.expected_edges) ? v.expected_edges : undefined,
    skippedCount: isFiniteNonNegative(v.skipped_count) ? v.skipped_count : undefined,
    parsePartialCount: isFiniteNonNegative(v.parse_partial_count)
      ? v.parse_partial_count
      : undefined,
    // `not_indexed_files_count` is deliberately never read here: by-design
    // gitignore/skip-list exclusions MUST NOT be surfaced as a coverage gap.
  };
}

/**
 * Parses `index_status(project)`'s response into the combined list of
 * genuine coverage-gap files: `parse_partial.files` plus `skipped.files`
 * (never `not_indexed`, which is by-design and not a gap), each tagged with
 * its `kind` — `skipped` and `parse_partial` are meaningfully different
 * severities (Story 1.3's per-Node rendering is expected to show them
 * differently), so this preserves the distinction rather than flattening
 * both into an undifferentiated path list (review round 2, Medium). Returns
 * `undefined` only when the result itself doesn't parse as an object at
 * all — a response that parses but is missing one or both sections is
 * treated as reporting zero gaps for that section, not as a parse failure.
 */
function parseIndexStatusResult(result: unknown): GapFile[] | undefined {
  const info = extractFromCallResult(result, extractGapInfo);
  return info?.gapPaths;
}

function extractGapInfo(value: unknown): { gapPaths: GapFile[] } | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  return {
    gapPaths: [
      ...extractFileList(v.parse_partial, 'parse_partial'),
      ...extractFileList(v.skipped, 'skipped'),
    ],
  };
}

/**
 * Extracts a section's `files` list as `{path, kind}` entries. Per the Code
 * Map's live-verified contract, each entry may be a plain path string or a
 * `{path, ...}` object — handled defensively, matching this module's
 * existing dual-shape parsing elsewhere. Missing/malformed input yields an
 * empty list rather than throwing, since an absent section legitimately
 * means "no gaps of this kind" as often as it means "unexpected shape."
 *
 * A malformed individual entry (neither a plain string nor a `{path: string,
 * ...}` object) is dropped, but logged via `console.warn` (review round 2,
 * Low) rather than silently — otherwise `gapPaths.length` could quietly
 * disagree with the reported `skippedCount`/`parsePartialCount` with no
 * signal as to why.
 */
function extractFileList(section: unknown, kind: GapFile['kind']): GapFile[] {
  if (!section || typeof section !== 'object') {
    return [];
  }
  const { files } = section as { files?: unknown };
  if (!Array.isArray(files)) {
    return [];
  }
  const gapFiles: GapFile[] = [];
  for (const entry of files) {
    if (typeof entry === 'string') {
      gapFiles.push({ path: entry, kind });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
      gapFiles.push({ path: (entry as { path: string }).path, kind });
      continue;
    }
    console.warn(
      `[graph-service] coverage gap entry skipped: unrecognized shape in "${kind}" files list (expected a string or {path: string}): ${JSON.stringify(entry)}`,
    );
  }
  return gapFiles;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractErrorText(result: unknown): string {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block) =>
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    ) as { text: string } | undefined;
    if (textBlock) {
      return textBlock.text;
    }
  }
  return 'no error detail provided';
}
