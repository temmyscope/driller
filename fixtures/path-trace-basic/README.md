# path-trace-basic fixture

Story 1.9 (Phase 1)'s first checked-in fixture — prior stories used
throwaway repos for manual verification; this one is small and permanent
enough to check in and re-run against on every future Path Trace change.

It lives inside this already-git-tracked `driller/app` repo rather than
carrying its own nested `.git`: opening this folder in driller finds the
ancestor `.git` at the `driller/app` root (git-relation `parent`), which is
enough to satisfy the app's "is this a git repo" open-folder check — the
actual index/trace scope is still just this folder, not the whole outer repo.

## Call graph

```
handleRequest (entry.ts)
  -> serviceA (serviceA.ts)
       -> repository (repository.ts)
            -> cacheLookup (cache.ts)
                 -> repository (repository.ts)   <- cycle back to `repository`
  -> serviceB (serviceB.ts)
       -> repository (repository.ts)             <- already visited via serviceA
```

- `serviceA` and `serviceB` both call `repository` (fan-in) — a correct
  Path Trace visits `repository` exactly once, not twice.
- `repository` and `cacheLookup` call each other (a true cycle) — a correct
  Path Trace visits each of them exactly once and terminates rather than
  looping.

Story 1.9 (Phase 3) adds two more files, `utilA.ts` and `utilB.ts`, each
exporting a standalone `helper()` — uncalled by anything above and calling
nothing themselves, so they can't affect any of the call-graph scenarios
above. They exist purely to give a `"helper"` query two same-named matches
at the exact-name tier, exercising the new `ambiguous` result.

## Hand-verified expected `traceCallPath`/`window.driller.tracePath(...)` output

Node ids are whatever the indexing backend's qualified-name scheme actually
produces for these files (path + symbol, per AD-19) — what's hand-verified
here is each result's `status` and the *order and membership* of `path`,
identified by function name. Sibling order (which of a Node's several
outgoing `CALLS` edges gets visited first) is guaranteed by `traceCallPath`
itself — it sorts each Node's outgoing targets by target `id` before
enqueueing them, rather than relying on whatever order `fetchCodeMap`/the
real backend happens to report edges in (never guaranteed). Because this
fixture's own filenames (`serviceA.ts`, `serviceB.ts`, ...) already sort
alphabetically the same way their qualified-name ids will, that deterministic
sort coincides with the files' natural reading order below — the order shown
is guaranteed by code, not an assumption about backend edge ordering that
happens to hold today.

`path` is the reachable set in BFS visit order, not a chain: consecutive
entries are often siblings (`serviceA`, `serviceB` both called by
`handleRequest`). FIX-2 added `parents` (the caller each Node was FIRST
reached from; the entry maps to `null`) and `depths` (hops from the entry in
that tree). The step list renders that tree depth-first, children sorted by
id, and the map highlights every real `CALLS` edge among the reached Nodes —
including non-tree ones such as `serviceB -> repository` and the
`cacheLookup -> repository` back-edge — never consecutive `path` pairs.

### `"handleRequest"`

```
{
  status: 'found',
  path: [handleRequest, serviceA, serviceB, repository, cacheLookup],
  parents: {
    handleRequest: null,
    serviceA: handleRequest,
    serviceB: handleRequest,
    repository: serviceA,
    cacheLookup: repository,
  },
  depths: { handleRequest: 0, serviceA: 1, serviceB: 1, repository: 2, cacheLookup: 3 },
}
```

BFS order: `handleRequest` is the entry; its two outgoing `CALLS` edges (to
`serviceA`, then `serviceB` — in ascending target-`id` order, which for this
fixture's qualified names coincides with source order) are visited next;
`serviceA`'s edge to `repository` is visited next (first arrival wins);
`serviceB`'s own edge to `repository` is a no-op (already visited);
`repository`'s edge to `cacheLookup` is visited last; `cacheLookup`'s edge
back to `repository` is a no-op (already visited, cycle terminates). Five
Nodes total, each exactly once.

Call tree (step list rows, depth-first):

```
handleRequest
  serviceA
    repository
      cacheLookup
  serviceB            (called by handleRequest)
```

### `"cacheLookup"` (the cyclic entry)

```
{
  status: 'found',
  path: [cacheLookup, repository],
  parents: { cacheLookup: null, repository: cacheLookup },
  depths: { cacheLookup: 0, repository: 1 },
}
```

BFS order: `cacheLookup` is the entry; its one outgoing `CALLS` edge (to
`repository`) is visited next; `repository`'s edge back to `cacheLookup` is a
no-op (already visited — the entry itself — so the trace terminates instead
of looping). Two Nodes total, each exactly once; does not hang.

### `"doesNotExist"`

```
{ status: 'no-path-found' }
```

No Node's `id` or `name` matches this query at all (exact or substring) —
`no-path-found`, never an ambiguous empty `path` array.

### `"helper"` (Story 1.9, Phase 3 — the ambiguous case)

```
{
  status: 'ambiguous',
  candidates: [
    { id: <utilA.ts's `helper` qualified-name id>, name: 'helper' },
    { id: <utilB.ts's `helper` qualified-name id>, name: 'helper' },
  ],
}
```

Hand-verified by indexing this fixture folder with the real backend
(`codebase-memory-mcp`) and querying it directly: `"helper"` matches exactly
two Nodes, both at the exact-name tier (neither Node's `id` — its qualified
name, path + symbol per AD-19 — equals the literal string `"helper"`, so the
exact-id tier contributes nothing and the exact-name tier is what resolves
this query). Two matches at that tier means the *whole* query resolves
`ambiguous` there — it never falls through to the substring tier, and never
auto-picks one.

`candidates` is sorted ascending by `id`. Each Node's `id` embeds its file's
path (AD-19), and `utilA.ts` sorts before `utilB.ts` — confirmed against the
real backend's actual qualified names — so `utilA.ts`'s `helper` is always
`candidates[0]` and `utilB.ts`'s `helper` is always `candidates[1]`,
regardless of which project-root prefix a given machine's backend derives
(that prefix is environment-specific — derived from the repo's absolute
path — so it's deliberately not reproduced verbatim here; what's
hand-verified and stable across environments is each result's `status`, the
match count, the tier that resolved it, and the `utilA`-before-`utilB`
sort order).

Clicking either candidate re-runs the trace with that exact `id` as the new
query, which resolves via the untouched exact-id tier: `{ status: 'found',
path: [that Node's id] }` — a single-element path, since neither `helper`
calls anything.
