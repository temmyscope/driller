/**
 * P4-4 phase 1b: `graphService:getCodeMap` with a `section`, through the real
 * `index.ts` (`scoped-code-map-harness.ts`) over `scoped-code-map-fixture.ts`.
 *
 * Pins, per the spec's I/O matrix:
 *  - no section: today's reply (the golden test) plus `section: null` and
 *    per-section counts that sum to the whole-scope Node count;
 *  - a section: exactly `buildScopedCodeMap` under the nearest-section
 *    predicate, so its severities are cut over the section alone (`s2`'s
 *    hotspot is severe in `api` and moderate across `web` + `api`);
 *  - nested entries: the `apps` section never holds `apps/web/**`;
 *  - an unknown section (or any section with no allowlist): the explicit
 *    `unknown-section` reply, without a fetch;
 *  - the caches (`lookup_node`, diff scope, Blast Radius expansion, MCP)
 *    always hold the whole-scope build.
 * The blast-radius per-section cut is pinned directly on
 * `buildScopedCodeMap` (`scoped-code-map.test.ts`), since the shared fixture
 * has no Node whose blast-radius rating flips.
 *
 * Nothing on `index.ts`'s import graph is imported statically here (only
 * types and side-effect-free modules): the harness's module hooks must be
 * registered before `production-code-map.ts` first loads.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { CodeMapEdge } from '@driller/graph-contracts';

import { isFileInScope } from './project-scope';
import { buildScopedCodeMap, keepFileForSection } from './scoped-code-map';
import { goldenStringify } from './scoped-code-map-fixture';
import { getters, makeFixtureProject, posted, removeHarnessTempDirs, send, startIndexTs, waitFor, type Posted } from './scoped-code-map-harness';

const PROJECT = makeFixtureProject();
const harness = globalThis as { __harnessFetchCount?: number; __harnessFetchGate?: Promise<void> };

let indexModule: typeof import('./index') | undefined;
let lookupNode: typeof import('./mcp-server').lookupNode;

const REPLY_TYPES = ['graphService:codeMap', 'graphService:codeMapUnknownSection', 'graphService:codeMapError'];

/** Posts `getCodeMap` (with `section` when given) and resolves with the first Code Map reply. */
async function requestMap(section?: unknown): Promise<Posted> {
  const from = posted.length;
  send({ type: 'graphService:getCodeMap', ...(section === undefined ? {} : { section }) });
  const reply = await waitFor(
    () => posted.slice(from).find((message) => REPLY_TYPES.includes(message.type ?? '')),
    'a Code Map reply',
  );
  // Let the synchronous cache kicks that follow the post run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return reply;
}

function setScope(scope: readonly string[]): void {
  send({ type: 'graphService:scopeChanged', path: PROJECT, includedPaths: scope });
}

interface MapNode {
  id: string;
  file: string;
  riskSignals: { family: string; type?: string; severity?: string }[];
}

const nodesOf = (reply: Posted): MapNode[] => reply.nodes as MapNode[];
const severityOf = (reply: Posted, id: string, type: string): string | undefined =>
  nodesOf(reply)
    .find((node) => node.id === id)
    ?.riskSignals.find((signal) => signal.family === 'deterministic' && signal.type === type)?.severity;

/** Everything `lookup_node`, diff scope and Blast Radius expansion read. */
function cacheSnapshot(): string {
  const { getNodes, getFolded, getFoldedTypes } = getters();
  return goldenStringify({ nodes: getNodes(), folded: getFolded(), foldedTypes: getFoldedTypes() });
}

// P4-4e review round 1: no temp dirs left behind.
after(removeHarnessTempDirs);

before(async () => {
  indexModule = await startIndexTs(PROJECT);
  ({ lookupNode } = await import('./mcp-server'));
});

