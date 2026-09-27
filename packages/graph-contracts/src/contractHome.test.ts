/**
 * P4-6: AD-13's "defined once" rule, pinned.
 *
 * Every Graph Service operation's result shape is declared in exactly one
 * place — this package — and consumed from here by both transports: IPC
 * (`@driller/ipc-contracts` re-exports them) and MCP
 * (`services/graph-service/mcp-server.ts` and `index.ts` import them). The
 * graph shapes those results carry (`CodeMapNode` and its closure, `GapFile`)
 * and `CodeMapEdge`/`CodeMapEdgeKind` moved with them and are held to the
 * same rule.
 *
 * This fails when:
 *  - one of those names is not declared exactly once in this package's
 *    source, or is not exported from its entry (`src/index.ts`);
 *  - `@driller/ipc-contracts`'s entry stops re-exporting one of them;
 *  - any other non-test `.ts`/`.tsx` source under `apps/`, `packages/` or
 *    `services/` declares a type, interface, class or enum with one of those
 *    names (the message names the file), or re-exports one from anywhere
 *    other than `@driller/graph-contracts`;
 *  - this package's source imports or requires another `@driller/` package,
 *    an absolute path, or a relative path outside its own `src/`; or its
 *    `package.json` or `tsconfig*.json` (`references`, `paths`) points at
 *    another repo package. `ipc-contracts` may depend on this package, never
 *    the reverse.
 *
 * Syntactic (plus the checker for this package's export surface), via the
 * TypeScript compiler API as the P2-10 key-boundary tests are: it sees
 * declarations by name, not a structurally identical copy under another name,
 * and it does not follow `export *`.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** The six Graph Service operation result types (AD-13). */
const OPERATION_RESULT_TYPES = [
  'PathTraceResult',
  'NodeLookupResult',
  'CoverageSummaryResult',
  'IndexCoverageSummary',
  'DiffScopeResult',
  'BlastRadiusExpansionResult',
] as const;

/** Graph shapes moved with the result types in P4-6: their structural dependencies, plus `CodeMapEdge`/`CodeMapEdgeKind` beside `CodeMapNode`. */
const MOVED_GRAPH_SHAPES = [
  'GapFile',
  'CodeMapNode',
  'CodeMapNodeKind',
  'CodeMapEdge',
  'CodeMapEdgeKind',
  'SummaryStatus',
  'RiskSignal',
  'RiskSignalFamily',
  'RiskSignalLocation',
  'DeterministicRiskSignal',
  'DeterministicRiskSignalType',
  'DeterministicRiskSeverity',
  'LlmJudgmentRiskSignal',
  'IngestedRiskSignal',
  'TestedBy',
  'TestedByTest',
  'TestedByFile',
  'FileTopLevelUse',
  'FoldedModule',
  'TopLevelChangedFile',
  'SimilarImplementation',
] as const;

/**
 * Constants that belong with those shapes: `TESTED_BY_MAX_TESTS` bounds
 * `TestedBy.tests`; `SIMILAR_TO_MIN_JACCARD`/`SIMILAR_TO_MAX_ENTRIES` bound
 * `CodeMapNode.similarTo` (P4-2 phase 4).
 */
const CONTRACT_CONSTANTS = ['TESTED_BY_MAX_TESTS', 'SIMILAR_TO_MIN_JACCARD', 'SIMILAR_TO_MAX_ENTRIES'] as const;

const CONTRACT_HOME_NAMES: readonly string[] = [...OPERATION_RESULT_TYPES, ...MOVED_GRAPH_SHAPES, ...CONTRACT_CONSTANTS];
const HOME_SPECIFIER = '@driller/graph-contracts';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(srcDir, '..');
const appRoot = path.resolve(packageDir, '..', '..');
const WORKSPACE_ROOTS = ['apps', 'packages', 'services'].map((dir) => path.join(appRoot, dir));
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'out', '.vite']);

function isSource(name: string): boolean {
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts');
}

/** Every non-test `.ts`/`.tsx` file under `dir`, recursively, skipping build output and `node_modules`. */
function walkSources(dir: string, exclude: (dir: string) => boolean = () => false): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    if (exclude(current)) {
      return;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && isSource(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files.sort();
}

/** Every non-test source in the repo's workspaces except this package's own. */
function consumerFiles(): string[] {
  return WORKSPACE_ROOTS.flatMap((root) => walkSources(root, (dir) => dir === packageDir));
}

function parse(filePath: string, sourceText = readFileSync(filePath, 'utf8')): ts.SourceFile {
  const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2022, true, kind);
}

