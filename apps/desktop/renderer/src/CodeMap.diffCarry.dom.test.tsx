/**
 * P4-8e: PR Review across a section switch, rendered for real (jsdom, a
 * fake `window.driller`) — replacing the P4-4h source pins on `CodeMap.tsx`
 * for PR Review's "Switch to …" focus and the diff carry's status lines.
 *
 * A small shell plays App's part: it holds the section, renders the real
 * Section bar above `CodeMap`, and applies `onSwitchSection`. The project
 * has two sections (`api`, `web`); the diff, computed in `web`, also changed
 * a Node in `api`, so PR Review offers "Switch to api". Every carry reply is
 * a deferred the test settles, so each line can be read while it is pending.
 */
import './test/domEnv';
import { cleanupAfterEach, elementSize, resizeObservers } from './test/domEnv';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { env } from 'node:process';
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CodeMapResult, DiffScopeCarryResult, DiffScopeResult } from '@driller/ipc-contracts';
import { CodeMap, type CodeMapProps } from './CodeMap';
import { SectionBar } from './SectionBar';
import { createFakeDrillerApi, deferred, type Deferred, type DrillerStubs, type FakeDrillerApi } from './test/fakeDrillerApi';
import { SECTION_NODES, sectionedMap, type SectionName } from './test/mapFixture';

afterEach(cleanupAfterEach);

/** 8a allows 20 s per test; these finish well under 2 s (doubled under CI, P4-8b's convention). */
const BUDGET = { timeout: 3_000 * (env.CI === 'true' ? 2 : 1) };
const FIND = { timeout: 1_500 };
const PROJECT = '/work/two-sections';
const S = SECTION_NODES;

const ENTER_BASE_REF = 'Enter a base ref (or leave it blank to auto-resolve) and compute the diff scope to see changed Nodes.';

/** The diff of `web`, which also changed `handler` in `api`. */
const WEB_DIFF: DiffScopeResult = {
  status: 'resolved',
  resolvedBaseRef: 'abc123',
  nodeIds: [S.render.id],
  changedInOtherSections: [{ section: 'api', changedNodes: 1, changedContracts: 0, topLevelFiles: 0 }],
};
const API_DIFF: DiffScopeResult = { status: 'resolved', resolvedBaseRef: 'abc123', nodeIds: [S.handler.id] };

/** Replies the test settles by hand, one queue per member, in call order. */
interface Pending {
  maps: Deferred<CodeMapResult>[];
  carries: Deferred<DiffScopeCarryResult>[];
  diffs: Deferred<DiffScopeResult>[];
}

/**
 * `web`'s first map and first diff answer at once; every later map, carry
 * check and diff waits in `pending` unless `stubs` replaces it.
 */
function carryFake(stubs: DrillerStubs = {}): { fake: FakeDrillerApi; pending: Pending } {
  const pending: Pending = { maps: [], carries: [], diffs: [] };
  let mapCalls = 0;
  let diffCalls = 0;
  const fake = createFakeDrillerApi({
    getCodeMap: (section) => {
      mapCalls += 1;
      if (mapCalls === 1) {
        return Promise.resolve(sectionedMap((section ?? null) as SectionName | null));
      }
      const reply = deferred<CodeMapResult>();
      pending.maps.push(reply);
      return reply.promise;
    },
    getShowFoldedKinds: async () => false,
    getEntryPins: async () => [],
    computeDiffScope: () => {
      diffCalls += 1;
      if (diffCalls === 1) {
        return Promise.resolve(structuredClone(WEB_DIFF));
      }
      const reply = deferred<DiffScopeResult>();
      pending.diffs.push(reply);
      return reply.promise;
    },
    checkDiffScopeCarry: () => {
      const reply = deferred<DiffScopeCarryResult>();
      pending.carries.push(reply);
      return reply.promise;
    },
    expandBlastRadius: async () => ({ status: 'resolved', hopDistances: {} }),
    ...stubs,
  });
  fake.install();
  return { fake, pending };
}

