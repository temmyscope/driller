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
): Promise<IndexRepositoryResult> {
  const { command, args } = resolveBackendCommand();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client(CLIENT_INFO);

  try {
    return await withTimeout(
      runIndex(client, transport, repoPath),
      timeoutMs,
      `index_repository (${repoPath})`,
    );
  } finally {
    // Best-effort: the transport's child process may already be gone (e.g.
    // it crashed before/during connect, or the call above timed out), in
    // which case close() rejecting is not itself an error worth surfacing
    // over the original failure/result.
    await client.close().catch(() => {});
  }
}

async function runIndex(
  client: Client,
  transport: StdioClientTransport,
  repoPath: string,
): Promise<IndexRepositoryResult> {
  await client.connect(transport);
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
  });

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
// File/Folder/Project/Branch (scaffolding). CALLS/IMPORTS/USAGE edges only —
// never DEFINES/CONTAINS_* containment edges (FR4 is call/dependency edges).
// ---------------------------------------------------------------------------

const CODE_MAP_NODE_KINDS: readonly CodeMapNodeKind[] = [
  'Function',
  'Interface',
  'Type',
  'Module',
];

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
const CODE_MAP_NODES_QUERY = `MATCH (n:Function|Interface|Type|Module) WHERE NOT n.file_path STARTS WITH '<' RETURN n.qualified_name AS id, n.name AS name, n.file_path AS file, n.start_line AS startLine, n.end_line AS endLine, CASE WHEN n:Function THEN 'Function' WHEN n:Interface THEN 'Interface' WHEN n:Type THEN 'Type' ELSE 'Module' END AS kind, n.complexity AS complexity, n.cognitive AS cognitive`;

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
const CODE_MAP_EDGES_QUERY = `MATCH (a:Function|Interface|Type|Module)-[r:CALLS|IMPORTS|USAGE]->(b:Function|Interface|Type|Module) WHERE a.qualified_name IS NOT NULL AND b.qualified_name IS NOT NULL RETURN a.qualified_name AS source, b.qualified_name AS target, type(r) AS kind`;

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
): Promise<CodeMapFetchResult> {
  const { command, args } = resolveBackendCommand();
  const transport = new StdioClientTransport({ command, args });
  const client = new Client(CLIENT_INFO);

  try {
    return await withTimeout(
      runFetchCodeMap(client, transport, project),
      timeoutMs,
      `query_graph (${project})`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

async function runFetchCodeMap(
  client: Client,
  transport: StdioClientTransport,
  project: string,
): Promise<CodeMapFetchResult> {
  await client.connect(transport);

  const nodesResult = await client.callTool({
    name: 'query_graph',
    arguments: { project, query: CODE_MAP_NODES_QUERY },
  });
  if (nodesResult.isError) {
    throw new Error(`query_graph (Code Map nodes) reported an error: ${extractErrorText(nodesResult)}`);
  }
  const nodes = parseCodeMapRows(nodesResult, parseCodeMapNodeRow, 'Code Map nodes');

  const edgesResult = await client.callTool({
    name: 'query_graph',
    arguments: { project, query: CODE_MAP_EDGES_QUERY },
  });
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
  });
  if (filesResult.isError) {
    throw new Error(`query_graph (Code Map files) reported an error: ${extractErrorText(filesResult)}`);
  }
  const fileRows = parseCodeMapRows(filesResult, parseCodeMapFileRow, 'Code Map files');
  const hotspotChangeCountByFile = new Map<string, number>();
  for (const row of fileRows) {
    if (row.changeCount !== undefined) {
      hotspotChangeCountByFile.set(row.file, row.changeCount);
    }
  }
  const nodesWithHotspot = nodes.map((node) => ({
    ...node,
    hotspotChangeCount: hotspotChangeCountByFile.get(node.file),
  }));

  return { nodes: nodesWithHotspot, edges };
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
function parseQueryGraphRows(text: string, label: string): Record<string, string>[] {
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

function parseCodeMapNodeRow(row: Record<string, string>): CodeMapNodeWithSignalSources | undefined {
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
  };
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
      client.callTool({ name: 'index_status', arguments: { project } }),
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
