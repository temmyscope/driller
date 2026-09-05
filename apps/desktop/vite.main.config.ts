import path from 'node:path';
import { defineConfig } from 'vite';

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
