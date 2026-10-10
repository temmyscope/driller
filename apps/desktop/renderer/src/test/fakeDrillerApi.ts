/**
 * P4-8c: a fake `window.driller` for DOM tests, typed against the real
 * `DrillerApi` contract.
 *
 * - Every member is listed in one object literal checked with
 *   `satisfies DrillerApi`, so adding, removing or renaming a contract
 *   member breaks this file at typecheck, and a stub's signature is the
 *   contract's own.
 * - A request method with no stub REJECTS with
 *   `fake window.driller.<name> not stubbed` and is recorded in
 *   `unstubbedCalls` — a component that catches the rejection still can't
 *   hide the call: `assertNoUnstubbedCalls()` fails naming it. Never a
 *   silent `undefined`.
 * - Stubs are per fake (`createFakeDrillerApi(stubs)`, one fake per test),
 *   and `stub(name, impl)` replaces one later.
 * - Every call is recorded with its arguments: `fake.calls.getCodeMap`.
 * - Subscriptions (`on…`) always work: `fake.emit.onModelStatus(payload)`
 *   calls every live subscriber, and the returned unsubscribe removes one.
 *   In a DOM test (`IS_REACT_ACT_ENVIRONMENT`) each `emit` runs inside
 *   React's `act`, so the state updates it causes are flushed before it
 *   returns; elsewhere it calls the subscribers directly.
 * - `install()` makes it `window.driller` for the current DOM test only.
 *   `domEnv`'s `cleanupAfterEach` uninstalls it after the unmount and fails
 *   the test on any unstubbed call, unless the test declared it with
 *   `expectUnstubbed(name)` (a negative test), which in turn fails if that
 *   call never happened.
 *
 * Test-only: never imported by app code (`domTestConventions.test.ts`).
 */
import { act } from 'react';
import { ENTRY_PINS_MAX, type DrillerApi, type EntryPinUpdateResult } from '@driller/ipc-contracts';

/** The subscription members (`onGraphServiceStatus`, …). */
export type DrillerEventName = Extract<keyof DrillerApi, `on${string}`>;
/** The request members: everything that returns a promise. */
export type DrillerMethodName = Exclude<keyof DrillerApi, DrillerEventName>;

type EventCallback<K extends DrillerEventName> = Parameters<DrillerApi[K]>[0];
type EventPayload<K extends DrillerEventName> = Parameters<EventCallback<K>>;

export type DrillerStubs = { [K in DrillerMethodName]?: DrillerApi[K] };

export interface FakeDrillerApi {
  /** The object to expose as `window.driller` (`install()` does it). */
  readonly api: DrillerApi;
  /** Every call so far, per member, in order, with its arguments. */
  readonly calls: { readonly [K in keyof DrillerApi]: Parameters<DrillerApi[K]>[] };
  /** Calls every live subscriber of one `on…` member with `payload`. */
  readonly emit: { readonly [K in DrillerEventName]: (...payload: EventPayload<K>) => void };
  /** How many subscribers one `on…` member has right now. */
  subscriberCount(name: DrillerEventName): number;
  /** Request members called with no stub, in call order. */
  readonly unstubbedCalls: readonly DrillerMethodName[];
  /**
   * Throws naming every request member called with no stub, except those
   * declared with `expectUnstubbed`, and every declared one never called.
   */
  assertNoUnstubbedCalls(): void;
  /** Declares that this test calls `name` unstubbed on purpose (a negative test). */
  expectUnstubbed(name: DrillerMethodName): void;
  /** Sets (or replaces) one member's stub. */
  stub<K extends DrillerMethodName>(name: K, impl: DrillerApi[K]): void;
  /** Makes `api` the current DOM test's `window.driller` (needs `src/test/domEnv`). */
  install(): void;
}

/** `domEnv`'s slot for the installed fake (shared by key: see `domEnv.ts`). */
const FAKE_SLOT_KEY = Symbol.for('driller.test.installedFakeDrillerApi');

export const INSTALL_NEEDS_DOM_ENV = 'install() needs the DOM environment: import ./test/domEnv first';

