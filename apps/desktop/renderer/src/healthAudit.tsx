/**
 * Health Audit Mode's own surface: the signal-count banding, the directory
 * grouping, and the cluster-card grid it renders.
 *
 * Health Audit renders no canvas at all (AD-2, corrected by P0-2b) — it
 * groups Nodes into cards by their containing directory, each card heat-banded
 * by the highest signal count on any single Node it holds. Three rules this
 * module exists to keep in one place, each of which the docs record as a
 * correction of something earlier that could not be produced honestly:
 *
 * - Heat comes from a signal COUNT, never a severity, and a card takes the
 *   band of its worst single Node, never the sum — so one bad Node makes a
 *   module hot rather than a large directory doing so by volume.
 * - A heat label always states the count beside the band ("hot · 7 signals"),
 *   never a bare adjective, and says what the number is.
 * - A Node's row shows its real signal values, never a percentage and never a
 *   severity rank, because no risk signal carries either.
 *
 * `HealthAuditClusterRow` and `HealthAuditClusterGrid` are deliberately
 * HOOKLESS: their tests call them as plain functions, which is the same pact
 * `NodeRiskSignalSections` keeps.
 *
 * `HEALTH_ROW_AFFORDANCE` lives here and is read by PR Review's metrics rows
 * too. That is intentional, not a leak: both surfaces are activatable rows
 * that open Node detail, and sharing the phrase is how they stay worded alike.
 */
import type {
  CodeMapNode,
  DeterministicRiskSignal,
  LlmJudgmentRiskSignal,
  RiskSignal,
} from '@driller/ipc-contracts';

import { formatCandidateLocation, formatCount, formatCountNumber } from './format';
import {
  DETERMINISTIC_SIGNAL_ICONS,
  formatDeterministicSignalLabel,
  selectDeterministicSignals,
  selectLlmJudgmentSignal,
  SEVERE_SIGNAL_GLYPH,
} from './riskSignals';

/**
 * Story 4.1's signal-count bucket (Design Notes: "no normalized severity
 * score exists across signal types ... a simple signal-count bucket, not a
 * cross-type weighted score"): `0` → no tint, `1-2` → light, `3-5` →
 * medium, `6+` → strong. Returns `null` for `0` so the caller can render no
 * modifier class/tint at all rather than a zero-opacity one.
 */
function riskCountBucket(riskCount: number): 'low' | 'medium' | 'high' | null {
  if (riskCount <= 0) {
    return null;
  }
  if (riskCount <= 2) {
    return 'low';
  }
  if (riskCount <= 5) {
    return 'medium';
  }
  return 'high';
}

/**
 * P0-2a: the Node's LLM judgment if — and only if — it is one that actually
 * counts and renders. `selectLlmJudgmentSignal` finds the judgment;
 * this adds the blank-text gate, because a whitespace-only judgment renders
 * nothing and so must not be counted either (the gap Story 4.1's review
 * round had to close once already).
 *
 * One definition, deliberately: `riskCountForNode` and
 * `groupNodesIntoHealthClusters`' `llmJudgment` field both call it, so a
 * Node can never be counted as carrying a judgment while the field that is
 * supposed to show it is absent, or vice versa.
 */
function selectCountedLlmJudgment(signals: RiskSignal[]): LlmJudgmentRiskSignal | undefined {
  const judgment = selectLlmJudgmentSignal(signals);
  return judgment !== undefined && judgment.judgment.trim().length > 0 ? judgment : undefined;
}

