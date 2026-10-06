/**
 * P4-8c: the DOM environment's own behaviour — the globals it installs, the
 * stand-ins React Flow and the app rely on, and what `cleanupAfterEach`
 * enforces. `domEnv` must stay the first import.
 */
import './domEnv';
import {
  cardSize,
  cleanupAfterEach,
  elementSize,
  expectConsoleError,
  NO_FAKE_INSTALLED,
  resizeObservers,
} from './domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useEffect, useState } from 'react';
import { render, screen } from '@testing-library/react';
import type { ModelStatusMessage } from '@driller/ipc-contracts';
import { NODE_CARD_FALLBACK_HEIGHT, NODE_CARD_FALLBACK_WIDTH } from '../CodeMap';
import { focusableWithin } from '../modalStack';
import { createFakeDrillerApi } from './fakeDrillerApi';

afterEach(cleanupAfterEach);

const READY: ModelStatusMessage = {
  type: 'graphService:modelStatus',
  state: 'ready',
  at: '2026-10-06T09:00:00.000Z',
  model: 'qwen2.5-coder-1.5b.gguf',
};

function div(attributes: Record<string, string> = {}): HTMLDivElement {
  const element = document.createElement('div');
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  return element;
}

describe('domEnv: globals', () => {
  it('installs jsdom’s window, document, navigator and Event on globalThis', () => {
    assert.equal(globalThis.window, window);
    assert.equal(window.document, document);
    assert.equal(globalThis.navigator, window.navigator, 'Node’s own navigator is replaced');
    const element = div();
    let seen = false;
    element.addEventListener('ping', () => {
      seen = true;
    });
    element.dispatchEvent(new Event('ping'));
    assert.equal(seen, true, 'a global Event dispatches on a jsdom element');
    assert.equal(globalThis.IS_REACT_ACT_ENVIRONMENT, true);
  });
});

describe('domEnv: sizes', () => {
  it('reports elementSize for ordinary elements and cardSize for a React Flow Node and its contents', () => {
    const container = div();
    const card = div({ class: 'react-flow__node' });
    const label = document.createElement('span');
    card.append(label);
    container.append(card);
    assert.deepEqual([container.offsetWidth, container.offsetHeight], [1200, 800]);
    assert.deepEqual([card.offsetWidth, card.offsetHeight], [200, 80]);
    assert.deepEqual([label.offsetWidth, label.offsetHeight], [200, 80]);

    elementSize.set(300, 200);
    cardSize.set(150, 60);
    assert.deepEqual([container.offsetWidth, container.offsetHeight], [300, 200]);
    assert.deepEqual([card.offsetWidth, card.offsetHeight], [150, 60]);
  });

  it('both sizes are back to their defaults in the next test', () => {
    assert.deepEqual([document.body.offsetWidth, document.body.offsetHeight], [1200, 800]);
    assert.deepEqual([cardSize.width, cardSize.height], [200, 80]);
  });

  it('cardSize defaults to CodeMap’s own card estimate', () => {
    assert.deepEqual([cardSize.width, cardSize.height], [NODE_CARD_FALLBACK_WIDTH, NODE_CARD_FALLBACK_HEIGHT]);
  });
});

describe('domEnv: ResizeObserver', () => {
  it('fires only on resizeAll, with each element’s size, until unobserved or disconnected', () => {
    const seen: [Element, number, number][] = [];
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        seen.push([entry.target, entry.contentRect.width, entry.contentRect.height]);
      }
    });
    const a = div();
    const b = div({ class: 'react-flow__node' });
    observer.observe(a);
    observer.observe(b);
    assert.deepEqual(seen, [], 'observing reports nothing by itself');

    resizeObservers.resizeAll(640, 480);
    assert.deepEqual(seen, [
      [a, 640, 480],
      [b, 200, 80],
    ], 'a card keeps its card size');
    assert.deepEqual([a.offsetWidth, a.offsetHeight], [640, 480], 'resizeAll sets elementSize too');

    observer.unobserve(a);
    resizeObservers.resizeAll(10, 20);
    assert.deepEqual(seen.at(-1), [b, 200, 80]);
    assert.equal(seen.length, 3);

    observer.disconnect();
    assert.equal(resizeObservers.liveCount, 0);
    resizeObservers.resizeAll(1, 1);
    assert.equal(seen.length, 3);

    // Observing again after a disconnect starts from nothing.
    const c = div();
    observer.observe(c);
    resizeObservers.resizeAll(5, 6);
    assert.deepEqual(seen.slice(3), [[c, 5, 6]]);
    observer.disconnect();
  });
});

