/**
 * CodeRabbit CLI adapter (Story 2.3, Phase 2).
 *
 * driller's first PR-bot ingestion adapter — resolves the base branch
 * (`git-base-ref.ts`), invokes `cr review --base <branch> --agent` in its
 * non-mutating review/analysis mode only (Always: AD-12, AD-17 — no other
 * flags, never a flag granting `cr` write access), parses its JSON output,
 * maps each finding's native severity onto the canonical
 * `'blocker'|'major'|'minor'|'info'` scale, resolves each finding's
 * file+line to an enclosing Node via `@driller/graph-contracts`'s
 * `findEnclosingNode`, and groups the results by Node id.
 *
 * CodeRabbit's exact `--agent` JSON schema is unconfirmed against official
 * docs (command syntax was verified; field names weren't — Design Notes).
 * Every part of this file that depends on that unconfirmed shape is
 * isolated inside `parseCodeRabbitOutput` and `mapCodeRabbitSeverity`,
 * exactly so a human can correct just those two functions once real `cr
 * review --agent` output is observed, without touching the subprocess
 * invocation, branch resolution, or Node-lookup/grouping logic around them
 * (Always: "isolated behind one narrow function... a shape mismatch
 * degrades to 'error', never throws uncaught or silently drops findings").
 */

import { findEnclosingNode } from '@driller/graph-contracts';
import type { CodeMapNode, IngestedRiskSignal } from '@driller/ipc-contracts';
import { resolveDefaultBranch } from './git-base-ref';
import { runSafeSubprocess } from './subprocess-runner';

/** The `sourceTool` value every finding this adapter produces carries — exported so `index.ts` can filter by it during the clear-prior-findings step (Always: "Each pass... replaces that tool's prior findings across every Node first"). */
export const CODERABBIT_SOURCE_TOOL = 'CodeRabbit';

/**
 * Result of a full CodeRabbit ingestion pass — an explicit result state
 * (AD-13's broader pattern), structurally identical to (and consumed
 * directly as) `@driller/ipc-contracts`'s `PrBotIngestionResult`, except the
 * `'ok'` variant carries the grouped-by-Node findings rather than a bare
 * count — `index.ts`'s caller derives the count after merge-writing them.
 */
export type CodeRabbitIngestionResult =
  | { status: 'ok'; findingsByNodeId: Record<string, IngestedRiskSignal[]> }
  | { status: 'tool-not-found' }
  | { status: 'no-base-ref-resolvable' }
  | { status: 'error'; message: string };

/**
 * Runs one CodeRabbit ingestion pass for `projectRoot` against the already-
 * fetched Code Map `nodes` (Story 2.3, Phase 2's `runIngestion` handler
 * passes the same `activeCodeMapNodes` `regenerateNode` reuses, never a
 * fresh fetch). Never throws — every failure path resolves to an explicit
 * result state.
 */
