import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// ---------------------------------------------------------------------------
// Story 1.5 (Phase 1): vendor npm-workspace-hoisted runtime dependencies into
// the packaged app.
//
// `@electron/packager` (which `electron-forge package`/`make` wrap) copies
// only `apps/desktop`'s own directory tree into the packaged app — and under
// npm workspace hoisting, `apps/desktop` has NO local `node_modules` at all
// (everything hoisted to the monorepo root). Live-verified this story's
// verification pass: a real `electron-forge package` build's `app.asar`
// (extracted via `npx asar extract` + `find`) contained no `node_modules`
// directory whatsoever — every dependency Vite left as a genuine `require()`/
// `import()` (`vite.graph-service.config.ts`'s `external` list — currently
// just `node-llama-cpp`; `codebase-memory-mcp` is a separate, pre-existing
// gap of the same shape, out of this story's scope) would have been silently
// absent from the shipped app, hard-failing the very first real download
// attempt with `MODULE_NOT_FOUND`. Everything else (react, electron-store,
// etc.) is unaffected because Vite inlines those into main.js/preload.js
// rather than leaving them as externals.
//
// This `afterCopy` hook copies `node-llama-cpp`'s full production dependency
// closure (`dependencies` + any *installed* `optionalDependencies` — only
// the current build machine's matching platform-native-binary package, e.g.
// `@node-llama-cpp/mac-arm64-metal`, is ever actually present; the other
// ~13 platform packages are legitimately absent and skipped) from the real
// npm-resolved location into the packaged app's own `node_modules`.
//
// Placement mirrors real Node resolution rather than always flattening to
// the top level: a dependency npm nested inside another package's own
// `node_modules` (a version-conflict override — e.g. `ipull`'s own pinned
// `tar-fs`) is left there, copied for free as part of that parent's own
// wholesale directory copy, and is deliberately NOT separately vendored to
// the top level — doing so would risk shadowing an unrelated package's
// different top-level-hoisted version of the same name with the wrong one.
// Only a dependency that resolves to the shared ROOT `node_modules` (true
// hoisting, the common case) gets its own top-level vendored copy and has
// its own dependencies queued in turn.
// ---------------------------------------------------------------------------

const EXTERNAL_RUNTIME_DEPENDENCIES = ['node-llama-cpp'];

/**
 * Finds the on-disk directory for `name`, searching the same `node_modules`
 * candidate directories real `require()` resolution would (via `require.
 * resolve.paths`, which merely enumerates search directories without
 * touching a package's own resolution rules) — deliberately NOT `require.
 * resolve(`${name}/package.json`)`: node-llama-cpp's `package.json` declares
 * an `exports` map with no `./package.json` subpath, so that subpath
 * resolution throws `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the package
 * itself is perfectly resolvable (live-verified this story's verification
 * pass — the first version of this hook hit exactly that error against a
 * real `electron-forge package` run). A plain `fs.existsSync` check against
 * each candidate directory sidesteps the exports map entirely, the same way
 * Node's own resolver would find the package directory before ever
 * consulting its exports map.
 */
function findPackageDir(name: string, requireFn: NodeJS.Require): string | undefined {
  const searchPaths = requireFn.resolve.paths(name) ?? [];
  for (const dir of searchPaths) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return undefined;
}

