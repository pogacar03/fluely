import {
  createRequestIdDeduper,
  normalizeContextPrompt,
} from "../../src/shared/context-queue";
import type { ContextScreenshot } from "../../src/shared/context-queue";
import type {
  AnalysisRequest,
  AnalysisState,
  AnalysisStateChangedEvent,
  ScreenshotState,
  WorkspaceCommand,
} from "../../src/shared/ipc";
import type {
  CommandResult,
  ConversationAttachment,
  ConversationMessage,
  ConversationPort,
} from "../../src/shared/conversation";

export interface CommandRouterScreenshotPort {
  getState(): ScreenshotState;
  getManagedPaths(ids?: readonly string[]): string[];
  capture(): Promise<ContextScreenshot>;
  delete(id: string): Promise<ScreenshotState>;
  clear(): Promise<ScreenshotState>;
}

export interface CommandRouterAttachmentPort {
  addFromScreenshot(
    screenshot: Pick<ContextScreenshot, "width" | "height">,
    sourcePath: string,
  ): Promise<ConversationAttachment>;
  deleteUnreferenced(
    candidateIds: readonly string[],
    referencedIds: ReadonlySet<string> | readonly string[],
  ): Promise<string[]>;
}

export interface CommandRouterConversationPort extends ConversationPort {
  addAttachment(attachment: ConversationAttachment): ConversationAttachment;
  startTurn(prompt: string, attachmentIds: readonly string[]): {
    user: ConversationMessage;
    assistant: ConversationMessage;
  };
  updateAssistant(messageId: string, text: string, status?: "pending" | "streaming"): ConversationMessage;
  finishAssistant(
    messageId: string,
    status: "completed" | "error" | "cancelled",
    text?: string,
    error?: { code: string; message: string },
  ): ConversationMessage;
  clear(): Promise<void>;
  whenIdle?(): Promise<void>;
}

export interface CommandRouterAnalysisPort {
  start(request: AnalysisRequest): AnalysisState | Promise<AnalysisState>;
  cancel(): AnalysisState | Promise<AnalysisState>;
  getState(): AnalysisState;
  onStateChanged(listener: (event: AnalysisStateChangedEvent) => void): () => void;
  whenIdle?(): Promise<void>;
}

export interface CommandRouterOptions {
  screenshots: CommandRouterScreenshotPort;
  attachments: CommandRouterAttachmentPort;
  conversation: CommandRouterConversationPort;
  analysis: CommandRouterAnalysisPort;
}

export type CommandRouterErrorCode =
  | "ANALYSIS_IN_PROGRESS"
  | "SCREENSHOT_NOT_FOUND"
  | "ANALYSIS_FAILED";

export interface CommandRouterError extends Error {
  code: CommandRouterErrorCode;
  action: string;
}

interface ActiveRun {
  messageId: string;
  providerSettled: Promise<void>;
  terminal: boolean;
}

function createError(
  code: CommandRouterErrorCode,
  message: string,
  action: string,
): CommandRouterError {
  const error = new Error(message) as CommandRouterError;
  error.name = "CommandRouterError";
  error.code = code;
  error.action = action;
  return error;
}

function getAnalysisError(event: AnalysisStateChangedEvent): { code: string; message: string } {
  return {
    code: event.error?.code ?? "ANALYSIS_FAILED",
    message: event.error?.message ?? "Codex CLI analysis failed.",
  };
}

/**
 * Main-process command authority shared by desktop now and phone later.
 * `source` is deliberately observational: it cannot change command meaning.
 */
export class CommandRouter {
  private readonly screenshots: CommandRouterScreenshotPort;
  private readonly attachments: CommandRouterAttachmentPort;
  private readonly conversation: CommandRouterConversationPort;
  private readonly analysis: CommandRouterAnalysisPort;
  private readonly requestDeduper = createRequestIdDeduper<CommandResult>();
  private activeRun: ActiveRun | null = null;

  public constructor(options: CommandRouterOptions) {
    this.screenshots = options.screenshots;
    this.attachments = options.attachments;
    this.conversation = options.conversation;
    this.analysis = options.analysis;
    this.analysis.onStateChanged((event) => this.handleAnalysisEvent(event));
  }

  public execute(command: WorkspaceCommand, _source: "desktop" | "phone"): Promise<CommandResult> {
    return this.requestDeduper.run(
      command.requestId,
      JSON.stringify(command),
      () => this.executeOnce(command),
    );
  }

  public async whenIdle(): Promise<void> {
    await this.analysis.whenIdle?.();
    await this.activeRun?.providerSettled;
    await this.conversation.whenIdle?.();
  }

  private async executeOnce(command: WorkspaceCommand): Promise<CommandResult> {
    switch (command.type) {
      case "capture":
        await this.screenshots.capture();
        return this.result();
      case "remove":
        return this.result(await this.screenshots.delete(command.screenshotId));
      case "clear-queue":
        return this.result(await this.screenshots.clear());
      case "clear-conversation":
        await this.cancelAndSettle();
        await this.conversation.clear();
        return this.result();
      case "cancel":
        await this.analysis.cancel();
        await this.analysis.whenIdle?.();
        await this.activeRun?.providerSettled;
        return this.result();
      case "send":
        return this.send(command.prompt);
      case "capture-and-send":
        await this.screenshots.capture();
        return this.send(command.prompt);
    }
  }

