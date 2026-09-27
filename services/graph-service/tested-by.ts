/**
 * P4-2 phase 2: "Tested by" for production Nodes.
 *
 * Phase 1 took test code off the map. The backend still knows which tests
 * reach which code, patchily, so this attaches that evidence to each
 * production Node as `CodeMapNode.testedBy`. Only two sources count:
 *
 *  1. a test→production `CALLS` edge the backend resolved through an import
 *     (`IMPORT_RESOLVED_CALL_STRATEGIES`) with a reported confidence of at
 *     least `MIN_TEST_EVIDENCE_CONFIDENCE` — never a name-only match;
 *  2. a `TESTS_FILE` File→File edge into the Node's own file.
 *
 * No evidence leaves `testedBy` absent. That means "no link found", never
 * "untested". On driller/app (2026-09-27 investigation), `TESTS_FILE`
 * covered about 41% of test files and direct calls reached about 29% of
 * production functions.
 */
import { TESTED_BY_MAX_TESTS, type TestedBy, type TestedByFile, type TestedByTest } from '@driller/graph-contracts';

import type { TestCallEvidence, TestEvidence } from './mcp-client';
import { IMPORT_RESOLVED_CALL_STRATEGIES, MIN_TEST_EVIDENCE_CONFIDENCE } from './test-evidence-strategies';
import { isTestNode, isTestSupportPath } from './test-code';

interface EvidenceNode {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  kind: string;
  isTest?: boolean;
}

/**
 * Whether a `CALLS` edge is import-resolved evidence: an allowed strategy
 * and a reported confidence at or above the floor. A missing confidence is
 * not evidence.
 */
export function isImportResolvedCall(call: Pick<TestCallEvidence, 'strategy' | 'confidence'>): boolean {
  return (
    IMPORT_RESOLVED_CALL_STRATEGIES.includes(call.strategy) &&
    call.confidence !== undefined &&
    call.confidence >= MIN_TEST_EVIDENCE_CONFIDENCE
  );
}

/**
 * The one classification for both evidence sources' test side — a `CALLS`
 * caller and a `TESTS_FILE` source: test code by `isTestNode` (the backend
 * flag, or the path), but not test support such as `testRender`.
 */
export function isTestEvidenceSource(source: { file: string; isTest?: boolean }): boolean {
  return isTestNode(source) && !isTestSupportPath(source.file);
}

function baseName(file: string): string {
  const parts = file.split('/');
  return parts[parts.length - 1] ?? file;
}

interface Candidate {
  entry: TestedByTest;
  /** The entry opens at a line the backend reported for this call (not a fallback). */
  hasCallLine: boolean;
}

/**
 * The entry a test caller contributes. A test function or method opens at
 * its own range. A Module caller is a test file's top level (a call inside
 * `test(...)`), whose range is the whole file, so it opens at the call's own
 * line — falling back to the Module's first line only when the backend
 * reported none.
 */
function toCandidate(call: TestCallEvidence): Candidate {
  if (call.sourceKind === 'Module') {
    const line = call.line ?? call.sourceStartLine;
    return {
      entry: {
        id: call.source,
        name: baseName(call.sourceFile),
        file: call.sourceFile,
        startLine: line,
        endLine: line,
        topLevel: true,
      },
      hasCallLine: call.line !== undefined,
    };
  }
  return {
    entry: {
      id: call.source,
      name: call.sourceName,
      file: call.sourceFile,
      startLine: call.sourceStartLine,
      endLine: call.sourceEndLine,
    },
    hasCallLine: true,
  };
}

/** Keep the candidate with a real call line; between equals, the earlier line. */
function preferred(existing: Candidate, next: Candidate): Candidate {
  if (existing.hasCallLine !== next.hasCallLine) {
    return existing.hasCallLine ? existing : next;
  }
  return next.entry.startLine < existing.entry.startLine ? next : existing;
}

function compareTests(a: TestedByTest, b: TestedByTest): number {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  if (a.startLine !== b.startLine) {
    return a.startLine - b.startLine;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Attaches `testedBy` to every production Node in `nodes` that has evidence.
 * Pure. `nodes` must be the full fetched set, test Nodes included, with
 * project-relative `file`s; `evidence` must use the same path form. Test
 * Nodes are returned unchanged (the caller removes them afterwards).
 * Returns the input array itself when no Node gains evidence.
 *
 * A call is never credited when its caller's or its target's id is shared
 * by a test Node and a production Node: the edge can't say which one it
 * meant.
 */
export function attachTestedBy<TNode extends EvidenceNode>(nodes: TNode[], evidence: TestEvidence): TNode[] {
  const productionIds = new Set<string>();
  const testIds = new Set<string>();
  // Test file -> its Module Node's range (File nodes carry no usable range).
  const testFileRanges = new Map<string, { startLine: number; endLine: number }>();
  for (const node of nodes) {
    if (isTestNode(node)) {
      testIds.add(node.id);
      if (node.kind === 'Module' && !testFileRanges.has(node.file)) {
        testFileRanges.set(node.file, { startLine: node.startLine, endLine: node.endLine });
      }
    } else {
      productionIds.add(node.id);
    }
  }

  // target id -> caller id -> best candidate (a caller counts once)
  const testsByTarget = new Map<string, Map<string, Candidate>>();
  for (const call of evidence.calls) {
    if (
      !isImportResolvedCall(call) ||
      !isTestEvidenceSource({ file: call.sourceFile, ...(call.sourceIsTest === true ? { isTest: true } : {}) }) ||
      productionIds.has(call.source) ||
      !productionIds.has(call.target) ||
      testIds.has(call.target)
    ) {
      continue;
    }
    let callers = testsByTarget.get(call.target);
    if (callers === undefined) {
      callers = new Map();
      testsByTarget.set(call.target, callers);
    }
    const candidate = toCandidate(call);
    const existing = callers.get(call.source);
    callers.set(call.source, existing === undefined ? candidate : preferred(existing, candidate));
  }

  // production file -> test files linked to it by TESTS_FILE
  const testFilesByFile = new Map<string, Set<string>>();
  for (const { testFile, file } of evidence.testFiles) {
    if (!isTestEvidenceSource({ file: testFile }) || isTestNode({ file })) {
      continue;
    }
    let testFiles = testFilesByFile.get(file);
    if (testFiles === undefined) {
      testFiles = new Set();
      testFilesByFile.set(file, testFiles);
    }
    testFiles.add(testFile);
  }

  if (testsByTarget.size === 0 && testFilesByFile.size === 0) {
    return nodes;
  }
  return nodes.map((node) => {
    if (isTestNode(node)) {
      return node;
    }
    const tests = [...(testsByTarget.get(node.id)?.values() ?? [])].map((candidate) => candidate.entry).sort(compareTests);
    const files: TestedByFile[] = [...(testFilesByFile.get(node.file) ?? [])].sort().map((file) => {
      const range = testFileRanges.get(file);
      return range === undefined ? { file } : { file, ...range };
    });
    if (tests.length === 0 && files.length === 0) {
      return node;
    }
    const testedBy: TestedBy = { tests: tests.slice(0, TESTED_BY_MAX_TESTS), totalTests: tests.length, files };
    return { ...node, testedBy };
  });
}
