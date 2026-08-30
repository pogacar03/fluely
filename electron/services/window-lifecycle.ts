export interface WindowLifecycleTarget {
  once(event: "ready-to-show", listener: () => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  show(): void;
  isDestroyed?: () => boolean;
}

export interface WindowLifecycleOptions {
  window: WindowLifecycleTarget;
  isCaptureActive: () => boolean;
  waitForCaptureIdle?: () => Promise<void>;
  onReadyToShow?: () => void;
  onClosed: () => void;
}

export interface ApplicationLifecycleTarget {
  on(event: "activate", listener: () => void): unknown;
}

export interface ApplicationLifecycleOptions {
  app: ApplicationLifecycleTarget;
  hasWindows: () => boolean;
  reassertPrivacy: () => void;
  createWindow: () => void;
}

/** Wires BrowserWindow lifecycle without allowing startup to bypass the capture gate. */
export function attachWindowLifecycle({
  window,
  isCaptureActive,
  waitForCaptureIdle,
  onReadyToShow = () => window.show(),
  onClosed,
}: WindowLifecycleOptions): void {
  let ready = false;
  let shown = false;
  let closed = false;
  let waitingForCaptureIdle: Promise<void> | undefined;

  const attemptShow = (): void => {
    if (!ready || shown || closed || window.isDestroyed?.()) {
      return;
    }

    if (isCaptureActive()) {
      if (!waitForCaptureIdle || waitingForCaptureIdle) {
        return;
      }

      let idle: Promise<void>;
      try {
        idle = Promise.resolve(waitForCaptureIdle());
      } catch {
        return;
      }
      waitingForCaptureIdle = idle;
      void idle.then(
        () => {
          if (waitingForCaptureIdle === idle) {
            waitingForCaptureIdle = undefined;
          }
          attemptShow();
        },
        () => {
          if (waitingForCaptureIdle === idle) {
            waitingForCaptureIdle = undefined;
          }
        },
      );
      return;
    }

    shown = true;
    onReadyToShow();
  };

  window.once("ready-to-show", () => {
    ready = true;
    attemptShow();
  });
  window.on("closed", () => {
    closed = true;
    onClosed();
  });
}

/** Keeps app activation on the same privacy/recreation path as the real main process. */
export function attachApplicationLifecycle({
  app,
  hasWindows,
  reassertPrivacy,
  createWindow,
}: ApplicationLifecycleOptions): void {
  app.on("activate", () => {
    reassertPrivacy();
    if (!hasWindows()) {
      createWindow();
    }
  });
}
