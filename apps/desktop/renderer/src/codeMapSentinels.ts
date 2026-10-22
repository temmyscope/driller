/**
 * Referentially-stable empty collections the Code Map shares.
 *
 * These exist for identity, not for emptiness: a memo that receives a fresh
 * `new Set()` each render recomputes every time, so the same frozen instance
 * has to be handed to every consumer. That is why they live in a leaf rather
 * than being declared per module — a second copy would be a silent
 * performance bug rather than a loud failure, invisible to every test.
 */

/** The empty Node-id set. Never `new Set()` at a call site. */
export const EMPTY_ID_SET: ReadonlySet<string> = new Set();
