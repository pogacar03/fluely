import type { BrowserWindow } from "electron";

export interface CapturePrivacyWindow {
  setContentProtection?: (enabled: boolean) => void;
  setHiddenInMissionControl?: (hidden: boolean) => void;
  on(event: "show", listener: () => void): unknown;
  removeListener(event: "show", listener: () => void): unknown;
  isDestroyed?: () => boolean;
}

export type PlatformDetector = NodeJS.Platform | (() => NodeJS.Platform);

function isDestroyed(window: CapturePrivacyWindow): boolean {
  return window.isDestroyed?.() ?? false;
}

export class CapturePrivacyController {
  private window: CapturePrivacyWindow | null = null;
  private enabled = true;
  private readonly platformDetector: () => NodeJS.Platform;
  private readonly onShow = (): void => {
    this.reassert();
  };

  public constructor(platform: PlatformDetector = process.platform) {
    this.platformDetector = typeof platform === "function" ? platform : () => platform;
  }

  public apply(window: CapturePrivacyWindow | BrowserWindow, enabled: boolean): void {
    this.detach();
    this.window = window;
    this.enabled = enabled;

    if (isDestroyed(window)) {
      this.window = null;
      return;
    }

    this.applyToWindow(window);
    try {
      window.on("show", this.onShow);
    } catch {
      // Ignore teardown races while a BrowserWindow is closing.
    }
  }

  public reassert(): void {
    if (!this.window || isDestroyed(this.window)) {
      return;
    }

    this.applyToWindow(this.window);
  }

  public dispose(): void {
    this.detach();
    this.window = null;
  }

  private applyToWindow(window: CapturePrivacyWindow): void {
    if (isDestroyed(window)) {
      return;
    }

    try {
      window.setContentProtection?.(this.enabled);
    } catch {
      // A window can be destroyed between the liveness check and the call.
    }

    if (this.platformDetector() !== "darwin") {
      return;
    }

    if (isDestroyed(window)) {
      return;
    }

    try {
      window.setHiddenInMissionControl?.(this.enabled);
    } catch {
      // Mission Control hiding is best-effort and unavailable on some builds.
    }
  }

  private detach(): void {
    if (!this.window) {
      return;
    }

    try {
      this.window.removeListener("show", this.onShow);
    } catch {
      // Ignore teardown races with a destroyed BrowserWindow.
    }
  }
}
