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
| **See Where the Risk Is** (FR7–FR9) | Shipped | Epic 2; P0-5; P1-1; P4-3f. Deterministic complexity/hotspot/blast-radius signals, LCOV gaps, separate AI judgments, opt-in bot findings. |
| **Audit a PR Before Merging** (FR11, FR12) | Shipped | Epic 3; P4-3. Local-git diff scope, changed/affected rows, contract dependents, sortable metrics table. Checkout-move detection added 2026-10-15 (P5-a, `1e1af7e`). |
| **Audit an Entire Codebase** (FR13) | Shipped | Epic 4; P0-2a/b/c. Directory-grouped risk-ranked cards on their own surface. |
| **Let Agents Query What Humans See** (FR14, FR15) | Shipped | Epic 5; P0-4; P4-6; P4-4f; P4-7c/h. Six MCP tools, not FR14's five — entry candidates is the sixth, with relations capped at 50 plus a total (disclosed, not parity drift). AD-24 MCP-listener liveness monitoring is in. |
| **Indexing scope sections** | Shipped | P4-4a–P4-4i; section-local map/operations, outgoing cross-section awareness, remembered section. |
| **Section-switch latency** | Shipped, live unverified | P5-b (`9406588`, 2026-10-18) serves a same-generation request from the raw cache; bench reports ~11 ms at 2k Nodes and ~59 ms at 10k. The ~5 s switch the 2026-10-13 assessment recorded on driller/app has not been re-measured live since. |
| **Revealed view / progressive exploration** | Shipped | P4-7a–P4-7h; FIX-5/6/7. Heuristic entry candidates, layered drill-down, history, persistent pins, shared-reach relations. Harness/fixture files excluded as roots (P5-e, `102eaa8`). |
| **Full map laid out by the call graph** | Shipped | `ba062d8` (2026-10-20). `communities.ts` partitions Nodes by who calls whom; `communityLayout.ts` draws each community as its own block by hop depth. Renderer-local layout only — a community id never reaches a Graph Service call (AD-2). Below 40 connected Nodes the map is not partitioned. |
| **Collapsed community cards** | Shipped | `72f72af` (2026-10-21). Full opens on one card per community (count, cohesion as two real counts, "↗ N out"), with a Grouped / All Nodes toggle, pooled islands, and generated community names. Known limit, by design: a link edge draws only between two *collapsed* cards. |
| **Local model download gating** | Shipped | P5-c (`f3a9c69`, 2026-10-18). Cloud never downloads the local model; e2e asserts no Hugging Face host is contacted. |
| **Cloud backend path** | Shipped, live unverified | Key handling (AD-4, P2-10) and switch-failure messaging (P5-g) are in and tested. No recorded real paid cloud call or backend-switch run — assessment 2026-10-13 asks for one before treating this path as verified. |
| **PR-bot ingestion (CodeRabbit, Qodo)** | Shipped, live unverified | FR9 path exists; no recorded installed-bot run. Carries an open read-only violation, below. |
| **Node 24 LTS / engines** | Shipped | P5-h (`17836f3`, 2026-10-18). `.nvmrc` 24; `engines.node` `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; CI gates on 22.x and the `.nvmrc` 24 leg. |
| **Verification suite** | Shipped | 2,559 unit and DOM tests, clean typecheck and lint, and 11 Electron e2e journeys passing against the real app as of `72f72af` (2026-10-21). e2e journeys hardened and run three times in a row on Node 24 at `25cfaaa` (2026-10-19). |

## Open and unverified

- **Snapshot ownership across cached arrays.** Raw maps have an index-generation
  guard; other cached arrays can still adopt an older fetch. Adoption should be
  atomic and generation-checked across every operation and outgoing UI result,
  renderer included, not only live MCP queries. (Assessment 2026-10-13,
  Winston.)
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
- **shadcn/ui.** AD-3 names it; it was never adopted and no shadcn, Radix or
  Tailwind dependency exists. Whether AD-3 drops it is a founder decision.

## Keeping this current

Update this file in the same change as the work it describes, the same way
[prd.md](prd.md) and [arc42.md](arc42.md) are updated. Prefer demoting a row to
*live unverified* over deleting it: "we never checked" is information. Date
every claim — a state with no date behind it is the drift this file exists to
prevent.
