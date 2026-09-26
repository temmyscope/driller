/**
 * P2-9: File ▸ Open Folder… (Cmd/Ctrl+O) runs the same open-folder flow as
 * the landing screen's Open a folder button. The handler owns its own
 * in-flight flag (set on call, cleared in `finally`), so a second keypress
 * before the first open settles is ignored, a rejection can't leave it
 * stuck, and a re-render can't reset it. `isBlocked` covers everything else
 * that should ignore the shortcut (a project open, a modal open, an open
 * already started from the button).
 */

export interface MenuOpenFolderDeps {
  isBlocked: () => boolean;
  open: () => Promise<void>;
}

export function createMenuOpenFolderHandler({ isBlocked, open }: MenuOpenFolderDeps): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight || isBlocked()) {
      return;
    }
    inFlight = true;
    try {
      await open();
    } finally {
      inFlight = false;
    }
  };
}
