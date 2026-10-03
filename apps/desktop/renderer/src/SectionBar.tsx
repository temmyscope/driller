import type { SectionNodeCount } from '@driller/ipc-contracts';

import { formatCount, formatCountNumber } from './format';

/**
 * P4-4 phase 1c: whether the Section bar shows for a ready map — only when
 * the indexing scope the Graph Service actually applied to that reply
 * (`CodeMapResult.appliedScope`, never the persisted setting) has 2 or more
 * entries. Duplicate allowlist entries collapse to one section (P4-4c review
 * (b)), so they are counted once: `api`, `api` is one section, not a bar.
 */
export function showSectionBar(appliedScope: readonly string[]): boolean {
  return new Set(appliedScope).size >= 2;
}

/** `all`'s Node count: the sum of every section's whole-scope count — never the on-screen section reply's `nodes`. */
export function allSectionsNodeCount(sections: readonly SectionNodeCount[]): number {
  return sections.reduce((sum, entry) => sum + entry.nodeCount, 0);
}

/** One tab: `path` is the allowlist entry, `null` for `all`. */
export interface SectionTab {
  path: string | null;
  nodeCount: number;
}

/**
 * The tabs in order: `all` first, then one per `sections` entry in its own
 * (allowlist) order. Built from `sections` alone, so each tab and its count
 * are matched by path — never zipped with `appliedScope` by index.
 */
export function sectionTabs(sections: readonly SectionNodeCount[]): SectionTab[] {
  return [
    { path: null, nodeCount: allSectionsNodeCount(sections) },
    ...sections.map((entry) => ({ path: entry.path, nodeCount: entry.nodeCount })),
  ];
}

/** The visible label (`api 412`) and the accessible name (`api, 412 Nodes`) of a tab. */
export function sectionTabLabel(path: string | null, nodeCount: number): { name: string; count: string; accessibleName: string } {
  const name = path ?? 'all';
  return {
    name,
    count: formatCountNumber(nodeCount),
    accessibleName: `${name}, ${formatCount(nodeCount, 'Node', 'Nodes')}`,
  };
}

/**
 * The tab a key moves focus to, or `null` for a key the tablist doesn't
 * handle: ArrowLeft/ArrowRight wrap, Home/End jump to the first/last tab.
 * Moving focus never activates (manual activation: Enter/Space, the
 * button's own click, is the only thing that switches — each switch refetches).
 */
export function nextSectionTabIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) {
    return null;
  }
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Moves DOM focus to the tab `nextSectionTabIndex` names, among `tabs()` (the
 * tablist's own `role="tab"` buttons, in order). Never activates.
 */
export function moveSectionTabFocus(
  event: { key: string; preventDefault: () => void },
  index: number,
  count: number,
  tabs: () => ArrayLike<{ focus: () => void }>,
): void {
  const next = nextSectionTabIndex(event.key, index, count);
  if (next === null) {
    return;
  }
  event.preventDefault();
  tabs()[next]?.focus();
}

/** P4-4d review round 1: the id of a tab, by its position (`all` is 0). */
export function sectionTabId(index: number): string {
  return `section-bar-tab-${index}`;
}

/** P4-4d review round 1: the id of the tabpanel every tab controls — the map's own region (`App.tsx`). */
export const SECTION_PANEL_ID = 'section-panel';

export const SECTION_BAR_HINT_ID = 'section-bar-hint';

/** The id of the selected tab, for the tabpanel's `aria-labelledby`; `undefined` when none is selected. */
export function selectedSectionTabId(sections: readonly SectionNodeCount[], section: string | null): string | undefined {
  const index = sectionTabs(sections).findIndex((tab) => tab.path === section);
  return index >= 0 ? sectionTabId(index) : undefined;
}

/**
 * P4-4 phase 1c: the Section bar (EXPERIENCE.md § Component Patterns,
 * "Section bar"; DESIGN.md `section-tab` / `section-tab-active`) — a
 * `role="tablist"` row under the header that switches the map to one
 * indexing-scope section. `section` is the selected allowlist path, `null`
 * for `all`. Each tab controls the map's region (`SECTION_PANEL_ID`).
 *
 * Keyboard: a roving `tabIndex` that follows the selected tab (so Tab enters
 * the bar on it), arrows and Home/End move focus only, and Enter/Space — the
 * native button click — activate. Activating the selected tab again is left
 * to `onChange`'s owner. Renders nothing with fewer than 2 sections, so a bar
 * of `all` plus one tab can never show.
 *
 * P4-4d review round 1: while the session isn't live (`enabled` false —
 * re-indexing or degraded) a switch would throw away the last completed map
 * for a fetch that can't be served, so the tabs are `aria-disabled` (never
 * natively `disabled`: they stay focusable and the hint is heard, the
 * `ModeSwitcher` precedent) and activating one does nothing. MUST STAY
 * HOOKLESS: `SectionBar.test.ts` calls it directly.
 */
export function SectionBar({
  sections,
  section,
  enabled,
  onChange,
}: {
  sections: readonly SectionNodeCount[];
  section: string | null;
  enabled: boolean;
  onChange: (section: string | null) => void;
}) {
  if (sections.length < 2) {
    return null;
  }
  const tabs = sectionTabs(sections);
  const selectedIndex = tabs.findIndex((tab) => tab.path === section);
  // `section` names no tab (a section that left the allowlist, before the
  // reply that falls back to `all` lands): no tab is selected, and `all`
  // holds the roving tabIndex so the bar stays reachable by Tab.
  const focusableIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const describedBy = enabled ? undefined : SECTION_BAR_HINT_ID;
  return (
    <div className="section-bar">
      <div
        className="section-bar__tabs"
        role="tablist"
        aria-label="Section"
        aria-disabled={enabled ? undefined : true}
        aria-describedby={describedBy}
      >
        {tabs.map((tab, index) => {
          const label = sectionTabLabel(tab.path, tab.nodeCount);
          const selected = index === selectedIndex;
          return (
            <button
              key={tab.path ?? ''}
              id={sectionTabId(index)}
              type="button"
              role="tab"
              className="section-bar__tab"
              aria-selected={selected}
              aria-controls={SECTION_PANEL_ID}
              aria-label={label.accessibleName}
              aria-disabled={enabled ? undefined : true}
              aria-describedby={describedBy}
              title={label.name}
              tabIndex={index === focusableIndex ? 0 : -1}
              onClick={() => {
                if (enabled) {
                  onChange(tab.path);
                }
              }}
              onKeyDown={(event) =>
                moveSectionTabFocus(
                  event,
                  index,
                  tabs.length,
                  () => event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
                )
              }
            >
              {label.name} <span className="section-bar__count">{label.count}</span>
            </button>
          );
        })}
      </div>
      {!enabled && (
        <span id={SECTION_BAR_HINT_ID} className="section-bar__hint">
          Sections switch once the map is live again
        </span>
      )}
    </div>
  );
}
