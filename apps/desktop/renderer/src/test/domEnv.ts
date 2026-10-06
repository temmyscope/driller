/**
 * P4-8c: the DOM for `*.dom.test.tsx` / `*.dom.test.ts` files, under
 * `node --test` (no second runner).
 *
 * MUST BE EACH DOM TEST FILE'S FIRST IMPORT, as a bare side-effect import —
 * `import './test/domEnv';` — before anything else (`domTestConventions.test.ts`
 * checks it). React-DOM decides whether a DOM exists when its module loads,
 * and an ES module's imports are evaluated in order, so this module's body
 * has to run before `react-dom` (or anything importing it) is evaluated. A
 * type-only or unused named import can be erased by the compiler, so only
 * the bare form is guaranteed to run first. Named imports from this module
 * (`cleanupAfterEach`, …) go in a second import. For the same reason this
 * module imports nothing from React or Testing Library at the top level
 * (P4-8d: only a dynamic import at its very end, after the DOM is installed,
 * to configure Testing Library — see "React's pending work").
 *
 * Isolation: `node --test` runs each test file in its own process, so the
 * globals installed here never reach the hookless test files.
 *
 * What it installs:
 * - one jsdom window (`pretendToBeVisual`, default `resources`, so no
 *   subresource is ever fetched), its properties copied onto `globalThis`;
 *   the ones Node also defines (`navigator`, Web Storage, `Event`, …) are
 *   replaced by jsdom's. `pretendToBeVisual` supplies
 *   `requestAnimationFrame`.
 * - the browser APIs jsdom lacks that React Flow and the app need:
 *   `ResizeObserver` (controllable: nothing fires until a test calls
 *   `resizeObservers.resizeAll`), `DOMMatrixReadOnly`, `offsetWidth`/
 *   `offsetHeight` (see "Sizes"), `getClientRects`, `getBoundingClientRect`,
 *   `getBBox`, `matchMedia`, `scrollIntoView` and (P4-8e) pointer capture
 *   (`setPointerCapture`/`hasPointerCapture`/`releasePointerCapture`,
 *   recorded per element; no capture events are dispatched);
 * - `IS_REACT_ACT_ENVIRONMENT`, so React routes updates through `act`;
 * - `window.driller`, which throws until a fake is installed
 *   (`createFakeDrillerApi(...).install()`).
 *
 * Sizes. There is no layout: every element reports a fixed size.
 * `.react-flow__node` elements (and anything inside one) report `cardSize`,
 * default 200×80 — `CodeMap`'s own estimate of a rendered card
 * (`NODE_CARD_FALLBACK_WIDTH`/`HEIGHT`). Every other element reports
 * `elementSize`, default 1200×800, which is what React Flow measures its
 * container as. Which cards are drawn (React Flow's
 * `onlyRenderVisibleElements` culling), edge positions and every fit depend
 * on these two settings; a test that changes them changes what is drawn.
 * Both reset after each test.
 *
 * CSS. App stylesheets are never applied: the test loader stubs `.css`
 * imports. So a class-based `display: none` never hides anything here; only
 * the `hidden` attribute and inline `style` do (that is what
 * `getClientRects` checks). Never assert CSS layout in jsdom; CSS stays
 * pinned by the existing source checks.
 *
 * Mixed realms. Only the globals listed in `REPLACED_NODE_GLOBALS` are
 * swapped for jsdom's. Others stay Node's — `AbortController`/`AbortSignal`,
 * `URL`, `Blob`, `fetch`, `structuredClone` — so e.g. a Node `AbortSignal`
 * passed to a jsdom `addEventListener` may be rejected. Use jsdom's
 * (`window.AbortController`) when one has to cross over.
 *
 * P4-8e: `resizeObservers.resizeElement(target, w, h)` fires only the
 * observers of one element (`resizeAll` fires every observer).
 *
 * P4-8d additions:
 * - `waitFor`/`findBy…` keep the act environment off until React's queued
 *   scheduler tasks have run (`drainPendingImmediates`), so a big render
 *   finishing after the wait never warns "not wrapped in act(...)".
 * - `cleanupAfterEach` lets a React Flow animated move still running finish
 *   (at most `ANIMATION_SETTLE_MS`), then interrupts it, before the unmount —
 *   a test that fails mid-move can't hold its file open.
 * - Never `assert.equal`/`strictEqual` two DOM elements: on failure
 *   `node:assert` diffs both jsdom object graphs, which takes minutes and
 *   looks like a hang. Use `assertSameElement(actual, expected, what)`.
 *
 * Each test, via `afterEach(cleanupAfterEach)`, fails when it:
 * - left an unstubbed `window.driller` call (made during the test or its
 *   unmount) that it didn't declare with `fake.expectUnstubbed(name)`;
 * - logged a `console.error` (every React warning, `act()` ones included)
 *   that it didn't declare with `expectConsoleError(pattern)`.
 */
