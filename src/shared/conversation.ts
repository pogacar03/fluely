import { contextPreviewUrl, type ContextScreenshot } from "./context-queue";
import type {
  AnalysisState,
  ScreenshotState,
  WorkspaceCommand,
} from "./ipc";

export type MessageRole = "user" | "assistant" | "system";

export type MessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "error"
  | "cancelled";

export interface ConversationAttachment {
  id: string;
  mimeType: "image/png";
  width: number;
  height: number;
  byteLength: number;
  createdAt: number;
}

export interface ConversationMessage {
  id: string;
  sequence: number;
  role: MessageRole;
  text: string;
  attachmentIds: string[];
  status: MessageStatus;
  createdAt: number;
  finishedAt?: number;
  error?: { code: string; message: string };
}

export interface ConversationSnapshot {
  sessionId: string;
  revision: number;
  messages: ConversationMessage[];
  attachments: ConversationAttachment[];
  activeMessageId?: string;
}

export type ConversationEventListener = (event: ConversationEvent) => void;

export interface SessionProjectionSnapshot {
  /** Monotonic across both conversation and working-queue projection events. */
  revision: number;
  conversation: ConversationSnapshot;
  queue: ContextScreenshot[];
  capturing?: boolean;
}

export interface ConversationPort {
  snapshot(): ConversationSnapshot;
  subscribe(listener: ConversationEventListener): () => void;
}

export type SessionProjectionEvent =
  | {
    type: "conversation";
    revision: number;
    event: ConversationEvent;
  }
  | {
    type: "queue-changed";
    revision: number;
    queue: ContextScreenshot[];
    capturing?: boolean;
  };

export type SessionProjectionEventListener = (event: SessionProjectionEvent) => void;

/** Stable Plan B read/event boundary; it does not expose Electron services or paths. */
export interface SessionProjectionPort {
  getSnapshot(): SessionProjectionSnapshot;
  subscribe(listener: SessionProjectionEventListener): () => void;
}

export interface ConversationProjection {
  snapshot(): ConversationSnapshot;
  replace(snapshot: ConversationSnapshot): void;
  apply(event: ConversationEvent): Promise<ConversationEventApplication>;
  whenIdle(): Promise<void>;
}

export interface CommandRouter {
  execute(command: WorkspaceCommand, source: "desktop" | "phone"): Promise<CommandResult>;
}

export interface CommandResult {
  queue: ScreenshotState;
  conversation: ConversationSnapshot;
  analysis?: AnalysisState;
}

export type ConversationEvent =
  | {
    type: "attachment-added";
    revision: number;
    activeMessageId: string | null;
    attachment: ConversationAttachment;
  }
  | {
    type: "message-added";
    revision: number;
    activeMessageId: string | null;
    message: ConversationMessage;
  }
  | {
    type: "message-updated";
    revision: number;
    activeMessageId: string | null;
    message: ConversationMessage;
  }
  | {
    type: "turn-evicted";
    revision: number;
    activeMessageId: string | null;
    messageIds: string[];
    attachmentIds: string[];
    snapshot: ConversationSnapshot;
  }
  | {
    type: "cleared";
    revision: number;
    activeMessageId: null;
    snapshot: ConversationSnapshot;
  };

const PROJECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function cloneProjectionScreenshot(item: ContextScreenshot): ContextScreenshot | null {
  if (!item || typeof item.id !== "string" || !PROJECTION_ID_PATTERN.test(item.id)) {
    return null;
  }

  return {
    id: item.id,
    capturedAt: item.capturedAt,
    width: item.width,
    height: item.height,
    mimeType: "image/png",
    previewUrl: contextPreviewUrl(item.id),
  };
}

function cloneProjectionQueue(items: readonly ContextScreenshot[]): ContextScreenshot[] {
  return items
    .map(cloneProjectionScreenshot)
    .filter((item): item is ContextScreenshot => item !== null);
}

export function cloneSessionProjectionSnapshot(snapshot: SessionProjectionSnapshot): SessionProjectionSnapshot {
  return {
    revision: snapshot.revision,
    conversation: cloneConversationSnapshot(snapshot.conversation),
    queue: cloneProjectionQueue(snapshot.queue),
    ...(typeof snapshot.capturing === "boolean" ? { capturing: snapshot.capturing } : {}),
  };
}