function props(overrides: Partial<CodeMapProps> = {}): CodeMapProps {
  const noop = () => {};
  return {
    projectPath: PROJECT,
    noSummaryBackendAvailable: false,
    cloudSelectedNoKey: false,
    mode: 'prReview',
    onRequestCodeMapMode: noop,
    graphServiceAvailable: true,
    dataVersion: 0,
    onMapState: noop,
    onDiffScopeSynced: noop,
    onOpenSettings: noop,
    onReindex: async () => true,
    onSwitchSection: noop,
    ...overrides,
  };
}

/** App's side, in miniature: the section is its state; the Section bar and `onSwitchSection` both set it. */
function Shell({
  switches,
  dataVersion = 0,
  projectPath = PROJECT,
  mode = 'prReview',
  onDiffScopeSynced = () => {},
}: {
  switches: string[];
  dataVersion?: number;
  projectPath?: string;
  mode?: CodeMapProps['mode'];
  onDiffScopeSynced?: CodeMapProps['onDiffScopeSynced'];
}) {
  const [section, setSection] = useState<string | null>('web');
  return (
    <>
      <SectionBar sections={sectionedMap('web').sections} section={section} enabled onChange={setSection} />
      <CodeMap
        {...props({
          projectPath,
          section,
          dataVersion,
          mode,
          onDiffScopeSynced,
          onSwitchSection: (next) => {
            switches.push(next);
            setSection(next);
          },
        })}
      />
    </>
  );
}

function drawnIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')]
    .map((node) => node.getAttribute('data-id') ?? '')
    .filter((id) => !id.startsWith('cluster:'))
    .sort();
}

async function waitForDrawn(ids: readonly string[]): Promise<void> {
  await waitFor(() => {
    resizeObservers.resizeAll(elementSize.width, elementSize.height);
    assert.deepEqual(drawnIds(), [...ids].sort());
  }, FIND);
}

function baseRefInput(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Base ref' }) as HTMLInputElement;
}

/** The PR Review status lines (idle, loading, resolved), in order. */
function statusLines(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.code-map__pr-review p.code-map__pr-review-resolved')].map(
    (line) => line.textContent ?? '',
  );
}

