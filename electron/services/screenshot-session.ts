export interface ScreenshotSessionWindow {
  isVisible(): boolean;
  hide(): void;
  show(): void;
  showInactive?: () => void;
  isDestroyed?: () => boolean;
}

export interface ScreenshotSessionOptions<T> {
  window: ScreenshotSessionWindow;
  platform: NodeJS.Platform;
  capture: () => Promise<T> | T;
  /** Holds visibility restoration until a timed-out native capture has settled. */
  whenIdle?: () => Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
}

let sessionActive = false;

/** Returns whether a screenshot session currently owns visibility restoration. */
export function isScreenshotSessionActive(): boolean {
  return sessionActive;
}

const captureInProgress = {
  code: "CAPTURE_IN_PROGRESS",
  message: "A screenshot capture is already in progress.",
  action: "Wait for the current capture to finish before trying again.",
};

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isDestroyed(window: ScreenshotSessionWindow): boolean {
  return window.isDestroyed?.() ?? false;
}

export async function runScreenshotSession<T>({
  window,
  platform,
  capture,
  whenIdle,
  wait = defaultWait,
}: ScreenshotSessionOptions<T>): Promise<T> {
  if (sessionActive) {
    throw captureInProgress;
  }

  sessionActive = true;
  let wasVisible = false;
  let finalized = false;

  const restore = (): void => {
    if (finalized) {
      return;
    }
    finalized = true;

    try {
      if (wasVisible && !isDestroyed(window)) {
        if (platform === "darwin" && window.showInactive) {
          window.showInactive();
        } else {
          window.show();
        }
      }
    } catch {
      // A teardown race must not strand the session gate or create an unhandled rejection.
    } finally {
      sessionActive = false;
    }
  };

  const restoreWhenIdle = (): void => {
    if (!whenIdle) {
      restore();
      return;
    }

    let idle: Promise<void>;
    try {
      idle = whenIdle();
    } catch {
      restore();
      return;
    }

    // The caller-facing timeout is already rejected. Keep the late native
    // operation observed and release the gate on either settle path.
    void Promise.resolve(idle).then(restore, restore);
  };

  try {
    wasVisible = window.isVisible();
    if (wasVisible) {
      window.hide();
    }

    await wait(platform === "darwin" ? 80 : 40);
    const result = await capture();
    if (whenIdle) {
      try {
        await whenIdle();
      } catch {
        // A failed idle observer must not strand a successfully completed session.
      }
    }
    restore();
    return result;
  } catch (error) {
    restoreWhenIdle();
    throw error;
  }
}
