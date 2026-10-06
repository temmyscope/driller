/**
 * P4-8c: the conventions the DOM test environment depends on.
 *
 * 1. Every `*.dom.test.tsx` / `*.dom.test.ts` starts with a bare
 *    side-effect import of `src/test/domEnv` (`import './test/domEnv';`).
 *    React-DOM decides whether a DOM exists when its module is evaluated,
 *    and imports are evaluated in order: anything evaluated before `domEnv`
 *    that pulls in React-DOM would see no `window`. A named import isn't
 *    enough — a type-only or unused one is erased by the compiler, and the
 *    module would then load wherever its next importer puts it.
 * 2. The test helpers under `src/test/` — and the DOM test dependencies
 *    themselves — are never imported by app code, so they never reach the
 *    app bundle. (The renderer's own `tsconfig.json` excludes `src/test/**`,
 *    but an import from app code would pull a file back in regardless.)
 *
 * Both checks are pure functions over file sources, run here against the
 * real tree and against inline cases that must fail.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SRC_DIR, '../../../..');
const TEST_HELPERS_DIR = path.join(SRC_DIR, 'test');
const DOM_ENV = path.join(TEST_HELPERS_DIR, 'domEnv');

/** Packages only DOM tests may import. */
const TEST_ONLY_PACKAGES = ['jsdom', '@testing-library/react', '@testing-library/dom', '@testing-library/user-event'];

interface SourceFile {
  /** Absolute path. */
  file: string;
  source: string;
}

const relative = (file: string) => path.relative(APP_ROOT, file);

/** `specifier` resolved against `fromFile`, extension dropped; `null` for a bare package specifier. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return null;
  }
  return path.resolve(path.dirname(fromFile), specifier).replace(/\.(tsx?|mts|cts|js|mjs)$/, '').replace(/\/index$/, '');
}

/** A file's first import (or re-export) declaration: its specifier, and whether it binds nothing. */
function firstImport(file: SourceFile): { specifier: string; bare: boolean } | null {
  const parsed = ts.createSourceFile(file.file, file.source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      return { specifier: statement.moduleSpecifier.text, bare: statement.importClause === undefined };
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      return { specifier: statement.moduleSpecifier.text, bare: false };
    }
  }
  return null;
}

const EXPECTED_FIRST = "expected a bare `import './test/domEnv';` first";

/** Each DOM test file that doesn't start with a bare import of `src/test/domEnv`, with what it starts with. */
function firstImportViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) => {
    const first = firstImport(file);
    if (first === null) {
      return [`${relative(file.file)}: first import is missing, ${EXPECTED_FIRST}`];
    }
    const resolved = resolveRelative(file.file, first.specifier);
    if (resolved === DOM_ENV && first.bare) {
      return [];
    }
    const what = resolved === DOM_ENV ? `a named or type import of '${first.specifier}'` : `'${first.specifier}'`;
    return [`${relative(file.file)}: first import is ${what}, ${EXPECTED_FIRST}`];
  });
}

/** Each app-code import of a test helper (`src/test/**`) or of a DOM-test-only package. */
function appImportViolations(files: readonly SourceFile[]): string[] {
  return files.flatMap((file) =>
    ts.preProcessFile(file.source, true, true).importedFiles.flatMap(({ fileName: specifier }) => {
      const resolved = resolveRelative(file.file, specifier);
      const helper = resolved !== null && (resolved === TEST_HELPERS_DIR || resolved.startsWith(`${TEST_HELPERS_DIR}${path.sep}`));
      const testPackage = TEST_ONLY_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
      return helper || testPackage ? [`${relative(file.file)} imports '${specifier}'`] : [];
    }),
  );
}

function read(pattern: string, exclude: (file: string) => boolean = () => false): SourceFile[] {
  return globSync(pattern, { cwd: APP_ROOT, exclude: (name) => name === 'node_modules' })
    .map((file) => path.join(APP_ROOT, file))
    .filter((file) => !exclude(file))
    .sort()
    .map((file) => ({ file, source: readFileSync(file, 'utf8') }));
}

