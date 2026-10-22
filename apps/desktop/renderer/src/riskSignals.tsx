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
 * six values are geometrically distinct on sight (●/■/▲/◆/⊘/⇄) so Story
 * 2.2/2.3's own future families can pick their own equally-distinct shapes
 * without colliding with these (Design Notes). `⇄` reads as the two-way
 * movement co-change describes, and shares no stroke with the other five or
 * with `SEVERE_SIGNAL_GLYPH`. Rendered `aria-hidden` inside
 * each chip — the chip's own `aria-label` carries the accessible name, not
 * this glyph.
 */
export const DETERMINISTIC_SIGNAL_ICONS: Record<DeterministicRiskSignalType, string> = {
  complexity: '●',
  'cognitive-complexity': '■',
  hotspot: '▲',
  'blast-radius': '◆',
  'test-coverage-gap': '⊘',
  'co-change': '⇄',
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
  // Says what the number counts, so the chip cannot read as a score.
  'co-change': 'Changes with',
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

/**
 * P0-1 (2026-09-24): every risk-signal section a Node can show, in one
 * shared renderer.
 *
 * Lifted verbatim out of `CodeMapNodeCard` (which now calls it) so the Node
 * Detail panel renders the *same* glyphs, labels, chips, callout and list
 * rather than a second, drifting copy — the spec's "extracted and shared,
 * never forked". Both surfaces therefore also honor the same three
 * map-level family toggles by construction.
 *
 * Renders `null` when nothing is visible, so neither surface ever produces
 * an empty row/container.
 *
 * Exported only so `CodeMap.blastRadius.test.ts` can render the canvas chip
 * strip directly (P0-5). That test calls this as a plain function, so it must
 * stay HOOKLESS — same pact as `HealthAuditClusterRow`.
 */
export function NodeRiskSignalSections({
  signals,
  toggles,
}: {
  signals: RiskSignal[];
  toggles: RiskSignalFamilyToggles;
}) {
  const deterministicSignals = selectDeterministicSignals(signals);
  const llmJudgmentSignal = selectLlmJudgmentSignal(signals);
  const ingestedSignals = selectIngestedSignals(signals);
  const visibleIngestedSignals = ingestedSignals.slice(0, MAX_RENDERED_INGESTED_FINDINGS);
  const hiddenIngestedSignalCount = ingestedSignals.length - visibleIngestedSignals.length;

  if (!hasVisibleRiskSignals(signals, toggles)) {
    return null;
  }

  return (
    <>
      {/* Story 2.1 (Phase 3): the deterministic risk-signal strip — one chip
          per `riskSignals` entry with `family === 'deterministic'`, gated on
          the map-level toggle AND on actually having at least one such
          signal (Boundaries & Constraints: "A Node with `riskSignals: []`
          ... renders no signal strip at all — never an empty row"). Each
          chip: `role="img"` — `aria-label` alone on a bare, non-interactive
          `<span>` (implicit role `generic`) is not reliably exposed to
          assistive technology; `role="img"` is the standard fix for a static
          icon+label combination. `title` gives sighted mouse users — who
          never see `aria-label` — the same glyph -> meaning mapping via the
          native hover tooltip. An unrecognized `signal.type` (e.g. a runtime
          value from a future backend build that doesn't match this
          renderer's still-five-member union) falls back to `'?'`/the raw
          type string rather than rendering a literal "undefined". */}
      {toggles.showDeterministicSignals && deterministicSignals.length > 0 && (
        <div className="code-map__node-signal-strip">
          {deterministicSignals.map((signal) => {
            const label = formatDeterministicSignalLabel(signal);
            const icon = DETERMINISTIC_SIGNAL_ICONS[signal.type] ?? '?';
            return (
              <span
                key={signal.type}
                className={
                  signal.severity === 'severe'
                    ? 'code-map__signal-chip code-map__signal-chip--severe'
                    : 'code-map__signal-chip'
                }
                role="img"
                aria-label={label}
                title={label}
              >
                {signal.severity === 'severe' && <span aria-hidden="true">{SEVERE_SIGNAL_GLYPH}</span>}
                <span aria-hidden="true">{icon}</span>
                {formatCountNumber(signal.value)}
              </span>
            );
          })}
        </div>
      )}
      {/* Story 2.2 (Phase 3): the LLM-judgment risk-signal callout — rendered
          after the deterministic strip above, gated on its own independent
          toggle AND on the Node actually carrying an `'llm-judgment'` signal
          (never an empty/placeholder callout). Deliberately never
          `.code-map__signal-chip`'s classes — dashed border, icon+full
          sentence, not a solid-border pill (FR8/UX-DR7: "no shared visual
          language between the two families"). The visible copy leads with
          "AI judgment:" so it reads as an inference, never with a
          deterministic signal's unqualified-measurement confidence. The
          blank/whitespace-only guard closes the gap between "never an
          empty/placeholder callout" and what the JSX actually checked. */}
      {toggles.showLlmJudgment && llmJudgmentSignal !== undefined && llmJudgmentSignal.judgment.trim().length > 0 && (
        <p className="code-map__llm-judgment" title={`AI judgment: ${llmJudgmentSignal.judgment}`}>
          <span aria-hidden="true">✦</span> AI judgment: {llmJudgmentSignal.judgment}
        </p>
      )}
      {/* Story 2.3 (Phase 4): the ingested-PR-bot-findings callout — its own
          distinct visual treatment (Boundaries & Constraints: "never
          `.code-map__signal-chip`'s classes, never llm-judgment's callout
          classes"), gated on its own independent toggle AND on the Node
          actually carrying at least one `'ingested'` signal. Each finding is
          its own row, always naming its severity as real visible text —
          never color/icon alone (Accessibility Floor) — plus the originating
          tool and finding text (FR9, AD-12). Rows are capped at
          `MAX_RENDERED_INGESTED_FINDINGS` plus an explicit "+N more" line
          when more exist — never an unbounded wall of inline comments
          (UX-DR27). `key={index}` (review-pattern precedent: `toFlowEdges`
          keys on index too) since a raw ingested finding carries no
          identifier of its own to key by. */}
      {toggles.showIngestedFindings && ingestedSignals.length > 0 && (
        <ul className="code-map__ingested-findings">
          {visibleIngestedSignals.map((signal, index) => (
            <li
              key={index}
              className="code-map__ingested-finding"
              title={`${signal.sourceTool} (${signal.severity}): ${signal.finding}`}
            >
              <span aria-hidden="true">⚑</span>
              <span className="code-map__ingested-finding-severity">{signal.severity}</span>
              <span className="code-map__ingested-finding-tool">{signal.sourceTool}:</span>
              <span className="code-map__ingested-finding-text">{signal.finding}</span>
            </li>
          ))}
          {hiddenIngestedSignalCount > 0 && (
            <li className="code-map__ingested-findings-more">+{hiddenIngestedSignalCount} more</li>
          )}
        </ul>
      )}
    </>
  );
}

/**
 * P2-12: how many of a Node's risk signals the map-level overlay toggles are
 * hiding — the signals in a family whose toggle is off (a blank LLM judgment,
 * which never renders anyway, is not counted). Lets the Risk Overlay section
 * tell "nothing to show" apart from "hidden by the toggles".
 */
export function countToggleHiddenSignals(signals: RiskSignal[], toggles: RiskSignalFamilyToggles): number {
  let hidden = 0;
  if (!toggles.showDeterministicSignals) {
    hidden += selectDeterministicSignals(signals).length;
  }
  if (!toggles.showLlmJudgment) {
    const judgment = selectLlmJudgmentSignal(signals);
    if (judgment !== undefined && judgment.judgment.trim().length > 0) {
      hidden += 1;
    }
  }
  if (!toggles.showIngestedFindings) {
    hidden += selectIngestedSignals(signals).length;
  }
  return hidden;
}
