/**
 * P2-1: the indexing-scope group's one confirmation sentence after a
 * successful save — applied with folders, applied and emptied, and saved but
 * not applied (Graph Service not running).
 *
 * Run by `npm test` through `scripts/ts-test-loader.mjs`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { projectScopeSaveOutcome, projectScopeSavedMessage } from './Settings';

describe('projectScopeSavedMessage', () => {
  it('names the folders the map now shows when applied', () => {
    assert.equal(
      projectScopeSavedMessage({ includedPaths: ['web', 'app'] }, true),
      'Saved — the map now shows only web, app.',
    );
    assert.equal(projectScopeSavedMessage({ includedPaths: ['web'] }, true), 'Saved — the map now shows only web.');
  });

  it('says the whole project is back when an emptied scope is applied', () => {
    assert.equal(projectScopeSavedMessage({ includedPaths: [] }, true), 'Saved — the map shows the whole project.');
  });

  it('says when it applies when saved but not applied', () => {
    const expected = 'Saved — applies when the Graph Service is running again.';
    assert.equal(projectScopeSavedMessage({ includedPaths: ['web'] }, false), expected);
    assert.equal(projectScopeSavedMessage({ includedPaths: [] }, false), expected);
  });
});

describe('projectScopeSaveOutcome', () => {
  it('an applied save refetches the map and confirms what it shows', () => {
    assert.deepEqual(projectScopeSaveOutcome({ config: { includedPaths: ['web'] }, applied: true }), {
      notice: 'Saved — the map now shows only web.',
      refetch: true,
    });
    assert.deepEqual(projectScopeSaveOutcome({ config: { includedPaths: [] }, applied: true }), {
      notice: 'Saved — the map shows the whole project.',
      refetch: true,
    });
  });

  it('an unapplied save does not refetch, and says when it applies', () => {
    assert.deepEqual(projectScopeSaveOutcome({ config: { includedPaths: ['web'] }, applied: false }), {
      notice: 'Saved — applies when the Graph Service is running again.',
      refetch: false,
    });
  });
});
