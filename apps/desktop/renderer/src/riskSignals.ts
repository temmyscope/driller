/**
 * The Code Map's risk-signal taxonomy: the glyph and label for each
 * deterministic signal type, the severe marker, and the selectors that split
 * a Node's `riskSignals` into its three families.
 *
 * Extracted from `CodeMap.tsx` because three surfaces read it — the canvas
 * card's signal strip, Health Audit's heat counting, and PR Review's metrics
 * cells — so leaving it in the component module made every one of those
 * regions import a value back from `CodeMap.tsx`, turning each later
 * extraction into a genuine value cycle. Here it is a leaf, and they can all
 * depend on it one-way.
 *
 * Pure: no JSX, no hooks, and nothing imported but `@driller/ipc-contracts`.
 * `CodeMap.tsx` re-exports what it already exported, so the four test files
 * reading these from `./CodeMap` are untouched.
 *
 * The Accessibility Floor lives here too: the five glyphs are distinguished
 * by shape, never colour alone, and `SEVERE_SIGNAL_GLYPH` must differ from
 * every one of them — `CodeMap.signals.test.ts` and `ActionableNotice.test.ts`
 * both assert that, across the whole app's glyph set.
 */
import { BLAST_RADIUS_DEFAULT_HOPS } from '@driller/ipc-contracts';

import { formatCount, formatCountNumber } from './format';
import type {
  DeterministicRiskSignal,
  DeterministicRiskSignalType,
  IngestedRiskSignal,
  LlmJudgmentRiskSignal,
  RiskSignal,
} from '@driller/ipc-contracts';


/**
 * Story 2.1 (Phase 3): one distinct shape glyph per `DeterministicRiskSignalType`
 * — Accessibility Floor requires shape distinction, never color alone. The
 * five values are geometrically distinct on sight (●/■/▲/◆/⊘) so Story
 * 2.2/2.3's own future families can pick their own equally-distinct shapes
 * without colliding with these (Design Notes). Rendered `aria-hidden` inside
 * each chip — the chip's own `aria-label` carries the accessible name, not
 * this glyph.
 */
export const DETERMINISTIC_SIGNAL_ICONS: Record<DeterministicRiskSignalType, string> = {
  complexity: '●',
  'cognitive-complexity': '■',
  hotspot: '▲',
  'blast-radius': '◆',
  'test-coverage-gap': '⊘',
};

/**
 * The full, never-truncated signal name for each chip's `aria-label` (e.g.
 * `"Complexity: 4"`) — the visible chip itself only ever shows icon+number
 * (Design Notes: mirrors `.code-map__node-affordance`'s own existing
 * "glyph+abbreviated-text, full meaning in `aria-label`" convention).
 */
const DETERMINISTIC_SIGNAL_LABELS: Record<DeterministicRiskSignalType, string> = {
  complexity: 'Complexity',
  'cognitive-complexity': 'Cognitive complexity',
  hotspot: 'Hotspot',
  'blast-radius': 'Blast radius',
  'test-coverage-gap': 'Test coverage gap',
};

/**
 * P0-5: the full accessible name / tooltip for one deterministic chip —
 * `"Complexity: 4"` for most signals. Blast Radius spells out its bound and
 * what it counts (`"Blast radius: 4 Nodes within 2 hops (callers and
 * callees)"`, built from `BLAST_RADIUS_DEFAULT_HOPS`) so the number never
 * reads as total impact. An unknown `type` (a future backend's value this
 * renderer's union doesn't know) falls back to the raw type string.
 * Every chip surface (canvas card, Health Audit row) goes through this, so
 * the wording can't fork.
 */
export function formatDeterministicSignalLabel(
  signal: Pick<DeterministicRiskSignal, 'type' | 'value' | 'severity'>,
): string {
  const label = DETERMINISTIC_SIGNAL_LABELS[signal.type] ?? signal.type;
  const severe = signal.severity === 'severe' ? ' (severe)' : '';
  if (signal.type === 'blast-radius') {
    const hops: number = BLAST_RADIUS_DEFAULT_HOPS;
    return `${label}: ${formatCount(signal.value, 'Node', 'Nodes')} within ${hops} hop${hops === 1 ? '' : 's'} (callers and callees)${severe}`;
  }
  return `${label}: ${formatCountNumber(signal.value)}${severe}`;
}

/**
 * P1-1: the glyph a severe deterministic chip adds before its type icon —
 * red is never the only cue (Accessibility Floor), so a severe chip also
 * carries this and "(severe)" in its label. Moderate chips get neither.
 * Must differ from every `DETERMINISTIC_SIGNAL_ICONS` value (`▲` was
 * rejected in review because it is hotspot's own icon); a test pins that.
 */
export const SEVERE_SIGNAL_GLYPH = '!';

