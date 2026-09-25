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
 *  - P2-6: "Remove saved key" beside that masked state deletes the stored
 *    key in one click (no confirmation — re-entering the key undoes it).
 *    While a removal is in flight, the key input, Save and "Store anyway"
 *    are disabled so a save can't race it.
 *  - An empty/whitespace-only key is rejected here, client-side, before any
 *    IPC call is made (I/O & Edge-Case Matrix).
 *  - On Linux with no secure OS keystore, `setCloudApiKey` returns
 *    `status: 'warning'` and stores nothing; this component shows that
 *    warning and requires an explicit "Store anyway" click (which resubmits
 *    with `acknowledgeInsecureStorage: true`) before anything is persisted
 *    — never a silent insecure store.
 *
 * Story 1.10 (Phase 1) adds a second, independent radio group: the external
 * editor preference (AD-23: required, always-populated — `system-default`
 * shows selected on first launch, never a blank/unset state). It loads and
 * saves independently of the backend-config group above (its own IPC round
 * trip, its own optimistic-update-plus-rollback-on-failure state) — the two
 * groups share only the overall panel shell and the same interaction
 * pattern, not any state.
 *
 * Story 2.3 (Phase 1) adds a third, independent group: per-project PR-bot
 * opt-in (`projectPath` prop, driller's first per-project Settings field —
 * disabled/hidden entirely when `projectPath === null`, unlike every field
 * above). Its own interaction shape is new, not a copy of the two above:
 * toggling a bot's checkbox ON never persists `enabled: true` by itself — it
 * only reveals that bot's own privacy disclosure notice — and only a second,
 * explicit confirm action ("Enable CodeRabbit"/"Enable Qodo") actually
 * persists it, mirroring the cloud-key group's own insecure-storage
 * warning-then-acknowledge pattern (`keyEntry`'s `'warning'` state /
 * `handleAcknowledgeInsecureStorage` above) rather than the plain
 * optimistic-update shape the backend/editor-preference groups use.
 * Toggling a bot OFF is always immediate, no disclosure/confirmation.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import type {
  BackendConfig,
  ClearCloudApiKeyResult,
  CloudBackend,
  EditorPreference,
  PrBotConfig,
  PrBotId,
  PrBotIngestionResult,
  ProjectScopeConfig,
  ProjectScopeSaveResult,
} from '@driller/ipc-contracts';
import { ActionableNotice } from './ActionableNotice';

interface SettingsProps {
  onClose: () => void;
  /**
   * P0-4: called once per successful `setActiveBackend` that changed the
   * backend from the value this panel last held — i.e. each time main
   * actually relays a switch that makes the Graph Service clear summaries.
   * Reported per switch (not as a net before/after diff at close) so a
   * local→cloud→local round trip inside one Settings session still counts:
   * the Graph Service cleared summaries twice even though the net value is
   * unchanged. Fired after the IPC reply, which main sends only after
   * posting `backendSwitched`, so a map refetch triggered from here is
   * ordered after the clear.
   */
  onBackendSwitched: () => void;
  /**
   * P2-1: called once per successful `setProjectScope` that main reports as
   * `applied` — handed to the running Graph Service for the open project, so
   * App.tsx refetches the loaded map to show the new scope. Fired after the
   * IPC reply, which main sends only after posting `scopeChanged`, so the
   * refetch is ordered after the scope change.
   */
  onProjectScopeApplied: () => void;
  /**
   * Absolute, OS-native path of the currently open project, or `null` when
   * none is open (Story 2.3, Phase 1) — PR-bot opt-in is per-project, so
   * this is the one piece of state this component needs from its caller
   * that every other Settings field so far has never needed.
   */
  projectPath: string | null;
  /**
   * Story 2.3 (Phase 4): notified with every settled `runPrBotIngestion`
   * result (not just success) — App.tsx's own `prBotToolNotFound` Set state
   * is derived from this stream, so it needs the non-failures too, not
   * merely `'tool-not-found'`: a later attempt returning `'ok'`/
   * `'no-base-ref-resolvable'`/`'error'` is what clears a bot's notice.
   *
   * P0-6 (2026-09-24) broke the old "every other status clears it" phrasing
   * this doc used to carry: `'review-md-present'` refuses before the bot is
   * invoked at all, so it is evidence of nothing about that bot's CLI and
   * App.tsx deliberately leaves the notice untouched for it. This prop
   * therefore forwards every status, but the receiver decides — it is not a
   * "anything but tool-not-found clears" contract any more.
   *
   * Fired on the real IPC result
   * unconditionally, even for a reply this component's own
   * `ingestionRequestIdRef` supersession would otherwise treat as stale for
   * *local* display purposes (see `handleRunIngestion` below) — whether a
   * given bot's CLI is actually on this machine's PATH is a genuine,
   * still-current fact regardless of which click produced this particular
   * reply, so App.tsx's notice state should still learn it. Optional since
   * not every caller (there is currently only one, App.tsx) necessarily
   * needs this notification.
   *
   * `requestedAt` (review finding, Edge Case Hunter, major): the wall-clock
   * `Date.now()` this specific request was initiated at — `Settings`'
   * own `ingestionRequestIdRef` resets on every remount (e.g. across a
   * project switch), so it can't tell a caller which of two overlapping
   * requests for the same bot, from two different Settings sessions, was
   * actually initiated more recently. `requestedAt` can, since it never
   * resets — a caller that receives replies out of order should apply only
   * the one with the larger `requestedAt`.
   */
  onIngestionResult?: (bot: PrBotId, result: PrBotIngestionResult, requestedAt: number) => void;
}