import { after } from 'node:test';
import { format } from 'node:util';
import { JSDOM } from 'jsdom';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  // A non-opaque origin, so `localStorage` exists. Loopback, and nothing is
  // ever loaded from it (default `resources`).
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const domWindow = dom.window;

/**
 * Globals Node defines itself (on some or all of Node 22–25) that must be
 * jsdom's in a DOM test: `navigator` and Web Storage are the browser's, and
 * React and Testing Library dispatch jsdom events, which jsdom only accepts
 * as its own `Event` instances. Everything Node lacks (`window`,
 * `document`, `HTMLElement`, …) is copied by the loop below.
 */
const REPLACED_NODE_GLOBALS = [
  'navigator',
  'localStorage',
  'sessionStorage',
  'Event',
  'EventTarget',
  'CustomEvent',
  'MessageEvent',
] as const;

function defineGlobal(name: string, get: () => unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, get, set: undefined });
}

for (const name of Object.getOwnPropertyNames(domWindow)) {
  if (name.startsWith('_') || name in globalThis) {
    continue;
  }
  defineGlobal(name, () => domWindow[name as keyof typeof domWindow]);
}
for (const name of REPLACED_NODE_GLOBALS) {
  defineGlobal(name, () => domWindow[name]);
}

// ---------------------------------------------------------------------------
// Sizes: what `offsetWidth`/`offsetHeight` report (see the header).
// ---------------------------------------------------------------------------

interface SettableSize {
  readonly width: number;
  readonly height: number;
  set(width: number, height: number): void;
  reset(): void;
}

function settableSize(defaultWidth: number, defaultHeight: number): SettableSize {
  let width = defaultWidth;
  let height = defaultHeight;
  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    set(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
    },
    reset() {
      width = defaultWidth;
      height = defaultHeight;
    },
  };
}

/** Every element's size except React Flow Node cards; default 1200×800. */
export const elementSize = settableSize(1200, 800);
/**
 * A React Flow Node card's size (`.react-flow__node` and its contents);
 * default 200×80, `CodeMap`'s `NODE_CARD_FALLBACK_WIDTH`/`HEIGHT`
 * (`domEnv.dom.test.tsx` checks the two agree).
 */
export const cardSize = settableSize(200, 80);

const CARD_SELECTOR = '.react-flow__node';

/** The size `element` reports. */
export function sizeOf(element: Element): { width: number; height: number } {
  const size = element.closest(CARD_SELECTOR) ? cardSize : elementSize;
  return { width: size.width, height: size.height };
}

Object.defineProperty(domWindow.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement) {
    return sizeOf(this).width;
  },
});
Object.defineProperty(domWindow.HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return sizeOf(this).height;
  },
});

function rect(width: number, height: number): DOMRectReadOnly {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({ x: 0, y: 0, width, height }),
  };
}

/**
 * Whether `element` would be rendered: connected, and neither it nor an
 * ancestor has the `hidden` attribute or a computed `display: none` (inline
 * styles only — see "CSS" in the header). jsdom's own UA stylesheet already
 * computes `[hidden]` as `display: none`; the attribute check is explicit anyway.
 */
function isRendered(element: Element): boolean {
  if (!element.isConnected) {
    return false;
  }
  for (let current: Element | null = element; current !== null; current = current.parentElement) {
    if (current.hasAttribute('hidden') || domWindow.getComputedStyle(current).display === 'none') {
      return false;
    }
  }
  return true;
}

