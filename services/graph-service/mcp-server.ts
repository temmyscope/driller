/**
 * The Agent-Facing Query Surface (Epic 5, Story 5.1): a secured MCP server,
 * hosted inside this subprocess (AD-1's `utilityProcess.fork`), that lets
 * other agents/tools query driller's Code Map the same way the renderer
 * does. Phase 1 proved the transport/security baseline with one operation,
 * Node lookup. Phase 2 wires the remaining four operations onto that same
 * baseline — Path Trace (`trace_path`), Blast Radius expansion
 * (`expand_blast_radius`), diff-scoped Node-set computation
 * (`compute_diff_scope`), and coverage-check retrieval
 * (`get_coverage_summary`) — each a thin `registerTool` wrapper over its
 * already-exported, already-reviewed compute function from `index.ts`
 * (AD-13: defined once, never re-implemented for this surface). No changes
 * to Phase 1's transport/security middleware in this phase (Boundaries &
 * Constraints, spec-5-1-phase-2).
 *
 * Security model (Boundaries & Constraints, epic-5-context.md's Technical
 * Decisions):
 *  - Binds strictly to `127.0.0.1` — never `0.0.0.0`, never an externally
 *    reachable interface.
 *  - Every request is validated on two independent layers before it ever
 *    reaches `transport.handleRequest`: `Origin` (via `originValidationResponse`
 *    + `localhostAllowedOrigins()`) and, separately, `Host` (via
 *    `hostHeaderValidationResponse` + `localhostAllowedHostnames()`) —
 *    defense-in-depth against DNS-rebinding (CVE-2025-49596). Host validation
 *    is never skipped just because Origin already passed. Note: a request
 *    with NO `Origin` header at all passes that specific check by design
 *    (`validateOriginHeader`'s own doc comment — non-browser MCP clients
 *    typically don't send one); Origin validation defends specifically
 *    against a *browser*-originated cross-origin request reaching this
 *    server. For a same-machine, non-browser local process, it's Host
 *    validation plus the loopback bind — not Origin validation, and not any
 *    v1 auth (there is none) — that actually gates access.
 *  - Deliberately does NOT use `WebStandardStreamableHTTPServerTransportOptions`'s
 *    own `allowedOrigins`/`allowedHosts`/`enableDnsRebindingProtection`
 *    constructor options — each is marked `@deprecated` in the installed
 *    `@modelcontextprotocol/server@2.0.0` SDK's own type definitions ("Use
 *    external middleware instead"); the standalone validator functions above,
 *    called as middleware ahead of `handleRequest`, are the current approach.
 *  - No authentication in v1 (PRD §9, explicitly deferred) — Origin/Host
 *    validation is the whole v1 security model, applied regardless.
 *
 * The transport speaks Web Standard `Request`/`Response` (Node 18+'s global
 * `fetch` types), not Node's own `IncomingMessage`/`ServerResponse`. The
 * Node↔Web-Standard bridge itself is `@modelcontextprotocol/node`'s own
 * `toNodeHandler` (review round 1: a hand-rolled version of this same bridge
 * previously lived here — replaced because the official adapter already
 * handles response-stream backpressure (`res.on('drain', ...)`) and abort
 * cleanup (`res.on('close', ...)` tied to an `AbortController`) more
 * robustly than a bespoke version was ever going to, without duplicating
 * SDK-maintained logic in application code).
 */

import http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CodeMapNode, McpServerStatusMessage } from '@driller/ipc-contracts';
import {
  BLAST_RADIUS_DEFAULT_HOPS,
  CHANGED_CONTRACT_MAX_DEPENDENT_IDS,
  FOLDED_TYPE_LOOKUP_MAX_USED_BY,
  SIMILAR_TO_MAX_ENTRIES,
  SIMILAR_TO_MIN_JACCARD,
  TESTED_BY_MAX_TESTS,
  type FoldedModule,
  type FoldedType,
  type NodeLookupResult,
  type UnknownSectionResult,
} from '@driller/graph-contracts';
import {
  computeBlastRadiusExpansionResult,
  computeDiffScopeResult,
  computePathTraceResult,
  getCoverageSummaryResult,
} from './index';
import { sectionOfFile } from './project-scope';

/**
 * A distinctive, uncommon port (confirmed with the human) outside typical
 * dev-server ranges (3000/8000/8080/5000), minimizing collision risk with
 * other local tooling.
 */
export const MCP_SERVER_PORT = 39217;

/**
 * Request-body ceiling (review round 1, High): every legitimate call this
 * surface ever receives is a small MCP JSON-RPC tool-call payload — this is
 * generous headroom over that, not a tuned-to-the-byte limit. Enforced by
 * `contentLengthExceedsLimit` below on the raw `Content-Length` header,
 * before `toNodeHandler`'s own request conversion ever reads a single byte
 * of the body into memory (see that function's own doc comment for why this
 * ordering — not a check inside the `fetch` handler — is the only point
 * that actually bounds memory use).
 */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * Generous but finite, for a server that only ever sees local-loopback
 * traffic — closes off slow-loris-style connections holding sockets open
 * indefinitely (review round 1, Medium: Node's own defaults for
 * `headersTimeout`/`requestTimeout` are far looser, tuned for public-internet
 * servers, and `timeout`/`Server#timeout` defaults to unlimited).
 */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SOCKET_IDLE_TIMEOUT_MS = 30_000;

