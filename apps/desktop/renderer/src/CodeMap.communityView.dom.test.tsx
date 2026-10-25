/**
 * The collapsed community view, mounted: the cards Full opens with, the
 * counted link edges between them, expanding and collapsing as one Back
 * step each, the `+`/`−` keys, the announcements through the Panel's one
 * live region, and the degenerate-case notice. `domEnv` must stay the first
 * import (see its header).
 *
 * The pure logic is pinned by `communityView.test.ts`; this pins what the
 * canvas actually does with it.
 */
import './test/domEnv';
import { cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { CodeMap, type CodeMapProps } from './CodeMap';
import { communityCardNodesText } from './communityView';
import { createFakeDrillerApi, type FakeDrillerApi } from './test/fakeDrillerApi';
import { FIXTURE_PROJECT_PATH, pathTraceBasicMap, syntheticMap, type CodeMapOk } from './test/mapFixture';

afterEach(cleanupAfterEach);

const BUDGET = { timeout: 4_000 * (env.CI === 'true' ? 2 : 1) };
// `[2026-10-25]` Scaled for CI like the test budget beside it. A flat inner
// budget gave every `waitFor` half the allowance, relative to machine speed,
// that the test around it got — see `4a1c48b` and status.md's row on it.
const FIND = { timeout: 1_500 * (env.CI === 'true' ? 2 : 1) };

/** A 60-Node synthetic map: above the collapse floor, and several communities. */
const GROUPED_MAP = () => syntheticMap({ nodes: 60 });

function mapFake(map: () => CodeMapOk): FakeDrillerApi {
  const fake = createFakeDrillerApi({
    getCodeMap: async () => map(),
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
  });
  fake.install();
  return fake;
}

function mount(props: Partial<CodeMapProps> = {}) {
  const noop = () => {};
  return render(
    <CodeMap
      projectPath={FIXTURE_PROJECT_PATH}
      noSummaryBackendAvailable={false}
      cloudSelectedNoKey={false}
      mode="codeMap"
      onRequestCodeMapMode={noop}
      graphServiceAvailable
      dataVersion={0}
      onMapState={noop}
      onDiffScopeSynced={noop}
      onOpenSettings={noop}
      onReindex={async () => true}
      onSwitchSection={noop}
      {...props}
    />,
  );
}

function measure(): void {
  resizeObservers.resizeAll(elementSize.width, elementSize.height);
}

/** The drawn community cards, in DOM order. */
function communityCardEls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.code-map__community')];
}

/** The drawn Node cards' ids. */
function nodeCardIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node-codeMapNode[data-id]')]
    .map((card) => card.getAttribute('data-id') ?? '')
    .sort();
}

/** The drawn community link edges' ids. */
function linkEdgeIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__edge[data-id]')]
    .map((edge) => edge.getAttribute('data-id') ?? '')
    .filter((id) => id.startsWith('community-link:'))
    .sort();
}

/** The Panel's one status line — where every expand, collapse and Back/Forward is announced. */
function status(): string {
  return document.querySelector<HTMLElement>('.code-map__reveal-status')?.textContent ?? '';
}

function historyButton(name: 'Back' | 'Forward'): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

async function mountGrouped(map: () => CodeMapOk = GROUPED_MAP) {
  mapFake(map);
  mount();
  await waitFor(() => {
    measure();
    assert.ok(communityCardEls().length > 1, 'the community cards are drawn');
  }, FIND);
}

