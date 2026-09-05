import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { connect as connectNet } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, afterEach } from "node:test";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayPath = path.resolve(__dirname, "../../../dist-electron/electron/services/PhoneGateway.js");
const pairingPath = path.resolve(__dirname, "../../../dist-electron/electron/services/pairing-session.js");
let gatewayModule;
let pairingModule;
try {
  gatewayModule = await import(pathToFileURL(gatewayPath).href);
  pairingModule = await import(pathToFileURL(pairingPath).href);
} catch {
  gatewayModule = {};
  pairingModule = {};
}

const gateways = [];
const temporaryDirectories = [];

class FakeServer {
  constructor(handler, unavailablePorts = new Set()) {
    this.handler = handler;
    this.unavailablePorts = unavailablePorts;
    this.listeners = new Map();
    this.listenCalls = [];
    this.closeCalls = 0;
    this.port = null;
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event, listener) {
    const wrapped = (...args) => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  removeListener(event, listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener));
    return this;
  }

  emit(event, ...args) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  listen(port, host, callback) {
    this.listenCalls.push({ port, host });
    if (this.unavailablePorts.has(port)) {
      queueMicrotask(() => this.emit("error", Object.assign(new Error("address unavailable"), { code: "EADDRINUSE" })));
      return this;
    }
    this.port = port === 0 ? 45678 : port;
    queueMicrotask(() => callback());
    return this;
  }

  address() {
    return this.port === null ? null : { address: "0.0.0.0", family: "IPv4", port: this.port };
  }

  close(callback) {
    this.closeCalls += 1;
    this.port = null;
    queueMicrotask(() => callback?.());
  }
}

function randomBytesFactory() {
  let value = 0;
  return (size) => {
    value += 1;
    return Buffer.alloc(size, value);
  };
}

function makeGateway({
  unavailablePorts = new Set(),
  portCandidates,
  createServer,
  qrUrls,
  qrCode,
  networkInterfaces,
  now,
  timer,
  pairingFailureRateLimit,
  projection,
  context,
  attachments,
  phoneAssetsDirectory,
  readMediaFile,
  commandRouter,
  onCommandError,
  mediaCapabilityFactory,
} = {}) {
  const servers = [];
  const clock = now ?? (() => 10_000);
  const gateway = new gatewayModule.PhoneGateway({
    networkInterfaces: networkInterfaces ?? (() => ({
      en0: [{ address: "192.168.50.8", family: "IPv4", internal: false }],
    })),
    createServer: createServer ?? ((handler) => {
      const server = new FakeServer(handler, unavailablePorts);
      servers.push(server);
      return server;
    }),
    pairing: pairingModule.createPairingSessionManager({
      now: clock,
      randomBytes: randomBytesFactory(),
    }),
    qrCode: qrCode ?? {
      toDataURL: async (url) => {
        qrUrls?.push(url);
        return `data:image/png;base64,${Buffer.from(url).toString("base64")}`;
      },
    },
    now: clock,
    ...(timer ? { timer } : {}),
    ...(pairingFailureRateLimit ? { pairingFailureRateLimit } : {}),
    ...(portCandidates ? { portCandidates } : {}),
    ...(projection ? { projection } : {}),
    ...(context ? { context } : {}),
    ...(attachments ? { attachments } : {}),
    ...(phoneAssetsDirectory ? { phoneAssetsDirectory } : {}),
    ...(readMediaFile ? { readMediaFile } : {}),
    ...(commandRouter ? { commandRouter } : {}),
    ...(onCommandError ? { onCommandError } : {}),
    ...(mediaCapabilityFactory ? { mediaCapabilityFactory } : {}),
  });
  gateways.push(gateway);
  return { gateway, servers };
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("gateway is disabled by default, binds only when started, falls back deterministically, and stops idempotently", async () => {
  assert.equal(typeof gatewayModule.PhoneGateway, "function");
  const { gateway, servers } = makeGateway({
    unavailablePorts: new Set([4123, 4124, 4125, 4126, 4127, 4128, 4129, 4130, 4131, 4132, 4133, 4134]),
  });

  assert.deepEqual(gateway.getStatus(), { state: "disabled" });
  assert.equal(servers.length, 0);

  const ready = await gateway.start();
  assert.equal(ready.state, "ready");
  assert.equal(ready.origin, "http://192.168.50.8:45678");
  assert.equal(servers[0].listenCalls.length, 1);
  assert.equal(servers[0].listenCalls[0].host, "0.0.0.0");
  assert.deepEqual(servers.flatMap((server) => server.listenCalls.map((call) => call.port)), [
    4123, 4124, 4125, 4126, 4127, 4128,
    4129, 4130, 4131, 4132, 4133, 4134, 0,
  ]);
  assert.equal((await gateway.start()).origin, ready.origin);

  const stopped = await gateway.stop();
  assert.deepEqual(stopped, { state: "disabled" });
  assert.equal(servers.at(-1).closeCalls, 1);
  assert.deepEqual(await gateway.stop(), { state: "disabled" });
});

test("gateway refuses to listen without a private LAN address", async () => {
  assert.equal(typeof gatewayModule.PhoneGateway, "function");
  const created = [];
  const gateway = new gatewayModule.PhoneGateway({
    networkInterfaces: () => ({ en0: [{ address: "8.8.8.8", family: "IPv4", internal: false }] }),
    createServer: () => { created.push(true); return new FakeServer(() => undefined); },
  });
  gateways.push(gateway);

  assert.deepEqual(await gateway.start(), {
    state: "error",
    code: "no_lan_address",
    message: "No private LAN address is available.",
  });
  assert.equal(created.length, 0);
});

function request(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = createHttpServer;
    void request;
    const client = import("node:http").then(({ request: makeRequest }) => {
      const req = makeRequest({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      req.on("error", reject);
      req.end();
    });
    void client.catch(reject);
  });
}

function requestBuffer(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request: makeRequest }) => {
      const req = makeRequest({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      req.on("error", reject);
      req.end();
    }).catch(reject);
  });
}

function rawRequest(port, requestTarget, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectNet({ host: "127.0.0.1", port });
    const chunks = [];
    let settled = false;
    const maybeFinishResponse = () => {
      const raw = Buffer.concat(chunks);
      const separator = raw.indexOf(Buffer.from("\r\n\r\n"));
      if (separator < 0) return;
      const headerText = raw.subarray(0, separator).toString("latin1");
      const length = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(headerText)?.[1];
      if (length === undefined) return;
      const bodyLength = Number(length);
      if (Number.isSafeInteger(bodyLength) && raw.byteLength >= separator + 4 + bodyLength) {
        finish();
        socket.destroy();
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString("latin1"));
      }
    };
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      maybeFinishResponse();
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
    socket.setTimeout(2_000, () => {
      socket.destroy(new Error("raw request timed out"));
    });
    socket.once("connect", () => {
      const requestHeaders = {
        Host: `127.0.0.1:${port}`,
        Connection: "close",
        ...headers,
      };
      const lines = [
        `GET ${requestTarget} HTTP/1.1`,
        ...Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      // Keep the client readable until the async application handler has written
      // its response. Half-closing here makes Node close the request before an
      // async media read can finish, which tests the transport rather than the
      // gateway's raw-target boundary.
      socket.write(lines.join("\r\n"));
    });
  });
}

function createLoopbackServer(handler) {
  const server = createHttpServer(handler);
  const listen = server.listen.bind(server);
  server.listen = (port, _host, callback) => listen(port, "127.0.0.1", callback);
  return server;
}

function parseRawResponse(raw) {
  const separator = raw.indexOf("\r\n\r\n");
  const headerText = separator >= 0 ? raw.slice(0, separator) : raw;
  const body = separator >= 0 ? raw.slice(separator + 4) : "";
  const lines = headerText.split("\r\n");
  const statusCode = Number(lines[0]?.split(" ")[1]);
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { statusCode, headers, body };
}

function assertRawSafeHeaders(response) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.match(response.headers["content-security-policy"], /default-src 'none'/);
}

