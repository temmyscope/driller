import { it } from 'node:test';
import { spawn } from 'node:child_process';

// The child is still exiting when the runner finishes, but it isn't a leak:
// the runner's exit grace lets it go.
it('starts a short-lived child and returns without waiting for it', () => {
  spawn('sleep', ['0.3'], { stdio: 'ignore' }).unref();
});
