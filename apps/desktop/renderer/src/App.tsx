import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BackendConfig,
  GraphServiceStatusMessage,
  HardwareAdvisoryMessage,
  IndexCoverageSummary,
  ModelStatusMessage,
  ProjectOpenResult,
  RecentProject,
} from '@driller/ipc-contracts';
import { CodeMap } from './CodeMap';
import { Settings } from './Settings';

type Notice =
  | { kind: 'not-a-git-repo'; path: string }
  | { kind: 'error'; message: string };

export function App() {
  const [recentProjects, setRecentProjects] = useState<RecentProject[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  // Story 1.6 (Phase 1): the Settings panel — driller's first Settings UI
  // surface, opened via the gear-icon button in the header below.
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [graphServiceStatus, setGraphServiceStatus] =
    useState<GraphServiceStatusMessage | null>(null);
  // The local-model download/verify status (Story 1.5 Phase 1, AD-18) — a
  // separate stream from graphServiceStatus (the two run in parallel and
  // either can fail independently), so it isn't project-path-correlated the
  // way graphServiceStatus is: there's exactly one local model per
  // installation, not one per project.
  const [modelStatus, setModelStatus] = useState<ModelStatusMessage | null>(null);
  // Story 1.6 (Phase 2): the backend config (already used by Settings) —
  // fetched once here too so App.tsx can derive the two new Actionable
  // Notice conditions (`noSummaryBackendAvailable`/`cloudSelectedNoKey`,
  // below) without CodeMap needing its own `getBackendConfig()` fetch.
  // Refetched whenever Settings closes (see `isSettingsOpen`'s `onClose`
  // below), since that's the only place `activeBackend`/`hasCloudKey` can
  // actually change during a session.
  const [backendConfig, setBackendConfig] = useState<BackendConfig | null>(null);
  // The hardware-adequacy advisory reasons currently active (Story 1.5
  // Phase 3) — a `Set`, not a single value, since the two signal sources
  // (constrained-tier, degenerate-results) are independent and can both be
  // true at once; each renders its own honest, reason-specific sentence
  // (Boundaries & Constraints: "wording distinguishes the two reasons
  // honestly"). Like `modelStatus`, there's one local model/generation run
  // per project, so this is reset on every fresh 'opened' project result
  // (see `applyOpenResult`) rather than lingering from a previously open
  // project.
  const [hardwareAdvisories, setHardwareAdvisories] = useState<Set<HardwareAdvisoryMessage['reason']>>(
    () => new Set(),
  );
  // The currently-open project's path, so a status correlated to a
  // different (superseded) project can be told apart from one about the
  // project actually on screen. Mirrored into a ref because the status
  // subscription below is registered once (empty deps) and would otherwise
  // close over a stale value.
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const currentProjectPathRef = useRef<string | null>(null);
  useEffect(() => {
    currentProjectPathRef.current = currentProjectPath;
  }, [currentProjectPath]);

  useEffect(() => {
    let cancelled = false;
    window.driller
      .listRecentProjects()
      .then((projects) => {
        if (!cancelled) {
          setRecentProjects(projects);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecentProjects([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Story 1.6 (Phase 2): fetched once on mount, and again whenever Settings
  // closes (its own `onClose` below) — the only place `activeBackend`/
  // `hasCloudKey` can change during a session. A failed fetch leaves
  // `backendConfig` at `null` rather than throwing; the derived booleans
  // below already treat `null` as "nothing to warn about yet" (same
  // conservative default a not-yet-loaded `modelStatus` gets).
  const refetchBackendConfig = useCallback(() => {
    window.driller
      .getBackendConfig()
      .then((config) => {
        setBackendConfig(config);
      })
      .catch(() => {
        // No explicit error surface for this — `noSummaryBackendAvailable`/
        // `cloudSelectedNoKey` simply stay false (via the `null` fallback in
        // their derivation below) rather than showing a wrong/stale notice.
      });
  }, []);

  useEffect(() => {
    refetchBackendConfig();
  }, [refetchBackendConfig]);

  useEffect(() => {
    const unsubscribe = window.driller.onGraphServiceStatus((status) => {
      // A status correlated to a project (indexing/indexed/an index-attempt
      // error) that isn't the one currently open is stale — e.g. a prior
      // project's attempt resolving after the user has already moved on to
      // another one. Discard it rather than showing project B's screen
      // with project A's counts or error (review round 1's concurrency bug).
      if ('path' in status && status.path !== currentProjectPathRef.current) {
        return;
      }
      setGraphServiceStatus(status);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.driller.onModelStatus((status) => {
      setModelStatus(status);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.driller.onHardwareAdvisory((message) => {
      // Additive, not replace: a second, different-reason advisory this
      // session must not clobber a still-relevant earlier one (Boundaries &
      // Constraints: both reasons can be independently true).
      setHardwareAdvisories((current) => {
        if (current.has(message.reason)) {
          return current;
        }
        const next = new Set(current);
        next.add(message.reason);
        return next;
      });
    });
    return unsubscribe;
  }, []);

  const applyOpenResult = useCallback((result: ProjectOpenResult) => {
    // Any outcome here (review finding, Low — not just 'opened') is a
    // transition away from whatever project/attempt the current
    // `hardwareAdvisories` belonged to: a stale advisory must not survive a
    // not-a-git-repo/error/cancelled result any more than it should survive
    // opening a genuinely new project. The Graph Service subprocess posts a
    // fresh advisory of its own for a newly-opened project if/when it's
    // actually warranted again.
    setHardwareAdvisories(new Set());
    switch (result.status) {
      case 'opened':
        setNotice(null);
        // Synchronous, not just via the ref-sync effect below: a status
        // push for this project (main sends the index-start request as
        // part of producing this very result) could in principle reach
        // this window before React has re-rendered and run that effect.
        currentProjectPathRef.current = result.project.path;
        setCurrentProjectPath(result.project.path);
        setRecentProjects((current) => {
          const withoutDuplicate = (current ?? []).filter(
            (p) => p.path !== result.project.path,
          );
          return [result.project, ...withoutDuplicate];
        });
        break;
      case 'not-a-git-repo':
        setNotice({ kind: 'not-a-git-repo', path: result.path });
        break;
      case 'error':
        setNotice({ kind: 'error', message: result.message });
        break;
      case 'cancelled':
        // The user backed out of the folder picker — clear any stale notice
        // from a previous attempt so it doesn't linger on screen.
        setNotice(null);
        break;
    }
  }, []);

  const reportUnexpectedError = useCallback((error: unknown) => {
    setNotice({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }, []);

  const handleOpenFolder = useCallback(async () => {
    setIsOpening(true);
    try {
      const result = await window.driller.openFolder();
      applyOpenResult(result);
    } catch (error) {
      // NFR4: no silent failure states — a rejected IPC call surfaces here
      // rather than becoming an unhandled promise rejection.
      reportUnexpectedError(error);
    } finally {
      setIsOpening(false);
    }
  }, [applyOpenResult, reportUnexpectedError]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      setIsOpening(true);
      // Set optimistically, synchronously, and before the IPC round-trip:
      // main sends the graph service its index-start request as part of
      // handling this same call, and that subprocess's first 'indexing'
      // push could in principle reach this window before this function's
      // own `await` resolves. Setting the ref immediately (the known
      // target path, not just on the eventual 'opened' result) keeps the
      // status-correlation filter above from discarding that legitimate,
      // freshly-arrived status as if it belonged to a stale/previous project.
      currentProjectPathRef.current = path;
      try {
        const result = await window.driller.openRecentProject(path);
        applyOpenResult(result);
      } catch (error) {
        reportUnexpectedError(error);
      } finally {
        setIsOpening(false);
      }
    },
    [applyOpenResult, reportUnexpectedError],
  );

  const handleRetryGraphService = useCallback(() => {
    // A restart respawns the Graph Service subprocess with fresh module
    // state (review finding, Medium) — any advisory shown before Retry
    // belonged to the pre-restart session and must not linger on screen
    // through it, matching `applyOpenResult`'s own "any transition away"
    // clearing. The fresh subprocess re-posts an advisory of its own, for
    // the current project, if/when the condition is still actually true.
    setHardwareAdvisories(new Set());
    window.driller.restartGraphService().catch(reportUnexpectedError);
  }, [reportUnexpectedError]);

  const isLoadingRecents = recentProjects === null;
  const hasRecentProjects = (recentProjects?.length ?? 0) > 0;
  // Once `indexed`, the Code Map replaces the open-folder/Recent Projects
  // screen as the only landing view (FR3) — never a file-tree/editor-first
  // view. The status badge stays visible, just demoted to a small
  // persistent footer rather than the main content (Code Map task list).
  const isIndexed = graphServiceStatus?.state === 'indexed';

  // Story 1.6 (Phase 2): the two new Actionable Notice conditions (Boundaries
  // & Constraints), derived entirely from already-fetched/subscribed state —
  // no new Graph Service message exists for either, by design (the Graph
  // Service just silently skips generation in both cases; see
  // services/graph-service/index.ts's `startSummaryGenerationForProject`).
  //
  // `localUnusable` only ever reflects a genuine reported failure
  // (`modelStatus?.state === 'error'`) — `null`/'downloading'/'verifying'/
  // 'ready' all read as "not (yet) unusable," never a false-positive notice
  // while the local model attempt is still in flight or hasn't been
  // observed yet this session.
  const localUnusable = modelStatus?.state === 'error';
  const hasCloudKey = backendConfig?.hasCloudKey ?? false;
  // "cloud selected, no key" — the currently *active* backend is cloud but
  // has no key to generate with, regardless of whether local happens to be
  // usable (Boundaries & Constraints: cloud being selected means the user
  // wants cloud, not a silent local fallback).
  const cloudSelectedNoKey = backendConfig?.activeBackend === 'cloud' && !hasCloudKey;
  // "no summary backend available" — neither backend can produce anything at
  // all (local unusable AND no cloud key to fall back to), independent of
  // which one is currently selected. The more specific `cloudSelectedNoKey`
  // takes priority when both technically apply (UX-DR17) — resolved here,
  // once, rather than leaving CodeMap to re-derive the same priority rule.
  const noSummaryBackendAvailable = !cloudSelectedNoKey && localUnusable && !hasCloudKey;

  return (
    <main className={`app${isIndexed ? ' app--map' : ''}`}>
      <header className="app__header">
        <div className="app__header-text">
          <h1 className="app__title">driller</h1>
          {!isIndexed && (
            <p className="app__subtitle">A browsable, honestly-indexed Code Map for a local codebase.</p>
          )}
        </div>
        <button
          type="button"
          className="app__settings-button"
          onClick={() => setIsSettingsOpen(true)}
          aria-label="Settings"
          title="Settings"
        >
          <span aria-hidden="true">⚙</span>
        </button>
      </header>

      {!isIndexed && (
        <>
          <section className="open-folder" aria-label="Open a project folder">
            <button
              type="button"
              className="open-folder__button"
              onClick={handleOpenFolder}
              disabled={isOpening}
            >
              {isOpening ? 'Opening…' : 'Open a folder'}
            </button>

            {notice?.kind === 'not-a-git-repo' && (
              <p className="notice notice--warning" role="status">
                <code>{notice.path}</code> is not a git repository. Choose another folder.
              </p>
            )}
            {notice?.kind === 'error' && (
              <p className="notice notice--error" role="alert">
                {notice.message}
              </p>
            )}
          </section>

          {!isLoadingRecents && hasRecentProjects && (
            <section className="recent-projects" aria-label="Recent projects">
              <h2 className="recent-projects__heading">Recent Projects</h2>
              <ul className="recent-projects__list">
                {recentProjects!.map((project) => (
                  <li key={project.path} className="recent-projects__item">
                    <button
                      type="button"
                      className="recent-projects__open"
                      onClick={() => handleOpenRecent(project.path)}
                      disabled={isOpening}
                    >
                      <span className="recent-projects__name">{project.name}</span>
                      <span className="recent-projects__path"><code>{project.path}</code></span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {isIndexed && (
        <section className="app__map" aria-label="Code Map">
          {/* `projectPath` (review finding, Medium) lets CodeMap reject a
              stale `graphService:summaryProgress` message for a project the
              user has since navigated away from — reliably non-null here:
              `isIndexed` only becomes true once an `indexed` status has
              already passed this component's own `currentProjectPathRef`
              correlation filter above, by which point `currentProjectPath`
              already reflects that same project. */}
          <CodeMap
            projectPath={currentProjectPath}
            noSummaryBackendAvailable={noSummaryBackendAvailable}
            cloudSelectedNoKey={cloudSelectedNoKey}
          />
        </section>
      )}

      {graphServiceStatus && (
        <footer className="graph-service-status" role="status">
          <GraphServiceStatusBadge status={graphServiceStatus} />
          {graphServiceStatus.state === 'error' && (
            <button type="button" className="graph-service-status__retry" onClick={handleRetryGraphService}>
              Retry
            </button>
          )}
        </footer>
      )}

      {modelStatus && (
        <footer className="model-status" role="status">
          <ModelStatusBadge status={modelStatus} />
          {modelStatus.state === 'error' && (
            // Reuses the Graph Service's own restart flow rather than a
            // bespoke retry channel (Code Map — this story adds no new IPC
            // request beyond onModelStatus): restarting respawns the Graph
            // Service subprocess and re-sends graphService:index for the
            // current project, which re-triggers ensureLocalModel() in the
            // fresh process (a failed attempt is never silently
            // auto-retried within the same process — see model-manager.ts).
            <button type="button" className="model-status__retry" onClick={handleRetryGraphService}>
              Retry
            </button>
          )}
        </footer>
      )}

      {/* Story 1.5 Phase 3: the hardware-adequacy advisory — a real
          Actionable-Notice-shaped element (icon+text, never color-only) near
          the model-status indicator above (Code Map/Design Notes). Still
          purely informational, with no button/action of its own (review
          finding, Low — comment updated for Story 1.6 Phase 2, which
          shipped the real cloud backend this advisory nudges toward):
          `formatHardwareAdvisory` below now correctly says cloud is a real,
          switchable option (Settings) rather than the pre-Phase-2 "isn't
          available yet" wording, but this footer itself still renders no
          button — the nudge only ever points the user at Settings by name,
          it doesn't add a shortcut into it.

          The `role="status"` region itself is always mounted (review
          finding, Low) — unlike `graphServiceStatus`/`modelStatus`'s own
          footers, which only mount once real content exists — because a
          live region reliably announces a change only if it already
          existed in the DOM before that change; mounting it for the first
          time in the same update that adds its first text risks that first
          advisory going unannounced by some screen readers. Empty (no
          advisories yet) renders no `<p>` children and collapses to zero
          visual footprint via `.hardware-advisory:empty` in styles.css,
          so this is invisible, not just empty-of-text, until the first
          advisory actually arrives. */}
      <footer className="hardware-advisory" role="status">
        {[...hardwareAdvisories].map((reason) => (
          <p key={reason} className="hardware-advisory__notice">
            <span aria-hidden="true">☁</span> {formatHardwareAdvisory(reason)}
          </p>
        ))}
      </footer>

      {isSettingsOpen && (
        <Settings
          projectPath={currentProjectPath}
          onClose={() => {
            setIsSettingsOpen(false);
            // Story 1.6 (Phase 2): the backend choice/key may have just
            // changed inside Settings — refresh `backendConfig` so
            // `noSummaryBackendAvailable`/`cloudSelectedNoKey` reflect it
            // immediately rather than waiting for some unrelated re-render.
            refetchBackendConfig();
          }}
        />
      )}
    </main>
  );
}

/**
 * Honest, reason-specific advisory text (Boundaries & Constraints: "wording
 * distinguishes the two reasons honestly") — updated for Story 1.6 Phase 2
 * (review finding, Low): the cloud backend is now real and switchable from
 * Settings, so the wording says so, rather than the pre-Phase-2 "isn't
 * available yet." Still purely a nudge, not a literal action: it names
 * where to go (Settings), not a button this component itself renders.
 */
function formatHardwareAdvisory(reason: HardwareAdvisoryMessage['reason']): string {
  switch (reason) {
    case 'constrained-tier':
      return 'This machine may be slow for local summaries — switching to the cloud backend in Settings would likely help.';
    case 'degenerate-results':
      return 'Local summaries are returning empty or slow results — switching to the cloud backend in Settings would likely help.';
  }
}

/**
 * Formats a millisecond duration as a short, human-readable elapsed-time
 * string ("340ms", "12s", "4m 05s", "1h 30m") — always shown, honestly,
 * regardless of how fast or slow the underlying hardware/repo made it
 * (NFR1, AD-15).
 *
 * Renders "—" for a non-finite input (e.g. a malformed `status.at`) rather
 * than a "NaNms"-shaped string — a bad timestamp should never leak into the
 * rendered text.
 *
 * The sub-second branch checks the *rounded* value, not the raw one: a raw
 * value in `[999.5, 1000)` would otherwise take the `ms` branch and
 * `Math.round` it up to a confusing "1000ms" instead of "1s".
 */
function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—';
  }
  const roundedMs = Math.round(Math.max(0, ms));
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  const totalSeconds = Math.floor(roundedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  // Unreachable under the current 30-minute indexing timeout ceiling, but
  // kept for robustness if that ceiling is ever raised independently.
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
}

/** "1 file" / "2 files" — the coverage gap text names its unit, correctly pluralized. */
function pluralizeFiles(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

/** True when the backend's own reporting shows a genuine coverage gap. */
function hasCoverageGap(coverage: IndexCoverageSummary): boolean {
  return coverage.skippedCount > 0 || coverage.parsePartialCount > 0;
}

/**
 * Renders the coverage summary distinctly for full vs. partial coverage
 * (FR2, UX-DR11) — sourced entirely from `coverage`, never re-derived here.
 * `not_indexed` exclusions never factor in: `coverage` only ever carries the
 * genuine `skipped`/`parse_partial` gap counts.
 *
 * Full-vs-gap is keyed on `skippedCount`/`parsePartialCount` alone (via
 * `hasCoverageGap`) — never on `nodes === expectedNodes` — because
 * `expectedNodes`/`expectedEdges` are optional enrichment on
 * `IndexCoverageSummary`, not always present (see mcp-client.ts's
 * `fetchCoverage` doc comment for why). The "x of y expected" detail below
 * is appended only when the backend's response happened to include both
 * expected-count fields; its absence never blocks the full/partial verdict
 * itself.
 */
function formatCoverage(coverage: IndexCoverageSummary, nodes: number, edges: number): string {
  const verdict = hasCoverageGap(coverage)
    ? [
        coverage.parsePartialCount > 0
          ? `${pluralizeFiles(coverage.parsePartialCount)} partially parsed`
          : null,
        coverage.skippedCount > 0 ? `${pluralizeFiles(coverage.skippedCount)} skipped` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(', ')
    : 'full coverage';

  if (coverage.expectedNodes === undefined || coverage.expectedEdges === undefined) {
    return verdict;
  }
  return `${verdict} (${nodes}/${coverage.expectedNodes} nodes, ${edges}/${coverage.expectedEdges} edges expected)`;
}

function GraphServiceStatusBadge({ status }: { status: GraphServiceStatusMessage }) {
  // Drives the live-ticking elapsed display while `state === 'indexing'`
  // (derived from `status.at`, no new IPC data needed) so a repo that
  // legitimately runs well past the ~3min target-scale budget still shows
  // visible progress rather than an unchanging "Indexing…" that reads as
  // hung. Inert for every other state.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status.state !== 'indexing') {
      return undefined;
    }
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [status.state, status.at]);

  switch (status.state) {
    case 'starting':
      return <span className="badge badge--pending">Graph Service starting…</span>;
    case 'alive':
      return <span className="badge badge--ok">Graph Service running</span>;
    case 'indexing': {
      const elapsedMs = now - new Date(status.at).getTime();
      return (
        <span className="badge badge--pending">
          Indexing…{' '}
          {/*
           * `aria-live="off"` on just this ticking span, nested inside the
           * page's `<footer role="status">` (an implicit `aria-live="polite"`
           * region): without it, a screen reader would re-announce this
           * badge roughly every second for the whole indexing run. The
           * meaningful state transition (this "Indexing…" text later being
           * replaced by "Indexed — …") still happens in the enclosing
           * `polite` region and is still announced once, since it isn't
           * inside this `off` span.
           */}
          <span aria-live="off">({formatElapsedMs(elapsedMs)})</span>
        </span>
      );
    }
    case 'indexed': {
      const gap = status.coverage ? hasCoverageGap(status.coverage) : false;
      return (
        <span className={`badge ${gap ? 'badge--warning' : 'badge--ok'}`}>
          Indexed — {status.nodes} nodes, {status.edges} edges ·{' '}
          {formatElapsedMs(status.elapsedMs)}
          {status.coverage && (
            <> · {formatCoverage(status.coverage, status.nodes, status.edges)}</>
          )}
        </span>
      );
    }
    case 'exited':
      return <span className="badge badge--muted">Graph Service exited</span>;
    case 'error':
      return (
        <span className="badge badge--error">
          Graph Service unavailable: {status.message}
          {status.elapsedMs !== undefined && <> (after {formatElapsedMs(status.elapsedMs)})</>}
        </span>
      );
  }
}

/**
 * "512 B" / "512.0 MB" / "1.2 GB" — bytes formatted for the model-download
 * progress text. Renders raw bytes below the 1KB threshold (review finding:
 * a sub-1KB value — plausible right as a download connection opens, before
 * any real progress has landed — used to render as a misleading "0 KB"
 * rather than something that reads sensibly at that size).
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Story 1.5 Phase 1's small, persistent local-model status indicator
 * (Design Notes / Code Map: text only, no Node-card rendering yet — this
 * phase's model-ready signal has no consumer beyond this badge). Mirrors
 * `GraphServiceStatusBadge`'s shape but is otherwise fully independent —
 * the two statuses run in parallel and are never conflated.
 *
 * Accessibility balance (review finding, matching `GraphServiceStatusBadge`'s
 * ticking elapsed-time indicator): the meaningful state transitions
 * (downloading → verifying → ready/error) are plain text, direct children of
 * this badge — never wrapped in `aria-live="off"` — so they're announced by
 * the enclosing `<footer role="status">` (an implicit `aria-live="polite"`
 * region) exactly once per transition, the same as any other status text.
 * Only the fast-changing byte-counter detail is suppressed, and is nested in
 * its *own* `aria-live="off"` span (with `aria-atomic="false"` alongside it,
 * belt-and-suspenders against a `role="status"` ancestor's implicit
 * `aria-atomic="true"` otherwise re-reading this nested span's every tick as
 * part of the ancestor's own atomic announcement) — never suppressing the
 * badge's own state-transition text itself.
 */
function ModelStatusBadge({ status }: { status: ModelStatusMessage }) {
  switch (status.state) {
    case 'downloading': {
      const percent =
        status.totalBytes > 0
          ? Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100))
          : undefined;
      return (
        <span className="badge badge--pending">
          Downloading model…{' '}
          <span aria-live="off" aria-atomic="false">
            ({formatBytes(status.downloadedBytes)} / {formatBytes(status.totalBytes)}
            {percent !== undefined && <> · {percent}%</>})
          </span>
        </span>
      );
    }
    case 'verifying':
      return <span className="badge badge--pending">Verifying model…</span>;
    case 'ready':
      return <span className="badge badge--ok">Model ready</span>;
    case 'error':
      return <span className="badge badge--error">Model unavailable: {status.message}</span>;
  }
}
