import {
  cloneSessionProjectionEvent,
  cloneSessionProjectionSnapshot,
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

function mapPhoneQueue(snapshot: SessionProjectionSnapshot, mediaCapability: string): SessionProjectionSnapshot {
  const capability = requireMediaCapability(mediaCapability);
  return {
    ...snapshot,
    queue: snapshot.queue.map((item) => ({
      ...item,
      previewUrl: phoneContextUrl(item.id, capability),
    })),
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
    return cloned;
  }
  return {
    ...cloned,
    queue: cloned.queue.map((item) => ({
      ...item,
      previewUrl: phoneContextUrl(item.id, mediaCapability),
    })),
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