/**
 * P4-6: `NodeLookupResult` is declared once in `@driller/graph-contracts`
 * (AD-13) — imported above and re-exported here so this module's public
 * surface is unchanged.
 */
export type { NodeLookupResult };

/**
 * Looks `nodeId` up in `nodes` (the caller's live `activeCodeMapNodes`,
 * passed as a getter — see `startMcpServer`'s own doc comment for why).
 *
 * Mirrors `computeBlastRadiusExpansionResult`'s established guard verbatim
 * (same message) rather than inventing a new phrasing for the same
 * "no project has finished indexing yet" condition (I/O & Edge-Case Matrix).
 *
 * P0-4: `deriveLive` is applied to the found Node only — `index.ts` injects
 * `live-node.ts`'s `deriveLiveNode`, so the cached fetch-time snapshot's
 * summary/staleness and record-backed signals are re-derived from the live
 * record store at query time. The not-found/error paths are unchanged; a
 * throw from `deriveLive` becomes an explicit `{status: 'error'}`.
 *
 * P4-2 phase 3a: an id that is no map Node but is a Module folded into its
 * file (`foldedModules`, the live `activeFoldedModules`) resolves as
 * `{status: 'folded', folded: true, kind: 'Module', nodeId, file, uses, usesTypes}` —
 * never `'not-found'`. A map Node wins over a folded Module with the same id.
 *
 * P4-2 phase 3b: likewise an id that is a Type/Interface folded off the map
 * (`foldedTypes`, the live `activeFoldedTypes`) resolves as `{status:
 * 'folded', folded: true, kind, nodeId, name, file, startLine, endLine,
 * usedBy, usedByTotal, usedByKinds, implements, implementedBy, refersTo,
 * referencedByTypes}`, with `usedBy` capped at
 * `FOLDED_TYPE_LOOKUP_MAX_USED_BY`. A map Node, then a folded Module, wins
 * over a folded type with the same id.
 */
