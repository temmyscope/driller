/**
 * P4-4 phase 1c: the Section bar — a `role="tablist"` of `all` plus one tab
 * per section, labelled with the verbatim path and its Node count, with a
 * roving `tabIndex`, arrow/Home/End focus moves and manual activation.
 *
 * `SectionBar` is hookless and rendered by calling it and walking the
 * returned elements (`renderTree`), like `ModeSwitcher.test.ts`. Its keydown
 * handlers are called with a fake event whose tablist hands back fake tabs.
 *
 * What this cannot reach: the browser's own Enter/Space → click on a
 * focused button, the visual underline, and VoiceOver reading the names and
 * the announcement — owed in the live check (tracker row P4-4d).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { SectionNodeCount } from '@driller/ipc-contracts';

import {
  SectionBar,
  allSectionsNodeCount,
  nextSectionTabIndex,
  sectionTabLabel,
  sectionTabs,
  SECTION_BAR_HINT_ID,
  SECTION_PANEL_ID,
  sectionTabId,
  selectedSectionTabId,
  showSectionBar,
} from './SectionBar';
import { renderTree, textOf, type RenderedElement } from './testRender';

const TWO: SectionNodeCount[] = [
  { path: 'web', nodeCount: 792 },
  { path: 'api', nodeCount: 412 },
];

function render(
  sections: readonly SectionNodeCount[],
  section: string | null,
  onChange: (next: string | null) => void = () => {},
  enabled = true,
) {
  const elements = renderTree(SectionBar({ sections, section, enabled, onChange }));
  const tablist = elements.find((element) => element.props.role === 'tablist');
  const tabs = elements.filter((element) => element.props.role === 'tab');
  return { elements, tablist, tabs };
}

/** Calls a tab's onKeyDown with `key`; returns which fake tab got focus and whether the default was prevented. */
function press(tab: RenderedElement, key: string, count: number): { focused: number | null; prevented: boolean } {
  let focused: number | null = null;
  let prevented = false;
  const fakeTabs = Array.from({ length: count }, (_, index) => ({ focus: () => (focused = index) }));
  (tab.props.onKeyDown as (event: unknown) => void)({
    key,
    preventDefault: () => (prevented = true),
    currentTarget: {
      parentElement: {
        querySelectorAll: (selector: string) => {
          assert.equal(selector, '[role="tab"]');
          return fakeTabs;
        },
      },
    },
  });
  return { focused, prevented };
}

describe('showSectionBar', () => {
  it('shows with 2 or more distinct applied entries only', () => {
    assert.equal(showSectionBar(['web', 'api']), true);
    assert.equal(showSectionBar(['web', 'api', 'docs']), true);
    assert.equal(showSectionBar(['api']), false);
    assert.equal(showSectionBar([]), false);
    // A duplicated allowlist entry collapses to one section: no bar.
    assert.equal(showSectionBar(['api', 'api']), false);
  });
});

describe('sectionTabs / labels', () => {
  it('all first with the sum of the sections, then each section in order', () => {
    assert.deepEqual(sectionTabs(TWO), [
      { path: null, nodeCount: 1204 },
      { path: 'web', nodeCount: 792 },
      { path: 'api', nodeCount: 412 },
    ]);
    assert.equal(allSectionsNodeCount(TWO), 1204);
    assert.equal(allSectionsNodeCount([]), 0);
  });

  it('labels: the verbatim path and the count; the accessible name says Nodes', () => {
    assert.deepEqual(sectionTabLabel('api', 412), { name: 'api', count: '412', accessibleName: 'api, 412 Nodes' });
    assert.deepEqual(sectionTabLabel(null, 1204), { name: 'all', count: '1,204', accessibleName: 'all, 1,204 Nodes' });
    assert.equal(sectionTabLabel('apps/web', 1).accessibleName, 'apps/web, 1 Node');
  });
});