// `modalStack`'s `focusableWithin` treats an element with no client rects as
// not rendered; jsdom always returns none.
Object.defineProperty(domWindow.Element.prototype, 'getClientRects', {
  configurable: true,
  value(this: Element): DOMRectList {
    const rects: DOMRectReadOnly[] = isRendered(this) ? [rect(sizeOf(this).width, sizeOf(this).height)] : [];
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList;
  },
});

// P4-8d: React Flow's pan/zoom caches its pane's extent from
// `getBoundingClientRect` at mount, and d3-zoom interpolates every animated
// move (`setCenter`/`setViewport` with a `duration`) over it. jsdom's 0×0
// made each animated step's zoom NaN. Same size as `getClientRects`, at the
// origin (there is no layout).
Object.defineProperty(domWindow.Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value(this: Element): DOMRect {
    const { width, height } = isRendered(this) ? sizeOf(this) : { width: 0, height: 0 };
    return rect(width, height) as DOMRect;
  },
});

// ---------------------------------------------------------------------------
// ResizeObserver: controllable. Observing reports nothing by itself; a test
// calls `resizeObservers.resizeAll(w, h)` (inside `act`) to fire every live
// observer for every element it observes.
// ---------------------------------------------------------------------------

const liveObservers = new Set<FakeResizeObserver>();

class FakeResizeObserver implements ResizeObserver {
  readonly #callback: ResizeObserverCallback;
  readonly #targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  observe(target: Element): void {
    this.#targets.add(target);
    liveObservers.add(this);
  }

  unobserve(target: Element): void {
    this.#targets.delete(target);
    if (this.#targets.size === 0) {
      liveObservers.delete(this);
    }
  }

  disconnect(): void {
    this.#targets.clear();
    liveObservers.delete(this);
  }

  /** Fires this observer's callback once, with one entry per observed element, at its current size. */
  fire(): void {
    if (this.#targets.size === 0) {
      return;
    }
    this.#callback([...this.#targets].map(resizeEntry), this);
  }

  /** P4-8e: fires this observer's callback with `entry` alone, if it observes `target`. */
  fireFor(target: Element, entry: ResizeObserverEntry): void {
    if (this.#targets.has(target)) {
      this.#callback([entry], this);
    }
  }
}

function resizeEntry(target: Element): ResizeObserverEntry {
  const { width, height } = sizeOf(target);
  const box: ResizeObserverSize = { inlineSize: width, blockSize: height };
  return {
    target,
    contentRect: rect(width, height),
    borderBoxSize: [box],
    contentBoxSize: [box],
    devicePixelContentBoxSize: [box],
  };
}

export const resizeObservers = {
  /**
   * Sets `elementSize` to `width`×`height`, then fires every live observer
   * once, each entry carrying its element's size (`sizeOf`: a card keeps
   * `cardSize`). Call inside `act`.
   */
  resizeAll(width: number, height: number): void {
    elementSize.set(width, height);
    for (const observer of [...liveObservers]) {
      observer.fire();
    }
  },
  /**
   * P4-8e: one element resized on its own — fires only the live observers
   * that observe `target`, each with one entry for it at `width`×`height`
   * (e.g. the canvas frame shrinking while `.code-map` keeps its height).
   * `elementSize` is unchanged. Call inside `act`.
   */
  resizeElement(target: Element, width: number, height: number): void {
    const box: ResizeObserverSize = { inlineSize: width, blockSize: height };
    const entry: ResizeObserverEntry = {
      target,
      contentRect: rect(width, height),
      borderBoxSize: [box],
      contentBoxSize: [box],
      devicePixelContentBoxSize: [box],
    };
    for (const observer of [...liveObservers]) {
      observer.fireFor(target, entry);
    }
  },
  /** How many observers are observing at least one element. */
  get liveCount(): number {
    return liveObservers.size;
  },
};

defineGlobal('ResizeObserver', () => FakeResizeObserver);
Object.defineProperty(domWindow, 'ResizeObserver', { configurable: true, value: FakeResizeObserver });

// ---------------------------------------------------------------------------
// DOMMatrixReadOnly: React Flow reads the zoom (`m22`) of its viewport's
// `transform` (`translate(x px, y px) scale(z)`). Parses `matrix(...)`,
// `translate(...)` and `scale(...)` — the forms React Flow writes.
// ---------------------------------------------------------------------------

class FakeDOMMatrixReadOnly {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;

