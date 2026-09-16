import type { ScreenshotState } from "../../src/shared/ipc";
import {
  applyConversationEvent,
  cloneConversationSnapshot,
  cloneSessionProjectionEvent,
  cloneSessionProjectionSnapshot,
  type ConversationEvent,
  type ConversationPort,
  type SessionProjectionEvent,
  type SessionProjectionPort,
  type SessionProjectionSnapshot,
} from "../../src/shared/conversation";

export interface SessionProjectionQueuePort {
  getState(): ScreenshotState;
  onStateChanged(listener: (state: ScreenshotState) => void): () => void;
}

export interface SessionProjectionStoreOptions {
  conversation: ConversationPort;
  queue: SessionProjectionQueuePort;
}

/** Adapts main-process sources to the Plan B projection boundary without exposing their concrete types. */
export class SessionProjectionStore implements SessionProjectionPort {
  private readonly listeners = new Set<(event: SessionProjectionEvent) => void>();
  private readonly conversation: ConversationPort;
  private readonly removeConversationListener: () => void;
  private readonly removeQueueListener: () => void;
  private state: SessionProjectionSnapshot;
  private disposed = false;

  public constructor(options: SessionProjectionStoreOptions) {
    this.conversation = options.conversation;
    const initialConversation = options.conversation.snapshot();
    const initialQueue = options.queue.getState();
    this.state = cloneSessionProjectionSnapshot({
      revision: initialConversation.revision,
      conversation: initialConversation,
      queue: initialQueue.items,
      capturing: initialQueue.capturing,
    });
    this.removeConversationListener = options.conversation.subscribe((event) => this.handleConversationEvent(event));
    this.removeQueueListener = options.queue.onStateChanged((state) => this.handleQueueState(state));
  }

  public getSnapshot(): SessionProjectionSnapshot {
    return cloneSessionProjectionSnapshot(this.state);
  }

  public subscribe(listener: (event: SessionProjectionEvent) => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
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

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeConversationListener();
    this.removeQueueListener();
    this.listeners.clear();
  }

  private handleConversationEvent(event: ConversationEvent): void {
    if (this.disposed) {
      return;
    }

    const applied = applyConversationEvent(this.state.conversation, event);
    const conversation = applied.status === "gap"
      ? cloneConversationSnapshot(this.conversation.snapshot())
      : applied.snapshot;
    const revision = this.state.revision + 1;
    this.state = {
      revision,
      conversation,
      queue: this.state.queue.map((item) => ({ ...item })),
      ...(typeof this.state.capturing === "boolean" ? { capturing: this.state.capturing } : {}),
    };
    this.emit({ type: "conversation", revision, event });
  }

  private handleQueueState(nextState: ScreenshotState): void {
    if (this.disposed) {
      return;
    }

    const next = cloneSessionProjectionSnapshot({
      revision: this.state.revision,
      conversation: this.state.conversation,
      queue: nextState.items,
      capturing: nextState.capturing,
    });
    if (sameQueue(this.state.queue, next.queue) && this.state.capturing === next.capturing) {
      return;
    }

    const revision = this.state.revision + 1;
    this.state = {
      revision,
      conversation: this.state.conversation,
      queue: next.queue,
      capturing: next.capturing,
    };
    this.emit({ type: "queue-changed", revision, queue: next.queue, capturing: next.capturing });
  }

  private emit(event: SessionProjectionEvent): void {
    const listeners = [...this.listeners];
    for (const listener of listeners) {
      try {
        listener(cloneSessionProjectionEvent(event));
      } catch {
        // One projection client must not break canonical source mutations.
      }
    }
  }
}

function sameQueue(left: readonly SessionProjectionSnapshot["queue"][number][], right: readonly SessionProjectionSnapshot["queue"][number][]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => {
    const other = right[index];
    return item.id === other.id &&
      item.capturedAt === other.capturedAt &&
      item.width === other.width &&
      item.height === other.height &&
      item.mimeType === other.mimeType &&
      item.previewUrl === other.previewUrl;
  });
}
