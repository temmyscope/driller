/**
 * P2-10: AD-4's one sanctioned key hop, pinned inside the Graph Service.
 *
 * The Graph Service receives the plaintext cloud key from main (the one hop
 * AD-4 sanctions) and must never echo it back to main, log it or persist it.
 * This scans every non-test source file under this directory (recursively)
 * and fails, naming file and line, when a guarded sink's arguments reference
 * a key-bearing name.
 *
 * Sinks: `console.*` (dot or element access), `process.stdout.write` /
 * `process.stderr.write` and any other `.write(…)`, `postMessage` and every
 * `post*` wrapper (bare or as a member call), and the `fs` write/append calls
 * (sync, callback and promise forms).
 *
 * Key-bearing names: `cloudApiKey`, `activeBackendConfig`, `backendConfig`,
 * any identifier matching `/api.?key/i`, and the raw request — `data` or
 * `event.data` — passed whole (reading a field off it, `data.type`, is fine).
 *
 * The check is syntactic: it sees these names at these sinks, not a key
 * copied into a differently named variable first.
 *
 * `main`'s sibling guard (`apps/desktop/main/key-boundary.test.ts`) scans
 * main the same way; the two are kept separate because each process has its
 * own sinks and its own sanctioned sends.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const KEY_NAMES = new Set(['cloudApiKey', 'activeBackendConfig', 'backendConfig']);
const KEY_NAME_PATTERN = /api.?key/i;
const RAW_REQUEST_NAME = 'data';

const FS_WRITE_CALLS = new Set([
  'write',
  'writeSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
]);
const POST_CALL_PATTERN = /^post[A-Z]\w*$/;

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.tsx'];

function isSource(name: string): boolean {
  return (
    SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) &&
    !/\.test\.(ts|mts|tsx)$/.test(name) &&
    !name.endsWith('.d.ts')
  );
}

/** Every non-test source file under `dir`, recursively, skipping `node_modules`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return entry.isFile() && isSource(entry.name) ? [full] : [];
  });
}

/** The sink a call writes to, or `undefined` if it isn't a guarded one. */
function guardedSink(callee: ts.Expression): string | undefined {
  if (ts.isElementAccessExpression(callee)) {
    return ts.isIdentifier(callee.expression) && callee.expression.text === 'console' ? 'console[…]' : undefined;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'console') {
      return `console.${name}`;
    }
    if (POST_CALL_PATTERN.test(name) || FS_WRITE_CALLS.has(name)) {
      return `${callee.expression.getText()}.${name}`;
    }
    return undefined;
  }
  if (ts.isIdentifier(callee) && (POST_CALL_PATTERN.test(callee.text) || FS_WRITE_CALLS.has(callee.text))) {
    return callee.text;
  }
  return undefined;
}

function inTypePosition(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) {
      return true;
    }
    if (ts.isExpression(current) || ts.isStatement(current)) {
      return false;
    }
  }
  return false;
}

/** `data` or `event.data` as a whole value — not `data.type`, not the key in `{ data: x }`. */
function isWholeRawRequest(node: ts.Node): boolean {
  const { parent } = node;
  const readsAField =
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
  if (readsAField) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    if (node.text !== RAW_REQUEST_NAME) {
      return false;
    }
    const isPropertyKey = ts.isPropertyAssignment(parent) && parent.name === node;
    const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
    return !isPropertyKey && !isMemberName;
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === RAW_REQUEST_NAME &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'event'
  );
}

function referencesKey(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && !inTypePosition(node)) {
    if (KEY_NAMES.has(node.text) || KEY_NAME_PATTERN.test(node.text)) {
      return true;
    }
  }
  if (isWholeRawRequest(node)) {
    return true;
  }
  return ts.forEachChild(node, referencesKey) ?? false;
}

