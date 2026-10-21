/**
 * The collapsed community view of the Code Map's Full map.
 *
 * Full lays its cards out by call-graph community (`communityLayout.ts`).
 * This module is the view on top of that: by default each community is drawn
 * as ONE labelled card stating what it holds, with the real call traffic
 * between those cards drawn and counted, and the engineer opens a community
 * to get its own Nodes. That is what makes the grouping legible at a glance
 * — a readable number of cards instead of every Node at once.
 *
 * What a community card is NOT (arc42.md §8, amended 2026-10-20, names all
 * three so they are never conflated): not an LOD cluster, which is a
 * renderer-local spatial aggregate of whatever cards are near each other on
 * screen; and not a Health Audit cluster, which groups Nodes by their
 * containing directory and bands them by risk-signal count. A community card
 * stands for a group the call graph itself produced.
 *
 * Boundaries, the same ones the Revealed view observes (`revealView.ts`):
 * this is layout and drawing only. It never feeds a risk signal, a blast
 * radius, adjacency, Path Trace, a diff-scoped Node set or Health Audit —
 * those all read the full fetched map (`CanvasPopulation.riskNodes` /
 * `riskEdges`), which this module passes through untouched. A community id is
 * renderer-local and must never flow into a Graph Service call (AD-2);
 * `isCommunityCardId` is the guard for anywhere a card id could be mistaken
 * for a Node id.
 *
 * One known limit, stated rather than hidden: a link edge is drawn only
 * between two COLLAPSED cards. With one end expanded there is no single card
 * on that side to anchor it to, and picking one of its members would invent
 * structure the graph does not have, so the edge is not drawn — instead the
 * collapsed card states its own outside traffic ("N out"), so the traffic is
 * never silently zero, and collapsing the other side shows where it goes.
 */
import {
  MIN_NODES_TO_PARTITION,
  UNREFERENCED_COMMUNITY_ID,
  type CommunityPartition,
  type GraphCommunity,
} from './communities';
import type { CommunityBlock } from './communityLayout';
import type { CanvasPopulation } from './CodeMap';
import type { CodeMapNode } from '@driller/ipc-contracts';

/**
 * Every community id starts with this (`detectCommunities` builds them as
 * `community:<representative Node id>`), and no Node id does — which is what
 * lets a card id and a Node id share one canvas without ambiguity.
 */
export const COMMUNITY_CARD_ID_PREFIX = 'community:';

/** Whether `id` is a community card's id rather than a Node's. Never pass one to a Graph Service call (AD-2). */
export function isCommunityCardId(id: string): boolean {
  return id.startsWith(COMMUNITY_CARD_ID_PREFIX);
}

/**
 * Which communities are drawn as their own Nodes. Session state, never
 * persisted; empty means every community is collapsed, which is the default
 * view.
 */
export type ExpandedCommunities = ReadonlySet<string>;

export const NO_EXPANDED_COMMUNITIES: ExpandedCommunities = new Set();

/**
 * Below this many Nodes on the map, nothing collapses — every Node is drawn,
 * as Full always did.
 *
 * Collapsing earns its place only when there is enough to hide. The same
 * reasoning gives `MIN_NODES_TO_PARTITION` its value, and the same number
 * serves: a map of a few dozen cards already fits one screen at a readable
 * zoom, so replacing it with two or three cards would hide a map the
 * engineer could simply have read — on the seven-Node `path-trace-basic`
 * fixture it would hide all seven behind "repository, 5 Nodes" and
 * "unreferenced in indexed code, 2 Nodes".
 */
export const MIN_NODES_TO_COLLAPSE = MIN_NODES_TO_PARTITION;

/** How many Nodes a partition holds, across every community. */
export function partitionNodeCount(partition: CommunityPartition): number {
  return partition.communities.reduce((total, community) => total + community.memberIds.length, 0);
}

/** Whether this map is grouped into cards at all — see `MIN_NODES_TO_COLLAPSE` and the one-community case. */
export function communityViewApplies(partition: CommunityPartition): boolean {
  return partition.communities.length > 1 && partitionNodeCount(partition) >= MIN_NODES_TO_COLLAPSE;
}

/**
 * The communities to draw as one card, given which are expanded.
 *
 * With only one community there is nothing to group: collapsing it would
 * hide the whole map behind a single card that says what the map already
 * says, so nothing collapses and the view is exactly Full's laid-out Nodes
 * (see `communityViewNotice`, which states that).
 */