export function lookupNode(
  nodeId: string,
  nodes: CodeMapNode[] | undefined,
  deriveLive: (cached: CodeMapNode) => CodeMapNode,
  foldedModules: readonly FoldedModule[] = [],
  foldedTypes: readonly FoldedType[] = [],
): NodeLookupResult {
  if (!nodes) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    const folded = foldedModules.find((module) => module.moduleIds.includes(nodeId));
    if (folded) {
      return {
        status: 'folded',
        folded: true,
        kind: 'Module',
        nodeId,
        file: folded.file,
        uses: folded.uses,
        usesTypes: folded.usesTypes ?? [],
      };
    }
    const type = foldedTypes.find((candidate) => candidate.id === nodeId);
    if (type) {
      return {
        status: 'folded',
        folded: true,
        kind: type.kind,
        nodeId,
        name: type.name,
        file: type.file,
        startLine: type.startLine,
        endLine: type.endLine,
        usedBy: type.usedBy.slice(0, FOLDED_TYPE_LOOKUP_MAX_USED_BY),
        usedByTotal: type.usedByTotal,
        usedByKinds: type.usedByKinds,
        implements: type.implements,
        implementedBy: type.implementedBy,
        refersTo: type.refersTo,
        referencedByTypes: type.referencedByTypes,
      };
    }
    return { status: 'not-found' };
  }
  // A throw while re-deriving (e.g. a record-store read failing) must still
  // come back as this tool's own explicit error state, never a rejected
  // tool call (AD-13).
  try {
    return { status: 'ok', node: deriveLive(node) };
  } catch (error) {
    return {
      status: 'error',
      message: `Failed to read this Node's current state: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * P4-4 phase 2b: one section's build, as `lookup_node` reads it —
 * `index.ts`'s `getSectionCodeMap(section)`, the memoized
 * `buildScopedCodeMap(activeRawCodeMap.raw, sectionPredicate)` (the same
 * build the renderer gets for that section). `appliedScope` is the scope the
 * raw cache was built under, which decides which section owns a file.
 */
export interface SectionCodeMapLookup {
  readonly status: 'section';
  readonly nodes: CodeMapNode[];
  readonly foldedModules: FoldedModule[];
  readonly foldedTypes: FoldedType[];
  readonly appliedScope: readonly string[];
}

/** P4-4 phase 2b: what `getSectionCodeMap(section)` answers. */
export type SectionCodeMapResult = SectionCodeMapLookup | UnknownSectionResult | { status: 'error'; message: string };

/**
 * P4-4 phase 2b (AD-13 "Section scope"): Node lookup WITH a `section`. The
 * id is looked up in the section's own build (`lookupNode` over its Nodes,
 * folded Modules and folded types, so a Node's severities, blast-radius
 * counts and section-scoped links are the section's — never the whole-scope
 * cached Node's). An id the section build doesn't hold but the whole scope
 * does (a map Node, or a folded Module or type, by its `file`) is the
 * explicit `not-in-section`, naming the section that owns it under the
 * nearest-entry rule; never `not-found`. An unknown section, the
 * map-refreshing error and "no project indexed" come from `sectionMap`
 * as-is.
 */
export function lookupNodeInSection(
  nodeId: string,
  section: string,
  sectionMap: SectionCodeMapResult,
  deriveLive: (cached: CodeMapNode) => CodeMapNode,
  wholeScope: {
    nodes: readonly CodeMapNode[] | undefined;
    foldedModules: readonly FoldedModule[];
    foldedTypes: readonly FoldedType[];
  },
): NodeLookupResult {
  if (sectionMap.status !== 'section') {
    return sectionMap;
  }
  const inSection = lookupNode(nodeId, sectionMap.nodes, deriveLive, sectionMap.foldedModules, sectionMap.foldedTypes);
  if (inSection.status !== 'not-found') {
    return inSection;
  }
  const file =
    wholeScope.nodes?.find((node) => node.id === nodeId)?.file ??
    wholeScope.foldedModules.find((module) => module.moduleIds.includes(nodeId))?.file ??
    wholeScope.foldedTypes.find((type) => type.id === nodeId)?.file;
  const nodeSection = file === undefined ? undefined : sectionOfFile(file, sectionMap.appliedScope);
  // An id whose file no section owns is in no section of this scope at all:
  // `not-found`, as the whole-scope lookup would say. Review round 1: so is
  // one whose owner IS the requested section (the build lacks it, so it is
  // no Node there) — never a self-contradicting `not-in-section`. (Both are
  // unreachable while the whole-scope caches and the section build come
  // from the same fetch.)
  if (nodeSection === undefined || nodeSection === section) {
    return inSection;
  }
  return { status: 'not-in-section', nodeId, section, nodeSection };
}

/**
 * True when `req` must be rejected outright for carrying (or possibly
 * carrying) a body over `MAX_REQUEST_BODY_BYTES`.
 *
 * This has to run — and reject — before `toNodeHandler`'s generated Node
 * handler is ever invoked, not inside the `fetch` callback passed to it
 * (review round 1, High): `@modelcontextprotocol/node`'s `toNodeHandler`
 * calls its own internal `toWebRequest` to fully buffer the incoming body
 * into memory as a string *before* it ever calls `handler.fetch` — a check
 * placed inside that `fetch` callback would only run after the oversized
 * body had already been read in full, defeating the point. Checking the raw
 * `Content-Length` header here, ahead of handing the request to
 * `toNodeHandler` at all, is the only point that actually bounds memory use.
 *
 * A request with no valid `Content-Length` (most commonly chunked
 * transfer-encoding) is rejected too, deliberately: every legitimate client
 * of this surface — including this repo's own
 * `@modelcontextprotocol/client` `StreamableHTTPClientTransport` — sends a
 * fully-buffered JSON body with an explicit `Content-Length`, never
 * chunked, so this costs nothing functionally while closing the obvious
 * bypass (omit `Content-Length`, still send an unbounded chunked body).
 */
function contentLengthExceedsLimit(req: http.IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    // No body is ever read for these regardless (`toWebRequest`'s own
    // method check) — nothing to bound.
    return false;
  }
  const raw = req.headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const contentLength = value === undefined ? NaN : Number(value);
  if (!Number.isFinite(contentLength)) {
    return true;
  }
  return contentLength > MAX_REQUEST_BODY_BYTES;
}

function writeRequestTooLarge(res: http.ServerResponse): void {
  res.writeHead(413, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Request body too large, or of unknown/unbounded length.' },
      id: null,
    }),
  );
}

/**
 * Shared response shape for every `registerTool` handler below (review
 * finding, Low): all five tools JSON-stringify their explicit result state
 * into a single text content block — extracted once now that there are 5
 * near-identical call sites instead of 1 (this phase's own AD-13
 * no-duplication stance, applied to the response-wrapping code too, not
 * just the compute layer).
 */
function jsonToolResult(result: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/**
 * P4-4 phase 2b (AD-13 "Section scope"): the optional `section` input shared
 * by `lookup_node`, `trace_path`, `expand_blast_radius` and
 * `compute_diff_scope`. Omitted, each tool is exactly what it was before
 * (1.6.0). `''` is rejected as invalid input (`min(1)`: the SDK answers
 * with an `isError` tool result, "Input validation error: …", before the
 * handler runs) — the same rule main applies to an IPC `section: ''`
 * (malformed), never `unknown-section`, which is for a well-formed name that
 * isn't an allowlist entry.
 */
export const SECTION_INPUT_DESCRIPTION =
  "An indexing-scope allowlist entry, exactly as the human's Section bar shows it. Omit for the whole scope (identical to the unsectioned result).";

const sectionInput = (): z.ZodOptional<z.ZodString> =>
  z.string().min(1, 'section must not be empty; omit it for the whole scope.').optional().describe(SECTION_INPUT_DESCRIPTION);

/** P4-4 phase 2b: the shared description sentence on how a `section` is resolved. */
const SECTION_RULE_DESCRIPTION =
  "With 'section', a file belongs to the nearest (longest) allowlist entry that contains it, so with nested entries such as 'apps' and 'apps/web', the 'apps' section never holds apps/web/**; a 'section' that is not in the current allowlist returns {status: 'unknown-section', section, knownSections}, and while the map is still refreshing for a changed allowlist the result is an explicit error saying so. ";

/**
 * Registers the `trace_path` tool (Story 5.1, Phase 2) on `server` —
 * extracted (FIX-2) so a test can capture and invoke the exact registered
 * handler without binding the listener. The handler serializes
 * `computePathTraceResult` as-is, so agents get the same `parents`/`depths`
 * tree the renderer draws (AD-13).
 */
export function registerTracePathTool(server: Pick<McpServer, 'registerTool'>): void {
  server.registerTool(
    'trace_path',
    {
      title: 'Trace the call tree from an entry Node',
      // FIX-2: the result is the reachable call TREE, not a single path —
      // `path` is BFS visit order (consecutive entries are often siblings),
      // so agents must read `parents`/`depths` for who calls whom, exactly
      // as the renderer's highlight and step list do (AD-13).
      description:
        "Trace the call tree reachable from a query-resolved entry Node through driller's Code Map, via CALLS edges only (breadth-first, each Node visited once). The result is the reachable call tree from the entry, not a single path. " +
        "On 'found', `path` lists every reached Node id in breadth-first visit order, entry first; consecutive entries are often sibling callees, not caller and callee. " +
        '`parents` maps each reached Node id to the caller it was first reached from (the entry maps to null); use it for who calls whom. ' +
        '`depths` maps each reached Node id to its hop distance from the entry (entry = 0). ' +
        'Returns the exact same PathTraceResult the human-facing UI renders for the identical query: an explicit result state (found/ambiguous/no-path-found/error), never collapsed into a generic success/failure. ' +
        "A Module id (a file's top-level code) is folded into its file and has no Code Map Node, so it never resolves as an entry and its calls are not traced; use lookup_node on it to see what that top-level code calls or uses. " +
        "Type and Interface Nodes are folded off the Code Map too, so a type's id or name never resolves as an entry: a type-only query returns no-path-found here. The human-facing UI shows this same result, adding only an 'is a type — open its detail' hint on top of it; agents should use lookup_node with the type's id to see who uses it. " +
        "With 'section', the trace runs over that section's Nodes and the CALLS edges between them alone: it never crosses into another section, and an entry outside the section is never resolved (the same result the human gets in that section). " +
        SECTION_RULE_DESCRIPTION,
      inputSchema: z.object({
        query: z
          .string()
          .min(1, 'query must not be empty.')
          .describe('The Path Trace query — matched against Node id first, then name, then a name substring.'),
        section: sectionInput(),
      }),
    },
    // P4-4 phase 2b: `section` is passed through as given — `undefined` when
    // omitted, which is exactly the pre-section call.
    async ({ query, section }) => jsonToolResult(await computePathTraceResult(query, section)),
  );
}

/** The Agent-Facing Query Surface's contract version (semver; see `startMcpServer`). */
export const MCP_SERVER_VERSION = '1.7.0';

/**
 * Registers the `lookup_node` tool on `server` — extracted (P4-2 phase 3a,
 * the same pattern as `registerTracePathTool`) so a test can capture and
 * invoke the exact registered handler, folded-Module argument included,
 * without binding the listener. Each getter is read at call time.
 *
 * P4-4 phase 2b: `getSectionCodeMap` is called only for a lookup WITH a
 * `section` — a call without one never touches the section memo, and is
 * byte-for-byte the pre-section lookup.
 */
export function registerLookupNodeTool(
  server: Pick<McpServer, 'registerTool'>,
  getActiveCodeMapNodes: () => CodeMapNode[] | undefined,
  deriveLiveNode: (cached: CodeMapNode) => CodeMapNode,
  getActiveFoldedModules: () => FoldedModule[] | undefined,
  // P4-2 phase 3b: the live `activeFoldedTypes`, read at call time too.
  getActiveFoldedTypes: () => FoldedType[] | undefined,
  // P4-4 phase 2b: `index.ts`'s memoized `getSectionCodeMap`.
  getSectionCodeMap: (section: string) => SectionCodeMapResult,
): void {
  server.registerTool(
    'lookup_node',
    {
      title: 'Look up a Code Map Node',
      description:
        "Look up a single Node from driller's Code Map by its stable id (qualified name). Returns the exact same shape the human-facing UI shows for that Node, including its full Risk Overlay signals and summary staleness (summaryStatus) — nothing is computed differently for this surface than for the renderer. " +
        `The 'blast-radius' signal's value is a bounded count, not total impact: the distinct Nodes within ${BLAST_RADIUS_DEFAULT_HOPS} hops that this Node reaches (following edges forward) or that reach it (following edges backward), each direction searched separately — Nodes that merely share a caller or callee with it are not counted. ` +
        "Every deterministic signal carries a 'severity': 'severe' means the value crossed driller's severe threshold; 'moderate' means only \"not severe\" — it covers every value below that threshold, including trivial ones, and is not a claim that the value is risky. " +
        `'testedBy', when present, lists tests that provably exercise this Node: 'tests' are test functions or methods (or, with 'topLevel', a test file's top-level test code) that call it through an import-resolved call edge, capped at ${TESTED_BY_MAX_TESTS} with 'totalTests' giving the full count; 'files' are test files the index links to this Node's file. Name-only matches never count. Tests are not Code Map Nodes: looking up a test's id returns not-found; open its file and line range instead. An absent 'testedBy' means no test link was found, NOT that the Node is untested: the index's test links are incomplete, so never report a Node as untested or infer coverage from their absence. ` +
        "'fileTopLevel', when present, lists what this Node's file's top-level code (code outside any function, e.g. module-level calls and registrations) calls or uses: Code Map Node ids with the edge kind. " +
        "'calledAtLoadBy', when present, lists the files whose top-level code calls or uses this Node — a Node called only at load time (main(), route registration, init hooks) has no Code Map caller, so this is where its caller is named. " +
        "Module Nodes (a file's top-level code) are folded into their file and are not Code Map Nodes: looking up a Module's id returns {status: 'folded', folded: true, kind: 'Module', nodeId, file, uses, usesTypes} (no 'node'), where 'uses' is the Code Map Nodes that top-level code calls or uses and 'usesTypes' the folded types it uses: check status === 'folded'; folded: true is also set. A folded Module's edges do not count toward any Node's blast radius, and a changed Module is not a changed Node. " +
        "'usesTypes', when present, lists the Type and Interface ids (with name and kind) this Node uses through a real USAGE edge — never inferred from its signature. " +
        `Type and Interface Nodes are folded off the Code Map as contracts: looking up a type's id returns {status: 'folded', folded: true, kind: 'Type' | 'Interface', nodeId, name, file, startLine, endLine, usedBy, usedByTotal, usedByKinds, implements, implementedBy, refersTo, referencedByTypes} (no 'node'), where 'usedBy' is up to ${FOLDED_TYPE_LOOKUP_MAX_USED_BY} ids of Code Map Nodes that use it through a USAGE edge (usedByTotal is the full count, usedByKinds its breakdown by Node kind); 'implements'/'implementedBy' are folded type ids it extends or implements, and that extend or implement it (Interface/Type IMPLEMENTS edges only: Classes are not Code Map Nodes, so a class implementing it is not listed); 'refersTo'/'referencedByTypes' are folded type ids it refers to, and that refer to it, through USAGE edges. A type's edges do not count toward any Node's blast radius, and a changed type is not a changed Node. ` +
        "'fileTopLevelTypes', when present on a Node, lists the folded types its file's top-level code uses. " +
        `'similarTo', when present, lists other production Functions in other files that the index's own SIMILAR_TO edge marks as near-duplicates of this one ({id, name, file, score}, score being the backend's jaccard token overlap, at least ${SIMILAR_TO_MIN_JACCARD}), highest score first, capped at ${SIMILAR_TO_MAX_ENTRIES} with 'similarToTotal' giving the full count; each id is a Code Map Node id. Similarity is structural (token overlap), not a claim they behave the same; same-file pairs and test code are never listed, and nothing is inferred beyond SIMILAR_TO. An absent 'similarTo' means no such pair was found (or the index has no SIMILAR_TO edges). ` +
        "'testCoverageAvailable': true, when present, means the project's coverage/lcov.info has line data for this Node's file; it says nothing about a percentage, and nothing about whether this Node ran. " +
        "'testCoverageHit': true, when present, means the function was entered at least once by tests (LCOV): a function record (FN/FNDA) starting in this Node's range has a call count above 0, and the file is not newer than the report. It is the only coverage claim made about the Node itself; line hits alone never set it, because loading a module hits a declaration's own line even when no test calls it. An absent 'testCoverageHit' is NOT evidence the Node is untested: the report may lack function records, be older than the file, or not list it. An absent 'testCoverageAvailable' means there is no LCOV data for the file at all (no coverage/lcov.info, an unparseable one, or a report that doesn't list the file). " +
        "With 'section', the Node is the one the human sees in that section: every deterministic signal's severity and the blast-radius count are computed over that section alone (its own severity cut, and only Nodes and edges inside it); the 'llm-judgment' and 'ingested' signals and the summary come from driller's stored records and are the same with or without a section; and the section-scoped links ('similarTo', 'usesTypes', 'fileTopLevel', 'fileTopLevelTypes', 'calledAtLoadBy', and a folded type's 'usedBy' and type links, or a folded Module's 'uses') name only ids inside the section; 'testedBy' and the test-coverage flags are the same as without a section. " +
        "An id that exists in the whole scope but belongs to another section (a folded Module or type by its file) returns {status: 'not-in-section', nodeId, section, nodeSection}, never not-found; 'nodeSection' is the section that holds it. " +
        SECTION_RULE_DESCRIPTION,
      inputSchema: z.object({
        nodeId: z.string().describe("The Node's stable id (qualified name), as shown in the Code Map."),
        section: sectionInput(),
      }),
    },
    async ({ nodeId, section }) =>
      jsonToolResult(
        section === undefined
          ? lookupNode(
              nodeId,
              getActiveCodeMapNodes(),
              deriveLiveNode,
              getActiveFoldedModules() ?? [],
              getActiveFoldedTypes() ?? [],
            )
          : lookupNodeInSection(nodeId, section, getSectionCodeMap(section), deriveLiveNode, {
              nodes: getActiveCodeMapNodes(),
              foldedModules: getActiveFoldedModules() ?? [],
              foldedTypes: getActiveFoldedTypes() ?? [],
            }),
      ),
  );
}