function makeUpgradeSocket() {
  const writes = [];
  return {
    writes,
    destroyed: false,
    write(value) {
      writes.push(String(value));
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test("raw request target parser accepts only strict origin-form paths without ambiguous encodings", () => {
  assert.equal(typeof gatewayModule.parseRawRequestTarget, "function");
  const valid = gatewayModule.parseRawRequestTarget("/api/context/11111111-1111-4111-8111-111111111111");
  assert.deepEqual(valid, {
    path: "/api/context/11111111-1111-4111-8111-111111111111",
    query: "",
    hasQuery: false,
  });
  assert.deepEqual(gatewayModule.parseRawRequestTarget("/pair?secret=abc"), {
    path: "/pair",
    query: "secret=abc",
    hasQuery: true,
  });

  for (const target of [
    "http://192.168.50.8:4123/api/context/11111111-1111-4111-8111-111111111111",
    "//192.168.50.8:4123/api/context/11111111-1111-4111-8111-111111111111",
    "/api/context/../context/11111111-1111-4111-8111-111111111111",
    "/api/context/%2e%2e/context/11111111-1111-4111-8111-111111111111",
    "/api/context/%252e%252e/context/11111111-1111-4111-8111-111111111111",
    "/api/context/%2f11111111-1111-4111-8111-111111111111",
    "/api/context/%252f11111111-1111-4111-8111-111111111111",
    "/api/context/%5c11111111-1111-4111-8111-111111111111",
    "/api/context/%00/11111111-1111-4111-8111-111111111111",
    "/api/context/11111111-1111-4111-8111-111111111111?cache=1",
  ]) {
    const parsed = gatewayModule.parseRawRequestTarget(target);
    if (target.includes("?cache=1")) {
      assert.deepEqual(parsed, {
        path: "/api/context/11111111-1111-4111-8111-111111111111",
        query: "cache=1",
        hasQuery: true,
      });
    } else {
      assert.equal(parsed, null, target);
    }
  }
});

test("authenticated media routing decodes a percent-encoded business ID only once", async () => {
  const contextId = "11111111-1111-4111-8111-111111111111";
  const qrUrls = [];
  const requestedIds = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    context: {
      getManagedPaths: (ids) => {
        requestedIds.push([...ids]);
        return ["/managed/context.png"];
      },
    },
    readMediaFile: async () => Buffer.from("png"),
  });
  await gateway.start();
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const exchanged = await invokeHandler(gateway, `/pair?secret=${secret}`);
  assert.equal(exchanged.statusCode, 302);

  const originalDecodeURIComponent = globalThis.decodeURIComponent;
  let decodeCount = 0;
  globalThis.decodeURIComponent = (value) => {
    decodeCount += 1;
    return originalDecodeURIComponent(value);
  };
  try {
    const response = await invokeHandler(gateway, "/api/context/%31" + contextId.slice(1), {
      headers: { cookie: exchanged.headers["set-cookie"] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(requestedIds, [[contextId]]);
    assert.equal(decodeCount, 1);
  } finally {
    globalThis.decodeURIComponent = originalDecodeURIComponent;
  }
});

function makeProjection(initialSnapshot) {
  let snapshot = structuredClone(initialSnapshot);
  let snapshotReads = 0;
  const listeners = new Set();
  return {
    getSnapshot: () => {
      snapshotReads += 1;
      return structuredClone(snapshot);
    },
    getSnapshotReadCount: () => snapshotReads,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(event, nextSnapshot) {
      snapshot = structuredClone(nextSnapshot ?? snapshot);
      for (const listener of listeners) {
        listener(structuredClone(event));
      }
    },
  };
}

function makeGatewayTimer() {
  const entries = [];
  return {
    entries,
    setTimeout(callback, delay) {
      const entry = { callback, delay, cleared: false };
      entries.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) entry.cleared = true;
    },
    fire(entry) {
      entry.callback();
    },
    active() {
      return entries.filter((entry) => !entry.cleared);
    },
  };
}

function makeGatewaySocket({ bufferedAmount = 0 } = {}) {
  const listeners = new Map();
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    sent: [],
    pings: 0,
    closeCalls: [],
    terminated: false,
    on(event, listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return socket;
    },
    once(event, listener) {
      const wrapped = (...args) => {
        socket.removeListener(event, wrapped);
        listener(...args);
      };
      return socket.on(event, wrapped);
    },
    removeListener(event, listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((candidate) => candidate !== listener));
      return socket;
    },
    emit(event, ...args) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args);
      }
    },
    send(value) {
      socket.sent.push(String(value));
    },
    ping() {
      socket.pings += 1;
    },
    close(code, reason) {
      socket.closeCalls.push({ code, reason });
      socket.readyState = WebSocket.CLOSED;
      socket.emit("close");
    },
    terminate() {
      socket.terminated = true;
      socket.readyState = WebSocket.CLOSED;
      socket.emit("close");
    },
  };
  return socket;
}

