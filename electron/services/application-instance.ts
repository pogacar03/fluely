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

export interface ApplicationWindowFocusOptions {
  getWindow(): OwnedWorkspaceWindow | null;
  isReady(): boolean;
  isCaptureActive(): boolean;
  waitForCaptureIdle(): Promise<void>;
}

export interface ApplicationWindowFocusController {
  requestFocus(): void;
  notifyGateChanged(): boolean;
  notifyWindowDestroyed(): void;
  dispose(): void;
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

/** Coalesces duplicate-launch focus until readiness and capture visibility gates are open. */
export function createApplicationWindowFocusController({
  getWindow,
  isReady,
  isCaptureActive,
  waitForCaptureIdle,
}: ApplicationWindowFocusOptions): ApplicationWindowFocusController {
  let pending = false;
  let disposed = false;
  let waitingForCaptureIdle: Promise<void> | undefined;

  const attemptFocus = (): boolean => {
    if (disposed || !pending || !isReady()) {
      return false;
    }

    const window = getWindow();
    if (!window || window.isDestroyed()) {
      pending = false;
      return false;
    }

    if (isCaptureActive()) {
      if (waitingForCaptureIdle) {
        return false;
      }

      let idle: Promise<void>;
      try {
        idle = Promise.resolve(waitForCaptureIdle());
      } catch {
        return false;
      }
      waitingForCaptureIdle = idle;
      void idle.then(
        () => {
          if (waitingForCaptureIdle === idle) {
            waitingForCaptureIdle = undefined;
          }
          attemptFocus();
        },
        () => {
          if (waitingForCaptureIdle === idle) {
            waitingForCaptureIdle = undefined;
          }
        },
      );
      return false;
    }

    pending = false;
    restoreAndFocusWindow(window);
    return true;
  };

  return {
    requestFocus: () => {
      if (disposed) {
        return;
      }
      pending = true;
      attemptFocus();
    },
    notifyGateChanged: attemptFocus,
    notifyWindowDestroyed: () => {
      pending = false;
      waitingForCaptureIdle = undefined;
    },
    dispose: () => {
      disposed = true;
      pending = false;
      waitingForCaptureIdle = undefined;
    },
  };
}