export async function runCodeRabbitIngestion(
  projectRoot: string,
  nodes: CodeMapNode[],
): Promise<CodeRabbitIngestionResult> {
  const branchResult = await resolveDefaultBranch(projectRoot);
  if ('resolvable' in branchResult) {
    // `resolvable: false` — never a silent hardcoded fallback (Always); `cr`
    // is never invoked in this case (I/O matrix).
    return { status: 'no-base-ref-resolvable' };
  }

  const subprocessResult = await runSafeSubprocess(
    'cr',
    ['review', '--base', branchResult.branch, '--agent'],
    { cwd: projectRoot },
  );

  if ('notFound' in subprocessResult) {
    return { status: 'tool-not-found' };
  }
  if ('error' in subprocessResult) {
    return { status: 'error', message: subprocessResult.error };
  }

  const parsed = parseCodeRabbitOutput(subprocessResult.stdout);
  if (parsed.status === 'error') {
    return { status: 'error', message: parsed.message };
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const findingsByNodeId: Record<string, IngestedRiskSignal[]> = {};

  for (const finding of parsed.findings) {
    // A finding whose file+line falls inside no known Node's range is
    // dropped — never attached to a synthetic/file-level pseudo-Node
    // (Always). `nodes` (not a separately-fetched set) is exactly what
    // `findEnclosingNode` walks, so a dropped finding here is genuinely
    // outside every Node driller currently knows about.
    const nodeId = findEnclosingNode(nodes, finding.file, finding.line);
    if (nodeId === undefined) {
      continue;
    }
    const node = nodesById.get(nodeId);
    if (!node) {
      // Unreachable in practice — `findEnclosingNode` only ever returns an
      // id it read off one of `nodes`, so `nodesById` always has it. A
      // defensive skip rather than a non-null assertion, matching this
      // codebase's stance elsewhere (e.g. `computeRegenerateNodeResult`'s
      // "Unreachable in practice" comments) of never trusting an assumed
      // invariant all the way to an unchecked access.
      continue;
    }

    const signal: IngestedRiskSignal = {
      family: 'ingested',
      severity: mapCodeRabbitSeverity(finding.severity),
      sourceTool: CODERABBIT_SOURCE_TOOL,
      finding: finding.message,
      // Mirrors `LlmJudgmentRiskSignal`'s own convention (ipc-contracts:
      // "for this phase, always the owning Node's own {file, startLine,
      // endLine} range") rather than the finding's own raw file/line — the
      // owning Node's range is always well-formed and already
      // project-relative/POSIX, unlike the finding's raw coordinates, whose
      // exact format CodeRabbit reports is part of the same unconfirmed
      // schema this file isolates.
      location: { file: node.file, startLine: node.startLine, endLine: node.endLine },
    };

    const existing = findingsByNodeId[nodeId];
    if (existing) {
      existing.push(signal);
    } else {
      findingsByNodeId[nodeId] = [signal];
    }
  }

  return { status: 'ok', findingsByNodeId };
}

// ---------------------------------------------------------------------------
// Schema-uncertain boundary (Design Notes) — everything below this point
// depends on CodeRabbit's unconfirmed `--agent` JSON field names. Isolated
// in these two functions (both exported for direct hand-testing — see this
// story's Verification section) so a human can correct just this section
// once real output is observed, without touching anything above it.
//
// Review finding (Edge Case Hunter, not patched — flagged for the same
// human correction pass): `finding.file`'s exact path FORMAT (absolute vs.
// project-relative, `./` prefix, separator) is also unconfirmed, not just
// its field name — `findEnclosingNode`'s exact-string match against
// `nodes[].file` (POSIX-relative, AD-19) will silently drop every finding
// if the real format differs, producing an `'ok'`/`findingCount: 0` result
// indistinguishable from a genuinely clean pass. No normalization is added
// here since the real format can't be guessed any better than the rest of
// this schema; correct alongside the field names/severity table once real
// `cr review --agent` output is observed.
// ---------------------------------------------------------------------------

/** One finding as `parseCodeRabbitOutput`'s best-effort assumed shape produces it. */
export interface RawCodeRabbitFinding {
  file: string;
  line: number;
  severity: string;
  message: string;
}

/** Result of `parseCodeRabbitOutput` — an explicit result state, never a thrown exception or a silently-empty array standing in for "didn't parse." */
export type ParseCodeRabbitOutputResult =
  | { status: 'ok'; findings: RawCodeRabbitFinding[] }
  | { status: 'error'; message: string };

/**
 * Parses `cr review --agent`'s raw stdout into `{file, line, severity,
 * message}` findings — the best-effort assumed shape (Design Notes: "a
 * top-level array or `{findings: [...]}`" of objects carrying those four
 * fields). Never throws: invalid JSON, or JSON that's valid but doesn't
 * match either top-level shape, both degrade to an explicit `{status:
 * 'error', message}` (Always: "a shape mismatch degrades to 'error', never
 * throws uncaught or silently drops findings") rather than an empty
 * `findings` array, which would otherwise be indistinguishable from a
 * genuinely clean pass (I/O matrix: "'ok' result" with a real finding count
 * vs. "'error' result with a message; nothing persisted" for schema drift —
 * conflating the two would misreport a parse failure as "no issues found").
 *
 * An individual array entry that doesn't itself match the assumed per-
 * finding shape (missing/mis-typed `file`/`line`/`severity`/`message`) is
 * skipped rather than failing the whole parse — this is a judgment call
 * (not stated explicitly in the spec's I/O matrix, which only covers
 * top-level schema drift), made on the same reasoning the matrix already
 * applies one step downstream ("a finding's file+line matches no Node ->
 * that finding is dropped, others still persisted"): one malformed entry
 * among otherwise-valid ones shouldn't discard every other genuine finding
 * in the same report. Revisit this choice specifically, alongside the field
 * names below, once real output is observed.
 */
export function parseCodeRabbitOutput(raw: string): ParseCodeRabbitOutputResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: 'error',
      message: `CodeRabbit output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const candidateArray = extractCandidateArray(parsed);
  if (!candidateArray) {
    return {
      status: 'error',
      message:
        'CodeRabbit output did not match the expected shape (a top-level array, or an object with a "findings" array).',
    };
  }

  const findings: RawCodeRabbitFinding[] = [];
  for (const item of candidateArray) {
    const finding = coerceRawFinding(item);
    if (finding) {
      findings.push(finding);
    }
  }
  return { status: 'ok', findings };
}

function extractCandidateArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const findings = (parsed as { findings?: unknown }).findings;
    if (Array.isArray(findings)) {
      return findings;
    }
  }
  return undefined;
}

function coerceRawFinding(item: unknown): RawCodeRabbitFinding | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const candidate = item as { file?: unknown; line?: unknown; severity?: unknown; message?: unknown };
  if (
    typeof candidate.file === 'string' &&
    typeof candidate.line === 'number' &&
    // Review finding (Edge Case Hunter): `typeof x === 'number'` admits
    // `NaN`, and `NaN < n`/`NaN > n` are both `false` — a `NaN` line would
    // silently bypass `findEnclosingNode`'s range check and falsely match
    // the first/smallest-range Node for that file instead of being dropped
    // per the Always constraint ("a finding whose file+line falls inside no
    // known Node's range is dropped").
    Number.isFinite(candidate.line) &&
    typeof candidate.severity === 'string' &&
    typeof candidate.message === 'string'
  ) {
    return {
      file: candidate.file,
      line: candidate.line,
      severity: candidate.severity,
      message: candidate.message,
    };
  }
  return undefined;
}

/**
 * Maps CodeRabbit's native severity string onto the canonical
 * `'blocker'|'major'|'minor'|'info'` scale (Always: "every finding's
 * severity is mapped through an explicit table... never passed through
 * unmapped; an unrecognized native value maps to `'info'`").
 *
 * The table below is a best-effort guess at CodeRabbit's actual native
 * values (Design Notes: schema unconfirmed) — case-insensitive matches
 * against the severity/priority vocabulary CodeRabbit's own product
 * surfaces commonly use (critical/high/medium/low, plus
 * blocker/major/minor/info/nit/nitpick/suggestion as synonyms a real
 * `--agent` build might use instead). Correct this table's left-hand keys
 * once real `cr review --agent` output is observed; the never-unmapped,
 * default-to-`'info'` contract on the right-hand side must be preserved
 * regardless of what the keys turn out to be.
 */
export function mapCodeRabbitSeverity(native: string): IngestedRiskSignal['severity'] {
  const normalized = native.trim().toLowerCase();
  return SEVERITY_TABLE[normalized] ?? 'info';
}

const SEVERITY_TABLE: Record<string, IngestedRiskSignal['severity']> = {
  blocker: 'blocker',
  critical: 'blocker',
  major: 'major',
  high: 'major',
  minor: 'minor',
  medium: 'minor',
  info: 'info',
  low: 'info',
  nit: 'info',
  nitpick: 'info',
  suggestion: 'info',
};
