import type {
  ConversationEvent,
  SessionProjectionSnapshot,
} from "./conversation";
import type { WorkspaceCommand } from "./ipc";

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
export const PHONE_GATEWAY_MAX_PROMPT_LENGTH = 3000;
export const PHONE_GATEWAY_COMMAND_RATE_LIMIT = 10;
export const PHONE_GATEWAY_COMMAND_RATE_WINDOW_MS = 10_000;
export const PHONE_GATEWAY_MAX_BUFFERED_AMOUNT_BYTES = 1 * 1024 * 1024;
export const PHONE_GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const PHONE_GATEWAY_HEARTBEAT_MISSES = 2;
export const PHONE_GATEWAY_MAX_COMMAND_SETTLED_IDS = 4_096;
export const PHONE_GATEWAY_MAX_COMMAND_SETTLED_RESPONSE_BYTES = 1_024;
export const PHONE_GATEWAY_COMMAND_FINGERPRINT_BYTES = 64;
/** Maximum serialized payload retained by one settled idempotency record. */
export const PHONE_GATEWAY_MAX_COMMAND_SETTLED_RECORD_BYTES =
  PHONE_GATEWAY_MAX_REQUEST_ID_BYTES +
  PHONE_GATEWAY_COMMAND_FINGERPRINT_BYTES +
  PHONE_GATEWAY_MAX_COMMAND_SETTLED_RESPONSE_BYTES;
/** Exact retained UTF-8 payload budget across all settled records in one session. */
export const PHONE_GATEWAY_MAX_COMMAND_SETTLED_SERIALIZED_BYTES =
  PHONE_GATEWAY_MAX_COMMAND_SETTLED_IDS * PHONE_GATEWAY_MAX_COMMAND_SETTLED_RECORD_BYTES;
/** The rolling command limit is also the hard number of concurrent executions. */
export const PHONE_GATEWAY_MAX_IN_FLIGHT_COMMANDS = PHONE_GATEWAY_COMMAND_RATE_LIMIT;
/** A parsed command cannot exceed the authenticated protocol frame that carried it. */
export const PHONE_GATEWAY_MAX_IN_FLIGHT_COMMAND_SERIALIZED_BYTES = PHONE_GATEWAY_MAX_FRAME_BYTES;
export const PHONE_GATEWAY_MAX_IN_FLIGHT_SERIALIZED_BYTES =
  PHONE_GATEWAY_MAX_IN_FLIGHT_COMMANDS * PHONE_GATEWAY_MAX_IN_FLIGHT_COMMAND_SERIALIZED_BYTES;
/** Bounds socket references retained while one idempotent execution is unresolved. */
export const PHONE_GATEWAY_MAX_IN_FLIGHT_WAITERS_PER_COMMAND = 16;

export type ServerFrame =
  | { type: "snapshot"; revision: number; payload: SessionProjectionSnapshot }
  | { type: "event"; revision: number; payload: ConversationEvent }
  | { type: "ack"; requestId: string }
  | { type: "error"; requestId?: string; code: string; message: string }
  | { type: "pong"; at: number };

export type PhoneCommandFrame = {
  type: "command";
  command: WorkspaceCommand;
};

export type ClientFrame =
  | { type: "resync"; requestId: string; afterRevision: number }
  | { type: "ping"; at: number }
  | PhoneCommandFrame;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    new TextEncoder().encode(value).byteLength <= PHONE_GATEWAY_MAX_REQUEST_ID_BYTES;
}

const SCREENSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isScreenshotId(value: unknown): value is string {
  return typeof value === "string" && SCREENSHOT_ID_PATTERN.test(value);
}

function isPrompt(value: unknown): value is string {
  return typeof value === "string" && value.length <= PHONE_GATEWAY_MAX_PROMPT_LENGTH;
}

function parseWorkspaceCommand(value: unknown): WorkspaceCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const command = value as Record<string, unknown>;
  if (!isRequestId(command.requestId) || typeof command.type !== "string") {
    return null;
  }

  switch (command.type) {
    case "capture":
    case "clear-queue":
    case "clear-conversation":
    case "cancel":
      return hasExactKeys(command, ["type", "requestId"])
        ? { type: command.type, requestId: command.requestId }
        : null;
    case "remove":
      return hasExactKeys(command, ["type", "requestId", "screenshotId"]) && isScreenshotId(command.screenshotId)
        ? { type: "remove", requestId: command.requestId, screenshotId: command.screenshotId }
        : null;
    case "send":
    case "capture-and-send":
      return hasExactKeys(command, ["type", "requestId", "prompt"]) && isPrompt(command.prompt)
        ? { type: command.type, requestId: command.requestId, prompt: command.prompt }
        : null;
    default:
      return null;
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parses the exact phone client frame union at the authenticated gateway boundary. */
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
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
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
    if (frame.type === "command" && hasExactKeys(frame, ["type", "command"])) {
      const command = parseWorkspaceCommand(frame.command);
      return command ? { type: "command", command } : null;
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