type KeyEntryState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'warning'; message: string; pendingKey: string }
  | { kind: 'error'; message: string };

/**
 * Per-bot disclosure-then-confirm state (Story 2.3, Phase 1) — one entry per
 * `PrBotId`, independent of the other bot's:
 *  - `'idle'`: matches persisted state, nothing pending.
 *  - `'confirming'`: the checkbox was just checked; the disclosure notice is
 *    showing; nothing persisted yet.
 *  - `'saving'`: the confirm action (or an immediate off-toggle) is in
 *    flight.
 *  - `'error'`: the last save attempt for this bot failed.
 */
type PrBotDisclosureState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

const IDLE_PR_BOT_DISCLOSURE: Record<PrBotId, PrBotDisclosureState> = {
  codeRabbit: { kind: 'idle' },
  qodo: { kind: 'idle' },
};

/**
 * "Run ingestion now" button's own per-bot state (Story 2.3, Phase 4) —
 * independent of `PrBotDisclosureState` above (that one gates
 * enable/disable persistence; this one is the whole-project ingestion pass
 * itself, only ever reachable once a bot is already `enabled`):
 *  - `'idle'`: nothing run yet this session, or the last run's result has
 *    already been superseded by a fresh click.
 *  - `'running'`: the pass is in flight.
 *  - `'ok'`: completed; `count` is `PrBotIngestionResult`'s own
 *    `findingCount` (0 is a valid, distinct "ran, found nothing" outcome).
 *  - `'tool-not-found'` / `'no-base-ref-resolvable'` /
 *    `'review-md-present'` / `'error'`: mirror `PrBotIngestionResult`'s own
 *    remaining states verbatim. `'review-md-present'` (P0-6, 2026-09-24)
 *    carries the absolute path of the file the pass refused to touch, so
 *    the inline status can name it rather than leaving the user to guess
 *    which `review.md` is meant.
 */
type IngestionRunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; count: number }
  | { kind: 'tool-not-found' }
  | { kind: 'no-base-ref-resolvable' }
  | { kind: 'review-md-present'; reviewMdPath: string }
  | { kind: 'error'; message: string };

const IDLE_INGESTION_RUN: Record<PrBotId, IngestionRunState> = {
  codeRabbit: { kind: 'idle' },
  qodo: { kind: 'idle' },
};

/** Inline-status copy for `IngestionRunState` — `'idle'` renders nothing (handled by the caller). */
function formatIngestionRunState(state: IngestionRunState): string | null {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'running':
      return 'Running…';
    case 'ok':
      return state.count === 0 ? 'Ran — no findings.' : `Ran — ${state.count} finding${state.count === 1 ? '' : 's'} ingested.`;
    case 'tool-not-found':
      return 'Tool not found on this machine — see the notice below.';
    case 'no-base-ref-resolvable':
      return "Couldn't resolve a base branch to diff against.";
    case 'review-md-present':
      // P0-6: names the exact file and states only what's verifiable — the
      // file exists, it wasn't touched, the pass didn't run. Deliberately
      // makes no claim about whose file it is: driller genuinely cannot
      // tell, and a leftover from a pass that was killed between PR-Agent's
      // write and the cleanup delete is in fact driller's own. Asserting
      // "a file driller didn't create" would be false exactly in that case,
      // to a user who already has no in-app way forward.
      return `Didn't run: ${state.reviewMdPath} already exists. That's the exact path PR-Agent writes its output to, and driller won't overwrite or delete what's there — nothing ran and nothing changed. Move or remove that file, then run again.`;
    case 'error':
      return state.message;
  }
}

const PR_BOTS: ReadonlyArray<{ id: PrBotId; label: string }> = [
  { id: 'codeRabbit', label: 'CodeRabbit' },
  { id: 'qodo', label: 'Qodo' },
];

/** This bot's own opt-in field on `PrBotConfig` (Design Notes: flat named fields, not a `Record<PrBotId, boolean>`). */
function isPrBotEnabled(bot: PrBotId, config: PrBotConfig): boolean {
  return bot === 'codeRabbit' ? config.codeRabbitEnabled : config.qodoEnabled;
}

/**
 * Per-bot privacy disclosure text (AC: "explicitly discloses, specific to
 * [the bot], that its local CLI mode transmits diff/code content to [that
 * bot]'s own cloud service — outside driller's control, not covered by
 * driller's own no-server privacy guarantee (AD-12, AD-16)"). Named per bot,
 * never a generic shared sentence — each bot is its own vendor's cloud
 * service.
 */
function prBotDisclosureText(bot: PrBotId): string {
  const toolName = bot === 'codeRabbit' ? 'CodeRabbit' : 'Qodo';
  return `${toolName}'s local CLI mode sends this project's diff/code content to ${toolName}'s own cloud service to generate findings. That transfer is outside driller's control and is not covered by driller's own no-server privacy guarantee.`;
}

/**
 * P2-1: the one confirmation sentence the indexing-scope group shows after a
 * successful save — what the map now shows when main applied it, or when it
 * will apply when it couldn't (Graph Service not running).
 */
