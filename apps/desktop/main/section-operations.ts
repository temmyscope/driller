/**
 * P4-4 phase 2a (AD-13 "Section scope"): the optional `section` on the three
 * section-scoped operations main relays — Path Trace, diff scope and Blast
 * Radius expansion — as pure functions, so the validation and the request
 * shapes are testable without Electron.
 *
 * - `parseOperationSectionArg` validates the renderer's untyped IPC
 *   argument: absent (`undefined`, the whole scope) or a non-empty string.
 *   Anything else — `42`, `null`, `''`, an object — is malformed: the IPC
 *   handler answers `INVALID_OPERATION_SECTION_RESULT` and sends nothing.
 *   Whether a string is a real allowlist entry is the Graph Service's call
 *   (`unknown-section`), never main's.
 * - The `build…Request` functions are the main → Graph Service messages.
 *   Without a section each is exactly the message main sent before this
 *   phase (same fields, same order, no `section` key at all).
 */
import type {
  DiffScopeCarryResult,
  GraphServiceComputeDiffScopeRequest,
  GraphServiceDiffScopeCarryRequest,
  GraphServiceExpandBlastRadiusRequest,
  GraphServicePathTraceRequest,
} from '@driller/ipc-contracts';

/** The validated `section` IPC argument (`section` absent = the whole scope). */
export type ParsedOperationSection = { ok: true; section?: string } | { ok: false };

/** The renderer's `section` argument for Path Trace, diff scope or Blast Radius expansion, validated. */
export function parseOperationSectionArg(value: unknown): ParsedOperationSection {
  if (value === undefined) {
    return { ok: true };
  }
  return typeof value === 'string' && value.length > 0 ? { ok: true, section: value } : { ok: false };
}

/** The reply to a malformed `section` argument (nothing is sent to the Graph Service). */
export const INVALID_OPERATION_SECTION_RESULT = { status: 'error', message: 'Invalid section.' } as const;

const sectionField = (section: string | undefined): { section?: string } =>
  section === undefined ? {} : { section };

/** The `graphService:pathTrace` request. */
export function buildPathTraceRequest(
  query: string,
  requestId: number,
  section?: string,
): GraphServicePathTraceRequest {
  return { type: 'graphService:pathTrace', query, requestId, ...sectionField(section) };
}

/** The `graphService:computeDiffScope` request (`baseRef` omitted when absent, as before). */
export function buildComputeDiffScopeRequest(
  projectPath: string,
  requestId: number,
  baseRef: string | undefined,
  section?: string,
): GraphServiceComputeDiffScopeRequest {
  return {
    type: 'graphService:computeDiffScope',
    projectPath,
    requestId,
    ...(baseRef !== undefined ? { baseRef } : {}),
    ...sectionField(section),
  };
}

/** The `graphService:expandBlastRadius` request. */
export function buildExpandBlastRadiusRequest(
  projectPath: string,
  nodeIds: string[],
  requestId: number,
  section?: string,
): GraphServiceExpandBlastRadiusRequest {
  return { type: 'graphService:expandBlastRadius', projectPath, nodeIds, requestId, ...sectionField(section) };
}

// ---------------------------------------------------------------------------
// P4-4 phase 3b (founder decision 2026-10-04): may PR Review's base ref carry
// over a section switch?
// ---------------------------------------------------------------------------

/** The validated `diffScope:carry` arguments, or why they were rejected (nothing is sent then). */
export type ParsedDiffScopeCarryArgs =
  | { ok: true; projectPath: string; fromSection: string | null; toSection: string | null; baseRef: string }
  | { ok: false; result: DiffScopeCarryResult };

const isSectionKey = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && value.length > 0);

/**
 * The renderer's untyped `diffScope:carry` arguments: a non-empty project
 * path, each section `null` (`all`) or a non-empty string, and a base ref
 * that is non-empty once trimmed (sent trimmed).
 */
export function parseDiffScopeCarryArgs(
  projectPath: unknown,
  fromSection: unknown,
  toSection: unknown,
  baseRef: unknown,
): ParsedDiffScopeCarryArgs {
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return { ok: false, result: { status: 'error', message: 'Invalid project path.' } };
  }
  if (!isSectionKey(fromSection) || !isSectionKey(toSection)) {
    return { ok: false, result: INVALID_OPERATION_SECTION_RESULT };
  }
  const trimmed = typeof baseRef === 'string' ? baseRef.trim() : '';
  if (trimmed.length === 0) {
    return { ok: false, result: { status: 'error', message: 'Invalid base ref.' } };
  }
  return { ok: true, projectPath, fromSection, toSection, baseRef: trimmed };
}

/** The `graphService:diffScopeCarry` request. */
export function buildDiffScopeCarryRequest(
  args: Extract<ParsedDiffScopeCarryArgs, { ok: true }>,
  requestId: number,
): GraphServiceDiffScopeCarryRequest {
  return {
    type: 'graphService:diffScopeCarry',
    projectPath: args.projectPath,
    requestId,
    fromSection: args.fromSection,
    toSection: args.toSection,
    baseRef: args.baseRef,
  };
}

/** The Graph Service's reply, validated at the process boundary: anything malformed is an `error`. */
export function toValidatedDiffScopeCarryResult(result: unknown): DiffScopeCarryResult {
  const status = (result as { status?: unknown } | null)?.status;
  if (status === 'same-repository' || status === 'ref-exists' || status === 'not-carried') {
    return { status };
  }
  const message = (result as { message?: unknown } | null)?.message;
  if (status === 'error' && typeof message === 'string') {
    return { status: 'error', message };
  }
  return { status: 'error', message: 'Malformed diff-scope carry reply.' };
}
