import { repository } from './repository';

/**
 * Calls back into `repository`, closing a cycle (`repository` -> `cacheLookup`
 * -> `repository` -> ...) — the fixture's deliberate cyclic entry, exercising
 * `traceCallPath`'s visited-set BFS termination (Always: each Node visited at
 * most once regardless of cycles).
 */
export function cacheLookup(): void {
  repository();
}
