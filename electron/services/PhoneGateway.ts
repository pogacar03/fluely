import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import * as QRCode from "qrcode";
import {
  PHONE_GATEWAY_MAX_FRAME_BYTES,
  parsePhoneClientFrame,
  PHONE_GATEWAY_PAIRING_TTL_MS,
  PHONE_GATEWAY_PORTS,
  serializePhoneServerFrame,
  type ServerFrame,
  type PhoneGatewayStatusListener,
  type PhoneGatewayStatus,
} from "../../src/shared/phone-gateway";
import type {
  SessionProjectionEvent,
  SessionProjectionPort,
} from "../../src/shared/conversation";
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
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

const BIND_HOST = "0.0.0.0";
const FALLBACK_PORT = 0;
const SESSION_COOKIE = "fluely_phone_session";
const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
}

export interface PhoneGatewayAttachmentSource {
  getPath(id: string): string | undefined;
}

export type PhoneGatewayFileReader = (path: string) => Promise<Uint8Array>;

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
}

interface ListeningServer {
  server: GatewayHttpServer;
  port: number;
}

interface PhoneClient {
  socket: WebSocket;
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
  | { namespace: "context"; id: string }
  | { namespace: "attachments"; id: string };

function parseMediaRoute(pathname: string, search: string, hash: string): PhoneMediaRoute | null {
  if (search || hash) {
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
    const rawId = pathname.slice(prefix.length);
    if (!rawId || rawId.includes("/")) {
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
    return { namespace, id };
  }
  return null;
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
  private readonly readManagedFile: PhoneGatewayFileReader;
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
  private lastBroadcastRevision = 0;

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
    this.projection = options.projection ? createPhoneProjection(options.projection) : null;
    this.context = options.context ?? null;
    this.attachments = options.attachments ?? null;
    this.phoneAssetsDirectory = options.phoneAssetsDirectory ?? PHONE_ASSET_DIRECTORY;
    this.readManagedFile = options.readFile ?? (async (path) => new Uint8Array(await readFile(path)));
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
    webSocketServer.on("connection", (socket) => this.acceptWebSocket(socket));
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
    if (client.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      client.socket.send(serializePhoneServerFrame(frame));
    } catch {
      try {
        client.socket.terminate();
      } catch {
        // The socket may already be closing.
      }
    }
  }

  private acceptWebSocket(socket: WebSocket): void {
    if (!this.projection) {
      socket.close(1011, "Phone projection unavailable.");
      return;
    }

    const client: PhoneClient = { socket };
    this.phoneClients.add(client);
    const remove = () => {
      this.phoneClients.delete(client);
    };
    socket.once("close", remove);
    socket.once("error", remove);
    socket.on("message", (data: RawData) => this.handleClientFrame(client, data));
    const snapshot = this.projection.getSnapshot();
    this.sendFrame(client, {
      type: "snapshot",
      revision: snapshot.revision,
      payload: snapshot,
    });
  }

  private handleClientFrame(client: PhoneClient, data: RawData): void {
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
      return;
    }

    if (frame.type === "ping") {
      this.sendFrame(client, { type: "pong", at: frame.at });
      return;
    }

    if (!this.projection) {
      return;
    }
    const snapshot = this.projection.getSnapshot();
    this.sendFrame(client, {
      type: "snapshot",
      revision: snapshot.revision,
      payload: snapshot,
    });
  }

  private handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://fluely.invalid");
    } catch {
      this.rejectUpgrade(socket, 404, "Not found.");
      return;
    }

    if (
      request.method !== "GET" ||
      url.pathname !== "/ws" ||
      url.search ||
      url.hash ||
      !this.isAllowedRequestMetadata(request, true)
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
    } finally {
      socket.destroy();
    }
  }

  private closePhoneClients(): void {
    for (const client of [...this.phoneClients]) {
      try {
        client.socket.close(1001, "Phone session ended.");
        client.socket.terminate();
      } catch {
        // A peer can close concurrently while pairing or stopping.
      }
    }
    this.phoneClients.clear();
  }

  private async closeServer(): Promise<void> {
    this.invalidatePairingWork();
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
    const allowedHosts = new Set([
      new URL(this.origin).host,
      `127.0.0.1:${this.selectedPort}`,
      `localhost:${this.selectedPort}`,
    ]);
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      return false;
    }

    const origin = request.headers.origin;
    return requireOrigin ? origin === this.origin : origin === undefined || origin === this.origin;
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }

    if (!this.isAllowedRequestMetadata(request)) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://fluely.invalid");
    } catch {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    if (request.method === "GET" && url.pathname === "/pair") {
      this.handlePairing(url, response, request.socket?.remoteAddress ?? "<unknown>");
      return;
    }

    if (request.method !== "GET") {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    const assetName = url.pathname === "/" && !url.search && !url.hash
      ? "index.html"
      : url.pathname === "/phone.js" && !url.search && !url.hash
        ? "phone.js"
        : url.pathname === "/phone.css" && !url.search && !url.hash
          ? "phone.css"
          : null;
    const mediaRoute = parseMediaRoute(url.pathname, url.search, url.hash);
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
    void this.readManagedFile(join(this.phoneAssetsDirectory, assetName))
      .then((bytes) => responseBytes(response, 200, contentType, bytes))
      .catch(() => responseBody(response, 404, "text/plain; charset=utf-8", "Not found."));
  }

  private serveMedia(route: PhoneMediaRoute, response: ServerResponse): void {
    let managedPath: string | undefined;
    try {
      managedPath = route.namespace === "context"
        ? this.context?.getManagedPaths([route.id])[0]
        : this.attachments?.getPath(route.id);
    } catch {
      managedPath = undefined;
    }
    if (!managedPath) {
      responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }

    void this.readManagedFile(managedPath)
      .then((bytes) => responseBytes(response, 200, "image/png", bytes))
      .catch(() => responseBody(response, 404, "text/plain; charset=utf-8", "Not found."));
  }

  private handlePairing(url: URL, response: ServerResponse, remoteAddress: string): void {
    if (!this.pairingFailures.allow(remoteAddress)) {
      responseBody(response, 429, "text/plain; charset=utf-8", "Too many pairing attempts.");
      return;
    }

    const secrets = url.searchParams.getAll("secret");
    if (secrets.length !== 1 || !secrets[0]) {
      this.pairingFailures.recordFailure(remoteAddress);
      responseBody(response, 401, "text/plain; charset=utf-8", "Pairing failed.");
      return;
    }

    const exchange = this.pairing.exchange(secrets[0], this.now());
    if (!exchange) {
      this.pairingFailures.recordFailure(remoteAddress);
      responseBody(response, 401, "text/plain; charset=utf-8", "Pairing failed.");
      return;
    }

    this.pairingFailures.recordSuccess();
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