/** In `web`: computes the diff against `main`, then presses "Switch to api". */
async function switchToApiWithDiff(): Promise<void> {
  await waitForDrawn([S.render.id, S.layout.id]);
  await act(async () => {
    fireEvent.change(baseRefInput(), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
  });
  const switchButton = await screen.findByRole('button', { name: 'Switch to api' }, FIND);
  await act(async () => {
    fireEvent.click(switchButton);
  });
}

function focused(): string {
  const active = document.activeElement;
  return active === null ? 'nothing' : `${active.tagName.toLowerCase()}${active.getAttribute('aria-label') ? ` "${active.getAttribute('aria-label')}"` : ''}${active.getAttribute('role') === 'tab' ? ` tab ${active.textContent}` : ''}`;
}

describe('PR Review "Switch to api" (replaces the prReviewSwitchFocusTarget wiring pin)', () => {
  it('switches to that section, still in PR Review, and focuses the base-ref input once its map is ready', BUDGET, async () => {
    const { fake, pending } = carryFake();
    const switches: string[] = [];
    render(<Shell switches={switches} />);
    await switchToApiWithDiff();
    assert.deepEqual(switches, ['api']);
    assert.deepEqual(fake.calls.getCodeMap, [['web'], ['api']]);
    assert.ok(document.activeElement !== baseRefInput(), 'not before the api map is ready');

    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    await waitForDrawn([S.handler.id, S.validate.id]);
    await waitFor(() => assert.ok(document.activeElement === baseRefInput(), `the base-ref input has focus (on ${focused()})`), FIND);
    assert.equal(baseRefInput().value, 'main', 'the base ref is kept for the carry');
    assert.ok(screen.getByRole('textbox', { name: 'Base ref' }), 'still PR Review');
    await act(async () => pending.carries[0]!.resolve({ status: 'not-carried' }));
    assert.equal(baseRefInput().value, '');
  });

  it('with the input disabled by the carried re-run, focus goes to the selected Section bar tab instead', BUDGET, async () => {
    const { pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    // The check answers first: the diff re-runs, so the input is disabled
    // when the api map lands.
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.equal(baseRefInput().disabled, true);
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    await waitForDrawn([S.handler.id, S.validate.id]);
    const apiTab = screen.getByRole('tab', { selected: true });
    assert.match(apiTab.textContent ?? '', /^api/);
    await waitFor(() => assert.ok(document.activeElement === apiTab, `the api tab has focus (on ${focused()})`), FIND);
    await act(async () => pending.diffs[0]!.resolve(API_DIFF));
  });
});

describe('the diff carry’s status lines (replaces the carry-flow line pins)', () => {
  it('while the check runs, the idle line says what is checked; then it is the plain prompt again', BUDGET, async () => {
    const { fake, pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    assert.deepEqual(fake.calls.checkDiffScopeCarry, [[PROJECT, 'web', 'api', 'main']]);
    assert.deepEqual(statusLines(), ['Checking whether main applies in api/…']);
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    assert.deepEqual(statusLines(), ['Checking whether main applies in api/…'], 'held while the check runs');
    await act(async () => pending.carries[0]!.resolve({ status: 'not-carried' }));
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
    assert.equal(fake.calls.computeDiffScope.length, 1, 'not carried: no re-run');
  });

  it('a carried re-run is announced in the loading line, and runs the button’s own request in the new section', BUDGET, async () => {
    const { fake, pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    await act(async () => pending.carries[0]!.resolve({ status: 'ref-exists' }));
    assert.deepEqual(statusLines(), ['Recomputing the diff against main in api/…']);
    assert.deepEqual(fake.calls.computeDiffScope, [
      [PROJECT, 'main', 'web'],
      [PROJECT, 'main', 'api'],
    ]);
    await act(async () => pending.diffs[0]!.resolve(API_DIFF));
    await waitFor(() => assert.match(statusLines()[0] ?? '', /^Diffed against abc123 — 1 changed Node\./), FIND);
  });

  it('the re-run keeps the button’s stale-reply guard: a refresh while it runs drops its late reply', BUDGET, async () => {
    const { pending } = carryFake({ getCodeMap: async (section) => sectionedMap((section ?? null) as SectionName | null) });
    const { rerender } = render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await waitForDrawn([S.handler.id, S.validate.id]);
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.deepEqual(statusLines(), ['Recomputing the diff against main in api/…']);
    rerender(<Shell switches={[]} dataVersion={1} />);
    await waitFor(() => assert.deepEqual(statusLines(), [ENTER_BASE_REF]), FIND);
    await act(async () => pending.diffs[0]!.resolve(API_DIFF));
    assert.deepEqual(statusLines(), [ENTER_BASE_REF], 'the late reply never lands');
  });

  it('a manual compute supersedes the check: plain "Computing diff scope…", and the late check changes nothing', BUDGET, async () => {
    const { fake, pending } = carryFake();
    const { rerender } = render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
    });
    assert.deepEqual(statusLines(), ['Computing diff scope…']);
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.deepEqual(statusLines(), ['Computing diff scope…']);
    assert.equal(fake.calls.computeDiffScope.length, 2, 'the check’s reply runs no second re-run');
    await act(async () => pending.diffs[0]!.resolve(API_DIFF));
    await waitFor(() => assert.match(statusLines()[0] ?? '', /^Diffed against abc123/), FIND);
    assert.equal(baseRefInput().value, 'main');
    // The check is over for good: the next idle line is the plain prompt.
    rerender(<Shell switches={[]} projectPath="/work/other" />);
    await waitFor(() => assert.deepEqual(statusLines(), [ENTER_BASE_REF]), FIND);
  });

  it('after a carried re-run, the next manual compute is announced plainly', BUDGET, async () => {
    const { pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.deepEqual(statusLines(), ['Recomputing the diff against main in api/…']);
    await act(async () => pending.diffs[0]!.resolve(API_DIFF));
    await waitFor(() => assert.match(statusLines()[0] ?? '', /^Diffed against abc123/), FIND);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
    });
    assert.deepEqual(statusLines(), ['Computing diff scope…']);
    await act(async () => pending.diffs[1]!.resolve(API_DIFF));
    await waitFor(() => assert.match(statusLines()[0] ?? '', /^Diffed against abc123/), FIND);
  });
});

describe('PR Review’s "changed elsewhere" line (P4-8j: replaces the line-placement pin)', () => {
  it('sits right beneath the change count, outside every live region; the count’s status says it instead', BUDGET, async () => {
    carryFake();
    const switches: string[] = [];
    render(<Shell switches={switches} />);
    await waitForDrawn([S.render.id, S.layout.id]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compute diff scope' }));
    });
    const line = await screen.findByRole('list', { name: 'Changed in other sections' }, FIND);
    const count = line.previousElementSibling;
    assert.ok(count !== null && count.getAttribute('role') === 'status', 'the line follows a status paragraph');
    assert.match(count.textContent ?? '', /^Diffed against abc123 — 1 changed Node\./, 'that paragraph is the change count');
    assert.ok(line.closest('[role="status"]') === null, 'the line (and its buttons) is in no live region');
    assert.ok((count.textContent ?? '').endsWith(' Also changed in api/: 1 changed Node.'), `the count says it (${count.textContent})`);
    assert.equal(line.textContent, 'api/: 1 changed Node — Switch to api');
    await act(async () => {
      fireEvent.click(within(line).getByRole('button', { name: 'Switch to api' }));
    });
    assert.deepEqual(switches, ['api']);
  });
});

