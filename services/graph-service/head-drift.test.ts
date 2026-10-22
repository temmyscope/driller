/**
 * P5-a (founder decision 6.1): re-index when the checkout moves.
 *
 * The pure decision (`head-drift.ts`) first; then through the real `index.ts`
 * (`scoped-code-map-harness.ts`), with the fixture project made a real git
 * repository (`main`, then a `feature` commit), so `readHeadCommit` reads a
 * real HEAD:
 *  - HEAD unchanged: the diff is computed as before;
 *  - a commit or checkout after the index: the diff returns the spec's error
 *    (7-character SHAs) and `headChanged` is posted once for that HEAD;
 *  - HEAD is read before `indexRepository` (a checkout while the index gate
 *    holds is caught by the next diff);
 *  - a failed re-index: later diffs get the same error, no second
 *    `headChanged` for that HEAD;
 *  - no HEAD (no repository, `.git` gone) is never drift;
 *  - `graphService:checkHead` (main's focus check) and MCP
 *    `compute_diff_scope` parity.
 *
 * Nothing on `index.ts`'s import graph is imported statically here: the
 * harness's module hooks must be registered before it first loads.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { DiffScopeResult } from '@driller/graph-contracts';

import { assessHeadDrift, autoReindexHeadAfterSuccess, headDriftErrorMessage } from './head-drift';
import {
  fetchMap,
  index,
  makeFixtureProject,
  posted,
  removeHarnessTempDirs,
  send,
  startIndexTs,
  waitFor,
} from './scoped-code-map-harness';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('P5-a: assessHeadDrift (pure)', () => {
  it('two known, different HEADs are drift; a re-index is requested when none is running and none was asked for that HEAD', () => {
    assert.deepEqual(assessHeadDrift({ indexedHead: A, currentHead: B, autoReindexHead: undefined, indexInFlight: false, reindexRequestPending: false }), {
      drift: true,
      indexedHead: A,
      currentHead: B,
      requestReindex: true,
      reindexing: true,
    });
  });

  it('review round 1: a re-index is under way when requested now, in flight, or requested moments ago — else not', () => {
    const base = { indexedHead: A, currentHead: B, autoReindexHead: B, indexInFlight: false, reindexRequestPending: false };
    const reindexing = (inputs: Parameters<typeof assessHeadDrift>[0]) => {
      const decision = assessHeadDrift(inputs);
      assert.equal(decision.drift, true);
      return decision.drift && decision.reindexing;
    };
    assert.equal(reindexing(base), false, 'already asked, nothing running: failed or ignored');
    assert.equal(reindexing({ ...base, indexInFlight: true }), true);
    assert.equal(reindexing({ ...base, reindexRequestPending: true }), true);
    assert.equal(reindexing({ ...base, autoReindexHead: undefined }), true, 'requested by this check');
  });

  it('an unknown HEAD on either side, or the same HEAD, is never drift', () => {
    for (const [indexedHead, currentHead] of [
      [undefined, B],
      [A, undefined],
      [undefined, undefined],
      [A, A],
    ] as const) {
      assert.deepEqual(assessHeadDrift({ indexedHead, currentHead, autoReindexHead: undefined, indexInFlight: false, reindexRequestPending: false }), { drift: false });
    }
  });

  it('drift, but no re-index request: one already asked for this HEAD, or an index in flight', () => {
    const asked = assessHeadDrift({ indexedHead: A, currentHead: B, autoReindexHead: B, indexInFlight: false, reindexRequestPending: false });
    assert.equal(asked.drift && asked.requestReindex, false);
    assert.equal(asked.drift, true);
    const inFlight = assessHeadDrift({ indexedHead: A, currentHead: B, autoReindexHead: undefined, indexInFlight: true, reindexRequestPending: false });
    assert.equal(inFlight.drift && inFlight.requestReindex, false);
    assert.equal(inFlight.drift, true);
    const other = assessHeadDrift({ indexedHead: A, currentHead: B, autoReindexHead: 'c'.repeat(40), indexInFlight: false, reindexRequestPending: false });
    assert.equal(other.drift && other.requestReindex, true, 'asked for another HEAD: this one is new');
  });

  it('the error text, with 7-character SHAs: the frozen wording while re-indexing, never "Re-indexing now" otherwise', () => {
    const indexed = 'abc1234ffffffffffffffffffffffffffffffff0';
    const current = 'def5678000000000000000000000000000000000';
    const frozen =
      'The checkout changed since this project was indexed (HEAD abc1234 → def5678). Re-indexing now — compute the diff scope again when the map refreshes.';
    assert.equal(headDriftErrorMessage(indexed, current), frozen);
    assert.equal(headDriftErrorMessage(indexed, current, true), frozen);
    assert.equal(
      headDriftErrorMessage(indexed, current, false),
      "The checkout moved since the last index (HEAD abc1234 → def5678) and the re-index didn't complete — use Retry (or re-open the project), then compute the diff scope again.",
    );
  });

  it('autoReindexHead after a success: cleared when the index caught up with it or on a project switch, else kept', () => {
    assert.equal(autoReindexHeadAfterSuccess(B, B, true), undefined);
    assert.equal(autoReindexHeadAfterSuccess(B, A, false), undefined);
    assert.equal(autoReindexHeadAfterSuccess(B, A, true), B);
    assert.equal(autoReindexHeadAfterSuccess(undefined, A, true), undefined);
  });
});

// ---------------------------------------------------------------------------
// Through the real index.ts.
// ---------------------------------------------------------------------------

const GIT_AVAILABLE = spawnSync('git', ['--version']).status === 0;
const PROJECT = makeFixtureProject();

const git = (...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: PROJECT,
    stdio: 'pipe',
  })
    .toString()
    .trim();
const head = (): string => git('rev-parse', 'HEAD');

/** `main` with the fixture, then a `feature` commit with one edit. */
function makeGitRepo(): void {
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  execFileSync('sh', ['-c', 'printf "// edited\\n" >> web/a.ts'], { cwd: PROJECT, stdio: 'pipe' });
  git('commit', '-q', '-am', 'feature edit');
}

