import type { ScreenshotItem, ScreenshotState } from "../../src/shared/ipc";
import {
  isScreenshotSessionActive,
  runScreenshotSession,
  type ScreenshotSessionWindow,
} from "./screenshot-session";
export { attachApplicationLifecycle, attachWindowLifecycle } from "./window-lifecycle";

export interface ScreenshotWorkflowDependencies {
  window: ScreenshotSessionWindow;
  platform: NodeJS.Platform;
  capture: () => Promise<ScreenshotItem>;
  whenIdle?: () => Promise<void>;
  delete: (id: string) => Promise<ScreenshotState>;
  clear: () => Promise<ScreenshotState>;
}

export interface ScreenshotWorkflow {
  capture(): Promise<ScreenshotItem>;
  delete(id: string): Promise<ScreenshotState>;
  clear(): Promise<ScreenshotState>;
  toggleVisibility(): void;
}

export function createScreenshotWorkflow({
  window,
  platform,
  capture,
  whenIdle,
  delete: deleteScreenshot,
  clear,
}: ScreenshotWorkflowDependencies): ScreenshotWorkflow {
  return {
    capture: () => runScreenshotSession({ window, platform, capture, whenIdle }),
    delete: (id) => deleteScreenshot(id),
    clear: () => clear(),
    toggleVisibility: () => {
      if (window.isVisible()) {
        window.hide();
      } else if (!isScreenshotSessionActive()) {
        window.show();
      }
    },
  };
}
