import path from 'node:path';
import { defineConfig } from 'vite';

// Bundles services/graph-service/index.ts. Built via the same 'main' target
// treatment as the Electron main process (Node/Electron builtins external,
// CJS output) — see forge.config.ts for why this subprocess entry rides the
// 'main' build target even though it isn't main-process code.
// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      '@driller/ipc-contracts': path.resolve(
        __dirname,
        '../../packages/ipc-contracts/src/index.ts',
      ),
    },
  },
  // node-llama-cpp is ESM-only with top-level await in its dependency graph,
  // so model-manager.ts loads it via a dynamic `import()` rather than a
  // static import (see model-manager.ts's doc comment — a static import
  // compiles to a plain `require()` here, which throws
  // `ERR_REQUIRE_ASYNC_MODULE` at runtime). Live-verified against this exact
  // build (this story's verification pass): by default Vite wraps every
  // dynamic import in a `__vitePreload` helper that references browser-only
  // globals (`window`, `Event`) for chunk-preloading — harmless when the
  // import succeeds, but a failed/rejected import would crash with
  // `ReferenceError: window is not defined` instead of surfacing the real
  // error, in a subprocess that has no `window` at all. `modulePreload:
  // false` alone does NOT suppress this wrapper (confirmed by inspecting the
  // built output) — Vite's build-import-analysis plugin only skips it when
  // `build.ssr` is truthy. Setting `build.ssr: true` pulls in Vite's SSR
  // dependency-externalization heuristic as a side effect, which would
  // otherwise turn @modelcontextprotocol/client and its whole transitive
  // tree (zod, jose, eventsource, …) into real `require()` calls instead of
  // staying inlined the way they are today — `ssr.noExternal: true` below
  // forces everything except this file's own explicit `external` list back
  // to being bundled, restoring today's output shape. Re-verified end to end
  // via a real `electron-forge package` build (this story's verification
  // pass): the packaged graph-service.js still inlines @modelcontextprotocol/
  // client's tree, node-llama-cpp/codebase-memory-mcp stay real `require()`s,
  // and the dynamic import compiles to a plain, unwrapped `import(...)`.
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: true,
    modulePreload: false,
    rollupOptions: {
      // mcp-client.ts resolves codebase-memory-mcp's own installed `bin`
      // entry at runtime via Node's module resolution (require.resolve) to
      // spawn it directly — that needs the real package on disk, not an
      // inlined copy of its (large, native-binary-downloading) code.
      //
      // node-llama-cpp (Story 1.5 Phase 1, AD-18) ships real platform-specific
      // `.node` native bindings loaded at runtime — bundling would either
      // fail outright or silently drop the native binary Vite/Rollup can't
      // parse as JS, so it's external here too, resolved from the real
      // installed package on disk (electron-forge's auto-unpack-natives
      // plugin, already configured per AD-3, is what gets its native files
      // out of the asar at package time).
      external: ['codebase-memory-mcp', 'node-llama-cpp'],
    },
  },
});
