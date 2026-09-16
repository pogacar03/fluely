import type { WebPreferences } from "electron";

export function getWindowPreferences(preload: string): Pick<
  WebPreferences,
  "preload" | "contextIsolation" | "sandbox" | "nodeIntegration"
> {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };
}