/**
 * A community's name can hold regex metacharacters — a path's dots, and the
 * parentheses `communities.ts` adds when two communities would read alike
 * ("src/CodeMap.tsx (formatCount)") — so a label read off a card is escaped
 * before it goes into a pattern. Without this, an announcement check passes
 * only for labels that happen to contain none.
 */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('Full map opens on the community cards', () => {
  it('draws one card per community and no Node cards', BUDGET, async () => {
    await mountGrouped();
    assert.equal(nodeCardIds().length, 0, 'no Node card is drawn while every community is collapsed');
    assert.ok(communityCardEls().length > 1);
  });

  it('each card names its community, counts its Nodes and states its cohesion in real counts', BUDGET, async () => {
    await mountGrouped();
    for (const card of communityCardEls()) {
      assert.equal(within(card).getByText('community').tagName, 'SPAN');
      // The label is a real identifier, in monospace (a `<code>` element).
      const label = card.querySelector('code');
      assert.ok(label !== null && (label.textContent ?? '').length > 0, 'the card carries a real identifier');
      assert.match(card.textContent ?? '', /\d+ Nodes?/);
      assert.match(card.textContent ?? '', /\d+ of \d+ calls inside|no calls in indexed code/);
      assert.doesNotMatch(card.textContent ?? '', /%/, 'never a derived percentage');
    }
  });

  it('spells the whole card out for assistive tech, including the action', BUDGET, async () => {
    await mountGrouped();
    const [card] = communityCardEls();
    const spoken = card!.getAttribute('aria-label') ?? '';
    assert.match(spoken, /^Community /);
    assert.match(spoken, /\d+ Nodes?/);
    assert.match(spoken, /expand$/);
    assert.equal(card!.getAttribute('aria-expanded'), 'false');
  });

  it('draws the call traffic between two cards with its count as visible text', BUDGET, async () => {
    await mountGrouped();
    await waitFor(() => {
      measure();
      assert.ok(linkEdgeIds().length > 0, 'at least one community link edge is drawn');
    }, FIND);
    const labels = [...document.querySelectorAll<HTMLElement>('.react-flow__edge')]
      .filter((edge) => (edge.getAttribute('data-id') ?? '').startsWith('community-link:'))
      .map((edge) => edge.textContent ?? '');
    assert.ok(labels.length > 0);
    for (const label of labels) {
      assert.match(label, /\d+ calls?/, 'the count rides as visible text, never width or colour alone');
    }
  });
});

describe('opening and closing a community', () => {
  it('a click opens it to its own Nodes and removes its card', BUDGET, async () => {
    await mountGrouped();
    const card = communityCardEls()[0]!;
    const opened = card.getAttribute('aria-label') ?? '';
    fireEvent.click(card);
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 0, 'its Nodes are drawn');
    }, FIND);
    assert.ok(
      !communityCardEls().some((other) => (other.getAttribute('aria-label') ?? '') === opened),
      'its own card is gone',
    );
  });

  it('announces the open through the Panel’s one live region, naming the community', BUDGET, async () => {
    await mountGrouped();
    const card = communityCardEls()[0]!;
    const label = card.querySelector('code')?.textContent ?? '';
    fireEvent.click(card);
    await waitFor(() => assert.match(status(), new RegExp(`^Expanded ${escapeRegExp(label)} — \\d+ Nodes?$`)), FIND);
  });

  it('`+` opens the focused card and `−` on one of its Nodes closes it again', BUDGET, async () => {
    await mountGrouped();
    const card = communityCardEls()[0]!;
    const label = card.querySelector('code')?.textContent ?? '';
    card.focus();
    fireEvent.keyDown(card, { key: '+' });
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 0);
    }, FIND);

    const nodeCard = document.querySelector<HTMLElement>('.react-flow__node-codeMapNode .code-map__node');
    assert.ok(nodeCard !== null, 'a Node card of the opened community is drawn');
    fireEvent.keyDown(nodeCard, { key: '-' });
    await waitFor(() => assert.match(status(), new RegExp(`^Collapsed ${escapeRegExp(label)} — \\d+ Nodes? hidden$`)), FIND);
    await waitFor(() => {
      measure();
      assert.equal(nodeCardIds().length, 0, 'the Nodes are hidden again');
    }, FIND);
  });

  it('never acts on `+`/`−` with a modifier held, so zoom shortcuts are untouched', BUDGET, async () => {
    await mountGrouped();
    const card = communityCardEls()[0]!;
    const before = communityCardEls().length;
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      fireEvent.keyDown(card, { key: '+', [modifier]: true });
    }
    await waitFor(() => {
      measure();
      assert.equal(communityCardEls().length, before, 'nothing opened');
    }, FIND);
    assert.equal(nodeCardIds().length, 0);
  });

  it('`−` on a collapsed card says it is already collapsed rather than doing nothing silently', BUDGET, async () => {
    await mountGrouped();
    const card = communityCardEls()[0]!;
    const label = card.querySelector('code')?.textContent ?? '';
    fireEvent.keyDown(card, { key: '-' });
    await waitFor(() => assert.equal(status(), `${label} is already collapsed.`), FIND);
  });
});

