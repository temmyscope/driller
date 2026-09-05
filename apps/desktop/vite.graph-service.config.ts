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
});
