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
  capture(source: "desktop" | "phone"): Promise<ContextScreenshot>;
  delete(id: string): Promise<ScreenshotState>;
  clear(): Promise<ScreenshotState>;
  cancelPending?(source?: "desktop" | "phone"): Promise<void>;
  whenIdle?(): Promise<void>;
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
  addAttachmentsAndStartTurn(
    prompt: string,
    attachments: readonly ConversationAttachment[],
  ): {
    user: ConversationMessage;
    assistant: ConversationMessage;
  };
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
  start(request: AnalysisRequest): Promise<void>;
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
  | "INVALID_ARGUMENT"
  | "ANALYSIS_IN_PROGRESS"
  | "SCREENSHOT_NOT_FOUND"
  | "ANALYSIS_FAILED"
  | "COMMAND_CANCELLED";

export interface CommandRouterError extends Error {
  code: CommandRouterErrorCode;
  action: string;
}

interface ActiveRun {
  messageId: string;
  source: "desktop" | "phone";
  providerSettled: Promise<void>;
  terminal: boolean;
}

interface CommandScope {
  source: "desktop" | "phone";
  generation: number;
  globalGeneration: number;
  started: boolean;
  operation?: Promise<CommandResult>;
  cancellation: Promise<never>;
  cancel(error: CommandRouterError): void;
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

const MAX_CONVERSATION_CONTEXT_LENGTH = 3000;

function buildConversationContext(snapshot: ReturnType<ConversationPort["snapshot"]>): string | undefined {
  const entries = snapshot.messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .map((message) => `${message.role}: ${message.text.trim()}`);
  if (entries.length === 0) {
    return undefined;
  }

  const selected: string[] = [];
  let length = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const remaining = MAX_CONVERSATION_CONTEXT_LENGTH - length - (selected.length > 0 ? 1 : 0);
    if (remaining <= 0) {
      break;
    }
    const entry = entries[index].slice(0, remaining);
    selected.unshift(entry);
    length += entry.length + (selected.length > 1 ? 1 : 0);
    if (entry.length < entries[index].length) {
      break;
    }
  }
  return selected.join("\n") || undefined;
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
  private commandTail: Promise<void> = Promise.resolve();
  private activeRun: ActiveRun | null = null;
  private activeCommand: CommandScope | null = null;
  private readonly scopes = new Set<CommandScope>();
  private phoneGeneration = 0;
  private globalGeneration = 0;

  public constructor(options: CommandRouterOptions) {
    this.screenshots = options.screenshots;
    this.attachments = options.attachments;
    this.conversation = options.conversation;
    this.analysis = options.analysis;
    this.analysis.onStateChanged((event) => this.handleAnalysisEvent(event));
  }

  public execute(command: WorkspaceCommand, source: "desktop" | "phone"): Promise<CommandResult> {
    return this.requestDeduper.run(
      command.requestId,
      JSON.stringify(command),
      () => this.executeScoped(command, source),
    );
  }

  public async quiesce(scope: "phone" | "all"): Promise<void> {
    if (scope === "all") this.globalGeneration += 1;
    else this.phoneGeneration += 1;
    const targets = [...this.scopes].filter((item) => scope === "all" || item.source === "phone");
    const cancellation = createError(
      "COMMAND_CANCELLED",
      "The command was cancelled because its session ended.",
      "Start a new session and try again.",
    );
    for (const target of targets) target.cancel(cancellation);

    await this.screenshots.cancelPending?.(scope === "phone" ? "phone" : undefined);
    const activeRun = this.activeRun;
    if (activeRun && (scope === "all" || activeRun.source === "phone")) {
      await this.analysis.cancel();
      await this.analysis.whenIdle?.();
      await activeRun.providerSettled;
    }
    await Promise.allSettled(targets.filter((target) => target.started).map((target) => target.operation));
  }

  public async whenIdle(): Promise<void> {
    await this.commandTail;
    await this.analysis.whenIdle?.();
    await this.activeRun?.providerSettled;
    await this.conversation.whenIdle?.();
  }

