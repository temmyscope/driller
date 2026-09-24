/**
 * A Node's `riskSignals` assembly (Story 2.1-2.3), moved out of `index.ts` in
 * P0-4 so it can be imported — and its output compared against
 * `live-node.ts`'s `deriveLiveNode` in a parity test — without `index.ts`'s
 * module-load side effects (initializing the record store, binding the MCP
 * server's port). Every input is a parameter; the one ambient read is the
 * record lookup, which defaults to the live `getNodeRecord` and is injectable.
 * `index.ts`'s `handleGetCodeMapRequest` is the production caller.
 */
import {
  computeBlastRadiusFromAdjacency,
  type BidirectionalAdjacency,
} from '@driller/graph-contracts';
import type { RiskSignal, RiskSignalLocation } from '@driller/ipc-contracts';
import { hasCoverageGap, type LcovCoverage } from './lcov';
import type { CodeMapNodeWithSignalSources } from './mcp-client';
import { getNodeRecord, type NodeRecord } from './node-record-store';

/**
 * Story 2.1 (Phase 1): builds one Node's `riskSignals` array (FR7, AD-9
 * corrected). `complexity`/`cognitive-complexity`/`hotspot` are surfaced only
 * when the backend actually reported a value for this Node/File (Boundaries
 * & Constraints — "no complexity data for a Node... not an error", I/O
 * matrix) — each is simply omitted from the array rather than included with
 * a placeholder value. `blast-radius` is the one signal always present, even
 * at value `0` for an isolated Node with no edges at all (I/O matrix),
 * computed via `@driller/graph-contracts`'s cycle-safe
 * `computeBlastRadiusFromAdjacency` against a pre-built `adjacency` — the
 * Code Map's already-fetched edges, never a second graph fetch.
 *
 * `location` duplicates `node`'s own `{file, startLine, endLine}` on every
 * signal (Design Notes) — degenerate here, but required by the Consistency
 * Conventions table since later signal families may report a narrower
 * location than their owning Node's full range.
 *
 * Pushed in a fixed field order (complexity, cognitive-complexity, hotspot,
 * blast-radius) so `riskSignals` is byte-identical across repeated fetches
 * of unchanged repo state (FR7 reproducibility) — no wall-clock, random, or
 * non-deterministic ordering input anywhere in this function. (Live-verified
 * this review round: `query_graph`'s row order is stable across repeated
 * identical calls against an unchanged index, so this ordering claim holds
 * in practice, not just by construction.)
 *
 * `adjacency` is built once per `getCodeMap` fetch by the caller (review
 * round, patch — see `handleGetCodeMapRequest`) and passed in rather than
 * rebuilt per Node.
 *
 * Story 2.1 (Phase 2): `coverage` is likewise loaded once per fetch by the
 * caller and passed in rather than re-read per Node. A `'test-coverage-gap'`
 * signal (distinct from `SummaryStatus`'s unrelated `'coverage-gap'`) is
 * pushed only when `coverage !== undefined` (the LCOV file existed and
 * parsed) `&&` `hasCoverageGap` finds zero covered lines in this Node's
 * range — omitted entirely otherwise, same omission-means-absent convention
 * as the other optional signals above, never a placeholder/zero entry.
 *
 * Story 2.2 (Phase 2): reads `getNodeRecord(node.id)?.llmJudgment` — the
 * Node record store's persisted state, not anything recomputed live — and
 * pushes one `LlmJudgmentRiskSignal` when present (FR8). Unlike the four
 * deterministic signals above, this one is NOT recomputed/reproducible by
 * construction (Epic 2 Context: reproducibility is a deterministic-signal
 * requirement only) — it reflects whatever `generateJudgments` has
 * persisted so far, which can differ fetch-to-fetch while generation is
 * still catching up on a large project. Return type widens from
 * `DeterministicRiskSignal[]` to the full `RiskSignal[]` union to
 * accommodate it.
 */
export function buildRiskSignals(
  node: CodeMapNodeWithSignalSources,
  adjacency: BidirectionalAdjacency,
  coverage: LcovCoverage | undefined,
  getRecord: (id: string) => NodeRecord | undefined = getNodeRecord,
): RiskSignal[] {
  const location = { file: node.file, startLine: node.startLine, endLine: node.endLine };
  const signals: RiskSignal[] = [];

  if (node.complexity !== undefined) {
    signals.push({ family: 'deterministic', type: 'complexity', value: node.complexity, location });
  }
  if (node.cognitiveComplexity !== undefined) {
    signals.push({
      family: 'deterministic',
      type: 'cognitive-complexity',
      value: node.cognitiveComplexity,
      location,
    });
  }
  if (node.hotspotChangeCount !== undefined) {
    signals.push({ family: 'deterministic', type: 'hotspot', value: node.hotspotChangeCount, location });
  }
  signals.push({
    family: 'deterministic',
    type: 'blast-radius',
    value: computeBlastRadiusFromAdjacency(adjacency, node.id),
    location,
  });
  if (coverage !== undefined && hasCoverageGap(coverage, node.file, node.startLine, node.endLine)) {
    signals.push({ family: 'deterministic', type: 'test-coverage-gap', value: 1, location });
  }

  // Story 2.2 (Phase 2) / Story 2.3 (Phase 4): the record-backed tail —
  // persisted LLM judgment, then ingested PR-bot findings, unchanged. P0-4:
  // extracted into `recordBackedSignals` below so `lookup_node`'s live
  // derivation (`live-node.ts`) rebuilds these through this exact same code
  // (FR15 parity), never a second copy.
  signals.push(...recordBackedSignals(getRecord(node.id), location));

  return signals;
}

/**
 * The record-backed tail of a Node's `riskSignals`, in `buildRiskSignals`'s
 * order: the persisted LLM judgment (FR8) first, then every ingested PR-bot
 * finding (FR9) as persisted, unchanged. A family with nothing persisted
 * contributes nothing — absent, never an empty placeholder. Shared by
 * `buildRiskSignals` (the fetch path) and `live-node.ts`'s `deriveLiveNode`
 * (`lookup_node`), so the two can never assemble these differently.
 */
export function recordBackedSignals(record: NodeRecord | undefined, location: RiskSignalLocation): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const judgment = record?.llmJudgment;
  if (judgment !== undefined) {
    signals.push({ family: 'llm-judgment', judgment: judgment.text, location });
  }
  const ingested = record?.ingestedFindings;
  if (ingested) {
    signals.push(...ingested);
  }
  return signals;
}