function commandResult() {
  return {
    queue: { items: [], capturing: false, permission: "granted" },
    conversation: { sessionId: "session-phone-command", revision: 0, messages: [], attachments: [] },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForSentFrame(socket, predicate, timeoutMs = 2_000, startIndex = 0) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const frame = socket.sent.slice(startIndex).map((value) => JSON.parse(value)).find(predicate);
    if (frame) {
      return frame;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the expected phone gateway frame.");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function invokeHandler(gateway, requestPath, {
  method = "GET",
  remoteAddress = "192.168.50.20",
  headers = {},
} = {}) {
  return new Promise((resolve) => {
    const responseHeaders = {};
    const response = {
      statusCode: 200,
      setHeader(name, value) {
        responseHeaders[name.toLowerCase()] = value;
      },
      end(body = "") {
        resolve({
          statusCode: response.statusCode,
          headers: responseHeaders,
          body: String(body),
        });
      },
    };
    const status = gateway.getStatus();
    gateway.handleRequest({
      method,
      url: requestPath,
      headers: {
        host: status.state === "ready" ? new URL(status.origin).host : "",
        ...headers,
      },
      socket: { remoteAddress },
    }, response);
  });
}

test("invalid WebSocket handshakes are rejected before ws handling with safe headers", async () => {
  const qrUrls = [];
  const { gateway } = makeGateway({ portCandidates: [0], qrUrls });
  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const exchanged = await invokeHandler(gateway, `/pair?secret=${secret}`);
  const cookie = exchanged.headers["set-cookie"].match(/^(fluely_phone_session=[^;]+)/)[1];
  let handleUpgradeCalls = 0;
  gateway.webSocketServer = {
    handleUpgrade() {
      handleUpgradeCalls += 1;
    },
  };
  const baseRequest = {
    method: "GET",
    url: "/ws",
    headers: {
      host: `192.168.50.8:${port}`,
      origin: ready.origin,
      cookie,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from("the sample nonce").toString("base64"),
    },
  };

  const invalidRequests = [
    { label: "missing connection", headers: { connection: undefined } },
    { label: "wrong connection", headers: { connection: "keep-alive" } },
    { label: "missing upgrade", headers: { upgrade: undefined } },
    { label: "wrong upgrade", headers: { upgrade: "h2c" } },
    { label: "wrong version", headers: { "sec-websocket-version": "12" } },
    { label: "malformed key", headers: { "sec-websocket-key": "not-base64" } },
    { label: "short key", headers: { "sec-websocket-key": Buffer.alloc(15).toString("base64") } },
    { label: "traversal target", url: "/ws/../ws", headers: {} },
    { label: "query target", url: "/ws?cache=1", headers: {} },
  ];

  for (const invalid of invalidRequests) {
    const socket = makeUpgradeSocket();
    const request = {
      ...baseRequest,
      ...(invalid.url ? { url: invalid.url } : {}),
      headers: { ...baseRequest.headers, ...invalid.headers },
    };
    gateway.handleUpgrade(request, socket, Buffer.alloc(0));
    const response = parseRawResponse(socket.writes.join(""));
    assert.equal(response.statusCode, 404, invalid.label);
    assertRawSafeHeaders(response);
    assert.equal(response.headers.connection, "close", invalid.label);
    assert.equal(response.headers["sec-websocket-accept"], undefined, invalid.label);
    assert.equal(response.body, "Not found.", invalid.label);
    assert.equal(socket.destroyed, true, invalid.label);
  }
  assert.equal(handleUpgradeCalls, 0);
});

test("illegal WebSocket methods are rejected with the same safe closed handshake", async () => {
  const { gateway } = makeGateway({ portCandidates: [0] });
  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const baseRequest = {
    url: "/ws",
    headers: {
      host: `192.168.50.8:${port}`,
      origin: ready.origin,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
    },
  };

  for (const method of ["POST", "PUT", "HEAD", "get", "PATCH"]) {
    const socket = makeUpgradeSocket();
    gateway.handleUpgrade({ ...baseRequest, method }, socket, Buffer.alloc(0));
    const response = parseRawResponse(socket.writes.join(""));
    assert.equal(response.statusCode, 404, method);
    assertRawSafeHeaders(response);
    assert.equal(response.headers.connection, "close", method);
    assert.equal(socket.destroyed, true, method);
  }
});

test("HTTP and WebSocket application boundaries reject the same unsafe target matrix with safe failures", async () => {
  const { gateway } = makeGateway({ portCandidates: [0] });
  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const host = `192.168.50.8:${port}`;
  const targets = [
    "/api/context/../context/11111111-1111-4111-8111-111111111111",
    "/api/context/%2e%2e/context/11111111-1111-4111-8111-111111111111",
    "/api/context/%252e%252e/context/11111111-1111-4111-8111-111111111111",
    "/api/context/11111111-1111-4111-8111-111111111111%2f..%2f11111111-1111-4111-8111-111111111111",
    "/api/context/11111111-1111-4111-8111-111111111111%252f..%252f11111111-1111-4111-8111-111111111111",
    "/api/context/11111111-1111-4111-8111-111111111111%5c..%5c11111111-1111-4111-8111-111111111111",
    "/api/context/11111111-1111-4111-8111-111111111111%255c..%255c11111111-1111-4111-8111-111111111111",
    "/api/context/11111111-1111-4111-8111-111111111111?cache=1",
    "/api/context/\t11111111-1111-4111-8111-111111111111",
    "/api/context/\u000011111111-1111-4111-8111-111111111111",
    "/api/context/\u007f11111111-1111-4111-8111-111111111111",
  ];

  for (const target of targets) {
    const response = await invokeHandler(gateway, target);
    assert.equal(response.statusCode, 404, `HTTP ${JSON.stringify(target)}`);
    assertSafeHeaders(response);
  }

  for (const target of targets) {
    const socket = makeUpgradeSocket();
    gateway.handleUpgrade({
      method: "GET",
      url: target,
      headers: {
        host,
        origin: ready.origin,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.alloc(16, 8).toString("base64"),
      },
    }, socket, Buffer.alloc(0));
    const response = parseRawResponse(socket.writes.join(""));
    assert.equal(response.statusCode, 404, `WS ${JSON.stringify(target)}`);
    assertRawSafeHeaders(response);
    assert.equal(response.headers.connection, "close", `WS ${JSON.stringify(target)}`);
    assert.equal(socket.destroyed, true, `WS ${JSON.stringify(target)}`);
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function makeFakeTimer() {
  const entries = [];
  return {
    entries,
    setTimeout(callback, delay) {
      const entry = { callback, delay, cleared: false };
      entries.push(entry);
      return entry;
    },
    clearTimeout(entry) {
      if (entry) {
        entry.cleared = true;
      }
    },
    fire(entry) {
      entry.callback();
    },
  };
}

function assertSafeHeaders(response) {
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.match(response.headers["content-security-policy"], /default-src 'none'/);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
}

test("authenticated shell and pairing exchange use safe headers and never redirect with a secret", async () => {
  assert.equal(typeof gatewayModule.PhoneGateway, "function");
  assert.equal(typeof pairingModule.createPairingSessionManager, "function");
  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    createServer: (handler) => createLoopbackServer(handler),
  });
  const ready = await gateway.start();
  assert.equal(ready.state, "ready");
  const port = Number(new URL(ready.origin).port);
  const secretUrl = qrUrls[0];
  assert.ok(secretUrl);
  const secret = new URL(secretUrl).searchParams.get("secret");
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(ready.origin.includes(secret), false);

  const assertSafeHeaders = (response) => {
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.match(response.headers["content-security-policy"], /default-src 'none'/);
    assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  };

  const unauthorized = await request(port, "/");
  assert.equal(unauthorized.statusCode, 401);
  assertSafeHeaders(unauthorized);
  assert.equal(unauthorized.body.includes(secret), false);
  assert.equal(unauthorized.body.includes("/Users/"), false);

  const unknown = await request(port, "/not-a-route");
  assert.equal(unknown.statusCode, 404);
  assertSafeHeaders(unknown);

  const exchanged = await request(port, `/pair?secret=${secret}`);
  assert.equal(exchanged.statusCode, 302);
  assert.equal(exchanged.headers.location, "/");
  assertSafeHeaders(exchanged);
  assert.equal(exchanged.headers.location.includes(secret), false);
  const setCookie = exchanged.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  const token = setCookie.match(/^fluely_phone_session=([^;]+)/)?.[1];
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(setCookie.includes(secret), false);

  const authorized = await request(port, "/", { Cookie: `fluely_phone_session=${token}` });
  assert.equal(authorized.statusCode, 200);
  assertSafeHeaders(authorized);
  assert.match(authorized.body, /Phone companion/);
  assert.equal(authorized.body.includes(secret), false);
  assert.equal(gateway.getStatus().state, "ready");
  assert.equal(gateway.getStatus().paired, true);
});

test("gateway broadcasts paired state and replacement pairing revokes the old cookie immediately", async () => {
  assert.equal(typeof gatewayModule.PhoneGateway, "function");
  const qrUrls = [];
  const statusEvents = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    createServer: (handler) => createLoopbackServer(handler),
  });
  const unsubscribe = gateway.onStatusChanged?.((status) => statusEvents.push(status));
  assert.equal(typeof unsubscribe, "function");

  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const firstSecret = new URL(qrUrls[0]).searchParams.get("secret");
  const firstExchange = await request(port, `/pair?secret=${firstSecret}`);
  const firstCookie = firstExchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];
  assert.equal(gateway.getStatus().paired, true);
  assert.equal(statusEvents.at(-1).paired, true);

  const replacement = await gateway.regeneratePairing();
  assert.equal(replacement.state, "ready");
  assert.equal(replacement.paired, false);
  assert.equal(statusEvents.at(-1).paired, false);
  const secondSecret = new URL(qrUrls[1]).searchParams.get("secret");
  const oldPhone = await request(port, "/", { Cookie: firstCookie });
  assert.equal(oldPhone.statusCode, 401);

  const secondExchange = await request(port, `/pair?secret=${secondSecret}`);
  const secondCookie = secondExchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];
  assert.equal((await request(port, "/", { Cookie: secondCookie })).statusCode, 200);
  assert.equal(gateway.getStatus().paired, true);
  assert.equal(statusEvents.at(-1).paired, true);

  await gateway.stop();
  assert.equal(statusEvents.at(-1).state, "disabled");
  unsubscribe();
});

test("gateway rejects non-canonical private addresses before constructing an advertised origin", async () => {
  assert.equal(typeof gatewayModule.PhoneGateway, "function");
  const { gateway } = makeGateway({
    networkInterfaces: () => ({
      en0: [{ address: "010.8.8.8", family: "IPv4", internal: false }],
    }),
  });

  assert.deepEqual(await gateway.start(), {
    state: "error",
    code: "no_lan_address",
    message: "No private LAN address is available.",
  });
});

test("pairing failures are bounded per socket address and globally with generic 429 responses", async () => {
  assert.equal(typeof gatewayModule.PhoneGateway, "function");
  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    pairingFailureRateLimit: {
      windowMs: 1_000,
      maxFailuresPerAddress: 3,
      maxFailuresGlobal: 4,
      maxTrackedAddresses: 8,
    },
  });
  await gateway.start();

  for (const requestPath of ["/pair", "/pair?secret=", "/pair?secret=one&secret=two"]) {
    const response = await invokeHandler(gateway, requestPath, {
      remoteAddress: "192.168.50.21",
      headers: { "x-forwarded-for": "192.168.50.99" },
    });
    assert.equal(response.statusCode, 401, requestPath);
    assert.equal(response.body, "Pairing failed.");
    assertSafeHeaders(response);
  }

  const perAddressLimited = await invokeHandler(gateway, "/pair?secret=wrong", {
    remoteAddress: "192.168.50.21",
    headers: { "x-forwarded-for": "192.168.50.99" },
  });
  assert.equal(perAddressLimited.statusCode, 429);
  assert.equal(perAddressLimited.body, "Too many pairing attempts.");
  assertSafeHeaders(perAddressLimited);

  const otherAddress = await invokeHandler(gateway, "/pair?secret=wrong", {
    remoteAddress: "192.168.50.22",
  });
  assert.equal(otherAddress.statusCode, 401);

  const globalLimited = await invokeHandler(gateway, "/pair?secret=wrong", {
    remoteAddress: "192.168.50.23",
  });
  assert.equal(globalLimited.statusCode, 429);
  assert.equal(globalLimited.body, "Too many pairing attempts.");
  assertSafeHeaders(globalLimited);
});

