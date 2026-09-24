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

/**
 * P0-5: re-exported so the renderer (whose only contracts dependency is this
 * package) reads the same hop bound the Graph Service's Blast Radius badge
 * uses — for PR Review's initial stepper depth and the Blast Radius chip's
 * tooltip/accessible name ("within N hops"), never a second literal.
 */
export { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/graph-contracts';

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

// ---------------------------------------------------------------------------
// Story 2.1 (Phase 1): deterministic risk signals (FR7, AD-9 corrected).
// Story 2.2 (Phase 1): `RiskSignal` splits into a discriminated union —
// `DeterministicRiskSignal` (renamed from the former single `RiskSignal`
// interface, no field changes) and the new `LlmJudgmentRiskSignal` — so the
// qualitative `'llm-judgment'` family (FR8) has a shape to persist into and
// render, distinct from a deterministic signal's mandatory numeric `value`.
//
// `RiskSignalFamily` is deliberately its own union rather than a bare string
// literal inlined on each signal interface — Epic 2's third family
// (`ingested`, Story 2.3) extends this union as a sibling member later,
// never redefine/compete with it (Consistency Conventions).
// `DeterministicRiskSignalType` is likewise extensible: Phase 2 adds
// `'test-coverage-gap'` as a fifth sibling member.
//
// Every `RiskSignal` carries its own `location` — for this phase, always the
// owning Node's own `{file, startLine, endLine}` range (a duplicate of the
// Node's own fields, degenerate here but required by the Consistency
// Conventions table, since later families may report a narrower location
// than their owning Node's full range).
//
// Complexity/cognitive-complexity and hotspot values are sourced only from
// `codebase-memory-mcp`'s own already-computed per-Node/per-File properties
// (see mcp-client.ts's extended `CODE_MAP_NODES_QUERY`) — never a new
// tree-sitter parsing pass or `git log` shell-out. Blast radius is computed
// live via `@driller/graph-contracts`'s `computeBlastRadius`, a cycle-safe
// BFS over the Code Map's already-fetched edges. All four are recomputed on
// every `getCodeMap` fetch — none persisted to `node-record-store.ts`
// (Boundaries & Constraints), and reproducible: re-fetching against
// unchanged repo state yields byte-identical `riskSignals` (FR7).
// ---------------------------------------------------------------------------

/** The Risk Overlay's three signal families (Epic 2) — Story 2.3 (Phase 1) adds `'ingested'`, the last of the three. */
export type RiskSignalFamily = 'deterministic' | 'llm-judgment' | 'ingested';

/**
 * Review round (patch): factored out of `DeterministicRiskSignal`/
 * `LlmJudgmentRiskSignal` — before this phase there was one `RiskSignal`
 * interface with one `location` field; the union split would otherwise leave
 * two independent inline copies of this same shape to keep in sync by hand.
 */
export interface RiskSignalLocation {
  file: string;
  startLine: number;
  endLine: number;
}

/**
 * Deterministic risk signal types (Story 2.1 Phase 1; Phase 2 adds
 * `'test-coverage-gap'` as a fifth sibling member, never a competing type).
 *
 * `'test-coverage-gap'` (Story 2.1 Phase 2, FR7) — a Node whose `[startLine,
 * endLine]` range has zero covered lines per a hand-parsed
 * `coverage/lcov.info` (see `services/graph-service/lcov.ts`). This is
 * distinct from `SummaryStatus`'s unrelated `'coverage-gap'` member, which
 * means indexing/parse coverage (FR-2/FR-5) — the two are unrelated
 * concepts that happen to share the word "coverage"; never conflate them.
 */
export type DeterministicRiskSignalType =
  | 'complexity'
  | 'cognitive-complexity'
  | 'hotspot'
  | 'blast-radius'
  | 'test-coverage-gap';

/**
 * One deterministic risk signal attached to a `CodeMapNode`. A Node with no
 * data for a given signal (e.g. zero complexity data for an unsupported
 * grammar) simply omits that entry from `riskSignals` — never a signal with
 * an undefined/null `value` standing in for "absent" (AD-13's explicit-
 * result-state pattern applied at the array level: absence is expressed by
 * omission from the array, not by a placeholder entry).
 *
 * Story 2.2 (Phase 1): this was formerly the single `RiskSignal` interface,
 * renamed here as part of `RiskSignal`'s split into a discriminated union —
 * every already-shipped Story 2.1 consumer keeps behaving identically
 * against this renamed shape, though two call sites (`buildRiskSignals`'s
 * return type in `services/graph-service/index.ts`, and the import there)
 * needed a mechanical update to the new name (review round: the original
 * comment overstated this as needing zero consumer changes). The only real
 * field change is `family`'s type narrowing from the old `RiskSignalFamily`
 * union to the literal `'deterministic'`, required for discriminant
 * narrowing — not a new/removed field.
 */
export interface DeterministicRiskSignal {
  family: 'deterministic';
  type: DeterministicRiskSignalType;
  value: number;
  location: RiskSignalLocation;
}

/**
 * Story 2.2 (Phase 1): the qualitative LLM-judgment risk signal (FR8) — a
 * free-text `judgment` in place of a deterministic signal's mandatory
 * numeric `value`, and no `type` (deterministic-only; see
 * `DeterministicRiskSignalType`). No `model`/`generatedAt` provenance here —
 * consistent with `CodeMapNode.summary`'s own wire shape (a bare `string`,
 * its provenance never reaches the renderer either), not an oversight.
 * `judgment` here corresponds to `NodeRecord.llmJudgment.text` on the
 * persisted side (`services/graph-service/node-record-store.ts`) — the two
 * names differ deliberately (this is the wire/render-facing shape, that one
 * follows `summary`'s own provenance-object naming) but describe the same
 * value; whoever bridges the two (Phase 2) reads `record.llmJudgment.text`
 * into this field's `judgment`. This phase only defines the shape — no code
 * yet produces one (Phase 2's job) or renders one (Phase 3's job); nothing
 * in this codebase can construct an `LlmJudgmentRiskSignal` yet.
 */
export interface LlmJudgmentRiskSignal {
  family: 'llm-judgment';
  judgment: string;
  location: RiskSignalLocation;
}

/**
 * Story 2.3 (Phase 1): a finding ingested from an external PR-review bot
 * (CodeRabbit, Qodo) — the Risk Overlay's third and final signal family
 * (FR-per epic-2-context.md). Mirrors `LlmJudgmentRiskSignal`'s shape
 * (`family` discriminant + `location`), with `severity` and `sourceTool`
 * added per the Consistency Conventions ("`ingested` signals additionally
 * carry `severity` and `sourceTool`"): every ingested finding must display
 * its originating tool and a canonical severity mapped from the source
 * tool's native scale — never passed through unmapped.
 *
 * This phase only defines the shape — no code yet produces one (Story 2.3
 * Phase 2/3's job, the actual CodeRabbit/Qodo CLI adapters) or renders one
 * (Phase 4's job). Nothing in this codebase can construct an
 * `IngestedRiskSignal` yet.
 */
export interface IngestedRiskSignal {
  family: 'ingested';
  severity: 'blocker' | 'major' | 'minor' | 'info';
  sourceTool: string;
  finding: string;
  location: RiskSignalLocation;
}

/**
 * The Risk Overlay's per-signal shape (Epic 2) — a discriminated union on
 * `family`, so each family's own fields (a deterministic signal's `value`
 * vs. an LLM-judgment signal's `judgment` vs. an ingested signal's
 * `severity`/`sourceTool`/`finding`) are only ever accessed after narrowing,
 * never assumed present across the whole union. All three families now
 * exist as of Story 2.3 (Phase 1).
 */
export type RiskSignal = DeterministicRiskSignal | LlmJudgmentRiskSignal | IngestedRiskSignal;

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
  /**
   * FR7's deterministic complexity/cognitive-complexity/hotspot/blast-radius
   * signals (Story 2.1, Phase 1), recomputed live on every `getCodeMap`
   * fetch. Never omitted/undefined (AD-13's explicit-result-state pattern) —
   * a Node with zero risk signals is `riskSignals: []`, not a missing field.
   */
  riskSignals: RiskSignal[];
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
// `DiffScopeResult` is an explicit, enumerated result-state union (AD-13's
// broader pattern), never null/empty standing in for "nothing changed" or
// "couldn't compute":
//  - `'resolved'`: `resolvedBaseRef` is always the merge-base COMMIT (never
//    the branch/ref name that was supplied or resolved) — the exact commit
//    `git diff --name-only` was actually run against, so what's reported and
//    what was computed can never silently diverge (Design Notes).
//    `nodeIds` is the diff-scoped Node set, matched via `findChangedNodeIds`.
//  - `'no-changes'`: the resolved base ref produced an empty changed-file
//    list — never an empty-but-unexplained `nodeIds`.
//  - `'not-a-git-repo'`: `.git` was absent at the project root at call time
//    (checked fresh, not cached from project-open — Design Notes) — no git
//    subprocess call was made.
//  - `'no-base-ref-resolvable'`: `baseRef` was omitted and
//    `resolveDefaultBranch` found nothing (no upstream, no local
//    `main`/`master`) — no git diff/merge-base call was made.
//  - `'error'`: any other failure (a non-`ENOENT` subprocess failure, or an
//    unexpected `merge-base`/`diff` result) — `message` is safe, user-facing
//    text.
// ---------------------------------------------------------------------------

export type DiffScopeResult =
  | { status: 'resolved'; resolvedBaseRef: string; nodeIds: string[] }
  | { status: 'no-changes' }
  | { status: 'not-a-git-repo' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'error'; message: string };

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
// `BlastRadiusExpansionResult` is an explicit, enumerated result-state union
// (AD-13's broader pattern), never null/empty standing in for "nothing
// reachable" or "couldn't compute":
//  - `'resolved'`: `hopDistances` maps every reachable Node's id to its
//    minimum hop distance from the nearest seed in the request's `nodeIds`
//    (seed Nodes themselves excluded — Always). A plain
//    `Record<string, number>`, not a `Map`, to keep this result JSON-shaped
//    like every other IPC result in this file — the Graph Service converts
//    `computeBlastRadiusHopDistances`'s `Map` return value to this shape
//    before posting it back. An empty `nodeIds` request (or one whose every
//    seed id is stale) resolves with an empty `hopDistances` object, not an
//    error.
//  - `'error'`: the expansion couldn't even be attempted (no project indexed
//    yet, the requested project isn't the currently active one, or it
//    changed mid-computation) — `message` is safe, user-facing text, mirrors
//    `DiffScopeResult`'s own `'error'` variant.
// ---------------------------------------------------------------------------

export type BlastRadiusExpansionResult =
  | { status: 'resolved'; hopDistances: Record<string, number> }
  | { status: 'error'; message: string };

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
  shellOpenInEditor: 'shell:openInEditor',
  modelStatus: 'model:status',
  summaryProgress: 'summary:progress',
  llmJudgmentProgress: 'llmJudgment:progress',
  hardwareAdvisory: 'hardware:advisory',
  mcpServerStatus: 'mcp:status',
  settingsGetBackendConfig: 'settings:getBackendConfig',
  settingsSetActiveBackend: 'settings:setActiveBackend',
  settingsSetCloudApiKey: 'settings:setCloudApiKey',
  settingsGetEditorPreference: 'settings:getEditorPreference',
  settingsSetEditorPreference: 'settings:setEditorPreference',
  settingsGetPrBotConfig: 'settings:getPrBotConfig',
  settingsSetPrBotEnabled: 'settings:setPrBotEnabled',
  settingsGetProjectScope: 'settings:getProjectScope',
  settingsSetProjectScope: 'settings:setProjectScope',
  prBotRunIngestion: 'prBot:runIngestion',
  nodeRegenerate: 'node:regenerate',
  pathTrace: 'path:trace',
  diagnosticLog: 'diagnostic:log',
  diffScopeCompute: 'diffScope:compute',
  blastRadiusExpand: 'blastRadius:expand',
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
   * already alive, since the two existing Retry buttons
   * (`graphServiceStatus`'s own error state, `modelStatus`'s error state)
   * both rely on that semantics for their own failure modes, which never
   * require killing a still-alive subprocess.
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
   * Takes effect on the next index (a fresh folder open, or a manual
   * Graph Service restart) — this call itself doesn't trigger a re-index.
   * Returns the project's updated `ProjectScopeConfig` so the renderer can
   * update its state without a separate refetch.
   */
  setProjectScope: (projectPath: string, includedPaths: string[]) => Promise<ProjectScopeConfig>;
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
   */
  tracePath: (query: string) => Promise<PathTraceResult>;
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
   */
  computeDiffScope: (projectPath: string, baseRef?: string) => Promise<DiffScopeResult>;
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
   */
  expandBlastRadius: (projectPath: string, nodeIds: string[]) => Promise<BlastRadiusExpansionResult>;
}
