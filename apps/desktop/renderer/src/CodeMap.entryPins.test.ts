/**
 * P4-7g: pins in `CodeMap` — the pinned candidate card ("⚑ pinned by you",
 * ", pinned entry point" in its accessible name), Node detail's "Entry point"
 * section and its toggle (`aria-pressed`, the explicit limit message), and
 * the hook wiring (source pins: the component's hooks can't run under
 * `node --test`): a stored pin change bumps the pins revision, which owes
 * Revealed a new listing on the same map.
 *
 * What this cannot reach: a real pin from Node detail topping the live
 * Revealed canvas, and a relaunch — the P4-7g live check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CodeMapNode, EntryCandidate } from '@driller/ipc-contracts';

import {
  CandidateReasonLine,
  CodeMapNodeCard,
  NODE_DETAIL_SECTION_HEADING_IDS,
  NodeDetailBody,
  NodeDetailEntryPin,
  type EntryPinControl,
  type NodeDetailBodyProps,
} from './CodeMap';
import { PIN_LIMIT_TEXT } from './entryPins';
import { renderTree, textOf, type RenderedElement } from './testRender';

const codeMapSrc = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
const noop = () => {};

function hostElements(root: unknown): RenderedElement[] {
  return renderTree(root).filter((element) => typeof element.type === 'string');
}

const NODE: CodeMapNode = {
  id: 'api.serviceB',
  name: 'serviceB',
  file: 'api/services.ts',
  startLine: 1,
  endLine: 9,
  kind: 'Function',
  summaryStatus: 'ready',
  summary: 'Does a thing.',
  riskSignals: [],
};

const PINNED: EntryCandidate = {
  id: 'api.serviceB',
  name: 'serviceB',
  file: 'api/services.ts',
  startLine: 1,
  endLine: 9,
  reach: 2,
  reason: { kind: 'pinned' },
};

describe('the pinned candidate card', () => {
  const data = {
    node: NODE,
    onActivate: noop,
    onShowNeighbors: noop,
    onOpenSource: noop,
    callerCount: 1,
    calleeCount: 1,
    noSummaryBackendAvailable: false,
    cloudSelectedNoKey: false,
    showDeterministicSignals: true,
    showLlmJudgment: true,
    showIngestedFindings: true,
    isChanged: false,
  };

  it('shows "⚑ pinned by you" (glyph plus text) instead of the heuristic reason, and says so in its accessible name', () => {
    const root = CodeMapNodeCard({ data: { ...data, candidate: PINNED } }) as unknown as RenderedElement;
    assert.equal(root.props['aria-label'], 'Function serviceB, pinned entry point, reaches 2 Nodes, open Node detail');
    const line = hostElements(root).find((element) => String(element.props.className).startsWith('code-map__node-candidate '));
    assert.ok(line);
    assert.equal(squash(textOf(line)), '⚑ pinned by you · reaches 2 Nodes in indexed code');
    assert.doesNotMatch(textOf(line), /candidate|no callers/);
    const glyph = hostElements(line).find((element) => textOf(element) === '⚑');
    assert.equal(glyph?.props['aria-hidden'], 'true');
  });

  it('a heuristic candidate keeps "◎ candidate"', () => {
    const line = CandidateReasonLine({ candidate: { ...PINNED, reach: 4, reason: { kind: 'no-callers' } } });
    assert.equal(squash(textOf(line)), '◎ candidate · no callers in indexed code · reaches 4 Nodes');
  });
});

describe("Node detail's pin toggle", () => {
  function control(overrides: Partial<EntryPinControl> = {}): { control: EntryPinControl; toggles: () => number } {
    let toggles = 0;
    return {
      control: {
        pinned: false,
        busy: false,
        message: null,
        onToggle: () => {
          toggles += 1;
        },
        ...overrides,
      },
      toggles: () => toggles,
    };
  }

  it('"⚑ Pin as entry point", not pressed; activating it toggles', () => {
    const { control: unpinned, toggles } = control();
    const elements = hostElements(NodeDetailEntryPin({ control: unpinned }));
    const button = elements.find((element) => element.type === 'button');
    assert.ok(button);
    assert.equal(squash(textOf(button)), '⚑ Pin as entry point');
    assert.equal(button.props['aria-pressed'], false);
    assert.equal(button.props.disabled, false);
    (button.props.onClick as () => void)();
    assert.equal(toggles(), 1);
    // The glyph is decoration: the accessible name is the label.
    assert.equal(hostElements(button).find((element) => element.type === 'span')?.props['aria-hidden'], 'true');
  });

  it('pinned: the same label, pressed, with a visible "⚑ pinned by you" note beside it; busy disables it', () => {
    const elements = hostElements(NodeDetailEntryPin({ control: control({ pinned: true, busy: true }).control }));
    const button = elements.find((element) => element.type === 'button');
    assert.equal(squash(textOf(button)), '⚑ Pin as entry point', 'review round 1: a stable label');
    assert.equal(button?.props['aria-pressed'], true);
    assert.equal(button?.props.disabled, true);
    const note = elements.find((element) => element.props.className === 'code-map__node-detail-pin-state');
    assert.equal(squash(textOf(note)), '⚑ pinned by you');
    assert.equal(note?.props['aria-hidden'], 'true', 'aria-pressed already says it');
    assert.ok(
      !hostElements(NodeDetailEntryPin({ control: control().control })).some(
        (element) => element.props.className === 'code-map__node-detail-pin-state',
      ),
    );
  });

  it('the pin limit is said explicitly, in a status line', () => {
    const status = hostElements(NodeDetailEntryPin({ control: control({ message: PIN_LIMIT_TEXT }).control })).find(
      (element) => element.props.role === 'status',
    );
    assert.match(textOf(status), /^Pin limit \(50\) reached/);
  });

  const bodyProps: NodeDetailBodyProps = {
    node: NODE,
    toggles: { showDeterministicSignals: true, showLlmJudgment: true, showIngestedFindings: true },
    cloudSelectedNoKey: false,
    noSummaryBackendAvailable: false,
    summaryAction: null,
    regenerateState: { kind: 'idle' },
    graphServiceAvailable: true,
    onRegenerate: noop,
    onOpenTest: noop,
  };

  it('NodeDetailBody: an "Entry point" section, before Staleness, only when the control is given', () => {
    const headings = (props: NodeDetailBodyProps) =>
      renderTree(NodeDetailBody(props))
        .filter((element) => element.type === 'h3')
        .map((element) => textOf(element));
    assert.ok(!headings(bodyProps).includes('Entry point'));
    const withPin = headings({ ...bodyProps, entryPin: control().control });
    assert.equal(withPin.indexOf('Entry point'), withPin.indexOf('Staleness') - 1);
    const section = renderTree(NodeDetailBody({ ...bodyProps, entryPin: control().control })).find(
      (element) => element.type === 'section' && element.props['aria-labelledby'] === NODE_DETAIL_SECTION_HEADING_IDS.entryPin,
    );
    assert.ok(section);
  });
});

describe('the wiring (source pins)', () => {
  it('Node detail gets the control for the Node it shows', () => {
    assert.match(
      codeMapSrc,
      /entryPin=\{\s*projectPath === null\s*\? undefined\s*: \{\s*pinned: entryPins\?\.includes\(nodeDetail\.node\.id\) \?\? false,\s*busy: entryPinBusy \|\| entryPins === null,\s*message: entryPinMessage\?\.nodeId === nodeDetail\.node\.id \? entryPinMessage\.text : null,\s*onToggle: \(\) => toggleEntryPin\(nodeDetail\.node\.id\),/,
    );
  });

  it('the pins are read per project, and a stored change bumps the pins revision (only a change)', () => {
    assert.match(codeMapSrc, /loadEntryPins\(projectPath, \(path\) => window\.driller\.getEntryPins\(path\)\)/);
    // Review round 1: one id, applied by main; nothing sent before the read lands.
    assert.match(codeMapSrc, /saveEntryPin\(projectPath, nodeId, plan\.pinned, \(path, id, pinned\) =>\s*window\.driller\.setEntryPins\(path, id, pinned\),?\s*\)/);
    assert.match(codeMapSrc, /if \(projectPath === null \|\| previous === null\) \{\s*return;/);
    assert.match(codeMapSrc, /useState<readonly string\[\] \| null>\(null\)/);
    assert.match(codeMapSrc, /setEntryPins\(null\);/);
    assert.match(codeMapSrc, /if \(outcome\.changed\) \{[\s\S]{0,200}setEntryPinsRevision\(\(revision\) => revision \+ 1\);/);
    assert.match(codeMapSrc, /if \(plan\.kind === 'limit'\) \{\s*setEntryPinMessage\(\{ nodeId, text: PIN_LIMIT_TEXT \}\);\s*return;/);
  });

  it('the listing effect re-lists on a pins revision, on the same map, without re-fitting', () => {
    assert.match(
      codeMapSrc,
      /needsRevealListing\(revealHeldRef\.current, currentRevealKey, revealMapStamp, entryPinsRevision\)/,
    );
    assert.match(codeMapSrc, /startRevealListing\(revealHeldRef\.current, key, mapStamp, pinsRevision\)/);
    assert.match(codeMapSrc, /mapStamp,\s*result,\s*pinsRevision,\s*sameFetch,\s*drillGraph,/);
    assert.match(codeMapSrc, /userMoved: revealUserMovedRef\.current,\s*sameFetch,/);
    assert.match(codeMapSrc, /isDevFixtureMode,\s*entryPinsRevision,\s*\]\);/);
  });

  it('review round 1: a same-fetch listing rebases the reveal steps; a kept failed one leaves them; others drop them', () => {
    assert.match(codeMapSrc, /if \(landed\.status === 'ready' && landed\.pinsListingFailed !== undefined\) \{[\s\S]{0,200}return;/);
    assert.match(
      codeMapSrc,
      /if \(sameFetch && landed\.status === 'ready' && drawnBefore !== null && drillGraph !== null && drillGraph\.edges === mapStamp\) \{[\s\S]{0,600}rebaseRevealHistory\(previous, \{\s*key,\s*mapStamp,\s*previous: drawnBefore,\s*landed: landed\.state,\s*rebase: \(state\) => refreshRevealState\(state, fresh, graph\),/,
    );
    assert.match(codeMapSrc, /setHistory\(\(previous\) => historyWithoutReveals\(previous\)\);/);
  });
});
