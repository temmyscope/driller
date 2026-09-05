import type { DrillerApi } from '@driller/ipc-contracts';

// The contextBridge-exposed API (AD-11) — the renderer's only path to main.
declare global {
  interface Window {
    driller: DrillerApi;
  }
}

export {};
