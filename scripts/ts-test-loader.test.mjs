/**
 * Guard test for `scripts/ts-test-loader.mjs`'s `import.meta.env` define
 * (P4-8c). Runs under the loader itself (`npm test` registers it for every
 * file), so importing a `.ts` fixture goes through the same transform a
 * renderer module does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('ts-test-loader: import.meta.env', () => {
  it('defines DEV as false, PROD as true and MODE as "test", as a production build would', async () => {
    const { env } = await import('./fixtures/loader/import-meta-env.ts');
    assert.deepEqual(env, { dev: false, prod: true, mode: 'test' });
  });
});