/**
 * Registers the `expand_blast_radius` tool (Story 5.1, Phase 2) on `server` —
 * extracted (P4-4 phase 2b, the `registerTracePathTool` pattern) so a test
 * can capture and invoke the exact registered handler without binding the
 * listener.
 */
export function registerExpandBlastRadiusTool(server: Pick<McpServer, 'registerTool'>): void {
  server.registerTool(
    'expand_blast_radius',
    {
      title: 'Expand blast radius from a Node set',
      description:
        "Compute hop-distance blast radius expansion from a seed set of Node ids through driller's Code Map. Returns the exact same BlastRadiusExpansionResult the human-facing UI would get for the identical seed set — an explicit result state (resolved/error), never collapsed into a generic success/failure. " +
        "Hop distances are per direction and unbounded: each Node's distance is the smaller of its forward (seed reaches it) and backward (it reaches a seed) distance from the nearest seed, never a path that mixes directions, so Nodes that only share a caller or callee with a seed are not returned. Seeds are excluded. " +
        `Filtering to distances 1..${BLAST_RADIUS_DEFAULT_HOPS} for a single seed gives exactly the Node set that seed's 'blast-radius' signal counts. ` +
        "A Module id (a file's top-level code) is folded into its file and has no Code Map Node: as a seed it reaches nothing, and Module edges are never walked. " +
        "Type and Interface ids are folded off the Code Map the same way: as seeds they reach nothing, and type (USAGE) edges are never walked. " +
        "With 'section', hop distances are walked over that section's Nodes and the edges between them alone (the same graph its blast-radius counts use): nothing outside the section is returned, and a seed outside it reaches nothing. " +
        SECTION_RULE_DESCRIPTION,
      inputSchema: z.object({
        projectPath: z.string().describe('The absolute path of the project to query — must match the currently indexed project.'),
        nodeIds: z
          .array(z.string())
          .max(1000, 'nodeIds must not exceed 1000 entries.')
          .describe('The seed Node ids to expand blast radius from. May be empty.'),
        section: sectionInput(),
      }),
    },
    // P4-4 phase 2b: `section` passed through (`undefined` when omitted — the pre-section call).
    async ({ projectPath, nodeIds, section }) =>
      jsonToolResult(computeBlastRadiusExpansionResult(projectPath, nodeIds, section)),
  );
}

