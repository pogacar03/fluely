import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    createServer: (handler) => createHttpServer(handler),
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
    createServer: (handler) => createHttpServer(handler),
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
  await writeFile(contextPath, pngBytes);
  await writeFile(attachmentPath, pngBytes);
  const contextId = "11111111-1111-4111-8111-111111111111";
  const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const qrCalls = [];
  const pairedGateway = makeGateway({
    portCandidates: [0],
    qrUrls: qrCalls,
    createServer: (handler) => createHttpServer(handler),
    context: { getManagedPaths: (ids) => ids[0] === contextId ? [contextPath] : [] },
    attachments: { getPath: (id) => id === attachmentId ? attachmentPath : undefined },
    projection: {
      getSnapshot: () => ({ revision: 0, conversation: {
        sessionId: "session-phone",
        revision: 0,
        messages: [],
        attachments: [],
      }, queue: [] }),
      subscribe: () => () => undefined,
    },
  }).gateway;
  const pairedReady = await pairedGateway.start();
  const pairedPort = Number(new URL(pairedReady.origin).port);
  const pairingSecret = new URL(qrCalls[0]).searchParams.get("secret");
  const exchange = await request(pairedPort, `/pair?secret=${pairingSecret}`);
  const cookieHeader = exchange.headers["set-cookie"][0].match(/^(fluely_phone_session=[^;]+)/)[1];

  const protectedRoutes = [
    "/",
    "/phone.js",
    "/phone.css",
    `/api/context/${contextId}`,
    `/api/attachments/${attachmentId}`,
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
    [`/api/context/${contextId}/extra`, { Cookie: cookieHeader }],
    [`/api/context/..%2F${contextId}`, { Cookie: cookieHeader }],
    [`/api/context/${attachmentId}`, { Cookie: cookieHeader }],
    [`/api/attachments/${contextId}`, { Cookie: cookieHeader }],
    [`/api/context/${contextId}?content-type=image%2Fpng`, { Cookie: cookieHeader }],
    [`/api/attachments/${attachmentId}`, { Cookie: cookieHeader, Range: "bytes=0-1" }],
  ]) {
    const rejected = await requestBuffer(pairedPort, route, headers);
    assert.equal(rejected.statusCode, 404, route);
    assert.equal(rejected.body.toString("utf8").includes("/Users/"), false);
    assertSafeHeaders(rejected);
  }

  const contextResponse = await requestBuffer(pairedPort, `/api/context/${contextId}`, { Cookie: cookieHeader });
  const attachmentResponse = await requestBuffer(pairedPort, `/api/attachments/${attachmentId}`, { Cookie: cookieHeader });
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
      createServer: (handler) => createHttpServer(handler),
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

    socket.send(JSON.stringify({ type: "command", command: { type: "capture", requestId: "b3" } }));
    const invalidFrame = await waitForObservedMessage(socket);
    assert.deepEqual(invalidFrame, {
      type: "error",
      code: "INVALID_FRAME",
      message: "Invalid phone frame.",
    });
    assert.equal(socket.readyState, WebSocket.OPEN);

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