describe('each open and close is one Back step', () => {
  it('Back closes what was opened, and Forward opens it again', BUDGET, async () => {
    await mountGrouped();
    const card = communityCardEls()[0]!;
    const label = card.querySelector('code')?.textContent ?? '';
    fireEvent.click(card);
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 0);
    }, FIND);

    fireEvent.click(historyButton('Back'));
    await waitFor(() => assert.match(status(), new RegExp(`^Back: Collapsed ${escapeRegExp(label)} —`)), FIND);
    await waitFor(() => {
      measure();
      assert.equal(nodeCardIds().length, 0, 'Back undid the open');
    }, FIND);

    fireEvent.click(historyButton('Forward'));
    await waitFor(() => assert.match(status(), new RegExp(`^Forward: Expanded ${escapeRegExp(label)} —`)), FIND);
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 0, 'Forward redid it');
    }, FIND);
  });

  it('two opens are two Back steps', BUDGET, async () => {
    await mountGrouped();
    const first = communityCardEls()[0]!;
    fireEvent.click(first);
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 0);
    }, FIND);
    const openedFirst = nodeCardIds().length;

    const second = communityCardEls()[0]!;
    fireEvent.click(second);
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > openedFirst, 'a second community opened too');
    }, FIND);

    fireEvent.click(historyButton('Back'));
    await waitFor(() => {
      measure();
      assert.equal(nodeCardIds().length, openedFirst, 'one Back undid only the second open');
    }, FIND);
    fireEvent.click(historyButton('Back'));
    await waitFor(() => {
      measure();
      assert.equal(nodeCardIds().length, 0, 'the second Back undid the first open');
    }, FIND);
  });
});

describe('the Grouped / All Nodes toggle', () => {
  it('shows every Node, and groups them again', BUDGET, async () => {
    await mountGrouped();
    const group = screen.getByRole('group', { name: 'Community view' });
    assert.equal(within(group).getByRole('button', { name: 'Grouped' }).getAttribute('aria-pressed'), 'true');

    fireEvent.click(within(group).getByRole('button', { name: 'All Nodes' }));
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 1, 'every Node is drawn');
    }, FIND);
    assert.equal(communityCardEls().length, 0, 'and no community card');
    assert.equal(within(group).getByRole('button', { name: 'All Nodes' }).getAttribute('aria-pressed'), 'true');

    fireEvent.click(within(group).getByRole('button', { name: 'Grouped' }));
    await waitFor(() => {
      measure();
      assert.ok(communityCardEls().length > 1, 'the cards are back');
    }, FIND);
    assert.equal(nodeCardIds().length, 0);
  });

  it('announces each switch, counting what is now shown', BUDGET, async () => {
    await mountGrouped();
    const group = screen.getByRole('group', { name: 'Community view' });
    fireEvent.click(within(group).getByRole('button', { name: 'All Nodes' }));
    await waitFor(() => assert.match(status(), /^Showing all \d+ Nodes$/), FIND);
    fireEvent.click(within(group).getByRole('button', { name: 'Grouped' }));
    await waitFor(() => assert.match(status(), /^Showing \d+ communities$/), FIND);
  });
});

describe('a map the view does not apply to', () => {
  it('draws every Node, offers no toggle, and says why', BUDGET, async () => {
    // The seven-Node `path-trace-basic` fixture: too few to group.
    mapFake(pathTraceBasicMap);
    mount();
    await waitFor(() => {
      measure();
      assert.ok(nodeCardIds().length > 0, 'its Nodes are drawn');
    }, FIND);
    assert.equal(communityCardEls().length, 0, 'no community card');
    assert.equal(screen.queryByRole('group', { name: 'Community view' }), null, 'and no choice that would do nothing');

    const notice = document.querySelector<HTMLElement>('.code-map__community-notice');
    assert.ok(notice !== null, 'the reason is stated');
    assert.match(notice.textContent ?? '', /too few to group, so every Node is shown/);
    assert.match(notice.textContent ?? '', new RegExp(communityCardNodesText(7)));
  });

  it('states when the whole map is unreferenced', BUDGET, async () => {
    const edgeless = (): CodeMapOk => ({ ...pathTraceBasicMap(), edges: [] });
    mapFake(edgeless);
    mount();
    await waitFor(() => {
      measure();
      const notice = document.querySelector<HTMLElement>('.code-map__community-notice');
      assert.ok(notice !== null);
      assert.match(notice.textContent ?? '', /No call edges in indexed code/);
    }, FIND);
  });
});
