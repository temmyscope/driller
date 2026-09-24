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
import type {
  CodeMapNode,
  DeterministicRiskSeverity,
  DeterministicRiskSignal,
  RiskSignal,
  RiskSignalLocation,
} from '@driller/ipc-contracts';
import { hasCoverageGap, type LcovCoverage } from './lcov';
import type { CodeMapNodeWithSignalSources } from './mcp-client';
import { getNodeRecord, type NodeRecord } from './node-record-store';

/**
 * P1-1: default severity thresholds — the one place they live. Defaults,
 * meant to be retuned with dogfooding data.
 */
/** McCabe's "complex" band starts at 21. */
export const SEVERE_COMPLEXITY_MIN = 21;
/** SonarQube's default cognitive-complexity threshold per function. */
export const SEVERE_COGNITIVE_COMPLEXITY_MIN = 15;
/**
 * `blast-radius` and `hotspot` are severe when in the project's top 10% of
 * that signal's values (ties at the cut inclusive) AND at least their own
 * floor — the floor keeps a tiny repo from going red on trivial values.
 * The two floors share a value today (the spec's default) but are separate
 * so each can be retuned on its own.
 */
export const SEVERE_PERCENTILE_TOP_FRACTION = 0.1;
export const BLAST_RADIUS_SEVERE_FLOOR = 10;
export const HOTSPOT_SEVERE_FLOOR = 10;

/** A deterministic signal as `buildRiskSignals` builds it: not yet rated. */
export type UnratedDeterministicRiskSignal = Omit<DeterministicRiskSignal, 'severity'>;
/** `buildRiskSignals`' output: `RiskSignal` with deterministic entries still unrated. */
export type UnratedRiskSignal = Exclude<RiskSignal, DeterministicRiskSignal> | UnratedDeterministicRiskSignal;

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
 *
 * P1-1: deterministic entries come out unrated (no `severity`) — severity
 * for `blast-radius`/`hotspot` depends on the whole project, so the caller
 * runs `assignDeterministicSeverities` over every Node's output afterwards.
 */
export function buildRiskSignals(
  node: CodeMapNodeWithSignalSources,
  adjacency: BidirectionalAdjacency,
  coverage: LcovCoverage | undefined,
  getRecord: (id: string) => NodeRecord | undefined = getNodeRecord,
): UnratedRiskSignal[] {
  const location = { file: node.file, startLine: node.startLine, endLine: node.endLine };
  const signals: UnratedRiskSignal[] = [];

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

/**
 * P1-1: the smallest value in the top `SEVERE_PERCENTILE_TOP_FRACTION` of
 * `values` (at least one entry is always in the top slice). Every value
 * equal to the cut is in, so tied Nodes always share a severity; sorting
 * numbers makes the result independent of input order (FR-7). Non-finite
 * values (`NaN`, `±Infinity`) are ignored — `NaN` would make the sort
 * order-dependent and an infinity would swallow the cut. `undefined` when
 * no finite value remains.
 */
function percentileCut(values: readonly number[]): number | undefined {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => b - a);
  if (sorted.length === 0) {
    return undefined;
  }
  const topCount = Math.max(1, Math.ceil(sorted.length * SEVERE_PERCENTILE_TOP_FRACTION));
  return sorted[topCount - 1];
}

/** P1-1: the project-wide percentile cuts `classifyDeterministicSeverity` reads. */
export interface PercentileCuts {
  blastRadius: number | undefined;
  hotspot: number | undefined;
}

function isSevereByPercentile(value: number, cut: number | undefined, floor: number): boolean {
  return cut !== undefined && value >= cut && value >= floor;
}

/**
 * P1-1: rates one deterministic signal. Exhaustive over
 * `DeterministicRiskSignalType`: a new type fails typecheck here until
 * someone decides its threshold, rather than silently rating moderate.
 */
export function classifyDeterministicSeverity(
  signal: Pick<DeterministicRiskSignal, 'type' | 'value'>,
  cuts: PercentileCuts,
): DeterministicRiskSeverity {
  const type = signal.type;
  switch (type) {
    case 'complexity':
      return signal.value >= SEVERE_COMPLEXITY_MIN ? 'severe' : 'moderate';
    case 'cognitive-complexity':
      return signal.value >= SEVERE_COGNITIVE_COMPLEXITY_MIN ? 'severe' : 'moderate';
    case 'blast-radius':
      return isSevereByPercentile(signal.value, cuts.blastRadius, BLAST_RADIUS_SEVERE_FLOOR) ? 'severe' : 'moderate';
    case 'hotspot':
      return isSevereByPercentile(signal.value, cuts.hotspot, HOTSPOT_SEVERE_FLOOR) ? 'severe' : 'moderate';
    case 'test-coverage-gap':
      return 'moderate';
    default: {
      const unhandled: never = type;
      throw new Error(`classifyDeterministicSeverity: unhandled deterministic signal type ${String(unhandled)}`);
    }
  }
}