const isTestFile = (file: string) => /\.test\.(ts|tsx|mts|mjs)$/.test(file);
const isTestHelper = (file: string) => file.startsWith(`${TEST_HELPERS_DIR}${path.sep}`);

describe('DOM test conventions (P4-8c)', () => {
  it('every *.dom.test.tsx / *.dom.test.ts starts with a bare import of src/test/domEnv', () => {
    const domTests = read('apps/**/*.dom.test.{ts,tsx}');
    assert.ok(domTests.length >= 3, `expected the DOM test files, found ${domTests.map((f) => relative(f.file)).join(', ')}`);
    assert.deepEqual(firstImportViolations(domTests), []);
  });

  it('the first-import check names a file that imports something else first, nothing, or domEnv by name', () => {
    const at = (name: string) => path.join(SRC_DIR, name);
    assert.deepEqual(
      firstImportViolations([
        { file: at('A.dom.test.tsx'), source: "import { render } from '@testing-library/react';\nimport './test/domEnv';\n" },
        { file: at('B.dom.test.tsx'), source: 'export {};\n' },
        { file: at('C.dom.test.tsx'), source: "import './other/domEnv';\n" },
        { file: at('D.dom.test.tsx'), source: "import { cleanupAfterEach } from './test/domEnv';\nimport { App } from './App';\n" },
        { file: at('E.dom.test.ts'), source: "import type { InstalledFake } from './test/domEnv';\nimport './test/domEnv';\n" },
        { file: at('F.dom.test.tsx'), source: "/** header */\nimport './test/domEnv';\nimport { cleanupAfterEach } from './test/domEnv';\n" },
        { file: path.join(TEST_HELPERS_DIR, 'G.dom.test.tsx'), source: "import './domEnv.ts';\n" },
      ]),
      [
        `apps/desktop/renderer/src/A.dom.test.tsx: first import is '@testing-library/react', ${EXPECTED_FIRST}`,
        `apps/desktop/renderer/src/B.dom.test.tsx: first import is missing, ${EXPECTED_FIRST}`,
        `apps/desktop/renderer/src/C.dom.test.tsx: first import is './other/domEnv', ${EXPECTED_FIRST}`,
        `apps/desktop/renderer/src/D.dom.test.tsx: first import is a named or type import of './test/domEnv', ${EXPECTED_FIRST}`,
        `apps/desktop/renderer/src/E.dom.test.ts: first import is a named or type import of './test/domEnv', ${EXPECTED_FIRST}`,
      ],
    );
  });

  it('no app code imports a test helper or a DOM test package', () => {
    const appCode = [
      ...read('apps/**/*.{ts,tsx}', (file) => isTestFile(file) || isTestHelper(file) || file.endsWith('.d.ts')),
      ...read('packages/**/*.{ts,tsx}', (file) => isTestFile(file) || file.endsWith('.d.ts')),
      ...read('services/**/*.{ts,tsx}', (file) => isTestFile(file) || file.endsWith('.d.ts')),
    ];
    assert.ok(
      appCode.some((file) => file.file === path.join(SRC_DIR, 'CodeMap.tsx')),
      'the scan covers renderer app code',
    );
    assert.deepEqual(appImportViolations(appCode), []);
  });

  it('the app-import check names a helper import, a package import and a dynamic import', () => {
    const file = path.join(SRC_DIR, 'Example.tsx');
    assert.deepEqual(
      appImportViolations([
        {
          file,
          source: [
            "import { createFakeDrillerApi } from './test/fakeDrillerApi';",
            "import { render } from '@testing-library/react';",
            "const env = import('./test/domEnv');",
            "import { JSDOM } from 'jsdom';",
            "import { App } from './App';",
            "import { testing } from './testing';",
            "import { x } from '@testing-library/react-native';",
          ].join('\n'),
        },
      ]),
      [
        "apps/desktop/renderer/src/Example.tsx imports './test/fakeDrillerApi'",
        "apps/desktop/renderer/src/Example.tsx imports '@testing-library/react'",
        "apps/desktop/renderer/src/Example.tsx imports './test/domEnv'",
        "apps/desktop/renderer/src/Example.tsx imports 'jsdom'",
      ],
    );
  });
});
