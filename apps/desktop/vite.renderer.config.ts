import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  // Renderer source (and its index.html entry) lives at apps/desktop/renderer,
  // per ARCHITECTURE-SPINE.md's Structural Seed — not at the Forge project
  // root, which is apps/desktop itself.
  root: path.resolve(__dirname, 'renderer'),
  build: {
    outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@driller/ipc-contracts': path.resolve(
        __dirname,
        '../../packages/ipc-contracts/src/index.ts',
      ),
      // Aliased to source for the same reason `ipc-contracts` is, and
      // because `ipc-contracts` RE-EXPORTS from it: without this, Vite
      // resolves it from node_modules and pre-bundles it into
      // `.vite/deps`, where the copy goes stale the moment a value is added
      // to the contract. A re-exported new constant then throws "does not
      // provide an export named …" at module load and the renderer never
      // paints — unit tests cannot see it, since they import the source
      // directly through the TypeScript loader.
      '@driller/graph-contracts': path.resolve(
        __dirname,
        '../../packages/graph-contracts/src/index.ts',
      ),
    },
  },
});
