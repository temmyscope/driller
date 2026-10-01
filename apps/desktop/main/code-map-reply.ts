/**
 * P2-5: turns the Graph Service's `graphService:codeMap` reply into the
 * renderer-facing ok `CodeMapResult`, validating the two scope fields at the
 * main boundary. The worker message crosses a process boundary untyped at
 * runtime, so a non-finite `hiddenByScope` becomes 0 and a non-string-array
 * `appliedScope` becomes `[]` — "no scope", the empty map's honest default.
 * `replaced` names the fields that were substituted, so the caller logs once
 * per reply rather than once per field.
 *
 * P4-2 phase 3b: `foldedTypes` is validated per element (`isFoldedType`): a
 * non-array becomes `[]` (and is named in `replaced`), and each malformed
 * element is dropped and counted in `droppedFoldedTypes`, so one bad row
 * never reaches the renderer and never blanks the rest.
 *
 * P4-2 phase 3c: `foldedModules` the same way (`isFoldedModule`,
 * `droppedFoldedModules`); every source range (types, Modules) must be
 * whole lines, start ≤ end. And a diff-scope reply
 * (`toValidatedDiffScopeResult`): `nodeIds`, `topLevelFiles` and
 * `changedContracts` are checked; malformed elements are dropped.
 *
 * P4-2 phase 4: each Node's `similarTo` is validated per element
 * (`isSimilarImplementation`, `sanitizeNodeSimilarTo`); malformed elements
 * are dropped and counted in `droppedSimilarTo`, and `similarToTotal` is
 * kept consistent with what survives.
 *
 * P4-3 phase 5: each Node's `testCoverageAvailable` (and, review round 1,
 * `testCoverageHit`) is kept only when it is exactly `true`
 * (`sanitizeNodeTestCoverageAvailable`; a hit also needs the flag); any
 * other present value is stripped and counted in
 * `droppedTestCoverageAvailable`, so a malformed flag can never make the
 * table say "covered".
 */
import type {
  ChangedContract,
  CodeMapNode,
  CodeMapResult,
  DiffScopeResult,
  FoldedModule,
  FoldedType,
  GraphServiceCodeMapMessage,
  SimilarImplementation,
  TopLevelChangedFile,
} from '@driller/ipc-contracts';

type CodeMapReply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;
type OkCodeMapResult = Extract<CodeMapResult, { status: 'ok' }>;

export type ReplacedCodeMapField = 'hiddenByScope' | 'appliedScope' | 'foldedTypes' | 'foldedModules';

const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
/** P4-2 phase 3c: a source range's lines — positive integers, start ≤ end. */
const isLineRange = (start: unknown, end: unknown): boolean =>
  Number.isInteger(start) && Number.isInteger(end) && (start as number) >= 1 && (start as number) <= (end as number);

/**
 * P4-2 phase 3b: whether `value` has every field the renderer reads off a
 * `FoldedType`: string `id`/`name`/`file`, a `kind` of `'Type'` or
 * `'Interface'`, finite `startLine`/`endLine`/`usedByTotal`, string-array
 * `usedBy`/`implements`/`implementedBy`/`refersTo`/`referencedByTypes`, and
 * a `usedByKinds` array of `{kind: string, count: number}`.
 */