export function notStubbedMessage(name: string): string {
  return `fake window.driller.${name} not stubbed`;
}

export function createFakeDrillerApi(initialStubs: DrillerStubs = {}): FakeDrillerApi {
  const stubs = new Map<DrillerMethodName, unknown>(Object.entries(initialStubs) as [DrillerMethodName, unknown][]);
  const calls = new Map<keyof DrillerApi, unknown[][]>();
  const subscribers = new Map<DrillerEventName, Set<(...payload: unknown[]) => void>>();
  const unstubbedCalls: DrillerMethodName[] = [];
  const expectedUnstubbed = new Set<DrillerMethodName>();

  const record = (name: keyof DrillerApi, args: unknown[]): void => {
    const list = calls.get(name) ?? [];
    list.push(args);
    calls.set(name, list);
  };

  function method<K extends DrillerMethodName>(name: K): DrillerApi[K] {
    const call = (...args: unknown[]): Promise<unknown> => {
      record(name, args);
      const impl = stubs.get(name);
      if (typeof impl !== 'function') {
        unstubbedCalls.push(name);
        return Promise.reject(new Error(notStubbedMessage(name)));
      }
      try {
        return Promise.resolve(impl(...args));
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return call as DrillerApi[K];
  }

  function event<K extends DrillerEventName>(name: K): DrillerApi[K] {
    const subscribe = (callback: (...payload: unknown[]) => void): (() => void) => {
      record(name, [callback]);
      const set = subscribers.get(name) ?? new Set();
      set.add(callback);
      subscribers.set(name, set);
      return () => {
        set.delete(callback);
      };
    };
    return subscribe as DrillerApi[K];
  }

  const api = {
    openFolder: method('openFolder'),
    openRecentProject: method('openRecentProject'),
    listRecentProjects: method('listRecentProjects'),
    restartGraphService: method('restartGraphService'),
    retryLocalModel: method('retryLocalModel'),
    onGraphServiceStatus: event('onGraphServiceStatus'),
    onModelStatus: event('onModelStatus'),
    onSummaryProgress: event('onSummaryProgress'),
    onLlmJudgmentProgress: event('onLlmJudgmentProgress'),
    onHardwareAdvisory: event('onHardwareAdvisory'),
    onMcpServerStatus: event('onMcpServerStatus'),
    onMenuOpenFolder: event('onMenuOpenFolder'),
    getCodeMap: method('getCodeMap'),
    readSourceRange: method('readSourceRange'),
    openInEditor: method('openInEditor'),
    getBackendConfig: method('getBackendConfig'),
    setActiveBackend: method('setActiveBackend'),
    setCloudApiKey: method('setCloudApiKey'),
    clearCloudApiKey: method('clearCloudApiKey'),
    getEditorPreference: method('getEditorPreference'),
    setEditorPreference: method('setEditorPreference'),
    getPrBotConfig: method('getPrBotConfig'),
    setPrBotEnabled: method('setPrBotEnabled'),
    getProjectScope: method('getProjectScope'),
    setProjectScope: method('setProjectScope'),
    getShowFoldedKinds: method('getShowFoldedKinds'),
    setShowFoldedKinds: method('setShowFoldedKinds'),
    getActiveSection: method('getActiveSection'),
    setActiveSection: method('setActiveSection'),
    getEntryPins: method('getEntryPins'),
    setEntryPins: method('setEntryPins'),
    runPrBotIngestion: method('runPrBotIngestion'),
    regenerateNode: method('regenerateNode'),
    tracePath: method('tracePath'),
    logDiagnosticEvent: method('logDiagnosticEvent'),
    computeDiffScope: method('computeDiffScope'),
    expandBlastRadius: method('expandBlastRadius'),
    listEntryCandidates: method('listEntryCandidates'),
    checkDiffScopeCarry: method('checkDiffScopeCarry'),
  } satisfies DrillerApi;

  const memberNames = Object.keys(api) as (keyof DrillerApi)[];
  const eventNames = memberNames.filter((name): name is DrillerEventName => name.startsWith('on'));

  const callsView = Object.fromEntries(
    memberNames.map((name) => [name, undefined]),
  ) as unknown as FakeDrillerApi['calls'];
  for (const name of memberNames) {
    Object.defineProperty(callsView, name, { enumerable: true, get: () => [...(calls.get(name) ?? [])] });
  }

  const emit = Object.fromEntries(
    eventNames.map((name) => [
      name,
      (...payload: unknown[]) => {
        const deliver = () => {
          for (const callback of [...(subscribers.get(name) ?? [])]) {
            callback(...payload);
          }
        };
        if (globalThis.IS_REACT_ACT_ENVIRONMENT === true) {
          act(deliver);
        } else {
          deliver();
        }
      },
    ]),
  ) as unknown as FakeDrillerApi['emit'];

  const fake: FakeDrillerApi = {
    api,
    calls: callsView,
    emit,
    subscriberCount: (name) => subscribers.get(name)?.size ?? 0,
    get unstubbedCalls() {
      return [...unstubbedCalls];
    },
    assertNoUnstubbedCalls() {
      const called = new Set(unstubbedCalls);
      const unexpected = [...called].filter((name) => !expectedUnstubbed.has(name));
      const missing = [...expectedUnstubbed].filter((name) => !called.has(name));
      const problems = [
        ...(unexpected.length > 0
          ? [`unstubbed window.driller calls: ${unexpected.join(', ')} (${unexpected.map(notStubbedMessage).join('; ')})`]
          : []),
        ...missing.map((name) => `expectUnstubbed('${name}'), but window.driller.${name} was never called`),
      ];
      if (problems.length > 0) {
        throw new Error(problems.join('\n'));
      }
    },
    expectUnstubbed(name) {
      expectedUnstubbed.add(name);
    },
    stub(name, impl) {
      stubs.set(name, impl);
    },
    install() {
      const slot = (globalThis as Record<symbol, { current: unknown } | undefined>)[FAKE_SLOT_KEY];
      if (slot === undefined) {
        throw new Error(INSTALL_NEEDS_DOM_ENV);
      }
      slot.current = fake;
    },
  };
  return fake;
}

/**
 * P4-8d: a promise a test settles by hand — for a stub whose reply must
 * land later, or out of order with another (`getCodeMap` for two sections).
 * Settle it inside React's `act` (or before a `waitFor`/`findBy…`), like any
 * other reply that updates the UI.
 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * P4-8g: the entry pins main keeps (AD-5 "Entry pins"), keyed by project —
 * `getEntryPins` / `setEntryPins` stubs that behave as main's
 * `settings:getEntryPins` / `settings:setEntryPins` do: a pin is appended
 * (pin order), an unpin removes it, a repeat changes nothing, and a pin past
 * `ENTRY_PINS_MAX` is refused with `limit` and the stored list. Pass
 * `stubs` into `createFakeDrillerApi` (the calls are recorded there);
 * `pinsOf` reads what is stored now.
 */
export interface EntryPinsStore {
  readonly stubs: Required<Pick<DrillerStubs, 'getEntryPins' | 'setEntryPins'>>;
  pinsOf(projectPath: string): string[];
}

export function entryPinsStore(initial: Readonly<Record<string, readonly string[]>> = {}): EntryPinsStore {
  const byProject = new Map<string, string[]>(Object.entries(initial).map(([project, ids]) => [project, [...ids]]));
  const pinsOf = (projectPath: string): string[] => [...(byProject.get(projectPath) ?? [])];
  return {
    pinsOf,
    stubs: {
      getEntryPins: async (projectPath) => pinsOf(projectPath),
      setEntryPins: async (projectPath, nodeId, pinned): Promise<EntryPinUpdateResult> => {
        const pins = pinsOf(projectPath);
        if (pinned && !pins.includes(nodeId)) {
          if (pins.length >= ENTRY_PINS_MAX) {
            return { status: 'limit', pins };
          }
          pins.push(nodeId);
        }
        const stored = pinned ? pins : pins.filter((id) => id !== nodeId);
        byProject.set(projectPath, stored);
        return { status: 'stored', pins: [...stored] };
      },
    },
  };
}
