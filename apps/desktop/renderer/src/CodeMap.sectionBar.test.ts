/**
 * P4-4 phase 1c: what the Section bar asks of `CodeMap` and `App` — a
 * section-keyed reload through `loadCodeMap`'s full reset, the
 * `unknown-section` fallback to `all` (status text, never an error notice),
 * the regenerate patch keeping a section's severities, and the empty-section
 * notice.
 *
 * The pure helpers are pinned directly; the hook wiring in `CodeMap.tsx` and
 * `App.tsx` can't be rendered without a DOM, so it is pinned on the source
 * (like `CodeMap.sectionScopedOps.test.ts`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { CodeMapNode, CodeMapResult, SectionNodeCount } from '@driller/ipc-contracts';

import {
  EmptyMapNotice,
  blastRadiusStateOnUnknownSection,
  chooseEmptyMapCase,
  handOffUnknownSection,
  regeneratedNodeForMap,
} from './CodeMap';
import {
  INITIAL_SECTION_SHELL_STATE,
  applyMapReportToSectionShell,
  applySectionActivated,
  applyUnknownSection,
  type MapFooterState,
} from './appFrame';
import { renderTree, textOf } from './testRender';

const SECTIONS: SectionNodeCount[] = [
  { path: 'web', nodeCount: 792 },
  { path: 'api', nodeCount: 412 },
];

const codeMapSrc = readFileSync(fileURLToPath(new URL('./CodeMap.tsx', import.meta.url)), 'utf8');
const appSrc = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

/** The body of `const loadCodeMap = useCallback(() => { … }, [...]);`. */
function loadCodeMapBody(): string {
  const start = codeMapSrc.indexOf('const loadCodeMap = useCallback(() => {');
  assert.ok(start >= 0);
  const end = codeMapSrc.indexOf('}, [fixtureNodeCount, clearDiffScopeSync]);', start);
  assert.ok(end > start);
  return codeMapSrc.slice(start, end);
}

function node(id: string, severity: 'severe' | 'none'): CodeMapNode {
  return {
    id,
    name: id,
    file: `api/${id}.ts`,
    startLine: 1,
    endLine: 2,
    kind: 'Function',
    summaryStatus: 'ready',
    summary: 'old',
    riskSignals:
      severity === 'severe'
        ? [{ family: 'deterministic', kind: 'blast-radius', value: 40, severity: 'severe', file: `api/${id}.ts`, startLine: 1, endLine: 2 } as never]
        : [],
  };
}

describe('handOffUnknownSection', () => {
  const unknown: CodeMapResult = { status: 'unknown-section', section: 'docs', knownSections: ['web', 'api'] };

  it('hands an unknown-section reply to the fallback, with the section the request was sent with', () => {
    const called: string[] = [];
    assert.equal(handOffUnknownSection(unknown, 'docs', (section) => called.push(section)), true);
    // The requested section wins over the reply's echo.
    assert.equal(handOffUnknownSection({ ...unknown, section: 'echo' }, 'docs', (section) => called.push(section)), true);
    assert.deepEqual(called, ['docs', 'docs']);
  });

  it('without a fallback, for a whole-scope request, or for any other reply, it is not handed off', () => {
    const called: string[] = [];
    assert.equal(handOffUnknownSection(unknown, 'docs', undefined), false);
    assert.equal(handOffUnknownSection(unknown, null, (section) => called.push(section)), false);
    assert.equal(handOffUnknownSection({ status: 'error', message: 'x' }, 'docs', (section) => called.push(section)), false);
    assert.deepEqual(called, []);
  });
});

function ready(section: string | null, nodes: number, appliedScope: string[] = ['web', 'api']): MapFooterState {
  return { status: 'ready', nodes, edges: 0, appliedScope, sections: SECTIONS, section };
}

