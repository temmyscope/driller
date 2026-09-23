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
  computeBlastRadiusExpansionResult,
  computeDiffScopeResult,
  computePathTraceResult,
  getCoverageSummaryResult,
} from './index';

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
 * Node lookup's own explicit result-state union (AD-13: `null`/`undefined`
 * must never stand in for "nothing here"). Not part of `@driller/ipc-contracts`
 * — this phase adds a new MCP-only operation, not a new IPC contract (Code
 * Map: "no changes this phase" there). Mirrors `RegenerateNodeResult`'s own
 * `{status: 'ok', node} | {status: 'error', message}` shape, with a third
 * `'not-found'` state for a syntactically valid but unknown `nodeId` — a
 * distinct case from "no project indexed yet" (both would otherwise collapse
 * into the same generic error).
 */
export type NodeLookupResult =
  | { status: 'ok'; node: CodeMapNode }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * Looks `nodeId` up in `nodes` (the caller's live `activeCodeMapNodes`,
 * passed as a getter — see `startMcpServer`'s own doc comment for why).
 *
 * Mirrors `computeBlastRadiusExpansionResult`'s established guard verbatim
 * (same message) rather than inventing a new phrasing for the same
 * "no project has finished indexing yet" condition (I/O & Edge-Case Matrix).
 */
export function lookupNode(nodeId: string, nodes: CodeMapNode[] | undefined): NodeLookupResult {
  if (!nodes) {
    return { status: 'error', message: 'No project has finished indexing yet.' };
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return { status: 'not-found' };
  }
  return { status: 'ok', node };
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
): () => Promise<void> {
  // Phase 1 shipped '1.0.0' as the documented v1 contract covering
  // `lookup_node` alone. Phase 2 bumps the MINOR version (semver:
  // backward-compatible addition, no existing tool's shape changed) to
  // reflect the four newly added tools — the v1 contract is extended, never
  // replaced (Acceptance Criteria).
  const server = new McpServer({ name: 'driller-code-map', version: '1.1.0' });

  server.registerTool(
    'lookup_node',
    {
      title: 'Look up a Code Map Node',
      description:
        "Look up a single Node from driller's Code Map by its stable id (qualified name). Returns the exact same shape the human-facing UI shows for that Node, including its full Risk Overlay signals and summary staleness (summaryStatus) — nothing is computed differently for this surface than for the renderer.",
      inputSchema: z.object({
        nodeId: z.string().describe("The Node's stable id (qualified name), as shown in the Code Map."),
      }),
    },
    async ({ nodeId }) => jsonToolResult(lookupNode(nodeId, getActiveCodeMapNodes())),
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

  server.registerTool(
    'trace_path',
    {
      title: 'Trace a call path',
      description:
        "Trace a deterministic call path from a query-resolved entry Node through driller's Code Map, via CALLS edges only. Returns the exact same PathTraceResult the human-facing UI's Path Trace would get for the identical query — an explicit result state (found/ambiguous/no-path-found/error), never collapsed into a generic success/failure.",
      inputSchema: z.object({
        query: z
          .string()
          .min(1, 'query must not be empty.')
          .describe('The Path Trace query — matched against Node id first, then name, then a name substring.'),
      }),
    },
    async ({ query }) => jsonToolResult(await computePathTraceResult(query)),
  );

  server.registerTool(
    'expand_blast_radius',
    {
      title: 'Expand blast radius from a Node set',
      description:
        "Compute hop-distance blast radius expansion from a seed set of Node ids through driller's Code Map. Returns the exact same BlastRadiusExpansionResult the human-facing UI would get for the identical seed set — an explicit result state (resolved/error), never collapsed into a generic success/failure.",
      inputSchema: z.object({
        projectPath: z.string().describe('The absolute path of the project to query — must match the currently indexed project.'),
        nodeIds: z
          .array(z.string())
          .max(1000, 'nodeIds must not exceed 1000 entries.')
          .describe('The seed Node ids to expand blast radius from. May be empty.'),
      }),
    },
    async ({ projectPath, nodeIds }) => jsonToolResult(computeBlastRadiusExpansionResult(projectPath, nodeIds)),
  );

  server.registerTool(
    'compute_diff_scope',
    {
      title: 'Compute the diff-scoped Node set',
      description:
        "Compute the diff-scoped Node set for a project against a base ref (or an auto-resolved default branch). Returns the exact same DiffScopeResult the human-facing UI would get for the identical request — an explicit result state (resolved/no-changes/not-a-git-repo/no-base-ref-resolvable/error), never collapsed into a generic success/failure.",
      inputSchema: z.object({
        projectPath: z.string().describe('The absolute path of the project to query — must match the currently indexed project.'),
        baseRef: z
          .string()
          .optional()
          .describe('The branch/commit to diff against. Omit to auto-resolve a default branch.'),
      }),
    },
    async ({ projectPath, baseRef }) => {
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
      );
      return jsonToolResult(result);
    },
  );

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