  private async executeOnce(command: WorkspaceCommand, source: "desktop" | "phone", scope: CommandScope): Promise<CommandResult> {
    switch (command.type) {
      case "capture":
        await this.screenshots.capture(source);
        this.assertCurrent(scope);
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
      case "ask":
        return this.ask(command.prompt, source, scope);
      case "send":
      case "capture-and-send":
        throw createError(
          "INVALID_ARGUMENT",
          "That workspace command is no longer supported.",
          "Use Capture or Ask and try again.",
        );
    }
  }

  private async ask(prompt: string | undefined, source: "desktop" | "phone", scope: CommandScope): Promise<CommandResult> {
    this.ensureAnalysisAvailable();
    const queue = this.screenshots.getState();
    const hasPrompt = typeof prompt === "string" && prompt.trim().length > 0;
    if (queue.items.length === 0 && !hasPrompt) {
      throw createError(
        "INVALID_ARGUMENT",
        "Ask requires a question or at least one queued screenshot.",
        "Enter a question or capture a screen before asking.",
      );
    }

    const normalizedPrompt = normalizeContextPrompt(prompt);
    const conversationContext = buildConversationContext(this.conversation.snapshot());

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
        this.assertCurrent(scope);
      }
    } catch (error) {
      await this.deleteMaterialized(materialized);
      throw error;
    }

    try {
      const turn = this.conversation.addAttachmentsAndStartTurn(
        normalizedPrompt,
        materialized,
      );
      this.assertCurrent(scope);
      await this.startAnalysis(turn.assistant.id, source, {
        prompt: normalizedPrompt,
        screenshotIds: queue.items.map((item) => item.id),
        intent: "answer",
        fast: false,
        ...(conversationContext ? { conversationContext } : {}),
      });
      this.assertCurrent(scope);
      return this.result(await this.screenshots.clear());
    } catch (error) {
      await this.deleteMaterialized(materialized);
      throw error;
    }
  }

  private async startAnalysis(messageId: string, source: "desktop" | "phone", request: AnalysisRequest): Promise<void> {
    let settle!: () => void;
    const providerSettled = new Promise<void>((resolve) => { settle = resolve; });
    const activeRun: ActiveRun = { messageId, source, providerSettled, terminal: false };
    this.activeRun = activeRun;
    try {
      await this.analysis.start(request);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Codex CLI analysis failed.";
      if (!activeRun.terminal) {
        try {
          this.conversation.finishAssistant(messageId, "error", "", {
            code: (error as { code?: string })?.code ?? "ANALYSIS_FAILED",
            message,
          });
        } catch {
          // A terminal provider event may have won the race.
        }
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

  private executeScoped(command: WorkspaceCommand, source: "desktop" | "phone"): Promise<CommandResult> {
    let cancel!: (error: CommandRouterError) => void;
    const cancellation = new Promise<never>((_, reject) => { cancel = reject; });
    const commandScope: CommandScope = {
      source,
      generation: source === "phone" ? this.phoneGeneration : this.globalGeneration,
      globalGeneration: this.globalGeneration,
      started: false,
      cancellation,
      cancel,
    };
    this.scopes.add(commandScope);
    const operation = this.enqueue(async () => {
      this.assertCurrent(commandScope);
      commandScope.started = true;
      this.activeCommand = commandScope;
      try {
        return await this.executeOnce(command, source, commandScope);
      } finally {
        if (this.activeCommand === commandScope) this.activeCommand = null;
      }
    });
    commandScope.operation = operation;
    const exposed = Promise.race([operation, cancellation]);
    void exposed.finally(() => this.scopes.delete(commandScope)).catch(() => undefined);
    return exposed;
  }

  private assertCurrent(scope: CommandScope): void {
    const current = scope.globalGeneration === this.globalGeneration && (
      scope.source !== "phone" || scope.generation === this.phoneGeneration
    );
    if (!current) {
      throw createError(
        "COMMAND_CANCELLED",
        "The command was cancelled because its session ended.",
        "Start a new session and try again.",
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.commandTail.then(operation, operation);
    this.commandTail = next.then(() => undefined, () => undefined);
    return next;
  }
}
