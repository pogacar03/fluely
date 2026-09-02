const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_FAILURES_PER_ADDRESS = 5;
const DEFAULT_MAX_FAILURES_GLOBAL = 20;
const DEFAULT_MAX_TRACKED_ADDRESSES = 256;

export interface PairingFailureRateLimitOptions {
  now?: () => number;
  windowMs?: number;
  maxFailuresPerAddress?: number;
  maxFailuresGlobal?: number;
  maxTrackedAddresses?: number;
}

export interface PairingFailureLimiter {
  allow(remoteAddress: string): boolean;
  recordFailure(remoteAddress: string): void;
  recordSuccess(): void;
  reset(): void;
}

interface AddressFailures {
  count: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Fixed-window pairing failure limiter with bounded per-address bookkeeping. */
export function createPairingFailureLimiter(
  options: PairingFailureRateLimitOptions = {},
): PairingFailureLimiter {
  const now = options.now ?? Date.now;
  const windowMs = positiveInteger(options.windowMs, DEFAULT_WINDOW_MS);
  const maxFailuresPerAddress = positiveInteger(
    options.maxFailuresPerAddress,
    DEFAULT_MAX_FAILURES_PER_ADDRESS,
  );
  const maxFailuresGlobal = positiveInteger(
    options.maxFailuresGlobal,
    DEFAULT_MAX_FAILURES_GLOBAL,
  );
  const maxTrackedAddresses = positiveInteger(
    options.maxTrackedAddresses,
    DEFAULT_MAX_TRACKED_ADDRESSES,
  );

  let windowStartedAt = now();
  let globalFailures = 0;
  const failuresByAddress = new Map<string, AddressFailures>();

  function rotateWindow(currentTime: number): void {
    if (currentTime < windowStartedAt + windowMs) {
      return;
    }
    windowStartedAt = currentTime;
    globalFailures = 0;
    failuresByAddress.clear();
  }

  function refreshWindow(): void {
    rotateWindow(now());
  }

  function allow(remoteAddress: string): boolean {
    refreshWindow();
    const addressFailures = failuresByAddress.get(remoteAddress)?.count ?? 0;
    return globalFailures < maxFailuresGlobal && addressFailures < maxFailuresPerAddress;
  }

  function recordFailure(remoteAddress: string): void {
    refreshWindow();
    if (globalFailures >= maxFailuresGlobal) {
      return;
    }

    const existing = failuresByAddress.get(remoteAddress);
    if (existing) {
      existing.count += 1;
    } else {
      if (failuresByAddress.size >= maxTrackedAddresses) {
        const oldest = failuresByAddress.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          failuresByAddress.delete(oldest);
        }
      }
      failuresByAddress.set(remoteAddress, { count: 1 });
    }
    globalFailures += 1;
  }

  function reset(): void {
    globalFailures = 0;
    failuresByAddress.clear();
    windowStartedAt = now();
  }

  return {
    allow,
    recordFailure,
    recordSuccess: reset,
    reset,
  };
}
