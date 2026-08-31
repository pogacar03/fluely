import {
  canOpenWork,
  navigateWorkspaceView,
  type WorkspaceView,
} from "../shared/workspace-view";

export type WorkspaceRootSelection =
  | { settings: true; work: false }
  | { settings: false; work: true };

export interface WorkspaceNavigationCallbacksOptions {
  setupComplete: boolean;
  getWorkspaceView(): WorkspaceView;
  setWorkspaceView(view: WorkspaceView): void;
  onWorkBlocked?: () => void;
}

export interface WorkspaceNavigationCallbacks {
  openSettings(): void;
  openWork(): boolean;
}

/** Selects the one renderer root App is allowed to mount for this render. */
export function selectWorkspaceRoot(view: WorkspaceView): WorkspaceRootSelection {
  return view === "settings"
    ? { settings: true, work: false }
    : { settings: false, work: true };
}

/** Creates App's session-only navigation callbacks without exposing persisted settings mutation. */
export function createWorkspaceNavigationCallbacks({
  setupComplete,
  getWorkspaceView,
  setWorkspaceView,
  onWorkBlocked,
}: WorkspaceNavigationCallbacksOptions): WorkspaceNavigationCallbacks {
  return {
    openSettings: () => {
      setWorkspaceView(navigateWorkspaceView(getWorkspaceView(), "settings", setupComplete));
    },
    openWork: () => {
      if (!canOpenWork(setupComplete)) {
        onWorkBlocked?.();
        return false;
      }
      setWorkspaceView(navigateWorkspaceView(getWorkspaceView(), "work", setupComplete));
      return true;
    },
  };
}