describe('domEnv: other stand-ins', () => {
  it('reads the zoom of a React Flow viewport transform through DOMMatrixReadOnly', () => {
    const moved = new DOMMatrixReadOnly('translate(12px, 34px) scale(0.5)');
    assert.equal(moved.m22, 0.5);
    assert.deepEqual([moved.m41, moved.m42], [12, 34]);
    assert.equal(new DOMMatrixReadOnly('matrix(2, 0, 0, 2, 5, 6)').m22, 2);
    assert.equal(new DOMMatrixReadOnly('none').m22, 1);
  });

  it('getClientRects: one rect when rendered; none when detached, `hidden` or display:none, itself or above', () => {
    const shown = div();
    document.body.append(shown);
    assert.equal(shown.getClientRects().length, 1);
    assert.equal(shown.getClientRects()[0]?.width, 1200);

    assert.equal(div().getClientRects().length, 0, 'detached');
    const hiddenParent = div({ hidden: '' });
    const inHidden = div();
    hiddenParent.append(inHidden);
    const noneParent = div({ style: 'display: none' });
    const inNone = div();
    noneParent.append(inNone);
    const selfNone = div({ style: 'display:none' });
    document.body.append(hiddenParent, noneParent, selfNone);
    assert.equal(hiddenParent.getClientRects().length, 0);
    assert.equal(inHidden.getClientRects().length, 0, 'inside a hidden ancestor');
    assert.equal(inNone.getClientRects().length, 0, 'inside a display:none ancestor');
    assert.equal(selfNone.getClientRects().length, 0);
  });

  it('getBoundingClientRect (P4-8d): the element’s size when rendered, 0×0 when not', () => {
    const shown = div();
    const card = div({ class: 'react-flow__node' });
    document.body.append(shown, card);
    const box = shown.getBoundingClientRect();
    assert.deepEqual([box.x, box.y, box.width, box.height], [0, 0, 1200, 800]);
    elementSize.set(600, 400);
    assert.deepEqual([shown.getBoundingClientRect().width, shown.getBoundingClientRect().height], [600, 400]);
    assert.equal(card.getBoundingClientRect().width, cardSize.width);
    const hidden = div({ hidden: '' });
    document.body.append(hidden);
    assert.equal(div().getBoundingClientRect().width, 0, 'detached');
    assert.equal(hidden.getBoundingClientRect().height, 0, 'hidden');
  });

  it('lets modalStack’s focusableWithin skip controls that are not rendered', () => {
    const dialog = div();
    dialog.innerHTML = `
      <button>Shown</button>
      <button hidden>Hidden attribute</button>
      <div style="display: none"><button>In display none</button></div>
      <button style="visibility: hidden">Invisible</button>
      <input value="field">`;
    document.body.append(dialog);
    assert.deepEqual(
      focusableWithin(dialog).map((element) => element.textContent || element.tagName),
      ['Shown', 'INPUT'],
    );
  });

  it('provides getBBox, scrollIntoView, matchMedia and requestAnimationFrame', async () => {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text') as SVGGraphicsElement;
    assert.deepEqual({ ...text.getBBox() }, { x: 0, y: 0, width: 0, height: 0 });
    document.body.scrollIntoView();
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    assert.equal(query.matches, false);
    assert.equal(query.media, '(prefers-color-scheme: dark)');
    const time = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    assert.equal(typeof time, 'number');
  });
});

describe('domEnv: cleanupAfterEach', () => {
  it('renders with Testing Library (first render)', () => {
    render(<p>only one</p>);
    assert.ok(screen.getByText('only one'));
  });

  it('starts each test on an empty body (the last one was unmounted)', () => {
    assert.equal(document.body.innerHTML, '');
    render(<p>only one</p>);
    assert.ok(screen.getByText('only one'));
  });

  it('window.driller throws, naming the fix, until a fake is installed', () => {
    assert.throws(() => window.driller, { message: NO_FAKE_INSTALLED });
    const fake = createFakeDrillerApi();
    fake.install();
    assert.equal(window.driller, fake.api);
  });

  it('a fake installed by the previous test is gone (forgetting install() fails loudly)', () => {
    assert.throws(() => window.driller.listRecentProjects(), { message: NO_FAKE_INSTALLED });
  });

  it('fails the test on an unstubbed call made while unmounting', async () => {
    function SavesOnUnmount() {
      useEffect(
        () => () => {
          void window.driller.setActiveSection('/p', null).catch(() => {});
        },
        [],
      );
      return <p>mounted</p>;
    }
    createFakeDrillerApi().install();
    render(<SavesOnUnmount />);
    await assert.rejects(cleanupAfterEach(), /unstubbed window\.driller calls: setActiveSection/);
  });

  it('expectUnstubbed lets a negative test pass, and fails one whose call never happened', async () => {
    const used = createFakeDrillerApi();
    used.install();
    used.expectUnstubbed('getEntryPins');
    await window.driller.getEntryPins('/p').catch(() => {});
    await cleanupAfterEach();

    const unused = createFakeDrillerApi();
    unused.install();
    unused.expectUnstubbed('getEntryPins');
    await assert.rejects(cleanupAfterEach(), /expectUnstubbed\('getEntryPins'\), but window\.driller\.getEntryPins was never called/);
  });

  it('fails the test on a React warning', async () => {
    const items = ['a', 'b'];
    render(
      <ul>
        {items.map((item) => (
          <li>{item}</li>
        ))}
      </ul>,
    );
    await assert.rejects(cleanupAfterEach(), /console\.error during the test: .*key/);
  });

  it('fails the test on a state update outside act()', async () => {
    let setLater: (value: string) => void = () => {};
    function Later() {
      const [value, setValue] = useState('before');
      setLater = setValue;
      return <p>{value}</p>;
    }
    render(<Later />);
    setLater('after');
    await assert.rejects(cleanupAfterEach(), /console\.error during the test: .*act\(/);
  });

  it('expectConsoleError opts one warning out, and fails when nothing matched it', async () => {
    // React logs each warning once per process, so this one is a direct log.
    expectConsoleError(/deliberate test warning/);
    console.error('deliberate test warning');
    await cleanupAfterEach();

    expectConsoleError(/never logged/);
    await assert.rejects(cleanupAfterEach(), /expectConsoleError\(\/never logged\/\) matched nothing/);
  });

  it('emit runs subscribers inside act: the update is on screen when it returns', () => {
    function ModelState() {
      const [state, setState] = useState('none');
      useEffect(() => window.driller.onModelStatus((status) => setState(status.state)), []);
      return <p>model: {state}</p>;
    }
    const fake = createFakeDrillerApi();
    fake.install();
    render(<ModelState />);
    fake.emit.onModelStatus(READY);
    assert.ok(screen.getByText('model: ready'));
  });
});
