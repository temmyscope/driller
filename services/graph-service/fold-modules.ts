/**
 * P4-2 phase 3a: Module Nodes fold into their file.
 *
 * A Module Node is a file's top-level code: its complexity is always 0 and it
 * is a pure edge source (on driller/app, ~11% of production map Nodes). Node
 * detail already names the file, so a separate Module card is noise. The
 * Module leaves the map population here, and what it calls or uses is kept
 * in a side index keyed by file (`FoldedModule`).
 *
 * `foldModules` runs in `fetchProductionCodeMap`, after test exclusion and
 * before the scope filter, adjacency, blast radius, severity cuts, Health
 * Audit, diff scope and the canvas — so a Module's edge never counts toward
 * any Node's blast radius or trace, and a changed Module is never a changed
 * Node. Its links survive as `CodeMapNode.fileTopLevel` (what a file's top
 * level uses) and `CodeMapNode.calledAtLoadBy` (the reverse: which files'
 * top level use this Node), so a function called only at load time still
 * names its caller.
 */
import type { CodeMapEdge, CodeMapEdgeKind, FileTopLevelUse, FoldedModule, TypeUse } from '@driller/graph-contracts';

import { isFileInScope } from './project-scope';

/** `CALLS` sorts first, so a target reached both ways is listed as a call. */
const KIND_ORDER: Readonly<Record<CodeMapEdgeKind, number>> = { CALLS: 0, USAGE: 1, IMPORTS: 2 };

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The result of `foldModules`. */
export interface FoldModulesResult<TNode> {
  /** Every non-Module Node, in input order. */
  nodes: TNode[];
  /** Every edge with neither end on a Module, in input order. */
  edges: CodeMapEdge[];
  /** Folded Modules keyed by file. Files with a Module but no outgoing map edge are still here, with `uses: []`. */
  modulesByFile: Map<string, FoldedModule>;
}

/**
 * Removes Module Nodes and every edge touching one. Each Module's outgoing
 * edges to a remaining map Node become its file's `uses` (distinct ids,
 * `CALLS` before `USAGE` before `IMPORTS`, then by id; ids and kinds only).
 * An edge to a Node that isn't in `nodes` (removed earlier, e.g. test code)
 * or to another Module records nothing. `nodes`' `file` must already be
 * project-relative.
 *
 * Uses are attributed per (Module id, file). Backend edges carry only ids,
 * so when one Module id appears in several files, each of those files'
 * Modules is the source of that id's edges and each file lists them.
 *
 * Pure. Returns the input arrays themselves when there is no Module.
 */
export function foldModules<TNode extends { id: string; file: string; kind: string; startLine: number; endLine: number }>(
  nodes: TNode[],
  edges: CodeMapEdge[],
): FoldModulesResult<TNode> {
  const modules = nodes.filter((node) => node.kind === 'Module');
  if (modules.length === 0) {
    return { nodes, edges, modulesByFile: new Map() };
  }
  const mapNodes = nodes.filter((node) => node.kind !== 'Module');
  const mapIds = new Set(mapNodes.map((node) => node.id));
  // An id carried by both a Module and a map Node stays a map Node: its edges
  // can't be told apart, so they stay on the map.
  const foldable = modules.filter((node) => !mapIds.has(node.id));
  const moduleOnlyIds = new Set(foldable.map((node) => node.id));

  const filesByModuleId = new Map<string, Set<string>>();
  const byFile = new Map<string, { ids: Set<string>; startLine: number; endLine: number }>();
  for (const module of foldable) {
    const files = filesByModuleId.get(module.id) ?? new Set<string>();
    files.add(module.file);
    filesByModuleId.set(module.id, files);
    const entry = byFile.get(module.file);
    if (entry === undefined) {
      byFile.set(module.file, { ids: new Set([module.id]), startLine: module.startLine, endLine: module.endLine });
    } else {
      entry.ids.add(module.id);
      entry.startLine = Math.min(entry.startLine, module.startLine);
      entry.endLine = Math.max(entry.endLine, module.endLine);
    }
  }

  const usesByFile = new Map<string, Map<string, CodeMapEdgeKind>>();
  const keptEdges: CodeMapEdge[] = [];
  for (const edge of edges) {
    const fromModule = moduleOnlyIds.has(edge.source);
    const toModule = moduleOnlyIds.has(edge.target);
    if (!fromModule && !toModule) {
      keptEdges.push(edge);
      continue;
    }
    if (!fromModule || toModule || !mapIds.has(edge.target)) {
      continue;
    }
    for (const file of filesByModuleId.get(edge.source) ?? []) {
      const uses = usesByFile.get(file) ?? new Map<string, CodeMapEdgeKind>();
      const known = uses.get(edge.target);
      if (known === undefined || KIND_ORDER[edge.kind] < KIND_ORDER[known]) {
        uses.set(edge.target, edge.kind);
      }
      usesByFile.set(file, uses);
    }
  }

  const modulesByFile = new Map<string, FoldedModule>();
  for (const [file, { ids, startLine, endLine }] of byFile) {
    const uses: FileTopLevelUse[] = [...(usesByFile.get(file) ?? [])]
      .map(([id, kind]) => ({ id, kind }))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || compareIds(a.id, b.id));
    modulesByFile.set(file, { file, moduleIds: [...ids].sort(compareIds), startLine, endLine, uses });
  }
  return { nodes: mapNodes, edges: keptEdges, modulesByFile };
}

