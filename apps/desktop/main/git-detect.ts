/**
 * Git-repo detection (FR1).
 *
 * A folder is treated as a valid project if it — or an ancestor, or a
 * nearby descendant — contains a `.git` entry (a directory for a normal
 * repo, or a file for a worktree/submodule). This runs before the
 * open-folder flow confirms anything; a folder with no `.git` anywhere in
 * that neighborhood surfaces an explicit "not a git repository" result
 * instead.
 *
 * driller treats the user's filesystem as read-only (AD-17): this module
 * only ever calls fs.existsSync/readdirSync, never anything mutating.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GitDetectionResult } from '@driller/ipc-contracts';

/** How many levels below the opened folder to search for a nested repo. */
const CHILD_SEARCH_MAX_DEPTH = 3;

/** Directories never worth descending into when searching for a child repo. */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.vite',
]);

/**
 * Case-insensitive membership check against SKIP_DIR_NAMES — on
 * case-insensitive filesystems (macOS and Windows defaults) a directory
 * named e.g. `Node_Modules` or `.Git` is the same directory as far as the
 * OS is concerned, and must be skipped just the same.
 */
function isSkippedDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name.toLowerCase());
}

function hasDotGit(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function findGitRootUpward(startDir: string): string | undefined {
  let current = startDir;
  // path.dirname(root) === root at the filesystem root — that's our stop condition.
  for (;;) {
    if (hasDotGit(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function findGitRootDownward(
  startDir: string,
  depth: number,
): string | undefined {
  if (depth > CHILD_SEARCH_MAX_DEPTH) {
    return undefined;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(startDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isSkippedDir(entry.name)) {
      continue;
    }
    const childDir = path.join(startDir, entry.name);
    if (hasDotGit(childDir)) {
      return childDir;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || isSkippedDir(entry.name)) {
      continue;
    }
    const found = findGitRootDownward(path.join(startDir, entry.name), depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/**
 * Detects whether `folderPath` is a git repository — itself (root), an
 * ancestor (parent), or a nearby descendant (child) — per this story's
 * I/O matrix.
 */
export function detectGitRepo(folderPath: string): GitDetectionResult {
  if (hasDotGit(folderPath)) {
    return { isGitRepo: true, gitRootPath: folderPath, relation: 'root' };
  }

  const parentRoot = findGitRootUpward(path.dirname(folderPath));
  if (parentRoot) {
    return { isGitRepo: true, gitRootPath: parentRoot, relation: 'parent' };
  }

  const childRoot = findGitRootDownward(folderPath, 1);
  if (childRoot) {
    return { isGitRepo: true, gitRootPath: childRoot, relation: 'child' };
  }

  return { isGitRepo: false };
}
