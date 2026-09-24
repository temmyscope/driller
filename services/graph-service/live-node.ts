/**
 * P0-4: live, query-time derivation of a Node's record-backed fields for the
 * Agent-Facing Query Surface's `lookup_node` (FR15 parity).
 *
 * `activeCodeMapNodes` is a snapshot taken at the last Code Map fetch and
 * never updated afterwards, so serving it as-is let an agent see
 * `pending`/stale/abandoned-backend data while the human saw current data.
 * Rather than patching the cache at every write site, `lookup_node` keeps the
 * cache's structural and deterministic data and re-derives everything the
 * Node record store backs — summary/staleness via `classifyNode`, and the
 * `llm-judgment`/`ingested` signals via `risk-signals.ts`'s
 * `recordBackedSignals` — through the exact same code the fetch path uses.
 *
 * `deriveLiveNode` is pure given its injected `sources`: it reads no module
 * state itself. This module is also free of `index.ts`'s module-load side
 * effects (record-store init, MCP port bind), so tests can import it. It is
 * not dependency-free, though: `classifyNode` lives in `summary-generator.ts`,
 * which loads `p-queue` at import time (no side effects beyond module
 * evaluation; `node-llama-cpp` stays a lazy dynamic import there).
 */
import type { CodeMapNode, RiskSignal } from '@driller/ipc-contracts';
import type { NodeRecord } from './node-record-store';
import { recordBackedSignals } from './risk-signals';
import { classifyNode } from './summary-generator';

export interface LiveNodeSources {
  /** The live record lookup — `getNodeRecord` in production, injected for tests. */
  getRecord: (id: string) => NodeRecord | undefined;
  /** The current coverage-gap file set (`index.ts`'s `coverageGapFileSet`). */
  coverageGapFiles: ReadonlySet<string>;
}

/**
 * Whether a cached signal is carried over as-is (true) or is record-backed
 * and therefore rebuilt from the live record (false). Exhaustive over
 * `RiskSignal['family']`: a new family fails typecheck here until someone
 * decides which side it belongs on, rather than being silently dropped or
 * silently kept stale.
 */
function isCarriedFromCache(signal: RiskSignal): boolean {
  const family = signal.family;
  switch (family) {
    case 'deterministic':
      return true;
    case 'llm-judgment':
    case 'ingested':
      return false;
    default: {
      const unhandled: never = family;
      throw new Error(`deriveLiveNode: unhandled risk-signal family ${String(unhandled)}`);
    }
  }
}

/**
 * Re-derives `cached`'s record-backed fields against the live record store.
 * The cached `summary`/`stale` keys are dropped before `classifyNode`'s
 * result is spread, so a record cleared by a backend switch yields `pending`
 * with no leftover text. Deterministic signals are kept from the cache
 * unchanged (they only change on a re-index/refetch), followed by the
 * record-backed ones rebuilt live — the same order `buildRiskSignals` uses.
 */
export function deriveLiveNode(cached: CodeMapNode, sources: LiveNodeSources): CodeMapNode {
  const { summary: _summary, stale: _stale, ...structural } = cached;
  const location = { file: cached.file, startLine: cached.startLine, endLine: cached.endLine };
  return {
    ...structural,
    ...classifyNode(cached, sources.coverageGapFiles, sources.getRecord),
    riskSignals: [
      ...cached.riskSignals.filter(isCarriedFromCache),
      ...recordBackedSignals(sources.getRecord(cached.id), location),
    ],
  };
}