/**
 * P0-2a: the per-Node risk-signal count Health Audit Mode ranks by —
 * deterministic signals (de-duplicated per `DeterministicRiskSignalType` by
 * `selectDeterministicSignals`) plus one for a judgment that passes
 * `selectCountedLlmJudgment`. `family: 'ingested'` is excluded: that is
 * Epic 3's PR-bot-findings concept, not part of Epic 2's Risk Overlay.
 *
 * P0-2b: `groupNodesIntoHealthClusters` is now the only caller. The Code
 * Map's LOD cluster tint used to be the second one, aggregating these same
 * per-Node counts into `clusterRiskCounts`; that tint is gone (it could only
 * ever appear below `LOD_ZOOM_THRESHOLD`, and Health Audit Mode no longer
 * renders a canvas at all), so there is nothing left for this count to drift
 * against.
 */
export function riskCountForNode(node: CodeMapNode): number {
  const judgmentCount = selectCountedLlmJudgment(node.riskSignals) !== undefined ? 1 : 0;
  return selectDeterministicSignals(node.riskSignals).length + judgmentCount;
}

/**
 * P0-2a: a cluster's heat band. One-to-one with `riskCountBucket`'s own
 * four outcomes — `null` → `'healthy'`, `'low'` → `'cool'`, `'medium'` →
 * `'warm'`, `'high'` → `'hot'` — so the banding itself is reused verbatim
 * and nothing new is thresholded. The rename is only so a caller never has
 * to render `null` as a band: a clean repo's cluster is ordinary output
 * carrying `'healthy'`, never an absent heat.
 *
 * DESIGN.md's `components.health-cluster-card` defines three heat-dot
 * colors, with `heat-dot-cool` already being `{colors.healthy}` — so
 * `'cool'` and `'healthy'` share a color there while staying distinct here,
 * and no information is lost in either direction.
 */
export type HealthClusterHeat = 'hot' | 'warm' | 'cool' | 'healthy';

const HEAT_BY_BUCKET = {
  high: 'hot',
  medium: 'warm',
  low: 'cool',
} as const satisfies Record<Exclude<ReturnType<typeof riskCountBucket>, null>, HealthClusterHeat>;

/**
 * P0-2a's banding, as a function. `groupNodesIntoHealthClusters` bands a
 * cluster's `heatCount` through this, and P0-2b's grid bands each ROW's own
 * `riskCount` through the same call — so the row's colour and the card's
 * colour can never come from two separately-maintained thresholds (Always:
 * "All grouping, ordering, capping, and heat banding come from 2a's helper —
 * no second copy"). Extracted, not re-implemented: this is verbatim the
 * expression the helper already inlined.
 */
export function heatForRiskCount(riskCount: number): HealthClusterHeat {
  const bucket = riskCountBucket(riskCount);
  return bucket === null ? 'healthy' : HEAT_BY_BUCKET[bucket];
}

/**
 * P0-2a: one Node inside a health cluster, carrying the count it was ranked
 * by and the signals behind that count — so a caller renders rows from real
 * signal values (`DETERMINISTIC_SIGNAL_LABELS`/`_ICONS` plus each signal's
 * own `value`) and never has to re-derive, or invent, a metric.
 */
export interface HealthClusterNode {
  node: CodeMapNode;
  /** `riskCountForNode(node)` — deterministic signals plus a non-blank judgment, never `ingested`. */
  riskCount: number;
  /** De-duplicated per `type`, then ordered by `type` ascending so the row order is total. */
  deterministicSignals: DeterministicRiskSignal[];
  /** Present only when the Node carries a judgment with non-whitespace text — the same gate `riskCountForNode` counts by. */
  llmJudgment?: LlmJudgmentRiskSignal;
}

