/**
 * P2-10: AD-4's key hop, pinned in main — the process that decrypts.
 *
 * main may send the plaintext key to the Graph Service (the one sanctioned
 * hop, built in graph-service-requests.ts) and nowhere else: not to a log,
 * not to the diagnostic log, not to disk, and not to the renderer. This
 * scans every non-test source file under this directory (recursively) and
 * fails, naming file and line, when a guarded sink's arguments reference a
 * key-bearing name.
 *
 * Sinks: `console.*` (dot or element access), `appendDiagnosticLogEntry`,
 * the `fs` write/append calls and any other `.write(…)`, renderer-bound
 * sends (`.send(…)`, `.reply(…)` — `webContents.send`, `event.sender.send`),
 * and the values an `ipcMain.handle`/`handleOnce`/`on` callback returns,
 * which reach the renderer as the reply.
 *
 * Key-bearing names: `cloudApiKey`, and any identifier matching
 * `/api.?key/i` — which covers `getDecryptedCloudApiKey(…)`.
 *
 * The check is syntactic: it sees these names at these sinks, not a key
 * copied into a differently named variable first. The Graph Service has its
 * own sibling guard (`services/graph-service/key-boundary.test.ts`).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const KEY_NAMES = new Set(['cloudApiKey']);
const KEY_NAME_PATTERN = /api.?key/i;

const FS_WRITE_CALLS = new Set([
  'write',
  'writeSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
]);
const RENDERER_SEND_CALLS = new Set(['send', 'reply']);
const LOG_CALLS = new Set(['appendDiagnosticLogEntry']);
const IPC_MAIN_REGISTRATIONS = new Set(['handle', 'handleOnce', 'on', 'once']);

/**
 * Sites allowed to trip the guard, as `file:sink`, each with its reason.
 * Empty: no current main source passes key material to a guarded sink.
 */
const ALLOWLIST = new Map<string, string>([]);

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
    if (FS_WRITE_CALLS.has(name) || RENDERER_SEND_CALLS.has(name) || LOG_CALLS.has(name)) {
      return `${callee.expression.getText()}.${name}`;
    }
    return undefined;
  }
  if (ts.isIdentifier(callee) && (FS_WRITE_CALLS.has(callee.text) || LOG_CALLS.has(callee.text))) {
    return callee.text;
  }
  return undefined;
}

/** `ipcMain.handle(channel, callback)` and friends: the callback, whose return value reaches the renderer. */
function ipcMainCallback(call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined {
  const callee = call.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== 'ipcMain' ||
    !IPC_MAIN_REGISTRATIONS.has(callee.name.text)
  ) {
    return undefined;
  }
  const callback = call.arguments[1];
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback : undefined;
}

/** The expressions a function returns — its own `return`s, not those of functions nested in it. */
function returnedExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) {
    return [];
  }
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      returned.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return returned;
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

function referencesKey(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && !inTypePosition(node)) {
    if (KEY_NAMES.has(node.text) || KEY_NAME_PATTERN.test(node.text)) {
      return true;
    }
  }
  return ts.forEachChild(node, referencesKey) ?? false;
}

function findKeyLeaks(fileName: string, sourceText: string): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const leaks: string[] = [];
  const report = (node: ts.Node, sink: string): void => {
    if (ALLOWLIST.has(`${fileName}:${sink}`)) {
      return;
    }
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    leaks.push(`${fileName}:${line + 1} ${sink}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const sink = guardedSink(node.expression);
      if (sink && node.arguments.some(referencesKey)) {
        report(node, `${sink}(…)`);
      }
      const callback = ipcMainCallback(node);
      if (callback) {
        for (const returned of returnedExpressions(callback)) {
          if (referencesKey(returned)) {
            report(returned, 'ipcMain reply');
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return leaks;
}

function scanDir(dir: string): string[] {
  const files = sourceFiles(dir);
  assert.ok(files.length > 0, `no sources found to scan under ${dir}`);
  return files.flatMap((file) => findKeyLeaks(path.relative(dir, file), readFileSync(file, 'utf8')));
}

const MAIN_DIR = fileURLToPath(new URL('.', import.meta.url));

describe('AD-4 key hop: main log, disk and renderer guard', () => {
  it('never passes the key to a log, the diagnostic log, disk or the renderer', () => {
    const leaks = scanDir(MAIN_DIR);
    assert.deepEqual(leaks, [], `Key material may reach a log, disk or the renderer: ${leaks.join(', ')}`);
  });

  it('catches each sink and each key-bearing name', () => {
    const mutated = [
      "console.error('decrypted', getDecryptedCloudApiKey());",
      "console['info'](request.cloudApiKey);",
      'await appendDiagnosticLogEntry({ at, kind: apiKey });',
      "fs.writeFileSync(file, JSON.stringify({ cloudApiKey }));",
      'await writeFile(file, apiKey);',
      'mainWindow.webContents.send(IpcChannels.x, { key: getDecryptedCloudApiKey() });',
      'event.reply(channel, cloudApiKey);',
      'ipcMain.handle(IpcChannels.y, () => getDecryptedCloudApiKey());',
      'ipcMain.handle(IpcChannels.z, () => { const helper = () => apiKey; return { ok: true }; });',
      "ipcMain.handle(IpcChannels.w, (): SetCloudApiKeyResult => { return { status: 'ok' } as SetCloudApiKeyResult; });",
      "console.error('Failed to store cloud API key.', message);",
      'graphService.postMessage(buildIndexRequest({ decrypt: getDecryptedCloudApiKey }));',
    ].join('\n');
    assert.deepEqual(findKeyLeaks('mutated.ts', mutated), [
      'mutated.ts:1 console.error(…)',
      'mutated.ts:2 console[…](…)',
      'mutated.ts:3 appendDiagnosticLogEntry(…)',
      'mutated.ts:4 fs.writeFileSync(…)',
      'mutated.ts:5 writeFile(…)',
      'mutated.ts:6 mainWindow.webContents.send(…)',
      'mutated.ts:7 event.reply(…)',
      'mutated.ts:8 ipcMain reply',
    ]);
  });

  it('scans subfolders, and skips tests and node_modules', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'key-boundary-main-'));
    try {
      mkdirSync(path.join(dir, 'ipc', 'handlers'), { recursive: true });
      mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(path.join(dir, 'index.ts'), "console.log('ok');\n");
      writeFileSync(path.join(dir, 'ipc', 'handlers', 'settings.mts'), '\nconsole.log(apiKey);\n');
      writeFileSync(path.join(dir, 'ipc', 'handlers', 'settings.test.ts'), 'console.log(apiKey);\n');
      writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.ts'), 'console.log(apiKey);\n');
      assert.deepEqual(scanDir(dir), [`${path.join('ipc', 'handlers', 'settings.mts')}:2 console.log(…)`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