  private async send(prompt: string): Promise<CommandResult> {
    this.ensureAnalysisAvailable();
    const queue = this.screenshots.getState();
    if (queue.items.length === 0) {
      throw createError(
        "SCREENSHOT_NOT_FOUND",
        "There are no screenshots in the context queue to send.",
        "Capture a screen before selecting Send images.",
      );
    }

    const materialized: ConversationAttachment[] = [];
    try {
      for (const screenshot of queue.items) {
        const sourcePath = this.screenshots.getManagedPaths([screenshot.id])[0];
        if (!sourcePath) {
          throw createError(
            "SCREENSHOT_NOT_FOUND",
            "One or more selected screenshots are no longer in the queue.",
            "Refresh the screenshot queue and try again.",
          );
        }
        materialized.push(await this.attachments.addFromScreenshot(screenshot, sourcePath));
      }
    } catch (error) {
      await this.deleteMaterialized(materialized);
      throw error;
    }

    const attachmentIds = materialized.map((attachment) => attachment.id);
    try {
      for (const attachment of materialized) {
        this.conversation.addAttachment(attachment);
      }
      const turn = this.conversation.startTurn(normalizeContextPrompt(prompt), attachmentIds);
      this.startAnalysis(turn.assistant.id, {
        prompt: normalizeContextPrompt(prompt),
        screenshotIds: queue.items.map((item) => item.id),
        intent: "answer",
        fast: false,
      });
      return this.result(queue);
    } catch (error) {
      await this.deleteMaterialized(materialized);
      throw error;
    }
  }

  private startAnalysis(messageId: string, request: AnalysisRequest): void {
    let settle!: () => void;
    const providerSettled = new Promise<void>((resolve) => { settle = resolve; });
    this.activeRun = { messageId, providerSettled, terminal: false };
    try {
      this.analysis.start(request);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Codex CLI analysis failed.";
      try {
        this.conversation.finishAssistant(messageId, "error", "", {
          code: (error as { code?: string })?.code ?? "ANALYSIS_FAILED",
          message,
        });
      } catch {
        // A terminal provider event may have won the race.
      }
      this.markRunTerminal(messageId);
      settle();
      return;
    }

    const whenIdle = this.analysis.whenIdle?.();
    if (whenIdle) {
      void whenIdle.then(settle, settle);
    } else {
      settle();
    }
  }

  private ensureAnalysisAvailable(): void {
    const state = this.analysis.getState();
    if (this.activeRun || state.status === "running") {
      throw createError(
        "ANALYSIS_IN_PROGRESS",
        "An analysis request is already running.",
        "Wait for the current answer to finish or cancel it before starting another request.",
      );
    }
  }

  private async cancelAndSettle(): Promise<void> {
    const state = this.analysis.getState();
    if (state.status === "running" || this.activeRun) {
      await this.analysis.cancel();
      await this.analysis.whenIdle?.();
      await this.activeRun?.providerSettled;
    }
  }

  private handleAnalysisEvent(event: AnalysisStateChangedEvent): void {
    const active = this.activeRun;
    if (!active) {
      return;
    }

    try {
      switch (event.event) {
        case "started":
          return;
        case "delta":
          this.conversation.updateAssistant(active.messageId, event.text, "streaming");
          return;
        case "completed":
          try {
            if (event.text.trim().length === 0) {
              this.conversation.finishAssistant(active.messageId, "error", "", {
                code: "ANALYSIS_FAILED",
                message: "Codex CLI returned no visible answer.",
              });
            } else {
              this.conversation.finishAssistant(active.messageId, "completed", event.text);
            }
          } finally {
            this.markRunTerminal(active.messageId);
          }
          return;
        case "error":
          try {
            this.conversation.finishAssistant(active.messageId, "error", event.text, getAnalysisError(event));
          } finally {
            this.markRunTerminal(active.messageId);
          }
          return;
        case "cancelled":
          try {
            this.conversation.finishAssistant(active.messageId, "cancelled", event.text);
          } finally {
            this.markRunTerminal(active.messageId);
          }
          return;
      }
    } catch {
      // The canonical store may already have received a terminal event from a
      // provider race; it must never make the analysis stream reject.
    }
  }

  private markRunTerminal(messageId: string): void {
    const active = this.activeRun;
    if (!active || active.messageId !== messageId) {
      return;
    }
    active.terminal = true;
    void active.providerSettled.then(() => {
      if (this.activeRun === active) {
        this.activeRun = null;
      }
    });
  }

  private async deleteMaterialized(materialized: readonly ConversationAttachment[]): Promise<void> {
    if (materialized.length === 0) {
      return;
    }
    const referenced = new Set(
      this.conversation.snapshot().messages.flatMap((message) => message.attachmentIds),
    );
    await this.attachments.deleteUnreferenced(materialized.map((attachment) => attachment.id), referenced);
  }

  private result(queue?: ScreenshotState): CommandResult {
    return {
      queue: queue ?? this.screenshots.getState(),
      conversation: this.conversation.snapshot(),
      analysis: this.analysis.getState(),
    };
  }
}
