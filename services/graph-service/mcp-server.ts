/**
 * The Agent-Facing Query Surface (Epic 5, Story 5.1 Phase 1): a secured MCP
 * server, hosted inside this subprocess (AD-1's `utilityProcess.fork`), that
 * lets other agents/tools query driller's Code Map the same way the
 * renderer does — starting with Node lookup, the one operation this phase
 * proves the whole pipe with. Phase 2 wires the remaining four operations
 * (Path Trace, Blast Radius expansion, diff-scoped Node-set, coverage-check
 * retrieval) onto this same transport/security baseline.
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
import type { CodeMapNode } from '@driller/ipc-contracts';

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
 * Builds the `McpServer`, registers the Node-lookup tool, and starts the
 * `127.0.0.1`-bound HTTP listener — called once at subprocess boot
 * (`index.ts`), never gated on a project being indexed first (Always).
 *
 * `getActiveCodeMapNodes` is a closure over `index.ts`'s own module-level
 * `activeCodeMapNodes`, not a value captured once at call time: that `let`
 * is reassigned on every `graphService:index` request and reset to
 * `undefined` on re-index (its own doc comment there), and this server is
 * constructed long before the first one ever completes. A captured value
 * would freeze at whatever it was during this call (always `undefined`,
 * since indexing hasn't happened yet) and never observe a later index
 * finishing — a live getter is the only correct shape here.
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
 * Returns a close function (review round 1, Medium) — `index.ts`'s
 * `finishShutdown` calls it so this listener is released on a clean
 * subprocess shutdown, the same resource-release discipline
 * `disposeModelContext` already established for this file.
 */
export function startMcpServer(getActiveCodeMapNodes: () => CodeMapNode[] | undefined): () => Promise<void> {
  const server = new McpServer({ name: 'driller-code-map', version: '1.0.0' });

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
    async ({ nodeId }) => {
      const result = lookupNode(nodeId, getActiveCodeMapNodes());
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode: no session bookkeeping needed for a single stdio-free
    // Node-lookup tool call (Phase 1 scope) — matches this transport's own
    // documented "stateless setup" pattern (`sessionIdGenerator: undefined`).
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
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[mcp-server] port ${MCP_SERVER_PORT} is already in use — likely a second driller instance already running. The Agent-Facing Query Surface will not be available in this instance.`,
      );
      return;
    }
    console.error('[mcp-server] failed to start the Agent-Facing Query Surface:', error);
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