let indexModule: typeof import('./index') | undefined;
let mcp: typeof import('./mcp-server') | undefined;

type IndexGateGlobal = { __harnessIndexGate?: Promise<void> };

/**
 * Replaces the harness's index gate with a getter, so a test sees the moment
 * `indexRepository` starts (it reads the gate first) and decides what it
 * awaits. Returns a restore function.
 */
function instrumentIndexGate(gate: () => Promise<void> | undefined): { entered: () => number; restore: () => void } {
  let entries = 0;
  Object.defineProperty(globalThis, '__harnessIndexGate', {
    configurable: true,
    get: () => {
      entries += 1;
      return gate();
    },
  });
  return {
    entered: () => entries,
    restore: () => {
      delete (globalThis as IndexGateGlobal).__harnessIndexGate;
    },
  };
}

const headChangedSince = (from: number) => posted.slice(from).filter((m) => m.type === 'graphService:headChanged');

const driftError = (indexedHead: string, currentHead: string, reindexing = true): DiffScopeResult => ({
  status: 'error',
  message: headDriftErrorMessage(indexedHead, currentHead, reindexing),
});

/** Re-index at the current HEAD and fetch the map, so the next diff starts from no drift. */
async function settle(): Promise<void> {
  await index(PROJECT);
  await fetchMap();
}

async function diff(): Promise<DiffScopeResult> {
  assert.ok(indexModule);
  return indexModule.computeDiffScopeResult(PROJECT, 'main');
}

after(removeHarnessTempDirs);

before(async () => {
  if (GIT_AVAILABLE) {
    makeGitRepo();
  }
  indexModule = await startIndexTs(PROJECT);
  mcp = await import('./mcp-server');
  await fetchMap();
});