export function cloneSessionProjectionEvent(event: SessionProjectionEvent): SessionProjectionEvent {
  if (event.type === "conversation") {
    return {
      type: "conversation",
      revision: event.revision,
      event: cloneConversationEvent(event.event),
    };
  }

  return {
    type: "queue-changed",
    revision: event.revision,
    queue: cloneProjectionQueue(event.queue),
    ...(typeof event.capturing === "boolean" ? { capturing: event.capturing } : {}),
  };
}

function cloneConversationEvent(event: ConversationEvent): ConversationEvent {
  if (event.type === "attachment-added") {
    return { ...event, attachment: cloneAttachment(event.attachment) };
  }
  if (event.type === "message-added" || event.type === "message-updated") {
    return { ...event, message: cloneMessage(event.message) };
  }
  if (event.type === "cleared") {
    return { ...event, snapshot: cloneConversationSnapshot(event.snapshot) };
  }
  return {
    ...event,
    messageIds: [...event.messageIds],
    attachmentIds: [...event.attachmentIds],
    snapshot: cloneConversationSnapshot(event.snapshot),
  };
}

export type SessionProjectionEventApplicationStatus = "applied" | "duplicate" | "gap";

export interface SessionProjectionEventApplication {
  status: SessionProjectionEventApplicationStatus;
  snapshot: SessionProjectionSnapshot;
}

/** Applies one ordered projection event; a gap tells reconnecting clients to fetch a snapshot. */
export function applySessionProjectionEvent(
  current: SessionProjectionSnapshot,
  event: SessionProjectionEvent,
): SessionProjectionEventApplication {
  const snapshot = cloneSessionProjectionSnapshot(current);
  if (event.revision <= snapshot.revision) {
    return { status: "duplicate", snapshot };
  }
  if (event.revision !== snapshot.revision + 1) {
    return { status: "gap", snapshot };
  }

  if (event.type === "conversation") {
    const conversation = applyConversationEvent(snapshot.conversation, event.event);
    if (conversation.status === "gap") {
      return { status: "gap", snapshot };
    }
    snapshot.conversation = conversation.snapshot;
  } else {
    snapshot.queue = cloneProjectionQueue(event.queue);
    if (typeof event.capturing === "boolean") {
      snapshot.capturing = event.capturing;
    }
  }
  snapshot.revision = event.revision;
  return { status: "applied", snapshot };
}

export type ConversationEventApplicationStatus = "applied" | "duplicate" | "gap";

export interface ConversationEventApplication {
  status: ConversationEventApplicationStatus;
  snapshot: ConversationSnapshot;
}

export interface ConversationModelOptions {
  sessionId: string;
  now?: () => number | Date;
  idFactory?: () => string;
  maxMessages?: number;
  maxAttachmentBytes?: number;
}

interface ConversationTurn {
  userMessageId: string;
  assistantMessageId: string;
  attachmentIds: string[];
}

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

function normalizeTimestamp(value: number | Date | undefined): number {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : Date.now();
  }
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function cloneAttachment(attachment: ConversationAttachment): ConversationAttachment {
  return { ...attachment };
}

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return {
    ...message,
    attachmentIds: [...message.attachmentIds],
    ...(message.error ? { error: { ...message.error } } : {}),
  };
}

export function cloneConversationSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    messages: snapshot.messages.map(cloneMessage),
    attachments: snapshot.attachments.map(cloneAttachment),
    ...(snapshot.activeMessageId ? { activeMessageId: snapshot.activeMessageId } : {}),
  };
}

export function createConversationSnapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    revision: 0,
    messages: [],
    attachments: [],
  };
}

function activeValue(activeMessageId: string | undefined): string | null {
  return activeMessageId ?? null;
}

function messageIsTerminal(message: ConversationMessage | undefined): boolean {
  return message?.status === "completed" || message?.status === "error" || message?.status === "cancelled";
}

function messageIndex(messages: readonly ConversationMessage[], id: string): number {
  return messages.findIndex((message) => message.id === id);
}

/**
 * Applies one canonical event to a renderer/phone snapshot. Events are
 * accepted only in strict revision order; callers must resync on a gap.
 */