test("successful pairing clears prior failure limits and stop clears limits before restart", async () => {
  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    pairingFailureRateLimit: {
      windowMs: 60_000,
      maxFailuresPerAddress: 5,
      maxFailuresGlobal: 3,
      maxTrackedAddresses: 8,
    },
  });
  await gateway.start();
  const secret = new URL(qrUrls[0]).searchParams.get("secret");

  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.30" })).statusCode, 401);
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.31" })).statusCode, 401);
  assert.equal((await invokeHandler(gateway, `/pair?secret=${secret}`, { remoteAddress: "192.168.50.32" })).statusCode, 302);
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.32" })).statusCode, 401);
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.32" })).statusCode, 401);
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.32" })).statusCode, 401);
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.32" })).statusCode, 429);

  await gateway.stop();
  await gateway.start();
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", { remoteAddress: "192.168.50.32" })).statusCode, 401);
});

test("gateway keeps the B1 GET Host and Origin boundary and does not add write routes", async () => {
  const { gateway } = makeGateway({ portCandidates: [0] });
  const ready = await gateway.start();
  const host = new URL(ready.origin).host;

  assert.equal((await invokeHandler(gateway, "/", { headers: { host: "attacker.invalid" } })).statusCode, 404);
  assert.equal((await invokeHandler(gateway, "/", { headers: { origin: "http://attacker.invalid" } })).statusCode, 404);
  assert.equal((await invokeHandler(gateway, "/pair?secret=wrong", {
    method: "POST",
    headers: { host },
  })).statusCode, 404);
});

test("late concurrent QR generation cannot overwrite the latest valid pairing", async () => {
  const qrCalls = [];
  const qrDeferreds = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrCode: {
      toDataURL: (url) => {
        const pending = deferred();
        qrCalls.push(url);
        qrDeferreds.push(pending);
        return pending.promise;
      },
    },
  });

  const starting = gateway.start();
  assert.equal(qrDeferreds.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(qrDeferreds.length, 1);
  qrDeferreds[0].resolve("data:image/png;base64,start");
  await starting;

  const first = gateway.regeneratePairing();
  const second = gateway.regeneratePairing();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(qrDeferreds.length, 3);

  qrDeferreds[2].resolve("data:image/png;base64,latest");
  await second;
  qrDeferreds[1].resolve("data:image/png;base64,stale");
  await first;

  const status = gateway.getStatus();
  assert.equal(status.state, "ready");
  assert.equal(status.qrDataUrl, "data:image/png;base64,latest");
  assert.equal(new URL(qrCalls[2]).searchParams.get("secret") !== new URL(qrCalls[1]).searchParams.get("secret"), true);
  assert.equal(new URL(status.qrDataUrl).search, "");
});

test("a stale QR rejection from before stop/restart cannot tear down the restarted gateway", async () => {
  const qrDeferreds = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrCode: {
      toDataURL: () => {
        const pending = deferred();
        qrDeferreds.push(pending);
        return pending.promise;
      },
    },
  });

  const starting = gateway.start();
  await new Promise((resolve) => setImmediate(resolve));
  qrDeferreds[0].resolve("data:image/png;base64,start");
  await starting;

  const stale = gateway.regeneratePairing();
  await new Promise((resolve) => setImmediate(resolve));
  await gateway.stop();

  const restarting = gateway.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(qrDeferreds.length, 3);
  qrDeferreds[2].resolve("data:image/png;base64,restarted");
  await restarting;
  qrDeferreds[1].reject(new Error("stale QR failure"));
  await stale;

  assert.deepEqual(gateway.getStatus(), {
    state: "ready",
    origin: "http://192.168.50.8:45678",
    qrDataUrl: "data:image/png;base64,restarted",
    pairingExpiresAt: 130_000,
    paired: false,
  });
});

test("stop revokes pending pairing before an in-flight QR generation finishes", async () => {
  const qrDeferreds = [];
  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    qrCode: {
      toDataURL: (url) => {
        const pending = deferred();
        qrUrls.push(url);
        qrDeferreds.push(pending);
        return pending.promise;
      },
    },
  });

  const starting = gateway.start();
  await new Promise((resolve) => setImmediate(resolve));
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const stopping = gateway.stop();
  const duringStop = await invokeHandler(gateway, `/pair?secret=${secret}`, {
    headers: { host: "192.168.50.8:45678" },
  });
  assert.equal(duringStop.statusCode, 401);

  qrDeferreds[0].resolve("data:image/png;base64,stopped");
  await starting;
  await stopping;
  assert.deepEqual(gateway.getStatus(), { state: "disabled" });
});

test("pairing expiry clears the QR and pending secret, broadcasts status, and uses an injectable timer", async () => {
  const timer = makeFakeTimer();
  const qrUrls = [];
  const statusEvents = [];
  const { gateway } = makeGateway({ portCandidates: [0], qrUrls, timer });
  gateway.onStatusChanged((status) => statusEvents.push(status));
  await gateway.start();
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  assert.equal(timer.entries.length, 1);
  assert.equal(timer.entries[0].delay, 120_000);

  timer.fire(timer.entries[0]);

  assert.deepEqual(gateway.getStatus(), {
    state: "ready",
    origin: "http://192.168.50.8:45678",
    qrDataUrl: "",
    pairingExpiresAt: 130_000,
    paired: false,
  });
  assert.equal(statusEvents.at(-1).qrDataUrl, "");
  assert.equal((await invokeHandler(gateway, `/pair?secret=${secret}`)).statusCode, 401);
});

test("regeneration and stop invalidate old timers so stale callbacks cannot clear newer state", async () => {
  const timer = makeFakeTimer();
  const { gateway } = makeGateway({ portCandidates: [0], timer });
  await gateway.start();
  const firstTimer = timer.entries[0];
  const regenerated = await gateway.regeneratePairing();
  const secondTimer = timer.entries[1];
  assert.equal(firstTimer.cleared, true);
  assert.equal(secondTimer.cleared, false);

  timer.fire(firstTimer);
  assert.equal(gateway.getStatus().qrDataUrl, regenerated.qrDataUrl);

  await gateway.stop();
  assert.equal(secondTimer.cleared, true);
  timer.fire(secondTimer);
  assert.deepEqual(gateway.getStatus(), { state: "disabled" });
});

