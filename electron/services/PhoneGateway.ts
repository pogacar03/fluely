import { createServer as createHttpServer } from "node:http";
import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import * as QRCode from "qrcode";
import {
  PHONE_GATEWAY_MAX_FRAME_BYTES,
  PHONE_GATEWAY_MAX_BUFFERED_AMOUNT_BYTES,
  PHONE_GATEWAY_HEARTBEAT_INTERVAL_MS,
  PHONE_GATEWAY_HEARTBEAT_MISSES,
  PHONE_GATEWAY_COMMAND_RATE_LIMIT,
  PHONE_GATEWAY_COMMAND_RATE_WINDOW_MS,
  PHONE_GATEWAY_COMMAND_FINGERPRINT_BYTES,
  PHONE_GATEWAY_MAX_COMMAND_SETTLED_IDS,
  PHONE_GATEWAY_MAX_COMMAND_SETTLED_RESPONSE_BYTES,
  PHONE_GATEWAY_MAX_COMMAND_SETTLED_SERIALIZED_BYTES,
  PHONE_GATEWAY_MAX_IN_FLIGHT_COMMANDS,
  PHONE_GATEWAY_MAX_IN_FLIGHT_COMMAND_SERIALIZED_BYTES,
  PHONE_GATEWAY_MAX_IN_FLIGHT_SERIALIZED_BYTES,
  PHONE_GATEWAY_MAX_IN_FLIGHT_WAITERS_PER_COMMAND,
  parsePhoneClientFrame,
  PHONE_GATEWAY_PAIRING_TTL_MS,
  PHONE_GATEWAY_PORTS,
  serializePhoneServerFrame,
  type ServerFrame,
  type PhoneGatewayStatusListener,
  type PhoneGatewayStatus,
} from "../../src/shared/phone-gateway";
import type {
  CommandResult,
  SessionProjectionEvent,
  SessionProjectionPort,
} from "../../src/shared/conversation";
import type { WorkspaceCommand } from "../../src/shared/ipc";
import {
  canonicalizeIpv4,
  isPrivateIpv4,
  selectPrivateIpv4,
  type NetworkInterfacesSnapshot,
} from "./network-address";
import {
  createPairingSessionManager,
  type PairingSessionManager,
  type PairingRandomBytesSource,
} from "./pairing-session";
import {
  createPairingFailureLimiter,
  type PairingFailureLimiter,
  type PairingFailureRateLimitOptions,
} from "./pairing-rate-limiter";
import {
  createPhoneProjection,
  type PhoneProjectionPort,
} from "./phone-projection";
import { readSecureMediaFile } from "./secure-media-file";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

const BIND_HOST = "0.0.0.0";
const FALLBACK_PORT = 0;
const SESSION_COOKIE = "fluely_phone_session";
const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/i;
const MEDIA_CAPABILITY_BYTES = 32;
const PHONE_ASSET_DIRECTORY = join(__dirname, "../../../dist-phone");
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export interface GatewaySocket {
  destroy?: () => void;
  once?: (event: string, listener: () => void) => unknown;
  on?: (event: string, listener: () => void) => unknown;
}

export interface GatewayHttpServer {
  listen(port: number, host: string, callback?: () => void): unknown;
  close(callback?: (error?: Error) => void): unknown;
  address(): { port: number } | string | null;
  on(event: "error" | "connection" | "upgrade", listener: (...args: unknown[]) => void): unknown;
  once(event: "error", listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: "error", listener: (...args: unknown[]) => void): unknown;
}

export type PhoneGatewayRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export interface PhoneGatewayQrCodeAdapter {
  toDataURL(value: string): Promise<string> | string;
}

export interface PhoneGatewayContextSource {
  getManagedPaths(ids: readonly string[]): string[];
  getManagedRoot?: () => string;
}

export interface PhoneGatewayAttachmentSource {
  getPath(id: string): string | undefined;
  getManagedRoot?: () => string;
}

export type PhoneGatewayFileReader = (path: string, managedRoot?: string) => Promise<Uint8Array>;

export interface PhoneGatewayTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PhoneGatewayOptions {
  createServer?: (handler: PhoneGatewayRequestHandler) => GatewayHttpServer;
  networkInterfaces?: () => NetworkInterfacesSnapshot;
  pairing?: PairingSessionManager;
  qrCode?: PhoneGatewayQrCodeAdapter;
  portCandidates?: readonly number[];
  fallbackPort?: number;
  now?: () => number;
  randomBytes?: PairingRandomBytesSource;
  timer?: PhoneGatewayTimer;
  pairingFailureRateLimit?: PairingFailureRateLimitOptions;
  projection?: SessionProjectionPort;
  context?: PhoneGatewayContextSource;
  attachments?: PhoneGatewayAttachmentSource;
  phoneAssetsDirectory?: string;
  readFile?: PhoneGatewayFileReader;
  readMediaFile?: PhoneGatewayFileReader;
  commandRouter?: PhoneGatewayCommandRouter;
  onCommandError?: (diagnostic: PhoneCommandFailureDiagnostic) => void;
  mediaCapabilityFactory?: () => string;
}

export interface PhoneGatewayCommandRouter {
  execute(command: WorkspaceCommand, source: "desktop" | "phone"): Promise<CommandResult>;
}

export interface PhoneCommandFailureDiagnostic {
  event: "phone_command_failed";
  commandType: WorkspaceCommand["type"];
  code: string;
}

interface ListeningServer {
  server: GatewayHttpServer;
  port: number;
}

interface PhoneClient {
  socket: WebSocket;
  sessionKey?: string;
  commandSession: PhoneCommandSession;
  missedHeartbeats: number;
  revoked: boolean;
}

interface PhoneCommandSession {
  settledLedger: Map<string, PhoneCommandSettledRecord>;
  settledSerializedBytes: number;
  inFlight: Map<string, PhoneCommandInFlight>;
  inFlightSerializedBytes: number;
  commandTimestamps: number[];
  revoked: boolean;
}

interface PhoneCommandSettledRecord {
  fingerprint: string;
  response: string;
  serializedBytes: number;
}

interface PhoneCommandInFlight {
  fingerprint: string;
  response: Promise<string>;
  commandSerializedBytes: number;
  waiters: Map<PhoneClient, number>;
  waiterCount: number;
}