export function collapsedCommunityIds(
  partition: CommunityPartition,
  expanded: ExpandedCommunities = NO_EXPANDED_COMMUNITIES,
): ReadonlySet<string> {
  if (!communityViewApplies(partition)) {
    return new Set();
  }
  return new Set(
    partition.communities.map((community) => community.id).filter((id) => !expanded.has(id)),
  );
}

/**
 * Whether Full is showing community cards or every Node. `'all'` is what
 * Full was before the collapsed view existed, and the way back to seeing the
 * whole map at once.
 */
export type CommunityViewMode = 'grouped' | 'all';

/** Which mode an expansion state amounts to; a map the view does not apply to is always `'all'`. */
export function communityViewMode(partition: CommunityPartition, expanded: ExpandedCommunities): CommunityViewMode {
  return collapsedCommunityIds(partition, expanded).size === 0 ? 'all' : 'grouped';
}

/**
 * The expansion state for a mode: every community for `'all'`, none for
 * `'grouped'`. A mode switch is not a history step, the same way the
 * Revealed/Full toggle is not — it is which view you are in, not a step
 * within one.
 */
export function expandedForMode(partition: CommunityPartition, mode: CommunityViewMode): ExpandedCommunities {
  return mode === 'all' ? new Set(partition.communities.map((community) => community.id)) : NO_EXPANDED_COMMUNITIES;
}

/** `revealedPopulation`'s shape: the population to draw, plus the map Nodes `layoutNodes` lays out. */
export interface CommunityViewPopulation extends CanvasPopulation {
  /** `canvasNodes` without the folded cards — the Nodes of expanded communities only. */
  mapNodes: readonly CodeMapNode[];
}

/**
 * Filters what the canvas draws to the Nodes of communities that are not
 * collapsed: `canvasNodes` (and the folded cards among them) and
 * `canvasEdges` to edges with both ends drawn. `riskNodes`/`riskEdges` are
 * passed through as the very same arrays, because every number reads them,
 * never the drawing.
 */
export function communityViewPopulation(
  population: CanvasPopulation,
  collapsed: ReadonlySet<string>,
  communityOfNode: ReadonlyMap<string, string>,
): CommunityViewPopulation {
  if (collapsed.size === 0) {
    const mapNodes = population.canvasNodes.filter((node): node is CodeMapNode => !('folded' in node));
    return { ...population, mapNodes };
  }
  const isDrawn = (id: string) => {
    const community = communityOfNode.get(id);
    return community === undefined || !collapsed.has(community);
  };
  const canvasNodes = population.canvasNodes.filter((node) => isDrawn(node.id));
  const mapNodes = canvasNodes.filter((node): node is CodeMapNode => !('folded' in node));
  return {
    riskNodes: population.riskNodes,
    riskEdges: population.riskEdges,
    canvasNodes,
    canvasEdges: population.canvasEdges.filter((edge) => isDrawn(edge.source) && isDrawn(edge.target)),
    foldedNodes: population.foldedNodes.filter((folded) => isDrawn(folded.id)),
    mapNodes,
  };
}

/** What one collapsed community card shows. */
export interface CommunityCard {
  /** The card's canvas id — the community's own id. */
  id: string;
  /** The community's own most-called member's real identifier. */
  label: string;
  memberCount: number;
  /** Calls with both ends inside the community. */
  internalEdges: number;
  /** Calls with exactly one end inside it. */
  externalEdges: number;
  position: { x: number; y: number };
}

/**
 * The cards for every collapsed block, in block order. A block that is not
 * collapsed has no card — its Nodes are drawn instead.
 */
export function communityCards(
  blocks: readonly CommunityBlock[],
  partition: CommunityPartition,
): CommunityCard[] {
  const byId = new Map(partition.communities.map((community) => [community.id, community]));
  const cards: CommunityCard[] = [];
  for (const block of blocks) {
    const community = byId.get(block.communityId);
    if (!block.collapsed || community === undefined) {
      continue;
    }
    cards.push({
      id: community.id,
      label: community.label,
      memberCount: community.memberIds.length,
      internalEdges: community.internalEdges,
      externalEdges: community.externalEdges,
      position: { x: block.x, y: block.y },
    });
  }
  return cards;
}

