/**
 * `--import` entry point that installs `ts-test-loader.mjs`'s hooks before
 * the test files are loaded. Separate from the hooks themselves because
 * `module.register` runs them on their own thread.
 */
import { register } from 'node:module';
register('./ts-test-loader.mjs', import.meta.url);