/**
 * P1-1: the project-wide cuts. Blast radius is per Node, so its population
 * is one value per `blast-radius` signal. Hotspot is per FILE —
 * `mcp-client.ts`'s `fetchCodeMap` joins `File.change_count` onto every Node
 * by `node.file` — so its population is one value per distinct
 * `location.file`; counting it per Node would let one heavily churned,
 * many-Node file fill the whole top 10% by itself. Should a file ever carry
 * two different finite values, the larger is taken (order-independent).
 */
function computePercentileCuts(nodesSignals: readonly (readonly UnratedRiskSignal[])[]): PercentileCuts {
  const blastRadiusValues: number[] = [];
  const hotspotByFile = new Map<string, number>();
  for (const signals of nodesSignals) {
    for (const signal of signals) {
      if (signal.family !== 'deterministic') {
        continue;
      }
      if (signal.type === 'blast-radius') {
        blastRadiusValues.push(signal.value);
      } else if (signal.type === 'hotspot' && Number.isFinite(signal.value)) {
        // Non-finite values are skipped here (as `percentileCut` would) so
        // `Math.max` can never see a `NaN` and make the per-file pick
        // order-dependent.
        const previous = hotspotByFile.get(signal.location.file);
        hotspotByFile.set(signal.location.file, previous === undefined ? signal.value : Math.max(previous, signal.value));
      }
    }
  }
  return { blastRadius: percentileCut(blastRadiusValues), hotspot: percentileCut([...hotspotByFile.values()]) };
}

/**
 * P1-1: the project pass. Takes every Node's `buildRiskSignals` output
 * (outer array = Nodes, in any order) and returns the same shape, each
 * deterministic signal stamped with its `severity`; every other signal is
 * passed through as-is. Pure and deterministic: the percentile cuts come
 * from sorted finite values, so reordering the Nodes (or their signals)
 * never changes any signal's severity. The cut is computed per population
 * (see `computePercentileCuts`) and then applied to every Node's own value,
 * so every Node in a severe hotspot file is severe.
 */
export function assignDeterministicSeverities(nodesSignals: readonly (readonly UnratedRiskSignal[])[]): RiskSignal[][] {
  const cuts = computePercentileCuts(nodesSignals);
  return nodesSignals.map((signals) =>
    signals.map((signal): RiskSignal =>
      signal.family === 'deterministic' ? { ...signal, severity: classifyDeterministicSeverity(signal, cuts) } : signal,
    ),
  );
}

/**
 * P1-1: the Code Map fetch path's whole risk-signal step, pure and
 * importable so it can be tested: build every Node's signals from its raw
 * `sources` entry, rate them across the WHOLE project in one pass, then zip
 * them back onto `annotatedNodes` by index. `annotatedNodes` and `sources`
 * are parallel (both `.map()`s off the same fetched Nodes, 1:1 in order);
 * a length or id mismatch throws rather than attaching one Node's signals
 * to another.
 *
 * `annotatedNodes` is runtime-shaped `CodeMapNodeWithSignalSources` (the
 * annotation spread keeps the raw complexity/cognitiveComplexity/
 * hotspotChangeCount fields even though its declared type drops them), so
 * those are destructured out here and never leak onto the wire alongside
 * the `riskSignals` that now represent them.
 */
export function attachProjectRiskSignals(
  annotatedNodes: readonly CodeMapNode[],
  sources: readonly CodeMapNodeWithSignalSources[],
  adjacency: BidirectionalAdjacency,
  coverage: LcovCoverage | undefined,
  getRecord: (id: string) => NodeRecord | undefined = getNodeRecord,
): CodeMapNode[] {
  if (annotatedNodes.length !== sources.length) {
    throw new Error(
      `attachProjectRiskSignals: ${annotatedNodes.length} annotated Nodes but ${sources.length} signal sources`,
    );
  }
  const rated = assignDeterministicSeverities(
    sources.map((source) => buildRiskSignals(source, adjacency, coverage, getRecord)),
  );
  return annotatedNodes.map((node, i) => {
    const source = sources[i]!;
    if (source.id !== node.id) {
      throw new Error(`attachProjectRiskSignals: Node ${i} is ${node.id} but its signal source is ${source.id}`);
    }
    const {
      complexity: _complexity,
      cognitiveComplexity: _cognitiveComplexity,
      hotspotChangeCount: _hotspotChangeCount,
      ...cleanNode
    } = node as CodeMapNodeWithSignalSources;
    return { ...cleanNode, riskSignals: rated[i]! };
  });
}
