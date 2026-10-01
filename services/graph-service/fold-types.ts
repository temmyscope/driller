/**
 * P4-2 phase 3b: Type and Interface Nodes fold off the canvas.
 *
 * On driller/app they are ~21% of map Nodes and ~34% of map edges, all of
 * them sink spokes (`USAGE` edges into them), with complexity always 0. But
 * they carry real "who depends on this contract" information, so they leave
 * the map population here and are kept in a side index keyed by id
 * (`FoldedType`): each keeps the map Nodes with a real `USAGE` edge into it
 * (`usedBy`), the types it refers to or is referred to by (`refersTo` /
 * `referencedByTypes`), and what it extends or implements, both ways
 * (`implements` / `implementedBy`). Each map Node keeps the types it uses
 * (`usesTypes`); each folded Module keeps the types its top-level code uses
 * (`FoldedModule.usesTypes`).
 *
 * `foldTypes` runs in `fetchProductionCodeMap` after `foldModules` (phase
 * 3a) and before the scope filter, adjacency, blast radius, severity cuts,
 * Health Audit, diff scope and the canvas — so a type edge never counts
 * toward any Node's blast radius, and a type is never a changed Node. Path
 * Trace is CALLS-only, so it loses nothing.
 *
 * Never fabricate: every link here is a backend `USAGE` (or, for
 * `implements`, `IMPLEMENTS`) edge. Nothing is inferred from a name match or
 * from a function's `param_types`/`return_type`. `IMPLEMENTS` is fetched
 * between Interface/Type Nodes only: a Class implementing an Interface is
 * not, because Classes are not Code Map Nodes.
 */
import type {
  CodeMapEdge,
  CodeMapNodeKind,
  FoldedModule,
  FoldedType,
  FoldedTypeKind,
  FoldedTypeUserKindCount,
  TypeUse,
} from '@driller/graph-contracts';

import { isFileInScope } from './project-scope';