function rel(file: string): string {
  return path.relative(appRoot, file).split(path.sep).join('/');
}

function isGuarded(name: string): boolean {
  return CONTRACT_HOME_NAMES.includes(name);
}

/**
 * Every type alias, interface, class and enum declared anywhere in `source`
 * (nested ones included), plus every top-level `const`/`let`/`var` binding —
 * the guarded constants (`CONTRACT_CONSTANTS`) are module-level.
 */
function declarations(source: ts.SourceFile): string[] {
  const found: string[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          found.push(declaration.name.text);
        }
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      (ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `file: Name` for each guarded name `source` declares locally. */
function redeclarations(source: ts.SourceFile): string[] {
  return declarations(source)
    .filter(isGuarded)
    .map((name) => `${rel(source.fileName)}: ${name}`);
}

/** Local binding name -> the module it is imported from, for every import in `source`. */
function importOrigins(source: ts.SourceFile): Map<string, string> {
  const origins = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name) {
      origins.set(clause.name.text, from);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        origins.set(element.name.text, from);
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      origins.set(bindings.name.text, from);
    }
  }
  return origins;
}

/** Guarded names `source` re-exports under that name, as `{ name, from }` (`from` is `undefined` for a local, non-imported binding). */
function guardedReExports(source: ts.SourceFile): { name: string; from: string | undefined; renamed: boolean }[] {
  const origins = importOrigins(source);
  const found: { name: string; from: string | undefined; renamed: boolean }[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    const moduleFrom =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    for (const element of statement.exportClause.elements) {
      const exported = element.name.text;
      if (!isGuarded(exported)) {
        continue;
      }
      const local = element.propertyName?.text ?? exported;
      found.push({
        name: exported,
        from: moduleFrom ?? origins.get(local),
        renamed: local !== exported,
      });
    }
  }
  return found;
}

/** `file: Name (from X)` for each guarded name re-exported from anywhere other than this package. */
function foreignReExports(source: ts.SourceFile): string[] {
  return guardedReExports(source)
    .filter((reExport) => reExport.from !== HOME_SPECIFIER || reExport.renamed)
    .map(
      (reExport) =>
        `${rel(source.fileName)}: ${reExport.name} (from ${reExport.from ?? 'a local declaration'}${reExport.renamed ? ', renamed' : ''})`,
    );
}

/** Every module specifier `source` reaches: static/dynamic imports, re-exports, `import type`, `require()`, `import x = require()`. */
function moduleSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Why `specifier`, imported by `fromFile`, breaks this package's no-repo-dependency rule — or `undefined` if it doesn't. */
function forbiddenSpecifier(specifier: string, fromFile: string): string | undefined {
  if (specifier.startsWith('@driller/')) {
    return 'another @driller package';
  }
  if (path.isAbsolute(specifier) || specifier.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(specifier)) {
    return 'an absolute path';
  }
  if (specifier.startsWith('.')) {
    return isInside(path.resolve(path.dirname(fromFile), specifier), srcDir) ? undefined : 'outside graph-contracts/src';
  }
  return undefined;
}

/** `file: specifier (reason)` for each forbidden specifier in `source`. */
function forbiddenImports(source: ts.SourceFile): string[] {
  return moduleSpecifiers(source).flatMap((specifier) => {
    const reason = forbiddenSpecifier(specifier, source.fileName);
    return reason ? [`${rel(source.fileName)}: ${specifier} (${reason})`] : [];
  });
}

/** Whether `target` (already absolute) is inside a repo workspace package other than this one. */
function isOtherRepoPackage(target: string): boolean {
  return WORKSPACE_ROOTS.some((root) => isInside(target, root)) && !isInside(target, packageDir);
}