describe('P5-a: HEAD drift through index.ts', { skip: !GIT_AVAILABLE && 'git is not installed' }, () => {
  it('HEAD unchanged: the diff is computed as before, and nothing is posted', { timeout: 30_000 }, async () => {
    const from = posted.length;
    assert.equal((await diff()).status, 'resolved');
    assert.equal(headChangedSince(from).length, 0);
  });

  it('a commit, then a diff: the explicit error, and one headChanged for the new HEAD', { timeout: 30_000 }, async () => {
    const indexed = head();
    git('commit', '-q', '--allow-empty', '-m', 'moved');
    const current = head();
    const from = posted.length;
    assert.deepEqual(await diff(), driftError(indexed, current));
    assert.deepEqual(headChangedSince(from), [{ type: 'graphService:headChanged', path: PROJECT, indexedHead: indexed, currentHead: current }]);
    // A second diff at the same HEAD: the same error, no second request.
    assert.deepEqual(await diff(), driftError(indexed, current));
    assert.equal(headChangedSince(from).length, 1);
    // Main re-indexes; at the new HEAD the diff works again.
    await settle();
    assert.equal((await diff()).status, 'resolved');
    assert.equal(headChangedSince(from).length, 1);
  });

  it('a checkout to another branch is drift too; back to the indexed commit is not', { timeout: 30_000 }, async () => {
    const indexed = head();
    git('checkout', '-q', 'main');
    const from = posted.length;
    assert.deepEqual(await diff(), driftError(indexed, head()));
    assert.equal(headChangedSince(from).length, 1);
    git('checkout', '-q', 'feature');
    assert.equal((await diff()).status, 'resolved', 'HEAD is the indexed commit again');
    // The re-index asked for `main` is cleared once an index catches up with
    // it; until then a later move to `main` is not asked for twice.
    git('checkout', '-q', 'main');
    await settle();
    git('checkout', '-q', 'feature');
    const again = posted.length;
    assert.equal((await diff()).status, 'error');
    assert.equal(headChangedSince(again).length, 1, 'feature is a new HEAD to re-index for');
    await settle();
  });

  it('HEAD is read before indexRepository: a checkout while the index runs is caught by the next diff', { timeout: 30_000 }, async () => {
    const before = head();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = instrumentIndexGate(() => held);
    try {
      const from = posted.length;
      send({ type: 'graphService:index', path: PROJECT, activeBackend: 'local' });
      await waitFor(() => (gate.entered() > 0 ? true : undefined), 'indexRepository to start');
      git('commit', '-q', '--allow-empty', '-m', 'during the index');
      const during = head();
      // Mid-index: no request (an index is in flight).
      assert.equal(headChangedSince(from).length, 0);
      release();
      await waitFor(
        () => posted.slice(from).find((m) => m.type === undefined && (m.state === 'indexed' || m.state === 'error')),
        'the index to finish',
      );
      gate.restore();
      await fetchMap();
      assert.deepEqual(await diff(), driftError(before, during));
      assert.equal(headChangedSince(from).length, 1);
    } finally {
      gate.restore();
    }
    await settle();
  });

  it('a failed re-index: later diffs return the same error, and no second headChanged for that HEAD', { timeout: 30_000 }, async () => {
    const indexed = head();
    git('commit', '-q', '--allow-empty', '-m', 'moved again');
    const current = head();
    const from = posted.length;
    assert.deepEqual(await diff(), driftError(indexed, current));
    assert.equal(headChangedSince(from).length, 1);
    // Main's re-index fails (the backend rejects) — held until the diff
    // below has run, so that diff is deterministically mid re-index.
    let fail: (error: Error) => void = () => {};
    const failing = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    failing.catch(() => {});
    const gate = instrumentIndexGate(() => failing);
    try {
      const indexFrom = posted.length;
      send({ type: 'graphService:index', path: PROJECT, activeBackend: 'local' });
      await waitFor(() => (gate.entered() > 0 ? true : undefined), 'the re-index to start');
      // During the failing re-index: the frozen wording.
      assert.deepEqual(await diff(), driftError(indexed, current));
      fail(new Error('backend down'));
      await waitFor(() => posted.slice(indexFrom).find((m) => m.type === undefined && m.state === 'error'), 'the re-index to fail');
      // Review round 1: no re-index is running now, so the error never says
      // "Re-indexing now" — it points at Retry.
      assert.deepEqual(await diff(), driftError(indexed, current, false));
      assert.deepEqual(await diff(), driftError(indexed, current, false));
      send({ type: 'graphService:checkHead', path: PROJECT });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(headChangedSince(from).length, 1, 'one automatic re-index per HEAD');
    } finally {
      gate.restore();
    }
    // Retry re-indexes as today.
    await settle();
    assert.equal((await diff()).status, 'resolved');
  });

  it('review round 1: main ignores the request — once the grace is over, the error stops saying "Re-indexing now"', { timeout: 30_000 }, async () => {
    assert.ok(indexModule);
    const indexed = head();
    git('commit', '-q', '--allow-empty', '-m', 'ignored');
    const current = head();
    indexModule.setReindexRequestGraceMsForTests(150);
    try {
      const from = posted.length;
      assert.deepEqual(await diff(), driftError(indexed, current), 'requested by this call');
      assert.deepEqual(await diff(), driftError(indexed, current), 'within the grace: the index request may be on its way');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(await diff(), driftError(indexed, current, false), 'nothing started: ignored');
      assert.equal(headChangedSince(from).length, 1);
    } finally {
      indexModule.setReindexRequestGraceMsForTests(undefined);
    }
    await settle();
  });

  it('no HEAD is never drift: .git gone after the index, and an index taken before the first commit', { timeout: 30_000 }, async () => {
    const dotGit = path.join(PROJECT, '.git');
    const from = posted.length;
    renameSync(dotGit, `${dotGit}-moved`);
    try {
      assert.equal((await diff()).status, 'not-a-git-repo', 'the diff behaves as today');
      // Indexed with no HEAD to read…
      await settle();
    } finally {
      renameSync(`${dotGit}-moved`, dotGit);
    }
    // …then the repository is back (a HEAD is known now): still no drift.
    assert.equal((await diff()).status, 'resolved');
    send({ type: 'graphService:checkHead', path: PROJECT });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(headChangedSince(from).length, 0);
    await settle();
  });

  it('graphService:checkHead: headChanged only on drift, only for the active project; malformed ignored', { timeout: 30_000 }, async () => {
    const from = posted.length;
    send({ type: 'graphService:checkHead', path: PROJECT });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(headChangedSince(from).length, 0, 'no drift');

    const indexed = head();
    git('commit', '-q', '--allow-empty', '-m', 'focus');
    const current = head();
    for (const bad of [{ type: 'graphService:checkHead' }, { type: 'graphService:checkHead', path: 'relative' }, { type: 'graphService:checkHead', path: '' }]) {
      send(bad);
    }
    send({ type: 'graphService:checkHead', path: path.join(PROJECT, 'elsewhere') });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(headChangedSince(from).length, 0, 'malformed, or another project');

    send({ type: 'graphService:checkHead', path: PROJECT });
    send({ type: 'graphService:checkHead', path: PROJECT });
    const posts = await waitFor(() => {
      const found = headChangedSince(from);
      return found.length > 0 ? found : undefined;
    }, 'headChanged');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(posts, [{ type: 'graphService:headChanged', path: PROJECT, indexedHead: indexed, currentHead: current }]);
    assert.equal(headChangedSince(from).length, 1);
    await settle();
  });

  it('MCP compute_diff_scope during drift: the same error, one re-index', { timeout: 30_000 }, async () => {
    assert.ok(mcp);
    type Handler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
    let handler: Handler | undefined;
    mcp.registerComputeDiffScopeTool({
      registerTool: (_name: string, _config: unknown, registered: Handler) => {
        handler = registered;
      },
    } as unknown as Parameters<typeof mcp.registerComputeDiffScopeTool>[0]);
    assert.ok(handler);
    const indexed = head();
    git('commit', '-q', '--allow-empty', '-m', 'agent');
    const current = head();
    const from = posted.length;
    const reply = await handler({ projectPath: PROJECT, baseRef: 'main' });
    assert.deepEqual(JSON.parse(reply.content[0]!.text), driftError(indexed, current));
    await handler({ projectPath: PROJECT, baseRef: 'main' });
    assert.equal(headChangedSince(from).length, 1);
    assert.equal(mcp.MCP_SERVER_VERSION, '1.12.0', 'P5-a itself changed no result shape; 1.12.0 is co-change’s additive Node field');
    await settle();
  });
});
