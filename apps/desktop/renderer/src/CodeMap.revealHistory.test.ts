/**
 * P4-7f: drill steps in the Back/Forward history (the entry union, the cap,
 * Back/Forward over reveal entries, stale entries never surviving a map
 * change), and the `+`/`−` keyboard on a focused card, hookless. P4-8g:
 * the wiring inside `CodeMap` is rendered in `CodeMap.revealHistory.dom.test.tsx`.
 *
 * What this cannot reach: the live canvas — VoiceOver reading the status
 * line, Cmd + `=` zooming the app (the P4-7f live check).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CodeMapEdge, CodeMapNode, EntryCandidate } from '@driller/ipc-contracts';

import { CodeMapNodeCard, CodeMapRevealStubCard } from './CodeMap';
import {
  applyRevealTransition,
  announcementSteps,
  canGoBack,
  canGoForward,
  drawnRevealState,
  expandNode,
  formatRevealHistoryAnnouncement,
  historyMove,
  historyWithoutEntry,
  historyWithoutReveals,
  initialRevealState,
  isRevealCardId,
  MAX_HISTORY_LENGTH,
  pushHistoryEntry,
  restoreRevealSnapshot,
  revealDrillGraphFor,
  revealDrillKey,
  revealFocusRescue,
  revealKey,
  revealStatusText,
  REVEAL_STEP_STALE_TEXT,
  revealStubCardId,
  type HeldReveal,
  type HistoryEntry,
  type NavigationHistory,
  type RevealAuxCard,
  type RevealHistoryEntry,
  type RevealState,
} from './revealView';
import type { RenderedElement } from './testRender';

function mapNode(id: string): CodeMapNode {
  return {
    id,
    name: id,
    file: 'src/a.ts',
    startLine: 1,
    endLine: 9,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'Does a thing.',
    riskSignals: [],
  };
}

const edge = (source: string, target: string): CodeMapEdge => ({ source, target, kind: 'CALLS' });

function candidate(id: string, reach: number): EntryCandidate {
  return { id, name: id, file: 'src/entry.ts', startLine: 1, endLine: 5, reach, reason: { kind: 'no-callers' } };
}

// path-trace-basic: handleRequest→serviceA,serviceB→repository↔cacheLookup.
const PTB_NODES = ['handleRequest', 'serviceA', 'serviceB', 'repository', 'cacheLookup'].map(mapNode);
const PTB_EDGES: CodeMapEdge[] = [
  edge('handleRequest', 'serviceA'),
  edge('handleRequest', 'serviceB'),
  edge('serviceA', 'repository'),
  edge('serviceB', 'repository'),
  edge('repository', 'cacheLookup'),
  edge('cacheLookup', 'repository'),
];
const KEY = revealKey('/p', null);

function ptbHeld(): { held: HeldReveal; start: RevealState; graph: ReturnType<typeof revealDrillGraphFor> } {
  const graph = revealDrillGraphFor(null, PTB_NODES, PTB_EDGES);
  const start = initialRevealState({ status: 'found', candidates: [candidate('handleRequest', 4)], totalQualifying: 1, relations: [] });
  return { held: { key: KEY, mapStamp: PTB_EDGES, listing: { status: 'ready', state: start, totalQualifying: 1 } }, start, graph };
}

const node = (id: string): HistoryEntry => ({ kind: 'node', id });

function reveal(before: RevealState, after: RevealState, focusId = 'handleRequest'): RevealHistoryEntry {
  return { kind: 'reveal', before, after, focusId, name: focusId, step: 'expand', key: KEY, mapStamp: PTB_EDGES };
}

const EMPTY: NavigationHistory = { stack: [], index: -1 };
const pushAll = (entries: HistoryEntry[], from: NavigationHistory = EMPTY) => entries.reduce(pushHistoryEntry, from);

describe('pushHistoryEntry: the entry union', () => {
  it('node entries keep today’s behaviour: append, forward truncation, same-id dedupe that keeps forward entries', () => {
    const h = pushAll([node('a'), node('b'), node('c')]);
    assert.deepEqual(h, { stack: [node('a'), node('b'), node('c')], index: 2 });
    const back = { ...h, index: 1 };
    assert.equal(pushHistoryEntry(back, node('b')), back, 'navigating to the current Node is a no-op, forward kept');
    assert.deepEqual(pushHistoryEntry(back, node('d')), { stack: [node('a'), node('b'), node('d')], index: 2 });
  });

  it('a reveal entry is never deduped: two identical expands are two Back steps', () => {
    const { start } = ptbHeld();
    const entry = reveal(start, start);
    const h = pushAll([entry, entry]);
    assert.equal(h.stack.length, 2);
    assert.equal(h.index, 1);
  });

  it('a node entry after a reveal entry is not deduped against an earlier node', () => {
    const { start } = ptbHeld();
    const h = pushAll([node('a'), reveal(start, start), node('a')]);
    assert.equal(h.stack.length, 3);
  });

  it('a render-only ref/stub card id never becomes a node entry', () => {
    assert.equal(isRevealCardId(revealStubCardId('hub')), true);
    assert.equal(isRevealCardId('src/a.ts::hub'), false);
    const h = pushAll([node('a')]);
    assert.equal(pushHistoryEntry(h, node(revealStubCardId('hub'))), h);
  });

  it('the cap counts every entry, node and reveal alike: the oldest is trimmed and the index follows', () => {
    const { start } = ptbHeld();
    const entries: HistoryEntry[] = [];
    for (let i = 0; i < MAX_HISTORY_LENGTH - 2; i += 1) {
      entries.push(node(`n${i}`));
    }
    entries.push(reveal(start, start), reveal(start, start));
    const full = pushAll(entries);
    assert.equal(full.stack.length, MAX_HISTORY_LENGTH);
    const over = pushHistoryEntry(full, reveal(start, start));
    assert.equal(over.stack.length, MAX_HISTORY_LENGTH);
    assert.equal(over.index, MAX_HISTORY_LENGTH - 1);
    assert.deepEqual(over.stack[0], node('n1'), 'the oldest entry was trimmed');
    const overByNode = pushHistoryEntry(full, node('last'));
    assert.equal(overByNode.stack.length, MAX_HISTORY_LENGTH);
    assert.deepEqual(overByNode.stack[0], node('n1'));
  });
});

describe('historyMove: Back and Forward over the union', () => {
  it('Expand, then Back: the reveal state deep-equals the pre-expand state; Forward re-applies the expand', () => {
    const { held, start, graph } = ptbHeld();
    const applied = applyRevealTransition(held, KEY, (state) => expandNode(state, graph.adjacency, graph.reachById, 'handleRequest'));
    assert.ok(applied);
    const entry = reveal(applied.before, applied.after);
    const history = pushHistoryEntry(EMPTY, entry);
    assert.equal(canGoBack(history), true, 'one reveal entry can be undone');

    const back = historyMove(history, 'back');
    assert.equal(back.kind, 'reveal');
    assert.ok(back.kind === 'reveal');
    assert.equal(back.how, 'undo');
    assert.equal(back.index, -1);
    const restored = restoreRevealSnapshot(applied.held, KEY, back.entry, back.entry.after, back.restore);
    assert.ok(restored);
    assert.deepEqual(drawnRevealState(restored, KEY), start);
    assert.equal(formatRevealHistoryAnnouncement(back.how, back.entry), 'Back: restored the view before expanding handleRequest');

    const atStart = { ...history, index: back.index };
    assert.equal(canGoBack(atStart), false);
    assert.equal(canGoForward(atStart), true);
    const forward = historyMove(atStart, 'forward');
    assert.ok(forward.kind === 'reveal');
    assert.equal(forward.how, 'redo');
    const redone = restoreRevealSnapshot(restored, KEY, forward.entry, forward.entry.before, forward.restore);
    assert.ok(redone);
    assert.equal(drawnRevealState(redone, KEY), applied.after);
    assert.equal(
      formatRevealHistoryAnnouncement(forward.how, forward.entry),
      'Forward: Revealed 3 callees of handleRequest in 2 layers',
    );
  });

  it('matrix row, as written: navigate to a Node, then expand, then Back ×2 — the first Back undoes the expand, and the view ends re-centred on that earlier Node', () => {
    // Review round 1: Back #1 undoes the expand AND re-centres on the node
    // entry it lands on; with no earlier Node, Back #2 has nowhere to go.
    const { start } = ptbHeld();
    const expanded = { ...start };
    const h = pushAll([node('N'), reveal(start, expanded, 'X')]);
    const first = historyMove(h, 'back');
    assert.ok(first.kind === 'reveal');
    assert.equal(first.how, 'undo');
    assert.equal(first.restore, start, 'the expand is undone');
    assert.equal(first.index, 0);
    assert.equal(first.centerId, 'N', 're-centred on the earlier Node');
    const after = { ...h, index: first.index };
    assert.equal(canGoBack(after), false);
    assert.deepEqual(historyMove(after, 'back'), { kind: 'none' });
  });

  it('[a, b, expand]: Back #1 undoes and re-centres on b, Back #2 re-centres on a', () => {
    const { start } = ptbHeld();
    const h = pushAll([node('a'), node('b'), reveal(start, { ...start }, 'X')]);
    const first = historyMove(h, 'back');
    assert.ok(first.kind === 'reveal');
    assert.equal(first.restore, start);
    assert.equal(first.centerId, 'b');
    assert.equal(first.index, 1);
    assert.deepEqual(historyMove({ ...h, index: first.index }, 'back'), { kind: 'center', id: 'a', index: 0 });
  });

  it('undo onto another reveal entry centres on that step’s Node; at the start, on the step’s own', () => {
    const { start } = ptbHeld();
    const s1 = { ...start };
    const h = pushAll([reveal(start, s1, 'P'), reveal(s1, { ...s1 }, 'Q')]);
    const first = historyMove(h, 'back');
    assert.ok(first.kind === 'reveal');
    assert.equal(first.centerId, 'P');
    const second = historyMove({ ...h, index: 0 }, 'back');
    assert.ok(second.kind === 'reveal');
    assert.equal(second.centerId, 'P');
    assert.equal(second.index, -1);
  });

  it('Back from a Node onto a reveal entry shows that step again (its `after`)', () => {
    const { start } = ptbHeld();
    const after = { ...start };
    const h = pushAll([reveal(start, after, 'x'), node('b')]);
    const move = historyMove(h, 'back');
    assert.ok(move.kind === 'reveal');
    assert.equal(move.how, 'return');
    assert.equal(move.restore, after);
    assert.equal(formatRevealHistoryAnnouncement(move.how, move.entry), 'Back: returned to x in the Revealed view');
  });

  it('node entries move exactly as before: Back at the first Node and Forward at the last do nothing', () => {
    const h = pushAll([node('a'), node('b')]);
    assert.deepEqual(historyMove(h, 'back'), { kind: 'center', id: 'a', index: 0 });
    assert.deepEqual(historyMove(h, 'forward'), { kind: 'none' });
    assert.deepEqual(historyMove({ ...h, index: 0 }, 'back'), { kind: 'none' });
    assert.deepEqual(historyMove({ ...h, index: 0 }, 'forward'), { kind: 'center', id: 'b', index: 1 });
    assert.equal(canGoBack({ ...h, index: 0 }), false);
  });
});

describe('review round 1: PR Review never touches the reveal state (skipReveals)', () => {
  const opts = { skipReveals: true };
  it('Back and Forward step past reveal entries to the nearest Node; none that way → no move', () => {
    const { start } = ptbHeld();
    const r = reveal(start, start);
    const h: NavigationHistory = { stack: [node('a'), r, r, node('b'), r], index: 4 };
    assert.deepEqual(historyMove(h, 'back', opts), { kind: 'center', id: 'b', index: 3 });
    assert.deepEqual(historyMove({ ...h, index: 3 }, 'back', opts), { kind: 'center', id: 'a', index: 0 });
    assert.deepEqual(historyMove({ ...h, index: 0 }, 'forward', opts), { kind: 'center', id: 'b', index: 3 });
    assert.deepEqual(historyMove({ ...h, index: 3 }, 'forward', opts), { kind: 'none' });
    assert.equal(canGoForward({ ...h, index: 3 }, opts), false);
    const onlyReveals: NavigationHistory = { stack: [r, r], index: 1 };
    assert.equal(canGoBack(onlyReveals, opts), false);
    assert.equal(canGoBack(onlyReveals), true, 'in Code Map it can be undone');
  });
});

describe('review round 1: Node-only histories behave exactly as before P4-7f', () => {
  // The old logic: Back needs `index > 0` and centres `stack[index - 1]`;
  // Forward needs `index < length - 1` and centres `stack[index + 1]`.
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  it('historyMove and canGoBack/canGoForward match the old rules on 500 random Node-only histories (both modes)', () => {
    for (let run = 0; run < 500; run += 1) {
      const length = Math.floor(random() * 8);
      const stack: HistoryEntry[] = Array.from({ length }, () => node(`n${Math.floor(random() * 4)}`));
      const index = length === 0 ? -1 : Math.floor(random() * (length + 1)) - 1;
      const h: NavigationHistory = { stack, index };
      const ids = stack.map((entry) => (entry as { id: string }).id);
      const oldBack = index <= 0 ? { kind: 'none' } : { kind: 'center', id: ids[index - 1], index: index - 1 };
      const oldForward =
        index >= length - 1 ? { kind: 'none' } : { kind: 'center', id: ids[index + 1], index: index + 1 };
      for (const options of [{}, { skipReveals: true }]) {
        assert.deepEqual(historyMove(h, 'back', options), oldBack, JSON.stringify(h));
        assert.deepEqual(historyMove(h, 'forward', options), oldForward, JSON.stringify(h));
        assert.equal(canGoBack(h, options), !(index <= 0));
        assert.equal(canGoForward(h, options), !(index >= length - 1));
      }
    }
  });
});

describe('restoreRevealSnapshot: never another map’s state', () => {
  it('applies only for the same key and map fetch, and only over the state the step left', () => {
    const { held, start, graph } = ptbHeld();
    const applied = applyRevealTransition(held, KEY, (state) => expandNode(state, graph.adjacency, graph.reachById, 'handleRequest'));
    assert.ok(applied);
    const entry = reveal(applied.before, applied.after);
    assert.equal(restoreRevealSnapshot(applied.held, revealKey('/p', 'api'), entry, applied.after, start), null, 'another section');
    assert.equal(restoreRevealSnapshot(applied.held, KEY, { ...entry, mapStamp: [] }, applied.after, start), null, 'another fetch');
    assert.equal(restoreRevealSnapshot(held, KEY, entry, applied.after, initialRevealState({ status: 'found', candidates: [], totalQualifying: 0, relations: [] })), null, 'a state the step never left');
  });

  it('a refresh’s previous state still drawn while loading is restored in place', () => {
    const { start, graph } = ptbHeld();
    const after = expandNode(start, graph.adjacency, graph.reachById, 'handleRequest');
    const loading: HeldReveal = { key: KEY, mapStamp: PTB_EDGES, listing: { status: 'loading', previous: after } };
    const restored = restoreRevealSnapshot(loading, KEY, reveal(start, after), after, start);
    assert.ok(restored && restored.listing.status === 'loading');
    assert.equal(restored.listing.previous, start);
  });
});

describe('review round 1: a stale step, focus, and repeated announcements', () => {
  it('historyWithoutEntry drops only that step', () => {
    const { start } = ptbHeld();
    const stale = reveal(start, start);
    const other = reveal(start, start);
    const h: NavigationHistory = { stack: [node('a'), other, stale], index: 2 };
    assert.deepEqual(historyWithoutEntry(h, stale), { stack: [node('a'), other], index: 1 });
    assert.equal(REVEAL_STEP_STALE_TEXT, 'That step no longer applies to this map');
  });

  it('focus moves only when the restore removed the focused card: to the step’s card if shown, else Back', () => {
    assert.equal(revealFocusRescue({ focusWasOnCard: false, focusedCardStillShown: false, stepCardShown: true }), 'none');
    assert.equal(revealFocusRescue({ focusWasOnCard: true, focusedCardStillShown: true, stepCardShown: true }), 'none');
    assert.equal(revealFocusRescue({ focusWasOnCard: true, focusedCardStillShown: false, stepCardShown: true }), 'step-card');
    assert.equal(revealFocusRescue({ focusWasOnCard: true, focusedCardStillShown: false, stepCardShown: false }), 'back-button');
  });

  it('an identical announcement is blanked, then set again (the live region changes); a new one is set at once', () => {
    assert.deepEqual(announcementSteps('No more callees', 'No more callees'), ['', 'No more callees']);
    assert.deepEqual(announcementSteps('Collapsed a', 'No more callees'), ['No more callees']);
    assert.deepEqual(announcementSteps(null, 'No more callees'), ['No more callees']);
    // The blank renders as an empty line, not the cap line.
    assert.equal(revealStatusText({ switchStatus: null, announcement: '', notice: null, capText: 'cap' }), '');
    assert.equal(revealStatusText({ switchStatus: null, announcement: 'Revealed 1 callee of a', notice: null, capText: 'cap' }), 'Revealed 1 callee of a');
    assert.equal(revealStatusText({ switchStatus: 'Showing the full map to reach x', announcement: 'a', notice: null, capText: null }), 'Showing the full map to reach x');
  });
});

describe('historyWithoutReveals: no reveal step outlives its map', () => {
  it('drops the reveal entries, moves the index to the kept entry at or before it, and merges equal neighbours', () => {
    const { start } = ptbHeld();
    const h: NavigationHistory = { stack: [node('a'), reveal(start, start), node('a'), node('b')], index: 2 };
    assert.deepEqual(historyWithoutReveals(h), { stack: [node('a'), node('b')], index: 0 });
    const onReveal: NavigationHistory = { stack: [node('a'), reveal(start, start), node('b')], index: 1 };
    assert.deepEqual(historyWithoutReveals(onReveal), { stack: [node('a'), node('b')], index: 0 });
    const onlyReveal: NavigationHistory = { stack: [reveal(start, start)], index: 0 };
    assert.deepEqual(historyWithoutReveals(onlyReveal), { stack: [], index: -1 });
  });

  it('keeps what `keep` accepts, and returns the same history when nothing goes', () => {
    const { start } = ptbHeld();
    const mine = reveal(start, start);
    const other = { ...reveal(start, start), mapStamp: [] as CodeMapEdge[] };
    const h: NavigationHistory = { stack: [mine, other], index: 1 };
    assert.deepEqual(historyWithoutReveals(h, (entry) => entry.mapStamp === PTB_EDGES), { stack: [mine], index: 0 });
    const clean = pushAll([node('a')]);
    assert.equal(historyWithoutReveals(clean), clean);
  });
});

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

function cardData(extra: Record<string, unknown> = {}) {
  return {
    node: mapNode('handleRequest'),
    onActivate: () => {},
    onShowNeighbors: () => {},
    onOpenSource: () => {},
    callerCount: 0,
    calleeCount: 2,
    noSummaryBackendAvailable: false,
    cloudSelectedNoKey: false,
    showDeterministicSignals: true,
    showLlmJudgment: true,
    showIngestedFindings: true,
    isChanged: false,
    ...extra,
  };
}

function press(
  root: RenderedElement,
  key: string,
  modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat', boolean>> = {},
) {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...modifiers, prevented: false, preventDefault() {
    event.prevented = true;
  } };
  (root.props.onKeyDown as (event: unknown) => void)(event);
  return event;
}

function revealedCard(calls: string[]) {
  return CodeMapNodeCard({
    data: cardData({
      drill: { kind: 'expand', count: 2 },
      onActivate: (n: CodeMapNode) => calls.push(`detail:${n.id}`),
      onDrill: (n: CodeMapNode, action: string) => calls.push(`${action}:${n.id}`),
    }),
  } as never) as unknown as RenderedElement;
}

describe('the card keyboard (Revealed only)', () => {
  it('`+` and `=` expand, `-` and `−` collapse the focused card (Shift allowed: `+` needs it)', () => {
    const calls: string[] = [];
    const card = revealedCard(calls);
    for (const [key, shiftKey] of [['+', true], ['=', false], ['-', false], ['−', false]] as const) {
      assert.equal(press(card, key, { shiftKey }).prevented, true, key);
    }
    assert.deepEqual(calls, ['expand:handleRequest', 'expand:handleRequest', 'collapse:handleRequest', 'collapse:handleRequest']);
  });

  it('never with Ctrl, Cmd or Alt held: Ctrl/Cmd + `=` stays app zoom (not prevented, no drill)', () => {
    const calls: string[] = [];
    const card = revealedCard(calls);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const key of ['=', '+', '-']) {
        assert.equal(press(card, key, { [modifier]: true }).prevented, false, `${modifier}+${key}`);
      }
    }
    assert.deepEqual(calls, []);
    assert.equal(revealDrillKey({ key: '=', ctrlKey: true, metaKey: false, altKey: false }), null);
  });

  it('review round 1: a held key’s auto-repeat is ignored (card and stub)', () => {
    const calls: string[] = [];
    const card = revealedCard(calls);
    assert.equal(press(card, '+', { shiftKey: true, repeat: true }).prevented, false);
    assert.equal(press(card, '-', { repeat: true }).prevented, false);
    assert.deepEqual(calls, []);
    const stubCalls: string[] = [];
    const stub: Extract<RevealAuxCard, { kind: 'more' }> = { kind: 'more', id: revealStubCardId('hub'), parentId: 'hub', parentName: 'hub', hiddenCount: 15 };
    const root = CodeMapRevealStubCard({ data: { stub, onActivate: (s) => stubCalls.push(s.parentId) } }) as unknown as RenderedElement;
    press(root, '+', { repeat: true });
    assert.deepEqual(stubCalls, []);
  });

  it('Enter (and Space) on the card body still opens Node detail — never a drill', () => {
    const calls: string[] = [];
    const card = revealedCard(calls);
    assert.equal(press(card, 'Enter').prevented, true);
    press(card, ' ');
    assert.deepEqual(calls, ['detail:handleRequest', 'detail:handleRequest']);
  });

  it('in Full (no drill handler on the card), `+` does nothing and is not prevented', () => {
    const calls: string[] = [];
    const card = CodeMapNodeCard({
      data: cardData({ onActivate: (n: CodeMapNode) => calls.push(`detail:${n.id}`) }),
    } as never) as unknown as RenderedElement;
    assert.equal(press(card, '+', { shiftKey: true }).prevented, false);
    assert.deepEqual(calls, []);
  });

  it('a stub card: Enter, Space or `+` shows the next callees; Ctrl + `+` does not', () => {
    const calls: string[] = [];
    const stub: Extract<RevealAuxCard, { kind: 'more' }> = {
      kind: 'more',
      id: revealStubCardId('hub'),
      parentId: 'hub',
      parentName: 'hub',
      hiddenCount: 15,
    };
    const root = CodeMapRevealStubCard({ data: { stub, onActivate: (s) => calls.push(s.parentId) } }) as unknown as RenderedElement;
    press(root, 'Enter');
    press(root, ' ');
    press(root, '+', { shiftKey: true });
    press(root, '=');
    assert.equal(press(root, '+', { ctrlKey: true }).prevented, false);
    press(root, '-');
    assert.deepEqual(calls, ['hub', 'hub', 'hub', 'hub']);
  });
});