/** A community card's Node count, in the engineer's own vocabulary. */
export function communityCardNodesText(memberCount: number): string {
  return `${memberCount} ${memberCount === 1 ? 'Node' : 'Nodes'}`;
}

/**
 * The community's cohesion, as the two real counts it is computed from
 * rather than a derived percentage: "12 of 15 calls inside". `GraphCommunity`
 * also carries `cohesion` as a number, which orders communities, but a card
 * states the counts — a figure the engineer can check against the graph,
 * which a percentage is not (the same discipline that kept a fabricated
 * "74% gap" off the Health Audit row, EXPERIENCE.md).
 *
 * A community with no calls at all says so instead of "0 of 0".
 */
export function communityCardCohesionText(internalEdges: number, externalEdges: number): string {
  const total = internalEdges + externalEdges;
  if (total === 0) {
    return 'no calls in indexed code';
  }
  return `${internalEdges} of ${total} calls inside`;
}

/** A collapsed card's outside traffic, or `null` when it has none — never a bare "0". */
export function communityCardOutsideText(externalEdges: number): string | null {
  return externalEdges === 0 ? null : `${externalEdges} out`;
}

/**
 * A community card's accessible name: what it is, what it holds, its
 * cohesion in real counts, and the one action it offers. Never relies on the
 * card's shape or colour to carry any of it (Accessibility Floor).
 */
export function communityCardAriaLabel(card: CommunityCard): string {
  const parts = [
    `Community ${card.label}`,
    communityCardNodesText(card.memberCount),
    communityCardCohesionText(card.internalEdges, card.externalEdges),
  ];
  if (card.externalEdges > 0) {
    // Spoken in full: the card's own "N out" is shorthand the glyph-free
    // accessible name should not inherit.
    parts.push(`${communityLinkLabel(card.externalEdges)} out`);
  }
  parts.push('expand');
  return parts.join(', ');
}

/** One drawn link between two collapsed community cards. */
export interface CommunityLinkEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  /** The visible text — a count, never width or colour alone (Accessibility Floor). */
  label: string;
  ariaLabel: string;
}

/** Every link edge's id starts with this; no Node id, community id or reveal card id does. */
export const COMMUNITY_LINK_EDGE_ID_PREFIX = 'community-link:';

/**
 * Whether `id` is a community link edge's. Such an edge joins two community
 * cards, never a Node pair, so it must never navigate: its endpoints are
 * community ids, which AD-2 keeps out of every Graph Service call and out of
 * the navigation history.
 */
export function isCommunityLinkEdgeId(id: string): boolean {
  return id.startsWith(COMMUNITY_LINK_EDGE_ID_PREFIX);
}

export function communityLinkLabel(count: number): string {
  return `${count} ${count === 1 ? 'call' : 'calls'}`;
}

/**
 * The link edges to draw: one per ordered pair of COLLAPSED communities with
 * traffic between them, strongest first (`partition.links` is already
 * sorted). A pair with either end expanded is left out — see this module's
 * header for why that is a limit stated rather than papered over.
 */
