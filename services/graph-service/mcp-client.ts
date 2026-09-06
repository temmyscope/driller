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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export interface IndexRepositoryResult {
  nodes: number;
  edges: number;
}

const CLIENT_INFO = { name: 'driller-graph-service', version: '0.1.0' };

// ~4 minutes: just past AD-15's ~3min full-index budget at the confirmed
// 1,000-1,300 file target. A hung MCP call (backend wedged, or a much
// larger-than-target repo) surfaces as the existing `error` state instead
// of an "Indexing…" badge that never resolves.
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

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
 * Connects to `codebase-memory-mcp` over stdio, calls `index_repository` for
 * `repoPath`, and returns the backend's raw node/edge counts. The MCP client
 * and its backing subprocess are ephemeral — spun up fresh and always torn
 * down again before this function returns (success, failure, or timeout) —
 * so a long-running or hung call never leaks a dangling backend process.
 *
 * Throws on any failure (backend fails to spawn, the MCP handshake fails,
 * the tool call rejects or reports `isError`, the combined call exceeds
 * `timeoutMs`, or the result can't be parsed into `{nodes, edges}`) —
 * callers surface that through the existing error/retry status path rather
 * than a bespoke failure shape.
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

  return parseIndexResult(result);
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
 * Extracts `{nodes, edges}` from a `CallToolResult`. The live backend may
 * return them as `structuredContent` (the modern MCP shape) or as a JSON
 * string in the first text content block (the common fallback shape) —
 * this checks both rather than assuming one.
 */
function parseIndexResult(result: unknown): IndexRepositoryResult {
  const structured = extractCounts(
    (result as { structuredContent?: unknown } | null | undefined)?.structuredContent,
  );
  if (structured) {
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
        const counts = extractCounts(parsed);
        if (counts) {
          return counts;
        }
      }
    }
  }

  throw new Error(
    'index_repository did not return recognizable {nodes, edges} counts.',
  );
}

function extractCounts(value: unknown): IndexRepositoryResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { nodes, edges } = value as { nodes?: unknown; edges?: unknown };
  if (typeof nodes === 'number' && typeof edges === 'number') {
    return { nodes, edges };
  }
  return undefined;
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