/** P0-2a: one module cluster — the Nodes under a single containing directory. */
export interface HealthCluster {
  /**
   * The full containing directory, POSIX-relative (`api/internal/service`),
   * or `HEALTH_CLUSTER_ROOT_KEY` for a file that sits at the repo root.
   * Unique across the returned list, which is what makes the cluster
   * ordering below total.
   */
  directory: string;
  /** What to display. Never the bare `'.'` sentinel — see `HEALTH_CLUSTER_ROOT_LABEL`. */
  label: string;
  /** Banded from `heatCount` via `riskCountBucket`. */
  heat: HealthClusterHeat;
  /**
   * The highest per-Node `riskCount` in the cluster — never the sum, so one
   * bad Node makes a cluster hot rather than a large directory doing so by
   * volume. Carried so a caller can state the evidence next to the band
   * ("hot · 7 signals") instead of showing a bare adjective.
   *
   * The MAX is what makes a health cluster a module being ranked against
   * other modules rather than a bag whose score grows with its size. (Story
   * 4.1's LOD cluster tint banded the SUM instead, correctly for a viewport
   * artifact; P0-2b deleted it, so that divergence no longer exists.)
   */
  heatCount: number;
  /** Sum of every member Node's `riskCount`, including Nodes dropped by the cap. The secondary ordering key. */
  totalRiskCount: number;
  /** Capped at `HEALTH_CLUSTER_NODE_LIMIT`, ordered by `riskCount` desc, then `name` asc, then `id` asc. */
  nodes: HealthClusterNode[];
  /** How many member Nodes the cap left out. `0` when all of them fit. */
  remainingNodeCount: number;
}

/** P0-2a: the helper's whole return shape — a settled contract with `spec-p0-2b-health-audit-surface.md`. */
export interface HealthClusterGrouping {
  clusters: HealthCluster[];
  /** How many clusters `HEALTH_CLUSTER_LIMIT` left out. `0` when all of them fit. */
  remainingClusterCount: number;
}

/**
 * The directory key for a Node whose `file` has no `/` at all (`main.ts`).
 * A stable sentinel rather than `''`, so the root cluster can never collide
 * with, or be mistaken for, a missing key.
 */
export const HEALTH_CLUSTER_ROOT_KEY = '.';

/** What to show for `HEALTH_CLUSTER_ROOT_KEY` — the sentinel is never rendered raw. */
export const HEALTH_CLUSTER_ROOT_LABEL = '(repo root)';

/**
 * Display caps. Renderer-local presentation limits, never a Graph Service
 * concern: the full Node set is still grouped and counted, and whatever the
 * caps drop is reported as an explicit remainder rather than silently
 * vanishing (AD-13's explicit-result-state pattern applied to truncation).
 */
export const HEALTH_CLUSTER_LIMIT = 12;
export const HEALTH_CLUSTER_NODE_LIMIT = 8;

/**
 * Plain code-unit ordering, deliberately NOT `localeCompare`: that consults
 * the runtime's ICU data, so the same input could order differently on two
 * machines. Every tiebreak below has to be reproducible, not merely stable
 * within one process.
 */