  constructor(init?: string | readonly number[]) {
    let [a, b, c, d, e, f] = [1, 0, 0, 1, 0, 0];
    if (Array.isArray(init) && init.length >= 6) {
      [a, b, c, d, e, f] = init as [number, number, number, number, number, number];
    } else if (typeof init === 'string') {
      for (const [, fn, rawArgs] of init.matchAll(/(\w+)\(([^)]*)\)/g)) {
        const args = (rawArgs ?? '').split(/[\s,]+/).filter(Boolean).map((value) => Number.parseFloat(value));
        if (fn === 'matrix' && args.length === 6) {
          [a, b, c, d, e, f] = args as [number, number, number, number, number, number];
        } else if (fn === 'translate') {
          e += args[0] ?? 0;
          f += args[1] ?? 0;
        } else if (fn === 'scale') {
          const sx = args[0] ?? 1;
          const sy = args[1] ?? sx;
          a *= sx;
          b *= sx;
          c *= sy;
          d *= sy;
        }
      }
    }
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.e = e;
    this.f = f;
  }

  get m11(): number {
    return this.a;
  }
  get m12(): number {
    return this.b;
  }
  get m21(): number {
    return this.c;
  }
  get m22(): number {
    return this.d;
  }
  get m41(): number {
    return this.e;
  }
  get m42(): number {
    return this.f;
  }
  get is2D(): boolean {
    return true;
  }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
}

for (const name of ['DOMMatrixReadOnly', 'DOMMatrix'] as const) {
  if (!(name in domWindow)) {
    Object.defineProperty(domWindow, name, { configurable: true, value: FakeDOMMatrixReadOnly });
    defineGlobal(name, () => FakeDOMMatrixReadOnly);
  }
}

// ---------------------------------------------------------------------------
// The rest: no layout, so every answer is an empty one.
// ---------------------------------------------------------------------------

if (!('getBBox' in domWindow.SVGElement.prototype)) {
  Object.defineProperty(domWindow.SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
}

// P4-8e: pointer capture, which jsdom lacks (the PR Review table divider
// captures the pointer for its drag). Captures are only recorded per element:
// no `gotpointercapture`/`lostpointercapture` event is dispatched, and events
// are not retargeted — a test fires the drag's pointer events on the element
// itself.
if (!('setPointerCapture' in domWindow.Element.prototype)) {
  const captures = new WeakMap<Element, Set<number>>();
  const capturesOf = (element: Element): Set<number> => {
    const set = captures.get(element) ?? new Set<number>();
    captures.set(element, set);
    return set;
  };
  Object.defineProperties(domWindow.Element.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        capturesOf(this).add(pointerId);
      },
    },
    hasPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        return capturesOf(this).has(pointerId);
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) {
        capturesOf(this).delete(pointerId);
      },
    },
  });
}

