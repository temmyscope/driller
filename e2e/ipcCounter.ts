/**
 * P4-8i: counts `window.driller` calls from the page side, with no app hook.
 *
 * `window.driller` is the preload's `contextBridge` API: a frozen,
 * non-configurable object in the page's main world, so it can't be wrapped
 * there. Every one of its methods is a thin forward to
 * `ipcRenderer.invoke(<channel>, …)` in the preload's isolated world
 * (`apps/desktop/preload/index.ts`), looked up on each call. So the counter
 * works one level down, still inside the page (renderer) process and only
 * through CDP:
 *
 * 1. `Runtime.enable` lists the page's execution contexts; the preload's
 *    isolated world is the non-default one of the main frame.
 * 2. `Runtime.addBinding` adds a binding to that world.
 * 3. `Runtime.queryObjects` finds that world's `ipcRenderer` (the object with
 *    `invoke`, `sendSync` and `on`), and its `invoke` is wrapped in place so
 *    each call first reports `{channel, args}` through the binding. The call
 *    is otherwise unchanged: same arguments, same return value.
 *
 * A call is named by its preload method (`expandBlastRadius`), mapped from
 * the IPC channel with `IpcChannels` and the preload's source, so a journey
 * reads `count('expandBlastRadius')`. Binding events and `Runtime.evaluate`
 * replies travel on one CDP session in order, so `calls()` round-trips an
 * evaluate first: every call the page made before it is counted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CDPSession, Page } from 'playwright-core';

import { IpcChannels } from '../packages/ipc-contracts/src/index';

export const IPC_BINDING = '__drillerE2eIpc';
/** The execution-context name Electron gives the preload's isolated world. */
export const ELECTRON_ISOLATED_WORLD = 'Electron Isolated Context';

const PRELOAD_SOURCE = fileURLToPath(new URL('../apps/desktop/preload/index.ts', import.meta.url));

export interface IpcCall {
  /** The `window.driller` method (or the raw channel when no method forwards to it). */
  method: string;
  channel: string;
  /** The call's arguments, when JSON-serialisable. */
  args?: unknown[];
  /** Page time of the call (ms). */
  at: number;
  /**
   * Page time the call's promise settled (ms), once it has. Live pass
   * 2026-10-19: a journey waiting for a refetch must wait for its reply, not
   * its start (the Graph Service caches the map only when the fetch lands).
   */
  settledAt?: number;
}

export interface IpcCounter {
  /** Every counted call so far, oldest first (after a round trip, so nothing in flight is missed). */
  calls: () => Promise<IpcCall[]>;
  /** How many calls to `method` so far. */
  count: (method: string) => Promise<number>;
  /** Stops listening. The page's wrapper stays: with the binding gone it only skips reporting. */
  dispose: () => Promise<void>;
}

/**
 * channel → `window.driller` method, read from the preload source: each
 * method's body names its `IpcChannels.<key>`. A channel two methods share
 * maps to the first.
 */