describe('the carry check’s settle (P4-8j: replaces the carry-flow pin)', () => {
  for (const [what, settle] of [
    ['an error reply', (reply: Deferred<DiffScopeCarryResult>) => reply.resolve({ status: 'error', message: 'git failed' })],
    ['a rejected check', (reply: Deferred<DiffScopeCarryResult>) => reply.reject(new Error('IPC down'))],
  ] as const) {
    it(`${what} clears the kept base ref and re-runs nothing`, BUDGET, async () => {
      const { fake, pending } = carryFake();
      render(<Shell switches={[]} />);
      await switchToApiWithDiff();
      await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
      assert.equal(baseRefInput().value, 'main', 'kept while the check runs');
      await act(async () => settle(pending.carries[0]!));
      assert.equal(baseRefInput().value, '');
      assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
      assert.equal(fake.calls.computeDiffScope.length, 1, 'no re-run');
    });
  }

  it('PR Review left before a carried reply: nothing re-runs, and the check is over', BUDGET, async () => {
    const { fake, pending } = carryFake();
    const { rerender } = render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    rerender(<Shell switches={[]} mode="codeMap" />);
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.equal(fake.calls.computeDiffScope.length, 1, 'no diff is run outside PR Review');
    rerender(<Shell switches={[]} mode="prReview" />);
    assert.deepEqual(statusLines(), [ENTER_BASE_REF], 'the check line is gone');
    assert.equal(fake.calls.computeDiffScope.length, 1);
  });
});

