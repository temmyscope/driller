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
  GraphServiceComputeDiffScopeRequest,
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
