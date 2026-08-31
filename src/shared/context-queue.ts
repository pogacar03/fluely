export interface ContextScreenshot {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  mimeType: "image/png";
  previewUrl: string;
}

export interface ContextQueueState {
  items: ContextScreenshot[];
}

export type ContextQueueAction =
  | { type: "append"; screenshot: ContextScreenshot }
  | { type: "remove"; screenshotId: string }
  | { type: "clear" };

export const MAX_CONTEXT_SCREENSHOTS = 5;
export const EMPTY_CONTEXT_PROMPT = "Analyze the attached screenshots.";
export const CONTEXT_PREVIEW_PREFIX = "fluely-media://context/";
export const MAX_COMPLETED_REQUEST_IDS = 512;

export function contextPreviewUrl(screenshotId: string): string {
  return `${CONTEXT_PREVIEW_PREFIX}${encodeURIComponent(screenshotId)}`;
}

function cloneScreenshot(screenshot: ContextScreenshot): ContextScreenshot {
  return { ...screenshot };
}

export function createContextQueue(items: readonly ContextScreenshot[] = []): ContextQueueState {
  return {
    items: items
      .slice(-MAX_CONTEXT_SCREENSHOTS)
      .map(cloneScreenshot),
  };
}

export function contextQueueReducer(
  state: ContextQueueState,
  action: ContextQueueAction,
): ContextQueueState {
  switch (action.type) {
    case "append":
      return createContextQueue([...state.items, action.screenshot]);
    case "remove":
      return createContextQueue(state.items.filter((item) => item.id !== action.screenshotId));
    case "clear":
      return createContextQueue();
  }
}

export function appendContextScreenshot(
  state: ContextQueueState,
  screenshot: ContextScreenshot,
): ContextQueueState {
  return contextQueueReducer(state, { type: "append", screenshot });
}

export function removeContextScreenshot(
  state: ContextQueueState,
  screenshotId: string,
): ContextQueueState {
  return contextQueueReducer(state, { type: "remove", screenshotId });
}

export function clearContextQueue(_state: ContextQueueState): ContextQueueState {
  return contextQueueReducer(_state, { type: "clear" });
}

export function selectQueuedScreenshots(
  state: ContextQueueState | readonly ContextScreenshot[],
): ContextScreenshot[] {
  const items = "items" in state ? state.items : state;
  return items.map(cloneScreenshot);
}

export function normalizeContextPrompt(prompt: unknown): string {
  if (typeof prompt !== "string") {
    return EMPTY_CONTEXT_PROMPT;
  }
  const normalized = prompt.trim();
  return normalized || EMPTY_CONTEXT_PROMPT;
}

export class DuplicateRequestIdError extends Error {
  public constructor(requestId: string) {
    super(`Request ID ${requestId} is already used for a different command.`);
    this.name = "DuplicateRequestIdError";
  }
}

export interface WorkspaceRequestIdFactory {
  next(action: string): string;
}

export type RendererSessionNonceFactory = () => string;

function createRendererSessionNonce(): string {
  return globalThis.crypto.randomUUID();
}

/** Creates request IDs that cannot collide with IDs from a previous renderer session. */
export function createWorkspaceRequestIdFactory(
  nonceFactory: RendererSessionNonceFactory = createRendererSessionNonce,
): WorkspaceRequestIdFactory {
  const sessionNonce = nonceFactory();
  let sequence = 0;

  return {
    next(action) {
      sequence += 1;
      return `desktop-${sessionNonce}-${action}-${sequence}`;
    },
  };
}

export interface RequestIdDeduper<T> {
  run(requestId: string, fingerprint: string, operation: () => Promise<T> | T): Promise<T>;
  clear(): void;
}

interface RequestEntry<T> {
  fingerprint: string;
  promise: Promise<T>;
  completed: boolean;
}

/** Coalesces retries while rejecting accidental request-id reuse for another action. */
export function createRequestIdDeduper<T>(): RequestIdDeduper<T> {
  const entries = new Map<string, RequestEntry<T>>();
  const completedRequestIds: string[] = [];

  function markCompleted(requestId: string, entry: RequestEntry<T>): void {
    if (entries.get(requestId) !== entry || entry.completed) {
      return;
    }

    entry.completed = true;
    completedRequestIds.push(requestId);
    while (completedRequestIds.length > MAX_COMPLETED_REQUEST_IDS) {
      const oldestRequestId = completedRequestIds.shift();
      if (oldestRequestId) {
        const oldestEntry = entries.get(oldestRequestId);
        if (oldestEntry?.completed) {
          entries.delete(oldestRequestId);
        }
      }
    }
  }

  return {
    run(requestId, fingerprint, operation) {
      const existing = entries.get(requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return Promise.reject(new DuplicateRequestIdError(requestId));
        }
        return existing.promise;
      }

      const promise = Promise.resolve().then(operation);
      const entry = { fingerprint, promise, completed: false };
      entries.set(requestId, entry);
      void promise.then(
        () => markCompleted(requestId, entry),
        () => markCompleted(requestId, entry),
      );
      return promise;
    },
    clear() {
      entries.clear();
      completedRequestIds.length = 0;
    },
  };
}
