/**
 * P4-4 phase 1a: `buildScopedCodeMap`, called directly (no `index.ts`), over
 * the same raw fixture the golden was captured from — so the pure pipeline is
 * proven byte-identical to the pre-refactor handler on its own, and per-section
 * maps (the nearest-entry rule) are built by the same lines.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';

import {
  FOLDED_TYPE_IPC_MAX_USED_BY,
  type CodeMapEdge,
  type CodeMapNode,
  type DeterministicRiskSignal,
} from '@driller/graph-contracts';

import { capFoldedTypeUsedBy } from './fold-types';
import { loadLcovCoverage } from './lcov';
import type { NodeRecord } from './node-record-store';
import { fetchProductionCodeMap } from './production-code-map';
import { isFileInScope, sectionOfFile } from './project-scope';
import {
  buildScopedCodeMap,
  countSectionNodes,
  filterCodeMapToScope,
  KEEP_ALL_FILES,
  keepFileForScope,
  keepFileForSection,
  type RawCodeMap,
} from './scoped-code-map';
import {
  FIXTURE_GAP_PATHS,
  FIXTURE_LCOV,
  FIXTURE_RECORDS,
  FIXTURE_SCOPES,
  FIXTURE_SOURCE_FILES,
  goldenStringify,
  SCOPED_MAP_FIXTURE,
} from './scoped-code-map-fixture';

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scoped-code-map.golden.json');

interface GoldenScope {
  reply: { nodes: unknown; edges: unknown; hiddenByScope: number; foldedTypes: unknown; foldedModules: unknown };
  cachedNodes: unknown;
  cachedFoldedModules: unknown;
  cachedFoldedTypes: unknown;
}

const noRecords = (): NodeRecord | undefined => undefined;
/** The golden's record store: `FIXTURE_RECORDS`, seeded into the real store before capture. */
const fixtureRecords = (id: string): NodeRecord | undefined => FIXTURE_RECORDS[id];

let raw: RawCodeMap;
let golden: Record<string, GoldenScope>;

before(async () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'driller-scoped-map-'));
  const past = new Date(Date.now() - 60_000);
  for (const file of FIXTURE_SOURCE_FILES) {
    mkdirSync(path.join(projectRoot, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(projectRoot, file), Array.from({ length: 20 }, (_, i) => `// line ${i + 1}`).join('\n'));
    utimesSync(path.join(projectRoot, file), past, past);
  }
  mkdirSync(path.join(projectRoot, 'coverage'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'coverage', 'lcov.info'), FIXTURE_LCOV);
  const fetched = await fetchProductionCodeMap('stub-project', projectRoot, 'Code Map', {
    fetch: async () => structuredClone(SCOPED_MAP_FIXTURE),
    includeTestedBy: true,
    includeImplements: true,
    includeSimilar: true,
  });
  raw = {
    projectRoot,
    fetched,
    coverage: await loadLcovCoverage(projectRoot),
    coverageGapFiles: new Set(FIXTURE_GAP_PATHS),
  };
  golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, GoldenScope>;
});

