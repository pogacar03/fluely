import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import {
  PHONE_GATEWAY_PAIRING_TTL_MS,
} from "../../src/shared/phone-gateway";

const CREDENTIAL_BYTES = 32;
const CREDENTIAL_HEX_LENGTH = CREDENTIAL_BYTES * 2;

export interface PairingRandomBytesSource {
  (size: number): Uint8Array;
}

export interface PairingSessionManagerOptions {
  now?: () => number;
  randomBytes?: PairingRandomBytesSource;
}

export interface PairingSessionManager {
  issue(nowMs?: number): { secret: string; expiresAt: number };
  exchange(secret: string, nowMs?: number): { cookieToken: string } | null;
  authenticate(cookieToken: string): boolean;
  revokeAll(): void;
  isPaired(): boolean;
}

interface PendingPairing {
  secret: Buffer;
  expiresAt: number;
}

function encodeCredential(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function makeCredential(randomBytes: PairingRandomBytesSource): Buffer {
  const bytes = Buffer.from(randomBytes(CREDENTIAL_BYTES));
  if (bytes.length !== CREDENTIAL_BYTES) {
    throw new Error("Credential source returned an invalid length.");
  }
  return bytes;
}

/** Compares fixed-size credential buffers without an early-exit byte comparison. */
export function constantTimeCredentialEqual(
  candidate: string,
  expected: Uint8Array,
): boolean {
  const candidateBuffer = Buffer.alloc(CREDENTIAL_BYTES);
  const decoded = typeof candidate === "string" &&
    new RegExp(`^[0-9a-f]{${CREDENTIAL_HEX_LENGTH}}$`, "i").test(candidate)
    ? Buffer.from(candidate, "hex")
    : Buffer.alloc(0);
  decoded.copy(candidateBuffer, 0, 0, CREDENTIAL_BYTES);

  const expectedBuffer = Buffer.alloc(CREDENTIAL_BYTES);
  Buffer.from(expected).copy(expectedBuffer, 0, 0, CREDENTIAL_BYTES);
  return decoded.length === CREDENTIAL_BYTES && timingSafeEqual(candidateBuffer, expectedBuffer);
}

export function createPairingSessionManager(
  options: PairingSessionManagerOptions = {},
): PairingSessionManager {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? ((size: number) => cryptoRandomBytes(size));
  let pending: PendingPairing | null = null;
  let sessionToken: Buffer | null = null;

  return {
    issue(nowMs = now()) {
      // Issuing a replacement pairing immediately invalidates the existing phone.
      sessionToken = null;
      const secret = makeCredential(randomBytes);
      pending = {
        secret,
        expiresAt: nowMs + PHONE_GATEWAY_PAIRING_TTL_MS,
      };
      return { secret: encodeCredential(secret), expiresAt: pending.expiresAt };
    },

    exchange(secret, nowMs = now()) {
      const current = pending;
      if (!current) {
        return null;
      }
      if (nowMs >= current.expiresAt) {
        pending = null;
        return null;
      }
      if (!constantTimeCredentialEqual(secret, current.secret)) {
        return null;
      }

      const token = makeCredential(randomBytes);
      pending = null;
      sessionToken = token;
      return { cookieToken: encodeCredential(token) };
    },

    authenticate(cookieToken) {
      return sessionToken !== null && constantTimeCredentialEqual(cookieToken, sessionToken);
    },

    revokeAll() {
      pending = null;
      sessionToken = null;
    },

    isPaired() {
      return sessionToken !== null;
    },
  };
}