describe('nextSectionTabIndex', () => {
  it('arrows wrap, Home/End jump, other keys are not handled', () => {
    assert.equal(nextSectionTabIndex('ArrowRight', 0, 3), 1);
    assert.equal(nextSectionTabIndex('ArrowRight', 2, 3), 0);
    assert.equal(nextSectionTabIndex('ArrowLeft', 0, 3), 2);
    assert.equal(nextSectionTabIndex('ArrowLeft', 2, 3), 1);
    assert.equal(nextSectionTabIndex('Home', 2, 3), 0);
    assert.equal(nextSectionTabIndex('End', 0, 3), 2);
    for (const key of ['Enter', ' ', 'Tab', 'ArrowUp', 'ArrowDown', 'a']) {
      assert.equal(nextSectionTabIndex(key, 1, 3), null, key);
    }
    assert.equal(nextSectionTabIndex('ArrowRight', 0, 0), null);
  });
});

describe('SectionBar', () => {
  it('renders nothing with fewer than 2 sections', () => {
    assert.equal(SectionBar({ sections: [{ path: 'api', nodeCount: 412 }], section: null, enabled: true, onChange: () => {} }), null);
    assert.equal(SectionBar({ sections: [], section: null, enabled: true, onChange: () => {} }), null);
  });

  it('a tablist named Section of tabs: all 1,204 · web 792 · api 412, all selected', () => {
    const { tablist, tabs } = render(TWO, null);
    assert.ok(tablist);
    assert.equal(tablist.props['aria-label'], 'Section');
    assert.deepEqual(
      tabs.map((tab) => textOf(tab)),
      ['all 1,204', 'web 792', 'api 412'],
    );
    assert.deepEqual(
      tabs.map((tab) => tab.props['aria-label']),
      ['all, 1,204 Nodes', 'web, 792 Nodes', 'api, 412 Nodes'],
    );
    assert.deepEqual(
      tabs.map((tab) => tab.props['aria-selected']),
      [true, false, false],
    );
    assert.deepEqual(
      tabs.map((tab) => tab.props.tabIndex),
      [0, -1, -1],
    );
    for (const tab of tabs) {
      assert.equal(tab.type, 'button');
      assert.equal(tab.props.type, 'button');
    }
  });

  it('the selected section is matched by path, and carries aria-selected and the roving tabIndex', () => {
    const { tabs } = render(TWO, 'api');
    assert.deepEqual(
      tabs.map((tab) => tab.props['aria-selected']),
      [false, false, true],
    );
    assert.deepEqual(
      tabs.map((tab) => tab.props.tabIndex),
      [-1, -1, 0],
    );
  });

  it('a selected section missing from the tabs selects none, and keeps all reachable', () => {
    const { tabs } = render(TWO, 'docs');
    assert.deepEqual(
      tabs.map((tab) => tab.props['aria-selected']),
      [false, false, false],
    );
    assert.equal(tabs[0]?.props.tabIndex, 0);
  });

  it('a click (Enter/Space on a button) activates that tab', () => {
    const picked: (string | null)[] = [];
    const { tabs } = render(TWO, null, (next) => picked.push(next));
    for (const tab of tabs) {
      (tab.props.onClick as () => void)();
    }
    assert.deepEqual(picked, [null, 'web', 'api']);
  });

  it('arrows and Home/End move focus only — never activate', () => {
    const picked: (string | null)[] = [];
    const { tabs } = render(TWO, null, (next) => picked.push(next));
    const last = tabs[2]!;
    assert.deepEqual(press(last, 'ArrowRight', 3), { focused: 0, prevented: true });
    assert.deepEqual(press(tabs[0]!, 'ArrowLeft', 3), { focused: 2, prevented: true });
    assert.deepEqual(press(tabs[1]!, 'Home', 3), { focused: 0, prevented: true });
    assert.deepEqual(press(tabs[0]!, 'End', 3), { focused: 2, prevented: true });
    // Enter is left to the button's own click; nothing handled here.
    assert.deepEqual(press(tabs[1]!, 'Enter', 3), { focused: null, prevented: false });
    assert.deepEqual(picked, []);
  });
});

