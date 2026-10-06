/**
 * Fixture for `scripts/ts-test-loader.test.mjs` (P4-8c): reads
 * `import.meta.env` the way renderer code does, so the test can see what
 * the loader's `define` turns each read into.
 */
export const env = {
  dev: import.meta.env.DEV,
  prod: import.meta.env.PROD,
  mode: import.meta.env.MODE,
};
