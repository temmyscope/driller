/**
 * P2-10: the two main → Graph Service requests that make up AD-4's one
 * sanctioned key hop, built here as pure, injectable functions so the "no
 * key under Local" and "no blank or undecryptable key" rules are testable
 * without Electron.
 *
 * AD-4 (amended 2026-09-25): plaintext key material may cross main → Graph
 * Service only in `graphService:index` and `graphService:backendSwitched`,
 * only while Cloud is the active backend. `cloudKeyField` is the single
 * place that decides whether the field is present; `index.ts` and the
 * key-change relay (key-change-relay.ts) both build the field through it.
 */

import type {
  CloudBackend,
  GraphServiceBackendSwitchedRequest,
  GraphServiceIndexRequest,
} from '@driller/ipc-contracts';

/** Returns the stored key, or `undefined` when none is stored. May throw. */
export type DecryptCloudKey = () => string | undefined;

/**
 * The `cloudApiKey` part of a main → Graph Service request. Present only
 * while Cloud is active and a non-blank key is stored; otherwise empty, so
 * the request carries no key field at all (not even `cloudApiKey:
 * undefined`).
 *
 * `decrypt` is called only when Cloud is active, so main never decrypts a
 * key it won't send. A throwing decrypt counts as no key: the field is
 * omitted and a fixed sentence is logged — never the error's own text,
 * which could echo key material.
 */
export function cloudKeyField(
  activeBackend: CloudBackend,
  decrypt: DecryptCloudKey,
): { cloudApiKey?: string } {
  if (activeBackend !== 'cloud') {
    return {};
  }
  let key: string | undefined;
  try {
    key = decrypt();
  } catch {
    console.error('Could not read the stored cloud API key; sending the request without one.');
    return {};
  }
  return key !== undefined && key.trim() !== '' ? { cloudApiKey: key } : {};
}

export interface IndexRequestDeps {
  /** Absolute, OS-native path to the project root. */
  projectPath: string;
  activeBackend: CloudBackend;
  includedPaths: readonly string[];
  decrypt: DecryptCloudKey;
}

/** The `graphService:index` request; `includedPaths` is omitted when empty. */
export function buildIndexRequest(deps: IndexRequestDeps): GraphServiceIndexRequest {
  return {
    type: 'graphService:index',
    path: deps.projectPath,
    activeBackend: deps.activeBackend,
    ...cloudKeyField(deps.activeBackend, deps.decrypt),
    ...(deps.includedPaths.length > 0 ? { includedPaths: [...deps.includedPaths] } : {}),
  };
}

export interface BackendSwitchedRequestDeps {
  activeBackend: CloudBackend;
  decrypt: DecryptCloudKey;
}

/**
 * The `graphService:backendSwitched` request, for both a real backend switch
 * and the key-change relay. With no key field the Graph Service drops any key
 * it held (AD-4 condition 5).
 */
export function buildBackendSwitchedRequest(
  deps: BackendSwitchedRequestDeps,
): GraphServiceBackendSwitchedRequest {
  return {
    type: 'graphService:backendSwitched',
    activeBackend: deps.activeBackend,
    ...cloudKeyField(deps.activeBackend, deps.decrypt),
  };
}