export function applyConversationEvent(
  current: ConversationSnapshot,
  event: ConversationEvent,
): ConversationEventApplication {
  const snapshot = cloneConversationSnapshot(current);
  if (event.revision <= snapshot.revision) {
    return { status: "duplicate", snapshot };
  }
  if (event.revision !== snapshot.revision + 1) {
    return { status: "gap", snapshot };
  }

  if (event.type === "cleared" || event.type === "turn-evicted") {
    const next = cloneConversationSnapshot(event.snapshot);
    next.revision = event.revision;
    if (event.activeMessageId) {
      next.activeMessageId = event.activeMessageId;
    } else {
      delete next.activeMessageId;
    }
    return { status: "applied", snapshot: next };
  }

  if (event.type === "attachment-added") {
    const existingIndex = snapshot.attachments.findIndex((attachment) => attachment.id === event.attachment.id);
    if (existingIndex >= 0) {
      snapshot.attachments[existingIndex] = cloneAttachment(event.attachment);
    } else {
      snapshot.attachments.push(cloneAttachment(event.attachment));
    }
  } else if (event.type === "message-added") {
    const existingIndex = messageIndex(snapshot.messages, event.message.id);
    if (existingIndex >= 0) {
      snapshot.messages[existingIndex] = cloneMessage(event.message);
    } else {
      snapshot.messages.push(cloneMessage(event.message));
      snapshot.messages.sort((left, right) => left.sequence - right.sequence);
    }
  } else if (event.type === "message-updated") {
    const existingIndex = messageIndex(snapshot.messages, event.message.id);
    if (existingIndex >= 0) {
      snapshot.messages[existingIndex] = cloneMessage(event.message);
    } else {
      snapshot.messages.push(cloneMessage(event.message));
      snapshot.messages.sort((left, right) => left.sequence - right.sequence);
    }
  }

  snapshot.revision = event.revision;
  if (event.activeMessageId) {
    snapshot.activeMessageId = event.activeMessageId;
  } else {
    delete snapshot.activeMessageId;
  }
  return { status: "applied", snapshot };
}

/**
 * Serializes renderer/phone event application and replaces a stale projection
 * with a fresh canonical snapshot when a revision is missed.
 */
