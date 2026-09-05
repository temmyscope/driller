# Product Requirements: driller

> Living PRD, tracked in-repo so requirements evolve alongside the code. Distilled from the founder's original [product brief](../../_bmad-output/planning-artifacts/briefs/brief-driller-2026-09-02/brief.md) and [full PRD](../../_bmad-output/planning-artifacts/prds/prd-driller-2026-09-03/prd.md) (2026-09-03), which remain the historical record of *how* these requirements were derived. This file is the current source of truth — update it directly as requirements change; don't fork a v2 alongside it.
>
> See [README.md](README.md) for how this fits with the other docs in this folder.

## 1. Vision

driller is the first screen a supervising engineer opens when an AI agent finishes writing code — before the diff, before the file tree, before a chat with the agent. Instead of reconstructing what changed by reading unified diffs, the engineer opens a hyperlinked, AI-summarized **Code Map** of the codebase, traverses it structurally, and sees exactly what a change touches, how far its effects reach, and where the risk actually concentrates — with raw source always one click away, never the starting point.

driller treats code review as a comprehension problem, not a diff-reading problem:

- It doesn't compete with AI PR-review bots that already flag inline bugs — it ingests their findings as another signal on the map.
- It doesn't withhold its structural view from the agents that write the code — the same Code Map, summaries, and risk signals are queryable by other agents through an agent-facing surface, not locked behind a human-only UI.
- It doesn't pretend AI-generated summaries are infallible — every summary is flagged stale the moment it drifts from source, and every summary is one click from the code it describes.

v1 ships as a single Electron desktop application, open-source, built to be used daily by its own founder on real repositories before it is offered to anyone else.

## 2. Target User

**Primary persona — the Supervising Engineer.** A software engineer or architect whose role is shifting from writing code to directing and auditing AI agents that write it. Technically strong enough to make a correct call given the right information fast — the bottleneck isn't judgment, it's how long it takes to *get* the information.

**Secondary — the onboarding engineer.** Someone assessing an unfamiliar codebase (their own team's or an OSS project's) using Health Audit Mode as a structural map instead of reading the whole repo cold. Not the primary v1 design target, but a natural beneficiary of the same surface.

**Explicit non-users (v1):** engineers wanting an IDE replacement; non-technical stakeholders (the Code Map assumes the reader can interpret call graphs and source); teams wanting a shared/hosted multi-user view of the same repo; organizations needing GitHub/GitLab/CI-gate integration.

### Jobs To Be Done

- Understand what an AI agent's change actually touches — structurally, not just textually — fast enough that review doesn't become the new bottleneck.
- Assess an unfamiliar or inherited codebase's overall health and risk concentration without reading it end to end.
- Answer "what happens when this endpoint/mutation/job runs" without manually following call sites by hand.
- Approve or push back on AI-written code with real confidence, not resignation to a rubber stamp.
- Stay the accountable party for a codebase's quality as authorship shifts to agents.

### Key User Journeys

**UJ-1 — Dani approves an agent's change without reading the raw diff.** Dani switches to PR Review Mode, selects a base ref; driller highlights changed Nodes and their Blast Radius. A changed Node carries a Risk Overlay finding from Dani's configured PR-bot. Dani reads the Node's summary and finding, runs a Path Trace to confirm the change never reaches a sensitive boundary, then approves — in a fraction of the time a full diff read would take. *Failure path:* if graph coverage is incomplete for a touched file, that Node shows a Coverage Gap flag instead of a confident summary, so Dani knows to read that file directly.

**UJ-2 — Sam audits an inherited AI-heavy codebase before a handoff.** Sam opens the repo for the first time; driller indexes progressively and lands Sam in Health Audit Mode by default, with hotspots and low-coverage Nodes visible clustered. Sam traces a path from an entry point through the suspect module to confirm the risk is real, then produces a punch list grounded in the actual call graph. *Failure path:* a repo too large to index synchronously still shows a progressively-completing map rather than blocking.

## 3. Glossary