describe('SectionBar: review round 1', () => {
  it('while not live: every tab aria-disabled, still focusable, described by the hint; activation does nothing', () => {
    const picked: (string | null)[] = [];
    const { tablist, tabs, elements } = render(TWO, 'api', (next) => picked.push(next), false);
    const hint = elements.find((element) => element.props.id === SECTION_BAR_HINT_ID);
    assert.ok(hint);
    assert.equal(textOf(hint), 'Sections switch once the map is live again');
    assert.equal(tablist?.props['aria-disabled'], true);
    for (const tab of tabs) {
      assert.equal(tab.props['aria-disabled'], true);
      assert.equal(tab.props['aria-describedby'], SECTION_BAR_HINT_ID);
      assert.notEqual(tab.props.disabled, true, 'stays focusable');
      (tab.props.onClick as () => void)();
    }
    assert.deepEqual(picked, []);
    // Focus still moves.
    assert.deepEqual(press(tabs[0]!, 'ArrowRight', 3), { focused: 1, prevented: true });
    assert.equal(tabs[2]?.props.tabIndex, 0);
  });

  it('while live: no hint and no aria-disabled', () => {
    const { tablist, tabs, elements } = render(TWO, null);
    assert.equal(elements.find((element) => element.props.id === SECTION_BAR_HINT_ID), undefined);
    assert.equal(tablist?.props['aria-disabled'], undefined);
    assert.ok(tabs.every((tab) => tab.props['aria-disabled'] === undefined && tab.props['aria-describedby'] === undefined));
  });

  it('each tab has an id and controls the map panel; the selected tab labels it', () => {
    const { tabs } = render(TWO, 'web');
    assert.deepEqual(
      tabs.map((tab) => tab.props.id),
      [sectionTabId(0), sectionTabId(1), sectionTabId(2)],
    );
    assert.equal(new Set(tabs.map((tab) => tab.props.id)).size, 3);
    assert.ok(tabs.every((tab) => tab.props['aria-controls'] === SECTION_PANEL_ID));
    assert.equal(selectedSectionTabId(TWO, 'web'), sectionTabId(1));
    assert.equal(selectedSectionTabId(TWO, null), sectionTabId(0));
    assert.equal(selectedSectionTabId(TWO, 'docs'), undefined);
  });

  it('a long path keeps its full text as the tab title', () => {
    const { tabs } = render([{ path: 'packages/very/long/section/path', nodeCount: 1 }, ...TWO], null);
    assert.equal(tabs[1]?.props.title, 'packages/very/long/section/path');
  });
});

describe('styles: the active tab is an underline in --text, never accent', () => {
  const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
  it('section-tab-active', () => {
    const rule = /\.section-bar__tab\[aria-selected='true'\] \{([^}]*)\}/.exec(css)?.[1];
    assert.ok(rule, 'the active rule keys on aria-selected');
    assert.match(rule, /border-bottom-color: var\(--text\);/);
    assert.match(rule, /color: var\(--text\);/);
    assert.doesNotMatch(rule, /accent/);
  });

  it('one row that scrolls sideways at narrow widths; tabs never wrap or shrink', () => {
    const tabs = /\.section-bar__tabs \{([^}]*)\}/.exec(css)?.[1];
    assert.ok(tabs);
    assert.match(tabs, /flex-wrap: nowrap;/);
    assert.match(tabs, /overflow-x: auto;/);
    const tab = /\.section-bar__tab \{([^}]*)\}/.exec(css)?.[1];
    assert.ok(tab);
    assert.match(tab, /white-space: nowrap;/);
    assert.match(tab, /flex-shrink: 0;/);
  });
});
