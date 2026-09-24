/**
 * Node module-customization hooks that let `node --test` run this repo's
 * TypeScript/TSX sources directly.
 *
 * Why this exists: the pure helpers worth unit-testing live in renderer
 * `.tsx` modules (spec P0-2a puts `groupNodesIntoHealthClusters` next to
 * `riskCountBucket` in `CodeMap.tsx`, so the banding has exactly one
 * definition). Node can neither parse JSX nor resolve the extensionless /
 * `.ts`-main specifiers the repo's `moduleResolution: "Bundler"` setup uses,
 * so `node --test` alone cannot load them.
 *
 * Deliberately the smallest thing that works, and no second convention: it
 * reuses `esbuild` — already in the tree as Vite's own transformer, i.e. the
 * same engine that compiles this code for the real app — rather than adding
 * a full test framework. It only strips types and rewrites JSX; it never
 * bundles, so what a test imports is the real module graph.
 */
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const TYPESCRIPT_FILE = /\.(ts|tsx|mts|cts)$/;
const RELATIVE_SPECIFIER = /^\.{1,2}\//;

/**
 * A renderer module may `import '@xyflow/react/dist/style.css'` for its
 * side effect. Node has no CSS loader; a stub is correct here because the
 * helpers under test are pure and never read a style.
 */
const CSS_STUB_URL = 'data:text/javascript,export default {};';

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return { url: CSS_STUB_URL, format: 'module', shortCircuit: true };
  }

  // `moduleResolution: "Bundler"` lets source omit the extension
  // (`../map/lod`); Node's ESM resolver requires it. Try the same candidate
  // list a bundler would, in the same order, so a directory with both
  // `index.ts` and a sibling `.ts` resolves identically in both.
  if (RELATIVE_SPECIFIER.test(specifier) && context.parentURL !== undefined) {
    const base = new URL(specifier, context.parentURL);
    for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      const candidate = new URL(base.href + suffix);
      if (isFile(candidate)) {
        return { url: candidate.href, format: 'module', shortCircuit: true };
      }
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!TYPESCRIPT_FILE.test(new URL(url).pathname)) {
    return nextLoad(url, context);
  }
  const path = fileURLToPath(url);
  const { code } = transformSync(await readFile(path, 'utf8'), {
    loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    sourcefile: path,
    sourcemap: 'inline',
  });
  return { format: 'module', source: code, shortCircuit: true };
}