function compareAscending(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * P0-2a: group `CodeMapNode[]` into Health Audit Mode's ranked module
 * clusters (UJ-2 step 3). Pure — no React, DOM, clock, or IPC — so the
 * whole thing is unit-testable and the surface spec that consumes it
 * (P0-2b) owns rendering only.
 *
 * Grouping is the containing directory and nothing else: no semantic, AI, or
 * heuristic module inference. Ranking is signal COUNT, not severity. P1-1
 * added `DeterministicRiskSignal.severity`, but deliberately left this
 * ranking and count unchanged (its Never list); severity shows only on the
 * row's chips.
 *
 * Every comparison chain ends in a key that is unique at its level
 * (`directory` for clusters, `id` for Nodes), so ordering is total and no
 * tie ever falls through to input order — running this twice over the same
 * input yields deeply equal results, array order included.
 */
export function groupNodesIntoHealthClusters(nodes: readonly CodeMapNode[]): HealthClusterGrouping {
  const byDirectory = new Map<string, HealthClusterNode[]>();

  for (const node of nodes) {
    const separator = node.file.lastIndexOf('/');
    const directory = separator > 0 ? node.file.slice(0, separator) : HEALTH_CLUSTER_ROOT_KEY;
    const judgment = selectCountedLlmJudgment(node.riskSignals);
    const members = byDirectory.get(directory);
    const member: HealthClusterNode = {
      node,
      riskCount: riskCountForNode(node),
      deterministicSignals: selectDeterministicSignals(node.riskSignals).sort((a, b) =>
        compareAscending(a.type, b.type),
      ),
      ...(judgment !== undefined ? { llmJudgment: judgment } : {}),
    };
    if (members === undefined) {
      byDirectory.set(directory, [member]);
    } else {
      members.push(member);
    }
  }

  const clusters: HealthCluster[] = [];
  for (const [directory, members] of byDirectory) {
    let heatCount = 0;
    let totalRiskCount = 0;
    for (const member of members) {
      heatCount = Math.max(heatCount, member.riskCount);
      totalRiskCount += member.riskCount;
    }
    members.sort(
      (a, b) =>
        b.riskCount - a.riskCount ||
        compareAscending(a.node.name, b.node.name) ||
        compareAscending(a.node.id, b.node.id),
    );
    clusters.push({
      directory,
      label: directory === HEALTH_CLUSTER_ROOT_KEY ? HEALTH_CLUSTER_ROOT_LABEL : directory,
      heat: heatForRiskCount(heatCount),
      heatCount,
      totalRiskCount,
      nodes: members.slice(0, HEALTH_CLUSTER_NODE_LIMIT),
      remainingNodeCount: Math.max(0, members.length - HEALTH_CLUSTER_NODE_LIMIT),
    });
  }

  clusters.sort(
    (a, b) =>
      b.heatCount - a.heatCount ||
      b.totalRiskCount - a.totalRiskCount ||
      compareAscending(a.directory, b.directory),
  );

  return {
    clusters: clusters.slice(0, HEALTH_CLUSTER_LIMIT),
    remainingClusterCount: Math.max(0, clusters.length - HEALTH_CLUSTER_LIMIT),
  };
}

/**
 * P0-2b: a cluster's heat label. Always the band AND the count it came from
 * (Always: never a bare adjective), never colour alone — this text sits beside
 * the dot and is what a screen reader reads.
 *
 * It also says WHAT the number is. `heatCount` is the highest count on any
 * SINGLE Node in the cluster, never the sum, so a bare "hot · 7 signals" on a
 * card listing eight Nodes reads as a module total it is not. When the module
 * carries more than its worst Node does, `totalRiskCount` is stated alongside
 * it; when the two are equal there is nothing to disambiguate and the clause
 * is dropped, which is also what a clean repo's "healthy · 0 signals on its
 * worst Node" reads as — ordinary output stating an explicit zero (P3-9).
 */
export function formatHealthClusterHeat(
  heat: HealthClusterHeat,
  heatCount: number,
  totalRiskCount: number,
): string {
  const worst = `${heat} · ${heatCount} signal${heatCount === 1 ? '' : 's'} on its worst Node`;
  return totalRiskCount === heatCount ? worst : `${worst}, ${formatCountNumber(totalRiskCount)} in the module`;
}

/** A Windows drive root (`C:/`) once backslashes are `/`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;

/**
 * FIX-3: a Health Audit row's location line — the Node's project-relative
 * file path (`apps/desktop/renderer/src/CodeMap.tsx`), never the qualified id
 * (whose project-name prefix, "Users-eoyawale-Desktop-…", is what the
 * 2026-09-26 live run saw) and never a machine path.
 *
 * AD-19 promises `file` is POSIX-relative, but this is defensive anyway:
 * backslashes become `/`; empty and `.` segments are dropped (a leading
 * `./`, a `/./`, a doubled `/`); an absolute POSIX or Windows path is made
 * relative when it sits under `projectPath` (compared case-insensitively, as
 * `App.tsx` compares project paths). Anything that can't become a clean
 * project-relative path — absolute outside the project or with no project
 * given, one with a `..` segment, or one that normalises to nothing — falls
 * back to `formatCandidateLocation`, the qualified-id line, so a row never
 * loses its identity or shows `''`/`/`.
 */
export function healthRowLocation(
  node: Pick<CodeMapNode, 'id' | 'name' | 'file'>,
  projectPath: string | null,
): string {
  let file = node.file.replace(/\\/g, '/');
  if (file.startsWith('/') || WINDOWS_ABSOLUTE.test(file)) {
    const root = projectPath?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
    if (root === '' || !file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
      return formatCandidateLocation(node);
    }
    file = file.slice(root.length + 1);
  }
  const segments = file.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    return formatCandidateLocation(node);
  }
  return segments.join('/');
}