describe('buildScopedCodeMap', () => {
  it('equals the pre-refactor handler, byte for byte, for every golden scope', () => {
    for (const scope of FIXTURE_SCOPES) {
      const expected = golden[JSON.stringify(scope)];
      assert.ok(expected, `golden has scope ${JSON.stringify(scope)}`);
      const map = buildScopedCodeMap(raw, keepFileForScope(scope), fixtureRecords);
      const same = (actual: unknown, wanted: unknown, what: string) =>
        assert.equal(goldenStringify(actual), goldenStringify(wanted), `${what} for scope ${JSON.stringify(scope)}`);
      same(map.nodes, expected.reply.nodes, 'Nodes (summary state, severities, LCOV flags, links)');
      same(map.nodes, expected.cachedNodes, 'cached Nodes');
      same(map.edges, expected.reply.edges, 'edges');
      same(map.hiddenByScope, expected.reply.hiddenByScope, 'hiddenByScope');
      same(capFoldedTypeUsedBy(map.foldedTypes, FOLDED_TYPE_IPC_MAX_USED_BY), expected.reply.foldedTypes, 'folded types (reply)');
      same(map.foldedTypes, expected.cachedFoldedTypes, 'folded types (cache)');
      same(map.foldedModules, expected.reply.foldedModules, 'folded Modules');
      same(map.foldedModules, expected.cachedFoldedModules, 'folded Modules (cache)');
      // The pre-signal Nodes are the map's Nodes, 1:1, raw signal fields still on.
      assert.deepEqual(map.preSignalNodes.map((node) => node.id), map.nodes.map((node) => node.id));
    }
  });

  it('never mutates its input, so the cached raw fetch can be re-filtered any number of times', () => {
    const before = goldenStringify(raw);
    const first = goldenStringify(buildScopedCodeMap(raw, (file) => isFileInScope(file, ['web']), noRecords));
    buildScopedCodeMap(raw, () => true, noRecords);
    buildScopedCodeMap(raw, (file) => isFileInScope(file, ['apps', 'apps/web']), noRecords);
    assert.equal(goldenStringify(raw), before);
    assert.equal(goldenStringify(buildScopedCodeMap(raw, (file) => isFileInScope(file, ['web']), noRecords)), first);
  });

  it('reads summary state through getRecord', () => {
    const record: NodeRecord = { summary: { text: 'Starts the server.', model: 'm', generatedAt: '2026-10-01T00:00:00.000Z' } };
    const map = buildScopedCodeMap(raw, () => true, (id) => (id === 's1' ? record : undefined));
    const s1 = map.nodes.find((node) => node.id === 's1');
    assert.equal(s1?.summaryStatus, 'ready');
    assert.equal(s1?.summary, 'Starts the server.');
    assert.equal(map.nodes.find((node) => node.id === 's2')?.summaryStatus, 'pending');
    // A coverage-gap file wins over any record.
    assert.equal(map.nodes.find((node) => node.id === 'd1')?.summaryStatus, 'coverage-gap');
  });

  it('per section (nearest entry wins): every in-scope Node is in exactly one section, each section built by the same pipeline', () => {
    const allowlist = ['apps', 'apps/web', 'web', 'api'];
    const whole = buildScopedCodeMap(raw, (file) => isFileInScope(file, allowlist), noRecords);
    const sections = allowlist.map((section) => ({
      section,
      map: buildScopedCodeMap(raw, (file) => sectionOfFile(file, allowlist) === section, noRecords),
    }));
    const ids = sections.flatMap(({ map }) => map.nodes.map((node) => node.id));
    assert.equal(new Set(ids).size, ids.length, 'no Node is in two sections');
    assert.deepEqual([...ids].sort(), whole.nodes.map((node) => node.id).sort());
    const apps = sections.find(({ section }) => section === 'apps')!.map;
    assert.ok(apps.nodes.every((node) => node.file.startsWith('apps/') && !node.file.startsWith('apps/web/')));
    const appsWeb = sections.find(({ section }) => section === 'apps/web')!.map;
    assert.ok(appsWeb.nodes.length > 0 && appsWeb.nodes.every((node) => node.file.startsWith('apps/web/')));
    // A section's map is exactly the pipeline run with its own file set
    // (never derived from the whole map): equal to filtering the raw Nodes first.
    for (const { section, map } of sections) {
      const keep = (file: string) => sectionOfFile(file, allowlist) === section;
      const filtered = filterCodeMapToScope(raw.projectRoot, raw.fetched.nodes, raw.fetched.edges, keep);
      assert.deepEqual(map.nodes.map((node) => node.id), filtered.nodes.map((node) => node.id));
      assert.deepEqual(map.edges, filtered.edges);
    }
  });

  it('a section rates severity against its own Nodes, not the whole map', () => {
    const allowlist = ['web', 'api'];
    const severities = (keep: (file: string) => boolean) =>
      Object.fromEntries(
        buildScopedCodeMap(raw, keep, noRecords).nodes.map((node) => [
          node.id,
          node.riskSignals.map((signal) => ('severity' in signal ? signal.severity : signal.family)),
        ]),
      );
    const whole = severities((file) => isFileInScope(file, allowlist));
    const api = severities((file) => sectionOfFile(file, allowlist) === 'api');
    assert.ok(Object.keys(api).length > 0);
    assert.ok(
      Object.keys(api).some((id) => goldenStringify(api[id]) !== goldenStringify(whole[id])),
      'at least one api Node is rated differently within its own section',
    );
  });
});

describe('the unrestricted map (review round 1)', () => {
  it('KEEP_ALL_FILES passes dangling edges through untouched, as an empty allowlist always has; any other predicate drops them', () => {
    const dangling = (edges: readonly { source: string; target: string }[]) =>
      edges.filter((edge) => edge.source.startsWith('ghost') || edge.target.startsWith('ghost')).length;
    assert.equal(dangling(raw.fetched.edges), 2, 'the fixture has 2 dangling edges after the production steps');
    assert.equal(keepFileForScope([]), KEEP_ALL_FILES);
    const all = buildScopedCodeMap(raw, KEEP_ALL_FILES, noRecords);
    assert.equal(all.edges, raw.fetched.edges, 'the same edges array, untouched');
    assert.equal(dangling(all.edges), 2);
    const everything = buildScopedCodeMap(raw, () => true, noRecords);
    assert.equal(dangling(everything.edges), 0);
    assert.equal(everything.nodes.length, all.nodes.length);
  });
});

