import { serviceA } from './serviceA';
import { serviceB } from './serviceB';

/**
 * The fixture's single entry point (Story 1.9, Phase 1's `README.md`
 * documents the hand-verified `traceCallPath` output for a query resolving
 * to this Node). Calls `serviceA` then `serviceB`, in that source order —
 * the BFS visits `serviceA` before `serviceB` for exactly that reason.
 */
export function handleRequest(): void {
  serviceA();
  serviceB();
}
