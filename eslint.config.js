// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.vite/**',
      '**/out/**',
      '**/dist/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Electron main process, preload script, and the Graph Service subprocess
    // all run in a Node.js context.
    files: [
      'apps/desktop/main/**/*.ts',
      'apps/desktop/preload/**/*.ts',
      'apps/desktop/*.config.ts',
      'apps/desktop/forge.config.ts',
      'services/graph-service/**/*.ts',
      'services/graph-service/*.config.ts',
      'packages/*/src/**/*.ts',
      // Repo tooling that Node itself runs (the `npm test` TypeScript
      // loader), not app code — a Node context like the three above.
      'scripts/**/*.mjs',
      '*.config.js',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // AD-11: renderer code must reach main only via the contextBridge-exposed
    // preload API. It must never import Electron/Node APIs directly, and it
    // must not see Node globals — these rules make that boundary enforceable
    // by the linter, not just a convention.
    files: ['apps/desktop/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'Renderer code must not import Electron APIs directly (AD-11). Use the contextBridge-exposed window.driller API from preload instead.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'require', message: 'Renderer has nodeIntegration disabled (AD-11).' },
        { name: 'process', message: 'Renderer has nodeIntegration disabled (AD-11).' },
        { name: '__dirname', message: 'Renderer has nodeIntegration disabled (AD-11).' },
        { name: '__filename', message: 'Renderer has nodeIntegration disabled (AD-11).' },
        { name: 'module', message: 'Renderer has nodeIntegration disabled (AD-11).' },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