test("authenticated phone assets and media routes return exact bytes and generic safe failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-media-test-"));
  temporaryDirectories.push(root);
  const contextPath = path.join(root, "context.png");
  const attachmentPath = path.join(root, "attachment.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x04, 0x05, 0x06]);
  await writeFile(contextPath, pngBytes, { mode: 0o600 });
  await writeFile(attachmentPath, pngBytes, { mode: 0o600 });
  const contextId = "11111111-1111-4111-8111-111111111111";
  const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const qrCalls = [];
  const mediaCapability = "a".repeat(64);
  const pairedGateway = makeGateway({
    portCandidates: [0],
    qrUrls: qrCalls,
    createServer: (handler) => createLoopbackServer(handler),
    context: {
      getManagedPaths: (ids) => ids[0] === contextId ? [contextPath] : [],
      getManagedRoot: () => root,
    },
    attachments: {
      getPath: (id) => id === attachmentId ? attachmentPath : undefined,
      getManagedRoot: () => root,
    },
    projection: {
      getSnapshot: () => ({ revision: 0, conversation: {
        sessionId: "session-phone",
        revision: 0,
        messages: [],
        attachments: [],
      }, queue: [] }),
      subscribe: () => () => undefined,
    },
    mediaCapabilityFactory: () => mediaCapability,
  }).gateway;
  const pairedReady = await pairedGateway.start();
  const pairedPort = Number(new URL(pairedReady.origin).port);
  const pairingSecret = new URL(qrCalls[0]).searchParams.get("secret");
  const exchange = await request(pairedPort, `/pair?secret=${pairingSecret}`);
  const cookieHeader = exchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];
  const contextRoute = `/api/context/${mediaCapability}/${contextId}`;
  const attachmentRoute = `/api/attachments/${mediaCapability}/${attachmentId}`;

  const protectedRoutes = [
    "/",
    "/phone.js",
    "/phone.css",
    contextRoute,
    attachmentRoute,
  ];
  for (const route of protectedRoutes) {
    const unauthorized = await requestBuffer(pairedPort, route);
    assert.equal(unauthorized.statusCode, 401, route);
    assertSafeHeaders(unauthorized);

    const hostRejected = await requestBuffer(pairedPort, route, {
      Cookie: cookieHeader,
      Host: "attacker.invalid",
    });
    assert.equal(hostRejected.statusCode, 404, route);
    assertSafeHeaders(hostRejected);

    const originRejected = await requestBuffer(pairedPort, route, {
      Cookie: cookieHeader,
      Origin: "http://attacker.invalid",
    });
    assert.equal(originRejected.statusCode, 404, route);
    assertSafeHeaders(originRejected);
  }

  for (const [route, headers] of [
    [`${contextRoute}/extra`, { Cookie: cookieHeader }],
    [`/api/context/..%2F${contextId}`, { Cookie: cookieHeader }],
    [`/api/context/${mediaCapability}/${attachmentId}`, { Cookie: cookieHeader }],
    [`/api/attachments/${mediaCapability}/${contextId}`, { Cookie: cookieHeader }],
    [`${contextRoute}?content-type=image%2Fpng`, { Cookie: cookieHeader }],
    [`${attachmentRoute}`, { Cookie: cookieHeader, Range: "bytes=0-1" }],
  ]) {
    const rejected = await requestBuffer(pairedPort, route, headers);
    assert.equal(rejected.statusCode, 404, route);
    assert.equal(rejected.body.toString("utf8").includes("/Users/"), false);
    assertSafeHeaders(rejected);
  }

  const contextResponse = await requestBuffer(pairedPort, contextRoute, { Cookie: cookieHeader });
  const attachmentResponse = await requestBuffer(pairedPort, attachmentRoute, { Cookie: cookieHeader });
  for (const response of [contextResponse, attachmentResponse]) {
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, pngBytes);
    assert.equal(response.headers["content-type"], "image/png");
    assert.equal(response.headers["content-length"], String(pngBytes.byteLength));
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["content-disposition"], undefined);
  }

  for (const asset of ["/phone.js", "/phone.css", "/"]) {
    const response = await requestBuffer(pairedPort, asset, { Cookie: cookieHeader });
    assert.equal(response.statusCode, 200, asset);
    assert.equal(response.body.includes(Buffer.from("/Users/")), false, asset);
    assert.equal(response.body.includes(Buffer.from("fluely_phone_session")), false, asset);
  }
});

test("authenticated WebSocket sends an immediate snapshot, ordered events, ping/pong, and fresh resync snapshots without commands", async () => {
  const WS_TEST_DEADLINE_MS = 3_000;
  const activeSockets = new Set();

  const closeActiveSockets = () => {
    for (const socket of activeSockets) {
      try {
        socket.terminate();
      } catch {
        // A test socket may already be closed.
      }
    }
    activeSockets.clear();
  };

  const frameStates = new WeakMap();
  const waitForObservedMessage = (socket, onFrame = () => undefined) => new Promise((resolve, reject) => {
    const state = frameStates.get(socket);
    assert.ok(state);
    const deliver = (data) => {
      try {
        const frame = JSON.parse(data.toString("utf8"));
        onFrame(frame);
        resolve(frame);
      } catch (error) {
        reject(error);
      }
    };
    if (state.frames.length > 0) {
      deliver(state.frames.shift());
      return;
    }
    state.waiters.push({ resolve: deliver, reject });
  });

  const runWithDeadline = async (operation) => {
    let timer;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("WS focused test deadline exceeded.")), WS_TEST_DEADLINE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      closeActiveSockets();
    }
  };

  const connect = (wsUrl, options) => new Promise((resolve, reject) => {
    const candidate = new WebSocket(wsUrl, options);
    activeSockets.add(candidate);
    const state = { frames: [], waiters: [] };
    frameStates.set(candidate, state);
    let opened = false;
    let settled = false;
    candidate.on("message", (data) => {
      const waiter = state.waiters.shift();
      if (waiter) {
        waiter.resolve(data);
      } else {
        state.frames.push(data);
      }
    });
    candidate.once("open", () => {
      opened = true;
      if (!settled) {
        settled = true;
        resolve(candidate);
      }
    });
    candidate.on("error", () => {
      if (!opened && !settled) {
        settled = true;
        reject(new Error("WebSocket client connection failed."));
      }
      for (const waiter of state.waiters.splice(0)) {
        waiter.reject(new Error("WebSocket client frame failed."));
      }
    });
    candidate.once("close", () => {
      activeSockets.delete(candidate);
      if (!opened && !settled) {
        settled = true;
        reject(new Error("WebSocket client closed before opening."));
      }
    });
  });

  const closeSocket = (socket) => new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", () => {
      activeSockets.delete(socket);
      resolve();
    });
    socket.close();
  });

  const expectRejectedConnection = (wsUrl, options) => new Promise((resolve) => {
    const candidate = new WebSocket(wsUrl, options);
    activeSockets.add(candidate);
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    candidate.once("open", () => finish("opened"));
    candidate.once("error", () => finish("rejected"));
    candidate.once("close", () => {
      activeSockets.delete(candidate);
      finish("rejected");
    });
  });

  await runWithDeadline(async () => {
    const message = {
      id: "message-1",
      sequence: 1,
      role: "assistant",
      text: "Streaming",
      attachmentIds: [],
      status: "streaming",
      createdAt: 100,
    };
    const initialSnapshot = {
      revision: 0,
      conversation: {
        sessionId: "session-ws",
        revision: 0,
        messages: [],
        attachments: [],
      },
      queue: [],
    };
    const projection = makeProjection(initialSnapshot);
    const qrUrls = [];
    const { gateway } = makeGateway({
      portCandidates: [0],
      qrUrls,
      createServer: (handler) => createLoopbackServer(handler),
      projection,
    });
    const ready = await gateway.start();
    const port = Number(new URL(ready.origin).port);
    const pairingSecret = new URL(qrUrls[0]).searchParams.get("secret");
    const exchange = await request(port, `/pair?secret=${pairingSecret}`);
    const cookieHeader = exchange.headers["set-cookie"]?.[0]?.match(/^(fluely_phone_session=[^;]+)/)?.[1];
    assert.ok(cookieHeader);
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const readsBeforeConnect = projection.getSnapshotReadCount();
    const socket = await connect(wsUrl, { headers: { Cookie: cookieHeader }, origin: ready.origin });
    const snapshotFrame = await waitForObservedMessage(socket);
    assert.equal(snapshotFrame.type, "snapshot");
    assert.equal(snapshotFrame.revision, 0);
    assert.equal(snapshotFrame.payload.conversation.sessionId, "session-ws");
    assert.equal(projection.getSnapshotReadCount(), readsBeforeConnect + 1);

    const event = {
      type: "conversation",
      revision: 1,
      event: {
        type: "message-added",
        revision: 1,
        activeMessageId: message.id,
        message,
      },
    };
    projection.publish(event, {
      ...initialSnapshot,
      revision: 1,
      conversation: { ...initialSnapshot.conversation, revision: 1, messages: [message], activeMessageId: message.id },
    });
    const eventFrame = await waitForObservedMessage(socket);
    assert.deepEqual(eventFrame, { type: "event", revision: 1, payload: event.event });

    socket.send(JSON.stringify({ type: "ping", at: 456 }));
    assert.deepEqual(await waitForObservedMessage(socket), { type: "pong", at: 456 });

    const readsBeforeResync = projection.getSnapshotReadCount();
    socket.send(JSON.stringify({ type: "resync", requestId: "resync-1", afterRevision: 0 }));
    const resyncFrame = await waitForObservedMessage(socket);
    assert.equal(resyncFrame.type, "snapshot");
    assert.equal(resyncFrame.revision, 1);
    assert.equal(resyncFrame.payload.conversation.messages[0].text, "Streaming");
    assert.equal(projection.getSnapshotReadCount(), readsBeforeResync + 1);

    socket.send(JSON.stringify({ type: "command", command: { type: "unsupported", requestId: "b3" } }));
    const invalidFrame = await waitForObservedMessage(socket);
    assert.deepEqual(invalidFrame, {
      type: "error",
      code: "INVALID_FRAME",
      message: "Invalid phone frame.",
    });
    assert.notEqual(socket.readyState, WebSocket.OPEN);

    await closeSocket(socket);
    const reconnected = await connect(wsUrl, { headers: { Cookie: cookieHeader }, origin: ready.origin });
    const reconnectedSnapshot = await waitForObservedMessage(reconnected);
    assert.equal(reconnectedSnapshot.type, "snapshot");
    assert.equal(reconnectedSnapshot.payload.conversation.messages[0].status, "streaming");
    await closeSocket(reconnected);

    assert.equal(await expectRejectedConnection(wsUrl, { origin: ready.origin }), "rejected");
    assert.equal(await expectRejectedConnection(wsUrl, {
      headers: { Cookie: cookieHeader },
      origin: "http://attacker.invalid",
    }), "rejected");
    assert.equal(await expectRejectedConnection(wsUrl, {
      headers: { Cookie: cookieHeader, Host: "attacker.invalid" },
      origin: ready.origin,
    }), "rejected");
  });
});

