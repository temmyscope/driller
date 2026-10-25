# Enterprise fork: requested capabilities

> **This is not driller's backlog.** driller (this repo) is open source. The
> items below are for a planned **enterprise fork**: a separate folder, a
> separate repository, forked from this one. Nothing here is a commitment for
> this repo, and nothing here should be read as shipped — [status.md](status.md)
> remains the single authority on what driller itself has built.
>
> Recorded 2026-10-25 from the founder's list, before any design work. Where an
> item is already partly served by driller today, that is noted so the fork
> starts from what exists rather than rebuilding it.

## How to read this

Each item carries **what was asked**, then **what driller already has**
(verified this session unless marked otherwise), then **what is actually open**
and any constraint the fork would inherit. The fork inherits driller's
invariants unless it deliberately drops them — in particular AD-17
(non-mutating integrations) and the rule that driller never writes into the
user's repository.

---

## 1. A PR summary page, openable in driller or a browser

**Asked:** in PR mode, generate a summary HTML page, reachable from a
browser/globe-style icon, that opens either inside driller or in an external
browser.

**What driller has:** PR Review mode with the changed/affected rows, contract
dependents and the sortable metrics table. All of it is on-screen state; there
is no export of any kind.

**Open:** the generation and the two open paths. Two constraints worth fixing
before design:

- **Where the file goes.** Writing the page into the repository root would
  repeat the one live invariant violation driller already has (Qodo's
  `review.md`, see [status.md](status.md) and [arc42.md §11](arc42.md#11-risks-and-technical-debt)).
  The page belongs in `userData` or a temp dir, with the repo untouched.
- **What it may contain.** A shareable artifact of a private codebase is a
  disclosure surface: source excerpts, file paths and AI judgments all leave
  the machine the moment someone forwards it. Worth deciding deliberately
  whether the page embeds code or only structure.

## 2. A terminal inside driller

**Asked:** can driller include a terminal? What would it be for, and how would
it work?

**Assessment — a general terminal is the wrong shape; a contextual runner is
the right one.** Taking the three parts separately:

- **Usefulness.** The genuine wins are all *bound to the Node you are looking
  at*: run the tests that cover this function (driller already knows them via
  `attachTestedBy`), blame it, check out the PR branch, re-index. That is a
  small set of known commands with the selected Node as their argument — not a
  shell. A general terminal's value over the one the engineer already has in
  their editor is close to zero, while its cost is high.
- **Cost.** A terminal can do anything, so it dissolves both the
  never-write-to-the-user's-repo rule and AD-17's non-mutating framing in one
  move: afterwards driller cannot claim either. It also adds a real surface
  (PTY lifecycle, shell integration, scrollback, escape handling) to a product
  whose differentiator is the map.
- **How it would work, if built.** `node-pty` in **main**, never the renderer —
  AD-11 withholds Node types from the renderer precisely so this cannot happen
  there — with a typed preload channel streaming bytes both ways and `xterm.js`
  rendering. The project root as cwd, and the spawn explicitly user-triggered.

**Recommendation:** build "run this Node's tests" with streamed output and an
explicit user trigger, not a shell. It is most of the value at a fraction of
the surface, and it keeps the invariant: driller invokes the project's own test
command on request and still writes nothing.

## 3. A Node's name should carry its method and its interface or class

**Asked:** the Node name should be the method name plus, where applicable, the
interface/object/class it implements or is implemented in.

**What driller has:** a Node's `name` is the bare symbol name. The backend
distinguishes `Function` from `Method` and `Method` carries `parent_class`;
`Class` and `Interface` carry `base_classes`. `Interface` and `Type` Nodes are
folded out of the map into a side index (`fold-types.ts`), so the implements
relationship is present in the data but not in any name.

**Open:** composing the display name, and deciding what it does to the map.
Longer names change card widths, which feeds straight into the community
layout's measured sizes. Likely the right split is a composed name in Node
detail and the bare name on the card — the same direction already taken for
types, interfaces, modules and tests, which were judged map noise and folded
into detail.

## 4. In PR mode, say how a change alters a Node's behaviour

**Asked:** write how the change in the Node changes its behaviour.

**What driller has:** changed Nodes, changed contracts and their dependents —
all structural. Nothing states behavioural intent.

**Open:** this is necessarily an **AI judgment, not a deterministic signal**,
and driller keeps those strictly apart (separate families, separate
provenance). It must land as a judgment with its model and timestamp, never
beside the structural rows as though it were measured. Worth noting the failure
mode this project has already corrected twice: a confident sentence about
behaviour that the tool cannot actually support is the "74% gap" mistake in
prose form.

## 5. Index test files only to link them to what they test, and for coverage

**Asked:** test files should be indexed only so they can be linked to the
method they test, and for coverage.

**What driller already has — most of this.** `production-code-map.ts` is the
single fetch every consumer uses, and it calls `excludeTestCode`, so neither
the map handler nor Path Trace can see a test Node, a test edge, or a test
file's hotspot. `attachTestedBy` (`tested-by.ts`) links tests to what they
test from the backend's `TESTS_FILE` edges, and `lcov.ts` supplies coverage
gaps. P5-e additionally excluded harness and fixture files as Revealed roots.

**Open:** only the layer below. The *backend* still indexes test files as
first-class Nodes — of driller/app's 2,870 `Function` Nodes a large share are
test functions, which is why 17 of the 25 `self_recursive` hits were in test
files. driller filters them out after the fact. Pushing the exclusion down to
index time would cut index size and cost, which is the fork's actual interest
here; the product behaviour is already as asked.

## 6. Keep vendor / `node_modules` code out of the map

**Asked** (reading the intent; the sentence as written says "we do want … cos
it creates noise", which the parenthetical contradicts): vendor and
`node_modules` code should **not** be loaded into the map, because it is noise.
Instead, show that a method calls an externally imported call. **Flagged for
confirmation** — the rest of this entry assumes the negative reading.

**What driller has:** `node_modules` is already absent in practice — driller/app
indexes 305 `File` Nodes and 2,870 `Function` Nodes, which is source-only; a
tree with `node_modules` would be orders of magnitude larger. The map also
skips an edge whose endpoint is not in the fetch's own node set, which is how a
filtered external/library target is dropped today.

**Open:** two real pieces. Vendored code that lives *inside* the repository
(not under `node_modules`) is ordinary source and is indexed as such — there is
no vendor-path concept. And the second half of the ask is not built at all:
when a method calls out to an external import, the call is currently dropped
silently rather than shown as "calls something outside the map". Showing it is
the more valuable half, since a silently missing edge is the kind of absence
driller has elsewhere been careful never to imply.

---

## Not yet decided

- Which of these are enterprise-only and which belong in open-source driller.
  Items 3, 5 and 6 are map-quality work that arguably improves driller itself;
  1, 2 and 4 are closer to a paid review workflow. The founder's list places
  all six in the fork.
- Whether the fork keeps AD-17 and the never-write-to-the-repo invariant. Items
  1 and 2 both press on it.