/**
 * FIX-3: `Class.method`-style name for a Node — its name plus the qualified
 * id's segment just before it (`…svc.A.handle` → `A.handle`), or the bare
 * name when the id doesn't end in `.${name}`.
 */
export function qualifiedSymbolName(node: Pick<CodeMapNode, 'id' | 'name'>): string {
  const suffix = `.${node.name}`;
  if (!node.id.endsWith(suffix)) {
    return node.name;
  }
  const prefix = node.id.slice(0, -suffix.length);
  const qualifier = prefix.slice(prefix.lastIndexOf('.') + 1);
  return qualifier === '' ? node.name : `${qualifier}.${node.name}`;
}

/**
 * FIX-3: the location line for each row of one Health Audit card, in order.
 * Normally `healthRowLocation`. Rows that would still read identically —
 * same name AND same location, e.g. two classes' `handle` in one file — get
 * the qualifying symbol appended ("api/a.ts (A.handle)"), and the start line
 * as well if even that collides, so every row on a card is distinguishable.
 */
export function healthRowLocations(
  nodes: readonly Pick<CodeMapNode, 'id' | 'name' | 'file' | 'startLine'>[],
  projectPath: string | null,
): string[] {
  const base = nodes.map((node) => healthRowLocation(node, projectPath));
  const keyOf = (index: number) => `${nodes[index]!.name}\u0000${base[index]!}`;
  const rowsByKey = new Map<string, number[]>();
  nodes.forEach((_, index) => {
    const key = keyOf(index);
    rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), index]);
  });
  const locations = [...base];
  for (const rows of rowsByKey.values()) {
    if (rows.length < 2) {
      continue;
    }
    const qualified = rows.map((index) => qualifiedSymbolName(nodes[index]!));
    rows.forEach((index, position) => {
      const symbol = qualified[position]!;
      const unique = qualified.filter((other) => other === symbol).length === 1;
      locations[index] = unique
        ? `${base[index]!} (${symbol})`
        : `${base[index]!} (${symbol}, line ${nodes[index]!.startLine})`;
    });
  }
  return locations;
}

/**
 * P0-2b: the per-cluster cap's explicit remainder (AD-13's
 * explicit-result-state pattern applied to truncation) — never silent
 * truncation. Pure and exported so the pluralization is pinned by a test
 * rather than by reading the JSX.
 */
export function formatRemainingNodes(remainingNodeCount: number): string {
  return `+${formatCount(remainingNodeCount, 'more Node', 'more Nodes')}`;
}

/** P0-2b: the cluster-list cap's own remainder. See `formatRemainingNodes`. */
export function formatRemainingClusters(remainingClusterCount: number): string {
  return `+${remainingClusterCount} more module${remainingClusterCount === 1 ? '' : 's'}`;
}

/**
 * P0-2c: the row control's affordance text — the "and activating it opens
 * Node detail" half of the Node card's own `aria-label` convention, carried as
 * real (visually hidden) CONTENT rather than as an `aria-label`.
 *
 * The distinction is the whole point. An `aria-label` REPLACES an element's
 * text as its accessible name, so labelling the row button would silently
 * delete every chip's own `aria-label` from what a screen reader announces:
 * "Complexity: 21", "Blast radius: 14" and the entire AI-judgment sentence are
 * rendered for sighted users and announced nowhere. Composing the name from
 * content keeps all of it, and cannot drift from what is displayed the way a
 * hand-built label can — the row's name is, by construction, exactly what the
 * row shows plus this one phrase.
 */
