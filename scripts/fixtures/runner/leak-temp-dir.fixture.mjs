import { it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('forgets to remove its temp dir', () => {
  mkdtempSync(path.join(os.tmpdir(), 'driller-scope-git-'));
});
