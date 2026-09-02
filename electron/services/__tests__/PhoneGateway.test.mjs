import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, afterEach } from "node:test";

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

function makeGateway({ unavailablePorts = new Set(), portCandidates, createServer, qrUrls } = {}) {
  const servers = [];
  const gateway = new gatewayModule.PhoneGateway({
    networkInterfaces: () => ({
      en0: [{ address: "192.168.50.8", family: "IPv4", internal: false }],
    }),
    createServer: createServer ?? ((handler) => {
      const server = new FakeServer(handler, unavailablePorts);
      servers.push(server);
      return server;
    }),
    pairing: pairingModule.createPairingSessionManager({
      now: () => 10_000,
      randomBytes: randomBytesFactory(),
    }),
    qrCode: {
      toDataURL: async (url) => {
        qrUrls?.push(url);
        return `data:image/png;base64,${Buffer.from(url).toString("base64")}`;
      },
    },
    ...(portCandidates ? { portCandidates } : {}),
  });
  gateways.push(gateway);
  return { gateway, servers };
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
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
