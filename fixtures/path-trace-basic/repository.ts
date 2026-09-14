import { cacheLookup } from './cache';

/**
 * Reached from both `serviceA` and `serviceB` — the fixture's deliberate
 * fan-in, so a correct BFS visits this Node exactly once even though two
 * different callers both call it (Always: visited-set dedup, not just cycle
 * protection).
 */
export function repository(): void {
  cacheLookup();
}