describe('section shell state (App)', () => {
  it('activating a section switches and says it is loading', () => {
    assert.deepEqual(applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'api'), {
      section: 'api',
      announcement: 'Loading section api…',
      pending: true,
    });
    const api = { section: 'api', announcement: '', pending: false };
    assert.deepEqual(applySectionActivated(api, null), { section: null, announcement: 'Loading all sections…', pending: true });
  });

  it('activating the section already selected changes nothing', () => {
    const api = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'api');
    assert.equal(applySectionActivated(api, 'api'), api);
    assert.equal(applySectionActivated(INITIAL_SECTION_SHELL_STATE, null), INITIAL_SECTION_SHELL_STATE);
  });

  it('the matching ready reply announces what is shown, with that reply’s Node count', () => {
    const loading = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'api');
    // A loading report, or the previous section's ready map, changes nothing.
    assert.equal(applyMapReportToSectionShell(loading, { status: 'loading' }), loading);
    assert.equal(applyMapReportToSectionShell(loading, ready(null, 1204)), loading);
    const shown = applyMapReportToSectionShell(loading, ready('api', 410));
    assert.deepEqual(shown, { section: 'api', announcement: 'Showing section api — 410 Nodes', pending: false });
    // Settled: later reports (a summary patch) don't re-announce.
    assert.equal(applyMapReportToSectionShell(shown, ready('api', 410)), shown);
    const all = applyMapReportToSectionShell(applySectionActivated(shown, null), ready(null, 1204));
    assert.equal(all.announcement, 'Showing all sections — 1,204 Nodes');
  });

  it('a failed switch announces the failure', () => {
    const loading = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'api');
    assert.deepEqual(applyMapReportToSectionShell(loading, { status: 'error' }), {
      section: 'api',
      announcement: 'Couldn’t load section api',
      pending: false,
    });
    // An error when no switch is pending is the map's own notice, not a switch's.
    const settled = { section: 'api', announcement: 'x', pending: false };
    assert.equal(applyMapReportToSectionShell(settled, { status: 'error' }), settled);
  });

  it('a ready reply with fewer than 2 distinct applied entries drops the selected section silently', () => {
    const settled = { section: 'api', announcement: 'Showing section api — 412 Nodes', pending: false };
    assert.deepEqual(applyMapReportToSectionShell(settled, ready('api', 412, ['api'])), {
      section: null,
      announcement: '',
      pending: false,
    });
    assert.equal(applyMapReportToSectionShell(settled, ready('api', 412, ['api', 'api'])).section, null);
    // With `all` selected there is nothing to drop.
    const all = { section: null, announcement: '', pending: false };
    assert.equal(applyMapReportToSectionShell(all, ready(null, 412, ['api'])), all);
  });

  it('unknown-section falls back to all with status text, replacing the loading text', () => {
    const docs = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'docs');
    assert.deepEqual(applyUnknownSection(docs, 'docs'), {
      section: null,
      announcement: 'docs is no longer in the indexing scope — showing all sections',
      pending: false,
    });
  });

  it('a late unknown-section for a section already left is ignored', () => {
    const web = { section: 'web', announcement: 'Showing section web — 792 Nodes', pending: false };
    assert.equal(applyUnknownSection(web, 'docs'), web);
  });
});

describe('Blast Radius unknown-section ends idle on all (P4-4e review (d))', () => {
  it('the fallback moves the shell to all and leaves the expansion to the reload', () => {
    let shell = applySectionActivated(INITIAL_SECTION_SHELL_STATE, 'docs');
    const next = blastRadiusStateOnUnknownSection('docs', (gone) => {
      shell = applyUnknownSection(shell, gone);
    });
    assert.equal(next, null, 'the expansion state is left to the reload');
    assert.equal(shell.section, null, 'the shell is on all');
  });

  it('…and that reload is loadCodeMap, keyed on the section, which resets the expansion to idle', () => {
    // P4-4h (founder decision 2026-10-04): the effect also starts a PR Review carry after the reset.
    assert.match(
      codeMapSrc,
      /useEffect\(\(\) => \{[^}]*const carry = diffScopeCarryCandidate\(\{ \.\.\.diffCarrySourceRef\.current, from, to: section \}\);\s*loadCodeMap\(\);[\s\S]*?\}, \[loadCodeMap, section\]\);/,
    );
    const body = loadCodeMapBody();
    assert.match(body, /setBlastRadiusState\(\{ status: 'idle' \}\);/);
    assert.match(body, /blastRadiusRequestIdRef\.current \+= 1;/);
  });
});

