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
import type { GapFile, IndexCoverageSummary } from '@driller/ipc-contracts';

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
  return { nodes: fields.nodes, edges: fields.edges, coverage };
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