export function createConversationProjection(
  initial: ConversationSnapshot,
  readSnapshot: () => Promise<ConversationSnapshot>,
): ConversationProjection {
  let state = cloneConversationSnapshot(initial);
  let tail: Promise<void> = Promise.resolve();

  const applyOne = async (event: ConversationEvent): Promise<ConversationEventApplication> => {
    const result = applyConversationEvent(state, event);
    if (result.status !== "gap") {
      state = result.snapshot;
      return { status: result.status, snapshot: cloneConversationSnapshot(state) };
    }

    const fresh = cloneConversationSnapshot(await readSnapshot());
    if (fresh.sessionId === state.sessionId && fresh.revision >= state.revision) {
      state = fresh;
    }
    return { status: "gap", snapshot: cloneConversationSnapshot(state) };
  };

  return {
    snapshot: () => cloneConversationSnapshot(state),
    replace(snapshot) {
      const next = cloneConversationSnapshot(snapshot);
      if (next.sessionId === state.sessionId && next.revision >= state.revision) {
        state = next;
      }
    },
    apply(event) {
      const operation = tail.then(() => applyOne(event), () => applyOne(event));
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    whenIdle: () => tail,
  };
}

/**
 * In-memory canonical conversation model. Electron's ConversationStore owns
 * the instance; this class contains no filesystem or renderer concerns.
 */
export class ConversationModel implements ConversationPort {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly maxMessages: number;
  private readonly maxAttachmentBytes: number;
  private readonly listeners = new Set<ConversationEventListener>();
  private readonly turns: ConversationTurn[] = [];
  private state: ConversationSnapshot;
  private nextSequence = 0;

  public constructor(options: ConversationModelOptions) {
    if (!options || typeof options.sessionId !== "string" || options.sessionId.length === 0) {
      throw new Error("ConversationModel requires a session ID.");
    }
    this.state = createConversationSnapshot(options.sessionId);
    this.now = () => normalizeTimestamp(options.now?.());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.maxMessages = Math.max(1, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES));
    this.maxAttachmentBytes = Math.max(1, Math.floor(options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES));
  }

  public snapshot(): ConversationSnapshot {
    return cloneConversationSnapshot(this.state);
  }

  public subscribe(listener: ConversationEventListener): () => void {
    this.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.listeners.delete(listener);
    };
  }

  public addAttachment(attachment: ConversationAttachment): ConversationAttachment {
    const copy = this.validateNewAttachment(
      attachment,
      new Set(this.state.attachments.map((candidate) => candidate.id)),
    );
    this.state.attachments.push(copy);
    this.emit({
      type: "attachment-added",
      revision: this.nextRevision(),
      activeMessageId: activeValue(this.state.activeMessageId),
      attachment: copy,
    });
    this.evictIfNeeded();
    return cloneAttachment(copy);
  }

  public addAttachmentsAndStartTurn(
    prompt: string,
    attachments: readonly ConversationAttachment[],
  ): {
    user: ConversationMessage;
    assistant: ConversationMessage;
  } {
    const knownIds = new Set(this.state.attachments.map((attachment) => attachment.id));
    const copies = attachments.map((attachment) => {
      const copy = this.validateNewAttachment(attachment, knownIds);
      knownIds.add(copy.id);
      return copy;
    });
    return this.commitTurn(prompt, copies, copies.map((attachment) => attachment.id));
  }

  public startTurn(prompt: string, attachmentIds: readonly string[] = []): {
    user: ConversationMessage;
    assistant: ConversationMessage;
  } {
    const normalizedAttachmentIds = [...new Set(attachmentIds)];
    if (normalizedAttachmentIds.some((id) => !this.state.attachments.some((attachment) => attachment.id === id))) {
      throw new Error("Conversation messages may reference registered attachments only.");
    }

    return this.commitTurn(prompt, [], normalizedAttachmentIds);
  }

  private validateNewAttachment(
    attachment: ConversationAttachment,
    knownIds: ReadonlySet<string>,
  ): ConversationAttachment {
    if (!attachment || typeof attachment.id !== "string" || attachment.id.length === 0) {
      throw new Error("Conversation attachments require an opaque ID.");
    }
    if (attachment.mimeType !== "image/png") {
      throw new Error("Conversation attachments must be PNG images.");
    }
    if (!Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0) {
      throw new Error("Conversation attachments require a valid byte length.");
    }
    if (knownIds.has(attachment.id)) {
      throw new Error("Conversation attachment IDs must be unique.");
    }
    return cloneAttachment(attachment);
  }

  private commitTurn(
    prompt: string,
    attachments: readonly ConversationAttachment[],
    attachmentIds: readonly string[],
  ): {
    user: ConversationMessage;
    assistant: ConversationMessage;
  } {
    if (this.state.activeMessageId) {
      throw new Error("A conversation turn is already active.");
    }

    const normalizedAttachmentIds = [...new Set(attachmentIds)];
    const registeredIds = new Set([
      ...this.state.attachments.map((attachment) => attachment.id),
      ...attachments.map((attachment) => attachment.id),
    ]);
    if (normalizedAttachmentIds.length !== attachmentIds.length ||
      normalizedAttachmentIds.some((id) => !registeredIds.has(id))) {
      throw new Error("Conversation messages may reference registered attachments only.");
    }

    const createdAt = this.now();
    const nextSequence = this.nextSequence;
    const userId = this.idFactory();
    const assistantId = this.idFactory();
    const user: ConversationMessage = {
      id: userId,
      sequence: nextSequence + 1,
      role: "user",
      text: prompt,
      attachmentIds: normalizedAttachmentIds,
      status: "completed",
      createdAt,
      finishedAt: createdAt,
    };
    const assistant: ConversationMessage = {
      id: assistantId,
      sequence: nextSequence + 2,
      role: "assistant",
      text: "",
      attachmentIds: [],
      status: "streaming",
      createdAt,
    };

    this.nextSequence = nextSequence + 2;
    this.state.attachments.push(...attachments.map(cloneAttachment));
    this.state.messages.push(user, assistant);
    this.state.activeMessageId = assistant.id;
    this.turns.push({
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      attachmentIds: [...normalizedAttachmentIds],
    });
    for (const attachment of attachments) {
      this.emit({
        type: "attachment-added",
        revision: this.nextRevision(),
        activeMessageId: assistant.id,
        attachment: cloneAttachment(attachment),
      });
    }
    this.emit({
      type: "message-added",
      revision: this.nextRevision(),
      activeMessageId: assistant.id,
      message: user,
    });
    this.emit({
      type: "message-added",
      revision: this.nextRevision(),
      activeMessageId: assistant.id,
      message: assistant,
    });
    this.evictIfNeeded();
    return { user: cloneMessage(user), assistant: cloneMessage(assistant) };
  }

  public updateAssistant(
    messageId: string,
    text: string,
    status: "pending" | "streaming" = "streaming",
  ): ConversationMessage {
    const message = this.requireAssistant(messageId);
    if (status !== "pending" && status !== "streaming") {
      throw new Error("Assistant updates must remain non-terminal.");
    }
    const updated = { ...message, text, status };
    this.replaceMessage(updated);
    this.emit({
      type: "message-updated",
      revision: this.nextRevision(),
      activeMessageId: messageId,
      message: updated,
    });
    return cloneMessage(updated);
  }

  public finishAssistant(
    messageId: string,
    status: "completed" | "error" | "cancelled",
    text?: string,
    error?: { code: string; message: string },
  ): ConversationMessage {
    const message = this.requireAssistant(messageId);
    const nextText = text ?? message.text;
    if (status === "completed" && nextText.trim().length === 0) {
      throw new Error("A completed assistant message requires visible answer text.");
    }
    const finishedAt = this.now();
    const updated: ConversationMessage = {
      ...message,
      text: nextText,
      status,
      finishedAt,
      ...(error ? { error: { ...error } } : {}),
    };
    if (!error) {
      delete updated.error;
    }
    this.replaceMessage(updated);
    delete this.state.activeMessageId;
    this.markTurnComplete(messageId);
    this.emit({
      type: "message-updated",
      revision: this.nextRevision(),
      activeMessageId: null,
      message: updated,
    });
    this.evictIfNeeded();
    return cloneMessage(updated);
  }

  public clear(): void {
    this.state = {
      sessionId: this.state.sessionId,
      revision: this.state.revision,
      messages: [],
      attachments: [],
    };
    this.turns.length = 0;
    this.emit({
      type: "cleared",
      revision: this.nextRevision(),
      activeMessageId: null,
      snapshot: this.state,
    });
  }

  private requireAssistant(messageId: string): ConversationMessage {
    const message = this.state.messages.find((candidate) => candidate.id === messageId);
    if (!message || message.role !== "assistant") {
      throw new Error("The requested assistant message does not exist.");
    }
    if (this.state.activeMessageId !== messageId) {
      throw new Error("The requested assistant message is not active.");
    }
    return message;
  }

  private replaceMessage(message: ConversationMessage): void {
    const index = messageIndex(this.state.messages, message.id);
    if (index < 0) {
      throw new Error("The requested conversation message does not exist.");
    }
    this.state.messages[index] = message;
  }

  private markTurnComplete(messageId: string): void {
    const turn = this.turns.find((candidate) => candidate.assistantMessageId === messageId);
    if (!turn) {
      throw new Error("The requested assistant message is not part of a turn.");
    }
  }

  private nextRevision(): number {
    this.state.revision += 1;
    return this.state.revision;
  }

  private attachmentBytes(): number {
    return this.state.attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
  }

  private evictIfNeeded(): void {
    while (this.state.messages.length > this.maxMessages || this.attachmentBytes() > this.maxAttachmentBytes) {
      const candidate = this.turns.find((turn) => {
        const assistant = this.state.messages.find((message) => message.id === turn.assistantMessageId);
        const user = this.state.messages.find((message) => message.id === turn.userMessageId);
        return Boolean(user && assistant && messageIsTerminal(assistant) && assistant.id !== this.state.activeMessageId);
      });
      if (!candidate) {
        return;
      }

      const messageIds = [candidate.userMessageId, candidate.assistantMessageId];
      this.state.messages = this.state.messages.filter((message) => !messageIds.includes(message.id));
      this.turns.splice(this.turns.indexOf(candidate), 1);
      const referenced = new Set(this.state.messages.flatMap((message) => message.attachmentIds));
      const attachmentIds = candidate.attachmentIds.filter((id) => !referenced.has(id));
      this.state.attachments = this.state.attachments.filter((attachment) => !attachmentIds.includes(attachment.id));
      this.emit({
        type: "turn-evicted",
        revision: this.nextRevision(),
        activeMessageId: activeValue(this.state.activeMessageId),
        messageIds,
        attachmentIds,
        snapshot: this.state,
      });
    }
  }

  private emit(event: ConversationEvent): void {
    const copy = event.type === "cleared" || event.type === "turn-evicted"
      ? { ...event, snapshot: cloneConversationSnapshot(event.snapshot) }
      : event.type === "attachment-added"
        ? { ...event, attachment: cloneAttachment(event.attachment) }
        : { ...event, message: cloneMessage(event.message) };
    for (const listener of [...this.listeners]) {
      try {
        listener(copy);
      } catch {
        // Observers cannot break the canonical writer.
      }
    }
  }
}

export type { WorkspaceCommand };
