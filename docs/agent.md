# Agent Guide: driller

> Operational guardrails for any agent (AI or human) writing code in this repo. This is a distilled checklist of what must never break, not a restatement of the architecture — see [arc42.md](arc42.md) for the reasoning behind each rule and [prd.md](prd.md) for what's being built and why. See [README.md](README.md) for how this fits with the other docs in this folder.
>
> Keep this file short and enforceable. If a rule needs a paragraph of justification, that justification belongs in arc42.md, and this file should just link to it.

## Non-negotiable invariants

These are architecture decisions (AD-N in [arc42.md §9](arc42.md#9-architecture-decisions)) framed as hard rules. Violating one is a bug, not a style preference — flag it in review rather than working around it.

- **Never let the renderer touch the Graph Service directly.** All cross-process calls route through `apps/desktop/main`'s IPC layer. (AD-1)
- **Never do indexing, summary generation, or risk computation on the main process.** That work belongs in the `services/graph-service` subprocess, spawned via `utilityProcess`. (AD-1)
- **Never define a Graph Service operation's shape more than once.** Node lookup, Path Trace, Blast Radius, diff-scoped Node-set, and coverage-check live in `packages/graph-contracts`, transport-agnostically. The IPC layer and the MCP server both consume that one definition — neither hand-rolls its own copy. (AD-13) *[Noted 2026-09-26, P3-1]* This is the rule, not the current state. Only three MCP tools share an IPC compute path; `lookup_node` and `get_coverage_summary` have no IPC channel, and the operation shapes are spread across three packages (P4-6). See [arc42.md §6](arc42.md#6-runtime-view), "Agent query". Don't add a sixth place.
- **Every Graph Service operation returns an explicit, enumerated result state.** Never let `null`/`undefined`/an empty array stand in for "not found," "no repo," or "degraded." (AD-13, NFR4)
- **Every `BrowserWindow` sets `contextIsolation: true` and `nodeIntegration: false`, no exceptions, with the sandbox enabled wherever compatible with required native functionality.** Renderer code reaches main only through the typed `contextBridge` preload API — no direct Node/Electron access from renderer code. (AD-11)
- **Never transmit code content to any driller-operated server**, under any LLM backend configuration. This is the product's core privacy promise — evaluate any new network call against it before adding it. (AD-16)
- **Never write to the user's project filesystem or git repo.** driller's own code treats both as read-only; driller's cache/settings live entirely outside the project directory. Third-party CLI shell-outs (PR-bot ingestion) must run in non-mutating mode only — never pass a flag that grants write access. (AD-6, AD-17) *[Noted 2026-09-26, P3-3]* Known open exception: Qodo ingestion has PR-Agent write `review.md` into the repo root, then deletes it. Don't copy that pattern. See arc42.md §11's Qodo entry.
- **Any user-controlled value passed to a PR-bot CLI subprocess (branch name, project path) uses safe array-argument APIs, never shell-string interpolation.** This is a distinct concern from the non-mutating-mode rule above — that prevents an unwanted write, this prevents arbitrary command execution. (AD-12)
- **Cloud API keys are `safeStorage` ciphertext at rest, never raw** — not in `electron-store`, not in a log line (in either process), never in any payload that reaches the renderer or goes back to main. Plaintext moves only twice: the user's typed key enters renderer → main once, as the `setCloudApiKey` argument, to be encrypted (never returned); and main sends it to the Graph Service in `graphService:index` and `graphService:backendSwitched` — only while Cloud is active, never echoed back, never persisted or logged, replaced or dropped on every backend switch and key removal. Build those two requests with `graph-service-requests.ts`, and replace the Graph Service's held config only via `nextBackendConfig`. Don't add a key-, secret-, credential-, bearer- or token-named field to any other contract type, and don't pass `cloudApiKey`, `activeBackendConfig`, `backendConfig`, an `apiKey`-named value or a raw request to a log, `post*`, `send`/`reply`, `fs` write or `ipcMain` reply — the three `key-boundary.test.ts` guards fail if you do. They are syntactic: they catch those names at those sinks, not a key renamed first, so don't rename one to get past them. On Linux, warn explicitly if `safeStorage` reports a `basic_text` backend before storing anything. (AD-4, amended 2026-09-25 by P2-10)
- **No crash reporting or telemetry.** Diagnostic logging is local-only, under `app.getPath('userData')`, never transmitted. Don't add a Sentry/Bugsnag-style SDK without treating it as a privacy decision first. (AD-21)
- **Node IDs are content-stable coordinates (file path + fully-qualified symbol path), never raw line numbers.** A structural re-index must never clear an existing `summary`, `llm-judgment`, or `ingested` field for a Node whose ID is unchanged — merge-write per signal family, never a full-record replace. (AD-19, AD-20)
- **Every Node/signal source-location field is `{file, startLine, endLine}` with `file` POSIX-separator and project-root-relative.** Never an absolute path, never an OS-native separator. Normalize at the producer, not at the point of use.
- **The full Node set never renders as live rich DOM simultaneously.** Use the shared LOD/virtualization module (`apps/desktop/renderer/map/lod/`) rather than a per-mode reimplementation; a cluster/aggregate ID is renderer-local and must never flow into a Graph Service call. (AD-2)
- **The Agent-Facing Query Surface binds to `127.0.0.1` only and validates both `Origin` and `Host` on every request.** Never `0.0.0.0`; the two header checks are independent defense-in-depth (Origin-only validation alone is vulnerable to DNS-rebinding), not redundant — don't drop one because the other passed. (AD-10)
- **Never launch an external editor or OS-level URI handler from the renderer.** Route it through a typed IPC call to main, which resolves the Node's source-location path to absolute/OS-native and validates/escapes it before building any URI or subprocess argument. (AD-23)

## Repo layout quick reference

```
apps/desktop/main/       Electron main — window lifecycle, IPC routing, Graph Service spawn/teardown
apps/desktop/preload/    contextBridge-exposed typed IPC API
apps/desktop/renderer/   React + TypeScript UI (Code Map, modes, Settings)
services/graph-service/  utilityProcess subprocess — MCP client, indexing, summaries, risk signals, MCP server
packages/graph-contracts/  Transport-agnostic Graph Service operation contracts
packages/ipc-contracts/    IPC-shaped wrapper re-exporting graph-contracts
```

Full rationale for this layout: [arc42.md §5](arc42.md#5-building-block-view). Requirement-to-code mapping: [arc42.md's Capability to Architecture Map](arc42.md#capability-to-architecture-map).

## Working in this repo

- This is an npm workspaces monorepo (`apps/*`, `services/*`, `packages/*`). Run commands from the repo root (`app/`).
- `npm run typecheck` — typechecks every workspace that has a `typecheck` script.
- `npm run lint` / `npm run lint:fix` — ESLint across the repo.
- `npm test` — `node --test` over every `*.test.ts`/`*.test.tsx` under `apps/`, `packages/` and `services/`, no test framework. Requires Node 22+ (`engines`), not the 20 that only the app itself needs.
  - `scripts/find-tests.mjs` owns the glob patterns and is the entry point. It fails loudly when they match nothing — `node --test` exits 0 on an empty glob, so without it a rename could drop the repo to zero tests with every command still green. If tests move, change the patterns there AND in both renderer tsconfigs.
  - `scripts/ts-test-loader.mjs` transforms TypeScript/TSX via esbuild (transform only, never a bundle), which is what lets a test import a pure helper out of a `.tsx` module — so a helper can stay next to the logic it must agree with instead of being relocated to be testable.
  - Renderer tests are typechecked by `renderer/tsconfig.test.json`, which grants Node types. AD-11 is enforced by `renderer/tsconfig.json`, which checks those same shipped files *without* Node types — both run in `npm run typecheck`, and dropping either one removes the boundary. Never add `"node"` to `renderer/tsconfig.json` instead.
- `npm start` — runs the desktop app (`@driller/desktop` workspace) via Electron Forge.
- New code that touches an IPC channel name should follow the existing `<domain>:<action>` convention (e.g. `graphService:index:progress`), not invent a new naming scheme.
- Before designing a new Graph Service capability, check whether it fits an existing `graph-contracts` operation shape before adding a new one — the contract's whole point is one definition serving both the human UI and the agent surface.

## Current build status

*[Updated 2026-09-23]* All five v1 epics have shipped: Open a Project and Explore Its Code Map, See Where the Risk Is, Audit a PR Before Merging, Audit an Entire Codebase, and Let Agents Query What Humans See — including the Agent-Facing Query Surface (all 5 operations) and its independent MCP-listener liveness monitoring (AD-24). Story-by-story status still moves independently of this file — always check `_bmad-output/implementation-artifacts/sprint-status.yaml` for what's actually `done`/`review`/`in-progress`/`backlog` before assuming a specific behavior, rather than trusting a status claim written here to stay current forever. `_bmad-output/implementation-artifacts/` holds the per-story spec (including its own review history) for anything already built.

Two things worth knowing before extending this codebase further, not gaps to silently fill in without a deliberate decision: there's no progressive/partial-index rendering for an oversized repo (see arc42.md §11) — a too-large-to-index project fails whole, with an honest timeout/error/Retry, not a partial map; and AD-15's performance budgets remain unvalidated by real profiling (the pipeline exists now, but no benchmark run against these specific numbers is recorded anywhere).

## When requirements or architecture change

Update [prd.md](prd.md) or [arc42.md](arc42.md) directly, in the same PR as the code change that motivated it. These files are meant to stay current, not to be a point-in-time snapshot — don't let them drift from what the code actually does.
