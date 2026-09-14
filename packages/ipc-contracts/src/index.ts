/**
 * @driller/ipc-contracts
 *
 * Shared, transport-agnostic TypeScript shapes for the messages this story
 * introduces: opening a project folder, the Recent Projects list, and the
 * Graph Service alive/status handshake.
 *
 * This package is consumed, unmodified, by:
 *  - apps/desktop/main      (constructs these values, wires ipcMain handlers)
 *  - apps/desktop/preload   (the contextBridge-exposed surface types itself
 *                            against DrillerApi below)
 *  - apps/desktop/renderer  (consumes the same types via window.driller)
 *  - services/graph-service (posts GraphServiceStatusMessage via parentPort)
 *
 * Per ARCHITECTURE-SPINE.md's Consistency Conventions, IPC channel names are
 * namespaced `<domain>:<action>`. The real Graph Service query surface
 * (Node lookup, Path Trace, Blast Radius, coverage-check, etc. — AD-13)
 * belongs in packages/graph-contracts — Story 1.9 (Phase 1) is its first real
 * content (Path Trace), reused here for the `path:trace` IPC envelope rather
 * than redefined ad hoc (see `PathTraceResult`'s import below).
 */

import type { PathTraceResult } from '@driller/graph-contracts';

export type { PathTraceResult } from '@driller/graph-contracts';

// ---------------------------------------------------------------------------
// Recent Projects (AD-5: persisted via electron-store under userData)
// ---------------------------------------------------------------------------

export interface RecentProject {
  /** Absolute, OS-native path to the project's root folder. */
  path: string;
  /** Display name — the folder's basename. */
  name: string;
  /** ISO-8601 timestamp of the most recent time this project was opened. */
  lastOpenedAt: string;
}

// ---------------------------------------------------------------------------
// Git repo detection (FR1)
// ---------------------------------------------------------------------------

export type GitRelation = 'root' | 'parent' | 'child';

export interface GitDetectionResult {
  isGitRepo: boolean;
  /** Absolute path to the detected `.git` repo root, when found. */
  gitRootPath?: string;
  /**
   * How the opened folder relates to the detected repo root:
   *  - 'root':   the opened folder itself contains `.git`
   *  - 'parent': an ancestor of the opened folder contains `.git`
   *  - 'child':  a descendant of the opened folder contains `.git`
   */
  relation?: GitRelation;
}

// ---------------------------------------------------------------------------
// Open-folder flow result (explicit result states — never an implicit empty
// value standing in for "not found"/"cancelled", per AD-13's broader pattern)
// ---------------------------------------------------------------------------

