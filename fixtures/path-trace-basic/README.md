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

### `"handleRequest"`

```
{ status: 'found', path: [handleRequest, serviceA, serviceB, repository, cacheLookup] }
```

BFS order: `handleRequest` is the entry; its two outgoing `CALLS` edges (to
`serviceA`, then `serviceB` — in ascending target-`id` order, which for this
fixture's qualified names coincides with source order) are visited next;
`serviceA`'s edge to `repository` is visited next (first arrival wins);
`serviceB`'s own edge to `repository` is a no-op (already visited);
`repository`'s edge to `cacheLookup` is visited last; `cacheLookup`'s edge
back to `repository` is a no-op (already visited, cycle terminates). Five
Nodes total, each exactly once.

### `"cacheLookup"` (the cyclic entry)

```
{ status: 'found', path: [cacheLookup, repository] }
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
