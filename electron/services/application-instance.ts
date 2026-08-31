export interface ApplicationInstancePort {
  acquire(): boolean;
  onSecondInstance(focus: () => void): () => void;
}

export interface ApplicationInstanceTarget {
  requestSingleInstanceLock(): boolean;
  on(event: "second-instance", listener: () => void): unknown;
  removeListener(event: "second-instance", listener: () => void): unknown;
}

export interface OwnedWorkspaceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/** Adapts Electron's process-wide lock and second-instance event to a testable port. */
export function createApplicationInstancePort(
  application: ApplicationInstanceTarget,
): ApplicationInstancePort {
  return {
    acquire: () => application.requestSingleInstanceLock(),
    onSecondInstance: (focus) => {
      const listener = (): void => focus();
      application.on("second-instance", listener);
      let subscribed = true;
      return () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        application.removeListener("second-instance", listener);
      };
    },
  };
}

/** Quits a duplicate process before it can initialize any workspace services. */
export function acquireSingleInstance(
  instance: ApplicationInstancePort,
  quit: () => void,
): boolean {
  if (instance.acquire()) {
    return true;
  }

  quit();
  return false;
}

/** Restores the one owned workspace window for a duplicate launch or activation. */
export function restoreAndFocusWindow(window: OwnedWorkspaceWindow | null): void {
  if (!window || window.isDestroyed()) {
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}
