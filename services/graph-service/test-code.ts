/**
 * P4-2 phase 1: test code is excluded from the Code Map population.
 *
 * On driller/app, test-file Nodes were about a quarter of the map and touched
 * 41% of its edges. Many of those edges are the backend's name-resolution
 * errors (a production function "using" a local declared inside a test). They
 * made test locals the highest in-degree Nodes on the map and inflated blast
 * radius and the project-relative severe cuts for production code.
 *
 * `excludeTestCode` runs in the Graph Service's Code Map fetch path
 * (`production-code-map.ts`), before the scope filter, adjacency, blast
 * radius, severity cuts and every cache built from the fetched map (diff
 * scope, `lookup_node`, Health Audit). So every number on the map describes
 * production code only.
 *
 * Driller indexes arbitrary projects, so the rules below cover the common
 * test conventions of each ecosystem, not only this repo's own.
 */

/** Directory segments (lower-cased) whose contents are test code. */
const TEST_DIRECTORY_SEGMENTS: ReadonlySet<string> = new Set([
  '__tests__',
  'test',
  'tests',
  'spec',
  '__mocks__',
  'e2e',
  'cypress',
  'playwright',
]);

/** Test-support file stems (lower-cased, JS/TS extension removed). */
const TEST_SUPPORT_STEMS: ReadonlySet<string> = new Set([
  'testrender',
  'test-utils',
  'testutils',
  'setuptests',
  'jest.setup',
  'vitest.setup',
]);

const JS_TS_EXTENSION = /\.[cm]?[jt]sx?$/i;

/**
 * File-name rules. Most are case-insensitive. The Java/Kotlin/.NET suffixes
 * (`FooTest.java`, `FooTests.cs`, `FooIT.kt`) stay case-sensitive on the
 * suffix itself: those conventions are CamelCase, and a case-insensitive
 * `*test.java` / `*it.java` / `*tests.cs` would also match production files
 * such as `Latest.java`, `Audit.java` or `Contests.cs`. Their extension is
 * still matched case-insensitively.
 */
const TEST_FILE_NAME_RULES: readonly RegExp[] = [
  /\.(test|spec)\./i, // *.test.* / *.spec.*
  /_test\.go$/i, // Go
  /^test_.*\.py$/i, // Python
  /_test\.py$/i,
  /^conftest\.py$/i,
  /_spec\.rb$/i, // Ruby
  /(Tests?|IT)\.(?:[jJ][aA][vV][aA]|[kK][tT])$/, // Java / Kotlin
  /Tests\.[cC][sS]$/, // .NET
];

/**
 * Splits `file` into the segments that lie inside the project, skipping `.`
 * and empty segments and resolving `..`. `inside` is false when the path is
 * absolute or climbs above its own start, i.e. when it is not a clean
 * project-relative path: then its directory segments may be ancestors of
 * the project root (`/home/u/tests/myproj/src/a.ts`) and must not count.
 */
function projectSegments(file: string): { segments: string[]; inside: boolean } {
  const absolute = /^([\\/]|[A-Za-z]:)/.test(file);
  const segments: string[] = [];
  let inside = !absolute;
  for (const segment of file.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0) {
        segments.pop();
      } else {
        inside = false;
      }
      continue;
    }
    segments.push(segment);
  }
  return { segments, inside };
}

/**
 * Whether a project-relative file path is test code. Pure. Rules:
 *  - file names: `*.test.*`, `*.spec.*`, Go `*_test.go`, Python `test_*.py`
 *    / `*_test.py` / `conftest.py`, Ruby `*_spec.rb`, Java/Kotlin
 *    `*Test`/`*Tests`/`*IT` `.java`/`.kt`, .NET `*Tests.cs`;
 *  - directory segments (case-insensitive): `__tests__`, `test`, `tests`,
 *    `spec`, `__mocks__`, `e2e`, `cypress`, `playwright`, or any segment
 *    ending in `.Tests`;
 *  - test-support files with a JS/TS extension: `testRender`, `test-utils`,
 *    `testUtils`, `setupTests`, `jest.setup`, `vitest.setup`; and any file
 *    matching `/test-?loader/i` under a `scripts` segment.
 *
 * Only segments inside the project count: for an absolute or `..`-escaping
 * path only the file-name rules apply (see `projectSegments`).
 */
export function isTestPath(file: string): boolean {
  const { segments, inside } = projectSegments(file);
  const basename = segments[segments.length - 1];
  if (basename === undefined) {
    return false;
  }
  if (TEST_FILE_NAME_RULES.some((rule) => rule.test(basename))) {
    return true;
  }
  if (JS_TS_EXTENSION.test(basename) && TEST_SUPPORT_STEMS.has(basename.replace(JS_TS_EXTENSION, '').toLowerCase())) {
    return true;
  }
  if (!inside) {
    return false;
  }
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  if (directories.some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment) || segment.endsWith('.tests'))) {
    return true;
  }
  return directories.includes('scripts') && /test-?loader/i.test(basename);
}

/**
 * Whether a Node is test code: its path matches `isTestPath`, or the backend
 * flagged it `is_test`. Both count because the backend flag is false on
 * Interfaces and Types declared inside test files.
 */
export function isTestNode(node: { file: string; isTest?: boolean }): boolean {
  return node.isTest === true || isTestPath(node.file);
}

/**
 * Removes test Nodes and every edge with either end on a test Node. `nodes`'
 * `file` must already be project-relative (see `isTestPath`). Returns the
 * input arrays themselves when nothing is test code.
 *
 * Nodes are filtered one by one, so a test Node that shares its id with a
 * production Node never takes the production one with it. An edge is only
 * dropped for an id that no production Node carries.
 */
export function excludeTestCode<
  TNode extends { id: string; file: string; isTest?: boolean },
  TEdge extends { source: string; target: string },
>(nodes: TNode[], edges: TEdge[]): { nodes: TNode[]; edges: TEdge[] } {
  const productionNodes = nodes.filter((node) => !isTestNode(node));
  if (productionNodes.length === nodes.length) {
    return { nodes, edges };
  }
  const productionIds = new Set(productionNodes.map((node) => node.id));
  const testOnlyIds = new Set(
    nodes.filter((node) => !productionIds.has(node.id)).map((node) => node.id),
  );
  return {
    nodes: productionNodes,
    edges: edges.filter((edge) => !testOnlyIds.has(edge.source) && !testOnlyIds.has(edge.target)),
  };
}