| Term | Meaning |
| --- | --- |
| **Code Map** | The hyperlinked, AI-summarized call graph that is driller's primary and default UI surface. Composed of Nodes and edges. |
| **Node** | A single addressable unit on the Code Map (function, method, module, or endpoint) carrying an AI-generated summary and Risk Overlay signals. |
| **Path Trace** | An ordered, searchable sequence of Nodes representing how a request/call flows from an entry point to its terminal effect. |
| **Risk Overlay** | The combined set of signals rendered on Nodes: deterministic, LLM-judgment, and ingested PR-bot findings. |
| **Blast Radius** | The set of Nodes structurally reachable from, or dependent on, a changed Node. A deterministic signal. |
| **Staleness Indicator** | A flag on a Node's AI summary showing the underlying source changed since the summary was last generated. |
| **Coverage Gap** | A flag shown on a Node instead of a confident-looking summary, when the underlying Graph Service index has incomplete structural coverage for that Node's file. Distinct failure mode from the Staleness Indicator: missing data, not outdated data. |
| **Graph Service** | driller's internal adapter between its own UI/query logic and the underlying MCP-based code-graph backend — the seam that keeps the backend swappable. See [arc42.md §3, §5](arc42.md). |
| **PR Review Mode** | Mode scoped to a single local git change (diff against a selected branch or commit). |
| **Health Audit Mode** | Mode presenting the whole-repo Code Map and Risk Overlay, independent of any single change. |
| **Agent-Facing Query Surface** | The MCP server / API through which other agents and tools query the Code Map, summaries, and Risk Overlay. |
| **Supervising Engineer** | The primary persona (see §2). |

## 4. Functional Requirements