const PHONE_SAFE_COMMAND_ERROR_MESSAGES: Readonly<Record<string, { code: string; message: string }>> = {
  ANALYSIS_IN_PROGRESS: {
    code: "ANALYSIS_IN_PROGRESS",
    message: "An analysis is already running.",
  },
  ANALYSIS_FAILED: {
    code: "ANALYSIS_FAILED",
    message: "Analysis failed.",
  },
  SCREENSHOT_NOT_FOUND: {
    code: "SCREENSHOT_NOT_FOUND",
    message: "No queued screenshots are available.",
  },
  COMMAND_UNAVAILABLE: {
    code: "COMMAND_UNAVAILABLE",
    message: "Phone commands are not available yet.",
  },
};

const GENERIC_PHONE_COMMAND_ERROR = {
  code: "COMMAND_FAILED",
  message: "Phone command failed.",
} as const;

function fingerprintPhoneCommand(command: WorkspaceCommand): string {
  return createHash("sha256").update(JSON.stringify(command), "utf8").digest("hex");
}

function serializeLedgerFrame(frame: ServerFrame): string {
  const serialized = serializePhoneServerFrame(frame);
  if (Buffer.byteLength(serialized, "utf8") <= PHONE_GATEWAY_MAX_COMMAND_SETTLED_RESPONSE_BYTES) {
    return serialized;
  }
  return serializePhoneServerFrame({
    type: "error",
    requestId: frame.type === "ack" || frame.type === "error" ? frame.requestId : undefined,
    ...GENERIC_PHONE_COMMAND_ERROR,
  });
}

function safePhoneCommandError(error: unknown): { code: string; message: string } {
  let code = "";
  try {
    code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "";
  } catch {
    code = "";
  }
  const safe = Object.prototype.hasOwnProperty.call(PHONE_SAFE_COMMAND_ERROR_MESSAGES, code)
    ? PHONE_SAFE_COMMAND_ERROR_MESSAGES[code]
    : GENERIC_PHONE_COMMAND_ERROR;
  return { ...safe };
}

function serializePhoneCommandError(
  requestId: string,
  safeError: { code: string; message: string },
): string {
  return serializeLedgerFrame({ type: "error", requestId, ...safeError });
}

function serializeSessionRevoked(requestId?: string): string {
  return serializeLedgerFrame({
    type: "error",
    ...(requestId ? { requestId } : {}),
    code: "SESSION_REVOKED",
    message: "Pairing revoked.",
  });
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "EADDRINUSE";
}

function errorStatus(
  code: Extract<PhoneGatewayStatus, { state: "error" }>["code"],
  message: string,
): PhoneGatewayStatus {
  return { state: "error", code, message };
}

function cloneStatus(status: PhoneGatewayStatus): PhoneGatewayStatus {
  if (status.state !== "ready") {
    return { ...status };
  }
  return { ...status };
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const chunk of header.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (name && value) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function responseBody(response: ServerResponse, statusCode: number, contentType: string, body: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function responseEmpty(response: ServerResponse, statusCode: number): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Length", "0");
  response.end();
}

function responseBytes(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  bytes: Uint8Array,
): void {
  const body = Buffer.from(bytes);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", body.byteLength);
  response.end(body);
}

type PhoneMediaRoute =
  | { namespace: "context"; id: string; capability?: string }
  | { namespace: "attachments"; id: string; capability?: string };

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
const INVALID_PERCENT_ENCODING_PATTERN = /%(?![0-9a-f]{2})/i;
const ENCODED_UNSAFE_BYTE_PATTERN = /%(?:25)*(?:00|0[1-9a-f]|1[0-9a-f]|2e|2f|5c|7f)/i;

export interface RawRequestTarget {
  path: string;
  query: string;
  hasQuery: boolean;
}

function hasDotSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function hasUnsafePathEncoding(pathname: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(pathname) ||
    pathname.includes("\\") ||
    hasDotSegment(pathname) ||
    ENCODED_SEPARATOR_PATTERN.test(pathname) ||
    INVALID_PERCENT_ENCODING_PATTERN.test(pathname) ||
    ENCODED_UNSAFE_BYTE_PATTERN.test(pathname);
}

/** Parses a raw HTTP request-target without URL normalization or path decoding. */
export function parseRawRequestTarget(target: unknown): RawRequestTarget | null {
  if (typeof target !== "string" || target.length === 0 || target[0] !== "/" || target.startsWith("//")) {
    return null;
  }
  if (CONTROL_CHARACTER_PATTERN.test(target) || target.includes("#")) {
    return null;
  }

  const queryIndex = target.indexOf("?");
  const path = queryIndex >= 0 ? target.slice(0, queryIndex) : target;
  const query = queryIndex >= 0 ? target.slice(queryIndex + 1) : "";
  if (!path || hasUnsafePathEncoding(path)) {
    return null;
  }
  return { path, query, hasQuery: queryIndex >= 0 };
}

function parseMediaRoute(pathname: string, hasQuery: boolean, requireCapability = false): PhoneMediaRoute | null {
  if (hasQuery) {
    return null;
  }

  const routes = [
    ["/api/context/", "context"],
    ["/api/attachments/", "attachments"],
  ] as const;
  for (const [prefix, namespace] of routes) {
    if (!pathname.startsWith(prefix)) {
      continue;
    }
    const segments = pathname.slice(prefix.length).split("/");
    if (segments.length !== (requireCapability ? 2 : 1)) {
      return null;
    }
    const rawCapability = requireCapability ? segments[0] : undefined;
    const rawId = segments.at(-1) ?? "";
    if (!rawId || (rawCapability !== undefined && !MEDIA_CAPABILITY_PATTERN.test(rawCapability))) {
      return null;
    }
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return null;
    }
    if (!OPAQUE_ID_PATTERN.test(id)) {
      return null;
    }
    return {
      namespace,
      id,
      ...(rawCapability ? { capability: rawCapability } : {}),
    };
  }
  return null;
}

