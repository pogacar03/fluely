import {
  ConversationModel,
  type ConversationAttachment,
  type ConversationEvent,
  type ConversationMessage,
  type ConversationModelOptions,
  type ConversationPort,
  type ConversationSnapshot,
} from "../../src/shared/conversation";

export interface ConversationAttachmentCleanupPort {
  deleteUnreferenced(
    candidateIds: readonly string[],
    referencedIds: ReadonlySet<string> | readonly string[],
  ): Promise<string[]>;
}

export interface ConversationStoreOptions extends ConversationModelOptions {
  attachmentStore?: ConversationAttachmentCleanupPort;
}

/** Main-process owner for the session conversation and its attachment refs. */
export class ConversationStore implements ConversationPort {
  private readonly model: ConversationModel;
  private readonly attachmentStore?: ConversationAttachmentCleanupPort;
  private cleanupTail: Promise<void> = Promise.resolve();

  public constructor(options: ConversationStoreOptions) {
    this.model = new ConversationModel(options);
    this.attachmentStore = options.attachmentStore;
    this.model.subscribe((event) => this.handleModelEvent(event));
  }

  public snapshot(): ConversationSnapshot {
    return this.model.snapshot();
  }

  public subscribe(listener: (event: ConversationEvent) => void): () => void {
    return this.model.subscribe(listener);
  }

  public addAttachment(attachment: ConversationAttachment): ConversationAttachment {
    return this.model.addAttachment(attachment);
  }

  public startTurn(prompt: string, attachmentIds: readonly string[] = []): {
    user: ConversationMessage;
    assistant: ConversationMessage;
  } {
    return this.model.startTurn(prompt, attachmentIds);
  }

  public updateAssistant(
    messageId: string,
    text: string,
    status: "pending" | "streaming" = "streaming",
  ): ConversationMessage {
    return this.model.updateAssistant(messageId, text, status);
  }

  public finishAssistant(
    messageId: string,
    status: "completed" | "error" | "cancelled",
    text?: string,
    error?: { code: string; message: string },
  ): ConversationMessage {
    return this.model.finishAssistant(messageId, status, text, error);
  }

  public async clear(): Promise<void> {
    const attachmentIds = this.model.snapshot().attachments.map((attachment) => attachment.id);
    this.model.clear();
    this.enqueueCleanup(attachmentIds, new Set());
    await this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    await this.cleanupTail;
  }

  public async dispose(): Promise<void> {
    await this.clear();
    const disposable = this.attachmentStore as (ConversationAttachmentCleanupPort & { dispose?: () => Promise<void> }) | undefined;
    await disposable?.dispose?.();
  }

  private handleModelEvent(event: ConversationEvent): void {
    if (event.type !== "turn-evicted") {
      return;
    }
    const referencedIds = new Set(this.model.snapshot().attachments.map((attachment) => attachment.id));
    this.enqueueCleanup(event.attachmentIds, referencedIds);
  }

  private enqueueCleanup(candidateIds: readonly string[], referencedIds: ReadonlySet<string>): void {
    if (!this.attachmentStore) {
      return;
    }
    this.cleanupTail = this.cleanupTail
      .then(() => this.attachmentStore!.deleteUnreferenced(candidateIds, referencedIds))
      .then(() => undefined, () => undefined);
  }
}
