/**
 * P2-10: AD-4's one sanctioned key hop, pinned at the contract.
 *
 * Plaintext cloud key material may cross exactly one process boundary:
 * main → Graph Service, in `GraphServiceIndexRequest` and
 * `GraphServiceBackendSwitchedRequest`. Every other contract type is either
 * renderer-facing, a Graph Service reply to main, or otherwise off the hop,
 * so a key-bearing field on any of them is a boundary breach. This scans
 * every non-test source file in `src/` and fails naming the offending type.
 *
 * It flags:
 *  - a data field whose name matches `KEY_FIELD_PATTERN` (API key, cloud key,
 *    secret, credential, bearer, token), unless listed in `ALLOWED_FIELDS`;
 *  - an interface that `extends` a sanctioned type, and a type that `Pick`s
 *    or `Omit`s one — each would carry (or could carry) the key field into a
 *    type the guard does not otherwise treat as the hop.
 *
 * Function-typed members (`setCloudApiKey: (key) => …` on the preload API,
 * including an optional `(() => void) | undefined`) are operations, not
 * fields that carry a key in a payload, so they are not counted. The
 * renderer handing a typed key to main for encryption is AD-4's key-entry
 * path, documented separately from this hop.
 *
 * The check is syntactic: it sees field names and type references, not a key
 * smuggled under an innocuous name.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/** The only two contract types allowed to carry plaintext key material (AD-4). */
const SANCTIONED_KEY_HOP_TYPES = new Set([
  'GraphServiceIndexRequest',
  'GraphServiceBackendSwitchedRequest',
]);

const KEY_FIELD_PATTERN = /(api.?key|cloud.?key|secret|credential|bearer|token)/i;

/**
 * Fields whose names match the pattern but carry no key material, as
 * `Type.field`, each with its reason.
 */
const ALLOWED_FIELDS = new Map<string, string>([
  ['BackendConfig.hasCloudKey', 'a boolean: whether a key is stored, never the key itself'],
]);

function isKeyFieldName(name: string): boolean {
  return name === 'cloudApiKey' || KEY_FIELD_PATTERN.test(name);
}

function unwrapType(type: ts.TypeNode): ts.TypeNode {
  let current = type;
  while (ts.isParenthesizedTypeNode(current)) {
    current = current.type;
  }
  return current;
}

function isFunctionType(type: ts.TypeNode): boolean {
  const unwrapped = unwrapType(type);
  if (ts.isFunctionTypeNode(unwrapped) || ts.isConstructorTypeNode(unwrapped)) {
    return true;
  }
  if (ts.isUnionTypeNode(unwrapped)) {
    // `(() => void) | undefined`, `(() => void) | null`: still an operation.
    const rest = unwrapped.types.filter(
      (member) =>
        !(
          member.kind === ts.SyntaxKind.UndefinedKeyword ||
          (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
        ),
    );
    return rest.length > 0 && rest.every(isFunctionType);
  }
  return false;
}

function isFunctionTyped(member: ts.TypeElement): boolean {
  if (ts.isMethodSignature(member)) {
    return true;
  }
  return ts.isPropertySignature(member) && member.type !== undefined && isFunctionType(member.type);
}

function memberName(member: ts.TypeElement, source: ts.SourceFile): string | undefined {
  const { name } = member;
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return name.getText(source);
}

interface Finding {
  typeName: string;
  /** The field, or how the type derives from a sanctioned one (`extends X`, `Pick<X>`). */
  what: string;
}

/**
 * Every place a type or interface declared in `sourceText` carries a
 * key-bearing data field (including fields nested in inline object literals
 * and union members of a type alias), or derives from a sanctioned type.
 */
function findKeyBearing(sourceText: string): Finding[] {
  const source = ts.createSourceFile('contract.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const found: Finding[] = [];

  const scan = (typeName: string, node: ts.Node): void => {
    if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) {
      const name = memberName(node, source);
      if (name !== undefined && isKeyFieldName(name) && !isFunctionTyped(node)) {
        found.push({ typeName, what: name });
      }
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const ref = node.typeName.text;
      const first = node.typeArguments?.[0];
      if (
        (ref === 'Pick' || ref === 'Omit') &&
        first &&
        ts.isTypeReferenceNode(first) &&
        ts.isIdentifier(first.typeName) &&
        SANCTIONED_KEY_HOP_TYPES.has(first.typeName.text)
      ) {
        found.push({ typeName, what: `${ref}<${first.typeName.text}>` });
      }
    }
    if (ts.isHeritageClause(node)) {
      for (const heritage of node.types) {
        const base = heritage.expression;
        if (ts.isIdentifier(base) && SANCTIONED_KEY_HOP_TYPES.has(base.text)) {
          found.push({ typeName, what: `extends ${base.text}` });
        }
      }
    }
    ts.forEachChild(node, (child) => scan(typeName, child));
  };

  const visitTopLevel = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) {
      scan(node.name?.text ?? '<anonymous>', node);
      return;
    }
    ts.forEachChild(node, visitTopLevel);
  };
  visitTopLevel(source);
  return found;
}