export const HEALTH_ROW_AFFORDANCE = 'open Node detail';

/**
 * P0-2b: one Node's row inside a cluster card. Values are the Node's real
 * `DeterministicRiskSignal.value`s, rendered through the same
 * `DETERMINISTIC_SIGNAL_ICONS`/`DETERMINISTIC_SIGNAL_LABELS` +
 * `role="img"`/`aria-label` chip convention `NodeRiskSignalSections` already
 * uses on the canvas — glyph and number visible, full signal name in the
 * accessible name. No percentages are derived: `test-coverage-gap` is a
 * boolean flag carrying `value: 1`, so the mockup's "61% gap"/"2 hotspots"
 * figures depict data driller does not have. P1-1: a severe signal's chip
 * gets the same `!` glyph and "(severe)" label as the canvas chip, and its
 * own `code-map__health-row-signal--severe` modifier.
 *
 * The row's own band is rendered as a WORD, not only as the value colour
 * (Accessibility Floor: the `--{heat}` class is reinforcement only, and the
 * signal chips' `aria-label`s carry name and value but never the band). It is
 * banded from this Node's own `riskCount` through the same `heatForRiskCount`
 * the card bands `heatCount` with, so a row and its card can never come from
 * two sets of thresholds — and a Node carrying nothing reads "healthy", which
 * is that same word, not a separate empty-state string.
 *
 * `location` is the row's second line: a directory cluster merges every
 * file under it, so `a.ts` and `b.ts` can both contribute a `handle` and
 * would otherwise render as two identical rows. FIX-3: it is the Node's
 * project-relative file (`healthRowLocation`), not the qualified id the Path
 * Trace candidate list's `formatCandidateLocation` shows, and the grid
 * computes it per card (`healthRowLocations`) so two same-named rows from
 * one file get their qualifying symbol appended.
 *
 * P0-2c: the row is now a real control — a native `<button>` filling the
 * `<li>`, calling `onActivate` with ITS OWN `member.node` (the object, never a
 * name/id the callee would have to resolve, which is what makes two
 * same-named rows in one cluster open their own Nodes rather than the first
 * match). A native button rather than the canvas card's
 * `tabIndex`/`role="button"`/`onKeyDown` trio: that pattern exists on the card
 * because React Flow owns the card's mouse handling, which is not a constraint
 * here — and a real button gets Enter, Space, the focus stop and the AT role
 * from the platform instead of from three hand-written handlers.
 *
 * Exactly ONE control per row (Never: "no second click target per row"), so
 * unlike the Node card there is no nested pill and therefore no
 * `stopPropagation` handling to match: the signal chips stay `role="img"`
 * spans, and — because the button carries NO `aria-label` — each chip's own
 * label still reaches the accessible name (`HEALTH_ROW_AFFORDANCE`).
 *
 * The `title` is the mouse's recovery path for the two lines that ellipsise
 * (`.code-map__health-row-name` and `-location`): a long identifier under a
 * deep qualified path is otherwise unreadable at this card width with no way
 * to get it back. Same role the Node card's `title` and the cluster heading's
 * `title={cluster.directory}` already play; it sits on the button because the
 * button is what the pointer is actually over.
 *
 * MUST STAY HOOKLESS. This component and `HealthAuditClusterGrid` are invoked
 * as plain functions by `CodeMap.healthAuditRow.test.ts`, which is how the
 * handlers are reachable at all without a DOM (this repo's runner has none —
 * `docs/agent.md`). A `useMemo`/`useId` here, or a `memo()` wrapper around
 * either component, makes every one of those tests fail as a React dispatcher
 * error rather than as an assertion. Neither component needs one: both are
 * pure renderings of already-computed props.
 */
