import { useCallback, useEffect, useState } from 'react';
import type {
  GraphServiceStatusMessage,
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
    const unsubscribe = window.driller.onGraphServiceStatus(setGraphServiceStatus);
    return unsubscribe;
  }, []);

  const applyOpenResult = useCallback((result: ProjectOpenResult) => {
    switch (result.status) {
      case 'opened':
        setNotice(null);
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

function GraphServiceStatusBadge({ status }: { status: GraphServiceStatusMessage }) {
  switch (status.state) {
    case 'starting':
      return <span className="badge badge--pending">Graph Service starting…</span>;
    case 'alive':
      return <span className="badge badge--ok">Graph Service running</span>;
    case 'exited':
      return <span className="badge badge--muted">Graph Service exited</span>;
    case 'error':
      return (
        <span className="badge badge--error">
          Graph Service unavailable{status.message ? `: ${status.message}` : ''}
        </span>
      );
  }
}
