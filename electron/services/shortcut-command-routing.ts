import { randomUUID } from "node:crypto";
import { EMPTY_CONTEXT_PROMPT } from "../../src/shared/context-queue";
import type { WorkspaceCommand } from "../../src/shared/ipc";
import type { ShortcutActionHandlers } from "./ShortcutManager";

export interface ShortcutCommandExecutor {
  execute(command: WorkspaceCommand, source: "desktop" | "phone"): Promise<unknown> | unknown;
}

export type ShortcutRequestIdFactory = (action: WorkspaceCommand["type"]) => string;

function createDefaultRequestIdFactory(): ShortcutRequestIdFactory {
  const nonce = randomUUID();
  let sequence = 0;
  return (action) => `shortcut-${nonce}-${action}-${++sequence}`;
}

/**
 * Converts global desktop shortcuts into the same typed commands used by the
 * renderer and future phone gateway. The shortcut layer never owns queue or
 * conversation state and never calls AnalysisService directly.
 */
export function createShortcutCommandHandlers(
  router: ShortcutCommandExecutor,
  requestIdFactory: ShortcutRequestIdFactory = createDefaultRequestIdFactory(),
): Required<Pick<ShortcutActionHandlers, "captureScreenshot" | "ask" | "cancelAndClear">> {
  const execute = (command: WorkspaceCommand): Promise<void> =>
    Promise.resolve(router.execute(command, "desktop")).then(() => undefined);
  const command = <T extends WorkspaceCommand["type"]>(type: T): Extract<WorkspaceCommand, { type: T }> => ({
    type,
    requestId: requestIdFactory(type),
    ...(type === "ask" ? { prompt: EMPTY_CONTEXT_PROMPT } : {}),
  } as Extract<WorkspaceCommand, { type: T }>);

  return {
    captureScreenshot: () => execute(command("capture")),
    ask: () => execute(command("ask")),
    cancelAndClear: async () => {
      await execute(command("cancel"));
      await execute(command("clear-queue"));
    },
  };
}