/** Every `references` entry and `paths` mapping in a parsed tsconfig that points at another repo package. */
function forbiddenTsconfigLinks(config: ts.ParsedCommandLine, configDir: string): string[] {
  const found: string[] = [];
  for (const reference of config.projectReferences ?? []) {
    const target = path.resolve(configDir, reference.path);
    if (isOtherRepoPackage(target) || !isInside(target, packageDir)) {
      found.push(`references: ${rel(target)}`);
    }
  }
  const paths = config.options.paths ?? {};
  const base = (config.options.pathsBasePath as string | undefined) ?? config.options.baseUrl ?? configDir;
  for (const [key, targets] of Object.entries(paths)) {
    if (key.startsWith('@driller/')) {
      found.push(`paths: ${key}`);
      continue;
    }
    for (const target of targets) {
      const resolved = path.resolve(base, target.replace(/\*.*$/, ''));
      if (isOtherRepoPackage(resolved)) {
        found.push(`paths: ${key} -> ${target}`);
      }
    }
  }
  return found;
}

function parseTsconfig(configPath: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  assert.equal(read.error, undefined, `could not read ${rel(configPath)}`);
  return ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
}

/** Names exported from this package's entry, resolved by the type checker (not a text scan). */
function entryExports(): Set<string> {
  const entry = path.join(srcDir, 'index.ts');
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  assert.ok(source, 'graph-contracts entry not found');
  const moduleSymbol = checker.getSymbolAtLocation(source);
  assert.ok(moduleSymbol, 'graph-contracts entry is not a module');
  return new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName()));
}