describe('P4-4 phase 1b: getCodeMap(section) through index.ts', () => {
  it('no section: section is null and the counts cover every whole-scope Node once', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    const reply = await requestMap();
    assert.equal(reply.type, 'graphService:codeMap');
    assert.equal(reply.section, null);
    assert.deepEqual(reply.appliedScope, ['web', 'api']);
    const sections = reply.sections as { path: string; nodeCount: number }[];
    assert.deepEqual(
      sections.map((entry) => entry.path),
      ['web', 'api'],
      'one entry per allowlist path, in order',
    );
    const nodes = nodesOf(reply);
    for (const entry of sections) {
      assert.equal(entry.nodeCount, nodes.filter((node) => isFileInScope(node.file, [entry.path])).length);
    }
    assert.equal(
      sections.reduce((sum, entry) => sum + entry.nodeCount, 0),
      nodes.length,
    );

    setScope([]);
    const unscoped = await requestMap();
    assert.equal(unscoped.section, null);
    assert.deepEqual(unscoped.sections, [], 'no allowlist, no sections');
  });

  it('section api: exactly the section build, with its own severity cuts', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    const whole = await requestMap();
    const reply = await requestMap('api');
    assert.equal(reply.type, 'graphService:codeMap');
    assert.equal(reply.section, 'api');
    assert.deepEqual(reply.appliedScope, ['web', 'api']);
    assert.deepEqual(reply.sections, whole.sections, 'the tab counts are the whole-scope ones');
    assert.equal(reply.hiddenByScope, whole.hiddenByScope, 'hiddenByScope keeps its allowlist meaning');

    const nodes = nodesOf(reply);
    assert.ok(nodes.length > 0);
    assert.ok(nodes.every((node) => node.file.startsWith('api/')), 'only api/ Nodes');
    const ids = new Set(nodes.map((node) => node.id));
    assert.ok(
      (reply.edges as CodeMapEdge[]).every((edge) => ids.has(edge.source) && ids.has(edge.target)),
      'only edges with both ends in api',
    );

    // The reply is the pipeline re-run over api's files from the same fetch.
    assert.ok(indexModule);
    const active = indexModule.getActiveRawCodeMap();
    assert.ok(active, 'the raw cache holds the fetch behind this reply');
    const expected = buildScopedCodeMap(active.raw, keepFileForSection('api', active.appliedScope));
    assert.equal(goldenStringify(reply.nodes), goldenStringify(expected.nodes));
    assert.equal(goldenStringify(reply.edges), goldenStringify(expected.edges));
    assert.equal(goldenStringify(reply.foldedModules), goldenStringify(expected.foldedModules));
    assert.deepEqual(
      (reply.foldedTypes as { id: string }[]).map((type) => type.id),
      expected.foldedTypes.map((type) => type.id),
    );

    // Severity is cut over api alone: s2's hotspot is in api's top 10% but
    // not in the top 10% across web + api.
    assert.equal(severityOf(reply, 's2', 'hotspot'), 'severe');
    assert.equal(severityOf(whole, 's2', 'hotspot'), 'moderate');
  });

  it('nested entries: the apps section excludes apps/web/**', { timeout: 20_000 }, async () => {
    setScope(['apps', 'apps/web']);
    const whole = await requestMap();
    const apps = await requestMap('apps');
    const appsWeb = await requestMap('apps/web');
    assert.ok(nodesOf(apps).length > 0);
    assert.ok(
      nodesOf(apps).every((node) => node.file.startsWith('apps/') && !node.file.startsWith('apps/web/')),
      'apps keeps only the files apps/web does not own',
    );
    assert.ok(nodesOf(appsWeb).every((node) => node.file.startsWith('apps/web/')));
    const counts = Object.fromEntries((whole.sections as { path: string; nodeCount: number }[]).map((e) => [e.path, e.nodeCount]));
    assert.equal(counts.apps, nodesOf(apps).length);
    assert.equal(counts['apps/web'], nodesOf(appsWeb).length);
    assert.equal(counts.apps! + counts['apps/web']!, nodesOf(whole).length, 'the counts sum to the whole-scope total');
  });

  it('an unknown section is an explicit state, never an empty map, and fetches nothing', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const fetchesBefore = harness.__harnessFetchCount ?? 0;
    for (const section of ['docs', 'all', 'ap', 'api/', '']) {
      const reply = await requestMap(section);
      assert.deepEqual(
        { type: reply.type, section: reply.section, knownSections: reply.knownSections },
        { type: 'graphService:codeMapUnknownSection', section, knownSections: ['web', 'api'] },
        `section ${JSON.stringify(section)}`,
      );
    }
    setScope([]);
    const none = await requestMap('web');
    assert.deepEqual(
      { type: none.type, section: none.section, knownSections: none.knownSections },
      { type: 'graphService:codeMapUnknownSection', section: 'web', knownSections: [] },
    );
    assert.equal(harness.__harnessFetchCount ?? 0, fetchesBefore, 'no fetch for an unknown section');
  });

  it('a failed fetch echoes the requested section on its error (review round 1)', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    for (const section of ['api', undefined]) {
      const failed = Promise.reject(new Error('backend down (test)'));
      failed.catch(() => {});
      harness.__harnessFetchGate = failed;
      try {
        const reply = await requestMap(section);
        assert.deepEqual(
          { type: reply.type, message: reply.message, section: reply.section },
          { type: 'graphService:codeMapError', message: 'backend down (test)', section: section ?? null },
        );
      } finally {
        harness.__harnessFetchGate = undefined;
      }
    }
  });

  it('a malformed section gets an explicit error reply', { timeout: 20_000 }, async () => {
    const reply = await requestMap(42);
    assert.deepEqual({ type: reply.type, message: reply.message }, { type: 'graphService:codeMapError', message: 'Invalid section.' });
  });

  it('the caches (and lookup_node) hold the whole-scope build after a section request', { timeout: 20_000 }, async () => {
    setScope(['web', 'api']);
    await requestMap();
    const wholeCaches = cacheSnapshot();
    const lookups = (): string => {
      const { getNodes, getFolded, getFoldedTypes } = getters();
      return goldenStringify(
        ['w1', 's2', 'A', 'T', 'mod:web/a'].map((id) =>
          lookupNode(
            id,
            getNodes() as never,
            (node) => node,
            getFolded() as never,
            getFoldedTypes() as never,
          ),
        ),
      );
    };
    const wholeLookups = lookups();
    assert.match(wholeLookups, /"id": "w1"/, 'a web Node resolves');

    const section = await requestMap('api');
    assert.equal(section.type, 'graphService:codeMap');
    assert.equal(cacheSnapshot(), wholeCaches, 'Nodes, folded Modules and folded types unchanged');
    assert.equal(lookups(), wholeLookups, 'lookup_node results unchanged');
    assert.ok(indexModule);
    assert.deepEqual(indexModule.getActiveRawCodeMap()?.appliedScope, ['web', 'api'], 'the raw cache is whole-scope');
  });
});
