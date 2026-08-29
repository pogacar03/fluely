export interface WindowLifecycleTarget {
  once(event: "ready-to-show", listener: () => void): unknown;
  on(event: "closed", listener: () => void): unknown;
  show(): void;
  isDestroyed?: () => boolean;
}

export interface WindowLifecycleOptions {
  window: WindowLifecycleTarget;
  isCaptureActive: () => boolean;
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
  onReadyToShow = () => window.show(),
  onClosed,
}: WindowLifecycleOptions): void {
  window.once("ready-to-show", () => {
    if (isCaptureActive() || window.isDestroyed?.()) {
      return;
    }
    onReadyToShow();
  });
  window.on("closed", onClosed);
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