describe('filterCodeMapToScope', () => {
  it('an empty allowlist is a no-op returning the same arrays; a predicate is always applied', () => {
    const nodes = [{ id: 'a', file: 'web/a.ts' }, { id: 'b', file: 'webapp/b.ts' }];
    const edges = [{ source: 'a', target: 'b' }];
    const none = filterCodeMapToScope('/repo', nodes, edges, []);
    assert.equal(none.nodes, nodes);
    assert.equal(none.edges, edges);
    const web = filterCodeMapToScope('/repo', nodes, edges, ['web']);
    assert.deepEqual(web, { nodes: [nodes[0]], edges: [] });
    const viaPredicate = filterCodeMapToScope('/repo', nodes, edges, (file) => isFileInScope(file, ['web']));
    assert.deepEqual(viaPredicate, web);
    // An absolute file is normalized for the match test only.
    const absolute = [{ id: 'c', file: '/repo/web/c.ts' }];
    assert.deepEqual(filterCodeMapToScope('/repo', absolute, [], ['web']).nodes, absolute);
  });
});

/**
 * P4-4 phase 1b: a section's severities are cut over the section alone (the
 * shared fixture has no Node whose blast-radius rating flips, so this one is
 * built for it), and the Section bar's counts.
 */
describe('P4-4 phase 1b: per-section severity and counts', () => {
  const fn = (id: string, file: string) => ({
    id,
    name: id,
    file,
    startLine: 1,
    endLine: 2,
    kind: 'Function' as const,
    summaryStatus: 'pending' as const,
    riskSignals: [],
  });
  let sectionRaw: RawCodeMap;

  before(async () => {
    // api: a0 called by 10 Nodes (blast radius 10). web: a 20-Node clique
    // (blast radius 19 each), which fills the whole scope's top 10%.
    const api = Array.from({ length: 11 }, (_, i) => fn(`a${i}`, 'api/a.ts'));
    const web = Array.from({ length: 20 }, (_, i) => fn(`w${i}`, 'web/w.ts'));
    const edges: CodeMapEdge[] = [
      ...api.slice(1).map((node) => ({ source: node.id, target: 'a0', kind: 'CALLS' as const })),
      ...web.flatMap((a) =>
        web.filter((b) => b !== a).map((b) => ({ source: a.id, target: b.id, kind: 'CALLS' as const })),
      ),
    ];
    const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'driller-section-severity-'));
    const fetched = await fetchProductionCodeMap('stub-project', projectRoot, 'Code Map', {
      fetch: async () => ({ nodes: [...api, ...web], edges }),
    });
    sectionRaw = { projectRoot, fetched, coverage: undefined, coverageGapFiles: new Set() };
  });

  const blastRadius = (nodes: readonly CodeMapNode[], id: string): string | undefined =>
    nodes
      .find((node) => node.id === id)
      ?.riskSignals.find(
        (signal): signal is DeterministicRiskSignal => signal.family === 'deterministic' && signal.type === 'blast-radius',
      )?.severity;

  it('a0 is severe in api and moderate across web + api', () => {
    const noRecords = () => undefined;
    const whole = buildScopedCodeMap(sectionRaw, keepFileForScope(['web', 'api']), noRecords);
    const api = buildScopedCodeMap(sectionRaw, keepFileForSection('api', ['web', 'api']), noRecords);
    assert.equal(blastRadius(whole.nodes, 'a0'), 'moderate');
    assert.equal(blastRadius(api.nodes, 'a0'), 'severe');
  });

  it('countSectionNodes: one entry per path in order, nearest entry wins, sum = total', () => {
    const nodes = ['apps/a.ts', 'apps/web/b.ts', 'apps/web/c.ts', 'web/d.ts', 'webapp/e.ts'].map((file) => ({ file }));
    assert.deepEqual(countSectionNodes('/project', nodes.slice(0, 4), ['apps/web', 'web', 'apps']), [
      { path: 'apps/web', nodeCount: 2 },
      { path: 'web', nodeCount: 1 },
      { path: 'apps', nodeCount: 1 },
    ]);
    assert.deepEqual(countSectionNodes('/project', nodes, []), []);
    assert.deepEqual(countSectionNodes('/project', nodes, ['web']), [{ path: 'web', nodeCount: 1 }], 'webapp is not web');
  });
});
