# Build Status: driller

> Living record of what is actually built, what is open, and what has only been
> claimed rather than verified. This is the repo's single authority on build
> status — [agent.md](agent.md) points here rather than carrying its own copy,
> and nothing else in `docs/` should assert that a capability shipped.
>
> See [README.md](README.md) for how this fits with the other docs in this
> folder. Requirements live in [prd.md](prd.md), architecture in
> [arc42.md](arc42.md).

## How to read this

Every row carries a state and the evidence behind it, with the date that
evidence was produced. A state is a claim about *the evidence*, not a promise
about behavior:

- **Shipped** — in the tree, with automated tests, and exercised live at least
  once on a real repository.
- **Shipped, live unverified** — in the tree with automated tests, but no
  recorded run against a real repository or real external service.
- **Open** — known to be incomplete or wrong, deliberately, with a pointer to
  where it's described.
- **Not built** — decided against or deferred for v1; not a gap to quietly fill.

When records disagree, prefer in this order: the current implementation plus
its verification; the newest commit or fix record; a founder decision for
unresolved intent; older summaries last. A green test suite does not establish
usefulness, and neither does a state in this table.

## Capabilities

| Capability | State | Evidence |
| --- | --- | --- |
| **Open a Project and Explore Its Code Map** (FR1–FR6, FR10, FR16, FR17) | Shipped | Epic 1; P0-3; P1-2/3; P2-1. Assessment 2026-10-13 confirms folder/recent-project entry, indexing progress, explicit degraded states, retry and close-project recovery. |
| **See Where the Risk Is** (FR7–FR9) | Shipped | Epic 2; P0-5; P1-1; P4-3f. Deterministic complexity/hotspot/blast-radius signals, LCOV gaps, separate AI judgments, opt-in bot findings. Pairwise co-change added 2026-10-22 (`6f44910`, `52b6802`): `FILE_CHANGES_WITH` as a sixth deterministic signal, with the co-changing files named in Node detail. |
| **Audit a PR Before Merging** (FR11, FR12) | Shipped | Epic 3; P4-3. Local-git diff scope, changed/affected rows, contract dependents, sortable metrics table. Checkout-move detection added 2026-10-15 (P5-a, `1e1af7e`). |
| **Audit an Entire Codebase** (FR13) | Shipped | Epic 4; P0-2a/b/c. Directory-grouped risk-ranked cards on their own surface. |
| **Let Agents Query What Humans See** (FR14, FR15) | Shipped | Epic 5; P0-4; P4-6; P4-4f; P4-7c/h. Six MCP tools, not FR14's five — entry candidates is the sixth, with relations capped at 50 plus a total (disclosed, not parity drift). AD-24 MCP-listener liveness monitoring is in. |
| **Indexing scope sections** | Shipped | P4-4a–P4-4i; section-local map/operations, outgoing cross-section awareness, remembered section. |
| **Section-switch latency** | Shipped, live unverified | P5-b (`9406588`, 2026-10-18) serves a same-generation request from the raw cache; bench reports ~11 ms at 2k Nodes and ~59 ms at 10k. The ~5 s switch the 2026-10-13 assessment recorded on driller/app has not been re-measured live since. |
| **Revealed view / progressive exploration** | Shipped | P4-7a–P4-7h; FIX-5/6/7. Heuristic entry candidates, layered drill-down, history, persistent pins, shared-reach relations. Harness/fixture files excluded as roots (P5-e, `102eaa8`). |
| **Full map laid out by the call graph** | Shipped | `ba062d8` (2026-10-20). `communities.ts` partitions Nodes by who calls whom; `communityLayout.ts` draws each community as its own block by hop depth. Renderer-local layout only — a community id never reaches a Graph Service call (AD-2). Below 40 connected Nodes the map is not partitioned. |
| **Collapsed community cards** | Shipped | `72f72af` (2026-10-21). Full opens on one card per community (count, cohesion as two real counts, "↗ N out"; the pooled-islands card says "each group calls only itself" instead, `e8a9eb6`), with a Grouped / All Nodes toggle, pooled islands, and generated community names. Known limit, by design: a link edge draws only between two *collapsed* cards. |
| **Local model download gating** | Shipped | P5-c (`f3a9c69`, 2026-10-18). Cloud never downloads the local model; e2e asserts no Hugging Face host is contacted. |
| **Cloud backend path** | Shipped, live unverified | Key handling (AD-4, P2-10) and switch-failure messaging (P5-g) are in and tested. No recorded real paid cloud call or backend-switch run — assessment 2026-10-13 asks for one before treating this path as verified. |
| **PR-bot ingestion (CodeRabbit, Qodo)** | Shipped, live unverified | FR9 path exists; no recorded installed-bot run. Carries an open read-only violation, below. |
| **Node 24 LTS / engines** | Shipped | P5-h (`17836f3`, 2026-10-18). `.nvmrc` 24; `engines.node` `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; CI gates on 22.x and the `.nvmrc` 24 leg. |
| **Verification suite** | Shipped | 2,599 unit and DOM tests across 626 suites, clean typecheck and lint, and all 11 Electron e2e journeys passing against the real app in 253 s with real userData untouched, as of `f3f383a` (2026-10-25). e2e journeys hardened and run three times in a row on Node 24 at `25cfaaa` (2026-10-19). Reproducing the e2e leg means no ambient `codebase-memory-mcp` at all — see below. |

## Open and unverified

- **An e2e run cannot coexist with an ambient backend, including the editor's.**
  `decidePreflight` refuses while *any* `codebase-memory-mcp` process is alive,
  because the run starts its own daemon and stops only that one. Each Claude Code
  session with the backend configured as a user-level MCP server holds a child of
  its own, so stopping the backend by hand does not stick — those processes have to
  go too (`2026-10-25`: four of them, across three idle sessions). Worth a narrower
  check — the port plus a daemon, rather than every process — but loosening a safety
  check to make a run go green is the wrong way round, so it stands as is.
- **Snapshot ownership across cached arrays — service side closed, renderer
  open.** `[2026-10-25]` A Code Map fetch still in flight when an index starts
  lands in `activeCodeMapNodes`/`activeCodeMapEdges` but never in the raw
  cache, so `getActiveRawCodeMap()` reports no current stamp. Entry candidates
  asked for that stamp since P4-7c; the others did not. Measured by driving the
  real sequence — map open, refetch starts, re-index of the same project begins
  before it lands — a whole-scope diff scope returned a *fully resolved* result
  over the previous generation's Nodes (changed contracts, dependent ids and
  all, nothing marking it stale), Blast Radius expansion returned confident hop
  distances, and `lookup_node` described a Node at the previous index's line
  range. With a `section` all three already refused, via
  `resolveCachedSectionFilter`; only the whole-scope path was exposed.
  Fixed in `584d7fa` and `41faa8c`: diff scope, Blast Radius expansion and the
  `startMcpServer` Nodes getter now ask the same stamp, so every service-side
  reader of the cached arrays refuses a generation-old map
  (`MAP_REFRESHING_RESULT`, or `lookup_node`'s existing "No project has
  finished indexing yet."). **Still open:** the renderer holds its own copies
  of nodes and edges and is not generation-checked, so the original item's
  "every outgoing UI result, renderer included" is only half met. (Assessment
  2026-10-13, Winston.)
- **Qodo ingestion writes into the user's repo.** PR-Agent writes `review.md`
  into the repo root and driller deletes it afterwards — a live exception to the
  never-write-to-the-user's-repo invariant. See [arc42.md §11](arc42.md#11-risks-and-technical-debt)
  and [agent.md](agent.md); don't copy the pattern.
- **`lookup_node` and `get_coverage_summary` have no IPC channel.** The contracts
  exist and the agent surface uses them; the human UI has no route to them.
  ([arc42.md §6](arc42.md#6-runtime-view), "Agent query".)
- **AD-15 performance budgets are unprofiled.** The pipeline exists; no benchmark
  run against those specific numbers is recorded anywhere. Packaged-build
  startup on the intended platforms is likewise unmeasured.
- **Accessibility pass over the review journey is outstanding.** NFR5's two
  floors hold (no color-only distinctions, keyboard traversal exists). Real
  speech output, focus under clustering/culling, and zoom have not been checked
  live; live-region text and fixture assertions do not establish that the spoken
  experience is understandable.
- **Plain-edge faintness owed a live visual judgement.** P5-f (`42943e7`) paints
  plain edges at DESIGN.md's `border-strong`; whether that reads correctly on a
  dense map has not been judged live.
- **Similar → Go to needs a dense live recheck** on driller/app. (Assessment
  2026-10-13.)
- **Product success metrics are unestablished.** Daily founder use, review
  speed/confidence against the prior diff workflow, and independent organic
  adoption are jointly required and none is measured. A passing test suite
  cannot establish any of them. (Assessment 2026-10-13, Mary.)

## Not built, deliberately

- **Progressive / partial-index rendering for an oversized repo.** A
  too-large-to-index project fails whole, with an honest timeout/error/Retry,
  not a partial map. [arc42.md §11](arc42.md#11-risks-and-technical-debt) retains
  all-or-nothing structural indexing; PRD UJ-2's "progressively completing
  indexing" is the older promise and is the one that would have to change.
- **Outer per-job retry around summary generation.** `p-retry` was planned in an
  early draft and never built; SDK-level retry is all there is. ([arc42.md §8](arc42.md#8-crosscutting-concepts),
  AD-8.)
- **Revealed as the default Code Map view.** `[decided 2026-10-22]` Proposed in the 2026-10 assessment as a way off a Full map whose card positions carried no meaning. That premise is gone: Full map is now laid out by the call graph and opens on community cards (`ba062d8`, `72f72af`), so the default it would have replaced no longer exists. Revealed stays opt-in and unchanged. Closed rather than deferred — see `EXPERIENCE.md`'s Revealed row for what would re-open it.
- **A cycle / recursion risk signal (the second half of "spend the unused
  signals").** `[decided 2026-10-25]` The backend does carry the data —
  `Function` and `Method` each have `recursive`, `self_recursive`,
  `unguarded_recursion`, `recursion_in_loop`, `loop_depth` and
  `transitive_loop_depth` — so the premise that it was there was right. It does
  not survive being measured on driller/app (2,870 functions):
  - **Every CALLS self-edge is a resolution artifact.** All 37 of them come from
    `strategy: 'callee_suffix'` at `confidence: 0.50`, the weakest resolver;
    none from a reliable one. One is a `Map.delete(...)` call resolved back to
    its own enclosing function. So the call graph contains no trustworthy
    2-cycle, and a "this is part of a cycle" claim would be built on noise.
  - **`recursive` (68) contradicts `self_recursive` (25)** and the 43-function
    gap is those same artifacts. `self_recursive` is AST-derived and accurate —
    spot-checked against source — and is the one to trust.
  - **`unguarded_recursion` (11) is a false alarm here.** It means "no numeric
    depth guard", not "can run away": the flagged functions are structural
    recursion with explicit base cases (`textOf` has three), and 8 of the 11 are
    test helpers or tree walkers.
  - **`transitive_loop_depth` saturates.** Its distribution jumps back up at 8
    and 10 (12 and 25 functions) with nothing at 9, because it is a reachability
    maximum over the call graph that is not gated on the callee being invoked
    inside a loop. 24 of the 25 at depth 10 are test harnesses whose own
    `loop_depth` is 0; they inherit 10 by mounting `CodeMap`.
  - **What is left is too small to be a signal.** Genuine self-recursion in
    driller's own non-test code is three functions out of 2,870
    (`findGitRootDownward`, `schedule`, `renderNodes`), all deliberate and safe.
    `loop_depth` is sound (0–3) but nested loops already drive the `complexity`
    and `cognitive` signals, so a seventh would correlate with two existing ones.

  A signal here would paint a warning glyph on safe code — the same fabricated
  alarm as the "74% gap" row and the pooled card's 1.00 cohesion, both of which
  this project removed. Closed rather than deferred. What would re-open it: a
  backend that resolves self-calls with a real strategy, or `unguarded_recursion`
  distinguishing a missing base case from a missing depth counter. The adjacency
  comment in `CodeMap.tsx` that used to call a self-loop "a recursive call" was
  corrected in the same change.

- **shadcn/ui.** AD-3 names it; it was never adopted and no shadcn, Radix or
  Tailwind dependency exists. Whether AD-3 drops it is a founder decision.

## Keeping this current

Update this file in the same change as the work it describes, the same way
[prd.md](prd.md) and [arc42.md](arc42.md) are updated. Prefer demoting a row to
*live unverified* over deleting it: "we never checked" is information. Date
every claim — a state with no date behind it is the drift this file exists to
prevent.