describe('what cancels a carry check in flight (P4-8j: replaces the cancel, unmount and reset pins)', () => {
  it('typing in the base-ref input: the line is the prompt again, and a late carried reply neither re-runs nor touches the text', BUDGET, async () => {
    const { fake, pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    assert.deepEqual(statusLines(), ['Checking whether main applies in api/…']);
    fireEvent.change(baseRefInput(), { target: { value: 'dev' } });
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.equal(baseRefInput().value, 'dev');
    assert.equal(fake.calls.computeDiffScope.length, 1, 'no re-run');
    // A late "not carried" would clear the input: it must not either.
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
  });

  it('typing, then a late "not carried": what was typed stays', BUDGET, async () => {
    const { pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    fireEvent.change(baseRefInput(), { target: { value: 'dev' } });
    await act(async () => pending.carries[0]!.resolve({ status: 'not-carried' }));
    assert.equal(baseRefInput().value, 'dev');
  });

  it('an unmount: a late carried reply runs no diff', BUDGET, async () => {
    const { fake, pending } = carryFake();
    const { unmount } = render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    unmount();
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.equal(fake.calls.computeDiffScope.length, 1);
  });

  it('an unmount: a late diff reply reports no sync time', BUDGET, async () => {
    const synced: [string | null, number | null][] = [];
    const { pending } = carryFake();
    const { unmount } = render(<Shell switches={[]} onDiffScopeSynced={(path, at) => synced.push([path, at])} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.deepEqual(statusLines(), ['Recomputing the diff against main in api/…']);
    const before = synced.length;
    unmount();
    await act(async () => pending.diffs[0]!.resolve(API_DIFF));
    assert.deepEqual(synced.slice(before), [], 'nothing reported after the unmount');
  });

  it('a reload (the map’s Retry): the line is the prompt, and the late carried reply re-runs nothing', BUDGET, async () => {
    const { fake, pending } = carryFake();
    render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.reject(new Error('Graph Service busy')));
    const retry = await screen.findByRole('button', { name: 'Retry' }, FIND);
    assert.deepEqual(statusLines(), ['Checking whether main applies in api/…'], 'the check outlives a failed load');
    await act(async () => {
      fireEvent.click(retry);
    });
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
    await act(async () => pending.maps[1]!.resolve(sectionedMap('api')));
    // The canvas mounts again after the failed load: let it draw (and fit) before the test ends.
    await waitForDrawn([S.handler.id, S.validate.id]);
    await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
    assert.equal(fake.calls.computeDiffScope.length, 1, 'no re-run');
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
    assert.deepEqual(fake.calls.checkDiffScopeCarry.length, 1, 'a reload starts no check of its own');
  });

  it('a refresh (a new data version): the line is the prompt, and the late carried reply re-runs nothing', BUDGET, async () => {
    const { fake, pending } = carryFake();
    const { rerender } = render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    rerender(<Shell switches={[]} dataVersion={1} />);
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
    await act(async () => pending.maps[1]!.resolve(sectionedMap('api')));
    await act(async () => pending.carries[0]!.resolve({ status: 'ref-exists' }));
    assert.equal(fake.calls.computeDiffScope.length, 1, 'no re-run');
    assert.deepEqual(statusLines(), [ENTER_BASE_REF]);
  });
});

describe('the diff carry across a project change (latent, P4-8e finding)', () => {
  // Found by this phase, not fixed (app code is out of scope): CodeMap's
  // project-change reset leaves a pending carry check live — its line stays,
  // and its reply re-runs the old project's diff into the new project's
  // state. Unreachable through App today: App unmounts CodeMap on a project
  // change while it reads the new project's saved section (P4-8d), and the
  // unmount moves the carry id on. A `todo` until CodeMap's reset owns it.
  it('a project change drops a pending carry check', { ...BUDGET, todo: 'the project-change reset does not cancel a pending carry check' }, async () => {
    const { fake, pending } = carryFake();
    const { rerender } = render(<Shell switches={[]} />);
    await switchToApiWithDiff();
    await act(async () => pending.maps[0]!.resolve(sectionedMap('api')));
    rerender(<Shell switches={[]} projectPath="/work/other" />);
    try {
      assert.deepEqual(statusLines(), [ENTER_BASE_REF], 'the new project shows no check');
      await act(async () => pending.carries[0]!.resolve({ status: 'same-repository' }));
      assert.equal(fake.calls.computeDiffScope.length, 1, 'no re-run of the old project’s diff');
    } finally {
      await act(async () => pending.carries[0]!.resolve({ status: 'not-carried' }));
      await act(async () => pending.diffs[0]?.resolve(API_DIFF));
    }
  });
});
