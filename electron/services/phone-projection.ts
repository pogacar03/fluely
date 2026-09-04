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

export function phoneContextUrl(screenshotId: string): string {
  return `/api/context/${encodeURIComponent(screenshotId)}`;
}

export function phoneAttachmentUrl(attachmentId: string): string {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`;
}

function mapPhoneQueue(snapshot: SessionProjectionSnapshot): SessionProjectionSnapshot {
  return {
    ...snapshot,
    queue: snapshot.queue.map((item) => ({
      ...item,
      previewUrl: phoneContextUrl(item.id),
    })),
  };
}

export function toPhoneProjectionSnapshot(snapshot: SessionProjectionSnapshot): SessionProjectionSnapshot {
  return mapPhoneQueue(cloneSessionProjectionSnapshot(snapshot));
}

export function toPhoneProjectionEvent(event: SessionProjectionEvent): SessionProjectionEvent {
  const cloned = cloneSessionProjectionEvent(event);
  if (cloned.type === "conversation") {
    return cloned;
  }
  return {
    ...cloned,
    queue: cloned.queue.map((item) => ({
      ...item,
      previewUrl: phoneContextUrl(item.id),
    })),
  };
}

/**
 * Adapts Plan A's projection boundary for the phone channel. It owns no
 * conversation or queue state and exposes no managed filesystem paths.
 */
export function createPhoneProjection(source: SessionProjectionPort): PhoneProjectionPort {
  return {
    getSnapshot: () => toPhoneProjectionSnapshot(source.getSnapshot()),
    subscribe(listener) {
      return source.subscribe((event) => listener(toPhoneProjectionEvent(event)));
    },
  };
}