/**
 * Applies the indexing scope to folded Modules, the way `filterCodeMapToScope`
 * applies it to Nodes: a Module whose file is outside `includedPaths` is
 * dropped (`isFileInScope`), and each remaining Module's `uses` keeps only
 * ids in `mapNodeIds` — the Nodes that survived the scope filter — so nothing
 * names an id `lookup_node` would report as not-found. `file` must already be
 * project-relative. Pure.
 */
export function scopeFoldedModules(
  foldedModules: readonly FoldedModule[],
  mapNodeIds: ReadonlySet<string>,
  // P4-4 phase 1a: or a file predicate (`buildScopedCodeMap`'s `keepFile`).
  includedPaths: readonly string[] | ((file: string) => boolean),
): FoldedModule[] {
  const keepFile =
    typeof includedPaths === 'function' ? includedPaths : (file: string) => isFileInScope(file, includedPaths);
  return foldedModules
    .filter((module) => keepFile(module.file))
    .map((module) =>
      module.uses.every((use) => mapNodeIds.has(use.id))
        ? module
        : { ...module, uses: module.uses.filter((use) => mapNodeIds.has(use.id)) },
    );
}

/**
 * Sets each Node's folded-Module links from `foldedModules`:
 *  - `fileTopLevel`: its file's top-level uses — the same array for every
 *    Node in that file;
 *  - `calledAtLoadBy`: the files whose top-level uses include it, sorted;
 *  - `fileTopLevelTypes` (P4-2 phase 3b): its file's top-level uses of
 *    folded types (`FoldedModule.usesTypes`) — the same array for every
 *    Node in that file.
 * A link with nothing in it is removed rather than left empty or stale, so
 * this can re-run after `scopeFoldedModules`. Pure; returns new Node objects
 * only for Nodes whose links are set or removed.
 */
export function attachFoldedModuleLinks<
  TNode extends {
    id: string;
    file: string;
    fileTopLevel?: FileTopLevelUse[];
    calledAtLoadBy?: string[];
    fileTopLevelTypes?: TypeUse[];
  },
>(nodes: TNode[], foldedModules: readonly FoldedModule[]): TNode[] {
  const usesByFile = new Map<string, FileTopLevelUse[]>();
  const typesByFile = new Map<string, TypeUse[]>();
  const loadCallers = new Map<string, Set<string>>();
  for (const module of foldedModules) {
    if (module.uses.length > 0) {
      usesByFile.set(module.file, module.uses);
    }
    if ((module.usesTypes?.length ?? 0) > 0) {
      typesByFile.set(module.file, module.usesTypes!);
    }
    for (const use of module.uses) {
      const files = loadCallers.get(use.id) ?? new Set<string>();
      files.add(module.file);
      loadCallers.set(use.id, files);
    }
  }
  return nodes.map((node) => {
    const fileTopLevel = usesByFile.get(node.file);
    const callers = loadCallers.get(node.id);
    const fileTopLevelTypes = typesByFile.get(node.file);
    if (
      fileTopLevel === undefined &&
      callers === undefined &&
      fileTopLevelTypes === undefined &&
      node.fileTopLevel === undefined &&
      node.calledAtLoadBy === undefined &&
      node.fileTopLevelTypes === undefined
    ) {
      return node;
    }
    const { fileTopLevel: _oldUses, calledAtLoadBy: _oldCallers, fileTopLevelTypes: _oldTypes, ...rest } = node;
    return {
      ...rest,
      ...(fileTopLevel !== undefined ? { fileTopLevel } : {}),
      ...(callers !== undefined ? { calledAtLoadBy: [...callers].sort(compareIds) } : {}),
      ...(fileTopLevelTypes !== undefined ? { fileTopLevelTypes } : {}),
    } as TNode;
  });
}
