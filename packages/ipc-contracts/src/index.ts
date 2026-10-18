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
 * than redefined ad hoc (see `PathTraceResult`'s import below). P4-6 moved
 * every other Graph Service operation result shape there as well; this
 * package re-exports them.
 */

import type {
  BlastRadiusExpansionResult,
  CodeMapEdge,
  CodeMapNode,
  CrossSectionEdgeCount,
  DiffScopeResult,
  EntryCandidatesResult,
  FoldedModule,
  FoldedType,
  IndexCoverageSummary,
  PathTraceResult,
  SectionNodeCount,
  UnknownSectionResult,
} from '@driller/graph-contracts';

/**
 * P4-6 (AD-13): every Graph Service operation's result shape — and each
 * graph shape those results carry (`CodeMapNode`/`CodeMapEdge` and their
 * types, `GapFile`) — is declared once in `@driller/graph-contracts` and re-exported
 * here unchanged, so every existing `@driller/ipc-contracts` import keeps
 * compiling. Never redeclare one of these here: `graph-contracts`'s
 * `contractHome.test.ts` fails if this file does.
 */
export type {
  PathTraceResult,
  GapFile,
  IndexCoverageSummary,
  CodeMapNodeKind,
  SummaryStatus,
  RiskSignalFamily,
  RiskSignalLocation,
  DeterministicRiskSignalType,
  DeterministicRiskSignal,
  DeterministicRiskSeverity,
  LlmJudgmentRiskSignal,
  IngestedRiskSignal,
  RiskSignal,
  CodeMapNode,
  TestedBy,
  TestedByTest,
  TestedByFile,
  FileTopLevelUse,
  FoldedModule,
  TopLevelChangedFile,
  ChangedContract,
  ChangedLineRange,
  FoldedType,
  FoldedTypeKind,
  FoldedTypeUserKindCount,
  TypeUse,
  SimilarImplementation,
  CodeMapEdgeKind,
  CodeMapEdge,
  DiffScopeResult,
  BlastRadiusExpansionResult,
  EntryCandidatesResult,
  EntryCandidate,
  EntryCandidateRelation,
  NodeLookupResult,
  CoverageSummaryResult,
  UnknownSectionResult,
  SectionNodeCount,
  CrossSectionEdgeCount,
  CrossSectionCall,
  SectionChangeCount,
} from '@driller/graph-contracts';

/**
 * P0-5: re-exported so the renderer (whose only contracts dependency is this
 * package) reads the same hop bound the Graph Service's Blast Radius badge
 * uses — for PR Review's initial stepper depth and the Blast Radius chip's
 * tooltip/accessible name ("within N hops"), never a second literal.
 */
export {
  BLAST_RADIUS_DEFAULT_HOPS,
  CROSS_SECTION_CALLS_MAX,
  // P4-7g: the per-project pin cap — main's setting and Node detail's "Pin limit (50) reached".
  ENTRY_PINS_MAX,
  FOLDED_TYPE_IPC_MAX_USED_BY,
  SIMILAR_TO_MAX_ENTRIES,
  SIMILAR_TO_MIN_JACCARD,
  TESTED_BY_MAX_TESTS,
} from '@driller/graph-contracts';

/**
 * P4-7e: re-exported so the renderer's drill (`revealView.ts`) walks the very
 * adjacency a candidate's reach counts — `CALLS` and `USAGE` only, never
 * `IMPORTS` — with no second implementation and no Graph Service call per
 * expand (Option C was rejected).
 */
export { entryReachAdjacency } from '@driller/graph-contracts';
export type { BidirectionalAdjacency } from '@driller/graph-contracts';

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
// Phase 2: coverage/scale transparency (FR2, NFR1, AD-15) — `GapFile` and
// `IndexCoverageSummary` are declared once in `@driller/graph-contracts`
// (P4-6) and re-exported above.
// ---------------------------------------------------------------------------

/**
 * P5-a review round 1: why a re-index runs — the open project's checkout
 * moved from `indexedHead` to `currentHead` (full commit SHAs). Main adds it
 * to the `indexing`/`indexed` statuses of the re-index it started for a
 * `graphService:headChanged`, so the renderer can say so (never a silent
 * reset of PR Review). The Graph Service itself never sets it.
 */
export interface HeadMove {
  indexedHead: string;
  currentHead: string;
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
      /** P5-a review round 1: set by main on a HEAD-triggered re-index. */
      headMoved?: HeadMove;
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
      /** P5-a review round 1: set by main on a HEAD-triggered re-index. */
      headMoved?: HeadMove;
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
      /** P5-a review round 1: set by main when a HEAD-triggered re-index fails. */
      headMoved?: HeadMove;
    };

/** Message main sends to ask the Graph Service subprocess to shut down cleanly. */
export interface GraphServiceShutdownRequest {
  type: 'graphService:shutdown';
  /**
   * True only for an actual app quit (Bug fix, 2026-09-23) — main's
   * `before-quit` handler sets this, its `graphServiceRestart` IPC
   * handler's `forceRespawn` path (a mid-session subprocess restart while
   * the app stays open, e.g. the MCP-listener Retry button) does not. Tells
   * the subprocess whether to also retire CBM's background daemon
   * (`mcp-client.ts`'s `stopCbmDaemon`) as part of this shutdown — a
   * mid-session restart has no reason to pay a cold-daemon-restart cost
   * for the very next call, and CBM staleness/version-conflict issues are
   * specifically a cross-session concern, not a within-session one.
   */
  stopCbmDaemon?: boolean;
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
  /**
   * This project's `ProjectScopeConfig.includedPaths` (Bug fix,
   * 2026-09-23), read from the persisted per-project settings at the moment
   * this request is sent — same "resolved in main, handed over as a plain
   * value" shape as `activeBackend`/`cloudApiKey` above. Omitted/empty means
   * no restriction, see `ProjectScopeConfig`'s own doc comment.
   */
  includedPaths?: string[];
  /**
   * P4-7g (AD-5 "Entry pins"): this project's pinned Node ids, in pin order,
   * read from the UI settings store at the moment this request is sent — the
   * Graph Service ranks them first in `listEntryCandidates`, for the IPC
   * channel and the MCP tool alike (FR-15). Omitted when there are none.
   * Later changes arrive as `GraphServiceSetEntryPinsRequest`.
   */
  entryPins?: string[];
}

/**
 * P4-7g (AD-5 "Entry pins"): main sends this after the renderer changes a
 * project's pins (`settings:setEntryPins`) — `pinnedIds` is what the store
 * now holds, in pin order. The Graph Service applies it only when
 * `projectPath` is the project it is indexing or has indexed (otherwise
 * ignored), and drops its entry-candidate memos so the next listing ranks
 * the new pins. Posts nothing back.
 */
export interface GraphServiceSetEntryPinsRequest {
  type: 'graphService:setEntryPins';
  projectPath: string;
  pinnedIds: string[];
}

/**
 * P4-7g review round 1: the Graph Service's report, when it caches a new
 * whole-scope map (the fetch after an index, or any refetch), of the pinned
 * ids that are not on it — so main logs a missing pin once per session even
 * when no listing is asked for (AD-21, local only). Posted only when there
 * is at least one.
 */
export interface GraphServiceEntryPinsMissingMessage {
  type: 'graphService:entryPinsMissing';
  projectPath: string;
  nodeIds: string[];
}

/**
 * P5-a (founder decision 6.1): main asks the Graph Service whether the open
 * project's checkout moved since it was indexed — sent when the app window
 * regains focus. The Graph Service answers only on drift, with
 * `GraphServiceHeadChangedMessage`; otherwise it posts nothing.
 */
export interface GraphServiceCheckHeadRequest {
  type: 'graphService:checkHead';
  /** Absolute, OS-native project root (main's `currentProjectPath`). */
  path: string;
}

/**
 * P5-a: the Graph Service found HEAD at `currentHead` while the index it
 * serves was taken at `indexedHead` (both full commit SHAs). Posted at most
 * once per distinct `currentHead`, never while an index is in flight. Main
 * re-sends the index request for `path` when it is the open project and the
 * Graph Service is running; anything else is logged and ignored.
 */
export interface GraphServiceHeadChangedMessage {
  type: 'graphService:headChanged';
  path: string;
  indexedHead: string;
  currentHead: string;
}

/**
 * P4-7g review round 1: the reply to `setEntryPins` — one id pinned or
 * unpinned by main against the list it has stored (never a whole list from
 * the renderer, which could be stale).
 *  - `'stored'`: `pins` is the stored list now, in pin order;
 *  - `'limit'`: pinning would pass `ENTRY_PINS_MAX`; nothing changed, `pins`
 *    is the stored list;
 *  - `'error'`: nothing changed (a malformed call, or the stored pins could
 *    not be read — main never overwrites a list it hasn't read).
 */
export type EntryPinUpdateResult =
  | { status: 'stored'; pins: string[] }
  | { status: 'limit'; pins: string[] }
  | { status: 'error'; message: string };

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

// `CodeMapNode`, `CodeMapEdge` and their own types (`CodeMapNodeKind`,
// `CodeMapEdgeKind`, `SummaryStatus`, the Risk Signal family types) are
// declared once in `@driller/graph-contracts` (P4-6) and re-exported above.

/**
 * Result of fetching the Code Map — an explicit result state (AD-13's
 * broader pattern), never null/undefined standing in for "fetch failed."
 * The empty-map case (zero map-eligible nodes) is still `status: 'ok'` with
 * an empty `nodes` array; the renderer is what turns that into the explicit
 * empty-map state (Always: never a blank canvas) — it isn't a distinct wire
 * state, since the backend genuinely has nothing more to say.
 */
export type CodeMapResult =
  | {
      status: 'ok';
      nodes: CodeMapNode[];
      edges: CodeMapEdge[];
      /**
       * P2-5: how many Nodes the project's indexing scope filter removed from
       * this map (`filterCodeMapToScope`) — 0 when no scope is set. Lets the
       * renderer tell "the scope hid everything" apart from "the project has
       * no map-eligible Nodes" when `nodes` is empty.
       */
      hiddenByScope: number;
      /**
       * P2-5: the indexing scope the Graph Service actually filtered this map
       * with (its `activeIncludedPaths` at filter time) — `[]` means no scope.
       * Carried with the map so the empty-map notice names the scope that
       * produced it, never a persisted value that may not have applied yet.
       */
      appliedScope: string[];
      /**
       * P4-2 phase 3b: the Type/Interface Nodes folded off this map (see
       * `FoldedType`), scope-filtered like `nodes`, sorted by id, each
       * `usedBy` capped at `FOLDED_TYPE_IPC_MAX_USED_BY` (`usedByTotal` is
       * the full count). Node
       * detail's "Uses" links and Path Trace's "is a type" notice resolve
       * against it.
       */
      foldedTypes: FoldedType[];
      /**
       * P4-2 phase 3c: the Module Nodes folded off this map (see
       * `FoldedModule`), scope-filtered like `nodes`. Only the "Show types &
       * modules" canvas toggle reads it, to draw them back as render-only
       * Nodes; nothing that computes a number does.
       */
      foldedModules: FoldedModule[];
      /**
       * P4-4 phase 1b: the section this map is for — the requested
       * allowlist entry, or `null` for the whole scope (no `section` asked
       * for). With a section, `nodes`/`edges`/`foldedTypes`/`foldedModules`
       * hold only that section's files (nearest-section rule) and every
       * severity is cut over the section alone; `hiddenByScope` and
       * `appliedScope` keep their whole-scope meaning.
       */
      section: string | null;
      /**
       * P4-4 phase 1b: one entry per `appliedScope` path, in allowlist order,
       * with the whole-scope Nodes it owns (`[]` with no scope) — the Section
       * bar's tab labels.
       */
      sections: SectionNodeCount[];
      /**
       * P4-4 phase 3a (section maps only): one entry per other allowlist
       * section with at least one whole-scope edge (`CALLS`/`IMPORTS`/
       * `USAGE`) between it and `section`, split by direction (`outgoing`:
       * this section → that one; `incoming`: that one → this) — the edges this
       * map's both-endpoints filter dropped, counted before the filter, never
       * by subtracting. Sorted by `outgoing + incoming` (highest first), then
       * section. Absent when there are none, and always absent when `section`
       * is `null`.
       */
      crossSectionEdges?: CrossSectionEdgeCount[];
    }
  /** P4-4 phase 1b: the requested `section` is not in the allowlist. */
  | UnknownSectionResult
  | { status: 'error'; message: string };

/**
 * Result of reading a Node's raw source range off disk (FR3/FR17
 * groundwork) — read-only, no editing surface (Non-Goal).
 */
export type ReadSourceRangeResult =
  | { status: 'ok'; content: string }
  | { status: 'error'; message: string };

/**
 * Result of the external-editor hand-off (Story 1.10, Phase 2, AD-23) —
 * `'ok'` covers both a successful line-jump launch (`vscode`/`jetbrains`)
 * and a successful `system-default` `shell.openPath` call; every failure
 * path (a malformed request, a containment violation from the shared
 * `resolveProjectFilePath` resolution, an `openExternal` rejection, or a
 * non-empty `openPath` result) resolves to an explicit
 * `{status: 'error', stage, message}` — never a silent no-op (Always).
 *
 * `stage` (review finding, post-implementation fix) distinguishes how far
 * the attempt got before failing: `'validate'` (a malformed request or no
 * project open) and `'resolve'` (a containment violation) both failed
 * before any launch was even attempted; only `'launch'` (an `openExternal`
 * rejection, or a non-empty `openPath` result) means the configured
 * editor/handler itself is unavailable. A caller must not apply "editor not
 * found / check install or Settings" framing to a `'validate'`/`'resolve'`
 * failure — that framing is only accurate for `'launch'`.
 */
export type OpenInEditorResult =
  | { status: 'ok' }
  | { status: 'error'; stage: 'validate' | 'resolve' | 'launch'; message: string };

/**
 * Message main sends to ask the Graph Service subprocess for the Code Map
 * of the most recently `indexed` project. Carries no path/params — the
 * Graph Service already knows which project it most recently finished
 * indexing (mirrors `graphService:index`'s per-project correlation without
 * repeating the path over this channel).
 */
export interface GraphServiceGetCodeMapRequest {
  type: 'graphService:getCodeMap';
  /**
   * P4-4 phase 1b: one indexing-scope allowlist entry to map on its own.
   * Omitted means the whole scope (never the string `"all"`).
   */
  section?: string;
  /**
   * P5-b founder decision 2: `true` bypasses the raw map cache and re-reads
   * the map from the backend (the map's Retry). Omitted on every other
   * request (a section switch or a reload is served from the cache).
   */
  force?: true;
}

/**
 * P5-b founder decision 2: options for `DrillerApi.getCodeMap`. `force`
 * re-reads the map from the backend instead of serving it from the Graph
 * Service's raw cache — the map's Retry buttons only.
 */
export interface GetCodeMapOptions {
  force?: boolean;
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServiceGetCodeMapRequest`, over the same `parentPort` channel as
 * `GraphServiceStatusMessage` — distinguished from those by `type` rather
 * than `state` so main can route the two without ambiguity.
 */
export type GraphServiceCodeMapMessage =
  | {
      type: 'graphService:codeMap';
      nodes: CodeMapNode[];
      edges: CodeMapEdge[];
      hiddenByScope: number;
      appliedScope: string[];
      /** P4-2 phase 3b: see `CodeMapResult.foldedTypes`. */
      foldedTypes: FoldedType[];
      /** P4-2 phase 3c: see `CodeMapResult.foldedModules`. */
      foldedModules: FoldedModule[];
      /**
       * P4-4 phase 1b: the request's `section` echoed (`null` when it had
       * none) — main checks it against the request it is settling; see
       * `CodeMapResult.section`.
       */
      section: string | null;
      /** P4-4 phase 1b: see `CodeMapResult.sections`. */
      sections: SectionNodeCount[];
      /** P4-4 phase 3a: see `CodeMapResult.crossSectionEdges`. */
      crossSectionEdges?: CrossSectionEdgeCount[];
    }
  /** P4-4 phase 1b: see `UnknownSectionResult`; `section` echoes the request. */
  | { type: 'graphService:codeMapUnknownSection'; section: string; knownSections: string[] }
  | {
      type: 'graphService:codeMapError';
      message: string;
      /**
       * P4-4c review round 1: the request's `section` echoed (`null` for the
       * whole scope) when the error is a reply to a Code Map request, so main
       * can drop a stale one. Absent on an error that cannot echo one (a
       * malformed request); main then settles the request in flight.
       */
      section?: string | null;
    };

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
// Story 2.2 (Phase 2): LLM-judgment generation progress (FR8, AD-8).
//
// A message stream distinct from `SummaryProgressMessage` — never repurposing
// its `summary`-shaped field for a judgment (Boundaries & Constraints) — but
// otherwise structurally identical: batched (never one message per Node),
// carrying the same `path` correlation field for the same reason
// `SummaryProgressMessage.path` exists (a renderer can reject a stale batch
// for a project it's since navigated away from). No renderer subscription
// consumes this yet (Phase 3's job) — `onLlmJudgmentProgress` exists on the
// preload bridge below but is unused until then.
// ---------------------------------------------------------------------------

export interface LlmJudgmentProgressUpdate {
  /** The completed Node's `id` (`qualified_name`). */
  id: string;
  /** The generated one-sentence risk judgment. */
  judgment: string;
}

export interface LlmJudgmentProgressMessage {
  type: 'graphService:llmJudgmentProgress';
  /** Absolute, OS-native path of the project this progress batch is for. */
  path: string;
  updated: LlmJudgmentProgressUpdate[];
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
// Story 5.2: MCP listener bind/error status (epic-5-context.md; spec-5-2).
//
// A message stream distinct from `GraphServiceStatusMessage` even though the
// subprocess it's posted from is the same one — own `type`, same
// disambiguation convention `HardwareAdvisoryMessage`/`ModelStatusMessage`
// already established. Never folded into `GraphServiceStatusMessage`'s own
// union: the Graph Service subprocess can be genuinely `'alive'`/`'indexed'`
// while only its MCP sub-component (services/graph-service/mcp-server.ts's
// own HTTP listener) has failed to bind or errored — conflating the two
// would misrepresent overall subprocess health.
//
// Explicit and enumerated (AD-13's broader pattern): never
// null/undefined standing in for "no signal yet." `'listening'` is posted
// once, from the listener's own successful-bind path, so there's a positive
// confirmation the whole mechanism is actually wired up — not just an
// absence of an `'unavailable'` post, which could equally mean "never
// checked." `'unavailable'` is posted from the listener's own `error` event
// (e.g. `EADDRINUSE`), independent of the Graph Service subprocess's own
// lifecycle staying healthy.
//
// `at: string` on every variant (review finding, Medium) — the two sibling
// status streams this one is closest to in shape, `GraphServiceStatusMessage`
// and `ModelStatusMessage`, both carry a timestamp on every variant so
// main/the renderer can tell how stale a currently-held status is; this one
// shouldn't be the exception.
// ---------------------------------------------------------------------------

export type McpServerStatusMessage =
  | { type: 'graphService:mcpServerStatus'; state: 'listening'; port: number; at: string }
  | { type: 'graphService:mcpServerStatus'; state: 'unavailable'; message: string; at: string };

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
 * P5-g (founder approval 2026-10-15, from the P3-5 live run): the message a
 * `setActiveBackend` rejection carries when main couldn't persist the
 * choice — actionable, and never the raw store error (a rename error names
 * the full userData file path). Main writes the raw error to the local
 * diagnostic log only (`'backend-setting-save-failed'`).
 */
export const BACKEND_SETTING_SAVE_FAILED_MESSAGE =
  "the backend setting couldn't be saved — check that the app's data folder is writable";

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
  /**
   * P2-6, `'ok'` only: whether main relayed the new key to a running Graph
   * Service (Cloud active, service running, project open). The renderer
   * re-kicks the map's pending Nodes only when this is true.
   */
  relayed?: boolean;
}

/**
 * Result of a `clearCloudApiKey` call (P2-6): the updated config, and
 * whether main relayed the key-less state to a running Graph Service
 * (`false` when no key was stored, or Cloud isn't active with a service
 * running and a project open).
 */
export interface ClearCloudApiKeyResult {
  config: BackendConfig;
  relayed: boolean;
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

/**
 * P1-3: message main posts to a running Graph Service subprocess to retry
 * ONLY the local-model download + checksum verification after a
 * `graphService:modelStatus` 'error' — never a restart, re-index, or
 * summary wipe. The service ignores it if the model is already ready or an
 * attempt is in flight; on success it resumes generation for the cached
 * Code Map's still-pending Nodes. Fire-and-forget: progress is reported
 * through the existing `graphService:modelStatus` stream.
 */
export interface GraphServiceRetryModelRequest {
  type: 'graphService:retryModel';
}

/**
 * P1-3: the reply to `DrillerApi.retryLocalModel` — whether main could hand
 * the retry to a running Graph Service. `ok: false` carries a user-facing
 * `message` (e.g. the Graph Service isn't running); the download's own
 * progress/outcome arrives separately via `onModelStatus`.
 */
export interface ModelRetryResult {
  ok: boolean;
  message?: string;
}

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
  /**
   * P4-4 phase 2a (AD-13 "Section scope"): one allowlist entry, exactly as
   * the Section bar shows it; absent = the whole scope (today's behaviour).
   * A value not in the allowlist gets `UnknownSectionResult`.
   */
  section?: string;
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
export type DiagnosticLogEntry =
  | {
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
    }
  | {
      /**
       * P4-7g (AD-5 "Entry pins"): a pinned Node is not on the indexed map
       * (an entry-candidate listing's `hiddenPinIds`) — hidden, never shown,
       * and the stored pin kept. Written by main, relaying the listing, once
       * per pinned id per session; never sent by the renderer (the
       * `diagnostic:log` channel accepts only `path-trace-dismissed`).
       */
      eventType: 'entry-pin-missing';
      /** ISO-8601 timestamp of the listing (or the map fetch after an index) that found it missing. */
      timestamp: string;
      /** P4-7g review round 1: the project the pin belongs to (local only, AD-21). */
      projectPath: string;
      nodeId: string;
    }
  | {
      /**
       * P5-g (founder approval 2026-10-15): persisting the active backend
       * failed (e.g. the settings file's rename was refused). Written by
       * main only; the renderer is shown
       * `BACKEND_SETTING_SAVE_FAILED_MESSAGE`, never this raw error.
       */
      eventType: 'backend-setting-save-failed';
      /** ISO-8601 timestamp of the failed save. */
      timestamp: string;
      /** The backend the user tried to switch to. */
      backend: CloudBackend;
      /** The raw store error's message (it may name userData paths — local only, AD-21). */
      error: string;
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
// Story 2.3 (Phase 1): PR-bot opt-in settings + privacy disclosure.
//
// driller's first PER-PROJECT settings store — every prior Settings field
// (`BackendConfig`, `EditorPreference`) is global, one value for the whole
// app; PR-bot opt-in is inherently per-project (a Supervising Engineer may
// want CodeRabbit ingestion on one repo and not another), so it's keyed by
// `projectPath` instead (see `PrBotConfig` below and
// `apps/desktop/main/pr-bot-settings.ts`, this contract's one persistence
// consumer).
//
// Only two bots exist and are named directly in the AC text (Design Notes)
// — `PrBotConfig` is deliberately flat named fields, not a
// `Record<PrBotId, boolean>`; a generic map would be premature for exactly
// two known, named members.
//
// No `disclosureAcknowledged` flag anywhere in this shape (Design Notes): a
// bot's `enabled: true` only ever becomes reachable through the renderer's
// explicit confirm action (Settings.tsx, mirroring Story 1.6's
// warning-then-acknowledge pattern for insecure key storage), so a bare
// boolean can't misrepresent whether the disclosure was actually shown.
//
// This phase adds the settings surface and disclosure-then-confirm UI only
// — no subprocess/CLI invocation (Story 2.3 Phase 2/3's job) and no change
// to `buildRiskSignals`'s actual signal computation.
// ---------------------------------------------------------------------------

/** The two PR-review bots a Settings user can opt into, per project. */
export type PrBotId = 'codeRabbit' | 'qodo';

/**
 * Per-project PR-bot opt-in state. Keyed by `projectPath` one level up (in
 * the persisted store and in `settingsGetPrBotConfig`/`settingsSetPrBotEnabled`'s
 * IPC signatures) — this shape itself carries no project identity of its
 * own, mirroring `BackendConfig`'s own "the config IS the current value,
 * not a keyed lookup" shape at the per-project level instead of globally.
 */
export interface PrBotConfig {
  codeRabbitEnabled: boolean;
  qodoEnabled: boolean;
}

/**
 * Per-project indexing-scope allowlist (Bug fix, 2026-09-23) — same
 * per-project keying shape as `PrBotConfig` above (`projectPath` one level
 * up, in the persisted store and in `settingsGetProjectScope`/
 * `settingsSetProjectScope`'s IPC signatures).
 *
 * Exists because CBM's `index_repository` has no subfolder include/exclude
 * parameter of its own — only a single whole-root `repo_path` plus its own
 * gitignore-style exclusions — so a mixed repo (real source alongside
 * unrelated tooling/docs/scripts, e.g. BMad planning files) has no way to
 * tell driller which subfolders are actually "the codebase" without this.
 *
 * `includedPaths` are POSIX-relative to the project root (e.g. `["web",
 * "app", "api"]`), matching `CodeMapNode.file`'s own path convention. Empty
 * means no restriction — the pre-existing default behavior for every
 * project that hasn't set this: every Node CBM itself doesn't already
 * exclude (gitignore/skip-list) is included. This is a query-time filter,
 * not a narrower `index_repository` call (see `services/graph-service/
 * index.ts`'s `filterCodeMapToScope`) — CBM still walks/parses the whole
 * repo internally; only the Node/edge set that ever reaches the Code Map,
 * risk signals, and summary generation is restricted.
 */
export interface ProjectScopeConfig {
  includedPaths: string[];
}

/**
 * `setProjectScope`'s reply (P2-1). `config` is the persisted, normalized
 * scope. `applied` is true when main also handed it to the running Graph
 * Service for the open project (`graphService:scopeChanged`), so the map
 * reflects it on its next fetch. False when it was only persisted — no Graph
 * Service running (or a project other than the open one): it applies when
 * the Graph Service is running again, since its next index of the project
 * reads the persisted scope. A malformed call persists nothing and rejects
 * instead of replying.
 */
export interface ProjectScopeSaveResult {
  config: ProjectScopeConfig;
  applied: boolean;
}

/**
 * Message main sends when the open project's indexing scope is saved (P2-1).
 * The scope is a query-time filter (`filterCodeMapToScope`), so this is a
 * state hand-off, never a re-index: the Graph Service adopts `includedPaths`
 * for `path` if it's the active project, and, if an index for `path` is in
 * flight, makes that index finish with this scope instead of the one its
 * request carried. Posts no status and no reply.
 */
export interface GraphServiceScopeChangedRequest {
  type: 'graphService:scopeChanged';
  /** Absolute, OS-native project root the scope belongs to. */
  path: string;
  /** The persisted `ProjectScopeConfig.includedPaths`; empty means no restriction. */
  includedPaths: string[];
}

// ---------------------------------------------------------------------------
// Story 2.3 (Phase 2): ingest CodeRabbit findings via the CodeRabbit CLI.
//
// `PrBotIngestionResult` is an explicit result-state union (AD-13's broader
// pattern), mirroring `RegenerateNodeResult`/`PathTraceResult`'s own shape:
//  - `'ok'`: the pass completed; `findingCount` is the total number of
//    findings persisted across every Node this pass (0 is a valid, distinct
//    outcome from every other state — the tool ran and found nothing).
//  - `'tool-not-found'`: `cr` isn't on PATH (`ENOENT`) — distinct from
//    `'error'` (edge-case sweep finding, 2026-09-05).
//  - `'no-base-ref-resolvable'`: `git-base-ref.ts`'s `resolveDefaultBranch`
//    found nothing (no upstream, no local `main`/`master`) — `cr` is never
//    invoked in this case.
//  - `'review-md-present'`: P0-6 (2026-09-24) — Qodo/PR-Agent only. A
//    `review.md` driller did not create was already sitting at the repo
//    root, which is where PR-Agent writes its own output, so the pass
//    refused: PR-Agent was never invoked and nothing was deleted.
//    `reviewMdPath` is the absolute path of that file, so the surface
//    reporting this can name it. Distinct from `'error'` because nothing
//    went wrong — driller declined to touch a file that isn't its own
//    (AD-17), and the user can clear the refusal themselves.
//  - `'error'`: any other failure (a non-`ENOENT` subprocess failure, or
//    CodeRabbit's JSON not matching the assumed shape) — `message` is safe,
//    user-facing text; nothing is persisted.
//
// Story 2.3 (Phase 3): `bot` widens from the literal `'codeRabbit'` to the
// full `PrBotId` union on `GraphServiceRunIngestionRequest`/
// `GraphServiceRunIngestionResultMessage` and `DrillerApi.runPrBotIngestion`
// below, now that the Qodo/PR-Agent adapter (`services/graph-service/
// qodo-adapter.ts`) exists alongside Phase 2's CodeRabbit one — both bots
// share this same result-state shape (`PrBotIngestionResult` itself is
// unchanged by this phase).
// ---------------------------------------------------------------------------

/** Result of a PR-bot ingestion pass (Story 2.3, Phase 2) — see this section's doc comment for each state's meaning. */
export type PrBotIngestionResult =
  | { status: 'ok'; findingCount: number }
  | { status: 'tool-not-found' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'review-md-present'; reviewMdPath: string }
  | { status: 'error'; message: string };

/**
 * Message main sends to ask the Graph Service subprocess to run an
 * ingestion pass for one PR-bot, against the project it most recently
 * finished indexing (mirrors `GraphServiceGetCodeMapRequest`/
 * `GraphServiceRegenerateNodeRequest`'s reliance on the Graph Service's own
 * `activeProject`/`activeProjectPath` state rather than carrying a path of
 * its own — main independently validates the renderer-supplied
 * `projectPath` against the currently-open project before ever sending
 * this).
 */
export interface GraphServiceRunIngestionRequest {
  type: 'graphService:runIngestion';
  bot: PrBotId;
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServiceRunIngestionRequest`, over the same `parentPort` channel as
 * every other Graph Service message — distinguished by `type`, same
 * convention as `GraphServiceRegenerateNodeResultMessage`. `bot` echoes the
 * request so main can settle the exact pending entry this reply is for
 * (`pendingIngestionResolvers`, keyed by `bot` — the id-keyed `Map` pattern
 * `pendingRegenerateResolvers` already established, generalized from
 * `nodeId` to `bot` since there's no Node id here).
 */
export interface GraphServiceRunIngestionResultMessage {
  type: 'graphService:runIngestionResult';
  bot: PrBotId;
  result: PrBotIngestionResult;
}

// ---------------------------------------------------------------------------
// Story 3.1 (Phase 1): compute a diff-scoped Node set from local git (FR11,
// AD-13).
//
// driller's first `git diff`/`git merge-base` subprocess computation —
// reuses Story 2.3's `runSafeSubprocess` (`services/graph-service/
// subprocess-runner.ts`) and `resolveDefaultBranch`
// (`services/graph-service/git-base-ref.ts`) unchanged, never a second
// subprocess mechanism. `findChangedNodeIds` (the actual Node-set matching,
// `@driller/graph-contracts`) is defined once, transport-agnostically, and
// reused here for the IPC envelope rather than redefined ad hoc — same
// precedent as `PathTraceResult`'s import above.
//
// `DiffScopeResult` itself (the explicit result-state union) is declared
// once in `@driller/graph-contracts` and re-exported above (P4-6).
// ---------------------------------------------------------------------------

/**
 * Message main sends to ask the Graph Service subprocess to compute a
 * diff-scoped Node set. `baseRef` is the caller-supplied branch/commit name
 * — optional, mirroring `computeDiffScope`'s own `(projectRoot, baseRef)`
 * signature (`services/graph-service/git-diff-scope.ts`); omitted, the Graph
 * Service resolves one via `resolveDefaultBranch` before ever calling git.
 *
 * Carries `projectPath` even though the Graph Service itself always computes
 * against its own `activeProjectPath`/`activeCodeMapNodes` state (mirrors
 * `handleRunIngestionRequest`'s shape, Code Map) — needed to settle the right
 * pending entry in main's own single-flight guard (`pendingDiffScopeResolvers`,
 * keyed by project path), including across a project switch that races an
 * in-flight request.
 *
 * `requestId` (review finding, Blind Hunter — a real correlation bug, not
 * just a defensive nicety): unlike `GraphServiceRunIngestionRequest`
 * (correlated via the natural `bot` id, which can't collide across two
 * *different* requests for the same bot since only one is ever in flight per
 * bot), a `projectPath`-only key here has a genuine stale-reply window — if a
 * request times out and its `pendingDiffScopeResolvers` entry is cleared, a
 * *new* request for the same `projectPath` can be issued before the
 * abandoned request's late reply finally arrives; without a way to tell them
 * apart, that late reply would incorrectly settle the new request's promise.
 * `requestId` is a monotonically increasing counter minted by main
 * (`nextDiffScopeRequestId`) per call, echoed back verbatim in the reply, and
 * checked before settling — a reply whose `requestId` doesn't match the
 * current pending entry's is a stale reply from an abandoned request and is
 * discarded rather than applied.
 */
export interface GraphServiceComputeDiffScopeRequest {
  type: 'graphService:computeDiffScope';
  projectPath: string;
  baseRef?: string;
  requestId: number;
  /**
   * P4-4 phase 2a (AD-13 "Section scope"): one allowlist entry, exactly as
   * the Section bar shows it; absent = the whole scope (today's behaviour).
   * A value not in the allowlist gets `UnknownSectionResult`.
   */
  section?: string;
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServiceComputeDiffScopeRequest`, over the same `parentPort` channel
 * as every other Graph Service message — distinguished by `type`, same
 * convention as `GraphServiceRunIngestionResultMessage`. `projectPath` and
 * `requestId` both echo the request's own fields verbatim (never re-derived
 * from the Graph Service's own possibly-since-changed `activeProjectPath`) —
 * see those fields' own doc comments on `GraphServiceComputeDiffScopeRequest`
 * for the correlation they exist for.
 */
export interface GraphServiceComputeDiffScopeResultMessage {
  type: 'graphService:computeDiffScopeResult';
  projectPath: string;
  requestId: number;
  result: DiffScopeResult;
}

// ---------------------------------------------------------------------------
// Story 3.2 (Phase 1): compute multi-Node blast radius hop distances (FR12,
// AD-13).
//
// Mirrors Story 3.1 (Phase 1)'s `DiffScopeResult`/`GraphServiceComputeDiffScope
// Request`/`GraphServiceComputeDiffScopeResultMessage` shape layer-for-layer
// — same `requestId` correlation (stale-reply safety), same
// `projectPath`-keyed single-flight guard, same never-rejects/every-failure-
// is-an-explicit-result contract. `computeBlastRadiusHopDistances`
// (`@driller/graph-contracts`) is the actual multi-source BFS, reused here
// for the IPC envelope rather than redefined ad hoc — same precedent
// `findChangedNodeIds`/`DiffScopeResult` already established.
//
// `BlastRadiusExpansionResult` itself (the explicit result-state union) is
// declared once in `@driller/graph-contracts` and re-exported above (P4-6).
// ---------------------------------------------------------------------------

/**
 * Message main sends to ask the Graph Service subprocess to expand blast
 * radius from `nodeIds` — mirrors `GraphServiceComputeDiffScopeRequest`'s
 * shape exactly, except `nodeIds: string[]` (the changed-Node seed set) in
 * place of `baseRef`.
 *
 * Carries `projectPath` for the same reason `GraphServiceComputeDiffScope
 * Request` does — the Graph Service always computes against its own
 * `activeProjectPath`/`activeCodeMapNodes`/`activeCodeMapEdges` state, but
 * main needs `projectPath` to settle the right pending entry in its own
 * single-flight guard (`pendingBlastRadiusResolvers`, keyed by project path),
 * including across a project switch that races an in-flight request.
 *
 * `requestId`: same stale-reply correlation reasoning as
 * `GraphServiceComputeDiffScopeRequest.requestId` — a monotonically
 * increasing counter minted by main per call, echoed back verbatim in the
 * reply, checked before settling so a late reply from an abandoned request
 * can never incorrectly settle a newer one for the same `projectPath`.
 */
export interface GraphServiceExpandBlastRadiusRequest {
  type: 'graphService:expandBlastRadius';
  projectPath: string;
  nodeIds: string[];
  requestId: number;
  /**
   * P4-4 phase 2a (AD-13 "Section scope"): one allowlist entry, exactly as
   * the Section bar shows it; absent = the whole scope (today's behaviour).
   * A value not in the allowlist gets `UnknownSectionResult`.
   */
  section?: string;
}

/**
 * Message the Graph Service subprocess posts back in response to a
 * `GraphServiceExpandBlastRadiusRequest`, over the same `parentPort` channel
 * as every other Graph Service message — distinguished by `type`, same
 * convention as `GraphServiceComputeDiffScopeResultMessage`. `projectPath`
 * and `requestId` both echo the request's own fields verbatim, same
 * correlation reasoning.
 */
export interface GraphServiceExpandBlastRadiusResultMessage {
  type: 'graphService:expandBlastRadiusResult';
  projectPath: string;
  requestId: number;
  result: BlastRadiusExpansionResult;
}

// ---------------------------------------------------------------------------
// P4-7c: list entry candidates (AD-13 (f), FR-3/FR-4/FR-15).
//
// The `graphService:expandBlastRadius` request/response pair's shape, with
// no `nodeIds`: the Graph Service lists candidates from its own cached
// active map (never a request-supplied Node set). `EntryCandidatesResult` is
// declared once in `@driller/graph-contracts` and re-exported above.
// ---------------------------------------------------------------------------

/**
 * Message main sends to ask the Graph Service subprocess for the ranked
 * entry candidates of `projectPath`'s active map. `projectPath` and
 * `requestId` correlate the reply, as for
 * `GraphServiceExpandBlastRadiusRequest`.
 */
export interface GraphServiceListEntryCandidatesRequest {
  type: 'graphService:listEntryCandidates';
  projectPath: string;
  requestId: number;
  /**
   * AD-13 "(f) per section" (founder decision 2026-10-04): one allowlist
   * entry, exactly as the Section bar shows it; absent = the whole scope.
   * A value not in the allowlist gets `UnknownSectionResult`.
   */
  section?: string;
}

/**
 * The Graph Service's reply to a `GraphServiceListEntryCandidatesRequest`;
 * `projectPath` and `requestId` echo the request's. P4-7c review round 1:
 * `section` echoes the request's section (`null` for the whole scope, or for
 * a malformed one), which main checks against the request it settles.
 */
export interface GraphServiceListEntryCandidatesResultMessage {
  type: 'graphService:listEntryCandidatesResult';
  projectPath: string;
  requestId: number;
  section: string | null;
  result: EntryCandidatesResult;
}

/**
 * P4-4 phase 3b (founder decision 2026-10-04): whether PR Review's base ref
 * carries over a section switch, so the diff scope is re-run in the new
 * section:
 *  - `same-repository`: both sections' folders are in the same git
 *    repository (`git rev-parse --show-toplevel`);
 *  - `ref-exists`: the target section is in another repository, and the base
 *    ref resolves to a commit there (`git rev-parse --verify`);
 *  - `not-carried`: neither, or a repository or section couldn't be
 *    determined — the base ref is cleared and the diff reset to idle;
 *  - `error`: the request itself failed (treated like `not-carried`).
 * Never computed from the diff itself; read-only git calls only.
 */
export type DiffScopeCarryResult =
  | { status: 'same-repository' }
  | { status: 'ref-exists' }
  | { status: 'not-carried' }
  | { status: 'error'; message: string };

/**
 * P4-4 phase 3b: main → Graph Service — may `baseRef` carry from section
 * `fromSection` to `toSection` (`null` = `all`, the project root)?
 * `requestId` correlates the reply, as for the diff-scope request.
 */
export interface GraphServiceDiffScopeCarryRequest {
  type: 'graphService:diffScopeCarry';
  projectPath: string;
  requestId: number;
  fromSection: string | null;
  toSection: string | null;
  baseRef: string;
}

/** P4-4 phase 3b: the reply to `GraphServiceDiffScopeCarryRequest`, echoing `projectPath` and `requestId`. */
export interface GraphServiceDiffScopeCarryResultMessage {
  type: 'graphService:diffScopeCarryResult';
  projectPath: string;
  requestId: number;
  result: DiffScopeCarryResult;
}

// ---------------------------------------------------------------------------
// IPC channel names — namespaced `<domain>:<action>`
// ---------------------------------------------------------------------------

export const IpcChannels = {
  projectOpen: 'project:open',
  projectOpenPath: 'project:openPath',
  projectListRecent: 'project:listRecent',
  graphServiceStatus: 'graphService:status',
  graphServiceRestart: 'graphService:restart',
  modelRetry: 'model:retry',
  codeMapGet: 'codeMap:get',
  sourceReadRange: 'source:readRange',
  shellOpenInEditor: 'shell:openInEditor',
  modelStatus: 'model:status',
  summaryProgress: 'summary:progress',
  llmJudgmentProgress: 'llmJudgment:progress',
  hardwareAdvisory: 'hardware:advisory',
  mcpServerStatus: 'mcp:status',
  settingsGetBackendConfig: 'settings:getBackendConfig',
  settingsSetActiveBackend: 'settings:setActiveBackend',
  settingsSetCloudApiKey: 'settings:setCloudApiKey',
  settingsClearCloudApiKey: 'settings:clearCloudApiKey',
  settingsGetEditorPreference: 'settings:getEditorPreference',
  settingsSetEditorPreference: 'settings:setEditorPreference',
  settingsGetPrBotConfig: 'settings:getPrBotConfig',
  settingsSetPrBotEnabled: 'settings:setPrBotEnabled',
  settingsGetProjectScope: 'settings:getProjectScope',
  settingsSetProjectScope: 'settings:setProjectScope',
  settingsGetShowFoldedKinds: 'settings:getShowFoldedKinds',
  settingsSetShowFoldedKinds: 'settings:setShowFoldedKinds',
  settingsGetActiveSection: 'settings:getActiveSection',
  settingsSetActiveSection: 'settings:setActiveSection',
  // P4-7g: AD-5 "Entry pins".
  settingsGetEntryPins: 'settings:getEntryPins',
  settingsSetEntryPins: 'settings:setEntryPins',
  prBotRunIngestion: 'prBot:runIngestion',
  nodeRegenerate: 'node:regenerate',
  pathTrace: 'path:trace',
  diagnosticLog: 'diagnostic:log',
  diffScopeCompute: 'diffScope:compute',
  diffScopeCarry: 'diffScope:carry',
  blastRadiusExpand: 'blastRadius:expand',
  // P4-7c: AD-13 (f), shared with the `list_entry_candidates` MCP tool.
  entryCandidatesList: 'entryCandidates:list',
  menuOpenFolder: 'menu:openFolder',
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
  /**
   * Manually retries spawning the Graph Service after it failed to start.
   * With `forceRespawn` omitted/falsy, the existing behavior is unchanged:
   * a no-op respawn (just a fresh index request) if the subprocess is
   * already alive, since the Graph Service's own Retry buttons (its
   * `graphServiceStatus` error state and the session notice) rely on that
   * semantics for their own failure modes, which never require killing a
   * still-alive subprocess. (The model-status footer's Retry no longer uses
   * this — P1-3 gave it `retryLocalModel`, which never re-indexes.)
   *
   * `forceRespawn: true` (Story 5.2, review finding, Critical) tears the
   * current subprocess down and spawns a fresh one even if it's alive —
   * needed specifically for the MCP listener's own Retry: an `'unavailable'`
   * `McpServerStatusMessage` is, by construction, posted FROM a subprocess
   * that is still alive when it posts (the listener is a sub-component of an
   * otherwise-healthy process), so the no-op-if-alive default would silently
   * do nothing for exactly the case this Retry button exists for.
   */
  restartGraphService: (forceRespawn?: boolean) => Promise<{ ok: boolean }>;
  /**
   * P1-3: the model-status footer's Retry — retries only the local-model
   * download/verify in the running Graph Service (no restart, no re-index).
   * `ok: false` with a `message` when the Graph Service isn't running or the
   * request couldn't be sent; progress arrives via `onModelStatus`.
   */
  retryLocalModel: () => Promise<ModelRetryResult>;
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
   * Subscribes to batched LLM-judgment generation progress (Story 2.2 Phase
   * 2, FR8, AD-8) — a stream distinct from `onSummaryProgress`, mirroring it
   * structurally. No renderer subscriber consumes this yet (Phase 3's job).
   * Returns an unsubscribe function.
   */
  onLlmJudgmentProgress: (callback: (message: LlmJudgmentProgressMessage) => void) => () => void;
  /**
   * Subscribes to the hardware-adequacy advisory stream (Story 1.5 Phase 3)
   * — a non-blocking, informational-only nudge toward the cloud path
   * (Story 1.6, not yet built), distinct from both `onModelStatus` and
   * `onSummaryProgress`. Returns an unsubscribe function.
   */
  onHardwareAdvisory: (callback: (message: HardwareAdvisoryMessage) => void) => () => void;
  /**
   * Subscribes to the MCP listener's own bind/error status stream (Story
   * 5.2) — a signal distinct from `onGraphServiceStatus`, since the Graph
   * Service subprocess can be genuinely `'alive'`/`'indexed'` while only its
   * MCP sub-component has failed to bind. Not project-scoped (mirrors
   * `onModelStatus`, not `onGraphServiceStatus`): the listener is bound once
   * per subprocess lifetime, independent of which project is open. Returns
   * an unsubscribe function.
   */
  onMcpServerStatus: (callback: (message: McpServerStatusMessage) => void) => () => void;
  /**
   * Subscribes to the application menu's File ▸ Open Folder… (Cmd/Ctrl+O,
   * P2-9). Returns an unsubscribe function.
   */
  onMenuOpenFolder: (callback: () => void) => () => void;
  /**
   * Fetches the Code Map (Nodes + call/dependency edges) for the most
   * recently `indexed` project. Called once per successful `indexed` state
   * — never re-fetched on every render.
   *
   * P4-4 phase 1b: `section` (one indexing-scope allowlist entry) maps that
   * section alone; omitted means the whole scope.
   *
   * P5-b founder decision 2: `options.force` re-reads the map from the
   * backend (the map's Retry); without it the Graph Service may serve the
   * request from its raw cache.
   */
  getCodeMap: (section?: string, options?: GetCodeMapOptions) => Promise<CodeMapResult>;
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
   * Hands off a Node's exact source location to the Phase 1-configured
   * external editor (Story 1.10, Phase 2, AD-23) — main resolves `file`
   * (the Node's POSIX-relative path) to an absolute path under the same
   * containment-checked resolution `readSourceRange` uses, then launches
   * VS Code/JetBrains via that editor's own URI scheme at the exact
   * `startLine`, or the OS's generic file-open mechanism for System default
   * (no line-jump). Never callable directly against `shell.openExternal`/
   * `shell.openPath` from the renderer (AD-11) — this is the one hand-off
   * point.
   */
  openInEditor: (file: string, startLine: number) => Promise<OpenInEditorResult>;
  /**
   * Fetches the current backend config (Story 1.6 Phase 1): the active
   * local/cloud choice, whether a cloud key is already stored, and whether
   * this machine is Linux with no secure OS keystore.
   */
  getBackendConfig: () => Promise<BackendConfig>;
  /**
   * Sets the active summary backend (local/cloud) choice. P5-g: when the
   * choice can't be saved it rejects with `BACKEND_SETTING_SAVE_FAILED_MESSAGE`.
   */
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
   * Removes the stored cloud API key (P2-6): deletes its ciphertext so
   * `hasCloudKey` becomes false, and resolves to the updated config. A no-op
   * when no key is stored. Rejects if the store write fails. Never changes
   * the active backend or deletes generated summaries. `relayed` says
   * whether the running Graph Service was told.
   */
  clearCloudApiKey: () => Promise<ClearCloudApiKeyResult>;
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
   * Fetches the current PR-bot opt-in config for one project (Story 2.3,
   * Phase 1) — driller's first per-project settings read. Returns
   * `{codeRabbitEnabled: false, qodoEnabled: false}` when the project has no
   * persisted entry yet (opt-in is disabled by default), never
   * undefined/unset.
   */
  getPrBotConfig: (projectPath: string) => Promise<PrBotConfig>;
  /**
   * Sets one bot's opt-in state for one project (Story 2.3, Phase 1).
   * Turning a bot on is only ever called from the renderer's explicit
   * confirm action, after that bot's own disclosure notice has been shown —
   * this call itself carries no such distinction, it's the renderer's
   * disclosure-then-confirm flow (Settings.tsx) that gates when it's
   * invoked with `enabled: true`. Turning a bot off is called immediately on
   * toggle, no disclosure/confirmation gating. Returns the project's full,
   * updated `PrBotConfig` so the renderer can update its state without a
   * separate refetch.
   */
  setPrBotEnabled: (projectPath: string, bot: PrBotId, enabled: boolean) => Promise<PrBotConfig>;
  /**
   * Fetches the current indexing-scope allowlist for one project (Bug fix,
   * 2026-09-23) — same per-project shape as `getPrBotConfig`. Returns
   * `{includedPaths: []}` (no restriction) when the project has no
   * persisted entry yet, never undefined/unset.
   */
  getProjectScope: (projectPath: string) => Promise<ProjectScopeConfig>;
  /**
   * Sets one project's indexing-scope allowlist (Bug fix, 2026-09-23).
   * Never triggers a re-index. P2-1: when `projectPath` is the open project
   * and the Graph Service is running, main also hands the scope to it
   * (`graphService:scopeChanged`) and replies `applied: true` — the renderer
   * then refetches the map to show it. Otherwise `applied: false`: saved, and
   * applies when the Graph Service is running again (see
   * `ProjectScopeSaveResult`). Rejects, persisting nothing, on a malformed
   * call. `config` is the persisted value, so the renderer can update its
   * state without a separate refetch.
   */
  setProjectScope: (projectPath: string, includedPaths: string[]) => Promise<ProjectScopeSaveResult>;
  /**
   * P4-2 phase 3c: whether one project's Code Map canvas shows the folded
   * Types/Interfaces/Modules again ("Show types & modules"). `false` (the
   * default) when the project has no persisted value.
   */
  getShowFoldedKinds: (projectPath: string) => Promise<boolean>;
  /**
   * P4-2 phase 3c: remembers one project's "Show types & modules" toggle in
   * the UI settings store and resolves with the value now in effect. A
   * render-only preference: nothing is re-indexed or recomputed.
   */
  setShowFoldedKinds: (projectPath: string, show: boolean) => Promise<boolean>;
  /**
   * P4-4i: one project's last selected section (AD-5, "Remembered section")
   * — `null` (`all`) when nothing is saved. Not validated against the
   * project's allowlist: the renderer checks it against `getProjectScope`
   * before using it.
   */
  getActiveSection: (projectPath: string) => Promise<string | null>;
  /**
   * P4-4i: remembers one project's section in the UI settings store and
   * resolves with the value now in effect. `null` (`all`) removes the
   * project's entry — the string `"all"` is never stored for it.
   */
  setActiveSection: (projectPath: string, section: string | null) => Promise<string | null>;
  /**
   * P4-7g (AD-5 "Entry pins"): one project's pinned Node ids, in pin order —
   * `[]` when none are stored (or the store can't be read). Never rejects
   * for a malformed path: that reads as `[]`.
   */
  getEntryPins: (projectPath: string) => Promise<string[]>;
  /**
   * P4-7g (review round 1): pins (`pinned: true`, appended — pin order) or
   * unpins one Node of one project, applied by main to the list it has
   * stored, and resolves with the outcome (`EntryPinUpdateResult`). Main
   * also hands a stored list to the Graph Service, so the next
   * `listEntryCandidates` (and the MCP tool) ranks the pins first. Never
   * rejects for a malformed call: that is an `error` result.
   */
  setEntryPins: (projectPath: string, nodeId: string, pinned: boolean) => Promise<EntryPinUpdateResult>;
  /**
   * Runs one PR-bot's ingestion pass against `projectPath` (Story 2.3, Phase
   * 2) — this phase's only entry point (Never: "Any UI trigger, entry
   * point... this phase"; reachable only by calling this directly, e.g. from
   * the DevTools console, mirroring Story 1.9 Phase 1's `tracePath`).
   * `projectPath` must be the currently-open project — main rejects a call
   * for any other path with an explicit `'error'` result rather than
   * silently operating on the wrong project. `bot` widens to the full
   * `PrBotId` union as of Story 2.3 (Phase 3), now that both the CodeRabbit
   * and Qodo/PR-Agent adapters exist.
   */
  runPrBotIngestion: (projectPath: string, bot: PrBotId) => Promise<PrBotIngestionResult>;
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
   *
   * P4-4 phase 2a: `section` (optional) limits the trace to one section's
   * files (nearest-section rule); omitted = the whole scope.
   */
  tracePath: (query: string, section?: string) => Promise<PathTraceResult>;
  /**
   * Fire-and-forget: appends one entry to driller's local-only diagnostic
   * log (Story 1.9, Phase 4, AD-21). Never rejects — a log-write failure is
   * swallowed/console-logged in main only, never surfaced to the caller or
   * allowed to block whatever UI action triggered it.
   */
  logDiagnosticEvent: (entry: DiagnosticLogEntry) => Promise<void>;
  /**
   * Computes a diff-scoped Node set from local git for `projectPath` (Story
   * 3.1, Phase 1, FR11, AD-13) — driller's first `git diff`/`git merge-base`
   * round trip. `baseRef` is an optional branch/commit name; omitted, the
   * Graph Service resolves a default via `resolveDefaultBranch`. `projectPath`
   * must be the currently-open project — main rejects a call for any other
   * path with an explicit `'error'` result, mirroring `runPrBotIngestion`'s
   * own validation. No renderer entry point calls this yet this phase (Never:
   * "no UI trigger, mode switcher... this phase") — reachable only by calling
   * this directly, e.g. from the DevTools console.
   *
   * P4-4 phase 2a: `section` (optional) limits the changed Nodes, contracts
   * and top-level files to one section; omitted = the whole scope.
   */
  computeDiffScope: (projectPath: string, baseRef?: string, section?: string) => Promise<DiffScopeResult>;
  /**
   * Computes combined blast radius hop distances from `nodeIds` for
   * `projectPath` (Story 3.2, Phase 1, FR12, AD-13) — a full IPC/graph-
   * service round trip mirroring `computeDiffScope`'s shape layer-for-layer,
   * over `@driller/graph-contracts`'s `computeBlastRadiusHopDistances`.
   * `projectPath` must be the currently-open project — main rejects a call
   * for any other path with an explicit `'error'` result, mirroring
   * `computeDiffScope`'s own validation. Unbounded: returns hop distances
   * for every reachable Node in one call, no `maxHops` parameter (Phase 2's
   * stepper slices this locally per hop step, zero additional round trips).
   * No renderer entry point calls this yet this phase (Never: "no UI
   * changes in this phase") — reachable only by calling this directly, e.g.
   * from the DevTools console.
   *
   * P4-4 phase 2a: `section` (optional) walks only that section's Nodes and
   * edges; a seed outside it contributes nothing. Omitted = the whole scope.
   */
  expandBlastRadius: (projectPath: string, nodeIds: string[], section?: string) => Promise<BlastRadiusExpansionResult>;
  /**
   * P4-7c (AD-13 (f), FR-15): the ranked candidate entry points of
   * `projectPath`'s active map — a heuristic over indexed code (Nodes with
   * no CALLS or USAGE caller in it, ranked by forward reach). The same
   * Graph Service compute function the `list_entry_candidates` MCP tool
   * calls, so both answers are identical. `projectPath` must be the open
   * project. `section` (optional) lists the candidates of that section's
   * own Nodes and edges; omitted = the whole scope. Never rejects: every
   * failure is an explicit `error` result.
   */
  listEntryCandidates: (projectPath: string, section?: string) => Promise<EntryCandidatesResult>;
  /**
   * P4-4 phase 3b (founder decision 2026-10-04): may PR Review's `baseRef`
   * carry from `fromSection` to `toSection` (`null` = `all`)? See
   * `DiffScopeCarryResult`. Read-only; never rejects.
   */
  checkDiffScopeCarry: (
    projectPath: string,
    fromSection: string | null,
    toSection: string | null,
    baseRef: string,
  ) => Promise<DiffScopeCarryResult>;
}
