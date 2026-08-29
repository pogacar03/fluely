import type { ScreenshotItem, ScreenshotState } from "../../src/shared/ipc";
import {
  isScreenshotSessionActive,
  runScreenshotSession,
  type ScreenshotSessionWindow,
} from "./screenshot-session";

export interface ScreenshotWorkflowDependencies {
  window: ScreenshotSessionWindow;
  platform: NodeJS.Platform;
  capture: () => Promise<ScreenshotItem>;
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
  delete: deleteScreenshot,
  clear,
}: ScreenshotWorkflowDependencies): ScreenshotWorkflow {
  return {
    capture: () => runScreenshotSession({ window, platform, capture }),
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
