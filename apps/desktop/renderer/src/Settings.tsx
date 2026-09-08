/**
 * Settings panel (Story 1.6, Phase 1) — driller's first Settings UI
 * surface: a backend choice (local vs. cloud) and, for cloud, a key-entry
 * field.
 *
 * Security-relevant UI invariants (Boundaries & Constraints, this story):
 *  - The renderer never receives the decrypted key back from main — only
 *    this component's own transient `keyInput` (what the user just typed,
 *    never re-populated from a saved value) and a masked "Key saved" state
 *    once `config.hasCloudKey` is true.
 *  - An empty/whitespace-only key is rejected here, client-side, before any
 *    IPC call is made (I/O & Edge-Case Matrix).
 *  - On Linux with no secure OS keystore, `setCloudApiKey` returns
 *    `status: 'warning'` and stores nothing; this component shows that
 *    warning and requires an explicit "Store anyway" click (which resubmits
 *    with `acknowledgeInsecureStorage: true`) before anything is persisted
 *    — never a silent insecure store.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { BackendConfig, CloudBackend } from '@driller/ipc-contracts';

interface SettingsProps {
  onClose: () => void;
}

type KeyEntryState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'warning'; message: string; pendingKey: string }
  | { kind: 'error'; message: string };

export function Settings({ onClose }: SettingsProps) {
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyEntry, setKeyEntry] = useState<KeyEntryState>({ kind: 'idle' });
  // Mirrors `config` so handleBackendChange's rollback (below) can read the
  // pre-optimistic-update value without depending on `config` itself and
  // recreating the callback (and re-subscribing the Escape-key listener)
  // on every config change.
  const configRef = useRef<BackendConfig | null>(null);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const refetchConfig = useCallback(() => {
    window.driller
      .getBackendConfig()
      .then((next) => {
        setConfig(next);
        setLoadError(null);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    refetchConfig();
  }, [refetchConfig]);

  // Escape closes the Settings overlay — same keyboard-dismissal pattern
  // already established for Story 1.3 Phase 1's source-view overlay
  // (CodeMap.tsx's closeSourceView effect); the × button already exists,
  // this just adds the keyboard path (review finding, Low).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleBackendChange = useCallback(
    (backend: CloudBackend) => {
      // Optimistic, since this is a same-machine, near-instant local write;
      // refetchConfig below confirms/corrects it on success.
      const previousConfig = configRef.current;
      setConfig((current) => (current ? { ...current, activeBackend: backend } : current));
      window.driller
        .setActiveBackend(backend)
        .then(refetchConfig)
        .catch((error) => {
          setLoadError(error instanceof Error ? error.message : String(error));
          // Roll back the optimistic update on failure (review finding,
          // Medium) — otherwise the UI keeps showing a selection that was
          // never actually persisted, silently diverging from real state.
          setConfig(previousConfig);
        });
    },
    [refetchConfig],
  );

  const attemptSaveKey = useCallback(
    (key: string, acknowledgeInsecureStorage: boolean) => {
      setKeyEntry({ kind: 'saving' });
      window.driller
        .setCloudApiKey(key, acknowledgeInsecureStorage)
        .then((result) => {
          if (result.status === 'ok') {
            // Never re-displays the key: the input is cleared, and the
            // masked "Key saved" state below derives entirely from
            // `config.hasCloudKey`, not from anything typed.
            setKeyInput('');
            setKeyEntry({ kind: 'idle' });
            refetchConfig();
            // Story 1.6 (Phase 2): if cloud is already the active backend
            // (the "cloud selected, no key" case this exact form exists
            // for), generation has been sitting blocked with no key to use.
            // Re-invoking `setActiveBackend` with the same already-active
            // value is a no-op for the persisted choice itself, but main's
            // handler unconditionally relays a fresh `graphService:
            // backendSwitched` (with the key now decryptable) whenever it's
            // called — the same mechanism a genuine local<->cloud switch
            // uses — so this is what actually resumes generation now that a
            // key exists, rather than leaving the user stuck until they
            // flip the radio away and back.
            if (configRef.current?.activeBackend === 'cloud') {
              window.driller.setActiveBackend('cloud').catch(() => {
                // Best-effort nudge — a failure here just means generation
                // stays blocked until the next real backend switch; nothing
                // about the key save itself (already confirmed above) is
                // affected.
              });
            }
            return;
          }
          if (result.status === 'warning') {
            setKeyEntry({
              kind: 'warning',
              message: result.message ?? 'This machine has no secure keystore available.',
              pendingKey: key,
            });
            // Review finding, Low: a key can reach real storage via this
            // 'warning' branch too — the insecure-keystore warning still
            // means the key ends up genuinely stored (either an already-
            // stored key from an earlier save, or, once the user clicks
            // "Store anyway" here, this same pending key on the resulting
            // 'ok' call above) — so the same resume-generation nudge applies
            // here, not just on a clean 'ok' result. Safe to fire
            // unconditionally alongside the warning state: with the same-
            // backend-value guard in services/graph-service/index.ts's
            // `handleBackendSwitchedRequest`, this never wipes existing
            // summaries — it only ever re-kicks still-pending Nodes.
            if (configRef.current?.activeBackend === 'cloud') {
              window.driller.setActiveBackend('cloud').catch(() => {
                // Best-effort nudge, same reasoning as the 'ok' branch above.
              });
            }
            return;
          }
          setKeyEntry({ kind: 'error', message: result.message ?? 'Failed to save the API key.' });
        })
        .catch((error) => {
          setKeyEntry({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [refetchConfig],
  );

  const handleSaveKey = useCallback(() => {
    const trimmed = keyInput.trim();
    // Empty/whitespace-only key: rejected client-side, no IPC call made
    // (I/O & Edge-Case Matrix).
    if (trimmed.length === 0) {
      setKeyEntry({ kind: 'error', message: 'Enter an API key before saving.' });
      return;
    }
    attemptSaveKey(trimmed, false);
  }, [keyInput, attemptSaveKey]);

  const handleAcknowledgeInsecureStorage = useCallback(() => {
    if (keyEntry.kind !== 'warning') {
      return;
    }
    attemptSaveKey(keyEntry.pendingKey, true);
  }, [keyEntry, attemptSaveKey]);

  const handleKeyInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setKeyInput(event.target.value);
    // A fresh edit invalidates any prior warning/error left over from the
    // last save attempt for the old key value.
    setKeyEntry((current) => (current.kind === 'saving' ? current : { kind: 'idle' }));
  }, []);

  return (
    <div className="settings-overlay">
      <div className="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="settings-panel__header">
          <h2 className="settings-panel__title">Settings</h2>
          <button type="button" className="settings-panel__close" onClick={onClose} aria-label="Close Settings">
            ×
          </button>
        </header>

        {loadError && (
          <div className="notice notice--error" role="alert">
            <p>{loadError}</p>
            {/* Without this, a failed initial `getBackendConfig()` fetch
                left `config` permanently `null` for the rest of this panel
                session — the whole backend-choice/key-entry body below
                never rendered again, only this raw error text (review
                finding, Medium). Reuses refetchConfig, the same call the
                initial mount effect makes. */}
            <button type="button" onClick={refetchConfig}>
              Retry
            </button>
          </div>
        )}

        {config && (
          <>
            <fieldset className="settings-panel__backend">
              <legend>Summary backend</legend>
              <label className="settings-panel__radio">
                <input
                  type="radio"
                  name="backend"
                  value="local"
                  checked={config.activeBackend === 'local'}
                  onChange={() => handleBackendChange('local')}
                />
                Local model
              </label>
              <label className="settings-panel__radio">
                <input
                  type="radio"
                  name="backend"
                  value="cloud"
                  checked={config.activeBackend === 'cloud'}
                  onChange={() => handleBackendChange('cloud')}
                />
                Cloud (bring your own key)
              </label>
            </fieldset>

            {config.activeBackend === 'cloud' && (
              <section className="settings-panel__cloud-key" aria-label="Cloud API key">
                {config.isLinuxInsecureBackend && (
                  <p className="notice notice--warning" role="status">
                    This machine has no secure OS keystore available. A stored key would have
                    weaker protection than usual.
                  </p>
                )}

                {config.hasCloudKey && keyEntry.kind !== 'warning' && keyInput.length === 0 && (
                  // Masked "Key saved" state — never re-displays the key
                  // itself, only that one is stored.
                  <p className="settings-panel__key-saved" role="status">
                    Key saved (••••••••)
                  </p>
                )}

                <label className="settings-panel__key-label">
                  API key
                  <input
                    type="password"
                    value={keyInput}
                    onChange={handleKeyInputChange}
                    placeholder={config.hasCloudKey ? 'Enter a new key to replace the saved one' : 'sk-…'}
                    autoComplete="off"
                  />
                </label>

                <button
                  type="button"
                  className="settings-panel__save"
                  onClick={handleSaveKey}
                  disabled={keyEntry.kind === 'saving'}
                >
                  {keyEntry.kind === 'saving' ? 'Saving…' : 'Save key'}
                </button>

                {keyEntry.kind === 'warning' && (
                  <div className="notice notice--warning" role="alert">
                    <p>{keyEntry.message}</p>
                    <button type="button" onClick={handleAcknowledgeInsecureStorage}>
                      Store anyway
                    </button>
                  </div>
                )}

                {keyEntry.kind === 'error' && (
                  <p className="notice notice--error" role="alert">
                    {keyEntry.message}
                  </p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