describe('CodeMap source: a switch reloads through the full reset', () => {
  it('loadCodeMap fetches the section on screen and resets everything a reload resets', () => {
    const body = loadCodeMapBody();
    assert.match(body, /const requestedSection = sectionRef\.current;\s*window\.driller\s*\.getCodeMap\(requestedSection \?\? undefined\)/);
    for (const reset of [
      /setHistory\(\{ stack: \[\], index: -1 \}\);/,
      /updateNodeDetail\(\{ status: 'closed' \}\);/,
      /setTypeDetail\(\{ status: 'closed' \}\);/,
      /setPathTrace\(\{ status: 'idle' \}\);/,
      /pathTraceRequestIdRef\.current \+= 1;/,
      /setBaseRefInput\(''\);/,
      /setDiffScopeState\(\{ status: 'idle' \}\);/,
      /clearDiffScopeSync\(\);/,
      /diffScopeRequestIdRef\.current \+= 1;/,
    ]) {
      assert.match(body, reset);
    }
  });

  it('an unknown-section load is handed to the fallback before the error state', () => {
    const body = loadCodeMapBody();
    const handOff = body.indexOf('if (handOffUnknownSection(result, requestedSection, onUnknownSectionRef.current)) {');
    const error = body.indexOf("setFetchState({ status: 'error', message: codeMapFailureMessage(result) });");
    assert.ok(handOff >= 0 && error > handOff);
  });

  it('a refresh fetches the section and hands an unknown-section reply off too', () => {
    const start = codeMapSrc.indexOf('const refreshCodeMap = useCallback(() => {');
    const body = codeMapSrc.slice(start, codeMapSrc.indexOf('}, [isDevFixtureMode, updateNodeDetail, clearDiffScopeSync]);', start));
    assert.match(body, /const requestedSection = sectionRef\.current;\s*window\.driller\s*\.getCodeMap\(requestedSection \?\? undefined\)/);
    assert.match(
      body,
      /requestId === refreshRequestIdRef\.current &&\s*handOffUnknownSection\(result, requestedSection, onUnknownSectionRef\.current\)\s*\) \{\s*return;/,
    );
  });

  it('the ready map carries the reply section and sections', () => {
    assert.equal(codeMapSrc.match(/section: result\.section,\s*sections: result\.sections,/g)?.length, 2);
  });
});

describe('regeneratedNodeForMap (P4-4d review round 1)', () => {
  // The section's Node: section-filtered links, the section's severities, an old stale summary.
  const onScreen: CodeMapNode = {
    ...node('handler', 'none'),
    stale: true,
    usesTypes: [{ id: 'api.Req', name: 'Req', kind: 'Interface' } as never],
    calledAtLoadBy: ['api/main.ts'],
    testCoverageAvailable: true,
  };
  // The whole-scope reply: a new summary, plus whole-scope severities and links.
  const regenerated: CodeMapNode = {
    ...node('handler', 'severe'),
    summary: 'new',
    usesTypes: [{ id: 'api.Req', name: 'Req', kind: 'Interface' } as never, { id: 'web.Props', name: 'Props', kind: 'Type' } as never],
    calledAtLoadBy: ['api/main.ts', 'web/main.ts'],
    fileTopLevel: [{ id: 'web.x' } as never],
    similarTo: [{ id: 'web.y' } as never],
    similarToTotal: 1,
  };

  it('in a section: only the regeneration fields from the reply, the rest of the on-screen Node kept', () => {
    const patched = regeneratedNodeForMap(onScreen, regenerated, 'api');
    const { summary, summaryStatus, stale, ...rest } = patched;
    assert.deepEqual({ summary, summaryStatus, stale }, { summary: 'new', summaryStatus: 'ready', stale: undefined });
    assert.equal('stale' in patched, false, 'a stale flag the reply cleared is not left over');
    const { summary: _s, summaryStatus: _ss, stale: _st, ...onScreenRest } = onScreen;
    void _s;
    void _ss;
    void _st;
    assert.deepEqual(rest, onScreenRest);
    assert.equal(patched.riskSignals, onScreen.riskSignals);
    assert.equal('fileTopLevel' in patched, false);
    assert.equal('similarTo' in patched, false);
  });

  it('a reply with no summary leaves none', () => {
    const pending = { ...regenerated, summaryStatus: 'pending' } as CodeMapNode;
    delete pending.summary;
    const patched = regeneratedNodeForMap(onScreen, pending, 'api');
    assert.equal(patched.summaryStatus, 'pending');
    assert.equal('summary' in patched, false);
  });

  it('in all: the reply as is', () => {
    assert.equal(regeneratedNodeForMap(onScreen, regenerated, null), regenerated);
  });
});

