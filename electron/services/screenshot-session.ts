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
  wait = defaultWait,
}: ScreenshotSessionOptions<T>): Promise<T> {
  if (sessionActive) {
    throw captureInProgress;
  }

  sessionActive = true;
  let wasVisible = false;

  try {
    wasVisible = window.isVisible();
    if (wasVisible) {
      window.hide();
    }

    await wait(platform === "darwin" ? 80 : 40);
    return await capture();
  } finally {
    try {
      if (wasVisible && !isDestroyed(window)) {
        if (platform === "darwin" && window.showInactive) {
          window.showInactive();
        } else {
          window.show();
        }
      }
    } finally {
      sessionActive = false;
    }
  }
}