/**
 * Registers the `compute_diff_scope` tool (Story 5.1, Phase 2) on `server` —
 * extracted (P4-4 phase 2b) like `registerExpandBlastRadiusTool`.
 */
export function registerComputeDiffScopeTool(server: Pick<McpServer, 'registerTool'>): void {
  server.registerTool(
    'compute_diff_scope',
    {
      title: 'Compute the diff-scoped Node set',
      description:
        "Compute the diff-scoped Node set for a project against a base ref (or an auto-resolved default branch). Returns the exact same DiffScopeResult the human-facing UI would get for the identical request — an explicit result state (resolved/no-changes/not-a-git-repo/no-base-ref-resolvable/error), never collapsed into a generic success/failure. " +
        "A resolved result's optional 'topLevelFiles' lists changed files whose only content on the map is folded top-level code (no Code Map Node), so a top-level-only change is named rather than reported as zero changed Nodes. " +
        "A resolved result's optional 'changedContracts' lists the folded Types/Interfaces whose own lines the diff " +
        "changed (types are not Code Map Nodes, so a type-only change would otherwise read as zero changed Nodes), " +
        "most dependents first: each is {id, name, kind: 'Type' | 'Interface', file, dependentCount, dependentIds}. " +
        "'dependentIds' are the in-scope Code Map Nodes with a real USAGE edge into the type (sorted, unique, at most " +
        `${CHANGED_CONTRACT_MAX_DEPENDENT_IDS}); 'dependentCount' is always their full number. ` +
        "Dependents are affected, not changed: they are not in 'nodeIds'. " +
        "'changedContractsApproximate: true' means approximate: couldn't read line ranges for some changed file, so " +
        "every type in it was counted (may over-report, never hides a contract). " +
        "'topLevelFiles' leaves out a file whose every change lies inside a type. " +
        "With 'section', the changed Nodes, changed contracts (and their dependents) and top-level-only files are only that section's own, matched against its Nodes alone; changes in other sections are not reported. " +
        SECTION_RULE_DESCRIPTION,
      inputSchema: z.object({
        projectPath: z.string().describe('The absolute path of the project to query — must match the currently indexed project.'),
        baseRef: z
          .string()
          .optional()
          .describe('The branch/commit to diff against. Omit to auto-resolve a default branch.'),
        section: sectionInput(),
      }),
    },
    async ({ projectPath, baseRef, section }) => {
      // Review finding (Low): mirrors the renderer's own established base-ref
      // normalization (Story 3.1, Phase 2) — a trimmed-empty string means
      // "omit," triggering auto-resolution, exactly like the tool's own
      // description promises. Without this, `baseRef: ''` would pass through
      // as `''` rather than `undefined`, diverging from that documented
      // behavior.
      const trimmedBaseRef = baseRef?.trim();
      const result = await computeDiffScopeResult(
        projectPath,
        trimmedBaseRef && trimmedBaseRef.length > 0 ? trimmedBaseRef : undefined,
        // P4-4 phase 2b: `undefined` when omitted — the pre-section call.
        section,
      );
      return jsonToolResult(result);
    },
  );
}