export function isFoldedType(value: unknown): value is FoldedType {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = value as Record<string, unknown>;
  return (
    isString(type.id) &&
    isString(type.name) &&
    isString(type.file) &&
    (type.kind === 'Type' || type.kind === 'Interface') &&
    isLineRange(type.startLine, type.endLine) &&
    isFiniteNumber(type.usedByTotal) &&
    isStringArray(type.usedBy) &&
    isStringArray(type.implements) &&
    isStringArray(type.implementedBy) &&
    isStringArray(type.refersTo) &&
    isStringArray(type.referencedByTypes) &&
    Array.isArray(type.usedByKinds) &&
    type.usedByKinds.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        isString((entry as { kind?: unknown }).kind) &&
        isFiniteNumber((entry as { count?: unknown }).count),
    )
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * P4-2 phase 3c: whether `value` has every field the renderer reads off a
 * `FoldedModule`: string `file`, a non-empty string-array `moduleIds`,
 * finite `startLine`/`endLine`, a `uses` array of `{id: string, kind:
 * 'CALLS' | 'USAGE' | 'IMPORTS'}`, and (optional) a `usesTypes` array of
 * `{id, name: string, kind: 'Type' | 'Interface'}`.
 */
export function isFoldedModule(value: unknown): value is FoldedModule {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isString(value.file) &&
    isStringArray(value.moduleIds) &&
    value.moduleIds.length > 0 &&
    value.moduleIds.every((id) => id.length > 0) &&
    isLineRange(value.startLine, value.endLine) &&
    Array.isArray(value.uses) &&
    value.uses.every(
      (use: unknown) =>
        isRecord(use) && isString(use.id) && (use.kind === 'CALLS' || use.kind === 'USAGE' || use.kind === 'IMPORTS'),
    ) &&
    (value.usesTypes === undefined ||
      (Array.isArray(value.usesTypes) &&
        value.usesTypes.every(
          (use: unknown) =>
            isRecord(use) &&
            isString(use.id) &&
            isString(use.name) &&
            (use.kind === 'Type' || use.kind === 'Interface'),
        )))
  );
}

/**
 * P4-2 phase 3c: whether `value` is a well-formed `ChangedContract`: string
 * `id`/`name`/`file`, a `kind` of `'Type'` or `'Interface'`, a unique
 * string-array `dependentIds` (possibly capped), and a non-negative integer
 * `dependentCount` of at least `dependentIds.length`.
 */
export function isChangedContract(value: unknown): value is ChangedContract {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.file) &&
    (value.kind === 'Type' || value.kind === 'Interface') &&
    isStringArray(value.dependentIds) &&
    new Set(value.dependentIds).size === value.dependentIds.length &&
    Number.isInteger(value.dependentCount) &&
    (value.dependentCount as number) >= value.dependentIds.length
  );
}

/**
 * P4-2 phase 4: whether `value` is a well-formed `SimilarImplementation`:
 * non-empty string `id`/`name`/`file` and a finite `score` in [0, 1] (a
 * jaccard). The Graph Service only sends scores at or above
 * `SIMILAR_TO_MIN_JACCARD`; this boundary only guards the shape the renderer
 * reads, so a lower score is not second-guessed here.
 */
export function isSimilarImplementation(value: unknown): value is SimilarImplementation {
  return (
    isRecord(value) &&
    isString(value.id) &&
    value.id.length > 0 &&
    isString(value.name) &&
    value.name.length > 0 &&
    isString(value.file) &&
    value.file.length > 0 &&
    isFiniteNumber(value.score) &&
    value.score >= 0 &&
    value.score <= 1
  );
}

/**
 * P4-2 phase 4: a Node with its `similarTo` validated per element. Returns
 * the same Node when both fields are well-formed (or both absent).
 * Otherwise: a non-array `similarTo` counts as 1 dropped and is removed;
 * malformed elements are dropped; when none survive, `similarTo` and
 * `similarToTotal` are both removed. A surviving list keeps a
 * `similarToTotal` that is an integer at least its length, else gets its
 * length. A lone `similarToTotal` is removed. `dropped` counts removed
 * elements.
 */
export function sanitizeNodeSimilarTo(node: CodeMapNode): { node: CodeMapNode; dropped: number } {
  const raw: unknown = node.similarTo;
  const rawTotal: unknown = node.similarToTotal;
  if (raw === undefined && rawTotal === undefined) {
    return { node, dropped: 0 };
  }
  const { similarTo: _similar, similarToTotal: _total, ...rest } = node;
  const valid = keepValid(raw, isSimilarImplementation);
  // A repeated id would double a row (and a React key); keep its first entry.
  const seen = new Set<string>();
  const kept = valid.kept.filter((entry) => !seen.has(entry.id) && seen.add(entry.id) !== undefined);
  const dropped = valid.dropped + (valid.kept.length - kept.length);
  if (kept.length === 0) {
    return { node: rest, dropped };
  }
  const totalOk = Number.isInteger(rawTotal) && (rawTotal as number) >= kept.length;
  if (dropped === 0 && totalOk) {
    return { node, dropped: 0 };
  }
  return { node: { ...rest, similarTo: kept, similarToTotal: totalOk ? (rawTotal as number) : kept.length }, dropped };
}

