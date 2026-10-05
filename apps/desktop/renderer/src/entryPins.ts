/**
 * P4-7g: the Node-detail "⚑ Pin as entry point" toggle, as pure functions
 * (no React), so every decision is unit-tested (`entryPins.test.ts`) and
 * `CodeMap.tsx` only wires them up.
 *
 * Pins are a per-project UI setting kept by main (AD-5 "Entry pins"): read
 * once per project open (`loadEntryPins`), changed one id at a time by main
 * against its stored list (`saveEntryPin`), and main hands what it stored to the Graph Service, so
 * the next entry-candidate listing — the renderer's and the MCP tool's —
 * ranks them first. The renderer never ranks anything itself.
 */
import { ENTRY_PINS_MAX, type EntryPinUpdateResult } from '@driller/ipc-contracts';

/**
 * The toggle's label after its "⚑" glyph. Review round 1: one stable label;
 * the state is `aria-pressed` plus a visible "pinned by you" note beside it
 * (never the label switching between "Pin" and "Unpin").
 */
export const PIN_BUTTON_TEXT = 'Pin as entry point';

/** The explicit message when a pin past `ENTRY_PINS_MAX` is refused. */
export const PIN_LIMIT_TEXT = `Pin limit (${ENTRY_PINS_MAX}) reached — unpin another entry point first.`;

/** The explicit message when the pins couldn't be saved (the IPC call failed). */
export const PIN_SAVE_FAILED_TEXT = 'Couldn’t save the entry pins. Try again.';

/**
 * What a toggle on `nodeId` asks main for: pin it (appended, so pin order
 * is the order the engineer pinned them) or unpin it — one id, applied by
 * main to the list it stored (review round 1: never a whole list from here,
 * which could be stale). A pin past `ENTRY_PINS_MAX` on the list held here
 * is refused before anything is sent; main checks again.
 */
export type PinTogglePlan = { kind: 'send'; pinned: boolean } | { kind: 'limit' };

export function planPinToggle(pins: readonly string[], nodeId: string): PinTogglePlan {
  if (pins.includes(nodeId)) {
    return { kind: 'send', pinned: false };
  }
  if (pins.length >= ENTRY_PINS_MAX) {
    return { kind: 'limit' };
  }
  return { kind: 'send', pinned: true };
}

/**
 * What a settled update leaves: the pins main says it stored (or, when the
 * call failed, the pins as they were), a message, and whether the pins
 * changed — only then does Revealed owe a new listing.
 */
export function pinSaveOutcome(input: {
  previous: readonly string[];
  result: EntryPinUpdateResult | null;
}): { pins: readonly string[]; message: string | null; changed: boolean } {
  const { previous, result } = input;
  if (result === null) {
    return { pins: previous, message: PIN_SAVE_FAILED_TEXT, changed: false };
  }
  if (result.status === 'error') {
    return { pins: previous, message: result.message, changed: false };
  }
  const changed = result.pins.length !== previous.length || result.pins.some((id, index) => id !== previous[index]);
  return { pins: result.pins, message: result.status === 'limit' ? PIN_LIMIT_TEXT : null, changed };
}

/** A string array, or `null`. */
function idList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((id) => typeof id === 'string') ? [...(value as string[])] : null;
}

/** A well-formed `EntryPinUpdateResult`, or `null`. */
function updateResult(value: unknown): EntryPinUpdateResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { status, pins, message } = value as Record<string, unknown>;
  if ((status === 'stored' || status === 'limit') && idList(pins) !== null) {
    return { status, pins: idList(pins) as string[] };
  }
  if (status === 'error' && typeof message === 'string') {
    return { status, message };
  }
  return null;
}

/**
 * Reads one project's pins. `null` with no project, and when the read fails
 * or resolves with anything but a string array — the toggle stays disabled
 * until a read lands (review round 1). Never rejects, even when `get`
 * throws synchronously. Hookless.
 */
export async function loadEntryPins(
  projectPath: string | null,
  get: (projectPath: string) => Promise<string[]>,
): Promise<string[] | null> {
  if (projectPath === null) {
    return null;
  }
  try {
    return idList(await get(projectPath));
  } catch (error) {
    console.warn('CodeMap: could not read the entry pins.', error);
    return null;
  }
}

/**
 * Pins or unpins one Node and resolves with main's outcome (`null` when the
 * call fails or replies with a malformed result). Never rejects, even when
 * `set` throws synchronously. Hookless.
 */
export async function saveEntryPin(
  projectPath: string,
  nodeId: string,
  pinned: boolean,
  set: (projectPath: string, nodeId: string, pinned: boolean) => Promise<EntryPinUpdateResult>,
): Promise<EntryPinUpdateResult | null> {
  try {
    return updateResult(await set(projectPath, nodeId, pinned));
  } catch (error) {
    console.warn('CodeMap: could not save the entry pin.', error);
    return null;
  }
}
