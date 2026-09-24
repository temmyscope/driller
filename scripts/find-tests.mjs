/**
 * Preflight for `npm test`.
 *
 * `node --test` exits 0 when its glob patterns match nothing, so a renamed
 * file or a moved directory would silently drop the repo to zero tests with
 * every command still green — the failure mode a test suite exists to
 * prevent. This globs the same patterns first and fails loudly on zero
 * matches, then execs the runner.
 *
 * Patterns live here rather than in `package.json` so the preflight and the
 * runner can never be given different ones.
 */
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import process from 'node:process';

/** Not exported: this file is a script, not a module. Kept in step with `renderer/tsconfig.json`'s `exclude` and `tsconfig.test.json`'s `include`. */
const TEST_PATTERNS = [
  'apps/**/*.test.ts',
  'apps/**/*.test.tsx',
  'packages/**/*.test.ts',
  'packages/**/*.test.tsx',
  'services/**/*.test.ts',
  'services/**/*.test.tsx',
];

const matches = TEST_PATTERNS.flatMap((pattern) =>
  globSync(pattern, { exclude: (name) => name === 'node_modules' }),
).sort();

if (matches.length === 0) {
  process.stderr.write(
    `No test files matched. Expected at least one of:\n${TEST_PATTERNS.map((p) => `  ${p}`).join('\n')}\n` +
      'If tests moved, update TEST_PATTERNS in scripts/find-tests.mjs (and the two renderer tsconfigs) rather than leaving the suite silently empty.\n',
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', './scripts/register-ts-test-loader.mjs', '--test', ...matches],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