export function communityLinkEdges(
  partition: CommunityPartition,
  collapsed: ReadonlySet<string>,
): CommunityLinkEdge[] {
  const labelOf = new Map(partition.communities.map((community) => [community.id, community.label]));
  const edges: CommunityLinkEdge[] = [];
  for (const link of partition.links) {
    if (!collapsed.has(link.sourceCommunityId) || !collapsed.has(link.targetCommunityId)) {
      continue;
    }
    const sourceLabel = labelOf.get(link.sourceCommunityId) ?? link.sourceCommunityId;
    const targetLabel = labelOf.get(link.targetCommunityId) ?? link.targetCommunityId;
    edges.push({
      id: `${COMMUNITY_LINK_EDGE_ID_PREFIX}${JSON.stringify([link.sourceCommunityId, link.targetCommunityId])}`,
      source: link.sourceCommunityId,
      target: link.targetCommunityId,
      count: link.count,
      label: communityLinkLabel(link.count),
      ariaLabel: `${sourceLabel} calls ${targetLabel} ${communityLinkLabel(link.count)} in indexed code`,
    });
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Expanding and collapsing
// ---------------------------------------------------------------------------

/** One expand or collapse — a single Back step, as a Revealed drill step is. */
export type CommunityStep = 'expand' | 'collapse';

export type CommunityTogglePlan =
  | { kind: 'step'; step: CommunityStep; next: ExpandedCommunities; label: string; memberCount: number }
  /** Nothing to do, with the one sentence saying why. */
  | { kind: 'none'; text: string };

/**
 * What activating a community card, or pressing `+`/`−` on one, does.
 *
 * `action` omitted toggles; given, it only acts in that direction, so `+` on
 * an already-expanded community says so rather than collapsing it.
 */
export function planCommunityToggle(
  partition: CommunityPartition,
  expanded: ExpandedCommunities,
  communityId: string,
  action?: CommunityStep,
): CommunityTogglePlan {
  const community = partition.communities.find((candidate) => candidate.id === communityId);
  if (community === undefined) {
    return { kind: 'none', text: 'That community is not on this map.' };
  }
  const collapsed = collapsedCommunityIds(partition, expanded);
  const isCollapsed = collapsed.has(communityId);
  const step: CommunityStep = action ?? (isCollapsed ? 'expand' : 'collapse');
  const memberCount = community.memberIds.length;
  if (step === 'expand') {
    if (!isCollapsed) {
      return { kind: 'none', text: `${community.label} is already expanded.` };
    }
    const next = new Set(expanded);
    next.add(communityId);
    return { kind: 'step', step, next, label: community.label, memberCount };
  }
  if (partition.communities.length <= 1) {
    return { kind: 'none', text: `${community.label} is the only community on this map — nothing to collapse into.` };
  }
  if (isCollapsed) {
    return { kind: 'none', text: `${community.label} is already collapsed.` };
  }
  const next = new Set(expanded);
  next.delete(communityId);
  return { kind: 'step', step, next, label: community.label, memberCount };
}

/** What a step is announced as, naming the community and what changed. */
export function formatCommunityAnnouncement(step: CommunityStep, label: string, memberCount: number): string {
  const nodes = communityCardNodesText(memberCount);
  return step === 'expand' ? `Expanded ${label} — ${nodes}` : `Collapsed ${label} — ${nodes} hidden`;
}

/** What a Back or Forward over a community step is announced as. */
export function formatCommunityHistoryAnnouncement(
  how: 'undo' | 'return' | 'redo',
  step: CommunityStep,
  label: string,
  memberCount: number,
): string {
  const undone: CommunityStep = step === 'expand' ? 'collapse' : 'expand';
  const applied = how === 'undo' ? undone : step;
  const prefix = how === 'undo' ? 'Back: ' : how === 'redo' ? 'Forward: ' : '';
  return `${prefix}${formatCommunityAnnouncement(applied, label, memberCount)}`;
}

// ---------------------------------------------------------------------------
// Degenerate cases
// ---------------------------------------------------------------------------

export type CommunityViewNotice =
  | { kind: 'single-community'; label: string; sentence: string }
  | { kind: 'all-unreferenced'; sentence: string }
  | { kind: 'too-small'; sentence: string };

/**
 * The Actionable Notice this view owes, or `null` when it owes none. Both
 * cases are real outcomes of a real partition, not failures — so each states
 * what is true in one sentence and offers no action, rather than leaving the
 * engineer to wonder why there are no community cards (EXPERIENCE.md's
 * Actionable Notice shape: an icon, one sentence, and at most one action).
 */
export function communityViewNotice(partition: CommunityPartition): CommunityViewNotice | null {
  if (partition.communities.length === 0) {
    return null;
  }
  const [only] = partition.communities;
  if (partition.communities.length !== 1 || only === undefined) {
    const nodes = partitionNodeCount(partition);
    return nodes < MIN_NODES_TO_COLLAPSE
      ? {
          kind: 'too-small',
          sentence: `${communityCardNodesText(nodes)} in indexed code — too few to group, so every Node is shown.`,
        }
      : null;
  }
  if (only.id === UNREFERENCED_COMMUNITY_ID) {
    return {
      kind: 'all-unreferenced',
      sentence: `No call edges in indexed code — all ${communityCardNodesText(only.memberIds.length)} are unreferenced, so there is nothing to group.`,
    };
  }
  return {
    kind: 'single-community',
    label: only.label,
    sentence: `One community in indexed code (${only.label}, ${communityCardNodesText(only.memberIds.length)}) — nothing to group, so every Node is shown.`,
  };
}

/** A community by id, for a caller that has only the id. */
export function communityById(partition: CommunityPartition, communityId: string): GraphCommunity | undefined {
  return partition.communities.find((community) => community.id === communityId);
}
