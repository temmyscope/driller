# Driller usefulness and usability assessment

Date: 2026-10-13. Perspectives: Mary (business analyst), Sally (UX designer), Amelia (supervising engineer), Winston (architect).

## Conclusion

Driller has a substantial working v1 foundation. The next step is to make its structural evidence reliably current, easy to interpret, and fast enough to use during real review. More features alone will not establish the product's goal: a supervising engineer must reach a sound approve-or-reject decision at least as quickly and confidently as with their prior diff workflow.

The immediate priorities are stale review attribution after external changes, stale-map races, human/agent freshness parity, and the remaining read-only violation in Qodo ingestion. Section-switch latency and unbounded card widths then need attention because they interrupt comprehension on a real repository. Product success and release readiness still require evidence beyond automated feature tests.

This assessment produces recommendations, not approved architecture changes or implementation tickets. Existing [prd.md](prd.md), [arc42.md](arc42.md), and [agent.md](agent.md) remain the working requirements and implementation rules.

## What the project is trying to achieve

The primary user is a technically capable engineer supervising AI-authored changes. Their bottleneck is reconstructing what changed, how behavior flows, and where consequences concentrate. Driller puts a browsable call graph, source-grounded summaries, deterministic signals, AI judgments, and imported bot findings ahead of raw source, while keeping source readily accessible. Health Audit supports onboarding and recurring whole-codebase assessment. The local MCP surface gives other agents the same structural evidence.

The product is a local-first, read-only comprehension tool. It is not an editor, automatic reviewer/approver, hosted collaboration service, or GitHub integration. Cross-service semantic tracing and architectural code generation are explicitly excluded. Recommendations below preserve these boundaries.

Evidence: [PRD vision, journeys, non-goals and success metrics](prd.md);[original UX behavior](EXPERIENCE.md).

## Onboarding: implementation and decisions already made

| Area | Current foundation | Relevant implementation history |
| --- | --- | --- |
| Project lifecycle | Folder/recent-project entry, indexing progress, explicit degraded states, retry and close-project recovery | Epic 1; P0-3; P1-2/3; P2-1 scope application |
| Structural browsing | React Flow Code Map, shared LOD, source/detail links, external-editor handoff, trace and navigation history | Epic 1; P2-4; P4-2; FIX-1/2/7 |
| Risk evidence | Deterministic complexity/hotspot/bounded blast-radius signals, LCOV gaps and function hits, separate AI judgments, opt-in bot findings | Epic 2; P0-5; P1-1; P4-3f |
| Change review | Local-git diff scope, changed and affected rows, contract dependents and top-level changes, sortable/resizable metrics table | Epic 3; P4-3 |
| Health Audit | Directory-grouped risk-ranked cards, actual Node signal values and detail activation; its own surface rather than a tinted canvas | Epic 4; P0-2a/b/c |
| Scope navigation | Indexing allowlist sections, section-local map/operations, outgoing cross-section awareness, remembered section | P4-4a through P4-4i |
| Progressive exploration | Optional Revealed view, heuristic entry candidates, measured layered drill-down, history, persistent entry pins and shared-reach relations | P4-7a through P4-7h; FIX-5/6/7 |
| Agent access | Localhost MCP, shared operation contracts, section-aware queries, live record-derived Node lookup, six tools including entry candidates | Epic 5; P0-4; P4-6; P4-4f; P4-7c/h |
| Verification | Unit, DOM and mutation checks; isolated Electron e2e journeys; CI infrastructure | P4-8a through P4-8l |

Architecture: Electron renderer → typed preload → thin main-process orchestration → utility-process Graph Service → external MCP indexing backend. Summaries, risk computation and indexing stay out of main. Shared contracts support IPC and MCP. Keep that structure; the gaps call for stronger lifecycle guarantees, not a replacement stack or generic plugin framework.

Evidence: [architecture](arc42.md), [agent guardrails](agent.md).

### Fix history to preserve

| Fix | What it addressed | Assessment status |
| --- | --- | --- |
| FIX-1 | Fitting a trace keeps Nodes readable | Implemented; do not reopen as a missing capability |
| FIX-2 | Trace highlights actual call edges rather than a fabricated consecutive chain | Implemented; retain evidence semantics |
| FIX-3 | Header at 200% zoom, counts, initial view, Health Audit rows, explicit Retry name | Implemented |
| FIX-4 | Floating map toolbars remain legible and avoid overlap | Implemented |
| FIX-5 | Revealed/history/pin regressions and navigation to hidden Nodes | Implemented; FIX-7 addresses the later end-of-history focus failure |
| FIX-6 | Pins drawn first, bounded backend startup and actionable failures | Implemented |
| FIX-7 | Real-zoom LOD bounds, focus after Go to, painted highlighted edges, measured Revealed spacing, focus when history button disables | Implemented with recorded unit/DOM/mutation/live evidence |

