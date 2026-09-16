import {
  cloneConversationSnapshot,
  createConversationProjection,
  type ConversationEvent,
  type ConversationProjection,
  type ConversationSnapshot,
} from "../shared/conversation";

export type ConversationHydrationStatus = "pending" | "hydrated" | "unavailable";

export interface ConversationHydrationState {
  status: ConversationHydrationStatus;
  attempts: number;
}

export interface ConversationHydrationCoordinatorOptions {
  initial?: ConversationSnapshot;
  readSnapshot: () => Promise<ConversationSnapshot>;
  onSnapshot?: (snapshot: ConversationSnapshot) => void;
  onUnavailable?: (error: unknown) => void;
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
}

export interface ConversationHydrationCoordinator {
  getState(): ConversationHydrationState;
  snapshot(): ConversationSnapshot | null;
  promote(snapshot: ConversationSnapshot): void;
  retryHydration(): Promise<boolean>;
  queueEvent(event: ConversationEvent): Promise<void>;
  whenIdle(): Promise<void>;
}

const DEFAULT_RETRY_DELAYS_MS = [0, 25, 100] as const;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Owns renderer conversation hydration and event ordering. A command result
 * can promote the coordinator even when the initial read failed, while event
 * resync remains bounded and leaves a terminal unavailable state for the UI.
 */
export function createConversationHydrationCoordinator(
  options: ConversationHydrationCoordinatorOptions,
): ConversationHydrationCoordinator {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_RETRY_DELAYS_MS.length));
  const retryDelays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let projection: ConversationProjection | null = options.initial
    ? createConversationProjection(options.initial, options.readSnapshot)
    : null;
  let status: ConversationHydrationStatus = options.initial ? "hydrated" : "pending";
  let attempts = 0;
  let pendingEvents: ConversationEvent[] = [];
  let tail: Promise<void> = Promise.resolve();
  let hydrationRetry: Promise<boolean> | null = null;
  let hydrationGeneration = 0;

  const publish = (): void => {
    if (!projection) {
      return;
    }
    try {
      options.onSnapshot?.(projection.snapshot());
    } catch {
      // A renderer observer cannot invalidate the canonical projection.
    }
  };

  const markUnavailable = (error: unknown): void => {
    status = "unavailable";
    try {
      options.onUnavailable?.(error);
    } catch {
      // Error presentation is best effort and must not break retry bookkeeping.
    }
  };

  const applyOne = async (event: ConversationEvent): Promise<void> => {
    if (!projection || status !== "hydrated") {
      pendingEvents.push(event);
      return;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await projection.apply(event);
        publish();
        if (result.status !== "gap" || result.snapshot.revision >= event.revision) {
          return;
        }
      } catch (error) {
        lastError = error;
      }

      if (attempt + 1 < maxAttempts) {
        await sleep(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 0);
      }
    }

    pendingEvents.unshift(event);
    const unavailable = lastError ?? new Error("Conversation resynchronization did not converge.");
    markUnavailable(unavailable);
    throw unavailable;
  };

  const drainPending = (): void => {
    const events = pendingEvents;
    pendingEvents = [];
    for (const event of events) {
      void enqueue(event);
    }
  };

  const enqueue = (event: ConversationEvent): Promise<void> => {
    const operation = tail.then(() => applyOne(event), () => applyOne(event));
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const promote = (snapshot: ConversationSnapshot): void => {
    hydrationGeneration += 1;
    const next = cloneConversationSnapshot(snapshot);
    if (projection && projection.snapshot().sessionId === next.sessionId) {
      projection.replace(next);
    } else {
      projection = createConversationProjection(next, options.readSnapshot);
    }
    status = "hydrated";
    attempts = 0;
    publish();
    drainPending();
  };

  const retryHydration = (): Promise<boolean> => {
    if (status === "hydrated") {
      return Promise.resolve(true);
    }
    if (hydrationRetry) {
      return hydrationRetry;
    }

    const retryGeneration = hydrationGeneration;
    hydrationRetry = (async () => {
      let lastError: unknown;
      status = "pending";
      attempts = 0;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (retryGeneration !== hydrationGeneration) {
          return false;
        }
        attempts = attempt + 1;
        try {
          const snapshot = await options.readSnapshot();
          if (retryGeneration !== hydrationGeneration) {
            return true;
          }
          promote(snapshot);
          return true;
        } catch (error) {
          if (retryGeneration !== hydrationGeneration) {
            return false;
          }
          lastError = error;
        }
        if (attempt + 1 < maxAttempts) {
          await sleep(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 0);
        }
      }
      if (retryGeneration !== hydrationGeneration) {
        return false;
      }
      markUnavailable(lastError ?? new Error("Conversation hydration did not converge."));
      return false;
    })().finally(() => {
      hydrationRetry = null;
    });
    return hydrationRetry;
  };

  return {
    getState: () => ({ status, attempts }),
    snapshot: () => projection?.snapshot() ?? null,
    promote,
    retryHydration,
    queueEvent: (event) => {
      if (status !== "hydrated" || !projection) {
        pendingEvents.push(event);
        return Promise.resolve();
      }
      return enqueue(event);
    },
    whenIdle: () => tail,
  };
}