function offendersIn(sourceText: string): string[] {
  return findKeyBearing(sourceText)
    .filter(({ typeName }) => !SANCTIONED_KEY_HOP_TYPES.has(typeName))
    .map(({ typeName, what }) => (what.includes('<') || what.startsWith('extends ') ? `${typeName} (${what})` : `${typeName}.${what}`))
    .filter((offender) => !ALLOWED_FIELDS.has(offender));
}

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Every non-test source file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return entry.isFile() && /\.(ts|mts|tsx)$/.test(entry.name) && !/\.test\.(ts|mts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')
      ? [full]
      : [];
  });
}

function allSources(): string {
  const files = sourceFiles(SRC_DIR);
  assert.ok(files.some((file) => path.basename(file) === 'index.ts'), 'index.ts not found under src/');
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

describe('AD-4 key hop: contract guard', () => {
  it('allows key-bearing fields only on the two main → Graph Service request types', () => {
    const offenders = offendersIn(allSources());
    assert.deepEqual(
      offenders,
      [],
      `Key-bearing field(s) outside AD-4's sanctioned hop: ${offenders.join(', ')}. ` +
        'Plaintext key material may only travel main → Graph Service in ' +
        `${[...SANCTIONED_KEY_HOP_TYPES].join(' / ')}.`,
    );
  });

  it('still sees the sanctioned fields, so the scan itself has not gone blind', () => {
    const sanctioned = findKeyBearing(allSources())
      .filter(({ typeName }) => SANCTIONED_KEY_HOP_TYPES.has(typeName))
      .map(({ typeName }) => typeName)
      .sort();
    assert.deepEqual(sanctioned, [...SANCTIONED_KEY_HOP_TYPES].sort());
  });

  it('names the offending type when a renderer-facing type gains a key field', () => {
    const mutated = `
      export interface BackendConfig { activeBackend: 'local' | 'cloud'; hasCloudKey: boolean; cloudApiKey?: string; }
      export type SetCloudApiKeyResult =
        | { status: 'ok' }
        | { status: 'error'; message: string; api_key: string };
      export interface ProviderAuth { clientSecret: string; bearerToken: string; credentials: string[]; cloud_key: string }
      export interface GraphServiceIndexRequest { cloudApiKey?: string; }
    `;
    assert.deepEqual(offendersIn(mutated), [
      'BackendConfig.cloudApiKey',
      'SetCloudApiKeyResult.api_key',
      'ProviderAuth.clientSecret',
      'ProviderAuth.bearerToken',
      'ProviderAuth.credentials',
      'ProviderAuth.cloud_key',
    ]);
  });

  it('flags a type that extends, Picks or Omits a sanctioned type', () => {
    const mutated = `
      export interface IndexEcho extends GraphServiceIndexRequest { echoed: true }
      export type SwitchView = Pick<GraphServiceBackendSwitchedRequest, 'activeBackend' | 'cloudApiKey'>;
      export type IndexSummary = Omit<GraphServiceIndexRequest, 'path'>;
    `;
    assert.deepEqual(offendersIn(mutated), [
      'IndexEcho (extends GraphServiceIndexRequest)',
      'SwitchView (Pick<GraphServiceBackendSwitchedRequest>)',
      'IndexSummary (Omit<GraphServiceIndexRequest>)',
    ]);
  });

  it('does not count function-typed members as key-bearing fields, optional ones included', () => {
    const api = `
      export interface DrillerApi {
        setCloudApiKey: (key: string) => Promise<void>;
        clearCloudApiKey(): Promise<void>;
        onApiKeyChanged?: ((listener: () => void) => void) | undefined;
        refreshToken: (() => void) | null;
      }
    `;
    assert.deepEqual(offendersIn(api), []);
  });

  it('still counts a union that is not purely functions', () => {
    const api = 'export interface Leaky { apiKey: string | (() => string); }';
    assert.deepEqual(offendersIn(api), ['Leaky.apiKey']);
  });
});