describe('empty section notice', () => {
  it('a section is its own case, whatever the whole-scope hiddenByScope says', () => {
    assert.deepEqual(chooseEmptyMapCase(229, 'api'), { kind: 'empty-section', section: 'api' });
    assert.deepEqual(chooseEmptyMapCase(0, 'api'), { kind: 'empty-section', section: 'api' });
    assert.deepEqual(chooseEmptyMapCase(229, null), { kind: 'scope-hid-everything', hiddenCount: 229 });
  });

  it('names the section, never the scope notice', () => {
    const elements = renderTree(
      EmptyMapNotice({
        hiddenByScope: 229,
        appliedScope: ['web', 'api'],
        section: 'api',
        graphServiceAvailable: true,
        reindexPending: false,
        onOpenSettings: () => {},
        onReindex: () => {},
      }),
    );
    const text = textOf(elements[0]);
    assert.match(text, /No map Nodes in api/);
    assert.doesNotMatch(text, /indexing scope/);
    assert.ok(elements.some((element) => element.type === 'code' && textOf(element) === 'api'));
    assert.equal(elements.filter((element) => element.type === 'button').length, 0);
  });
});

describe('App source: shell state and wiring', () => {

  it('map reports for the open project settle the section shell', () => {
    assert.match(
      appSrc,
      /if \(reportPath !== null && reportPath === currentProjectPathRef\.current\) \{\s*transitionSectionShell\(\(current\) => applyMapReportToSectionShell\(current, state\), state\);/,
    );
  });

  it('the map region is the tabpanel, labelled by the selected tab, while the bar is shown', () => {
    assert.match(
      appSrc,
      /<section\s+className="app__map"\s+id=\{SECTION_PANEL_ID\}\s+role=\{sectionBarShown \? 'tabpanel' : undefined\}\s+aria-labelledby=\{sectionPanelLabelledBy\}\s+aria-label=\{sectionPanelLabelledBy === undefined \? 'Code Map' : undefined\}/,
    );
    assert.match(
      appSrc,
      /const sectionPanelLabelledBy = sectionBarShown \? selectedSectionTabId\(sectionBarSource\.sections, section\) : undefined;/,
    );
  });

  it('resets the section on a project open (with the mode) and on Close', () => {
    assert.match(
      appSrc,
      /setMode\(wasAlreadyInRecentProjects \? 'codeMap' : 'healthAudit'\);\s*commitSectionShell\(INITIAL_SECTION_SHELL_STATE\);\s*setPendingSectionFocus\(null\);/,
    );
    // P4-4 phase 3b: a pending cross-section focus goes with it.
    assert.match(
      appSrc,
      /setMode\('codeMap'\);\s*commitSectionShell\(INITIAL_SECTION_SHELL_STATE\);\s*setPendingSectionFocus\(null\);\s*focusOpenFolderAfterCloseRef/,
    );
  });
});