function vendorExternalDependencies(buildPath: string): void {
  const configRequire = createRequire(import.meta.url);
  const destNodeModules = path.join(buildPath, 'node_modules');

  // Cleared first (review finding): electron-forge's packaging step reuses
  // the same `out/` build path across repeated `package`/`make` runs rather
  // than always starting from an empty directory, and this hook is the only
  // thing that ever creates `<buildPath>/node_modules` in the first place —
  // without clearing it, a package removed from `EXTERNAL_RUNTIME_
  // DEPENDENCIES` (or one whose real dependency closure shrinks) could leave
  // a stale copy behind from a prior run, masking a real
  // dependency-resolution regression the next run should have surfaced.
  fs.rmSync(destNodeModules, { recursive: true, force: true });

  // Anchored off node-llama-cpp's own real resolved location rather than an
  // assumed relative path from this config file, so this doesn't silently
  // break if the monorepo's layout or invocation cwd ever changes.
  const anchorDir = findPackageDir('node-llama-cpp', configRequire);
  if (!anchorDir) {
    throw new Error(
      "vendorExternalDependencies: could not resolve node-llama-cpp's own install location.",
    );
  }
  // .../node_modules/node-llama-cpp -> .../node_modules
  const rootNodeModules = path.dirname(anchorDir);

  const visited = new Set<string>(); // by resolved package directory, so the same name resolving to two different (nested vs. hoisted) installs is never conflated
  const queue: Array<{ name: string; requireFn: NodeJS.Require }> = EXTERNAL_RUNTIME_DEPENDENCIES.map(
    (name) => ({ name, requireFn: configRequire }),
  );

  while (queue.length > 0) {
    const { name, requireFn } = queue.shift()!;
    const srcDir = findPackageDir(name, requireFn);
    if (!srcDir) {
      // Expected for an uninstalled optionalDependency of a different
      // platform (e.g. @node-llama-cpp/linux-x64 when packaging on macOS) —
      // only the current build machine's matching native-binary package is
      // ever actually installed, and that is correct.
      continue;
    }
    if (visited.has(srcDir)) {
      continue;
    }
    visited.add(srcDir);

    const pkgJsonPath = path.join(srcDir, 'package.json');
    // A scoped package (`@scope/name`) lives two directory levels under its
    // containing node_modules (`node_modules/@scope/name`), not one — using
    // a flat `path.dirname(srcDir)` here would land on the `@scope` folder
    // itself and always miscompare against `rootNodeModules`, wrongly
    // treating every scoped package (node-llama-cpp's own platform-native-
    // binary packages are ALL scoped under `@node-llama-cpp/*`) as "nested"
    // and skipping it outright.
    const nearestNodeModules = name.startsWith('@')
      ? path.dirname(path.dirname(srcDir))
      : path.dirname(srcDir);
    const isNested = nearestNodeModules !== rootNodeModules;
    if (!isNested) {
      // Only a root-hoisted resolution needs its own top-level vendored
      // copy — a nested one (a version override inside some other package's
      // own node_modules) was already copied for free as part of that
      // parent's own wholesale directory copy.
      //
      // Live-verified bug (this story's verification pass, via a real
      // integration run against the actual packaged bundle): a nested
      // package's OWN dependencies must still be walked even when the
      // package itself isn't separately copied — `node-llama-cpp/node_
      // modules/log-symbols` (a nested override) itself depends on
      // `yoctocolors`, which npm hoisted to the shared ROOT node_modules
      // (no conflict for that one) rather than nesting it under
      // `log-symbols` too. The first version of this hook skipped walking a
      // nested package's dependencies entirely on the assumption its
      // parent's wholesale copy already carried everything it needed — true
      // for `log-symbols` itself, false for `yoctocolors`, which was never
      // vendored anywhere and left the packaged app crashing at runtime
      // with `Cannot find package 'yoctocolors'`. Every visited package's
      // dependencies are now always walked, root-hoisted or not; only the
      // wholesale directory *copy* is skipped for a nested one.
      const destDir = path.join(destNodeModules, name);
      fs.mkdirSync(path.dirname(destDir), { recursive: true });
      fs.cpSync(srcDir, destDir, { recursive: true, dereference: true });
    }

    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const requireFromHere = createRequire(pkgJsonPath);
    for (const dep of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]) {
      queue.push({ name: dep, requireFn: requireFromHere });
    }
  }
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    afterCopy: [
      (buildPath, _electronVersion, _platform, _arch, callback) => {
        try {
          vendorExternalDependencies(buildPath);
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    // AD-3: packaging uses Electron Forge with auto-unpack-natives so any
    // native module (tree-sitter bindings, node-llama-cpp — added in Story
    // 1.5 Phase 1) is unpacked from the asar correctly.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: { main: 'main/index.ts' },
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: { preload: 'preload/index.ts' },
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // The Graph Service subprocess (AD-1). It is not "main process"
          // code, but the plugin only distinguishes 'main' | 'preload'
          // build targets, and 'main' gets the right treatment here: a
          // plain Node/Electron-builtins-external CJS bundle, output
          // alongside main.js so `utilityProcess.fork` can find it at
          // `path.join(__dirname, 'graph-service.js')`.
          entry: { 'graph-service': '../../services/graph-service/index.ts' },
          config: 'vite.graph-service.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
