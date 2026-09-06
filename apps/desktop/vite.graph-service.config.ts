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
  build: {
    rollupOptions: {
      // mcp-client.ts resolves codebase-memory-mcp's own installed `bin`
      // entry at runtime via Node's module resolution (require.resolve) to
      // spawn it directly — that needs the real package on disk, not an
      // inlined copy of its (large, native-binary-downloading) code.
      external: ['codebase-memory-mcp'],
    },
  },
});
