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
    },
  },
});