function findKeyLeaks(fileName: string, sourceText: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const leaks: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const sink = guardedSink(node.expression);
      if (sink && node.arguments.some(referencesKey)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        leaks.push(`${fileName}:${line + 1} ${sink}(…)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return leaks;
}

/**
 * AD-4 condition 5: every assignment to the held backend config goes through
 * `nextBackendConfig`, which builds it from the request alone — so a request
 * without `cloudApiKey` drops the key rather than keeping the old one.
 */
function findUnguardedConfigAssignments(fileName: string, sourceText: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'activeBackendConfig'
    ) {
      const { right } = node;
      const viaHelper =
        ts.isCallExpression(right) && ts.isIdentifier(right.expression) && right.expression.text === 'nextBackendConfig';
      if (!viaHelper) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${fileName}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const SERVICE_DIR = fileURLToPath(new URL('.', import.meta.url));

function scanDir<T>(dir: string, scan: (fileName: string, text: string) => T[]): T[] {
  const files = sourceFiles(dir);
  assert.ok(files.length > 0, `no sources found to scan under ${dir}`);
  return files.flatMap((file) => scan(path.relative(dir, file), readFileSync(file, 'utf8')));
}

describe('AD-4 key hop: Graph Service log, post and write guard', () => {
  it('never passes the key, the backend config or the raw request to a log, post or write', () => {
    const leaks = scanDir(SERVICE_DIR, findKeyLeaks);
    assert.deepEqual(leaks, [], `Key material may reach a log, a message to main or disk: ${leaks.join(', ')}`);
  });

  it('replaces the held backend config only through nextBackendConfig (condition 5)', () => {
    const unguarded = scanDir(SERVICE_DIR, findUnguardedConfigAssignments);
    assert.deepEqual(unguarded, [], `activeBackendConfig assigned without nextBackendConfig: ${unguarded.join(', ')}`);
  });

  it('catches each sink and each key-bearing name', () => {
    const mutated = [
      "console.error('backend', activeBackendConfig);",
      'console.log(`key ${backendConfig.cloudApiKey}`);',
      "process.parentPort.postMessage({ type: 'x', cloudApiKey });",
      "postStatus({ state: 'ready', config: { ...activeBackendConfig } });",
      "console.log('safe', activeBackend, data.type, event.data.path, { data: 1 });",
      "console['warn'](apiKey);",
      'this.postProgress(backendConfig);',
      "process.stderr.write(String(data));",
      "fs.writeFileSync('/tmp/x', JSON.stringify(event.data));",
      "await fsp.appendFile('/tmp/x', apiKey);",
      'appendFileSync(logPath, { ...data });',
      'const n: typeof apiKey = 1 as unknown as ApiKeyShape;',
    ].join('\n');
    assert.deepEqual(findKeyLeaks('mutated.ts', mutated), [
      'mutated.ts:1 console.error(…)',
      'mutated.ts:2 console.log(…)',
      'mutated.ts:3 process.parentPort.postMessage(…)',
      'mutated.ts:4 postStatus(…)',
      'mutated.ts:6 console[…](…)',
      'mutated.ts:7 this.postProgress(…)',
      'mutated.ts:8 process.stderr.write(…)',
      'mutated.ts:9 fs.writeFileSync(…)',
      'mutated.ts:10 fsp.appendFile(…)',
      'mutated.ts:11 appendFileSync(…)',
    ]);
  });

  it('flags a direct assignment that would keep a stale key', () => {
    const mutated = [
      'activeBackendConfig = nextBackendConfig(request);',
      'activeBackendConfig = { ...activeBackendConfig, ...request };',
    ].join('\n');
    assert.deepEqual(findUnguardedConfigAssignments('mutated.ts', mutated), ['mutated.ts:2']);
  });

  it('scans subfolders, and skips tests and node_modules', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'key-boundary-'));
    try {
      mkdirSync(path.join(dir, 'adapters', 'cloud'), { recursive: true });
      mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(path.join(dir, 'index.ts'), "console.log('ok');\n");
      writeFileSync(path.join(dir, 'adapters', 'cloud', 'client.mts'), "\nconsole.debug(apiKey);\n");
      writeFileSync(path.join(dir, 'adapters', 'view.tsx'), 'postMessage(data);\n');
      writeFileSync(path.join(dir, 'adapters', 'client.test.ts'), 'console.log(apiKey);\n');
      writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.ts'), 'console.log(apiKey);\n');
      assert.deepEqual(scanDir(dir, findKeyLeaks).sort(), [
        `${path.join('adapters', 'cloud', 'client.mts')}:2 console.debug(…)`,
        `${path.join('adapters', 'view.tsx')}:1 postMessage(…)`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