if (!('scrollIntoView' in domWindow.Element.prototype)) {
  Object.defineProperty(domWindow.Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
}

if (typeof domWindow.matchMedia !== 'function') {
  const matchMedia = (query: string): MediaQueryList => {
    const list = new domWindow.EventTarget() as MediaQueryList;
    return Object.assign(list, {
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
    });
  };
  Object.defineProperty(domWindow, 'matchMedia', { configurable: true, value: matchMedia });
  defineGlobal('matchMedia', () => matchMedia);
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// P4-8d: React's pending work. React's scheduler runs renders, commits and
// passive effects in `setImmediate` tasks, and yields every ~5 ms, so a big
// render (a 300-Node map) continues in later tasks. Testing Library's
// `waitFor`/`findBy…` turn `IS_REACT_ACT_ENVIRONMENT` off while they wait
// and back on one `setTimeout(0)` after the condition passes — which can be
// before React's queued tasks have run. Those tasks then update state with
// the act environment on and outside `act`: an "not wrapped in act(...)"
// warning, which fails the test (seen on Node 22, where the timing differs).
// So every `setImmediate` still pending is counted (the scheduler captures
// `setImmediate` when it loads, after this module ran), and `waitFor` drains
// them before it turns the act environment back on (see the end of this file).
// ---------------------------------------------------------------------------

const nodeSetImmediate = globalThis.setImmediate;
const nodeClearImmediate = globalThis.clearImmediate;
const pendingImmediates = new Set<NodeJS.Immediate>();

const trackedSetImmediate = <TArgs extends unknown[]>(callback: (...args: TArgs) => void, ...args: TArgs): NodeJS.Immediate => {
  const handle: NodeJS.Immediate = nodeSetImmediate(() => {
    pendingImmediates.delete(handle);
    callback(...args);
  });
  pendingImmediates.add(handle);
  return handle;
};
globalThis.setImmediate = Object.assign(trackedSetImmediate, {
  __promisify__: nodeSetImmediate.__promisify__,
}) as typeof setImmediate;
globalThis.clearImmediate = ((handle: NodeJS.Immediate | undefined) => {
  if (handle !== undefined) {
    pendingImmediates.delete(handle);
  }
  nodeClearImmediate(handle);
}) as typeof clearImmediate;

/** At most this many task turns per drain: a render that keeps rescheduling itself can't hang a test. */
const MAX_DRAIN_TURNS = 1_000;

/**
 * Lets every pending `setImmediate` task (React's scheduler: renders,
 * commits, passive effects) run, including the ones those schedule, up to
 * `MAX_DRAIN_TURNS` turns. Returns whether the queue emptied.
 */
export async function drainPendingImmediates(): Promise<boolean> {
  for (let turn = 0; turn < MAX_DRAIN_TURNS; turn += 1) {
    if (pendingImmediates.size === 0) {
      return true;
    }
    await new Promise<void>((resolve) => nodeSetImmediate(resolve));
  }
  return pendingImmediates.size === 0;
}

// ---------------------------------------------------------------------------
// window.driller: the installed fake, or a loud error. `fakeDrillerApi.ts`'s
// `install()` fills the slot (it can't import this module: non-DOM tests
// import the fake too).
// ---------------------------------------------------------------------------

/** What `cleanupAfterEach` needs of an installed fake. */
export interface InstalledFake {
  readonly api: unknown;
  assertNoUnstubbedCalls(): void;
}

/** Shared with `fakeDrillerApi.ts` by key, not by import. */
export const FAKE_SLOT_KEY = Symbol.for('driller.test.installedFakeDrillerApi');

interface FakeSlot {
  current: InstalledFake | null;
}

const fakeSlot: FakeSlot = { current: null };
(globalThis as Record<symbol, unknown>)[FAKE_SLOT_KEY] = fakeSlot;

export const NO_FAKE_INSTALLED =
  'window.driller has no fake installed: call createFakeDrillerApi(...).install() in this test';

Object.defineProperty(domWindow, 'driller', {
  configurable: true,
  get() {
    if (fakeSlot.current === null) {
      throw new Error(NO_FAKE_INSTALLED);
    }
    return fakeSlot.current.api;
  },
});

// ---------------------------------------------------------------------------
// console.error: recorded per test (and still printed). React reports every
// warning — `act()` ones included — through it.
// ---------------------------------------------------------------------------

const consoleErrors: string[] = [];
const expectedConsoleErrors: { pattern: RegExp; seen: boolean }[] = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  consoleErrors.push(format(...args));
  originalConsoleError(...args);
};

/**
 * Opts this test out of failing on `console.error` output matching
 * `pattern`. The test still fails if nothing matched it, so an opt-out
 * can't outlive the warning it was for.
 */
export function expectConsoleError(pattern: RegExp): void {
  expectedConsoleErrors.push({ pattern, seen: false });
}

function consoleErrorProblems(): string[] {
  const unexpected = consoleErrors.filter((message) => {
    const expectation = expectedConsoleErrors.find(({ pattern }) => pattern.test(message));
    if (expectation) {
      expectation.seen = true;
      return false;
    }
    return true;
  });
  const problems = unexpected.map((message) => `console.error during the test: ${message.split('\n')[0]}`);
  for (const { pattern, seen } of expectedConsoleErrors) {
    if (!seen) {
      problems.push(`expectConsoleError(${pattern}) matched nothing`);
    }
  }
  consoleErrors.length = 0;
  expectedConsoleErrors.length = 0;
  return problems;
}

/**
 * Call with `afterEach(cleanupAfterEach)` in every DOM test file. Testing
 * Library's auto-cleanup registers itself only when a global `afterEach`
 * exists, which `node:test` doesn't provide — without this, a second test
 * sees the first one's rendered tree.
 *
 * Unmounts (RTL `cleanup`), empties `<body>`, resets both sizes, then uninstalls the fake and
 * fails the test — after the unmount, so calls made by effect cleanups
 * count — on any unstubbed `window.driller` call or `console.error` it
 * didn't declare (see the header).
 */
export async function cleanupAfterEach(): Promise<void> {
  // Imported here, not at the top: see the header.
  const { cleanup } = await import('@testing-library/react');
  const problems: string[] = [];
  await finishViewportAnimations();
  try {
    cleanup();
    // Anything a test appended by hand (RTL removes only its own containers).
    document.body.replaceChildren();
  } finally {
    elementSize.reset();
    cardSize.reset();
    const fake = fakeSlot.current;
    fakeSlot.current = null;
    if (fake !== null) {
      try {
        fake.assertNoUnstubbedCalls();
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    problems.push(...consoleErrorProblems());
  }
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// P4-8d: React Flow's animated moves (`setCenter`/`setViewport` with a
// `duration`: d3 transitions driven by this window's animation frames).
// ---------------------------------------------------------------------------

/** How long `cleanupAfterEach` lets a running animation finish before it stops it. React Flow's moves take 300 ms. */
export const ANIMATION_SETTLE_MS = 500;

/** The elements a d3 transition is scheduled or running on (d3 keeps it in `__transition`). */
export function animatingElements(): Element[] {
  return [...document.querySelectorAll('*')].filter((element) => '__transition' in element);
}

/**
 * Before the unmount: lets a viewport animation still running (a test that
 * passed without waiting for it, or failed mid-move) finish, for at most
 * `ANIMATION_SETTLE_MS`, then interrupts whatever is left. Otherwise the
 * move would update the next test's tree — or, past the last test, d3 would
 * wait forever for a frame from the closed window, holding the file's
 * process open until the runner's 240 s limit. The act environment is off
 * meanwhile, as in `waitFor`: these updates belong to no test step.
 */
async function finishViewportAnimations(): Promise<void> {
  if (animatingElements().length === 0) {
    return;
  }
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    const deadline = performance.now() + ANIMATION_SETTLE_MS;
    while (animatingElements().length > 0 && performance.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    const left = animatingElements();
    if (left.length > 0) {
      const { interrupt } = await import('d3-transition');
      for (const element of left) {
        interrupt(element);
      }
    }
    await drainPendingImmediates();
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

/**
 * P4-8d: asserts that `actual` is `expected` (the same element). Use it — or
 * `assert.ok(a === b, message)` — instead of `assert.equal`/`strictEqual` on
 * two DOM elements: on failure `node:assert` diffs both jsdom object graphs,
 * which takes minutes and looks like a hang.
 */
export function assertSameElement(actual: Element | null | undefined, expected: Element | null | undefined, what: string): void {
  if (actual === expected && actual !== null && actual !== undefined) {
    return;
  }
  throw new Error(`${what}: expected ${describeElement(expected)}, got ${describeElement(actual)}`);
}

function describeElement(element: Element | null | undefined): string {
  if (element === null || element === undefined) {
    return String(element);
  }
  const label = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? '';
  return `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> ${label}`;
}

// P4-8d: Testing Library's `waitFor`/`findBy…` also drain React's pending
// tasks before the act environment is turned back on (see "React's pending
// work" above). Imported dynamically, here at the end, for the reason in the
// header: everything above has installed the DOM by now.
{
  const testingLibrary = await import('@testing-library/react');
  testingLibrary.configure({
    // Testing Library's own wrapper, plus the drain: the act environment is
    // off while waiting, then — after one `setTimeout(0)` (its microtask
    // drain) and every React task queued meanwhile, repeated until a turn
    // queues none — back on.
    asyncWrapper: async (callback) => {
      const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
      try {
        const result: unknown = await callback();
        for (let round = 0; round < MAX_DRAIN_TURNS; round += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (pendingImmediates.size === 0) {
            break;
          }
          await drainPendingImmediates();
        }
        return result;
      } finally {
        globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
      }
    },
  });
}

// The window's timers would keep the test file's process alive once its
// tests are done. (Defensive: no test leaves one pending today.)
after(() => {
  domWindow.close();
});
