import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import type { Socket } from "node:net";
import * as QRCode from "qrcode";
import {
  PHONE_GATEWAY_PAIRING_TTL_MS,
  PHONE_GATEWAY_PORTS,
  type PhoneGatewayStatusListener,
  type PhoneGatewayStatus,
} from "../../src/shared/phone-gateway";
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

const BIND_HOST = "0.0.0.0";
const FALLBACK_PORT = 0;
const SESSION_COOKIE = "fluely_phone_session";
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

const PHONE_SHELL = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fluely Phone Companion</title>
</head>
<body>
  <main><h1>Fluely Phone companion</h1><p>Your paired phone is connected.</p></main>
</body>
</html>
`;

export interface GatewaySocket {
  destroy?: () => void;
  once?: (event: string, listener: () => void) => unknown;
  on?: (event: string, listener: () => void) => unknown;
}

export interface GatewayHttpServer {
  listen(port: number, host: string, callback?: () => void): unknown;
  close(callback?: (error?: Error) => void): unknown;
  address(): { port: number } | string | null;
  on(event: "error" | "connection", listener: (...args: unknown[]) => void): unknown;
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
}

interface ListeningServer {
  server: GatewayHttpServer;
  port: number;
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
  }

  private async closeServer(): Promise<void> {
    this.invalidatePairingWork();
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

  private isAllowedRequestMetadata(request: IncomingMessage): boolean {
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
    return origin === undefined || origin === this.origin;
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

    if (request.method === "GET" && url.pathname === "/") {
      const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
      if (!token || !this.pairing.authenticate(token)) {
        responseBody(response, 401, "text/plain; charset=utf-8", "Authentication required.");
        return;
      }
      responseBody(response, 200, "text/html; charset=utf-8", PHONE_SHELL);
      return;
    }

    responseBody(response, 404, "text/plain; charset=utf-8", "Not found.");
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
