import type { ContextScreenshot } from "../../src/shared/context-queue";
import {
  cloneSessionProjectionEvent,
  cloneSessionProjectionSnapshot,
  type ConversationAttachment,
  type ConversationEvent,
  type ConversationMessage,
  type ConversationSnapshot,
  type SessionProjectionEvent,
  type SessionProjectionPort,
  type SessionProjectionSnapshot,
} from "../../src/shared/conversation";

export interface PhoneProjectionPort {
  getSnapshot(): SessionProjectionSnapshot;
  subscribe(listener: (event: SessionProjectionEvent) => void): () => void;
}

export interface PhoneProjectionOptions {
  getMediaCapability: () => string | undefined;
}

const MEDIA_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

function requireMediaCapability(mediaCapability: string | undefined): string {
  if (!mediaCapability || !MEDIA_CAPABILITY_PATTERN.test(mediaCapability)) {
    throw new Error("A current phone media capability is required.");
  }
  return mediaCapability;
}

export function phoneContextUrl(screenshotId: string, mediaCapability: string): string {
  return `/api/context/${requireMediaCapability(mediaCapability)}/${encodeURIComponent(screenshotId)}`;
}

export function phoneAttachmentUrl(attachmentId: string, mediaCapability: string): string {
  return `/api/attachments/${requireMediaCapability(mediaCapability)}/${encodeURIComponent(attachmentId)}`;
}

const SAFE_ANALYSIS_ERROR = {
  code: "ANALYSIS_FAILED",
  message: "Analysis failed.",
} as const;

const SAFE_ANALYSIS_ERRORS: Record<string, { code: string; message: string }> = {
  USAGE_LIMIT: {
    code: "USAGE_LIMIT",
    message: "Codex usage limit reached. Restore your usage or switch to an available model, then retry.",
  },
  AUTHENTICATION_REQUIRED: {
    code: "AUTHENTICATION_REQUIRED",
    message: "Check your Codex login, then retry the request.",
  },
  MODEL_UNAVAILABLE: {
    code: "MODEL_UNAVAILABLE",
    message: "The selected Codex model is unavailable. Choose an available model, then retry.",
  },
  CLI_START_TIMEOUT: {
    code: "CLI_START_TIMEOUT",
    message: "Codex CLI startup timed out. Retry the request.",
  },
  CLI_IDLE_TIMEOUT: {
    code: "CLI_IDLE_TIMEOUT",
    message: "Codex CLI became idle. Retry the request.",
  },
  CLI_HARD_TIMEOUT: {
    code: "CLI_HARD_TIMEOUT",
    message: "Codex CLI timed out. Retry the request.",
  },
};

function safeAnalysisError(error: { code: string; message: string }): { code: string; message: string } {
  return SAFE_ANALYSIS_ERRORS[error.code] ?? SAFE_ANALYSIS_ERROR;
}

function sanitizeAttachment(attachment: ConversationAttachment): ConversationAttachment {
  return {
    id: attachment.id,
    mimeType: "image/png",
    width: attachment.width,
    height: attachment.height,
    byteLength: attachment.byteLength,
    createdAt: attachment.createdAt,
  };
}

function sanitizeMessage(message: ConversationMessage): ConversationMessage {
  const sanitized: ConversationMessage = {
    id: message.id,
    sequence: message.sequence,
    role: message.role,
    text: message.text,
    attachmentIds: [...message.attachmentIds],
    status: message.status,
    createdAt: message.createdAt,
    ...(typeof message.finishedAt === "number" ? { finishedAt: message.finishedAt } : {}),
    ...(message.error ? { error: safeAnalysisError(message.error) } : {}),
  };
  return sanitized;
}

function sanitizeConversation(snapshot: ConversationSnapshot): ConversationSnapshot {
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    messages: snapshot.messages.map(sanitizeMessage),
    attachments: snapshot.attachments.map(sanitizeAttachment),
    ...(typeof snapshot.activeMessageId === "string"
      ? { activeMessageId: snapshot.activeMessageId }
      : {}),
  };
}

function sanitizeQueue(
  items: readonly ContextScreenshot[],
  mediaCapability: string,
): ContextScreenshot[] {
  const capability = requireMediaCapability(mediaCapability);
  return items.map((item) => ({
    id: item.id,
    capturedAt: item.capturedAt,
    width: item.width,
    height: item.height,
    mimeType: "image/png",
    previewUrl: phoneContextUrl(item.id, capability),
  }));
}

function sanitizeConversationEvent(event: ConversationEvent): ConversationEvent {
  if (event.type === "attachment-added") {
    return {
      type: "attachment-added",
      revision: event.revision,
      activeMessageId: event.activeMessageId,
      attachment: sanitizeAttachment(event.attachment),
    };
  }
  if (event.type === "message-added" || event.type === "message-updated") {
    return {
      type: event.type,
      revision: event.revision,
      activeMessageId: event.activeMessageId,
      message: sanitizeMessage(event.message),
    };
  }
  if (event.type === "cleared") {
    return {
      type: "cleared",
      revision: event.revision,
      activeMessageId: null,
      snapshot: sanitizeConversation(event.snapshot),
    };
  }
  return {
    type: "turn-evicted",
    revision: event.revision,
    activeMessageId: event.activeMessageId,
    messageIds: [...event.messageIds],
    attachmentIds: [...event.attachmentIds],
    snapshot: sanitizeConversation(event.snapshot),
  };
}

function mapPhoneQueue(snapshot: SessionProjectionSnapshot, mediaCapability: string): SessionProjectionSnapshot {
  const capability = requireMediaCapability(mediaCapability);
  return {
    revision: snapshot.revision,
    conversation: sanitizeConversation(snapshot.conversation),
    queue: sanitizeQueue(snapshot.queue, capability),
    ...(typeof snapshot.capturing === "boolean" ? { capturing: snapshot.capturing } : {}),
    mediaCapability: capability,
  };
}

export function toPhoneProjectionSnapshot(
  snapshot: SessionProjectionSnapshot,
  mediaCapability: string,
): SessionProjectionSnapshot {
  return mapPhoneQueue(cloneSessionProjectionSnapshot(snapshot), mediaCapability);
}

export function toPhoneProjectionEvent(
  event: SessionProjectionEvent,
  mediaCapability: string,
): SessionProjectionEvent {
  const cloned = cloneSessionProjectionEvent(event);
  if (cloned.type === "conversation") {
    return {
      type: "conversation",
      revision: cloned.revision,
      event: sanitizeConversationEvent(cloned.event),
    };
  }
  return {
    type: "queue-changed",
    revision: cloned.revision,
    queue: sanitizeQueue(cloned.queue, mediaCapability),
    ...(typeof cloned.capturing === "boolean" ? { capturing: cloned.capturing } : {}),
  };
}

/**
 * Adapts Plan A's projection boundary for the phone channel. It owns no
 * conversation or queue state and exposes no managed filesystem paths.
 */
export function createPhoneProjection(
  source: SessionProjectionPort,
  options: PhoneProjectionOptions,
): PhoneProjectionPort {
  const getMediaCapability = options.getMediaCapability;
  return {
    getSnapshot: () => toPhoneProjectionSnapshot(source.getSnapshot(), getMediaCapability() ?? ""),
    subscribe(listener) {
      return source.subscribe((event) => listener(toPhoneProjectionEvent(event, getMediaCapability() ?? "")));
    },
  };
}