/** One backend `IMPLEMENTS` edge (`source` extends/implements `target`), ids only. */
export interface ImplementsLink {
  source: string;
  target: string;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isFoldedTypeKind = (kind: string): kind is FoldedTypeKind => kind === 'Type' || kind === 'Interface';

/** The result of `foldTypes`. */
export interface FoldTypesResult<TNode> {
  /** Every Node that isn't a folded Type/Interface, in input order. */
  nodes: TNode[];
  /** Every edge with neither end on a folded type, in input order. */
  edges: CodeMapEdge[];
  /** Folded types keyed by id — including types nothing uses (`usedBy: []`). */
  typesById: Map<string, FoldedType>;
  /** Map Node id → the folded type ids it uses (sorted by id). Only Nodes that use one. */
  usesByNode: Map<string, string[]>;
  /** Folded type id → the map Node ids that use it (sorted by id). Only types that are used. */
  usedByType: Map<string, string[]>;
}

function addLink(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
}

const sortedIds = (ids: Iterable<string> | undefined): string[] => [...(ids ?? [])].sort(compareIds);

/** Counts `users` by their kind in `kinds` (users with no known kind are left out), most first, then by kind. */
function countUserKinds(users: readonly string[], kinds: ReadonlyMap<string, string>): FoldedTypeUserKindCount[] {
  const counts = new Map<string, number>();
  for (const user of users) {
    const kind = kinds.get(user);
    if (kind !== undefined) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([kind, count]) => ({ kind: kind as CodeMapNodeKind, count }))
    .sort((a, b) => b.count - a.count || compareIds(a.kind, b.kind));
}

/**
 * Removes Type and Interface Nodes and every edge touching one. Of those
 * edges, only `USAGE` edges are kept as links:
 *  - from a remaining map Node into a folded type — a use (`usesByNode`,
 *    and the reverse `usedByType` / `FoldedType.usedBy`);
 *  - from one folded type into another — `refersTo` / `referencedByTypes`.
 * Any other edge touching a type (a `CALLS` into one, a `USAGE` from a type
 * into a map Node, one from a Node not in `nodes` — removed earlier, e.g.
 * test code or a Module) records nothing. `implementsLinks` becomes each
 * type's `implements` and `implementedBy`, kept only when both ends are
 * folded types. `nodes`' `file` must already be project-relative.
 *
 * An id carried by both a type and a non-type Node stays a map Node, like
 * `foldModules`: its edges can't be told apart.
 *
 * Pure. Returns the input arrays themselves when there is no type.
 */
export function foldTypes<
  TNode extends { id: string; name: string; file: string; kind: string; startLine: number; endLine: number },
>(nodes: TNode[], edges: CodeMapEdge[], implementsLinks: readonly ImplementsLink[] = []): FoldTypesResult<TNode> {
  const types = nodes.filter((node) => isFoldedTypeKind(node.kind));
  if (types.length === 0) {
    return { nodes, edges, typesById: new Map(), usesByNode: new Map(), usedByType: new Map() };
  }
  const mapNodes = nodes.filter((node) => !isFoldedTypeKind(node.kind));
  const mapKinds = new Map(mapNodes.map((node) => [node.id, node.kind]));
  const foldable = types.filter((node) => !mapKinds.has(node.id));
  const typeIds = new Set(foldable.map((node) => node.id));

  const uses = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  const refersTo = new Map<string, Set<string>>();
  const referencedBy = new Map<string, Set<string>>();
  const keptEdges: CodeMapEdge[] = [];
  for (const edge of edges) {
    const fromType = typeIds.has(edge.source);
    const toType = typeIds.has(edge.target);
    if (!fromType && !toType) {
      keptEdges.push(edge);
      continue;
    }
    if (edge.kind !== 'USAGE' || !toType || edge.source === edge.target) {
      continue;
    }
    if (fromType) {
      addLink(refersTo, edge.source, edge.target);
      addLink(referencedBy, edge.target, edge.source);
    } else if (mapKinds.has(edge.source)) {
      addLink(uses, edge.source, edge.target);
      addLink(usedBy, edge.target, edge.source);
    }
  }

  const implementsBy = new Map<string, Set<string>>();
  const implementedBy = new Map<string, Set<string>>();
  for (const link of implementsLinks) {
    if (link.source === link.target || !typeIds.has(link.source) || !typeIds.has(link.target)) {
      continue;
    }
    addLink(implementsBy, link.source, link.target);
    addLink(implementedBy, link.target, link.source);
  }

  const typesById = new Map<string, FoldedType>();
  for (const type of foldable) {
    // A duplicate id (defensive: ids are unique by construction) keeps the first.
    if (typesById.has(type.id)) {
      continue;
    }
    const users = sortedIds(usedBy.get(type.id));
    typesById.set(type.id, {
      id: type.id,
      name: type.name,
      kind: type.kind as FoldedTypeKind,
      file: type.file,
      startLine: type.startLine,
      endLine: type.endLine,
      usedBy: users,
      usedByTotal: users.length,
      usedByKinds: countUserKinds(users, mapKinds),
      implements: sortedIds(implementsBy.get(type.id)),
      implementedBy: sortedIds(implementedBy.get(type.id)),
      refersTo: sortedIds(refersTo.get(type.id)),
      referencedByTypes: sortedIds(referencedBy.get(type.id)),
    });
  }
  return {
    nodes: mapNodes,
    edges: keptEdges,
    typesById,
    usesByNode: new Map([...uses].map(([id, ids]) => [id, sortedIds(ids)])),
    usedByType: new Map([...usedBy].map(([id, ids]) => [id, sortedIds(ids)])),
  };
}

/**
 * Applies the indexing scope to folded types, the way `scopeFoldedModules`
 * does to folded Modules: a type whose file is outside `includedPaths` is
 * dropped (`isFileInScope`); each remaining type's `usedBy` keeps only Nodes
 * in `mapNodeKinds` (the Nodes that survived the scope filter, with their
 * kinds — `usedByTotal`/`usedByKinds` are recounted), and its type links
 * (`implements`, `implementedBy`, `refersTo`, `referencedByTypes`) only
 * types that survived too — so nothing names an id `lookup_node` would
 * report as not-found. Pure; an unchanged type is returned as-is.
 */
export function scopeFoldedTypes(
  foldedTypes: readonly FoldedType[],
  mapNodeKinds: ReadonlyMap<string, string>,
  // P4-4 phase 1a: or a file predicate (`buildScopedCodeMap`'s `keepFile`).
  includedPaths: readonly string[] | ((file: string) => boolean),
): FoldedType[] {
  const keepFile =
    typeof includedPaths === 'function' ? includedPaths : (file: string) => isFileInScope(file, includedPaths);
  const inScope = foldedTypes.filter((type) => keepFile(type.file));
  const typeIds = new Set(inScope.map((type) => type.id));
  const keepTypes = (ids: string[]) => ids.filter((id) => typeIds.has(id));
  return inScope.map((type) => {
    const typeLinks = [type.implements, type.implementedBy, type.refersTo, type.referencedByTypes];
    if (type.usedBy.every((id) => mapNodeKinds.has(id)) && typeLinks.every((ids) => ids.every((id) => typeIds.has(id)))) {
      return type;
    }
    const usedBy = type.usedBy.filter((id) => mapNodeKinds.has(id));
    return {
      ...type,
      usedBy,
      usedByTotal: usedBy.length,
      usedByKinds: countUserKinds(usedBy, mapNodeKinds),
      implements: keepTypes(type.implements),
      implementedBy: keepTypes(type.implementedBy),
      refersTo: keepTypes(type.refersTo),
      referencedByTypes: keepTypes(type.referencedByTypes),
    };
  });
}

/**
 * Caps each folded type's `usedBy` at `max` ids for the Code Map reply
 * (`FOLDED_TYPE_IPC_MAX_USED_BY`); `usedByTotal` and `usedByKinds` keep the
 * full counts. Pure; a type within the cap is returned as-is.
 */
export function capFoldedTypeUsedBy(foldedTypes: readonly FoldedType[], max: number): FoldedType[] {
  return foldedTypes.map((type) => (type.usedBy.length > max ? { ...type, usedBy: type.usedBy.slice(0, max) } : type));
}

/** Sorts by name, then id — the order a Node's "Uses" are listed in. */
function compareTypeUses(a: TypeUse, b: TypeUse): number {
  return compareIds(a.name, b.name) || compareIds(a.id, b.id);
}

const toTypeUse = (type: FoldedType): TypeUse => ({ id: type.id, name: type.name, kind: type.kind });

/**
 * Sets each Node's `usesTypes` from `foldedTypes`' `usedBy` (the reverse
 * index), sorted by name then id. A Node that uses nothing has the field
 * removed rather than left empty or stale, so this can re-run after
 * `scopeFoldedTypes`. `foldedTypes` must carry uncapped `usedBy`. Pure;
 * returns new Node objects only for Nodes whose link is set or removed.
 */
export function attachTypeUses<TNode extends { id: string; usesTypes?: TypeUse[] }>(
  nodes: TNode[],
  foldedTypes: readonly FoldedType[],
): TNode[] {
  const usesByNode = new Map<string, TypeUse[]>();
  for (const type of foldedTypes) {
    for (const user of type.usedBy) {
      const list = usesByNode.get(user) ?? [];
      list.push(toTypeUse(type));
      usesByNode.set(user, list);
    }
  }
  return nodes.map((node) => {
    const usesTypes = usesByNode.get(node.id);
    if (usesTypes === undefined && node.usesTypes === undefined) {
      return node;
    }
    const { usesTypes: _old, ...rest } = node;
    return { ...rest, ...(usesTypes !== undefined ? { usesTypes: usesTypes.sort(compareTypeUses) } : {}) } as TNode;
  });
}

/**
 * Moves each folded Module's top-level uses of a folded type out of `uses`
 * (which then names only map Nodes) into `usesTypes`, sorted by name then
 * id — so a file's top-level use of a type is kept, not dropped with the
 * type. An existing `usesTypes` is recomputed from the given `foldedTypes`
 * plus whatever `uses` still names a type, keeping only types in
 * `foldedTypes` — so this can re-run after scoping. Pure; a Module with
 * nothing to change is returned as-is.
 */
export function splitModuleTypeUses(
  foldedModules: readonly FoldedModule[],
  foldedTypes: readonly FoldedType[],
): FoldedModule[] {
  const typesById = new Map(foldedTypes.map((type) => [type.id, type]));
  return foldedModules.map((module) => {
    const typeIds = [
      ...module.uses.filter((use) => typesById.has(use.id)).map((use) => use.id),
      ...(module.usesTypes ?? []).map((use) => use.id),
    ];
    const usesTypes = [...new Set(typeIds)]
      .flatMap((id) => {
        const type = typesById.get(id);
        return type === undefined ? [] : [toTypeUse(type)];
      })
      .sort(compareTypeUses);
    const uses = module.uses.filter((use) => !typesById.has(use.id));
    const unchanged =
      uses.length === module.uses.length &&
      usesTypes.length === (module.usesTypes?.length ?? 0) &&
      usesTypes.every((use, index) => module.usesTypes?.[index]?.id === use.id);
    if (unchanged) {
      return module;
    }
    const { usesTypes: _old, ...rest } = module;
    return { ...rest, uses, ...(usesTypes.length > 0 ? { usesTypes } : {}) };
  });
}