function parsePairingSecret(query: string, hasQuery: boolean): string | null {
  if (!hasQuery || !query || query.includes("&")) {
    return null;
  }
  const separator = query.indexOf("=");
  if (separator <= 0 || separator === query.length - 1 || query.indexOf("=", separator + 1) >= 0) {
    return null;
  }
  if (query.slice(0, separator) !== "secret") {
    return null;
  }
  try {
    const secret = decodeURIComponent(query.slice(separator + 1));
    return secret && !CONTROL_CHARACTER_PATTERN.test(secret) && !secret.includes("\\") && !/[?&#=]/.test(secret)
      ? secret
      : null;
  } catch {
    return null;
  }
}

function hasHeaderToken(value: string | string[] | undefined, expected: string): boolean {
  return typeof value === "string" && value.split(",").some((token) => token.trim().toLowerCase() === expected);
}

function isWebSocketRequestAttempt(request: IncomingMessage): boolean {
  return request.headers.upgrade !== undefined ||
    request.headers["sec-websocket-version"] !== undefined ||
    request.headers["sec-websocket-key"] !== undefined ||
    hasHeaderToken(request.headers.connection, "upgrade");
}

function isWebSocketKey(value: string | string[] | undefined): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 16 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function buildGatewayOrigin(address: string, port: number): string {
  const canonicalAddress = canonicalizeIpv4(address);
  if (!canonicalAddress || !isPrivateIpv4(canonicalAddress)) {
    throw new Error("Gateway address is not a canonical private IPv4 address.");
  }

  const origin = new URL(`http://${canonicalAddress}:${port}`);
  if (origin.protocol !== "http:" || origin.hostname !== canonicalAddress || !isPrivateIpv4(origin.hostname)) {
    throw new Error("Gateway origin hostname did not preserve its private IPv4 address.");
  }
  return origin.origin;
}

function constantTimeMediaCapabilityEqual(candidate: string | undefined, expected: string | null): boolean {
  if (!expected || typeof candidate !== "string" || !MEDIA_CAPABILITY_PATTERN.test(candidate)) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return candidateBytes.byteLength === MEDIA_CAPABILITY_BYTES &&
    expectedBytes.byteLength === MEDIA_CAPABILITY_BYTES &&
    timingSafeEqual(candidateBytes, expectedBytes);
}

export class PhoneGateway {
  private readonly createServer: (handler: PhoneGatewayRequestHandler) => GatewayHttpServer;
  private readonly getNetworkInterfaces: () => NetworkInterfacesSnapshot;
  private readonly pairing: PairingSessionManager;
  private readonly qrCode: PhoneGatewayQrCodeAdapter;
  private readonly portCandidates: readonly number[];
  private readonly fallbackPort: number;
  private readonly now: () => number;
  private readonly timer: PhoneGatewayTimer;
  private readonly pairingFailures: PairingFailureLimiter;
  private readonly projection: PhoneProjectionPort | null;
  private readonly context: PhoneGatewayContextSource | null;
  private readonly attachments: PhoneGatewayAttachmentSource | null;
  private readonly phoneAssetsDirectory: string;
  private readonly readPhoneAsset: PhoneGatewayFileReader;
  private readonly readMediaFile: PhoneGatewayFileReader;
  private readonly commandRouter: PhoneGatewayCommandRouter | null;
  private readonly onCommandError: (diagnostic: PhoneCommandFailureDiagnostic) => void;
  private readonly mediaCapabilityFactory: () => string;
  private readonly bindMediaUrls: boolean;
  private server: GatewayHttpServer | null = null;
  private selectedAddress: string | null = null;
  private selectedPort: number | null = null;
  private origin: string | null = null;
  private qrDataUrl = "";
  private pairingExpiresAt = 0;
  private sockets = new Set<GatewaySocket>();
  private status: PhoneGatewayStatus = { state: "disabled" };
  private readonly statusListeners = new Set<PhoneGatewayStatusListener>();
  private startPromise: Promise<PhoneGatewayStatus> | undefined;
  private stopPromise: Promise<PhoneGatewayStatus> | undefined;
  private pairingGeneration = 0;
  private pairingExpiryTimer: unknown = null;
  private webSocketServer: WebSocketServer | null = null;
  private removeProjectionSubscription: (() => void) | null = null;
  private readonly phoneClients = new Set<PhoneClient>();
  private readonly phoneSessions = new Map<string, PhoneCommandSession>();
  private heartbeatTimer: unknown = null;
  private lastBroadcastRevision = 0;
  private mediaCapability: string | null = null;

  public constructor(options: PhoneGatewayOptions = {}) {
    this.createServer = options.createServer ?? ((handler) => createHttpServer(handler) as unknown as GatewayHttpServer);
    this.getNetworkInterfaces = options.networkInterfaces ?? (() => networkInterfaces() as NetworkInterfacesSnapshot);
    this.now = options.now ?? Date.now;
    this.pairing = options.pairing ?? createPairingSessionManager({
      now: this.now,
      randomBytes: options.randomBytes,
    });
    this.qrCode = options.qrCode ?? { toDataURL: (value) => QRCode.toDataURL(value) };
    this.portCandidates = options.portCandidates ?? PHONE_GATEWAY_PORTS;
    this.fallbackPort = options.fallbackPort ?? FALLBACK_PORT;
    this.timer = options.timer ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.pairingFailures = createPairingFailureLimiter({
      now: this.now,
      ...options.pairingFailureRateLimit,
    });
    this.context = options.context ?? null;
    this.attachments = options.attachments ?? null;
    this.phoneAssetsDirectory = options.phoneAssetsDirectory ?? PHONE_ASSET_DIRECTORY;
    this.readPhoneAsset = options.readFile ?? (async (path) => new Uint8Array(await readFile(path)));
    this.readMediaFile = options.readMediaFile ?? readSecureMediaFile;
    this.commandRouter = options.commandRouter ?? null;
    this.onCommandError = options.onCommandError ?? ((diagnostic) => {
      console.warn("Phone command failed.", diagnostic);
    });
    this.mediaCapabilityFactory = options.mediaCapabilityFactory ?? (() =>
      cryptoRandomBytes(MEDIA_CAPABILITY_BYTES).toString("hex"));
    this.bindMediaUrls = Boolean(options.projection);
    this.projection = options.projection
      ? createPhoneProjection(options.projection, {
        getMediaCapability: () => this.mediaCapability ?? undefined,
      })
      : null;
  }

  public getStatus(): PhoneGatewayStatus {
    if (this.status.state !== "ready") {
      return cloneStatus(this.status);
    }
    return {
      ...this.status,
      qrDataUrl: this.qrDataUrl,
      pairingExpiresAt: this.pairingExpiresAt,
      paired: this.pairing.isPaired(),
    };
  }

  public onStatusChanged(listener: PhoneGatewayStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public start(): Promise<PhoneGatewayStatus> {
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.start());
    }
    if (this.status.state === "ready") {
      return Promise.resolve(this.getStatus());
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.status = { state: "starting" };
    this.publishStatus();
    const promise = this.startInternal()
      .then((nextStatus) => {
        this.status = nextStatus;
        this.publishStatus();
        return this.getStatus();
      })
      .catch(async () => {
        await this.closeServer();
        this.status = errorStatus("start_failed", "Phone companion could not start.");
        this.pairing.revokeAll();
        this.pairingFailures.reset();
        this.publishStatus();
        return this.getStatus();
      })
      .finally(() => {
        if (this.startPromise === promise) {
          this.startPromise = undefined;
        }
      });
    this.startPromise = promise;
    return promise;
  }

  public stop(): Promise<PhoneGatewayStatus> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    const promise = (async () => {
      this.invalidatePairingWork();
      this.pairing.revokeAll();
      this.pairingFailures.reset();
      if (this.startPromise) {
        await this.startPromise;
      }
      await this.closeServer();
      this.status = { state: "disabled" };
      this.publishStatus();
      return this.getStatus();
    })().finally(() => {
      if (this.stopPromise === promise) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = promise;
    return promise;
  }

  public async regeneratePairing(): Promise<PhoneGatewayStatus> {
    if (this.stopPromise) {
      await this.stopPromise;
      return this.getStatus();
    }
    if (this.startPromise) {
      await this.startPromise;
    }
    if (this.status.state !== "ready" || !this.origin) {
      return this.getStatus();
    }

    const origin = this.origin;
    const generation = this.beginPairingGeneration();
    const pairing = this.pairing.issue(this.now());
    this.rotateMediaCapability();
    this.closePhoneClients();
    this.pairingFailures.reset();
    this.pairingExpiresAt = pairing.expiresAt;
    this.schedulePairingExpiry(generation, pairing.expiresAt);
    this.publishStatus();
    try {
      const qrDataUrl = await this.qrCode.toDataURL(this.buildPairingUrl(origin, pairing.secret));
      if (!this.isCurrentPairingGeneration(generation, origin)) {
        return this.getStatus();
      }
      this.qrDataUrl = qrDataUrl;
      this.publishStatus();
      return this.getStatus();
    } catch {
      if (!this.isCurrentPairingGeneration(generation, origin)) {
        return this.getStatus();
      }
      this.pairing.revokeAll();
      this.pairingFailures.reset();
      await this.closeServer();
      this.status = errorStatus("start_failed", "Phone companion could not start.");
      this.publishStatus();
      return this.getStatus();
    }
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }

  private async startInternal(): Promise<PhoneGatewayStatus> {
    const address = selectPrivateIpv4(this.getNetworkInterfaces());
    if (!address) {
      this.pairing.revokeAll();
      return errorStatus("no_lan_address", "No private LAN address is available.");
    }

    const generation = this.beginPairingGeneration();
    const pairing = this.pairing.issue(this.now());
    this.rotateMediaCapability();
    this.pairingFailures.reset();
    let listening: ListeningServer;
    try {
      listening = await this.listenOnAvailablePort();
    } catch (error) {
      this.pairing.revokeAll();
      if (error === "port_unavailable") {
        return errorStatus("port_unavailable", "No gateway port is available.");
      }
      return errorStatus("start_failed", "Phone companion could not start.");
    }

    this.server = listening.server;
    this.selectedAddress = address;
    this.selectedPort = listening.port;
    try {
      this.origin = buildGatewayOrigin(address, listening.port);
    } catch {
      await this.closeServer();
      this.pairing.revokeAll();
      return errorStatus("start_failed", "Phone companion could not start.");
    }
    this.trackServerConnections(listening.server);
    this.createWebSocketServer();
    this.lastBroadcastRevision = this.projection?.getSnapshot().revision ?? 0;
    this.subscribeToProjection();
    this.pairingExpiresAt = pairing.expiresAt;
    this.schedulePairingExpiry(generation, pairing.expiresAt);

    try {
      const qrDataUrl = await this.qrCode.toDataURL(this.buildPairingUrl(this.origin, pairing.secret));
      if (!this.isCurrentPairingGeneration(generation, this.origin)) {
        return this.currentReadyStatus();
      }
      this.qrDataUrl = qrDataUrl;
      return this.currentReadyStatus();
    } catch {
      if (!this.isCurrentPairingGeneration(generation, this.origin)) {
        return this.currentReadyStatus();
      }
      await this.closeServer();
      this.pairing.revokeAll();
      return errorStatus("start_failed", "Phone companion could not start.");
    }
  }

  private async listenOnAvailablePort(): Promise<ListeningServer> {
    const ports = [...this.portCandidates];
    if (!ports.includes(this.fallbackPort)) {
      ports.push(this.fallbackPort);
    }

    let addressInUseCount = 0;
    for (const port of ports) {
      const server = this.createServer((request, response) => this.handleRequest(request, response));
      try {
        const actualPort = await this.listen(server, port);
        return { server, port: actualPort };
      } catch (error) {
        await this.closeOneServer(server);
        if (isAddressInUse(error)) {
          addressInUseCount += 1;
          continue;
        }
        throw error;
      }
    }

    if (addressInUseCount === ports.length) {
      throw "port_unavailable";
    }
    throw new Error("No gateway port was available.");
  }

  private listen(server: GatewayHttpServer, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        server.removeListener?.("error", onError);
      };
      const onError = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };
      const onListening = () => {
        if (settled) {
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string" || !Number.isInteger(address.port) || address.port <= 0) {
          settled = true;
          cleanup();
          reject(new Error("Gateway did not report a listening port."));
          return;
        }
        settled = true;
        cleanup();
        resolve(address.port);
      };

      server.once("error", onError);
      try {
        server.listen(port, BIND_HOST, onListening);
      } catch (error) {
        onError(error);
      }
    });
  }

  private trackServerConnections(server: GatewayHttpServer): void {
    server.on("connection", (socket) => {
      const candidate = socket as GatewaySocket;
      this.sockets.add(candidate);
      const remove = () => this.sockets.delete(candidate);
      candidate.once?.("close", remove);
      if (!candidate.once) {
        candidate.on?.("close", remove);
      }
    });
    server.on("upgrade", (...args) => {
      const request = args[0] as IncomingMessage | undefined;
      const socket = args[1] as Socket | undefined;
      const head = args[2] as Buffer | undefined;
      if (!request || !socket || !head) {
        return;
      }
      this.handleUpgrade(request, socket, head);
    });
  }

  private createWebSocketServer(): void {
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: PHONE_GATEWAY_MAX_FRAME_BYTES,
    });
    webSocketServer.on("error", () => {
      // Protocol errors are reported to the affected socket when possible;
      // they must never expose ws internals to the phone or main process.
    });
    webSocketServer.on("connection", (socket, request) => {
      const sessionKey = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      this.acceptWebSocket(socket, sessionKey);
    });
    this.webSocketServer = webSocketServer;
  }

  private subscribeToProjection(): void {
    if (!this.projection || this.removeProjectionSubscription) {
      return;
    }
    this.removeProjectionSubscription = this.projection.subscribe((event) => {
      this.broadcastProjectionEvent(event);
    });
  }

  private broadcastProjectionEvent(event: SessionProjectionEvent): void {
    if (!this.projection || event.revision <= this.lastBroadcastRevision) {
      return;
    }

    const snapshot = this.projection.getSnapshot();
    const frame: ServerFrame = event.type === "conversation"
      ? {
        type: "event",
        revision: event.revision,
        payload: event.event,
      }
      : {
        type: "snapshot",
        revision: event.revision,
        payload: snapshot,
      };
    this.lastBroadcastRevision = event.revision;
    this.broadcastFrame(frame);
  }

  private broadcastFrame(frame: ServerFrame): void {
    for (const client of [...this.phoneClients]) {
      this.sendFrame(client, frame);
    }
  }

  private sendFrame(client: PhoneClient, frame: ServerFrame): void {
    if (!this.isCurrentPhoneClient(client)) {
      return;
    }
    this.sendSerializedFrame(client, serializePhoneServerFrame(frame));
  }

  private sendSerializedFrame(client: PhoneClient, serialized: string): void {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (client.socket.bufferedAmount > PHONE_GATEWAY_MAX_BUFFERED_AMOUNT_BYTES) {
      this.closeForBackpressure(client);
      return;
    }
    try {
      client.socket.send(serialized);
      if (client.socket.bufferedAmount > PHONE_GATEWAY_MAX_BUFFERED_AMOUNT_BYTES) {
        this.closeForBackpressure(client);
      }
    } catch {
      try {
        client.socket.terminate();
      } catch {
        // The socket may already be closing.
      }
    }
  }

  private acceptWebSocket(socket: WebSocket, sessionKey?: string): void {
    if (!this.projection) {
      socket.close(1011, "Phone projection unavailable.");
      return;
    }

    const client: PhoneClient = {
      socket,
      ...(sessionKey ? { sessionKey } : {}),
      commandSession: sessionKey ? this.getPhoneCommandSession(sessionKey) : this.createPhoneCommandSession(),
      missedHeartbeats: 0,
      revoked: false,
    };
    if (!this.isCurrentPhoneClient(client)) {
      socket.close(1008, "Pairing revoked.");
      return;
    }
    this.phoneClients.add(client);
    if (this.heartbeatTimer === null) {
      this.scheduleHeartbeat();
    }
    const remove = () => {
      this.phoneClients.delete(client);
      if (this.phoneClients.size === 0) {
        this.clearHeartbeatTimer();
      }
    };
    socket.once("close", remove);
    socket.once("error", remove);
    socket.on("pong", () => {
      client.missedHeartbeats = 0;
    });
    socket.on("message", (data: RawData) => this.handleClientFrame(client, data));
    const snapshot = this.projection.getSnapshot();
    this.sendFrame(client, {
      type: "snapshot",
      revision: snapshot.revision,
      payload: snapshot,
    });
  }

  private handleClientFrame(client: PhoneClient, data: RawData): void {
    if (!this.isCurrentPhoneClient(client)) {
      this.rejectRevokedClient(client);
      return;
    }

    let bytes: Uint8Array;
    if (typeof data === "string") {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (Array.isArray(data)) {
      bytes = Buffer.concat(data);
    } else {
      bytes = data;
    }

    const frame = parsePhoneClientFrame(bytes);
    if (!frame) {
      this.sendFrame(client, {
        type: "error",
        code: "INVALID_FRAME",
        message: "Invalid phone frame.",
      });
      this.closeClient(client, 1008, "Invalid phone frame.");
      return;
    }

    if (!this.isCurrentPhoneClient(client)) {
      this.rejectRevokedClient(client);
      return;
    }

    if (frame.type === "ping") {
      this.sendFrame(client, { type: "pong", at: frame.at });
      return;
    }

    if (!this.projection) {
      return;
    }
    if (frame.type === "resync") {
      const snapshot = this.projection.getSnapshot();
      this.sendFrame(client, {
        type: "snapshot",
        revision: snapshot.revision,
        payload: snapshot,
      });
      return;
    }

    if (frame.type === "command") {
      this.handleCommandFrame(client, frame.command);
    }
  }

  private handleCommandFrame(client: PhoneClient, command: WorkspaceCommand): void {
    if (!this.isCurrentPhoneClient(client)) {
      this.rejectRevokedClient(client, command.requestId);
      return;
    }

    const session = client.commandSession;
    const fingerprint = fingerprintPhoneCommand(command);
    const settled = session.settledLedger.get(command.requestId);
    if (settled) {
      if (settled.fingerprint !== fingerprint) {
        this.sendSerializedFrame(client, serializeLedgerFrame({
          type: "error",
          requestId: command.requestId,
          code: "DUPLICATE_REQUEST_ID",
          message: "This request ID was already used for a different command.",
        }));
        return;
      }
      this.sendSerializedFrame(client, settled.response);
      return;
    }

    const inFlight = session.inFlight.get(command.requestId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        this.sendSerializedFrame(client, serializeLedgerFrame({
          type: "error",
          requestId: command.requestId,
          code: "DUPLICATE_REQUEST_ID",
          message: "This request ID was already used for a different command.",
        }));
        return;
      }
      if (inFlight.waiterCount >= PHONE_GATEWAY_MAX_IN_FLIGHT_WAITERS_PER_COMMAND) {
        this.rejectRateLimitedCommand(client, command.requestId);
        return;
      }
      inFlight.waiters.set(client, (inFlight.waiters.get(client) ?? 0) + 1);
      inFlight.waiterCount += 1;
      return;
    }

    if (
      session.settledLedger.size + session.inFlight.size >= PHONE_GATEWAY_MAX_COMMAND_SETTLED_IDS
    ) {
      this.revokePhoneSession(client, command.requestId);
      return;
    }

    const commandSerializedBytes = Buffer.byteLength(JSON.stringify(command), "utf8");
    if (
      commandSerializedBytes > PHONE_GATEWAY_MAX_IN_FLIGHT_COMMAND_SERIALIZED_BYTES ||
      session.inFlight.size >= PHONE_GATEWAY_MAX_IN_FLIGHT_COMMANDS ||
      session.inFlightSerializedBytes + commandSerializedBytes > PHONE_GATEWAY_MAX_IN_FLIGHT_SERIALIZED_BYTES
    ) {
      this.rejectRateLimitedCommand(client, command.requestId);
      return;
    }

    const now = this.now();
    const timestamps = session.commandTimestamps;
    while (timestamps.length > 0 && now - timestamps[0] >= PHONE_GATEWAY_COMMAND_RATE_WINDOW_MS) {
      timestamps.shift();
    }
    if (timestamps.length >= PHONE_GATEWAY_COMMAND_RATE_LIMIT) {
      this.rejectRateLimitedCommand(client, command.requestId);
      return;
    }
    timestamps.push(now);

    const response = Promise.resolve().then(async () => {
      if (!this.isCurrentPhoneClient(client)) {
        return serializeSessionRevoked(command.requestId);
      }
      if (!this.commandRouter) {
        return serializeLedgerFrame({
          type: "error",
          requestId: command.requestId,
          code: "COMMAND_UNAVAILABLE",
          message: "Phone commands are not available yet.",
        });
      }
      try {
        await this.commandRouter.execute(command, "phone");
        if (!this.isCurrentPhoneClient(client)) {
          return serializeSessionRevoked(command.requestId);
        }
        return serializeLedgerFrame({ type: "ack", requestId: command.requestId });
      } catch (error) {
        const safeError = safePhoneCommandError(error);
        try {
          this.onCommandError({
            event: "phone_command_failed",
            commandType: command.type,
            code: safeError.code,
          });
        } catch {
          // Local diagnostics must not affect the phone protocol.
        }
        return this.isCurrentPhoneClient(client)
          ? serializePhoneCommandError(command.requestId, safeError)
          : serializeSessionRevoked(command.requestId);
      }
    });
    const entry: PhoneCommandInFlight = {
      fingerprint,
      response,
      commandSerializedBytes,
      waiters: new Map([[client, 1]]),
      waiterCount: 1,
    };
    session.inFlight.set(command.requestId, entry);
    session.inFlightSerializedBytes += commandSerializedBytes;
    void response.then((serialized) => {
      this.settlePhoneCommand(session, command.requestId, entry, serialized);
    });
  }

  private createPhoneCommandSession(): PhoneCommandSession {
    return {
      settledLedger: new Map(),
      settledSerializedBytes: 0,
      inFlight: new Map(),
      inFlightSerializedBytes: 0,
      commandTimestamps: [],
      revoked: false,
    };
  }

  private settlePhoneCommand(
    session: PhoneCommandSession,
    requestId: string,
    entry: PhoneCommandInFlight,
    response: string,
  ): void {
    if (session.inFlight.get(requestId) !== entry) {
      return;
    }
    session.inFlight.delete(requestId);
    session.inFlightSerializedBytes = Math.max(
      0,
      session.inFlightSerializedBytes - entry.commandSerializedBytes,
    );
    if (session.revoked) {
      entry.waiters.clear();
      return;
    }

    const serializedBytes =
      Buffer.byteLength(requestId, "utf8") +
      PHONE_GATEWAY_COMMAND_FINGERPRINT_BYTES +
      Buffer.byteLength(response, "utf8");
    if (
      session.settledSerializedBytes + serializedBytes >
      PHONE_GATEWAY_MAX_COMMAND_SETTLED_SERIALIZED_BYTES
    ) {
      const firstClient = entry.waiters.keys().next().value as PhoneClient | undefined;
      entry.waiters.clear();
      if (firstClient) {
        this.revokePhoneSession(firstClient, requestId);
      }
      return;
    }

    const settled: PhoneCommandSettledRecord = {
      fingerprint: entry.fingerprint,
      response,
      serializedBytes,
    };
    session.settledLedger.set(requestId, settled);
    session.settledSerializedBytes += serializedBytes;
    for (const [waiter, count] of entry.waiters) {
      for (let index = 0; index < count; index += 1) {
        this.sendSerializedFrame(waiter, response);
      }
    }
    entry.waiters.clear();
  }

  private rejectRateLimitedCommand(client: PhoneClient, requestId: string): void {
    this.sendFrame(client, {
      type: "error",
      requestId,
      code: "RATE_LIMITED",
      message: "Too many phone commands. Try again shortly.",
    });
    this.closeClient(client, 1008, "Phone command rate limit exceeded.");
  }

  private getPhoneCommandSession(sessionKey: string): PhoneCommandSession {
    const existing = this.phoneSessions.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created = this.createPhoneCommandSession();
    this.phoneSessions.set(sessionKey, created);
    return created;
  }

  private isCurrentPhoneClient(client: PhoneClient): boolean {
    if (client.revoked || client.commandSession.revoked) {
      return false;
    }
    // Direct in-process test sockets do not have an issued pairing. Every
    // network client has an origin and therefore must authenticate here too.
    return !client.sessionKey || this.origin === null || this.pairing.authenticate(client.sessionKey);
  }

  private rejectRevokedClient(client: PhoneClient, requestId?: string): void {
    client.revoked = true;
    this.revokeCommandSessionState(client.commandSession);
    this.sendSerializedFrame(client, serializeSessionRevoked(requestId));
    this.closeClient(client, 1008, "Pairing revoked.");
  }

  private revokePhoneSession(client: PhoneClient, requestId: string): void {
    const sessionKey = client.sessionKey;
    const affected = [...this.phoneClients].filter((candidate) =>
      candidate === client || (sessionKey !== undefined && candidate.sessionKey === sessionKey));
    const session = sessionKey === undefined ? undefined : this.phoneSessions.get(sessionKey);
    client.revoked = true;
    this.revokeCommandSessionState(client.commandSession);
    if (session) {
      this.revokeCommandSessionState(session);
    }
    for (const candidate of affected) {
      candidate.revoked = true;
      this.revokeCommandSessionState(candidate.commandSession);
    }
    this.pairing.revokeAll();
    for (const candidate of affected) {
      this.sendSerializedFrame(candidate, serializeSessionRevoked(candidate === client ? requestId : undefined));
      this.closeClient(candidate, 1008, "Pairing revoked.");
    }
  }

  private revokeCommandSessionState(session: PhoneCommandSession): void {
    session.revoked = true;
    for (const entry of session.inFlight.values()) {
      entry.waiters.clear();
    }
    session.inFlight.clear();
    session.inFlightSerializedBytes = 0;
    session.settledLedger.clear();
    session.settledSerializedBytes = 0;
    session.commandTimestamps = [];
  }

  private closeClient(client: PhoneClient, code: number, reason: string): void {
    try {
      client.socket.close(code, reason);
    } catch {
      try {
        client.socket.terminate();
      } catch {
        // The peer may already be disconnected.
      }
    }
  }

  private closeForBackpressure(client: PhoneClient): void {
    try {
      client.socket.close(1009, "Phone connection backpressure limit exceeded.");
    } catch {
      // The peer may already be closing.
    }
    try {
      client.socket.terminate();
    } catch {
      // The peer may already be disconnected.
    }
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeatTimer();
    const heartbeat = () => {
      this.heartbeatTimer = null;
      if (!this.webSocketServer) {
        return;
      }
      for (const client of [...this.phoneClients]) {
        if (client.socket.readyState !== WebSocket.OPEN) {
          continue;
        }
        if (client.missedHeartbeats >= PHONE_GATEWAY_HEARTBEAT_MISSES) {
          try {
            client.socket.terminate();
          } catch {
            // The peer may already be disconnected.
          }
          continue;
        }
        client.missedHeartbeats += 1;
        try {
          client.socket.ping();
        } catch {
          try {
            client.socket.terminate();
          } catch {
            // The peer may already be disconnected.
          }
        }
      }
      if (this.phoneClients.size > 0) {
        this.heartbeatTimer = this.timer.setTimeout(heartbeat, PHONE_GATEWAY_HEARTBEAT_INTERVAL_MS);
      }
    };
    this.heartbeatTimer = this.timer.setTimeout(heartbeat, PHONE_GATEWAY_HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === null) {
      return;
    }
    this.timer.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    const target = parseRawRequestTarget(request.url);
    if (!target) {
      this.rejectUpgrade(socket, 404, "Not found.");
      return;
    }

    if (
      request.method !== "GET" ||
      target.path !== "/ws" ||
      target.hasQuery ||
      !this.isAllowedRequestMetadata(request, true) ||
      !hasHeaderToken(request.headers.connection, "upgrade") ||
      !hasHeaderToken(request.headers.upgrade, "websocket") ||
      request.headers["sec-websocket-version"] !== "13" ||
      !isWebSocketKey(request.headers["sec-websocket-key"])
    ) {
      this.rejectUpgrade(socket, 404, "Not found.");
      return;
    }

    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (!token || !this.pairing.authenticate(token)) {
      this.rejectUpgrade(socket, 401, "Authentication required.");
      return;
    }
    if (!this.webSocketServer || !this.projection) {
      this.rejectUpgrade(socket, 404, "Not found.");
      return;
    }

    try {
      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer?.emit("connection", webSocket, request);
      });
    } catch {
      this.rejectUpgrade(socket, 404, "Not found.");
    }
  }

  private rejectUpgrade(socket: Socket, statusCode: 401 | 404, body: string): void {
    const reason = statusCode === 401 ? "Unauthorized" : "Not Found";
    const bodyBytes = Buffer.from(body, "utf8");
    const headers = [
      `HTTP/1.1 ${statusCode} ${reason}`,
      ...Object.entries(SECURITY_HEADERS).map(([name, value]) => `${name}: ${value}`),
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${bodyBytes.byteLength}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    try {
      socket.write(`${headers}${body}`);
    } catch {
      // The peer may have disconnected before the safe rejection was written.
    } finally {
      socket.destroy();
    }
  }

  private closePhoneClients(): void {
    for (const session of this.phoneSessions.values()) {
      this.revokeCommandSessionState(session);
    }
    for (const client of [...this.phoneClients]) {
      client.revoked = true;
      this.revokeCommandSessionState(client.commandSession);
      try {
        client.socket.close(1001, "Phone session ended.");
        client.socket.terminate();
      } catch {
        // A peer can close concurrently while pairing or stopping.
      }
    }
    this.phoneClients.clear();
    this.phoneSessions.clear();
  }

  private async closeServer(): Promise<void> {
    this.invalidatePairingWork();
    this.clearHeartbeatTimer();
    this.closePhoneClients();
    const webSocketServer = this.webSocketServer;
    this.webSocketServer = null;
    this.removeProjectionSubscription?.();
    this.removeProjectionSubscription = null;
    this.lastBroadcastRevision = 0;
    const server = this.server;
    this.server = null;
    this.selectedAddress = null;
    this.selectedPort = null;
    this.origin = null;
    this.mediaCapability = null;
    this.qrDataUrl = "";
    this.pairingExpiresAt = 0;
    for (const socket of this.sockets) {
      try {
        socket.destroy?.();
      } catch {
        // A peer can close concurrently while the gateway is stopping.
      }
    }
    this.sockets.clear();
    if (server) {
      await this.closeOneServer(server);
    }
    if (webSocketServer) {
      await new Promise<void>((resolve) => {
        try {
          webSocketServer.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }

  private closeOneServer(server: GatewayHttpServer): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      try {
        server.close(() => finish());
      } catch {
        finish();
      }
    });
  }

  private buildPairingUrl(origin: string, secret: string): string {
    return `${origin}/pair?secret=${encodeURIComponent(secret)}`;
  }

  private currentReadyStatus(): Extract<PhoneGatewayStatus, { state: "ready" }> {
    if (!this.origin) {
      throw new Error("Gateway is not ready.");
    }
    return {
      state: "ready",
      origin: this.origin,
      qrDataUrl: this.qrDataUrl,
      pairingExpiresAt: this.pairingExpiresAt,
      paired: this.pairing.isPaired(),
    };
  }

  private clearPairingExpiryTimer(): void {
    if (this.pairingExpiryTimer === null) {
      return;
    }
    try {
      this.timer.clearTimeout(this.pairingExpiryTimer);
    } finally {
      this.pairingExpiryTimer = null;
    }
  }

  private rotateMediaCapability(): void {
    const capability = this.mediaCapabilityFactory();
    if (typeof capability !== "string" || !MEDIA_CAPABILITY_PATTERN.test(capability)) {
      throw new Error("Phone media capability factory returned an invalid value.");
    }
    this.mediaCapability = capability;
  }

  private invalidatePairingWork(): void {
    this.pairingGeneration += 1;
    this.clearPairingExpiryTimer();
    this.qrDataUrl = "";
    this.pairingExpiresAt = 0;
  }

  private beginPairingGeneration(): number {
    this.invalidatePairingWork();
    return this.pairingGeneration;
  }

  private isCurrentPairingGeneration(generation: number, origin: string): boolean {
    return generation === this.pairingGeneration && this.server !== null && this.origin === origin;
  }

  private schedulePairingExpiry(generation: number, expiresAt: number): void {
    this.clearPairingExpiryTimer();
    const delayMs = Math.max(0, expiresAt - this.now());
    this.pairingExpiryTimer = this.timer.setTimeout(() => {
      if (generation !== this.pairingGeneration) {
        return;
      }
      this.pairingExpiryTimer = null;
      this.pairing.revokePending();
      this.qrDataUrl = "";
      this.pairingGeneration += 1;
      this.publishStatus();
    }, delayMs);
  }

  private isAllowedRequestMetadata(request: IncomingMessage, requireOrigin = false): boolean {
    if (!this.origin || this.selectedAddress === null || this.selectedPort === null) {
      return false;
    }

    const host = request.headers.host;
    const advertisedHost = this.origin.startsWith("http://") ? this.origin.slice("http://".length) : "";
    const allowedHosts = new Set([
      advertisedHost,
      `127.0.0.1:${this.selectedPort}`,
      `localhost:${this.selectedPort}`,
    ]);
    if (typeof host !== "string" || !allowedHosts.has(host.toLowerCase())) {
      return false;
    }

    const origin = request.headers.origin;
    return requireOrigin ? origin === this.origin : origin === undefined || origin === this.origin;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    if (isWebSocketRequestAttempt(request)) {
      response.setHeader("Connection", "close");
    }

    if (!this.isAllowedRequestMetadata(request)) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    const target = parseRawRequestTarget(request.url);
    if (!target) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    if (request.method === "GET" && target.path === "/pair") {
      this.handlePairing(target.query, target.hasQuery, response, request.socket?.remoteAddress ?? "<unknown>");
      return;
    }

    if (request.method !== "GET") {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    const assetName = target.path === "/" && !target.hasQuery
      ? "index.html"
      : target.path === "/phone.js" && !target.hasQuery
        ? "phone.js"
        : target.path === "/phone.css" && !target.hasQuery
          ? "phone.css"
          : null;
    const mediaRoute = parseMediaRoute(target.path, target.hasQuery, this.bindMediaUrls);
    const isProtectedRoute = assetName !== null || mediaRoute !== null;

    if (!isProtectedRoute) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    if (!token || !this.pairing.authenticate(token)) {
      responseBody(response, 401, "text/plain; charset=utf-8", "Authentication required.");
      return;
    }

    if (assetName) {
      this.serveAsset(assetName, response);
      return;
    }

    if (!mediaRoute) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    if (this.bindMediaUrls && !constantTimeMediaCapabilityEqual(mediaRoute.capability, this.mediaCapability)) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    if (
      request.headers.range !== undefined ||
      request.headers["content-type"] !== undefined ||
      request.headers["content-disposition"] !== undefined
    ) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }
    this.serveMedia(mediaRoute, response);
  }

  private serveAsset(assetName: "index.html" | "phone.js" | "phone.css", response: ServerResponse): void {
    const contentType = assetName === "index.html"
      ? "text/html; charset=utf-8"
      : assetName === "phone.js"
        ? "text/javascript; charset=utf-8"
        : "text/css; charset=utf-8";
    void this.readPhoneAsset(join(this.phoneAssetsDirectory, assetName))
      .then((bytes) => responseBytes(response, 200, contentType, bytes))
      .catch(() => responseBody(response, 404, "text/plain; charset=utf-8", "Not found."));
  }

  private serveMedia(route: PhoneMediaRoute, response: ServerResponse): void {
    let managedPath: string | undefined;
    let managedRoot: string | undefined;
    try {
      if (route.namespace === "context") {
        managedPath = this.context?.getManagedPaths([route.id])[0];
        managedRoot = this.context?.getManagedRoot?.();
      } else {
        managedPath = this.attachments?.getPath(route.id);
        managedRoot = this.attachments?.getManagedRoot?.();
      }
    } catch {
      managedPath = undefined;
      managedRoot = undefined;
    }
    if (!managedPath) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    void this.readMediaFile(managedPath, managedRoot)
      .then((bytes) => responseBytes(response, 200, "image/png", bytes))
      .catch(() => responseBody(response, 404, "text/plain; charset=utf-8", "Not found."));
  }

  private handlePairing(query: string, hasQuery: boolean, response: ServerResponse, remoteAddress: string): void {
    if (!this.pairingFailures.allow(remoteAddress)) {
      responseBody(response, 429, "text/plain; charset=utf-8", "Too many pairing attempts.");
      return;
    }

    const secret = parsePairingSecret(query, hasQuery);
    if (!secret) {
      this.pairingFailures.recordFailure(remoteAddress);
      responseBody(response, 401, "text/plain; charset=utf-8", "Pairing failed.");
      return;
    }

    const exchange = this.pairing.exchange(secret, this.now());
    if (!exchange) {
      this.pairingFailures.recordFailure(remoteAddress);
      responseBody(response, 401, "text/plain; charset=utf-8", "Pairing failed.");
      return;
    }

    this.pairingFailures.recordSuccess();
    this.rotateMediaCapability();
    this.closePhoneClients();
    this.invalidatePairingWork();
    response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${exchange.cookieToken}; HttpOnly; SameSite=Strict; Path=/`);
    response.setHeader("Location", "/");
    this.publishStatus();
    responseEmpty(response, 302);
  }

  private publishStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Renderer/status observers must not affect gateway availability.
      }
    }
  }
}

export { BIND_HOST, PHONE_GATEWAY_PAIRING_TTL_MS, SECURITY_HEADERS };