test("phone commands enter the canonical router with source phone and replay one cached acknowledgement", async () => {
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-command", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const calls = [];
  const router = {
    execute: async (command, source) => {
      calls.push({ command, source });
      return commandResult();
    },
  };
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket);
  socket.sent = [];

  const command = { type: "capture", requestId: "phone-idempotent-1" };
  const frame = JSON.stringify({ type: "command", command });
  socket.emit("message", Buffer.from(frame));
  await flushMicrotasks();
  socket.emit("message", Buffer.from(frame));
  await flushMicrotasks();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command, source: "phone" });
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(JSON.parse(socket.sent[0]), JSON.parse(socket.sent[1]));
  assert.equal(JSON.parse(socket.sent[0]).type, "ack");
});

test("phone commands close the session after the eleventh command in a rolling ten-second window", async () => {
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-rate", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = { execute: async () => commandResult() };
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket);
  socket.sent = [];

  for (let index = 0; index < 10; index += 1) {
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: `phone-rate-${index}` },
    })));
    await flushMicrotasks();
  }
  assert.equal(socket.terminated, false);

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "phone-rate-10" },
  })));
  await flushMicrotasks();

  const error = socket.sent.map((value) => JSON.parse(value)).find((frame) => frame.type === "error");
  assert.deepEqual(error, {
    type: "error",
    requestId: "phone-rate-10",
    code: "RATE_LIMITED",
    message: "Too many phone commands. Try again shortly.",
  });
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.equal(socket.closeCalls[0].code, 1008);
});

test("phone gateway permits two outstanding pings, terminates on tick three, and pong resets the count", async () => {
  const timer = makeGatewayTimer();
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-heartbeat", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const { gateway } = makeGateway({ projection, timer, portCandidates: [0] });
  await gateway.start();
  const staleSocket = makeGatewaySocket();
  const resetSocket = makeGatewaySocket();
  gateway.acceptWebSocket(staleSocket);
  gateway.acceptWebSocket(resetSocket);

  const first = timer.active().find((entry) => entry.delay === 15_000);
  assert.ok(first);
  timer.fire(first);
  assert.equal(staleSocket.pings, 1);
  assert.equal(resetSocket.pings, 1);
  assert.equal(staleSocket.terminated, false);
  assert.equal(resetSocket.terminated, false);

  const second = timer.active().find((entry) => entry.delay === 15_000 && entry !== first);
  assert.ok(second);
  timer.fire(second);
  assert.equal(staleSocket.pings, 2);
  assert.equal(resetSocket.pings, 2);
  assert.equal(staleSocket.terminated, false);
  assert.equal(resetSocket.terminated, false);

  resetSocket.emit("pong");
  const third = timer.active().find((entry) => entry.delay === 15_000 && entry !== first && entry !== second);
  assert.ok(third);
  timer.fire(third);
  assert.equal(staleSocket.terminated, true);
  assert.equal(staleSocket.pings, 2);
  assert.equal(resetSocket.terminated, false);
  assert.equal(resetSocket.pings, 3);

  const fourth = timer.active().find((entry) => entry.delay === 15_000 && ![first, second, third].includes(entry));
  assert.ok(fourth);
  timer.fire(fourth);
  assert.equal(resetSocket.terminated, false);
  assert.equal(resetSocket.pings, 4);

  const fifth = timer.active().find((entry) => entry.delay === 15_000 && ![first, second, third, fourth].includes(entry));
  assert.ok(fifth);
  timer.fire(fifth);
  assert.equal(resetSocket.terminated, true);
  assert.equal(resetSocket.pings, 4);
});

test("phone gateway closes a client before sending when outbound backpressure exceeds one MiB", () => {
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-backpressure", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const { gateway } = makeGateway({ projection });
  const socket = makeGatewaySocket({ bufferedAmount: 1_048_577 });
  gateway.acceptWebSocket(socket);

  assert.equal(socket.terminated, true);
  assert.equal(socket.sent.length, 0);
});

test("disconnecting during an active phone command does not cancel or invent an acknowledgement", async () => {
  let release;
  let calls = 0;
  const router = {
    execute: async () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-disconnect", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket);
  socket.sent = [];
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "phone-disconnect-1" },
  })));
  await flushMicrotasks();
  assert.equal(calls, 1);
  socket.emit("close");
  release(commandResult());
  await flushMicrotasks();

  assert.deepEqual(socket.sent, []);
});

test("a revoked pairing cannot dispatch a command that was already queued before replacement", async () => {
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-revoke-race", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const calls = [];
  const router = {
    execute: async (command, source) => {
      calls.push({ command, source });
      return commandResult();
    },
  };
  const qrUrls = [];
  const { gateway } = makeGateway({ projection, commandRouter: router, qrUrls, portCandidates: [0] });
  const ready = await gateway.start();
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const exchanged = await invokeHandler(gateway, `/pair?secret=${secret}`);
  const cookieHeader = exchanged.headers["set-cookie"];
  const sessionKey = cookieHeader.match(/^fluely_phone_session=([^;]+)/)[1];
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket, sessionKey);
  socket.sent = [];

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "phone-revoke-race" },
  })));
  await gateway.regeneratePairing();
  await flushMicrotasks();

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "phone-revoke-after" },
  })));
  await flushMicrotasks();
  assert.deepEqual(calls, []);
  assert.equal(socket.readyState, WebSocket.CLOSED);
  void ready;
});

test("phone idempotency survives reconnect beyond the shared 512-entry deduper window", async () => {
  let now = 10_000;
  const calls = [];
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-ledger", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = {
    execute: async (command, source) => {
      calls.push({ command, source });
      return commandResult();
    },
  };
  const { gateway } = makeGateway({ projection, commandRouter: router, now: () => now });
  const firstSocket = makeGatewaySocket();
  gateway.acceptWebSocket(firstSocket, "session-phone-ledger");
  firstSocket.sent = [];

  for (let index = 0; index < 513; index += 1) {
    const startIndex = firstSocket.sent.length;
    firstSocket.emit("message", Buffer.from(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: `ledger-${index}` },
    })));
    await waitForSentFrame(firstSocket, (frame) => frame.type === "ack" && frame.requestId === `ledger-${index}`, 2_000, startIndex);
    now += 10_001;
  }
  assert.equal(calls.length, 513);

  firstSocket.emit("close");
  const reconnectedSocket = makeGatewaySocket();
  gateway.acceptWebSocket(reconnectedSocket, "session-phone-ledger");
  reconnectedSocket.sent = [];
  reconnectedSocket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "ledger-0" },
  })));
  await waitForSentFrame(reconnectedSocket, (frame) => frame.type === "ack" && frame.requestId === "ledger-0", 2_000, 0);

  assert.equal(calls.length, 513);
  assert.equal(JSON.parse(reconnectedSocket.sent[0]).type, "ack");
});