/**
 * Builds the `McpServer`, registers all five tools (`lookup_node` plus
 * Phase 2's `trace_path`/`expand_blast_radius`/`compute_diff_scope`/
 * `get_coverage_summary`), and starts the `127.0.0.1`-bound HTTP listener —
 * called once at subprocess boot (`index.ts`), never gated on a project
 * being indexed first (Always).
 *
 * `getActiveCodeMapNodes` is a closure over `index.ts`'s own module-level
 * `activeCodeMapNodes`, not a value captured once at call time: that `let`
 * is reassigned on every `graphService:index` request and reset to
 * `undefined` on re-index (its own doc comment there), and this server is
 * constructed long before the first one ever completes. A captured value
 * would freeze at whatever it was during this call (always `undefined`,
 * since indexing hasn't happened yet) and never observe a later index
 * finishing — a live getter is the only correct shape here. The four Phase 2
 * tools need no equivalent getter parameter: their compute functions
 * (`computePathTraceResult`/`computeBlastRadiusExpansionResult`/
 * `computeDiffScopeResult`/`getCoverageSummaryResult`) live in `index.ts`
 * itself and already close over that module's own live state directly.
 *
 * `registerTool`/`new WebStandardStreamableHTTPServerTransport(...)` below
 * can throw synchronously (a malformed tool config, etc.) — deliberately
 * left uncaught here so that failure propagates to the caller's own
 * try/catch (`index.ts`, review round 1, Low) rather than being silently
 * swallowed. `server.connect(transport)` is different: it's inherently
 * asynchronous, so its failure is handled with its own `.catch()` below
 * (review round 1, Medium) — `httpServer.listen(...)` is deliberately
 * sequenced to run only after `connect()` resolves, closing a startup race
 * where the HTTP listener could accept a connection before the transport
 * was actually attached.
 *
 * `postMcpServerStatus` (Story 5.2) is called exactly once from the listener's
 * own bind/error paths: `{state: 'listening', port}` from `httpServer.listen`'s
 * successful-bind callback, `{state: 'unavailable', message}` from
 * `httpServer.on('error', ...)`. This is the one gap Story 5.1 left: the
 * Graph Service subprocess itself can stay `'alive'`/`'indexed'` while this
 * listener silently fails to bind or crashes — before this, nothing told main
 * or the renderer. Deliberately not posted from `server.connect(transport)`'s
 * own `.catch()` above (Boundaries & Constraints, spec-5-2's Code Map): that
 * failure already logs to console and leaves the listener never started,
 * which the absence of any `'listening'` post already makes silently
 * incomplete rather than falsely healthy — but it's a distinct, rarer failure
 * mode (SDK/transport construction, not a bind/error the socket itself
 * reports) that the spec scopes this new signal to the listener's own two
 * existing event paths, not a third call site.
 *
 * Returns a close function (review round 1, Medium) — `index.ts`'s
 * `finishShutdown` calls it so this listener is released on a clean
 * subprocess shutdown, the same resource-release discipline
 * `disposeModelContext` already established for this file.
 */