export function projectScopeSavedMessage(config: ProjectScopeConfig, applied: boolean): string {
  if (!applied) {
    return 'Saved — applies when the Graph Service is running again.';
  }
  if (config.includedPaths.length === 0) {
    return 'Saved — the map shows the whole project.';
  }
  return `Saved — the map now shows only ${config.includedPaths.join(', ')}.`;
}

/**
 * P2-1: what a successful save does in Settings — the confirmation to show,
 * and whether to ask App.tsx to refetch the map (only when main applied the
 * scope to the running Graph Service; an unapplied save has nothing new to
 * fetch).
 */
export function projectScopeSaveOutcome(result: ProjectScopeSaveResult): { notice: string; refetch: boolean } {
  return { notice: projectScopeSavedMessage(result.config, result.applied), refetch: result.applied };
}

/** P2-6: the fixed sentence for a failed key removal; the detail goes to the console. */
export const KEY_REMOVE_FAILED_MESSAGE = "Couldn't remove the saved key.";

/**
 * P2-6: what a successful key removal does in Settings — the notice to show,
 * and whether to re-kick the map's pending Nodes (`onBackendSwitched`), which
 * is only when main actually relayed the change to a running Graph Service.
 */
export function keyRemovedOutcome(result: ClearCloudApiKeyResult): { notice: string; notify: boolean } {
  return {
    notice:
      result.config.activeBackend === 'cloud'
        ? 'Key removed. Cloud summaries are paused until you add a key.'
        : 'Key removed.',
    notify: result.relayed,
  };
}

