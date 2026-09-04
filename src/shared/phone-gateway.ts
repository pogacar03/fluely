import type {
  CommandResult,
  ConversationEvent,
  SessionProjectionSnapshot,
} from "./conversation";

export interface PhoneGatewaySettings {
  enabled: boolean;
}

export type PhoneGatewayStatus =
  | { state: "disabled" }
  | { state: "starting" }
  | {
    state: "ready";
    origin: string;
    qrDataUrl: string;
    pairingExpiresAt: number;
    paired: boolean;
  }
  | {
    state: "error";
    code: "no_lan_address" | "port_unavailable" | "start_failed";
    message: string;
  };

export type PhoneGatewayStatusListener = (status: PhoneGatewayStatus) => void;

export const PHONE_GATEWAY_PAIRING_TTL_MS = 120_000;

export const PHONE_GATEWAY_PORTS = [
  4123, 4124, 4125, 4126, 4127, 4128,
  4129, 4130, 4131, 4132, 4133, 4134,
] as const;

export const PHONE_GATEWAY_MAX_FRAME_BYTES = 16 * 1024;
export const PHONE_GATEWAY_MAX_REQUEST_ID_BYTES = 128;

export type ServerFrame =
  | { type: "snapshot"; revision: number; payload: SessionProjectionSnapshot }
  | { type: "event"; revision: number; payload: ConversationEvent }
  | { type: "ack"; requestId: string; result: CommandResult }
  | { type: "error"; requestId?: string; code: string; message: string }
  | { type: "pong"; at: number };

export type ClientFrame =
  | { type: "resync"; requestId: string; afterRevision: number }
  | { type: "ping"; at: number };

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= PHONE_GATEWAY_MAX_REQUEST_ID_BYTES;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parses only the B2 read-only client frame union; B3 commands are intentionally rejected. */
export function parsePhoneClientFrame(input: string | Uint8Array): ClientFrame | null {
  let text: string;
  try {
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).byteLength > PHONE_GATEWAY_MAX_FRAME_BYTES) {
        return null;
      }
      text = input;
    } else {
      if (input.byteLength > PHONE_GATEWAY_MAX_FRAME_BYTES) {
        return null;
      }
      text = new TextDecoder().decode(input);
    }
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const frame = value as Record<string, unknown>;
    if (frame.type === "ping" && hasExactKeys(frame, ["type", "at"]) && isTimestamp(frame.at)) {
      return { type: "ping", at: frame.at };
    }
    if (
      frame.type === "resync" &&
      hasExactKeys(frame, ["type", "requestId", "afterRevision"]) &&
      isRequestId(frame.requestId) &&
      isRevision(frame.afterRevision)
    ) {
      return {
        type: "resync",
        requestId: frame.requestId,
        afterRevision: frame.afterRevision,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializePhoneServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export const DEFAULT_PHONE_GATEWAY_SETTINGS: PhoneGatewaySettings = {
  enabled: false,
};
