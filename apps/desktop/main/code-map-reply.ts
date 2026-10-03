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
 *
 * P4-4 phase 1b: `section` must be a string or `null` (anything else
 * becomes `null`, named in `replaced`), and `sections` is validated per
 * element (`isSectionNodeCount`): a non-array becomes `[]` (named in
 * `replaced`), each malformed element is dropped and counted in
 * `droppedSections`. An unknown-section reply goes through
 * `toUnknownSectionResult`. Whether a reply is for the request being
 * settled is checked before either (`code-map-requests.ts`'s
 * `routeCodeMapReply`).
 *
 * P4-4 phase 3a: the cross-section counts, per element, the same way:
 * `crossSectionEdges` (`isCrossSectionEdgeCount`) and each Node's
 * `crossSectionCalls` (`sanitizeNodeCrossSectionCalls`) on a Code Map
 * reply, `changedInOtherSections` (`isSectionChangeCount`) on a diff-scope
 * reply. Malformed elements
 * are dropped and counted (logged once per reply by the caller), a field
 * with nothing left is removed rather than sent as `[]`, and a whole-scope
 * reply (`section: null`) never carries `crossSectionEdges` (nor, review
 * round 1, any Node's `crossSectionCalls`).
 */
import type {
  ChangedContract,
  CodeMapNode,
  CodeMapResult,
  CrossSectionCall,
  CrossSectionEdgeCount,
  DiffScopeResult,
  FoldedModule,
  FoldedType,
  GraphServiceCodeMapMessage,
  SectionChangeCount,
  SectionNodeCount,
  SimilarImplementation,
  TopLevelChangedFile,
  UnknownSectionResult,
} from '@driller/ipc-contracts';
import { CROSS_SECTION_CALLS_MAX } from '@driller/ipc-contracts';

type CodeMapReply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;
type UnknownSectionReply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMapUnknownSection' }>;
type OkCodeMapResult = Extract<CodeMapResult, { status: 'ok' }>;
type UnknownSectionCodeMapResult = Extract<CodeMapResult, { status: 'unknown-section' }>;

export type ReplacedCodeMapField =
  | 'hiddenByScope'
  | 'appliedScope'
  | 'foldedTypes'
  | 'foldedModules'
  | 'section'
  | 'sections';

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
 * P4-4 phase 1b: whether `value` is a well-formed `SectionNodeCount`: a
 * string `path` and a non-negative integer `nodeCount`.
 */
export function isSectionNodeCount(value: unknown): value is SectionNodeCount {
  return (
    isRecord(value) &&
    isString(value.path) &&
    Number.isInteger(value.nodeCount) &&
    (value.nodeCount as number) >= 0
  );
}

/**
 * P4-4 phase 1b: an unknown-section reply as the renderer may read it.
 * `section` must be a string (else `null`: the caller settles an error);
 * `knownSections` keeps only its string elements (a non-array becomes
 * `[]`), and `dropped` counts what was removed.
 */
export function toUnknownSectionResult(
  message: UnknownSectionReply,
): { result: UnknownSectionCodeMapResult; dropped: number } | null {
  return parseUnknownSection(message.section, message.knownSections);
}

/**
 * The `{status: 'unknown-section'}` fields off an untyped reply: `null` when
 * `section` is not a string; `knownSections` keeps only its strings (a
 * non-array becomes `[]`), counting what it dropped. Shared by the Code Map
 * reply and (P4-4 phase 2a) the diff-scope reply.
 */
function parseUnknownSection(
  rawSection: unknown,
  rawKnown: unknown,
): { result: UnknownSectionResult; dropped: number } | null {
  if (!isString(rawSection)) {
    return null;
  }
  const known = Array.isArray(rawKnown) ? rawKnown.filter(isString) : [];
  const dropped = Array.isArray(rawKnown) ? rawKnown.length - known.length : 1;
  return { result: { status: 'unknown-section', section: rawSection, knownSections: known }, dropped };
}

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

/** A count field: a non-negative integer. */
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/**
 * P4-4 phase 3a (founder decision 2026-10-03): whether `value` is a
 * well-formed `CrossSectionEdgeCount`: a non-empty string `section` and
 * non-negative integer `outgoing` / `incoming`, at least one above 0 (an
 * entry exists only for a section with an edge).
 */
export function isCrossSectionEdgeCount(value: unknown): value is CrossSectionEdgeCount {
  return (
    isRecord(value) &&
    isString(value.section) &&
    value.section.length > 0 &&
    isCount(value.outgoing) &&
    isCount(value.incoming) &&
    value.outgoing + value.incoming >= 1
  );
}

/**
 * P4-4 phase 3a (founder decision 2026-10-03): whether `value` is a
 * well-formed `SectionChangeCount`: a non-empty string `section` and
 * non-negative integer `changedNodes` / `changedContracts` / `topLevelFiles`,
 * at least one above 0.
 */
export function isSectionChangeCount(value: unknown): value is SectionChangeCount {
  return (
    isRecord(value) &&
    isString(value.section) &&
    value.section.length > 0 &&
    isCount(value.changedNodes) &&
    isCount(value.changedContracts) &&
    isCount(value.topLevelFiles) &&
    value.changedNodes + value.changedContracts + value.topLevelFiles >= 1
  );
}

/** P4-4 phase 3a: whether `value` is a well-formed `CrossSectionCall`: non-empty string `id`/`name`/`section`. */
export function isCrossSectionCall(value: unknown): value is CrossSectionCall {
  return (
    isRecord(value) &&
    isString(value.id) &&
    value.id.length > 0 &&
    isString(value.name) &&
    value.name.length > 0 &&
    isString(value.section) &&
    value.section.length > 0
  );
}

/**
 * P4-4 phase 3a: an optional per-section count list's well-formed elements,
 * the first entry per section only (a repeated section would double a
 * line). `undefined` when nothing survives (the field is then left out,
 * never `[]`); `dropped` counts what was removed (a non-array counts 1).
 */
function keepSectionCounts<T extends { section: string }>(
  raw: unknown,
  isValid: (value: unknown) => value is T,
): { kept: T[] | undefined; dropped: number } {
  const valid = keepValid(raw, isValid);
  const seen = new Set<string>();
  const kept = valid.kept.filter((entry) => !seen.has(entry.section) && seen.add(entry.section) !== undefined);
  return { kept: kept.length > 0 ? kept : undefined, dropped: valid.dropped + (valid.kept.length - kept.length) };
}

/**
 * P4-4 phase 3a: a Node with its `crossSectionCalls` validated per element,
 * for a reply about `section` (`null`: the whole scope). The same rules as
 * `sanitizeNodeSimilarTo`, plus the section's own:
 *  - on a whole-scope reply both fields are removed (counted as 1): a
 *    no-section Node never carries them, like the reply's `crossSectionEdges`;
 *  - malformed elements, repeated ids and (review round 1) calls whose
 *    `section` is the reply's own section are dropped and counted;
 *  - with none left both fields are removed; a lone `crossSectionCallsTotal`
 *    is removed and counted;
 *  - a surviving list keeps a `crossSectionCallsTotal` that is an integer at
 *    least its length, else gets its length (counted);
 *  - (review round 1) a list longer than `CROSS_SECTION_CALLS_MAX` is cut to
 *    the cap, keeping the total; each cut entry is counted.
 * Returns the same Node when nothing needed changing (or both are absent).
 */
export function sanitizeNodeCrossSectionCalls(
  node: CodeMapNode,
  section: string | null,
): { node: CodeMapNode; dropped: number } {
  const raw: unknown = node.crossSectionCalls;
  const rawTotal: unknown = node.crossSectionCallsTotal;
  if (raw === undefined && rawTotal === undefined) {
    return { node, dropped: 0 };
  }
  const { crossSectionCalls: _calls, crossSectionCallsTotal: _total, ...rest } = node;
  if (section === null) {
    return { node: rest, dropped: 1 };
  }
  const valid = keepValid(raw, isCrossSectionCall);
  const seen = new Set<string>();
  const kept = valid.kept.filter(
    (entry) => entry.section !== section && !seen.has(entry.id) && seen.add(entry.id) !== undefined,
  );
  const dropped = valid.dropped + (valid.kept.length - kept.length);
  if (kept.length === 0) {
    return { node: rest, dropped: dropped + (raw === undefined ? 1 : 0) };
  }
  const totalOk = Number.isInteger(rawTotal) && (rawTotal as number) >= kept.length;
  const overCap = Math.max(0, kept.length - CROSS_SECTION_CALLS_MAX);
  if (dropped === 0 && totalOk && overCap === 0) {
    return { node, dropped: 0 };
  }
  return {
    node: {
      ...rest,
      crossSectionCalls: kept.slice(0, CROSS_SECTION_CALLS_MAX),
      crossSectionCallsTotal: totalOk ? (rawTotal as number) : kept.length,
    },
    dropped: dropped + (totalOk ? 0 : 1) + overCap,
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
  // P4-4 phase 2a: an unknown-section reply is passed through, validated
  // like the Code Map's own. (Read off a widened view: `isRecord` narrows
  // the `UnknownSectionResult` interface out of `result`'s type.)
  const untyped = result as Record<string, unknown>;
  if (untyped.status === 'unknown-section') {
    return parseUnknownSection(untyped.section, untyped.knownSections) ?? { result: MALFORMED_DIFF_SCOPE, dropped: 1 };
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
  // P4-4 phase 3a: the changed Nodes in other sections (section requests only).
  const elsewhere = keepSectionCounts(raw.changedInOtherSections, isSectionChangeCount);
  return {
    result: {
      status: 'resolved',
      resolvedBaseRef: raw.resolvedBaseRef,
      nodeIds,
      ...(topLevel.kept.length > 0 ? { topLevelFiles: topLevel.kept } : {}),
      ...(contracts.kept.length > 0 ? { changedContracts: contracts.kept } : {}),
      ...(approximate ? { changedContractsApproximate: true as const } : {}),
      ...(elsewhere.kept !== undefined ? { changedInOtherSections: elsewhere.kept } : {}),
    },
    dropped: raw.nodeIds.length - nodeIds.length + topLevel.dropped + contracts.dropped + elsewhere.dropped,
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
  /** P4-4 phase 1b: how many `sections` elements were malformed and dropped. */
  droppedSections: number;
  /**
   * P4-4 phase 3a: how many cross-section count elements (`crossSectionEdges`,
   * and every Node's `crossSectionCalls` / `crossSectionCallsTotal`) were
   * malformed and dropped — including a `crossSectionEdges` on a whole-scope
   * reply, which never carries one.
   */
  droppedCrossSection: number;
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
  const rawSection: unknown = message.section;
  let section: string | null = null;
  if (rawSection === null || isString(rawSection)) {
    section = rawSection;
  } else {
    replaced.push('section');
  }
  const rawSections: unknown = message.sections;
  let sections: SectionNodeCount[] = [];
  let droppedSections = 0;
  if (Array.isArray(rawSections)) {
    sections = rawSections.filter(isSectionNodeCount);
    droppedSections = rawSections.length - sections.length;
  } else {
    replaced.push('sections');
  }
  // P4-4 phase 3a: only a section reply may carry `crossSectionEdges`.
  const rawCrossEdges: unknown = (message as { crossSectionEdges?: unknown }).crossSectionEdges;
  const crossEdges =
    section === null
      ? { kept: undefined, dropped: rawCrossEdges === undefined ? 0 : 1 }
      : keepSectionCounts(rawCrossEdges, isCrossSectionEdgeCount);
  let droppedCrossSection = crossEdges.dropped;
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
        const crossChecked = sanitizeNodeCrossSectionCalls(flagged.node, section);
        droppedCrossSection += crossChecked.dropped;
        return crossChecked.node;
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
      section,
      sections,
      ...(crossEdges.kept !== undefined ? { crossSectionEdges: crossEdges.kept } : {}),
    },
    replaced,
    droppedFoldedTypes,
    droppedFoldedModules,
    droppedSimilarTo,
    droppedTestCoverageAvailable,
    droppedSections,
    droppedCrossSection,
  };
}
