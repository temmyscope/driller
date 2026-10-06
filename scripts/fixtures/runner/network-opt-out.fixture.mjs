// @allow-network: fixture proving the per-file opt-out; it never sends a byte
import { it } from 'node:test';
import assert from 'node:assert/strict';

it('a remote fetch reaches the real fetch, which aborts it before connecting', async () => {
  await assert.rejects(fetch('https://example.com', { signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
});