/**
 * P4-3 phase 5: a Node with its `testCoverageAvailable` validated. The flag
 * is `true` or absent (never `false`), so any other present value (`false`,
 * `"yes"`, `1`, `null`) is removed and counted as 1 dropped. Returns the same
 * Node when the flag is `true` or absent.
 *
 * P4-3f review round 1: `testCoverageHit` (the per-Node proof that lets the
 * table say "covered") the same way, and additionally only alongside a
 * surviving `testCoverageAvailable: true` — a lone hit is removed and
 * counted, so the claim can only shrink at this boundary, never grow.
 */
export function sanitizeNodeTestCoverageAvailable(node: CodeMapNode): { node: CodeMapNode; dropped: number } {
  const hasFlag = 'testCoverageAvailable' in node;
  const hasHit = 'testCoverageHit' in node;
  if (!hasFlag && !hasHit) {
    return { node, dropped: 0 };
  }
  const rawFlag: unknown = node.testCoverageAvailable;
  const rawHit: unknown = node.testCoverageHit;
  const keepFlag = rawFlag === true;
  const keepHit = keepFlag && rawHit === true;
  if ((!hasFlag || keepFlag) && (!hasHit || keepHit)) {
    return { node, dropped: 0 };
  }
  const { testCoverageAvailable: _flag, testCoverageHit: _hit, ...rest } = node;
  // An own key holding `undefined` says nothing, so it is removed without
  // counting as malformed.
  const dropped = (hasFlag && !keepFlag && rawFlag !== undefined ? 1 : 0) + (hasHit && !keepHit && rawHit !== undefined ? 1 : 0);
  return {
    node: { ...rest, ...(keepFlag ? { testCoverageAvailable: true as const } : {}), ...(keepHit ? { testCoverageHit: true as const } : {}) },
    dropped,
  };
}

/** P4-2 phase 3c: a well-formed `TopLevelChangedFile`: string `file`, a valid line range. */
export function isTopLevelChangedFile(value: unknown): value is TopLevelChangedFile {
  return isRecord(value) && isString(value.file) && isLineRange(value.startLine, value.endLine);
}

const MALFORMED_DIFF_SCOPE: DiffScopeResult = {
  status: 'error',
  message: 'The diff-scope reply from the Graph Service was malformed.',
};

/** Keeps an optional array field's well-formed elements; `dropped` counts the rest (a non-array counts 1). */
function keepValid<T>(raw: unknown, isValid: (value: unknown) => value is T): { kept: T[]; dropped: number } {
  if (raw === undefined) {
    return { kept: [], dropped: 0 };
  }
  if (!Array.isArray(raw)) {
    return { kept: [], dropped: 1 };
  }
  const kept = raw.filter(isValid);
  return { kept, dropped: raw.length - kept.length };
}

/**
 * P4-2 phase 3c: a diff-scope reply as the renderer may read it. A
 * resolved result needs a string `resolvedBaseRef` and an array `nodeIds`
 * (else the whole reply becomes an explicit error); non-string `nodeIds`
 * entries are dropped. `topLevelFiles` and `changedContracts` keep only
 * well-formed elements and are left out when none survive;
 * `changedContractsApproximate` survives only as `true` beside contracts.
 * An error result needs a string `message`. Other states pass through.
 * `dropped` counts what was removed, for one warning per reply.
 */