export function Settings({
  onClose,
  onBackendSwitched,
  onProjectScopeApplied,
  projectPath,
  onIngestionResult,
}: SettingsProps) {
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyEntry, setKeyEntry] = useState<KeyEntryState>({ kind: 'idle' });
  // P2-6: the "Key removed." info notice, and whether a removal is in flight.
  const [keyRemovedNotice, setKeyRemovedNotice] = useState<string | null>(null);
  const [removingKey, setRemovingKey] = useState(false);
  const [keyRemoveError, setKeyRemoveError] = useState<string | null>(null);
  // Mirrors `config` so handleBackendChange's rollback (below) can read the
  // pre-optimistic-update value without depending on `config` itself and
  // recreating the callback (and re-subscribing the Escape-key listener)
  // on every config change.
  const configRef = useRef<BackendConfig | null>(null);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  // Story 1.10 (Phase 1): the editor preference group's own state, loaded
  // and saved independently of `config` above (own IPC round trip, own
  // optimistic-update-plus-rollback). `null` only until the first fetch
  // resolves — AD-23 guarantees the resolved value is never itself
  // undefined/unset.
  const [editorPreference, setEditorPreferenceState] = useState<EditorPreference | null>(null);
  const [editorPreferenceLoadError, setEditorPreferenceLoadError] = useState<string | null>(null);
  const [editorPreferenceSaveError, setEditorPreferenceSaveError] = useState<string | null>(null);
  const editorPreferenceRef = useRef<EditorPreference | null>(null);
  useEffect(() => {
    editorPreferenceRef.current = editorPreference;
  }, [editorPreference]);

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

  const refetchEditorPreference = useCallback(() => {
    window.driller
      .getEditorPreference()
      .then((next) => {
        setEditorPreferenceState(next);
        setEditorPreferenceLoadError(null);
        // Review finding: a stale save-error from an earlier failed save
        // attempt must not linger once a later successful load confirms
        // current state is correct — otherwise it can persist indefinitely
        // even after nothing is actually wrong anymore.
        setEditorPreferenceSaveError(null);
      })
      .catch((error) => {
        setEditorPreferenceLoadError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  useEffect(() => {
    refetchConfig();
    refetchEditorPreference();
  }, [refetchConfig, refetchEditorPreference]);

  // Story 2.3 (Phase 1): the PR-bot opt-in group's own state — its own IPC
  // round trip, keyed by `projectPath` rather than loaded once at mount like
  // the two groups above, since a different project's config must never
  // leak into view (Acceptance: "a second project's Settings never shows
  // the first project's enabled state"). `null` both before the first fetch
  // resolves and whenever `projectPath === null` (no project open).
  const [prBotConfig, setPrBotConfig] = useState<PrBotConfig | null>(null);
  const [prBotConfigLoadError, setPrBotConfigLoadError] = useState<string | null>(null);
  const [prBotDisclosure, setPrBotDisclosure] =
    useState<Record<PrBotId, PrBotDisclosureState>>(IDLE_PR_BOT_DISCLOSURE);

  // Story 2.3 (Phase 4): the "Run ingestion now" button's own per-bot state
  // — independent of `prBotDisclosure` above (enable/disable persistence
  // vs. an actual ingestion pass). `ingestionRequestIdRef` is the same
  // per-call supersession pattern `CodeMap.tsx`'s `handleOpenInEditor`
  // already established (Boundaries & Constraints: "a stale reply ...
  // never clobbers a newer one") — keyed by `PrBotId` since both bots' runs
  // are independent and a reply for one must never gate the other's local
  // display state.
  const [ingestionRun, setIngestionRun] = useState<Record<PrBotId, IngestionRunState>>(IDLE_INGESTION_RUN);
  const ingestionRequestIdRef = useRef<Record<PrBotId, number>>({ codeRabbit: 0, qodo: 0 });

  // Bug fix (2026-09-23): the indexing-scope allowlist group's own state —
  // same per-`projectPath` keying/staleness-guard shape as the PR-bot group
  // above (a different project's scope must never leak into view), but a
  // plain optimistic-save-with-rollback interaction (mirrors
  // `editorPreference`'s own group) rather than PR-bot's disclosure-then-
  // confirm flow — there's no privacy disclosure to show for a plain
  // indexing filter. `projectScopeInput` is the raw comma-separated text
  // being edited, independent of `projectScope` (the last-saved value) so
  // typing doesn't round-trip through an IPC call on every keystroke.
  const [projectScope, setProjectScope] = useState<ProjectScopeConfig | null>(null);
  const [projectScopeLoadError, setProjectScopeLoadError] = useState<string | null>(null);
  const [projectScopeInput, setProjectScopeInput] = useState('');
  const [projectScopeSaveError, setProjectScopeSaveError] = useState<string | null>(null);
  const [projectScopeSaving, setProjectScopeSaving] = useState(false);
  // P2-1: the last successful save's confirmation (`projectScopeSavedMessage`);
  // cleared on edit, on a new save, and on a project change.
  const [projectScopeSavedNotice, setProjectScopeSavedNotice] = useState<string | null>(null);

  // Review finding (Edge Case Hunter): Settings stays mounted across a
  // project switch (App.tsx never unmounts it), so a fetch/save promise
  // started for one `projectPath` can resolve after the prop has already
  // moved on to another project. Without this ref, that late response would
  // overwrite the newly-switched-to project's state with the stale
  // project's data — a direct violation of "a second project's Settings
  // never shows the first project's enabled state" (Acceptance Criteria).
  const projectPathRef = useRef<string | null>(projectPath);
  useEffect(() => {
    projectPathRef.current = projectPath;
  }, [projectPath]);

  const refetchPrBotConfig = useCallback(() => {
    if (projectPath === null) {
      // No project open: nothing to fetch — the fieldset renders
      // disabled/hidden below rather than showing stale or empty state.
      setPrBotConfig(null);
      setPrBotConfigLoadError(null);
      return;
    }
    window.driller
      .getPrBotConfig(projectPath)
      .then((next) => {
        if (projectPathRef.current !== projectPath) {
          // Stale response: projectPath has since changed. Discard rather
          // than clobber the current project's already-loaded/loading state.
          return;
        }
        setPrBotConfig(next);
        setPrBotConfigLoadError(null);
      })
      .catch((error) => {
        if (projectPathRef.current !== projectPath) {
          return;
        }
        setPrBotConfigLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [projectPath]);

  const refetchProjectScope = useCallback(() => {
    if (projectPath === null) {
      setProjectScope(null);
      setProjectScopeLoadError(null);
      setProjectScopeInput('');
      return;
    }
    window.driller
      .getProjectScope(projectPath)
      .then((next) => {
        if (projectPathRef.current !== projectPath) {
          return;
        }
        setProjectScope(next);
        setProjectScopeInput(next.includedPaths.join(', '));
        setProjectScopeLoadError(null);
      })
      .catch((error) => {
        if (projectPathRef.current !== projectPath) {
          return;
        }
        setProjectScopeLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [projectPath]);

  useEffect(() => {
    // Re-fetches whenever `projectPath` changes (including the mount fetch,
    // since `refetchPrBotConfig`'s identity depends on it) — and resets any
    // in-flight per-bot disclosure state back to idle, so a disclosure
    // notice left open for one project can never linger and be mistaken for
    // another project's state.
    refetchPrBotConfig();
    setPrBotDisclosure(IDLE_PR_BOT_DISCLOSURE);
    // Bug fix (2026-09-23): same per-project refetch, and same
    // never-leave-a-stale-error-visible reasoning, for the indexing-scope
    // allowlist group.
    refetchProjectScope();
    setProjectScopeSaveError(null);
    setProjectScopeSavedNotice(null);
    // Story 2.3 (Phase 4): same reasoning applied to the ingestion-run
    // display state — a "Running…"/result line left over from a previous
    // project must never linger and be mistaken for the newly-switched-to
    // project's own state. Bumping both bots' request ids also invalidates
    // any still-in-flight `runPrBotIngestion` call from the prior project,
    // so its eventual reply can't clobber this fresh idle state back to
    // something stale (the same supersession check `handleRunIngestion`
    // below applies on every settle).
    setIngestionRun(IDLE_INGESTION_RUN);
    ingestionRequestIdRef.current = {
      codeRabbit: ingestionRequestIdRef.current.codeRabbit + 1,
      qodo: ingestionRequestIdRef.current.qodo + 1,
    };
  }, [projectPath, refetchPrBotConfig, refetchProjectScope]);

  /**
   * Wires "Run ingestion now" to `window.driller.runPrBotIngestion` (Story
   * 2.3, Phase 4) — only ever called for a bot whose `enabled` is currently
   * persisted `true` (gated in the JSX below, Boundaries & Constraints).
   * `onIngestionResult` fires unconditionally on every real settled result
   * (SettingsProps' own doc comment: "not just success"), even one this
   * call's own `requestId` check would otherwise treat as stale for local
   * display — whether a bot's CLI is on PATH is a genuine machine-level
   * fact App.tsx's notice state needs regardless of which click produced
   * this particular reply. The local `ingestionRun` display, by contrast,
   * only ever reflects the LATEST call for that bot (the request-id-ref
   * supersession pattern `CodeMap.tsx`'s `handleOpenInEditor` already
   * established) — a stale reply from Settings being closed/reopened, or a
   * second click before the first resolves, never clobbers a newer one.
   *
   * Review finding (Edge Case Hunter, major): `ingestionRequestIdRef` is
   * local to THIS mount of Settings — it resets whenever Settings closes
   * and reopens (e.g. across a project switch), so it can't order replies
   * across mounts. That's fine for the local `ingestionRun` display (which
   * itself resets on every mount/project-change), but `onIngestionResult`
   * feeds App.tsx's `prBotToolNotFound`, which is NOT scoped to one mount —
   * two overlapping requests for the same bot from two different project
   * sessions could resolve out of order and leave App.tsx applying the
   * older reply after the newer one, misrepresenting the current state.
   * `requestedAt` (wall-clock `Date.now()`, captured once per request) is
   * passed through instead — unlike `ingestionRequestIdRef`, it never
   * resets on remount, so App.tsx can always tell which of two replies for
   * the same bot was actually initiated more recently, regardless of
   * mount/unmount in between.
   */
  const handleRunIngestion = useCallback(
    (bot: PrBotId) => {
      if (projectPath === null) {
        return;
      }
      const requestId = (ingestionRequestIdRef.current[bot] += 1);
      const requestedAt = Date.now();
      setIngestionRun((current) => ({ ...current, [bot]: { kind: 'running' } }));
      window.driller
        .runPrBotIngestion(projectPath, bot)
        .then((result) => {
          onIngestionResult?.(bot, result, requestedAt);
          if (ingestionRequestIdRef.current[bot] !== requestId) {
            return;
          }
          switch (result.status) {
            case 'ok':
              setIngestionRun((current) => ({ ...current, [bot]: { kind: 'ok', count: result.findingCount } }));
              break;
            case 'tool-not-found':
              setIngestionRun((current) => ({ ...current, [bot]: { kind: 'tool-not-found' } }));
              break;
            case 'no-base-ref-resolvable':
              setIngestionRun((current) => ({ ...current, [bot]: { kind: 'no-base-ref-resolvable' } }));
              break;
            case 'review-md-present':
              setIngestionRun((current) => ({
                ...current,
                [bot]: { kind: 'review-md-present', reviewMdPath: result.reviewMdPath },
              }));
              break;
            case 'error':
              setIngestionRun((current) => ({ ...current, [bot]: { kind: 'error', message: result.message } }));
              break;
          }
        })
        .catch((error: unknown) => {
          if (ingestionRequestIdRef.current[bot] !== requestId) {
            return;
          }
          setIngestionRun((current) => ({
            ...current,
            [bot]: { kind: 'error', message: error instanceof Error ? error.message : String(error) },
          }));
        });
    },
    [projectPath, onIngestionResult],
  );

  const persistPrBotEnabled = useCallback(
    (bot: PrBotId, enabled: boolean) => {
      if (projectPath === null) {
        return;
      }
      setPrBotDisclosure((current) => ({ ...current, [bot]: { kind: 'saving' } }));
      window.driller
        .setPrBotEnabled(projectPath, bot, enabled)
        .then((next) => {
          if (projectPathRef.current !== projectPath) {
            // Stale response: the user has since switched projects. This
            // project's own write already succeeded on disk, so nothing to
            // retry — just don't let it overwrite the now-different
            // project's displayed state (see projectPathRef above).
            return;
          }
          setPrBotConfig(next);
          setPrBotDisclosure((current) => ({ ...current, [bot]: { kind: 'idle' } }));
        })
        .catch((error) => {
          if (projectPathRef.current !== projectPath) {
            return;
          }
          setPrBotDisclosure((current) => ({
            ...current,
            [bot]: { kind: 'error', message: error instanceof Error ? error.message : String(error) },
          }));
        });
    },
    [projectPath],
  );

  /**
   * The PR-bot checkbox's onChange handler (Always: "toggling a bot's
   * checkbox to 'on' never persists `enabled: true` by itself"). Checking a
   * currently-disabled bot only opens its disclosure notice — no IPC call.
   * Unchecking an already-*persisted*-enabled bot persists immediately, no
   * disclosure. Unchecking a bot that's merely pending confirmation (never
   * actually persisted) just cancels the disclosure back to idle.
   */
  const handlePrBotToggle = useCallback(
    (bot: PrBotId, event: ChangeEvent<HTMLInputElement>) => {
      const wantsOn = event.target.checked;
      const persistedOn = prBotConfig ? isPrBotEnabled(bot, prBotConfig) : false;

      if (wantsOn) {
        if (persistedOn) {
          // Already enabled — the checkbox should already read checked;
          // nothing to do.
          return;
        }
        setPrBotDisclosure((current) => ({ ...current, [bot]: { kind: 'confirming' } }));
        return;
      }

      if (persistedOn) {
        persistPrBotEnabled(bot, false);
        return;
      }

      setPrBotDisclosure((current) => ({ ...current, [bot]: { kind: 'idle' } }));
    },
    [prBotConfig, persistPrBotEnabled],
  );

  /** The disclosure notice's own confirm button — the one path that can ever persist `enabled: true`. */
  const handlePrBotConfirm = useCallback(
    (bot: PrBotId) => {
      persistPrBotEnabled(bot, true);
    },
    [persistPrBotEnabled],
  );

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
      // P2-6: a backend change makes the removal notice's wording stale.
      setKeyRemovedNotice(null);
      setKeyRemoveError(null);
      setConfig((current) => (current ? { ...current, activeBackend: backend } : current));
      window.driller
        .setActiveBackend(backend)
        .then(() => {
          // P0-4: a genuine change (or an unknown previous value — an extra
          // map refetch is harmless, a missed one is a parity break).
          if (previousConfig?.activeBackend !== backend) {
            onBackendSwitched();
          }
          return refetchConfig();
        })
        .catch((error) => {
          setLoadError(error instanceof Error ? error.message : String(error));
          // Roll back the optimistic update on failure (review finding,
          // Medium) — otherwise the UI keeps showing a selection that was
          // never actually persisted, silently diverging from real state.
          setConfig(previousConfig);
        });
    },
    [refetchConfig, onBackendSwitched],
  );

  // Story 1.10 (Phase 1): mirrors `handleBackendChange`'s exact
  // optimistic-update-plus-rollback-on-failure shape (Always, this story's
  // Boundaries & Constraints) — a same-machine, near-instant local write,
  // applied immediately and confirmed/corrected by a refetch, rolled back to
  // the pre-click value with an inline error on failure (I/O & Edge-Case
  // Matrix: "Write to the store fails").
  const handleEditorPreferenceChange = useCallback(
    (value: EditorPreference) => {
      const previousEditorPreference = editorPreferenceRef.current;
      setEditorPreferenceSaveError(null);
      setEditorPreferenceState(value);
      window.driller
        .setEditorPreference(value)
        .then(refetchEditorPreference)
        .catch((error) => {
          setEditorPreferenceSaveError(error instanceof Error ? error.message : String(error));
          // Roll back the optimistic update on failure — otherwise the UI
          // keeps showing a selection that was never actually persisted,
          // silently diverging from real state (same reasoning as
          // handleBackendChange's own rollback above).
          setEditorPreferenceState(previousEditorPreference);
        });
    },
    [refetchEditorPreference],
  );

  /**
   * Wires the indexing-scope allowlist's "Save" button (Bug fix,
   * 2026-09-23) — not a keystroke-triggered optimistic update like
   * `handleEditorPreferenceChange` above (a free-text field, unlike a radio
   * group, needs an explicit commit point rather than saving every
   * keystroke). Parses `projectScopeInput`'s raw comma-separated text into
   * a trimmed, empty-entry-filtered array; the actual normalization
   * (path-separator cleanup, de-duplication) happens server-side
   * (project-scope-settings.ts's `coerceIncludedPaths`) and the response is
   * what both `projectScope` and `projectScopeInput` are set from — so the
   * displayed text reflects exactly what was persisted, not what was typed.
   */
  const handleProjectScopeSave = useCallback(() => {
    if (projectPath === null) {
      return;
    }
    const includedPaths = projectScopeInput
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    setProjectScopeSaving(true);
    setProjectScopeSaveError(null);
    setProjectScopeSavedNotice(null);
    window.driller
      .setProjectScope(projectPath, includedPaths)
      .then((result) => {
        if (projectPathRef.current !== projectPath) {
          return;
        }
        setProjectScope(result.config);
        setProjectScopeInput(result.config.includedPaths.join(', '));
        const { notice, refetch } = projectScopeSaveOutcome(result);
        setProjectScopeSavedNotice(notice);
        if (refetch) {
          onProjectScopeApplied();
        }
      })
      .catch((error) => {
        if (projectPathRef.current !== projectPath) {
          return;
        }
        setProjectScopeSaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (projectPathRef.current === projectPath) {
          setProjectScopeSaving(false);
        }
      });
  }, [projectPath, projectScopeInput, onProjectScopeApplied]);

  const attemptSaveKey = useCallback(
    (key: string, acknowledgeInsecureStorage: boolean) => {
      // P2-6: a save supersedes any removal notice or removal error, and
      // any warning/error it produces must not sit beside "Key removed."
      setKeyRemovedNotice(null);
      setKeyRemoveError(null);
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
            // P2-6: main itself relays the new key to a running Graph
            // Service (key-change-relay.ts), which re-kicks pending Nodes
            // without clearing summaries — when it did, the map just needs
            // to refetch, as after a backend switch.
            if (result.relayed === true) {
              onBackendSwitched();
            }
            return;
          }
          if (result.status === 'warning') {
            setKeyEntry({
              kind: 'warning',
              message: result.message ?? 'This machine has no secure keystore available.',
              pendingKey: key,
            });
            // P2-6: nothing was stored, so nothing is relayed — main only
            // relays after a successful save (the resubmitted "Store anyway"
            // call lands in the 'ok' branch above).
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
    [refetchConfig, onBackendSwitched],
  );

  /**
   * P2-6: one click, no confirmation. main deletes the ciphertext, relays the
   * key-less state to a running Graph Service when one is affected, and
   * returns the updated config plus whether it relayed. On failure a fixed
   * sentence shows in its own error notice (not the save slot, so it never
   * reads as a failed save), the detail goes to the console, and "Key saved"
   * stays (the config is left as it was).
   */
  const handleRemoveKey = useCallback(() => {
    setRemovingKey(true);
    setKeyRemovedNotice(null);
    setKeyRemoveError(null);
    window.driller
      .clearCloudApiKey()
      .then((result) => {
        const { notice, notify } = keyRemovedOutcome(result);
        setConfig(result.config);
        setLoadError(null);
        setKeyInput('');
        setKeyEntry({ kind: 'idle' });
        setKeyRemovedNotice(notice);
        if (notify) {
          onBackendSwitched();
        }
      })
      .catch((error) => {
        console.error('Failed to remove the saved cloud API key.', error instanceof Error ? error.message : String(error));
        setKeyRemoveError(KEY_REMOVE_FAILED_MESSAGE);
      })
      .finally(() => {
        setRemovingKey(false);
      });
  }, [onBackendSwitched]);

  const handleSaveKey = useCallback(() => {
    const trimmed = keyInput.trim();
    // Empty/whitespace-only key: rejected client-side, no IPC call made
    // (I/O & Edge-Case Matrix).
    if (trimmed.length === 0) {
      setKeyRemovedNotice(null);
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
    setKeyRemovedNotice(null);
    setKeyRemoveError(null);
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
          <ActionableNotice
            tone="error"
            role="alert"
            // Without this Retry, a failed initial `getBackendConfig()` fetch
            // left `config` permanently `null` for the rest of this panel
            // session — the whole backend-choice/key-entry body below never
            // rendered again, only this raw error text (review finding,
            // Medium). Reuses refetchConfig, the same call the initial mount
            // effect makes.
            action={
              <button type="button" onClick={refetchConfig} aria-label="Retry loading the backend setting">
                Retry
              </button>
            }
          >
            {loadError}
          </ActionableNotice>
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
                  <ActionableNotice tone="warning" role="status">
                    This machine has no secure OS keystore available. A stored key would have
                    weaker protection than usual.
                  </ActionableNotice>
                )}

                {config.hasCloudKey && keyEntry.kind !== 'warning' && keyInput.length === 0 && (
                  // Masked "Key saved" state — never re-displays the key
                  // itself, only that one is stored.
                  // P2-6: the Remove button sits beside the status text, not
                  // inside the live region, so it isn't re-announced.
                  <div className="settings-panel__key-saved-row">
                    <p className="settings-panel__key-saved" role="status">
                      Key saved (••••••••)
                    </p>
                    <button
                      type="button"
                      className="settings-panel__remove-key"
                      onClick={handleRemoveKey}
                      disabled={removingKey || keyEntry.kind === 'saving'}
                    >
                      {removingKey ? 'Removing…' : 'Remove saved key'}
                    </button>
                  </div>
                )}

                {keyRemovedNotice && (
                  <ActionableNotice tone="info" role="status">
                    {keyRemovedNotice}
                  </ActionableNotice>
                )}

                {keyRemoveError && (
                  <ActionableNotice tone="error" role="alert">
                    {keyRemoveError}
                  </ActionableNotice>
                )}

                <label className="settings-panel__key-label">
                  API key
                  <input
                    type="password"
                    value={keyInput}
                    onChange={handleKeyInputChange}
                    placeholder={config.hasCloudKey ? 'Enter a new key to replace the saved one' : 'sk-…'}
                    autoComplete="off"
                    disabled={removingKey}
                  />
                </label>

                <button
                  type="button"
                  className="settings-panel__save"
                  onClick={handleSaveKey}
                  disabled={keyEntry.kind === 'saving' || removingKey}
                >
                  {keyEntry.kind === 'saving' ? 'Saving…' : 'Save key'}
                </button>

                {keyEntry.kind === 'warning' && (
                  <ActionableNotice
                    tone="warning"
                    role="alert"
                    action={
                      <button type="button" onClick={handleAcknowledgeInsecureStorage} disabled={removingKey}>
                        Store anyway
                      </button>
                    }
                  >
                    {keyEntry.message}
                  </ActionableNotice>
                )}

                {keyEntry.kind === 'error' && (
                  <ActionableNotice tone="error" role="alert">
                    {keyEntry.message}
                  </ActionableNotice>
                )}
              </section>
            )}
          </>
        )}

        {editorPreferenceLoadError && (
          <ActionableNotice
            tone="error"
            role="alert"
            // Same "retry the exact fetch that failed" convention as the
            // backend-config load-error notice above.
            action={
              <button
                type="button"
                onClick={refetchEditorPreference}
                aria-label="Retry loading the editor preference"
              >
                Retry
              </button>
            }
          >
            {editorPreferenceLoadError}
          </ActionableNotice>
        )}

        {editorPreference && (
          <fieldset className="settings-panel__editor">
            <legend>External editor</legend>
            <label className="settings-panel__radio">
              <input
                type="radio"
                name="editorPreference"
                value="vscode"
                checked={editorPreference === 'vscode'}
                onChange={() => handleEditorPreferenceChange('vscode')}
              />
              VS Code
            </label>
            <label className="settings-panel__radio">
              <input
                type="radio"
                name="editorPreference"
                value="jetbrains"
                checked={editorPreference === 'jetbrains'}
                onChange={() => handleEditorPreferenceChange('jetbrains')}
              />
              JetBrains
            </label>
            <label className="settings-panel__radio">
              <input
                type="radio"
                name="editorPreference"
                value="system-default"
                checked={editorPreference === 'system-default'}
                onChange={() => handleEditorPreferenceChange('system-default')}
              />
              System default
            </label>

            {editorPreferenceSaveError && (
              <ActionableNotice tone="error" role="alert">
                {editorPreferenceSaveError}
              </ActionableNotice>
            )}
          </fieldset>
        )}

        {/* Story 2.3 (Phase 1): PR-bot opt-in + privacy disclosure — the
            fieldset itself is disabled (Always: "disabled ... when no
            project is open") via the native `disabled` attribute below,
            which also disables every descendant checkbox/button for free;
            this is inherently per-project, unlike every field above. */}
        <fieldset className="settings-panel__pr-bots" disabled={projectPath === null}>
          <legend>PR-bot ingestion</legend>

          {projectPath === null && (
            <p className="settings-panel__pr-bots-hint">
              Open a project to configure PR-bot ingestion.
            </p>
          )}

          {projectPath !== null && prBotConfigLoadError && (
            <ActionableNotice
              tone="error"
              role="alert"
              action={
                <button type="button" onClick={refetchPrBotConfig} aria-label="Retry loading the PR-bot settings">
                  Retry
                </button>
              }
            >
              {prBotConfigLoadError}
            </ActionableNotice>
          )}

          {projectPath !== null &&
            prBotConfig &&
            PR_BOTS.map(({ id, label }) => {
              const persistedOn = isPrBotEnabled(id, prBotConfig);
              const disclosure = prBotDisclosure[id];
              const checked = persistedOn || disclosure.kind === 'confirming' || disclosure.kind === 'saving';

              return (
                <div className="settings-panel__pr-bot" key={id}>
                  <label className="settings-panel__checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disclosure.kind === 'saving'}
                      onChange={(event) => handlePrBotToggle(id, event)}
                    />
                    {label}
                  </label>

                  {disclosure.kind === 'confirming' && (
                    <ActionableNotice
                      tone="warning"
                      role="alert"
                      action={
                        <button type="button" onClick={() => handlePrBotConfirm(id)}>
                          Enable {label}
                        </button>
                      }
                    >
                      {prBotDisclosureText(id)}
                    </ActionableNotice>
                  )}

                  {disclosure.kind === 'error' && (
                    <ActionableNotice tone="error" role="alert">
                      {disclosure.message}
                    </ActionableNotice>
                  )}

                  {/* Story 2.3 (Phase 4): "Run ingestion now" — only ever
                      shown next to a bot whose `enabled` is currently
                      PERSISTED true (Boundaries & Constraints: "never for a
                      disabled/unconfirmed bot"), so gated on `persistedOn`
                      itself, not `checked` above (which also covers the
                      transient confirming/saving states before enablement
                      is actually persisted). */}
                  {persistedOn && (
                    <div className="settings-panel__pr-bot-ingestion">
                      <button
                        type="button"
                        onClick={() => handleRunIngestion(id)}
                        disabled={ingestionRun[id].kind === 'running'}
                      >
                        {ingestionRun[id].kind === 'running' ? 'Running…' : 'Run ingestion now'}
                      </button>
                      {formatIngestionRunState(ingestionRun[id]) !== null &&
                        (ingestionRun[id].kind === 'error' ? (
                          <ActionableNotice tone="error" role="alert">
                            {formatIngestionRunState(ingestionRun[id])}
                          </ActionableNotice>
                        ) : (
                          <p className="settings-panel__pr-bot-ingestion-status" role="status">
                            {formatIngestionRunState(ingestionRun[id])}
                          </p>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
        </fieldset>

        <fieldset className="settings-panel__project-scope" disabled={projectPath === null}>
          <legend>Indexing scope</legend>

          {projectPath === null && (
            <p className="settings-panel__project-scope-hint">
              Open a project to restrict which subfolders are indexed.
            </p>
          )}

          {projectPath !== null && projectScopeLoadError && (
            <ActionableNotice
              tone="error"
              role="alert"
              action={
                <button type="button" onClick={refetchProjectScope} aria-label="Retry loading the indexing scope">
                  Retry
                </button>
              }
            >
              {projectScopeLoadError}
            </ActionableNotice>
          )}

          {projectPath !== null && projectScope && (
            <>
              <p className="settings-panel__project-scope-hint">
                Comma-separated subfolders the map shows (e.g. <code>web, app, api</code>). Leave
                empty to show the whole project — the default. While the Graph Service is running,
                saving updates the map right away, without re-indexing.
              </p>
              <label className="settings-panel__project-scope-label">
                Included subfolders
                <input
                  type="text"
                  value={projectScopeInput}
                  disabled={projectScopeSaving}
                  onChange={(event) => {
                    setProjectScopeInput(event.target.value);
                    setProjectScopeSavedNotice(null);
                  }}
                  placeholder="web, app, api"
                />
              </label>
              <button type="button" onClick={handleProjectScopeSave} disabled={projectScopeSaving}>
                {projectScopeSaving ? 'Saving…' : 'Save'}
              </button>
              {projectScopeSaveError && (
                <ActionableNotice tone="error" role="alert">
                  {projectScopeSaveError}
                </ActionableNotice>
              )}
              {projectScopeSavedNotice && (
                <ActionableNotice tone="info" role="status">
                  {projectScopeSavedNotice}
                </ActionableNotice>
              )}
            </>
          )}
        </fieldset>
      </div>
    </div>
  );
}
