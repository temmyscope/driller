import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GraphServiceStatusMessage,
  IndexCoverageSummary,
  ProjectOpenResult,
  RecentProject,
} from '@driller/ipc-contracts';

type Notice =
  | { kind: 'not-a-git-repo'; path: string }
  | { kind: 'error'; message: string };

export function App() {
  const [recentProjects, setRecentProjects] = useState<RecentProject[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [graphServiceStatus, setGraphServiceStatus] =
    useState<GraphServiceStatusMessage | null>(null);
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

  const applyOpenResult = useCallback((result: ProjectOpenResult) => {
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
    window.driller.restartGraphService().catch(reportUnexpectedError);
  }, [reportUnexpectedError]);

  const isLoadingRecents = recentProjects === null;
  const hasRecentProjects = (recentProjects?.length ?? 0) > 0;

  return (
    <main className="app">
      <header className="app__header">
        <h1 className="app__title">driller</h1>
        <p className="app__subtitle">A browsable, honestly-indexed Code Map for a local codebase.</p>
      </header>

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
    </main>
  );
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
