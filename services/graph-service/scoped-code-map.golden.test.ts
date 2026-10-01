/**
 * P4-4 phase 1a: the equivalence proof for extracting the Code Map pipeline
 * out of `index.ts` into `buildScopedCodeMap` (`scoped-code-map.ts`).
 *
 * `scoped-code-map.golden.json` was captured from the PRE-refactor
 * `handleGetCodeMapRequest` / `computePathTraceResult` (baseline commit
 * 3688778, run on a `git archive` export of it) by running this file with
 * `DRILLER_UPDATE_GOLDEN=1`, over `scoped-code-map-fixture.ts` (including its
 * Node records) and every scope in `FIXTURE_SCOPES`. Without that variable it
 * asserts the current handlers produce the same bytes:
 *  - the `graphService:codeMap` reply (Nodes with summary state, severities,
 *    record-backed signals, LCOV flags, testedBy / similarTo / folded links;
 *    edges, including dangling ones on an unrestricted map; folded types and
 *    Modules; `hiddenByScope`; `appliedScope`);
 *  - the caches every other operation reads (`activeCodeMapNodes`, folded
 *    Modules, uncapped folded types), through the stubbed `startMcpServer`;
 *  - the Path Trace result for each query.
 * Serialized with an `undefined` sentinel, so an own property set to
 * `undefined` is distinguished from an absent one.
 *
 * Only ever re-capture on the baseline: the golden is the pre-refactor
 * behaviour, not whatever the current code does. A capture run always fails
 * (re-run without the flag), and is refused under CI.
 *
 * This file imports nothing the baseline lacks, so it runs there unchanged.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

import { mergeNodeRecord } from './node-record-store';
import { FIXTURE_RECORDS, FIXTURE_SCOPES, FIXTURE_TRACE_QUERIES, goldenStringify } from './scoped-code-map-fixture';
import { fetchMap, getters, makeFixtureProject, send, startIndexTs, trace } from './scoped-code-map-harness';

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scoped-code-map.golden.json');
const UPDATE_GOLDEN = process.env.DRILLER_UPDATE_GOLDEN === '1';

const PROJECT = makeFixtureProject();

/** Everything the golden records for one scope. */
async function snapshotScope(scope: readonly string[]): Promise<Record<string, unknown>> {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
  const reply = await fetchMap();
  const { getNodes, getFolded, getFoldedTypes } = getters();
  const traces: Record<string, unknown> = {};
  for (const query of FIXTURE_TRACE_QUERIES) {
    traces[query] = await trace(query);
  }
  return {
    reply,
    cachedNodes: getNodes(),
    cachedFoldedModules: getFolded(),
    cachedFoldedTypes: getFoldedTypes(),
    traces,
  };
}

before(async () => {
  await startIndexTs(PROJECT);
  // The record store is the real one, switched to PROJECT by the index.
  for (const [id, record] of Object.entries(FIXTURE_RECORDS)) {
    mergeNodeRecord(id, record);
  }
});

describe('P4-4 phase 1a: the Code Map pipeline is byte-identical to the pre-refactor handler', () => {
  it('every scope: map reply, caches and Path Trace equal the golden', { timeout: 60_000 }, async () => {
    const actual: Record<string, unknown> = {};
    for (const scope of FIXTURE_SCOPES) {
      actual[JSON.stringify(scope)] = await snapshotScope(scope);
    }
    const text = `${goldenStringify(actual)}\n`;
    if (UPDATE_GOLDEN) {
      assert.ok(!process.env.CI, 'DRILLER_UPDATE_GOLDEN is refused under CI: the golden is captured on the baseline only');
      writeFileSync(GOLDEN_PATH, text);
      assert.fail('golden rewritten — re-run without DRILLER_UPDATE_GOLDEN');
    }
    assert.ok(existsSync(GOLDEN_PATH), 'the golden file is missing; it is captured from the pre-refactor handler only');
    // Byte equality first (the claim), then a structural diff for a readable failure.
    const golden = readFileSync(GOLDEN_PATH, 'utf8');
    if (text !== golden) {
      assert.deepEqual(JSON.parse(text), JSON.parse(golden));
      assert.fail('the serialized output differs from the golden only in key order or formatting');
    }
  });
});