Grouped by feature area. Each FR is the stable ID referenced by [arc42.md's Capability to Architecture Map](arc42.md#capability-to-architecture-map) and by the sprint tracker in `_bmad-output/implementation-artifacts/sprint-status.yaml`.

### 4.1 Project Load & Indexing
- **FR1 — Load Local Project.** Open a local folder as a driller project. Detects a git repo at the folder root or a parent/child folder and confirms before indexing; shows indexing progress within 5s of folder selection; persists a recent-projects list.
- **FR2 — Coverage Transparency.** Surfaces Graph Service index coverage honestly. A coverage summary shows on completed indexing; a Node relying on a file with incomplete coverage shows a Coverage Gap flag inline instead of a confident-looking summary.

### 4.2 Code Map (map-first browsing)
- **FR3 — Map as Default Entry.** The Code Map is the only landing view — no file-tree-first or editor-first view exists. Raw source for any Node is reachable in exactly one click.
- **FR4 — Node Traversal.** Follow call/dependency edges without leaving the map. Selecting an edge or "called by / calls" affordance re-centers the map; back/forward history is supported.

### 4.3 AI-generated Node summaries
- **FR5 — Per-Node Summary.** Every Node with resolvable source shows a plain-language AI summary generated from its actual source. Regeneration is triggered by the staleness mechanism (FR16).
- **FR6 — Summary Backend Configuration.** Configurable local/on-device model or bring-your-own-key cloud provider. v1 ships at least one of each. No code content is transmitted to any driller-operated server under either configuration. Switching backend regenerates summaries only, never the graph index.

### 4.4 Risk & complexity overlay
- **FR7 — Deterministic Signal Overlay.** Complexity, Blast Radius, test coverage gaps, and hotspots. Each is reproducible; toggles independently of the LLM-judgment layer.
- **FR8 — LLM-Judgment Signal Overlay.** Qualitative risk judgment, visually distinguished from deterministic signals at all times; toggles independently.
- **FR9 — Ingested PR-Bot Findings.** Findings from configured external AI PR-review bots (e.g. CodeRabbit, Qodo) render as a Risk Overlay signal type. Opt-in per project, disabled by default; a Node with a finding shows the originating tool and finding text; absence of any integration doesn't degrade other overlays.

### 4.5 Path Trace search
- **FR10 — Path Trace Search.** Search a request/call path (REST, GraphQL, or gRPC entry point) and get a traceable, ordered path. Free-text or structured input; renders as a highlighted route on the map itself, not only a text list; an unfound path states that explicitly.

### 4.6 PR Review Mode
- **FR11 — Git-Scoped Review.** Scope the Code Map to a local git change — diff against a selected branch or commit. Local git only, no platform connection. Changed Nodes are visually distinguished from unchanged ones.
- **FR12 — Blast Radius on Change.** Highlights the computed Blast Radius (FR7) of changed Nodes; interactively expandable by hop depth (1-hop, 2-hop, ...).

### 4.7 Health Audit Mode
- **FR13 — Whole-Repo Audit View.** Full-repo Code Map with the Risk Overlay applied, independent of any single change, reachable without selecting a git ref. Overlay signals aggregate visually (heatmap-style).

### 4.8 Agent-facing query surface
- **FR14 — MCP/API Graph Query.** Other agents and tools query driller's Code Map — structure, summaries, Risk Overlay — via an MCP server or API. Minimum surface: Node lookup, Path Trace, Risk Overlay signal retrieval. No data leaves the local machine beyond what the querying agent's own runtime already has. Documented contract ships with v1.
- **FR15 — Agent Query Parity.** Signals returned via the agent-facing surface match what the human UI displays for the same Node/path at the same point in time, including the Staleness Indicator.

### 4.9 Trust indicators
- **FR16 — Staleness Indicator.** Flags an AI-generated summary stale when the underlying source has changed since generation. Checked on every index refresh; visually distinct in the UI and flagged in the agent-facing response; regeneration is user-triggered, never automatic.
- **FR17 — Source One-Click-Away.** Every summary and every Risk Overlay signal links directly to the exact source range it describes, opening in-app in one action.

## 5. Non-Functional Requirements

- **NFR1 — Performance.** Handle a repo of ~1,000–1,300 files / ~250,000–320,000 total LOC acceptably at launch. Initial full index under 3 minutes, incremental re-index under 5 seconds, indexing progress visible within 5 seconds of folder selection. (Architecture-provisional — see AD-15 in [arc42.md §9](arc42.md#9-architecture-decisions).)
- **NFR2 — Reliability.** The Graph Service degrades gracefully when its backend is unavailable: a clear degraded-state message, never a crash or a silently stale/wrong map.
- **NFR3 — Security.** Local git and filesystem access is read-only except for driller's own local cache/index storage; no code-content telemetry to driller-operated infrastructure by default; every `BrowserWindow` uses `contextIsolation` and disables `nodeIntegration`.
- **NFR4 — Observability / Trust.** Coverage gaps and staleness are the only two "something might be wrong here" states surfaced to the user; every other degraded state must be visible in the UI and the agent-facing surface alike — none may fail silently.
- **NFR5 — Accessibility.** No formal WCAG-level conformance target is set for v1 (deferred). Two floors hold regardless: Risk Overlay signal families and trust flags are never distinguished by color alone; Code Map traversal and mode switching have a keyboard path.

## 6. UX Requirements

Full behavioral and visual design detail lives in the UX design spine (`_bmad-output/planning-artifacts/ux-designs/ux-driller-2026-09-03/`); this section captures only the requirements that constrain scope.

- Dark-first color mode is the primary design target; light mode is secondary/derived.
- Every code identifier renders in monospace, everywhere, without exception.
- The Code Map must never read as a BI/analytics dashboard — no stat tiles, no data-viz flourishes divorced from actual code structure.
- Risk Overlay signal families and trust flags are distinguished by shape/icon, never color alone.
- Every "something needs attention" state (no path found, backend degraded, cloud key missing, tool not found, etc.) uses one consistent shape: an icon, one specific sentence, and — when one exists — exactly one next action. Never a silent empty state, never a vague apology.
- No inline-comment-wall review UX, no IDE creep (no code editing/execution surface), no auto-approve/auto-merge action, no cross-repo switcher — see Non-Goals below.

## 7. Non-Goals (Explicit)

- Not an IDE — no code editing or execution from within the app, regardless of how convenient it might look later.
- Does not auto-approve or auto-merge changes. Every decision surface informs the Supervising Engineer; none decides for them.
- Does not rebuild AI PR-review bot functionality — ingests their findings (FR9) rather than competing with them.
- Not a cross-repo or multi-repo tool in v1 — one local project per session.
- No GitHub/GitLab/Bitbucket platform integration in v1 — no webhooks, no inline PR comments, no CI-gate status. Change scoping is local-git-only (FR11).
- Does not claim solved AI-summary accuracy — staleness indication and source-linking are a mitigation, not a guarantee.
- Not a hosted or multi-tenant service — local-first, single engineer, single machine.
- Does not build a fully pluggable multi-backend graph abstraction — the Graph Service stays a thin adapter over one chosen MCP-based backend.

## 8. MVP Scope

**In scope for v1**, organized as delivery epics (full story-level breakdown and current status: `_bmad-output/planning-artifacts/epics.md` and `_bmad-output/implementation-artifacts/sprint-status.yaml`):

1. **Open a Project and Explore Its Code Map** — FR1–FR6, FR10, FR16, FR17. The foundational map-before-code experience.
2. **See Where the Risk Is** — FR7–FR9. Deterministic, LLM-judgment, and ingested-finding overlays.
3. **Audit a PR Before Merging** — FR11, FR12. PR Review Mode; realizes UJ-1.
4. **Audit an Entire Codebase** — FR13. Health Audit Mode; realizes UJ-2.
5. **Let Agents Query What Humans See** — FR14, FR15. The Agent-Facing Query Surface.

**Out of scope for v1** (real candidates for later, not rejected):
- Standing companion / live mode alongside an active agent session.
- Web UI + local companion-daemon distribution variant.
- Any premium/commercial tier or licensing mechanics.
- Multi-repo / cross-repo mapping; team/multiplayer sharing.
- Cross-service API tracing (tracing a frontend call into a separate backend service) and architecture-recommendation/refactor-preview — see [arc42.md §11 Risks and Technical Debt](arc42.md#11-risks-and-technical-debt) for why these are deliberately excluded from driller itself rather than merely deferred.

## 9. Success Metrics

**Required, jointly — MVP is not a success unless all three hold.** (The source PRD labels these "Primary," but don't read that as ranking SM-3 below SM-1/SM-2: no subset of the three is sufficient on its own.)

- **SM-1.** Daily dogfood usage — the founder opens driller as the actual entry point for reviewing AI-authored changes on real repos.
- **SM-2.** Review speed and confidence — time to approve-or-reject an AI-authored change through driller is faster than, or no worse than, the prior diff-reading baseline, with no drop in confidence.
- **SM-3.** Organic adoption — engineers beyond the founder open a driller project on their own repo without direct outreach.

**Secondary — genuinely optional confirmation signals, not part of the joint bar above:**

- **SM-4.** Health Audit Mode used recurringly, not only at first-open onboarding.
- **SM-5.** The Agent-Facing Query Surface is actually queried by at least one other agent or tool during the MVP window.

**Counter-metrics (do not optimize toward zero):**
- **SM-C1.** Risk Overlay dismissal rate should not be driven to zero signals shown — a quiet overlay could mean under-detection.
- **SM-C2.** Staleness-indicator frequency should not be minimized by suppressing the flag rather than earning freshness through real regeneration.

## 10. Open Questions

Carried forward from the original PRD; resolve in place here as decisions land rather than tracking them separately.

1. Formal accessibility conformance target for v1 (currently: no formal target, two behavioral floors only — see §5 NFR5).
2. What Path Trace (FR10) should cover beyond REST/GraphQL/gRPC entry points — background jobs, event/message flows, CLI entry points are plausible future extensions.
3. Inherited ecosystem risk from betting on an MCP-based Graph Service backend: coverage is best-effort, not guaranteed-complete, and driller inherits that backend's own language/framework coverage gaps and release cadence.
4. Standing companion mode design, web + companion-daemon variant, premium/commercial tier shape, team/multiplayer use, full hallucination-proofing of AI summaries, and AI-agent commit provenance all remain open by design — not scoped for v1, not reopened here.