export function HealthAuditClusterRow({
  member,
  onActivate,
  location = healthRowLocation(member.node, null),
}: {
  member: HealthClusterNode;
  onActivate: (node: CodeMapNode) => void;
  /** FIX-3: this row's line from `healthRowLocations` (the grid passes it); defaults to the row's own `healthRowLocation`. */
  location?: string;
}) {
  const heat = heatForRiskCount(member.riskCount);
  const judgment = member.llmJudgment;
  return (
    <li className="code-map__health-row">
      <button
        type="button"
        className="code-map__health-row-button"
        title={`${member.node.name} · ${location}`}
        onClick={() => onActivate(member.node)}
      >
        <span className="code-map__health-row-identity">
          <span className="code-map__health-row-name">{member.node.name}</span>
          <span className="code-map__health-row-location">{location}</span>
        </span>
        <span className={`code-map__health-row-values code-map__health-row-values--${heat}`}>
          <span className="code-map__health-row-band">{heat}</span>
          {member.deterministicSignals.map((signal) => {
            const label = formatDeterministicSignalLabel(signal);
            const icon = DETERMINISTIC_SIGNAL_ICONS[signal.type] ?? '?';
            return (
              <span
                key={signal.type}
                className={
                  signal.severity === 'severe'
                    ? 'code-map__health-row-signal code-map__health-row-signal--severe'
                    : 'code-map__health-row-signal'
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
          {/* The judgment is a sentence, not a measurement — its glyph and
              accessible name follow `.code-map__llm-judgment`'s own "AI
              judgment:" lead-in so it never reads with a deterministic
              signal's unqualified-measurement confidence. */}
          {judgment !== undefined && (
            <span
              className="code-map__health-row-signal"
              role="img"
              aria-label={`AI judgment: ${judgment.judgment}`}
              title={`AI judgment: ${judgment.judgment}`}
            >
              <span aria-hidden="true">✦</span>
            </span>
          )}
        </span>
        {/* Last, so the name reads "<identifier> <location> <band> <signals…>
            open Node detail" — what the row is, then what activating it does.
            Visually hidden rather than `aria-label`d: see
            `HEALTH_ROW_AFFORDANCE`. */}
        <span className="visually-hidden">{HEALTH_ROW_AFFORDANCE}</span>
      </button>
    </li>
  );
}

/** The grid's own heading, referenced by the scroll region's `aria-labelledby`. */
export const HEALTH_GRID_HEADING_ID = 'code-map-health-grid-heading';

/**
 * P0-2b: Health Audit Mode's own surface — the cluster-card grid that renders
 * INSTEAD OF the canvas (DESIGN.md `components.health-cluster-card`,
 * EXPERIENCE.md "Health Audit cluster card", `mockups/health-audit-mode.html`).
 *
 * Every number here comes from P0-2a's `groupNodesIntoHealthClusters`: the
 * grouping, the ordering, the caps, the remainders and the heat banding. This
 * component decides nothing about risk — it is the rendering half only.
 *
 * P0-2c: rows are no longer inert. `onActivateNode` is threaded to every
 * `HealthAuditClusterRow` and is the component's ONLY behavioral prop —
 * `openNodeDetail`, the same one-click open path the Code Map's Node cards
 * take, so Health Audit gains a caller of Node detail rather than a second
 * detail surface. Nothing else about the card changed: the heat, the chips and
 * the remainder lines are P0-2b's, unaltered.
 *
 * The remainder lines ("+N more Nodes"/"+N more modules") stay plain `<p>`s
 * deliberately (I/O Matrix): they are COUNTS of Nodes the caps dropped, not
 * Nodes, so there is nothing for them to open and they must not look or behave
 * as if there were.
 *
 * Deliberately NOT rendered when there is nothing ready to group: the loading,
 * fetch-error, empty-map and PR-Review notices keep the surface entirely to
 * themselves (I/O Matrix), so a partial card frame never appears over one.
 * There is also no "Last full scan N ago" footer, unlike the mockup's: driller
 * has no scan-timestamp source, and the figure will not be faked.
 *
 * `tabIndex={0}` on the scroll container survives P0-2c and is still
 * load-bearing, for a narrower reason than the one that put it here. Row
 * buttons now give the region focusable descendants, and moving focus between
 * them scrolls the region on its own — but the remainder lines and the
 * heading are NOT focusable, so a card list whose last content below the fold
 * is "+2 more modules" would have nothing to tab to in order to bring it into
 * view. The container's own focus stop is what keeps the whole region
 * scrollable, not just the parts that happen to be controls.
 *
 * The `<h2>` gives the cards' `<h3>`s a parent in the heading outline instead
 * of starting it at level 3, and names the region. Its id is a module-scope
 * constant rather than a `useId`, which is also what keeps this component
 * hookless — see `HealthAuditClusterRow`'s own MUST STAY HOOKLESS note, which
 * applies to this component identically.
 */
export function HealthAuditClusterGrid({
  grouping,
  onActivateNode,
  projectPath = null,
}: {
  grouping: HealthClusterGrouping;
  onActivateNode: (node: CodeMapNode) => void;
  /** FIX-3: the open project's root, so `healthRowLocations` can make an absolute `file` project-relative. */
  projectPath?: string | null;
}) {
  return (
    <section
      className="code-map__health-grid"
      aria-labelledby={HEALTH_GRID_HEADING_ID}
      tabIndex={0}
    >
      <h2 className="code-map__health-heading" id={HEALTH_GRID_HEADING_ID}>
        Risk signals clustered by module
      </h2>
      <ol className="code-map__health-cards">
        {grouping.clusters.map((cluster) => {
          const locations = healthRowLocations(
            cluster.nodes.map((member) => member.node),
            projectPath,
          );
          return (
          <li key={cluster.directory} className="code-map__health-card">
            <h3 className="code-map__health-card-heading" title={cluster.directory}>
              <span
                className={`code-map__health-dot code-map__health-dot--${cluster.heat}`}
                aria-hidden="true"
              />
              <span className="code-map__health-card-label">{cluster.label}</span>
            </h3>
            <p className="code-map__health-card-heat">
              {formatHealthClusterHeat(cluster.heat, cluster.heatCount, cluster.totalRiskCount)}
            </p>
            <ul className="code-map__health-rows">
              {/* P0-2c: the key carries the member's POSITION as well as its
                  Node id. A Node id is a fully-qualified name, which is
                  unique in practice but is not guaranteed unique by anything
                  in `graph-contracts` — and two Nodes sharing one inside a
                  single cluster is exactly the "Duplicate names" case this
                  surface already has to survive. Id alone would make that a
                  duplicate React key: React would reuse one row element for
                  both, so the second row could render the first row's Node
                  and open it. The index is safe as a tiebreak here because
                  the list is a total order `groupNodesIntoHealthClusters`
                  already settled, not a user-reorderable one. */}
              {cluster.nodes.map((member, index) => (
                <HealthAuditClusterRow
                  key={`${member.node.id}#${index}`}
                  member={member}
                  onActivate={onActivateNode}
                  location={locations[index]}
                />
              ))}
            </ul>
            {cluster.remainingNodeCount > 0 && (
              <p className="code-map__health-more">{formatRemainingNodes(cluster.remainingNodeCount)}</p>
            )}
          </li>
          );
        })}
      </ol>
      {grouping.remainingClusterCount > 0 && (
        <p className="code-map__health-more code-map__health-more--clusters">
          {formatRemainingClusters(grouping.remainingClusterCount)}
        </p>
      )}
    </section>
  );
}
