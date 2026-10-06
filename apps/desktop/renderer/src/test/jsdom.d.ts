/**
 * P4-8c: the slice of jsdom's API `domEnv.ts` uses. jsdom ships no types,
 * and P4-8c adds exactly four dev dependencies (`@types/jsdom` is not one of
 * them), so the one constructor and the members used are declared here.
 * Test-only: `tsconfig.test.json` includes `src/test/**`, the app's own
 * `tsconfig.json` excludes it.
 */
declare module 'jsdom' {
  export interface ConstructorOptions {
    url?: string;
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