export function startMcpServer(
  getActiveCodeMapNodes: () => CodeMapNode[] | undefined,
  postMcpServerStatus: (message: McpServerStatusMessage) => void,
  deriveLiveNode: (cached: CodeMapNode) => CodeMapNode,
  // P4-2 phase 3a: the live `activeFoldedModules`, a getter for the same
  // reason `getActiveCodeMapNodes` is one.
  getActiveFoldedModules: () => FoldedModule[] | undefined,
  // P4-2 phase 3b: the live `activeFoldedTypes`, a getter for the same reason.
  getActiveFoldedTypes: () => FoldedType[] | undefined,
  // P4-4 phase 2b: `index.ts`'s memoized section build, for `lookup_node`
  // with a `section` only.
  getSectionCodeMap: (section: string) => SectionCodeMapResult,
): () => Promise<void> {
  // Phase 1 shipped '1.0.0' as the documented v1 contract covering
  // `lookup_node` alone. Phase 2 bumps the MINOR version (semver:
  // backward-compatible addition, no existing tool's shape changed) to
  // reflect the four newly added tools — the v1 contract is extended, never
  // replaced (Acceptance Criteria). P4-2 phase 3a bumps it again (1.2.0):
  // `lookup_node` gains the folded-Module result and the `fileTopLevel`/
  // `calledAtLoadBy` Node fields, and `compute_diff_scope` gains
  // `topLevelFiles` — all additive. P4-2 phase 3b (1.3.0): `lookup_node`
  // gains the folded-type result and the `usesTypes`/`fileTopLevelTypes`
  // Node fields, and the folded-Module result gains `kind: 'Module'` and
  // `usesTypes`. Additive for a client that reads fields, but a client
  // comparing the folded-Module result's exact shape (deep equality against
  // `{status, folded, nodeId, file, uses}`) will see the two new fields.
  // P4-2 phase 3c (1.4.0): `compute_diff_scope`'s resolved result gains
  // `changedContracts` and `changedContractsApproximate` — additive, absent
  // when not applicable. One behaviour change: `topLevelFiles` now leaves
  // out a file whose every change lies inside a type (a contract-only
  // change, named in `changedContracts` instead).
  // P4-2 phase 4 (1.5.0): `lookup_node`'s Node gains `similarTo` and
  // `similarToTotal` — additive, absent when not applicable.
  // P4-3 phase 5 (1.6.0): `lookup_node`'s Node gains `testCoverageAvailable`
  // and `testCoverageHit` — additive, `true` or absent (never `false`).
  // P4-4 phase 2b (1.7.0): `lookup_node`, `trace_path`, `expand_blast_radius`
  // and `compute_diff_scope` gain an optional `section` (AD-13 "Section
  // scope"); `lookup_node` gains the `not-in-section` and `unknown-section`
  // states and the others `unknown-section`, all reachable only with it. A
  // call without `section` is byte-for-byte what 1.6.0 returned. (The P4-4f
  // spec, written before P4-3f took 1.6.0, says 1.5.0 → 1.6.0; the intent —
  // one additive minor bump — is kept.)
  const server = new McpServer({ name: 'driller-code-map', version: MCP_SERVER_VERSION });

  registerLookupNodeTool(
    server,
    getActiveCodeMapNodes,
    deriveLiveNode,
    getActiveFoldedModules,
    getActiveFoldedTypes,
    getSectionCodeMap,
  );

  // Story 5.1 (Phase 2): the remaining four operations. Each handler calls
  // straight into its already-exported, already-reviewed compute function
  // from `index.ts` (AD-13) — never a second copy of any operation's logic —
  // mirroring `lookup_node`'s own JSON-stringified-result pattern above.
  // Unlike `lookup_node` (Phase 1, not retrofitted — Design Notes), each of
  // these three project-scoped tools takes `projectPath` as an explicit
  // input, mirroring their existing IPC contracts exactly (Always): an
  // external agent must state which project it's querying, same as the
  // renderer does.

  registerTracePathTool(server);

  registerExpandBlastRadiusTool(server);

  registerComputeDiffScopeTool(server);

  server.registerTool(
    'get_coverage_summary',
    {
      title: 'Get the index coverage summary',
      description:
        "Retrieve the current index's coverage-check summary (skipped/parse-partial file counts and gap paths) for a project. Returns an explicit result state: 'ok' with the coverage summary, 'unavailable' when the project is indexed but no coverage summary was captured (distinct from an error), or 'error' when the project isn't the currently indexed one.",
      inputSchema: z.object({
        projectPath: z.string().describe('The absolute path of the project to query — must match the currently indexed project.'),
      }),
    },
    async ({ projectPath }) => {
      return jsonToolResult(getCoverageSummaryResult(projectPath));
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode: no session bookkeeping needed — every tool call above
    // (Phase 1's `lookup_node` and Phase 2's four additions) is a single
    // stdio-free request/response with no cross-call state of its own —
    // matches this transport's own documented "stateless setup" pattern
    // (`sessionIdGenerator: undefined`).
    sessionIdGenerator: undefined,
  });

  const nodeHandler = toNodeHandler({
    fetch: async (request: Request): Promise<Response> => {
      // Origin validation — first independent layer, applied to every
      // request regardless of the no-auth-for-v1 decision (Always).
      const originRejection = originValidationResponse(request, localhostAllowedOrigins());
      if (originRejection) {
        return originRejection;
      }

      // Host validation — second, independent layer (defense-in-depth
      // against DNS-rebinding, CVE-2025-49596). Never skipped or treated as
      // redundant with the Origin check above, even though Origin already
      // passed (Always).
      const hostRejection = hostHeaderValidationResponse(request, localhostAllowedHostnames());
      if (hostRejection) {
        return hostRejection;
      }

      return transport.handleRequest(request);
    },
  });

  const httpServer = http.createServer((req, res) => {
    if (contentLengthExceedsLimit(req)) {
      writeRequestTooLarge(res);
      return;
    }
    void nodeHandler(req, res);
  });

  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.timeout = SOCKET_IDLE_TIMEOUT_MS;

  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    // Console logging stays separate from the posted UI message (review
    // finding, Low): a developer reading this log wants the full technical
    // detail (and, for the generic branch, the original `Error` object with
    // its stack trace) — the UI message is deliberately shorter, clean,
    // non-redundant copy (review finding, Low: the earlier version restated
    // "unavailable" inside a message already shown after an "unavailable:"
    // prefix, and referenced "this instance," which doesn't read as
    // end-user copy).
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[mcp-server] port ${MCP_SERVER_PORT} is already in use — likely a second driller instance already running. The Agent-Facing Query Surface will not be available in this instance.`,
      );
      postMcpServerStatus({
        type: 'graphService:mcpServerStatus',
        state: 'unavailable',
        message: `Port ${MCP_SERVER_PORT} may already be in use by another driller window. Retry will restart driller's background service.`,
        at: new Date().toISOString(),
      });
      return;
    }
    console.error('[mcp-server] failed to start the Agent-Facing Query Surface:', error);
    postMcpServerStatus({
      type: 'graphService:mcpServerStatus',
      state: 'unavailable',
      message: `driller's background service failed to start this surface: ${error.message}. Retry will restart it.`,
      at: new Date().toISOString(),
    });
  });

  server
    .connect(transport)
    .then(() => {
      // Binds strictly to the loopback interface (Always: never `0.0.0.0`,
      // never an externally-reachable interface) — the explicit host
      // argument is load bearing, not just documentation; `http.Server#listen`'s
      // default without it varies by platform and can bind all interfaces.
      httpServer.listen(MCP_SERVER_PORT, '127.0.0.1', () => {
        console.log(`[mcp-server] Agent-Facing Query Surface listening on 127.0.0.1:${MCP_SERVER_PORT}`);
        postMcpServerStatus({
          type: 'graphService:mcpServerStatus',
          state: 'listening',
          port: MCP_SERVER_PORT,
          at: new Date().toISOString(),
        });
      });
    })
    .catch((error: unknown) => {
      console.error(
        '[mcp-server] failed to connect the MCP server to its transport — the Agent-Facing Query Surface will not start:',
        error,
      );
    });

  return async () => {
    await new Promise<void>((resolve) => {
      httpServer.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          console.error('[mcp-server] error while closing the HTTP listener:', error);
        }
        resolve();
      });
    });
    try {
      await server.close();
    } catch (error) {
      console.error('[mcp-server] error while closing the MCP server:', error);
    }
  };
}