export function channelToMethod(preloadSource: string, channels: Readonly<Record<string, string>>): Map<string, string> {
  const map = new Map<string, string>();
  const body = preloadSource.slice(preloadSource.indexOf('const drillerApi'));
  const methodPattern = /^ {2}(\w+): (?:async )?\(/gm;
  const starts = [...body.matchAll(methodPattern)].map((m) => ({ name: m[1]!, index: m.index }));
  starts.forEach((start, i) => {
    const text = body.slice(start.index, starts[i + 1]?.index ?? body.length);
    for (const match of text.matchAll(/ipcRenderer\.invoke\(\s*IpcChannels\.(\w+)/g)) {
      const channel = channels[match[1]!];
      if (channel !== undefined && !map.has(channel)) map.set(channel, start.name);
    }
  });
  return map;
}

/**
 * Runs in the isolated world, called on the `queryObjects` array: wraps
 * `invoke` once on every IPC-renderer-shaped object there (Electron keeps
 * more than one: the public `ipcRenderer` and internal ones). A re-entry
 * guard reports each outer call once; the counter keeps only channels in
 * `IpcChannels`, so internal traffic is ignored.
 */
function wrapIpcRendererInvoke(this: unknown[], binding: string): string {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g.__drillerE2eWrapped === 'string') return g.__drillerE2eWrapped;
  if (typeof g[binding] !== 'function') return 'no binding in the isolated world';
  type Ipc = { invoke: (channel: string, ...args: unknown[]) => unknown; sendSync: unknown; on: unknown };
  const found = this.filter(
    (o): o is Ipc =>
      typeof o === 'object' &&
      o !== null &&
      typeof (o as Ipc).invoke === 'function' &&
      typeof (o as Ipc).sendSync === 'function' &&
      typeof (o as Ipc).on === 'function',
  );
  if (found.length === 0) return 'no ipcRenderer in the isolated world';
  let depth = 0;
  let wrappedCount = 0;
  let nextId = 0;
  for (const ipc of found) {
    const original = ipc.invoke;
    const wrapped = function (this: unknown, channel: string, ...args: unknown[]) {
      const live = g[binding] as ((payload: string) => void) | undefined;
      const counted = depth === 0 && typeof live === 'function';
      const id = (nextId += 1);
      if (counted) {
        let payload: string;
        try {
          payload = JSON.stringify({ channel, args, at: Date.now(), id });
        } catch {
          payload = JSON.stringify({ channel, at: Date.now(), id });
        }
        live(payload);
      }
      depth += 1;
      let result: unknown;
      try {
        result = original.call(this, channel, ...args);
      } finally {
        depth -= 1;
      }
      if (counted && result !== null && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        const settled = () => {
          const still = g[binding] as ((payload: string) => void) | undefined;
          if (typeof still === 'function') still(JSON.stringify({ settled: id, at: Date.now() }));
        };
        (result as Promise<unknown>).then(settled, settled);
      }
      return result;
    };
    try {
      ipc.invoke = wrapped;
      if (ipc.invoke === wrapped) wrappedCount += 1;
    } catch {
      // A read-only one: the others still count.
    }
  }
  if (wrappedCount === 0) return 'ipcRenderer.invoke is read-only';
  g.__drillerE2eWrapped = 'wrapped';
  return 'wrapped';
}

interface ExecutionContextDescription {
  id: number;
  name: string;
  auxData?: { isDefault?: boolean; type?: string; frameId?: string };
}

/** Adds the binding, wraps the preload's `ipcRenderer.invoke`, and starts counting. Throws when it can't. */
export async function installIpcCounter(page: Page): Promise<IpcCounter> {
  const methods = channelToMethod(readFileSync(PRELOAD_SOURCE, 'utf8'), IpcChannels as unknown as Record<string, string>);
  const known = new Set(Object.values(IpcChannels as unknown as Record<string, string>));
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const contexts: ExecutionContextDescription[] = [];
  const recorded: IpcCall[] = [];
  const ids = new Map<number, IpcCall>();
  const onContext = (event: { context: ExecutionContextDescription }) => contexts.push(event.context);
  const onBinding = (event: { name: string; payload: string }) => {
    if (event.name !== IPC_BINDING) return;
    try {
      const raw = JSON.parse(event.payload) as { channel: string; args?: unknown[]; at: number; id?: number; settled?: number };
      if (raw.settled !== undefined) {
        const call = ids.get(raw.settled);
        if (call !== undefined) call.settledAt = raw.at;
        return;
      }
      if (!known.has(raw.channel)) return; // Electron-internal traffic
      const call: IpcCall = { method: methods.get(raw.channel) ?? raw.channel, channel: raw.channel, args: raw.args, at: raw.at };
      recorded.push(call);
      if (raw.id !== undefined) ids.set(raw.id, call);
    } catch {
      recorded.push({ method: '(unparsable)', channel: '', at: Date.now() });
    }
  };
  cdp.on('Runtime.executionContextCreated', onContext);
  cdp.on('Runtime.bindingCalled', onBinding);
  const fail = async (why: string): Promise<never> => {
    await cdp.detach().catch(() => {});
    throw new Error(`could not count window.driller calls: ${why}`);
  };
  // `Runtime.enable` reports every existing context before it returns.
  await cdp.send('Runtime.enable');
  // Electron names the preload's world; Playwright adds utility worlds of its own.
  const isolated = contexts.filter(
    (c) => c.auxData?.isDefault === false && c.auxData?.type === 'isolated' && c.name === ELECTRON_ISOLATED_WORLD,
  );
  if (isolated.length !== 1) {
    return fail(`expected the preload's isolated world, found ${isolated.map((c) => `"${c.name}"`).join(', ') || 'none'}`);
  }
  const world = isolated[0]!;
  await cdp.send('Runtime.addBinding', { name: IPC_BINDING, executionContextName: world.name });
  const proto = await cdp.send('Runtime.evaluate', { expression: 'Object.prototype', contextId: world.id });
  if (proto.result.objectId === undefined) return fail('no Object.prototype handle');
  const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: 'e2e-ipc' });
  const result = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objects.objectId!,
    functionDeclaration: wrapIpcRendererInvoke.toString(),
    arguments: [{ value: IPC_BINDING }],
    returnByValue: true,
  });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'e2e-ipc' });
  const status = result.result.value as unknown;
  if (status !== 'wrapped') return fail(String(status ?? result.exceptionDetails?.text));
  const calls = async () => {
    await cdp.send('Runtime.evaluate', { expression: '0', contextId: world.id });
    return recorded.map((call) => ({ ...call }));
  };
  return {
    calls,
    count: async (method) => (await calls()).filter((call) => call.method === method).length,
    dispose: async () => {
      cdp.off('Runtime.bindingCalled', onBinding);
      cdp.off('Runtime.executionContextCreated', onContext);
      await cdp.send('Runtime.removeBinding', { name: IPC_BINDING }).catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
}

/** Exported for `ipcCounter.test.ts`: the preload source the channel map is read from. */
export const PRELOAD_SOURCE_PATH = path.normalize(PRELOAD_SOURCE);