FIX-7's own verification record (the spec behind commit `c67dc66`, since removed along with the rest of the planning corpus) recorded 2,302 passing tests on Node 25 and 22, clean typecheck/lint, and ten passing live e2e journeys on 2026-10-12. These are historical verification results, not checks rerun for this documentation task. Similar → Go to still needs a dense driller/app live recheck. Plain-edge styling and maximum card width are separate open decisions; they are not evidence that FIX-7 failed to fix highlighted paint or Revealed overlap.

## Four perspectives

### Mary — usefulness and outcomes

The scope aligns with a real supervising-engineer job, but the documented success bar remains unproven. Daily founder use, review speed/confidence, and independent organic adoption are jointly required. A passing test suite cannot establish any of them. Run real-change comparisons, record misleading results as well as successes, and validate an independent engineer's first review. Keep measurements local and voluntary rather than introducing telemetry.

There is also an interpretation hazard: the reference review journey says a trace confirms a change never reaches a sensitive boundary. A best-effort, section-bounded index cannot prove that absence. Position trace results as structural evidence within the indexed scope, with clear limits.

### Sally — usability and comprehension

The map now has several usable routes into dense code: sections, risk-ranked audit cards, changed/affected rows, and Revealed exploration. Existing fixes improve actual interaction, not just appearance. The remaining largest friction is the roughly five-second section switch recorded on driller/app, followed by cards that can approach 1,000 px wide and push entire Revealed columns away. Address these before deciding whether Revealed should become the default.

Finish a focused accessibility pass over the review journey: real speech output, keyboard traversal, focus under clustering/culling, minimum window size and zoom. Text in live regions and fixture assertions are useful evidence, but do not establish that the spoken experience is understandable.

### Amelia — the supervising engineer using the tool

Before trusting a review I need to know which source snapshot, base ref and scope produced it; which files are structurally missing; and whether summaries/judgments describe the current code. A silently stale contract count or fresh-looking stale summary is more damaging than an explicit unavailable result. Changed rows and blast-radius counts should be precise enough to guide inspection, and should not inflate a one-function edit into every function in a file without saying so.

I also need a clear path from risk evidence to exact source, and a reliable stop/retry boundary when the graph is refreshing. Complete the real cloud/backend-switch and bot-ingestion checks before treating those paths as verified.

### Winston — architecture supporting trust

The process isolation, shared contracts, explicit states and local privacy boundaries are appropriate. The main architectural weakness is snapshot ownership: raw maps have an index-generation guard, while other cached arrays can still adopt an older fetch. Make adoption atomic and generation-checked across every operation and outgoing UI result. Deliver staleness changes to the renderer as well as live MCP queries.

Use same-generation raw-cache builds for section switches and keep browsing separate from summary/judgment job scheduling. Isolate Qodo output away from the user's repository. Validate performance and packaged startup on the intended scale/platforms before claiming their budgets or external adoption readiness.

## Evidence limits and documentation drift

This assessment used the working docs, the planning corpus then at the project root (product brief, full PRD, architecture spine, implementation specs, live tracker, founder decisions and deferred work — all since removed), and current source/test inspection. No new GUI session, paid cloud call, installed bot run, packaged build or performance benchmark was performed. Findings explicitly labeled live come from recorded runs; code risks need targeted reproduction where stated.

Use this evidence order when records disagree: current implementation plus relevant verification; newest fix spec/live tracker; founder decision record for unresolved intent; older backlog/status summaries. Neither a `done` label nor a proposed founder recommendation substitutes for acceptance.

- The sprint tracker was dated 2026-09-23 and still had many stories in `review`, while `agent.md` claimed all five epics shipped. Neither alone described October readiness. *[Resolved 2026-10-21: the tracker is gone and [status.md](status.md) is now the repo's single build-status authority, with a date against every claim.]*
- PRD UJ-2 still promises progressively completing indexing. Architecture §11 explicitly retains all-or-nothing structural indexing. New projects do correctly start in Health Audit (`App.tsx`); do not classify that behavior as missing.
- FR14 lists five MCP operations; the current implementation and architecture include entry candidates as a sixth. MCP entry relations are intentionally capped at 50 with a total, unlike IPC; this disclosed cap is not accidental parity drift.
- The old deferred entry claiming an SDK 60-second indexing timeout is superseded: `mcp-client.ts` passes the configured request timeout and `mcp-client.index.test.ts` checks an index taking over 60 seconds.

Reconcile these in the existing living documents when the corresponding work is accepted. Keep tracking and future updates consolidated; no separate report per persona is needed.
