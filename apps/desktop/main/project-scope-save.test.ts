/**
 * P2-1: main hands a saved scope to the Graph Service only for the open
 * project with a running service, always hands over the persisted,
 * normalized value, and rejects a malformed call without persisting.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProjectScopeConfig } from '@driller/ipc-contracts';

import { resolveProjectScopeSave, type ProjectScopeSaveDeps } from './project-scope-save';

const PROJECT = '/repo/a';
const RAW = ['web/', ' web', 'app\\'];
const NORMALIZED = ['web', 'app'];

/** A `persist` that records its calls and normalizes like `coerceIncludedPaths` would. */
function fakePersist(): { persist: ProjectScopeSaveDeps['persist']; calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  return {
    calls,
    persist: (projectPath, includedPaths): ProjectScopeConfig => {
      calls.push([projectPath, includedPaths]);
      return { includedPaths: includedPaths === RAW ? NORMALIZED : includedPaths };
    },
  };
}

describe('resolveProjectScopeSave', () => {
  it('posts the persisted, normalized scope and replies applied for the open project with a running service', () => {
    const { persist, calls } = fakePersist();
    const decision = resolveProjectScopeSave(PROJECT, RAW, { persist, serviceRunning: true, currentProjectPath: PROJECT });
    assert.deepEqual(calls, [[PROJECT, RAW]]);
    assert.deepEqual(decision, {
      post: { type: 'graphService:scopeChanged', path: PROJECT, includedPaths: NORMALIZED },
      result: { config: { includedPaths: NORMALIZED }, applied: true },
    });
  });

  it('posts an emptied scope too (the whole project comes back)', () => {
    const { persist } = fakePersist();
    const decision = resolveProjectScopeSave(PROJECT, [], { persist, serviceRunning: true, currentProjectPath: PROJECT });
    assert.deepEqual(decision.post?.includedPaths, []);
    assert.equal(decision.result.applied, true);
  });

  it('persists but posts nothing and replies not applied when the service is down', () => {
    const { persist, calls } = fakePersist();
    const decision = resolveProjectScopeSave(PROJECT, RAW, { persist, serviceRunning: false, currentProjectPath: PROJECT });
    assert.equal(calls.length, 1);
    assert.deepEqual(decision, { post: null, result: { config: { includedPaths: NORMALIZED }, applied: false } });
  });

  it('persists but posts nothing and replies not applied for a project that is not open', () => {
    const { persist, calls } = fakePersist();
    for (const currentProjectPath of ['/repo/b', null]) {
      const decision = resolveProjectScopeSave(PROJECT, RAW, { persist, serviceRunning: true, currentProjectPath });
      assert.equal(decision.post, null);
      assert.equal(decision.result.applied, false);
    }
    assert.equal(calls.length, 2);
  });

  it('throws a specific sentence and persists nothing for a missing project', () => {
    const { persist, calls } = fakePersist();
    for (const projectPath of ['', undefined, 3]) {
      assert.throws(
        () => resolveProjectScopeSave(projectPath, RAW, { persist, serviceRunning: true, currentProjectPath: PROJECT }),
        { message: "Couldn't save the indexing scope: no project was given." },
      );
    }
    assert.equal(calls.length, 0);
  });

  it('throws a specific sentence and persists nothing for a malformed folder list', () => {
    const { persist, calls } = fakePersist();
    for (const includedPaths of ['web', ['web', 1], undefined]) {
      assert.throws(
        () => resolveProjectScopeSave(PROJECT, includedPaths, { persist, serviceRunning: true, currentProjectPath: PROJECT }),
        { message: "Couldn't save the indexing scope: the folder list wasn't a list of folder names." },
      );
    }
    assert.equal(calls.length, 0);
  });
});
