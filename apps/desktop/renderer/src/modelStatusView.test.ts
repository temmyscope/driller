/** P5-c review round 1: the model badge is hidden under Cloud (pure). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModelStatusMessage } from '@driller/ipc-contracts';

import { visibleModelStatus } from './modelStatusView';

const AT = '2026-10-18T00:00:00.000Z';
const STATUSES: ModelStatusMessage[] = [
  { type: 'graphService:modelStatus', state: 'downloading', at: AT, downloadedBytes: 1, totalBytes: 2 },
  { type: 'graphService:modelStatus', state: 'verifying', at: AT },
  { type: 'graphService:modelStatus', state: 'ready', at: AT, model: 'm.gguf' },
  { type: 'graphService:modelStatus', state: 'error', at: AT, message: 'down' },
];

describe('visibleModelStatus', () => {
  it('hides every state under Cloud (a leftover Local badge, late progress)', () => {
    for (const status of STATUSES) {
      assert.equal(visibleModelStatus(status, 'cloud'), null, status.state);
    }
  });

  it('shows every state under Local, and before the config has loaded', () => {
    for (const status of STATUSES) {
      assert.equal(visibleModelStatus(status, 'local'), status);
      assert.equal(visibleModelStatus(status, undefined), status);
    }
    assert.equal(visibleModelStatus(null, 'local'), null);
  });
});