test("phone idempotency moves completion into an exactly counted minimal settled record", async () => {
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-minimal-ledger", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = {
    execute: async () => commandResult(),
  };
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket, "session-phone-minimal-ledger");
  socket.sent = [];

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "minimal-ledger-1" },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "ack" && frame.requestId === "minimal-ledger-1");

  const session = gateway.phoneSessions.get("session-phone-minimal-ledger");
  assert.ok(session);
  assert.equal(session.inFlight.size, 0);
  assert.equal(session.inFlightSerializedBytes, 0);
  const entry = session.settledLedger.get("minimal-ledger-1");
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ["fingerprint", "response", "serializedBytes"]);
  assert.equal(JSON.parse(entry.response).type, "ack");
  assert.equal("result" in JSON.parse(entry.response), false);
  const expectedBytes = Buffer.byteLength("minimal-ledger-1", "utf8") +
    Buffer.byteLength(entry.fingerprint, "utf8") +
    Buffer.byteLength(entry.response, "utf8");
  assert.equal(entry.serializedBytes, expectedBytes);
  assert.equal(session.settledSerializedBytes, expectedBytes);
  assert.equal(session.settledSerializedBytes < 1_216, true);
});

test("phone commands enforce a hard transient count and exact serialized-byte budget while execution is pending", async () => {
  let now = 10_000;
  const executions = [];
  const commands = [];
  const router = {
    execute: async (command) => {
      const execution = deferred();
      executions.push(execution);
      commands.push(command);
      return execution.promise;
    },
  };
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-transient-budget", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const { gateway } = makeGateway({ projection, commandRouter: router, now: () => now });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket, "session-phone-transient-budget");
  socket.sent = [];

  const prompt = "🚀".repeat(1_500);
  for (let index = 0; index < 10; index += 1) {
    const command = { type: "send", requestId: `transient-${index}`, prompt };
    socket.emit("message", Buffer.from(JSON.stringify({ type: "command", command })));
    await flushMicrotasks();
    now += 10_000;
  }

  const session = gateway.phoneSessions.get("session-phone-transient-budget");
  const expectedBytes = commands.reduce((total, command) =>
    total + Buffer.byteLength(JSON.stringify(command), "utf8"), 0);
  assert.equal(commands.length, 10);
  assert.equal(session.inFlight.size, 10);
  assert.equal(session.inFlightSerializedBytes, expectedBytes);
  assert.equal(session.inFlightSerializedBytes <= 10 * 16 * 1_024, true);

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "transient-overflow" },
  })));
  await flushMicrotasks();

  assert.equal(commands.length, 10);
  assert.deepEqual(socket.sent.map((value) => JSON.parse(value)).at(-1), {
    type: "error",
    requestId: "transient-overflow",
    code: "RATE_LIMITED",
    message: "Too many phone commands. Try again shortly.",
  });
  assert.equal(socket.readyState, WebSocket.CLOSED);

  for (const execution of executions) {
    execution.resolve(commandResult());
  }
  await flushMicrotasks();
});

test("concurrent duplicate failures share one execution and replay the same safe error", async () => {
  const execution = deferred();
  let calls = 0;
  const router = {
    execute: async () => {
      calls += 1;
      return execution.promise;
    },
  };
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-concurrent-error", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const { gateway } = makeGateway({
    projection,
    commandRouter: router,
    onCommandError: () => undefined,
  });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket, "session-phone-concurrent-error");
  socket.sent = [];
  const frame = Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "send", requestId: "concurrent-error", prompt: "secret prompt" },
  }));

  socket.emit("message", frame);
  socket.emit("message", frame);
  await flushMicrotasks();
  assert.equal(calls, 1);

  execution.reject(Object.assign(new Error("secret provider path /Users/private/provider.json"), {
    code: "INTERNAL_ERROR",
  }));
  await waitForSentFrame(socket, () => socket.sent.length === 2);

  assert.equal(calls, 1);
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(JSON.parse(socket.sent[0]), JSON.parse(socket.sent[1]));
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: "error",
    requestId: "concurrent-error",
    code: "COMMAND_FAILED",
    message: "Phone command failed.",
  });
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("concurrent duplicate success has a bounded waiter set and executes the router once", async () => {
  const execution = deferred();
  let calls = 0;
  const router = {
    execute: async () => {
      calls += 1;
      return execution.promise;
    },
  };
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-concurrent-success", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const sockets = Array.from({ length: 17 }, () => makeGatewaySocket());
  for (const socket of sockets) {
    gateway.acceptWebSocket(socket, "session-phone-concurrent-success");
    socket.sent = [];
  }
  const frame = Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "concurrent-success" },
  }));

  for (const socket of sockets) {
    socket.emit("message", frame);
  }
  await flushMicrotasks();

  const session = gateway.phoneSessions.get("session-phone-concurrent-success");
  assert.equal(calls, 1);
  assert.equal(session.inFlight.get("concurrent-success").waiters.size, 16);
  assert.deepEqual(JSON.parse(sockets[16].sent[0]), {
    type: "error",
    requestId: "concurrent-success",
    code: "RATE_LIMITED",
    message: "Too many phone commands. Try again shortly.",
  });
  assert.equal(sockets[16].readyState, WebSocket.CLOSED);

  execution.resolve(commandResult());
  await Promise.all(sockets.slice(0, 16).map((socket) =>
    waitForSentFrame(socket, (response) => response.type === "ack" && response.requestId === "concurrent-success")));

  assert.equal(calls, 1);
  for (const socket of sockets.slice(0, 16)) {
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: "ack",
      requestId: "concurrent-success",
    });
  }
});

test("default phone command diagnostics contain only stable safe fields", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  const secret = "secret prompt and /Users/private/provider.json";
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-safe-log", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = {
    execute: async () => {
      throw Object.assign(new Error(secret), { code: "INTERNAL_ERROR" });
    },
  };
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket);
  socket.sent = [];

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "send", requestId: "safe-log", prompt: secret },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "error" && frame.requestId === "safe-log");

  assert.deepEqual(warnings, [[
    "Phone command failed.",
    {
      event: "phone_command_failed",
      commandType: "send",
      code: "COMMAND_FAILED",
    },
  ]]);
  assert.equal(warnings.flat(Infinity).some((value) => String(value).includes(secret)), false);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("phone command rate limiting expires timestamps at the exact ten-second boundary", async () => {
  let now = 10_000;
  let calls = 0;
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-rate-boundary", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = {
    execute: async () => {
      calls += 1;
      return commandResult();
    },
  };
  const { gateway } = makeGateway({ projection, commandRouter: router, now: () => now });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket);
  socket.sent = [];

  for (let index = 0; index < 10; index += 1) {
    const requestId = `rate-boundary-${index}`;
    const startIndex = socket.sent.length;
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId },
    })));
    await waitForSentFrame(socket, (frame) => frame.type === "ack" && frame.requestId === requestId, 2_000, startIndex);
  }

  now += 10_000;
  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "rate-boundary-10" },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "ack" && frame.requestId === "rate-boundary-10");

  assert.equal(calls, 11);
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("phone session revokes at the hard unique-command ledger limit instead of evicting IDs", async () => {
  let now = 10_000;
  let calls = 0;
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-ledger-cap", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = {
    execute: async () => {
      calls += 1;
      return commandResult();
    },
  };
  const { gateway } = makeGateway({ projection, commandRouter: router, now: () => now });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket, "session-phone-ledger-cap");
  socket.sent = [];

  for (let index = 0; index < 4096; index += 1) {
    const startIndex = socket.sent.length;
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "command",
      command: { type: "capture", requestId: `ledger-cap-${index}` },
    })));
    await waitForSentFrame(socket, (frame) => frame.type === "ack" && frame.requestId === `ledger-cap-${index}`, 2_000, startIndex);
    now += 10_001;
  }
  assert.equal(calls, 4096);
  const session = gateway.phoneSessions.get("session-phone-ledger-cap");
  assert.equal(session.settledLedger.size, 4096);
  assert.equal(session.inFlight.size, 0);
  assert.equal(
    session.settledSerializedBytes,
    [...session.settledLedger.values()].reduce((total, entry) => total + entry.serializedBytes, 0),
  );
  assert.equal(session.settledSerializedBytes <= 4_980_736, true);

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "capture", requestId: "ledger-cap-4096" },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "error" && frame.requestId === "ledger-cap-4096", 2_000, socket.sent.length - 1);

  const error = socket.sent.map((value) => JSON.parse(value)).at(-1);
  assert.deepEqual(error, {
    type: "error",
    requestId: "ledger-cap-4096",
    code: "SESSION_REVOKED",
    message: "Pairing revoked.",
  });
  assert.equal(calls, 4096);
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