/**
 * Story 2.3 (Phase 4): severity ordering for the ingested-findings callout
 * — `blocker` > `major` > `minor` > `info` (Boundaries & Constraints,
 * lower rank number sorts first). `Array.prototype.sort` is stable per spec
 * (ES2019+), so sorting `node.riskSignals`' own filtered-in-order entries by
 * this rank alone already satisfies "ties by array order" — no secondary
 * comparator/index tracking needed.
 */
export const INGESTED_SEVERITY_RANK: Record<IngestedRiskSignal['severity'], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/**
 * Cap on rendered ingested findings per Node (Boundaries & Constraints: "A
 * Node with more than 3 findings shows the 3 highest-severity ones ... plus
 * a '+N more' line — never renders every finding unbounded"). Ingested
 * findings are genuinely unbounded in count/length (Design Notes), unlike
 * the fixed five-member deterministic family above — this is this phase's
 * own resolution of UX-DR27's "never a wall of inline comments" warning.
 */
export const MAX_RENDERED_INGESTED_FINDINGS = 3;

/**
 * The three independent, map-level family toggles (`showDeterministicSignals`
 * / `showLlmJudgment` / `showIngestedFindings`) every risk-signal surface
 * honors, passed as one object so a second surface can't silently honor a
 * subset of them.
 */
export type RiskSignalFamilyToggles = {
  showDeterministicSignals: boolean;
  showLlmJudgment: boolean;
  showIngestedFindings: boolean;
};

/**
 * P0-1 (2026-09-24): the deterministic-family selection, lifted verbatim out
 * of `CodeMapNodeCard` so both the card and the Node Detail panel run the
 * identical filter rather than forking it.
 *
 * Filtered, not assumed — `RiskSignal` is a real discriminated union
 * (`llm-judgment`/`ingested` are sibling shapes with no `type`/`value`), and
 * the chip loop below must never render a non-deterministic signal through
 * this one unfiltered. Written as an explicit type predicate so the result is
 * actually typed `DeterministicRiskSignal[]`, not still the wider union.
 * A repeat `type` is dropped defensively: the "at most one signal per
 * `DeterministicRiskSignalType`" invariant lives in a different module
 * (`graph-service/index.ts`'s `buildRiskSignals`) this file can't see, and a
 * future bug there would otherwise produce colliding React keys here. The
 * `Set` is typed against `DeterministicRiskSignalType` specifically so a
 * typo/drift against that union fails at compile time.
 */
export function selectDeterministicSignals(signals: RiskSignal[]): DeterministicRiskSignal[] {
  const seen = new Set<DeterministicRiskSignalType>();
  return signals.filter((signal): signal is DeterministicRiskSignal => {
    if (signal.family !== 'deterministic' || seen.has(signal.type)) {
      return false;
    }
    seen.add(signal.type);
    return true;
  });
}

/**
 * At most one `'llm-judgment'` signal per Node by construction
 * (`buildRiskSignals`/the judgment generator never emit more than one), so
 * `find` (not `filter`) is enough — and unlike the deterministic family
 * there's no `type` discriminant to de-duplicate by. `undefined` when the
 * Node carries none: the callout is gated on this being defined, never an
 * empty/placeholder callout.
 */
export function selectLlmJudgmentSignal(signals: RiskSignal[]): LlmJudgmentRiskSignal | undefined {
  return signals.find((signal): signal is LlmJudgmentRiskSignal => signal.family === 'llm-judgment');
}

/**
 * The ingested-PR-bot family — genuinely multi-valued per Node (multiple bots
 * can legitimately coexist on one Node), so no de-duplication: two distinct
 * findings from the same tool at the same location are both real. Sorted by
 * severity (`blocker` > `major` > `minor` > `info`, ties by array order via
 * `Array.prototype.sort`'s own stability guarantee) BEFORE any capping, so
 * the findings actually rendered are always the highest-severity ones.
 */
export function selectIngestedSignals(signals: RiskSignal[]): IngestedRiskSignal[] {
  return signals
    .filter((signal): signal is IngestedRiskSignal => signal.family === 'ingested')
    .sort((a, b) => INGESTED_SEVERITY_RANK[a.severity] - INGESTED_SEVERITY_RANK[b.severity]);
}

/**
 * Whether `<NodeRiskSignalSections>` would render anything at all for these
 * signals under these toggles — the same three gates the component itself
 * applies, answered without rendering, so a caller that wraps it in a
 * labelled section (the Node Detail panel) can omit that wrapper entirely
 * rather than emitting an empty container (I/O matrix: "signals section
 * absent entirely, not an empty container").
 */
export function hasVisibleRiskSignals(signals: RiskSignal[], toggles: RiskSignalFamilyToggles): boolean {
  if (toggles.showDeterministicSignals && selectDeterministicSignals(signals).length > 0) {
    return true;
  }
  if (toggles.showLlmJudgment) {
    const judgment = selectLlmJudgmentSignal(signals);
    if (judgment !== undefined && judgment.judgment.trim().length > 0) {
      return true;
    }
  }
  return toggles.showIngestedFindings && selectIngestedSignals(signals).length > 0;
}
