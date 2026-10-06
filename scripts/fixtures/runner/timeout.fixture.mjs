import { after, describe, it } from 'node:test';

describe('a test that never settles', () => {
  let keepAlive;
  // The timer keeps the event loop busy, so only the per-test timeout can
  // end the first test; clearing it afterwards lets the file finish.
  after(() => clearInterval(keepAlive));

  it('never settles', async () => {
    await new Promise(() => {
      keepAlive = setInterval(() => {}, 1_000);
    });
  });

  it('runs after the timed-out test', () => {});
});
