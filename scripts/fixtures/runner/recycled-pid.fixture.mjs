import { it } from 'node:test';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

// Stands in for PID reuse: the run log claims this test spawned `git status`
// as a PID that, by the end of the run, belongs to an unrelated process.
it('appears to have spawned a PID that now runs something else', () => {
  appendFileSync(
    process.env.DRILLER_TEST_RUN_LOG,
    `${JSON.stringify({ event: 'spawn', pid: Number(process.env.FIXTURE_FOREIGN_PID), command: 'git status', file: 'recycled' })}\n`,
  );
});