describe('graph-contracts is the one home of every Graph Service operation shape (P4-6, AD-13)', () => {
  const homeSources = walkSources(srcDir).map((file) => parse(file));
  const homeDeclarations = homeSources.flatMap(declarations);
  const exported = entryExports();

  for (const name of CONTRACT_HOME_NAMES) {
    it(`declares ${name} once and exports it from its entry`, () => {
      const count = homeDeclarations.filter((declared) => declared === name).length;
      assert.equal(count, 1, `${name} must be declared exactly once in packages/graph-contracts/src (found ${count})`);
      assert.ok(exported.has(name), `${name} is not exported from packages/graph-contracts/src/index.ts`);
    });
  }

  it('ipc-contracts re-exports every one of them from @driller/graph-contracts', () => {
    const ipcEntry = parse(path.join(appRoot, 'packages', 'ipc-contracts', 'src', 'index.ts'));
    const reExported = new Set(
      guardedReExports(ipcEntry)
        .filter((reExport) => reExport.from === HOME_SPECIFIER && !reExport.renamed)
        .map((reExport) => reExport.name),
    );
    const missing = CONTRACT_HOME_NAMES.filter((name) => !reExported.has(name));
    assert.deepEqual(missing, [], `packages/ipc-contracts/src/index.ts must re-export from ${HOME_SPECIFIER}: ${missing.join(', ')}`);
  });

  it('no other source in apps/, packages/ or services/ redeclares one', () => {
    const files = consumerFiles();
    // Sanity: the walk must actually reach the files that used to declare these shapes.
    for (const expected of [
      'packages/ipc-contracts/src/index.ts',
      'services/graph-service/mcp-server.ts',
      'services/graph-service/index.ts',
    ]) {
      assert.ok(files.map(rel).includes(expected), `the scan did not reach ${expected}`);
    }
    const offenders = files.flatMap((file) => redeclarations(parse(file)));
    assert.deepEqual(
      offenders,
      [],
      `Declared outside packages/graph-contracts (import or re-export it from ${HOME_SPECIFIER} instead):\n  ${offenders.join('\n  ')}`,
    );
  });

  it(`no other source re-exports one from anywhere but ${HOME_SPECIFIER}`, () => {
    const offenders = consumerFiles().flatMap((file) => foreignReExports(parse(file)));
    assert.deepEqual(offenders, [], `Re-exported from the wrong place:\n  ${offenders.join('\n  ')}`);
  });

  it('its source depends on nothing else in the repo', () => {
    assert.ok(homeSources.length > 0, 'no graph-contracts sources found');
    const offenders = homeSources.flatMap(forbiddenImports);
    assert.deepEqual(offenders, [], `graph-contracts must depend on nothing in the repo:\n  ${offenders.join('\n  ')}`);
  });

  it('its package.json and tsconfigs point at no other repo package', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    const internalDeps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((field) => Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}))
      .filter((dep) => dep.startsWith('@driller/'));
    assert.deepEqual(internalDeps, [], 'packages/graph-contracts/package.json must not depend on another @driller package');

    const configs = readdirSync(packageDir).filter((name) => /^tsconfig.*\.json$/.test(name));
    assert.ok(configs.length > 0, 'no tsconfig found in packages/graph-contracts');
    const offenders = configs.flatMap((name) =>
      forbiddenTsconfigLinks(parseTsconfig(path.join(packageDir, name)), packageDir).map((link) => `${name}: ${link}`),
    );
    assert.deepEqual(offenders, [], `graph-contracts tsconfig points at another repo package:\n  ${offenders.join('\n  ')}`);
  });

  // Self-checks: the detectors above must actually fire on the violations
  // they exist for, or a green run proves nothing.
  describe('detector self-checks', () => {
    it('detects a redeclaration, naming the file', () => {
      const fake = parse(
        path.join(appRoot, 'services', 'graph-service', 'risk-signals.ts'),
        "export type NodeLookupResult = { status: 'ok' };\ninterface GapFile { path: string }\n",
      );
      assert.deepEqual(redeclarations(fake), [
        'services/graph-service/risk-signals.ts: NodeLookupResult',
        'services/graph-service/risk-signals.ts: GapFile',
      ]);
    });

    it('accepts an import or a re-export from the home package', () => {
      const fake = parse(
        path.join(appRoot, 'services', 'graph-service', 'mcp-server.ts'),
        `import type { DiffScopeResult } from '${HOME_SPECIFIER}';\nexport type { DiffScopeResult };\nexport type { CodeMapNode } from '${HOME_SPECIFIER}';\n`,
      );
      assert.deepEqual(redeclarations(fake), []);
      assert.deepEqual(foreignReExports(fake), []);
    });

    it('flags a re-export from anywhere else, or of a local declaration', () => {
      const fake = parse(
        path.join(appRoot, 'apps', 'desktop', 'main', 'x.ts'),
        "import type { CodeMapNode } from '@driller/ipc-contracts';\nexport type { CodeMapNode };\nexport type { GapFile } from './gap';\ntype DiffScopeResult = never;\nexport type { DiffScopeResult };\nexport type { Foo as RiskSignal } from '@driller/graph-contracts';\n",
      );
      assert.deepEqual(foreignReExports(fake), [
        'apps/desktop/main/x.ts: CodeMapNode (from @driller/ipc-contracts)',
        'apps/desktop/main/x.ts: GapFile (from ./gap)',
        'apps/desktop/main/x.ts: DiffScopeResult (from a local declaration)',
        'apps/desktop/main/x.ts: RiskSignal (from @driller/graph-contracts, renamed)',
      ]);
    });

    it('detects every way this package could import another repo package', () => {
      const fake = parse(
        path.join(srcDir, 'index.ts'),
        [
          "import type { CodeMapEdge } from '@driller/ipc-contracts';",
          "type X = import('@driller/ipc-contracts').CodeMapNode;",
          "const y = require('../../ipc-contracts/src/index');",
          "import z = require('/abs/elsewhere');",
          "export * from '../../../services/graph-service/index';",
          "const w = await import('file:///tmp/x.js');",
          "import { ok } from './pathTrace';",
          "import ts from 'typescript';",
        ].join('\n'),
      );
      assert.deepEqual(forbiddenImports(fake), [
        'packages/graph-contracts/src/index.ts: @driller/ipc-contracts (another @driller package)',
        'packages/graph-contracts/src/index.ts: @driller/ipc-contracts (another @driller package)',
        'packages/graph-contracts/src/index.ts: ../../ipc-contracts/src/index (outside graph-contracts/src)',
        'packages/graph-contracts/src/index.ts: /abs/elsewhere (an absolute path)',
        'packages/graph-contracts/src/index.ts: ../../../services/graph-service/index (outside graph-contracts/src)',
        'packages/graph-contracts/src/index.ts: file:///tmp/x.js (an absolute path)',
      ]);
    });

    it('detects tsconfig references and paths into another repo package', () => {
      const config = ts.parseJsonConfigFileContent(
        {
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@driller/ipc-contracts': ['../ipc-contracts/src/index.ts'],
              'contracts/*': ['../../services/graph-service/*'],
              'local/*': ['./src/*'],
            },
          },
          references: [{ path: '../ipc-contracts' }],
          files: [],
        },
        ts.sys,
        packageDir,
      );
      assert.deepEqual(forbiddenTsconfigLinks(config, packageDir), [
        'references: packages/ipc-contracts',
        'paths: @driller/ipc-contracts',
        'paths: contracts/* -> ../../services/graph-service/*',
      ]);
    });
  });
});