export function toValidatedDiffScopeResult(result: DiffScopeResult): { result: DiffScopeResult; dropped: number } {
  if (!isRecord(result)) {
    return { result: MALFORMED_DIFF_SCOPE, dropped: 1 };
  }
  if (result.status === 'error') {
    return isString(result.message) ? { result, dropped: 0 } : { result: MALFORMED_DIFF_SCOPE, dropped: 1 };
  }
  if (result.status !== 'resolved') {
    const known = ['no-changes', 'not-a-git-repo', 'no-base-ref-resolvable'] as const;
    return (known as readonly unknown[]).includes(result.status)
      ? { result: { status: result.status }, dropped: 0 }
      : { result: MALFORMED_DIFF_SCOPE, dropped: 1 };
  }
  const raw = result as Record<string, unknown>;
  if (!isString(raw.resolvedBaseRef) || !Array.isArray(raw.nodeIds)) {
    return { result: MALFORMED_DIFF_SCOPE, dropped: 1 };
  }
  const nodeIds = raw.nodeIds.filter(isString);
  const topLevel = keepValid(raw.topLevelFiles, isTopLevelChangedFile);
  const contracts = keepValid(raw.changedContracts, isChangedContract);
  const approximate = raw.changedContractsApproximate === true && contracts.kept.length > 0;
  return {
    result: {
      status: 'resolved',
      resolvedBaseRef: raw.resolvedBaseRef,
      nodeIds,
      ...(topLevel.kept.length > 0 ? { topLevelFiles: topLevel.kept } : {}),
      ...(contracts.kept.length > 0 ? { changedContracts: contracts.kept } : {}),
      ...(approximate ? { changedContractsApproximate: true as const } : {}),
    },
    dropped: raw.nodeIds.length - nodeIds.length + topLevel.dropped + contracts.dropped,
  };
}

/** "a", "a and b", "a, b and c" — for a one-line log of the replaced fields. */
export function joinNaturally(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function toOkCodeMapResult(message: CodeMapReply): {
  result: OkCodeMapResult;
  replaced: ReplacedCodeMapField[];
  /** P4-2 phase 3b: how many `foldedTypes` elements were malformed and dropped. */
  droppedFoldedTypes: number;
  /** P4-2 phase 3c: how many `foldedModules` elements were malformed and dropped. */
  droppedFoldedModules: number;
  /** P4-2 phase 4: how many `similarTo` elements, across all Nodes, were malformed and dropped. */
  droppedSimilarTo: number;
  /** P4-3 phase 5: how many `testCoverageAvailable` / `testCoverageHit` values were malformed (or a hit without the flag), stripped. */
  droppedTestCoverageAvailable: number;
} {
  const replaced: ReplacedCodeMapField[] = [];
  const rawHidden: unknown = message.hiddenByScope;
  let hiddenByScope = 0;
  if (typeof rawHidden === 'number' && Number.isFinite(rawHidden)) {
    hiddenByScope = rawHidden;
  } else {
    replaced.push('hiddenByScope');
  }
  const rawScope: unknown = message.appliedScope;
  let appliedScope: string[] = [];
  if (Array.isArray(rawScope) && rawScope.every((entry) => typeof entry === 'string')) {
    appliedScope = rawScope as string[];
  } else {
    replaced.push('appliedScope');
  }
  const rawTypes: unknown = message.foldedTypes;
  let foldedTypes: FoldedType[] = [];
  let droppedFoldedTypes = 0;
  if (Array.isArray(rawTypes)) {
    foldedTypes = rawTypes.filter(isFoldedType);
    droppedFoldedTypes = rawTypes.length - foldedTypes.length;
  } else {
    replaced.push('foldedTypes');
  }
  const rawModules: unknown = message.foldedModules;
  let foldedModules: FoldedModule[] = [];
  let droppedFoldedModules = 0;
  if (Array.isArray(rawModules)) {
    foldedModules = rawModules.filter(isFoldedModule);
    droppedFoldedModules = rawModules.length - foldedModules.length;
  } else {
    replaced.push('foldedModules');
  }
  let droppedSimilarTo = 0;
  let droppedTestCoverageAvailable = 0;
  const nodes = Array.isArray(message.nodes)
    ? message.nodes.map((node) => {
        if (!isRecord(node)) {
          return node;
        }
        const sanitized = sanitizeNodeSimilarTo(node);
        droppedSimilarTo += sanitized.dropped;
        const flagged = sanitizeNodeTestCoverageAvailable(sanitized.node);
        droppedTestCoverageAvailable += flagged.dropped;
        return flagged.node;
      })
    : message.nodes;
  return {
    result: {
      status: 'ok',
      nodes,
      edges: message.edges,
      hiddenByScope,
      appliedScope,
      foldedTypes,
      foldedModules,
    },
    replaced,
    droppedFoldedTypes,
    droppedFoldedModules,
    droppedSimilarTo,
    droppedTestCoverageAvailable,
  };
}