test("phone command failures use a fixed safe error and keep the authenticated connection open", async () => {
  const projection = makeProjection({
    revision: 0,
    conversation: { sessionId: "session-phone-error", revision: 0, messages: [], attachments: [] },
    queue: [],
  });
  const router = {
    execute: async (command) => {
      throw Object.assign(new Error("provider /Users/yu/private/session.json"), {
        code: command.requestId === "phone-safe-error-prototype" ? "__proto__" : "INTERNAL_ERROR",
      });
    },
  };
  const { gateway } = makeGateway({ projection, commandRouter: router });
  const socket = makeGatewaySocket();
  gateway.acceptWebSocket(socket);
  socket.sent = [];

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "send", requestId: "phone-safe-error-1", prompt: "Question" },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "error" && frame.requestId === "phone-safe-error-1", 2_000, 0);

  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: "error",
    requestId: "phone-safe-error-1",
    code: "COMMAND_FAILED",
    message: "Phone command failed.",
  });
  assert.equal(socket.readyState, WebSocket.OPEN);

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "send", requestId: "phone-safe-error-2", prompt: "Question" },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "error" && frame.requestId === "phone-safe-error-2", 2_000, 1);
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(JSON.parse(socket.sent[1]).message, "Phone command failed.");

  socket.emit("message", Buffer.from(JSON.stringify({
    type: "command",
    command: { type: "send", requestId: "phone-safe-error-prototype", prompt: "Question" },
  })));
  await waitForSentFrame(socket, (frame) => frame.type === "error" && frame.requestId === "phone-safe-error-prototype", 2_000, 2);
  assert.deepEqual(JSON.parse(socket.sent[2]), {
    type: "error",
    requestId: "phone-safe-error-prototype",
    code: "COMMAND_FAILED",
    message: "Phone command failed.",
  });
  assert.equal(socket.readyState, WebSocket.OPEN);
});

test("raw HTTP request targets are matched before URL normalization and reject traversal, encoded separators, and query confusion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-route-test-"));
  temporaryDirectories.push(root);
  const contextId = "11111111-1111-4111-8111-111111111111";
  const contextPath = path.join(root, "context.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  await writeFile(contextPath, pngBytes, { mode: 0o600 });

  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    createServer: (handler) => createLoopbackServer(handler),
    context: {
      getManagedPaths: (ids) => ids[0] === contextId ? [contextPath] : [],
      getManagedRoot: () => root,
    },
  });
  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const host = new URL(ready.origin).host;
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const exchange = await request(port, "/pair?secret=" + secret);
  const cookie = exchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];

  const valid = parseRawResponse(await rawRequest(port, "/api/context/" + contextId, {
    Host: host,
    Cookie: cookie,
  }));
  assert.equal(valid.statusCode, 200);
  assert.equal(Buffer.from(valid.body, "latin1").equals(pngBytes), true);

  const invalidTargets = [
    "http://" + host + "/api/context/" + contextId,
    "/api/context/../context/" + contextId,
    "/api/context/%2e%2e/context/" + contextId,
    "/api/context/..\\context\\" + contextId,
    "/api/context/%252e%252e/context/" + contextId,
    "/api/context/" + contextId + "%2f..%2f" + contextId,
    "/api/context/" + contextId + "?cache=1",
    "/api/context//" + contextId,
    "/api/context/" + contextId + "/",
    "/api/context/%00" + contextId,
  ];

  for (const target of invalidTargets) {
    const response = parseRawResponse(await rawRequest(port, target, {
      Host: host,
      Cookie: cookie,
    }));
    assert.equal(response.statusCode, 404, target);
    assertRawSafeHeaders(response);
    assert.equal(response.body.includes("/Users/"), false, target);
  }
});

test("authenticated media rejects symlinks, directories, unsafe modes, and oversized files with generic not-found responses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fluely-phone-media-safety-test-"));
  temporaryDirectories.push(root);
  const ids = {
    symlink: "11111111-1111-4111-8111-111111111111",
    directory: "22222222-2222-4222-8222-222222222222",
    wrongMode: "33333333-3333-4333-8333-333333333333",
    oversized: "44444444-4444-4444-8444-444444444444",
  };
  const targetPath = path.join(root, "target.png");
  const symlinkPath = path.join(root, "linked.png");
  const directoryPath = path.join(root, "directory.png");
  const wrongModePath = path.join(root, "wrong-mode.png");
  const oversizedPath = path.join(root, "oversized.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  await writeFile(targetPath, pngBytes, { mode: 0o600 });
  await chmod(targetPath, 0o600);
  await symlink(targetPath, symlinkPath);
  await mkdir(directoryPath, { mode: 0o700 });
  await writeFile(wrongModePath, pngBytes, { mode: 0o644 });
  await chmod(wrongModePath, 0o644);
  await writeFile(oversizedPath, Buffer.alloc(1), { mode: 0o600 });
  await chmod(oversizedPath, 0o600);
  await truncate(oversizedPath, 20 * 1024 * 1024 + 1);

  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    createServer: (handler) => createLoopbackServer(handler),
    context: {
      getManagedPaths: (requested) => {
        const id = requested[0];
        return id === ids.symlink ? [symlinkPath]
          : id === ids.directory ? [directoryPath]
            : id === ids.wrongMode ? [wrongModePath]
              : id === ids.oversized ? [oversizedPath]
                : [];
      },
      getManagedRoot: () => root,
    },
  });
  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const exchange = await request(port, "/pair?secret=" + secret);
  const cookie = exchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];

  for (const id of Object.values(ids)) {
    const response = await requestBuffer(port, "/api/context/" + id, { Cookie: cookie });
    assert.equal(response.statusCode, 404, id);
    assertSafeHeaders(response);
    assert.equal(response.body.includes("/Users/"), false, id);
  }
});

test("raw WebSocket upgrades reject invalid request headers before ws default handling and always close with safe headers", async () => {
  const initialSnapshot = {
    revision: 0,
    conversation: {
      sessionId: "session-ws-raw",
      revision: 0,
      messages: [],
      attachments: [],
    },
    queue: [],
  };
  const qrUrls = [];
  const { gateway } = makeGateway({
    portCandidates: [0],
    qrUrls,
    createServer: (handler) => createLoopbackServer(handler),
    projection: {
      getSnapshot: () => structuredClone(initialSnapshot),
      subscribe: () => () => undefined,
    },
  });
  const ready = await gateway.start();
  const port = Number(new URL(ready.origin).port);
  const host = new URL(ready.origin).host;
  const secret = new URL(qrUrls[0]).searchParams.get("secret");
  const exchange = await request(port, "/pair?secret=" + secret);
  const cookie = exchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];
  const validHeaders = {
    Host: host,
    Origin: ready.origin,
    Cookie: cookie,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": Buffer.from("the sample nonce").toString("base64"),
  };
  const invalidRequests = [
    ["missing Connection", { Connection: null }],
    ["wrong Connection token", { Connection: "keep-alive" }],
    ["missing Upgrade", { Upgrade: null }],
    ["wrong Upgrade token", { Upgrade: "h2c" }],
    ["wrong WebSocket version", { "Sec-WebSocket-Version": "12" }],
    ["malformed WebSocket key", { "Sec-WebSocket-Key": "not-base64" }],
    ["short WebSocket key", { "Sec-WebSocket-Key": Buffer.alloc(15).toString("base64") }],
    ["absolute-form request target", { requestTarget: "http://" + host + "/ws" }],
  ];

  for (const [name, overrides] of invalidRequests) {
    const headers = { ...validHeaders };
    const requestTarget = overrides.requestTarget ?? "/ws";
    delete overrides.requestTarget;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) {
        delete headers[key];
      } else {
        headers[key] = value;
      }
    }
    const response = parseRawResponse(await rawRequest(port, requestTarget, headers));
    assert.equal(response.statusCode, 404, name);
    assertRawSafeHeaders(response);
    assert.equal(response.headers.connection, "close", name);
    assert.equal(response.headers["sec-websocket-accept"], undefined, name);
    assert.equal(response.body, "Not found.", name);
  }
});
