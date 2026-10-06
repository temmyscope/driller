import { it } from 'node:test';

// Code under test that swallows a refused fetch must not hide the attempt.
it('catches the refusal', async () => {
  try {
    await fetch('https://example.com', { signal: AbortSignal.timeout(3_000) });
  } catch {
    // swallowed on purpose
  }
});