export type ProjectOpenResult =
  | { status: 'opened'; project: RecentProject; git: GitDetectionResult }
  | { status: 'not-a-git-repo'; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

// ---------------------------------------------------------------------------
// Graph Service alive/status handshake (AD-1)
//
// Story 1.1 established only the process boundary and the alive/exited/error
// handshake. Story 1.2 (Phase 1) adds 'indexing'/'indexed': the Graph Service
// connects to the real codebase-memory-mcp backend as an MCP client and
// reports structural-indexing progress as a status distinct from plain
// 'alive'. 'indexed' carries raw node/edge counts only — no coverage-gap
// interpretation (that's Phase 2, and 'indexed' is deliberately a distinct
// state so a future summary-generation status has room to sit alongside it,
// per AD-8).
//
// This is a proper discriminated union keyed on `state`, not a flat shape
// with optional fields: a flat shape let a real bug (review round 1) go
// unnoticed by the type system — 'indexed' could be constructed without
// `nodes`/`edges`, and nothing correlated a status to the project it was
// about. `path` on the indexing-attempt states lets a consumer (the Graph
// Service itself, and the renderer) tell a status about the currently-open
// project apart from a stale/superseded one for a project the user has
// since navigated away from — MCP tool calls aren't cleanly cancelable
// mid-flight, so an overtaken attempt's eventual result must be identified
// and discarded rather than silently applied.
// ---------------------------------------------------------------------------

export type GraphServiceState =
  | 'starting'
  | 'alive'
  | 'indexing'
  | 'indexed'
  | 'exited'
  | 'error';

// ---------------------------------------------------------------------------
// Phase 2: coverage/scale transparency (FR2, NFR1, AD-15).
//
// Sourced entirely from the real backend's own `index_repository`/
// `index_status` reporting — driller never re-derives or infers coverage
// locally. `parse_partial`/`skipped` files are the only genuine coverage
// gaps; `not_indexed` (gitignore/skip-list exclusions) is by-design and MUST
// NOT be surfaced here. The follow-up `index_status` call that supplies
// `gapPaths` is best-effort: if it fails, `coverage` is omitted from the
// `indexed` message entirely rather than posting a partial summary.
//
// `expectedNodes`/`expectedEdges` are optional enrichment, not a gate:
// live testing found the backend's MCP `index_repository` response
// intermittently omits them even on an otherwise-healthy call, while
// `skippedCount`/`parsePartialCount` (the fields that actually determine a
// genuine gap) are always present. Requiring the expected-count fields
// before building `coverage` at all made the summary vanish on healthy
// runs — see mcp-client.ts's `fetchCoverage` and this spec's Design Notes.
// ---------------------------------------------------------------------------

/**
 * One coverage-gap file from the `index_status` follow-up call, tagged with
 * which kind of gap it is. `skipped` (not indexed at all) and `parse_partial`
 * (indexed, but tree-sitter's error recovery may have missed some constructs)
 * are meaningfully different severities — Story 1.3's per-Node rendering is
 * expected to show them differently, so this story preserves the distinction
 * through the wire rather than flattening it into an undifferentiated
 * `string[]`.
 */
export interface GapFile {
  /**
   * The gap file's path exactly as `index_status` reported it. Documented
   * here as "absolute" when this shape was first introduced, but Story 1.5
   * Phase 2's live verification against the real backend found it actually
   * reporting a bare project-relative path (e.g. `"broken.js"`, matching
   * `CodeMapNode.file`'s own format directly) for at least one real
   * build/invocation shape — never trust this field's absoluteness without
   * checking `path.isAbsolute()` first (see `toProjectRelativePosixPath` in
   * `services/graph-service/index.ts`, this contract's one real consumer).
   */
  path: string;
  /** Which kind of coverage gap this file is. */
  kind: 'skipped' | 'parse_partial';
}

export interface IndexCoverageSummary {
  /**
   * Node count the backend expected to produce for a fully-covered index.
   * Optional enrichment — present only when the backend's response happens
   * to include it; never required to produce a `coverage` object at all.
   */
  expectedNodes?: number;
  /**
   * Edge count the backend expected to produce for a fully-covered index.
   * Optional enrichment — same caveat as `expectedNodes`.
   */
  expectedEdges?: number;
  /** Count of files the backend skipped outright (a genuine coverage gap). */
  skippedCount: number;
  /** Count of files the backend could only partially parse (a genuine coverage gap). */
  parsePartialCount: number;
  /**
   * The `parse_partial`/`skipped` gap files from the `index_status`
   * follow-up call, each tagged with its `kind`. Wired through for Story
   * 1.3's Code Map to render per-Node — this story does not render them
   * itself.
   */
  gapPaths: GapFile[];
}

export type GraphServiceStatusMessage =
  | { state: 'starting'; pid?: number; at: string }
  | { state: 'alive'; pid?: number; at: string }
  | {
      state: 'indexing';
      pid?: number;
      at: string;
      /** Absolute path of the project this indexing attempt is for. */
      path: string;
    }
  | {
      state: 'indexed';
      pid?: number;
      at: string;
      /** Absolute path of the project that finished indexing. */
      path: string;
      /** Raw node count from the backend — no coverage-gap interpretation. */
      nodes: number;
      /** Raw edge count from the backend — no coverage-gap interpretation. */
      edges: number;
      /**
       * Wall-clock time the index attempt took, in milliseconds. Always
       * present and honest (NFR1, AD-15) — never hidden regardless of
       * hardware speed or repo size.
       */
      elapsedMs: number;
      /**
       * Coverage summary sourced directly from the backend's own reporting
       * (FR2). Omitted when the best-effort `index_status` follow-up call
       * fails — that failure never turns this successful `index_repository`
       * result into an `error` status.
       */
      coverage?: IndexCoverageSummary;
    }
  | {
      state: 'exited';
      pid?: number;
      at: string;
      /** Process exit code. */
      code: number | null;
    }
  | {
      state: 'error';
      pid?: number;
      at: string;
      message: string;
      /** Process exit code, present when this error came from an unexpected exit. */
      code?: number | null;
      /**
       * Absolute path of the project this error is about, present when the
       * error came from a specific index attempt (an MCP-call failure or
       * timeout). Absent for subprocess-level errors (spawn failure,
       * unexpected exit) that aren't about any particular in-flight index.
       */
      path?: string;
      /**
       * Elapsed time of the failed index attempt, in milliseconds. Present
       * whenever this error came from an in-flight index attempt (mirrors
       * `path`'s presence) — never hidden (NFR1, AD-15). Absent for
       * subprocess-level errors unrelated to any particular index attempt.
       */
      elapsedMs?: number;
    };

/** Message main sends to ask the Graph Service subprocess to shut down cleanly. */
export interface GraphServiceShutdownRequest {
  type: 'graphService:shutdown';
}

/**
 * Message main sends to ask the Graph Service subprocess to index a project.
 * Sent after `spawnGraphService()` on a confirmed git-repo folder open (and,
 * to retry a failed index without needing a full folder re-pick, on a manual
 * Graph Service restart while a project is open).
 *
 * Story 1.6 (Phase 2) adds `activeBackend`/`cloudApiKey`: main resolves
 * which summary backend to generate with from the persisted backend
 * settings (backend-settings.ts) at the moment this request is sent, and
 * includes the freshly-decrypted cloud key when relevant — see
 * `GraphServiceBackendSwitchedRequest.cloudApiKey`'s doc comment for the
 * exact presence/absence rules, which apply here identically.
 */
export interface GraphServiceIndexRequest {
  type: 'graphService:index';
  /** Absolute, OS-native path to the project root to index. */
  path: string;
  /** Which summary backend to generate with for this project (Story 1.6, Phase 2). */
  activeBackend: CloudBackend;
  /** The decrypted cloud API key — see `GraphServiceBackendSwitchedRequest.cloudApiKey`'s doc comment. */
  cloudApiKey?: string;
}

/**
 * Message main sends to ask the Graph Service subprocess to switch its
 * active summary backend for the currently open project (Story 1.6, Phase
 * 2) — sent from `settingsSetActiveBackend`'s IPC handler when the backend
 * choice changes while a project is already open (a fresh `graphService:
 * index` for a newly-opened project already carries this same
 * `{activeBackend, cloudApiKey}` shape, so there's no separate "initial
 * backend" message).
 *
 * Triggers clearing every persisted summary for the current project via
 * `node-record-store.ts`'s existing merge-write API (`summary: undefined`
 * per Node — AD-20: a per-signal-family write, never a full-record wipe of
 * any other family) and re-queuing every Node through the same job pool —
 * never a partial/mixed-backend result set, and never a graph re-index
 * (AD-18, Boundaries & Constraints).
 */
export interface GraphServiceBackendSwitchedRequest {
  type: 'graphService:backendSwitched';
  /** The newly-active summary backend. */
  activeBackend: CloudBackend;
  /**
   * The decrypted cloud API key, present only when `activeBackend ===
   * 'cloud'` and a key is actually stored — decrypted transiently in main
   * (the only process with `safeStorage` access, per this story's Design
   * Notes) and never persisted or logged in the Graph Service. Absent when
   * switching to `'local'`, or when switching to `'cloud'` with no key
   * stored yet — generation is blocked in that case (Boundaries &
   * Constraints), and the renderer's own "cloud selected, no key"
   * Actionable Notice covers it, derived entirely from `BackendConfig`
   * rather than a new posted message.
   */
  cloudApiKey?: string;
}

// ---------------------------------------------------------------------------
// Story 1.3 (Phase 1): the Code Map (FR3/FR4).
//
// A map "Node" is a Function/Interface/Type/Module-labeled graph entity only
// (EXPERIENCE.md's "function/method/module name" atomic map unit) — never a
// raw Variable/Section/File/Folder/Project scaffolding entity. Edges are
// CALLS/IMPORTS/USAGE call/dependency edges only — never DEFINES/CONTAINS_*
// containment edges. See mcp-client.ts's `fetchCodeMap` for the exact Cypher
// this is sourced from.
//
// `file`/`startLine`/`endLine` follow AD-19: `file` is POSIX-relative to the
// project root, never absolute/OS-native. `startLine`/`endLine` are always
// `number` here even though the live backend's `query_graph` returns them as
// numeric-looking strings — `mcp-client.ts` parses them before this shape is
// ever constructed, so nothing downstream (this contract included) ever
// re-does that parsing or forgets it.
// ---------------------------------------------------------------------------

/** The map-eligible Node labels (Design Notes — a judgment call, not fixed by the backend's schema). */
export type CodeMapNodeKind = 'Function' | 'Interface' | 'Type' | 'Module';

/** The call/dependency edge kinds rendered on the Code Map (FR4) — never a containment edge. */
export type CodeMapEdgeKind = 'CALLS' | 'IMPORTS' | 'USAGE';

/**
 * A Node's summary-generation state (Story 1.5 Phase 2):
 *  - 'pending': eligible for generation (resolvable source, no coverage
 *    gap) but generation hasn't completed for it yet — renders a
 *    lightweight "summary pending" state, never a confident-looking
 *    placeholder.
 *  - 'ready': `summary` carries the generated one-line plain-language text.
 *  - 'coverage-gap': this Node's file is in the current index's coverage
 *    gap set (FR5) — ineligible for generation entirely; renders a real,
 *    distinct coverage-gap indicator (icon+text, never color-only), never a
 *    summary.
 */
export type SummaryStatus = 'pending' | 'ready' | 'coverage-gap';

export interface CodeMapNode {
  /** `qualified_name` — stable node identity, shown verbatim/monospace (Always: no summary content yet). */
  id: string;
  /** `name` — the bare identifier, verbatim from source. */
  name: string;
  /** POSIX-relative path to the file this Node is defined in (AD-19). */
  file: string;
  startLine: number;
  endLine: number;
  kind: CodeMapNodeKind;
  /**
   * Populated at `getCodeMap` fetch time from the Node record store's
   * current state (Story 1.5 Phase 2) — never null/undefined standing in
   * for "not generated yet" (AD-13's broader explicit-result-state pattern).
   */
  summaryStatus: SummaryStatus;
  /** The generated one-line plain-language summary — present only when `summaryStatus === 'ready'`. */
  summary?: string;
  /**
   * Story 1.8 Phase 3: whether this Node's summary has drifted from its
   * source since generation (the record store's `NodeRecord.stale`,
   * populated at `getCodeMap` fetch time by the same `classifyNode` step
   * that populates `summaryStatus`/`summary` above). Meaningful only when
   * `summaryStatus === 'ready'` — `true` only when the record's `stale`
   * flag is actually set; absent otherwise (never a default `false`
   * standing in for "not evaluated", matching `NodeRecord.stale`'s own
   * tri-state contract).
   */
  stale?: boolean;
}

export interface CodeMapEdge {
  /** Source Node's `id` (`qualified_name`). */
  source: string;
  /** Target Node's `id` (`qualified_name`). */
  target: string;
  kind: CodeMapEdgeKind;
}

/**
 * Result of fetching the Code Map — an explicit result state (AD-13's
 * broader pattern), never null/undefined standing in for "fetch failed."
 * The empty-map case (zero map-eligible nodes) is still `status: 'ok'` with
 * an empty `nodes` array; the renderer is what turns that into the explicit
 * empty-map state (Always: never a blank canvas) — it isn't a distinct wire
 * state, since the backend genuinely has nothing more to say.
 */
export type CodeMapResult =
  | { status: 'ok'; nodes: CodeMapNode[]; edges: CodeMapEdge[] }
  | { status: 'error'; message: string };

/**
 * Result of reading a Node's raw source range off disk (FR3/FR17
 * groundwork) — read-only, no editing surface (Non-Goal).
 */
export type ReadSourceRangeResult =
  | { status: 'ok'; content: string }
  | { status: 'error'; message: string };

/**
 * Message main sends to ask the Graph Service subprocess for the Code Map
 * of the most recently `indexed` project. Carries no path/params — the
 * Graph Service already knows which project it most recently finished
 * indexing (mirrors `graphService:index`'s per-project correlation without
 * repeating the path over this channel).
 */
export interface GraphServiceGetCodeMapRequest {
  type: 'graphService:getCodeMap';
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServiceGetCodeMapRequest`, over the same `parentPort` channel as
 * `GraphServiceStatusMessage` — distinguished from those by `type` rather
 * than `state` so main can route the two without ambiguity.
 */
export type GraphServiceCodeMapMessage =
  | { type: 'graphService:codeMap'; nodes: CodeMapNode[]; edges: CodeMapEdge[] }
  | { type: 'graphService:codeMapError'; message: string };

// ---------------------------------------------------------------------------
// Story 1.5 (Phase 1): local-model download/verify status (AD-18).
//
// A message stream distinct from `GraphServiceStatusMessage` even though
// `error` appears in both unions — the two are disambiguated by `type`
// (`'graphService:modelStatus'` here), the same convention
// `GraphServiceCodeMapMessage` already established, rather than by `state`
// alone (which collides). Posted by the Graph Service subprocess starting
// alongside `graphService:index` (kicked off in parallel with
// `indexRepository`, never sequentially after it — the pre-mortem finding
// this story's Intent calls out), independent of indexing's own status:
// a model failure never blocks/derails an indexing result, and vice versa.
//
// This phase's model-ready signal has no consumer yet beyond a small status
// indicator (Never: no summary generation, no Node-card rendering) — Story
// 1.5 Phase 2 is what actually consumes a `ready` state to start generating.
// ---------------------------------------------------------------------------

export type ModelStatusMessage =
  | {
      type: 'graphService:modelStatus';
      state: 'downloading';
      at: string;
      /** Bytes downloaded so far, per `node-llama-cpp`'s downloader progress. */
      downloadedBytes: number;
      /** Total expected bytes for the model file being downloaded. */
      totalBytes: number;
    }
  | {
      type: 'graphService:modelStatus';
      state: 'verifying';
      at: string;
    }
  | {
      type: 'graphService:modelStatus';
      state: 'ready';
      at: string;
      /** The verified model's filename (e.g. the GGUF tier that was downloaded). */
      model: string;
    }
  | {
      type: 'graphService:modelStatus';
      state: 'error';
      at: string;
      /**
       * Explicit, actionable failure text (a metadata-fetch failure, a
       * download failure, or a checksum mismatch) — never a silently
       * partial model (AD-18). The renderer's retry affordance reuses the
       * existing `restartGraphService` flow (same pattern as a
       * `GraphServiceStatusMessage` error), which respawns the subprocess
       * and re-sends `graphService:index` for the current project — that
       * re-triggers `ensureLocalModel()` in a fresh process, since a failed
       * attempt is not silently auto-retried within the same process
       * (matrix: "Retry affordance", not automatic retry).
       */
      message: string;
    };

// ---------------------------------------------------------------------------
// Story 1.5 (Phase 2): summary-generation progress (AD-8).
//
// A message stream distinct from both `GraphServiceStatusMessage` and
// `ModelStatusMessage` (own `type`, same disambiguation convention) —
// structural-indexing-complete and summary-generation progress are two
// distinct signals per AD-8: the Code Map stays browsable via the existing
// `getCodeMap` response while generation continues in the background.
// Posted batched (every ~1s or N completions, whichever first) rather than
// one message per Node (Always/AD-8) — `updated` carries however many Nodes
// completed generation since the last batch.
//
// `path` (review finding, Medium) is the generation run's project — the
// same absolute, OS-native path shape `RecentProject.path`/`ProjectOpenResult
// ['opened'].project.path` already use — carried so the renderer has a
// structural way to reject stale progress for a project it's since
// navigated away from, mirroring the `currentProjectPathRef`-style
// correlation pattern `App.tsx` already applies to `GraphServiceStatusMessage`
// (Story 1.2/1.4): without it, a progress message racing a project switch
// relied entirely on the backend never sending one late, rather than the
// renderer being able to defensively filter by the project actually on
// screen.
// ---------------------------------------------------------------------------

export interface SummaryProgressUpdate {
  /** The completed Node's `id` (`qualified_name`). */
  id: string;
  /** The generated one-line plain-language summary. */
  summary: string;
}

export interface SummaryProgressMessage {
  type: 'graphService:summaryProgress';
  /** Absolute, OS-native path of the project this progress batch is for. */
  path: string;
  updated: SummaryProgressUpdate[];
}

// ---------------------------------------------------------------------------
// Story 1.5 (Phase 3): hardware-adequacy advisory (Intent, Boundaries &
// Constraints).
//
// A message stream distinct from `ModelStatusMessage`/`SummaryProgressMessage`
// (own `type`, same disambiguation convention) — `services/graph-service/
// index.ts` combines two independent signals into this one post:
//  - 'constrained-tier': Phase 1's own tier-selection heuristic already
//    signals constrained hardware (the fallback tier was chosen), surfaced
//    once the local model is `ready`. No new GPU/hardware-detection
//    dependency — reuses `LocalModelReady.tier` (Design Notes).
//  - 'degenerate-results': `summary-generator.ts`'s reactive rolling
//    completed/degenerate-result rate crossed its threshold within the
//    current generation run (a *rate*, never a single fluke — Boundaries &
//    Constraints).
//
// Informational only (Boundaries & Constraints): this never claims a
// "switch to cloud" action exists, since Story 1.6 (the actual cloud-key
// backend) doesn't exist yet — the renderer's Actionable Notice for this
// message carries no action button, just an honest, reason-specific
// sentence. Sent at most once per signal source per project session (Code
// Map: "no repeat spam") — `index.ts` tracks that, not the renderer.
// ---------------------------------------------------------------------------

/** Which hardware-adequacy signal triggered the advisory — see `HardwareAdvisoryMessage`'s doc comment. */
export type HardwareAdvisoryReason = 'constrained-tier' | 'degenerate-results';

export interface HardwareAdvisoryMessage {
  type: 'graphService:hardwareAdvisory';
  reason: HardwareAdvisoryReason;
}

// ---------------------------------------------------------------------------
// Story 1.6 (Phase 1): cloud API key storage (FR6, AD-4).
//
// driller's first Settings UI surface and its first `safeStorage`
// integration (see apps/desktop/main/backend-settings.ts). The cloud API
// key is stored only as `safeStorage.encryptString()` ciphertext — this
// contract never carries the raw key back out to the renderer; the
// renderer only ever learns whether a key is stored (`hasCloudKey`), never
// its value. `isLinuxInsecureBackend` mirrors
// `safeStorage.getSelectedStorageBackend()` reporting `basic_text` (no
// secure OS keystore available) so the renderer can render the Linux
// warning proactively, not only in reaction to a `SetCloudApiKeyResult`
// with `status: 'warning'`.
//
// This phase only proves the configuration surface is trustworthy — no
// actual cloud API call happens here (Story 1.6 Phase 2's job).
// ---------------------------------------------------------------------------

/** The two summary backends a Settings user can choose between (Story 1.6). */
export type CloudBackend = 'local' | 'cloud';

export interface BackendConfig {
  activeBackend: CloudBackend;
  /** True once a cloud API key ciphertext is persisted — never the key itself. */
  hasCloudKey: boolean;
  /** True on Linux with no secure OS keystore (`safeStorage` reports `basic_text`). */
  isLinuxInsecureBackend: boolean;
}

/**
 * Result of a `setCloudApiKey` attempt:
 *  - `'ok'`: stored as ciphertext.
 *  - `'warning'`: Linux with no secure keystore and no acknowledgment yet —
 *    nothing was stored; `message` is the warning text to show the user, who
 *    must resubmit with `acknowledgeInsecureStorage: true` to actually store
 *    the key.
 *  - `'error'`: encryption unavailable, a write failure, or invalid input
 *    (e.g. an empty key) — `message` is safe, user-facing text; the raw key
 *    never appears in it, on this or any other path (AD-21, security audit
 *    finding).
 */
export interface SetCloudApiKeyResult {
  status: 'ok' | 'warning' | 'error';
  message?: string;
}

// ---------------------------------------------------------------------------
// Story 1.8 (Phase 4): on-demand single-Node regeneration (AD-7).
//
// `node:regenerate` is this app's first id-keyed *mutating* IPC channel —
// every prior IPC surface is read-only (Design Notes). The renderer sends a
// request keyed by exactly one Node ID (from the Node Detail panel's
// Regenerate button, shown only for a stale Node); main relays it to the
// Graph Service and the reply reports the outcome for that Node only, never
// a broader re-index or whole-project regeneration (Boundaries &
// Constraints).
//
// `RegenerateNodeResult` mirrors `CodeMapResult`'s own explicit-result-state
// shape (AD-13): on success, `node` carries the exact same annotated shape
// `getCodeMap` produces (via `annotateNodesWithSummaryState`), so the
// renderer can patch its already-rendered Node set in place without a
// refetch. On any failure (unreadable source, degenerate output, no usable
// backend, Node not found, an already-in-flight request for the same Node,
// or the coverage-gap exclusion), the existing record is left completely
// untouched and `message` carries safe, user-facing text.
// ---------------------------------------------------------------------------

export type RegenerateNodeResult =
  | { status: 'ok'; node: CodeMapNode }
  | { status: 'error'; message: string };

/**
 * Message main sends to ask the Graph Service subprocess to regenerate one
 * Node's summary. Unlike `GraphServiceGetCodeMapRequest`, this carries a
 * `nodeId` — main correlates the eventual `graphService:regenerateNodeResult`
 * reply back to the right renderer-side request via a `Map<nodeId, {resolve,
 * reject}>` (generalizing `pendingCodeMapResolve`'s single slot), since
 * multiple regenerate requests for different Nodes can legitimately be in
 * flight at once (Boundaries & Constraints: a second request for the SAME
 * Node already in flight is rejected immediately in main instead, never
 * reaching this message).
 */
export interface GraphServiceRegenerateNodeRequest {
  type: 'graphService:regenerateNode';
  /** The Node's `qualified_name`-derived `id` (AD-19) — exactly one Node, never a batch. */
  nodeId: string;
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServiceRegenerateNodeRequest`, over the same `parentPort` channel as
 * every other Graph Service message — distinguished by `type`, same
 * convention as `GraphServiceCodeMapMessage`. `nodeId` echoes the request so
 * main can settle the exact pending entry this reply is for, even though
 * `result`'s own `node.id` (on success) already carries the same value.
 */
export interface GraphServiceRegenerateNodeResultMessage {
  type: 'graphService:regenerateNodeResult';
  nodeId: string;
  result: RegenerateNodeResult;
}

// ---------------------------------------------------------------------------
// Story 1.9 (Phase 1): Path Trace (FR10, AD-13).
//
// A transport-agnostic `traceCallPath` (packages/graph-contracts) reached
// through a new, dedicated, strictly read-only `path:trace` IPC round trip
// (Boundaries & Constraints) — never touching the Node record store,
// `activeCodeMapNodes`, or generation/staleness state; the Graph Service
// handler re-fetches nodes+edges via the existing `fetchCodeMap(activeProject)`
// on every call instead of adding new cached state (mirrors
// `handleGetCodeMapRequest`). No search UI or route highlighting yet
// (Phase 2) — this phase is callable directly via `window.driller.
// tracePath(query)` (e.g. from the DevTools console).
// ---------------------------------------------------------------------------

/**
 * Message main sends to ask the Graph Service subprocess to trace a call
 * path from a query-resolved entry Node. Carries `query` (unlike
 * `GraphServiceGetCodeMapRequest`, which carries no params) since a Path
 * Trace is parameterized per call — mirrors `GraphServiceRegenerateNodeRequest`'s
 * `nodeId` in that both add extra fields on top of the bare `{type}` shape
 * `GraphServiceGetCodeMapRequest` establishes.
 *
 * `requestId` is a main-generated correlation token (Spec Change Log,
 * post-review hardening), echoed back verbatim in
 * `GraphServicePathTraceResultMessage.requestId` — same correlation role
 * `GraphServiceRegenerateNodeRequest.nodeId` already plays for its own
 * reply, needed here because `path:trace` has only a single pending-request
 * slot in main (unlike `nodeId`'s per-Node `Map`): without an id the Graph
 * Service echoes back, main cannot tell a genuine reply for the request
 * currently occupying that slot apart from a late reply for an earlier
 * request that already timed out and had its slot reassigned to a newer
 * one — see `pendingPathTraceToken`'s doc comment in apps/desktop/main/
 * index.ts for the exact race this closes.
 */
export interface GraphServicePathTraceRequest {
  type: 'graphService:pathTrace';
  query: string;
  requestId: number;
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServicePathTraceRequest`, over the same `parentPort` channel as
 * every other Graph Service message — distinguished by `type`, same
 * convention as `GraphServiceCodeMapMessage`/
 * `GraphServiceRegenerateNodeResultMessage`. `result` is `PathTraceResult`
 * itself (imported from `@driller/graph-contracts` above) — this message
 * type only wraps it for the `parentPort` channel, never redefines its
 * result states. `requestId` echoes `GraphServicePathTraceRequest.requestId`
 * verbatim — see that field's own doc comment for why this correlation is
 * needed.
 */
export interface GraphServicePathTraceResultMessage {
  type: 'graphService:pathTraceResult';
  requestId: number;
  result: PathTraceResult;
}

// ---------------------------------------------------------------------------
// Story 1.9 (Phase 4): the local-only diagnostic log sink (AD-21).
//
// driller's first diagnostic log sink, and its first departure from the
// `electron-store`-under-`userData` pattern (settings.ts/backend-settings.ts)
// — see apps/desktop/main/diagnostic-log.ts's own doc comment for why an
// append-only event log is a different shape than that single-blob store.
//
// `DiagnosticLogEntry` is a discriminated union on `eventType` — this phase
// implements exactly one member, `'path-trace-dismissed'`, posted when the
// user clicks "Dismiss" on a `found`/`no-path-found`/`ambiguous` Path Trace
// result (Story 1.9, Phases 1-3). Designed for reuse: a future Epic 2 Risk
// Overlay event type extends this union with a new member rather than
// redefining this one (Never: no other `eventType` is added in this phase).
// ---------------------------------------------------------------------------

/** One local-only diagnostic log entry — never transmitted anywhere (AD-21). */
export type DiagnosticLogEntry = {
  eventType: 'path-trace-dismissed';
  /** ISO-8601 timestamp of the dismissal. */
  timestamp: string;
  /** The Path Trace query that produced the dismissed result. */
  query: string;
  /**
   * The dismissed result's status — matches the AC's explicit list
   * (`found`/`no-path-found`/`ambiguous`); Dismiss never renders for
   * `searching`/`idle`/`error`, so no other value ever reaches this field.
   */
  resultStatus: 'found' | 'no-path-found' | 'ambiguous';
};

// ---------------------------------------------------------------------------
// Story 1.10 (Phase 1): external editor preference (AD-23).
//
// A required, always-populated Settings field — Phase 2's external-editor
// hand-off (this app's first `shell.openExternal`/`shell.openPath` call
// site) reads it to decide which editor to launch and whether it can
// exact-line-jump. No consumer exists yet in this phase (Never); the field
// simply must never be undefined/unset once read, per AD-23.
//
// Persisted via `apps/desktop/main/editor-settings.ts`'s own
// `electron-store` file (AD-5) — a separate store from
// backend-settings.ts's `activeBackend`/cloud-key fields (Never: no change
// to that existing store), following the same shape (Schema + defaults +
// coerce-with-safe-fallback).
// ---------------------------------------------------------------------------

/**
 * The three external-editor choices a Settings user can pick between.
 * `'system-default'` is the always-safe fallback (no line-jump support in
 * Phase 2); `'vscode'`/`'jetbrains'` get exact-line-jump there.
 */
export type EditorPreference = 'vscode' | 'jetbrains' | 'system-default';

// ---------------------------------------------------------------------------
// IPC channel names — namespaced `<domain>:<action>`
// ---------------------------------------------------------------------------

export const IpcChannels = {
  projectOpen: 'project:open',
  projectOpenPath: 'project:openPath',
  projectListRecent: 'project:listRecent',
  graphServiceStatus: 'graphService:status',
  graphServiceRestart: 'graphService:restart',
  codeMapGet: 'codeMap:get',
  sourceReadRange: 'source:readRange',
  modelStatus: 'model:status',
  summaryProgress: 'summary:progress',
  hardwareAdvisory: 'hardware:advisory',
  settingsGetBackendConfig: 'settings:getBackendConfig',
  settingsSetActiveBackend: 'settings:setActiveBackend',
  settingsSetCloudApiKey: 'settings:setCloudApiKey',
  settingsGetEditorPreference: 'settings:getEditorPreference',
  settingsSetEditorPreference: 'settings:setEditorPreference',
  nodeRegenerate: 'node:regenerate',
  pathTrace: 'path:trace',
  diagnosticLog: 'diagnostic:log',
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

// ---------------------------------------------------------------------------
// The contextBridge-exposed renderer API surface (AD-11).
// Preload implements this; renderer only ever calls through it.
// ---------------------------------------------------------------------------

export interface DrillerApi {
  /** Shows a native folder picker, then runs the full open-folder flow. */
  openFolder: () => Promise<ProjectOpenResult>;
  /** Re-opens a known path from the Recent Projects list. */
  openRecentProject: (path: string) => Promise<ProjectOpenResult>;
  /** Lists persisted recent projects, most-recently-opened first. */
  listRecentProjects: () => Promise<RecentProject[]>;
  /** Manually retries spawning the Graph Service after it failed to start. */
  restartGraphService: () => Promise<{ ok: boolean }>;
  /** Subscribes to Graph Service status changes; returns an unsubscribe function. */
  onGraphServiceStatus: (
    callback: (status: GraphServiceStatusMessage) => void,
  ) => () => void;
  /**
   * Subscribes to the local-model download/verify status stream (Story 1.5
   * Phase 1, AD-18) — a separate signal from `onGraphServiceStatus`'s
   * indexing status, since the two run in parallel and either can fail
   * independently of the other. Returns an unsubscribe function.
   */
  onModelStatus: (callback: (status: ModelStatusMessage) => void) => () => void;
  /**
   * Subscribes to batched summary-generation progress (Story 1.5 Phase 2,
   * AD-8) — a stream distinct from both `onGraphServiceStatus` and
   * `onModelStatus`, since generation runs in the background after the Code
   * Map is already showing. Returns an unsubscribe function.
   */
  onSummaryProgress: (callback: (message: SummaryProgressMessage) => void) => () => void;
  /**
   * Subscribes to the hardware-adequacy advisory stream (Story 1.5 Phase 3)
   * — a non-blocking, informational-only nudge toward the cloud path
   * (Story 1.6, not yet built), distinct from both `onModelStatus` and
   * `onSummaryProgress`. Returns an unsubscribe function.
   */
  onHardwareAdvisory: (callback: (message: HardwareAdvisoryMessage) => void) => () => void;
  /**
   * Fetches the Code Map (Nodes + call/dependency edges) for the most
   * recently `indexed` project. Called once per successful `indexed` state
   * — never re-fetched on every render.
   */
  getCodeMap: () => Promise<CodeMapResult>;
  /**
   * Reads a Node's exact source line range off disk, read-only (FR3/FR17
   * groundwork) — `file` is the Node's POSIX-relative path (AD-19),
   * `startLine`/`endLine` are 1-indexed and inclusive.
   */
  readSourceRange: (
    file: string,
    startLine: number,
    endLine: number,
  ) => Promise<ReadSourceRangeResult>;
  /**
   * Fetches the current backend config (Story 1.6 Phase 1): the active
   * local/cloud choice, whether a cloud key is already stored, and whether
   * this machine is Linux with no secure OS keystore.
   */
  getBackendConfig: () => Promise<BackendConfig>;
  /** Sets the active summary backend (local/cloud) choice. */
  setActiveBackend: (backend: CloudBackend) => Promise<void>;
  /**
   * Attempts to store a cloud API key as ciphertext. On Linux with no
   * secure keystore, the first call (without `acknowledgeInsecureStorage`)
   * returns `status: 'warning'` and stores nothing; resubmit with
   * `acknowledgeInsecureStorage: true` to actually store it. The raw key is
   * only ever transiently held in main for the duration of this call — main
   * never returns it back to the renderer, logs it, or retains it beyond the
   * encrypt call.
   */
  setCloudApiKey: (
    key: string,
    acknowledgeInsecureStorage?: boolean,
  ) => Promise<SetCloudApiKeyResult>;
  /**
   * Fetches the current external editor preference (Story 1.10, Phase 1,
   * AD-23) — always resolves to one of the three known values, never
   * undefined/unset, even on first launch (`'system-default'`, the
   * persisted default) or after the store coerces a corrupted value back to
   * it.
   */
  getEditorPreference: () => Promise<EditorPreference>;
  /** Sets the external editor preference choice. */
  setEditorPreference: (value: EditorPreference) => Promise<void>;
  /**
   * Regenerates exactly one Node's summary on demand (Story 1.8, Phase 4) —
   * this app's first id-keyed mutating IPC round-trip. Scoped to `nodeId`
   * only: never triggers a broader re-index or whole-project generation run
   * (AD-7), and never runs except from this explicit call. A second call for
   * a Node already in flight resolves immediately with an explicit error
   * (Boundaries & Constraints) rather than queuing behind the first.
   */
  regenerateNode: (nodeId: string) => Promise<RegenerateNodeResult>;
  /**
   * Traces the call-reachable subgraph from a query-resolved entry Node
   * (Story 1.9, Phase 1, FR10) — a read-only round trip to
   * `packages/graph-contracts`'s `traceCallPath` via the Graph Service.
   * Callable directly (e.g. from the DevTools console); no search UI or
   * route-highlighting consumer exists yet (Phase 2).
   */
  tracePath: (query: string) => Promise<PathTraceResult>;
  /**
   * Fire-and-forget: appends one entry to driller's local-only diagnostic
   * log (Story 1.9, Phase 4, AD-21). Never rejects — a log-write failure is
   * swallowed/console-logged in main only, never surfaced to the caller or
   * allowed to block whatever UI action triggered it.
   */
  logDiagnosticEvent: (entry: DiagnosticLogEntry) => Promise<void>;
}
