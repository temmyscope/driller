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
 */
import type { CodeMapResult, FoldedType, GraphServiceCodeMapMessage } from '@driller/ipc-contracts';

type CodeMapReply = Extract<GraphServiceCodeMapMessage, { type: 'graphService:codeMap' }>;
type OkCodeMapResult = Extract<CodeMapResult, { status: 'ok' }>;

export type ReplacedCodeMapField = 'hiddenByScope' | 'appliedScope' | 'foldedTypes';

const isString = (value: unknown): value is string => typeof value === 'string';
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);

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
    isFiniteNumber(type.startLine) &&
    isFiniteNumber(type.endLine) &&
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
  return {
    result: { status: 'ok', nodes: message.nodes, edges: message.edges, hiddenByScope, appliedScope, foldedTypes },
    replaced,
    droppedFoldedTypes,
  };
}
