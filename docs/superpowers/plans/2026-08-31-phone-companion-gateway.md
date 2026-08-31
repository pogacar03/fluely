# Phone Companion Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in same-LAN phone companion that pairs by one-time QR code, shows the same draft screenshots and canonical chat as desktop, can trigger desktop capture/send/cancel/clear, and safely resynchronizes after disconnection.

**Architecture:** Electron main hosts a small HTTP/WebSocket gateway and remains the sole writer through Plan A's `CommandRouter` and `ConversationPort`. Pairing exchanges a short-lived one-time secret for an HttpOnly session cookie, then redirects to a clean URL. The phone web page hydrates from a canonical snapshot and applies the same ordered events as desktop. Images are fetched by opaque IDs through authenticated endpoints; no filesystem path, long-lived query credential, or renderer relay is used.

**Tech Stack:** Electron 40, TypeScript, Node HTTP, `ws`, `qrcode`, React-free static phone client, existing Vite/Electron packaging, Node.js test runner.

**Spec:** `docs/superpowers/specs/2026-08-31-shared-workspace-phone-companion-design.md`

**Depends on:** All gates in `docs/superpowers/plans/2026-08-31-desktop-shared-session-foundation.md` are complete and explicitly passed by the user.

## Global Constraints

- The phone gateway is disabled by default and binds only after the user explicitly enables LAN access.
- Main remains the single writer. Phone and desktop use the same typed commands, snapshots, events, request IDs, queue, messages, and immutable attachments.
- Support exactly one paired phone session in the first slice. Re-pairing revokes the previous session immediately.
- First slice is HTTP on a trusted local network, not TLS. Show this limitation beside the QR code and never imply internet-safe transport.
- Add `ws` and `qrcode` as runtime dependencies, and `@types/ws` plus `@types/qrcode` as development dependencies. Confirm packaged runtime resolution.
- Every inbound payload is schema-validated and capped before parsing/dispatch. No endpoint returns local paths.
- Use TDD, separate `gpt-5.6-luna` (`reasoning_effort=max`) review, path-scoped commits, independent verification, and the same mandatory post-task launch/user gate as Plan A.

---

## Task 1: Add typed gateway settings, lifecycle, addressing, and QR pairing

**Outcome:** The Settings view can explicitly enable a LAN gateway, displays the selected LAN URL and a scannable one-time QR code, and can disable/revoke it cleanly. Pairing yields a secure session cookie and removes the secret from the browser URL.

**Files:**

- Modify: `package.json`
- Modify: package lockfile used by this repository
- Create: `src/shared/phone-gateway.ts`
- Create: `src/shared/__tests__/phone-gateway.test.mjs`
- Create: `electron/services/PhoneGateway.ts`
- Create: `electron/services/__tests__/PhoneGateway.test.mjs`
- Create: `electron/services/network-address.ts`
- Create: `electron/services/__tests__/network-address.test.mjs`
- Create: `electron/services/pairing-session.ts`
- Create: `electron/services/__tests__/pairing-session.test.mjs`
- Create: `scripts/smoke-packaged.mjs`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/renderer/components/SetupView.tsx`
- Create or modify: `src/renderer/components/PhoneConnectionPanel.tsx`
- Modify: relevant renderer styles/tests

**Interfaces:**

```ts
export interface PhoneGatewaySettings {
  enabled: boolean;
}

export type PhoneGatewayStatus =
  | { state: "disabled" }
  | { state: "starting" }
  | { state: "ready"; origin: string; qrDataUrl: string; pairingExpiresAt: number; paired: boolean }
  | { state: "error"; code: "no_lan_address" | "port_unavailable" | "start_failed"; message: string };

export interface PairingSessionManager {
  issue(nowMs?: number): { secret: string; expiresAt: number };
  exchange(secret: string, nowMs?: number): { cookieToken: string } | null;
  authenticate(cookieToken: string): boolean;
  revokeAll(): void;
}
```

Lifecycle and security constants:

- bind `0.0.0.0` only while enabled;
- try ports 4123 through 4134 in order, then request an OS-assigned port;
- choose a private, non-loopback IPv4 address for the QR URL; reject public, link-local, and loopback candidates;
- generate a cryptographically random 32-byte pairing secret with a 120-second TTL and single successful exchange;
- exchange sets a cryptographically random 32-byte cookie token with `HttpOnly; SameSite=Strict; Path=/` and redirects to `/` without the pairing secret;
- never log either secret or cookie token;
- disabling, quitting, or pairing a replacement phone revokes all sessions, closes sockets, and stops listening.

**Steps:**

- [ ] Add dependency entries and install using the repository's package manager; inspect the lockfile diff for unrelated upgrades.
- [ ] Add `smoke:packaged` to `package.json` with exact value `node scripts/smoke-packaged.mjs`. Implement the script to locate exactly one `.app` under the electron-builder output directory, launch its inner executable with a newly created temporary user-data directory, require it to remain alive for five seconds, terminate only that child, and remove only that temporary directory. A missing/ambiguous artifact, early exit, or failed termination is a non-zero smoke result.
- [ ] Add failing tests for private IPv4 filtering/selection, deterministic port fallback, default-disabled lifecycle, idempotent start/stop, and listener cleanup.
- [ ] Add failing fake-clock/random-source tests for 32-byte secret generation, 120-second expiry, one-time exchange, constant-time token comparison, replacement revocation, and cookie attributes.
- [ ] Implement address selection, pairing manager, and the minimal `PhoneGateway` HTTP lifecycle with dependency-injected server/random/clock adapters.
- [ ] Serve only a minimal authenticated shell and pairing exchange in this task. Return 401 for protected routes before authentication and 404 for unknown routes.
- [ ] Apply every HTTP response header: restrictive CSP, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a frame-denying policy.
- [ ] Add typed IPC for enable/disable/status/regenerate-pairing. Persist only the boolean setting; never persist session credentials.
- [ ] Add the Settings panel with explicit enable toggle, status, LAN-only warning, QR image, text URL, expiry countdown, regenerate action, paired indicator, and disable/revoke action.
- [ ] Test renderer state and ensure QR data is absent while disabled and regenerated credentials replace prior credentials.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, `npm run build`, `npm run package:dir`, and `npm run smoke:packaged`.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) security/lifecycle review and resolve every blocking finding.
- [ ] Commit only task paths with message `feat: add secure phone pairing gateway`.
- [ ] Independently verify the commit and packaged dependency resolution.
- [ ] Launch the committed app on LAN with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent and keep it running. The user gate checks enable/disable, QR visibility, successful phone pairing, clean redirected URL, expiry/regeneration, and old-phone revocation after replacement pairing.

---

## Task 2: Deliver authenticated snapshots, conversation events, and screenshot bytes

**Outcome:** After pairing, the phone shows the same ordered draft queue, user/assistant messages, and screenshot attachments as desktop. It receives live updates and can recover a complete snapshot after reconnecting.

**Files:**

- Modify: `src/shared/phone-gateway.ts`
- Modify: `electron/services/PhoneGateway.ts`
- Create: `electron/services/phone-projection.ts`
- Create: `electron/services/__tests__/phone-projection.test.mjs`
- Modify: `electron/services/__tests__/PhoneGateway.test.mjs`
- Create: `electron/phone/index.html`
- Create: `electron/phone/phone.css`
- Create: `electron/phone/phone.ts`
- Create: `electron/phone/__tests__/phone-client.test.mjs`
- Modify: build/package configuration so phone assets are present in development and packaged apps
- Modify: Plan A conversation/attachment interfaces only if an implementation mismatch is found and approved by main-agent review

**Protocol:**

```ts
export type ServerFrame =
  | { type: "snapshot"; revision: number; payload: SessionProjectionSnapshot }
  | { type: "event"; revision: number; payload: ConversationEvent }
  | { type: "ack"; requestId: string; result: CommandResult }
  | { type: "error"; requestId?: string; code: string; message: string }
  | { type: "pong"; at: number };

export type ClientFrame =
  | { type: "resync"; requestId: string; afterRevision: number }
  | { type: "ping"; at: number };
```

Authenticated routes:

- `GET /` returns the phone client shell;
- `GET /phone.js` and `GET /phone.css` return fixed packaged assets;
- `GET /api/context/:screenshotId` returns the current draft screenshot by opaque ID;
- `GET /api/attachments/:attachmentId` returns an immutable sent attachment by opaque ID;
- `GET /ws` upgrades only for an authenticated cookie and accepted Host/Origin.

Media responses use exact MIME type, content length, `Cache-Control: no-store`, `nosniff`, and no content disposition containing a path. Unknown, malformed, expired, or cross-namespace IDs return a generic 404.

**Steps:**

- [ ] Add failing projection tests proving a desktop snapshot and phone snapshot are structurally identical apart from channel-specific media URLs, and that ordered events preserve sequence/revision.
- [ ] Add failing HTTP tests for authentication, Host/Origin allowlists, route matching, opaque ID validation, context/attachment namespace separation, MIME/length/security headers, and generic 404 behavior.
- [ ] Implement projection helpers over Plan A's `ConversationPort` and `AttachmentStore`; never duplicate or mutate canonical conversation state.
- [ ] Add WebSocket authentication and send a full snapshot immediately after connection. Subscribe once to canonical events and broadcast each revision in order.
- [ ] Implement revision-gap handling: the phone requests `resync`; the server responds with a fresh full snapshot. Reconnect never cancels an active analysis.
- [ ] Build a small mobile-first phone UI showing connection state, the same draft screenshot queue, ordered chat messages, sent image thumbnails, assistant streaming state, and errors. Use no external CDN or remote asset.
- [ ] Add client tests for snapshot hydration, event application, revision-gap detection, reconnect backoff, image URL namespaces, and identical message ordering.
- [ ] Add build/package tests or assertions proving all phone static assets are included and served in both dev and packaged layouts.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, `npm run build`, `npm run package:dir`, and `npm run smoke:packaged`.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) review focused on canonical-state fidelity, auth on every byte route, path secrecy, reconnect correctness, and packaged assets; resolve blocking findings.
- [ ] Commit only task paths with message `feat: mirror desktop conversation to phone`.
- [ ] Independently verify commit, full checks, and a byte-for-byte media retrieval smoke through an authenticated test client.
- [ ] Launch the committed app with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent and keep it running. The user gate checks that a screenshot captured on the computer appears on the phone before send, sent screenshots appear in the same chat turn on both devices, assistant text/order match, and reconnect restores the same history.

---

## Task 3: Route phone capture, send, clear, cancel, and resync commands

**Outcome:** The paired phone can trigger a computer screenshot, manage the shared draft queue, send the same image/text request, cancel analysis, and clear draft context. Every action is idempotent and both screens converge on the same canonical result.

**Files:**

- Modify: `src/shared/phone-gateway.ts`
- Modify: `electron/services/PhoneGateway.ts`
- Modify: `electron/services/CommandRouter.ts`
- Modify: related gateway/router tests
- Modify: `electron/phone/index.html`
- Modify: `electron/phone/phone.css`
- Modify: `electron/phone/phone.ts`
- Modify: phone client tests

**Protocol additions:**

```ts
export type PhoneCommandFrame = {
  type: "command";
  command: WorkspaceCommand;
};
```

Operational limits:

- maximum incoming WebSocket message size: 16 KiB;
- maximum 10 commands in any rolling 10-second window per paired session;
- outbound buffered amount above 1 MiB triggers connection closure and subsequent snapshot resync;
- server heartbeat every 15 seconds; terminate peers that miss two consecutive heartbeats;
- request IDs must be opaque non-empty strings of at most 128 bytes;
- duplicate request IDs return the cached prior acknowledgement and never execute twice;
- command errors do not disconnect the phone unless the frame is invalid or abuse limits are exceeded.

**Steps:**

- [ ] Add failing parser tests for every command, unknown fields/types, oversize frames, invalid IDs, and prompt length limits matching the desktop command contract.
- [ ] Add failing gateway tests for rate limiting, duplicate request replay, acknowledgement caching, heartbeat cleanup, outbound backpressure, and disconnect during an active request.
- [ ] Dispatch valid phone frames directly to Plan A's `CommandRouter` with source `phone`; do not create phone-specific screenshot or analysis paths.
- [ ] Ensure phone capture invokes the existing computer screenshot provider and canonical queue event. Ensure send materializes the same attachment/message records consumed by desktop.
- [ ] Add phone controls for Capture, Send images, Capture & ask, Remove, Clear queue, Clear conversation, Cancel, and optional prompt. Mirror desktop disabled/loading semantics. Sending never clears the queue; `Clear conversation` never clears the queue.
- [ ] Show command acknowledgement/errors without inventing local chat messages; all visible queue/chat changes come from canonical snapshot/events.
- [ ] Add integration tests with desktop and phone subscribers proving command idempotency, identical queue/message/attachment order, empty prompt normalization, cancel semantics, disconnect/reconnect during streaming, and old-session revocation.
- [ ] Run focused tests, `npm test`, `npm run typecheck`, `npm run build`, `npm run package:dir`, and `npm run smoke:packaged`.
- [ ] Request a `gpt-5.6-luna` (`reasoning_effort=max`) review focused on command authority, abuse limits, race conditions, idempotency, and desktop/phone convergence; resolve blocking findings.
- [ ] Commit only task paths with message `feat: control shared session from phone`.
- [ ] Independently verify commit and full checks.
- [ ] Launch the committed app with a fresh `gpt-5.6-luna` (`reasoning_effort=max`) agent and keep it running. The user gate checks phone-triggered computer capture, queue changes on both screens, phone send with and without text, queue retention after send, cancellation, duplicate taps, and reconnect while an answer is streaming.

---

## Task 4: Security, packaging, lifecycle, and real-device acceptance

**Outcome:** The phone companion survives packaged execution, shuts down cleanly, rejects unauthorized/malformed traffic, and passes an end-to-end real-phone acceptance matrix on the same LAN.

**Files:**

- Modify: `electron/services/PhoneGateway.ts`
- Modify: gateway/security tests
- Modify: Electron build/package configuration and scripts
- Modify: `README.md` or the repository's user-facing setup document
- Create: `docs/superpowers/verification/2026-08-31-phone-companion-acceptance.md`

**Steps:**

- [ ] Add adversarial tests for unauthenticated HTTP/WS, forged Origin/Host, reused/expired pairing secrets, stale cookies, traversal/encoded traversal, wrong media namespace, oversized frames, command floods, slow/unresponsive peers, and server shutdown with open connections.
- [ ] Verify no response, log, QR payload after redirect, renderer IPC payload, or error message exposes an absolute path, pairing secret, or cookie token.
- [ ] Verify disabling LAN and app quit close HTTP listener/WebSockets, revoke credentials, unsubscribe from conversation events, and release the selected port.
- [ ] Build the packaged app and run it from the packaged artifact, confirming phone assets and runtime dependencies resolve without development paths.
- [ ] Test startup cleanup: quit, relaunch, confirm previous queue/chat/attachments are gone and old authenticated media IDs/cookies no longer work.
- [ ] Document enablement, same-LAN requirement, HTTP trust limitation, one-phone replacement behavior, two-minute pairing expiry, and restart-clears-history behavior.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm run package:dir`, and `npm run smoke:packaged`. Record exact commands and outcomes in the acceptance report.
- [ ] Request separate `gpt-5.6-luna` (`reasoning_effort=max`) code/security and product/spec reviews; resolve all blocking findings.
- [ ] Commit only task paths with message `chore: finish phone companion acceptance`.
- [ ] Independently verify final HEAD, commit path set, all checks, packaged artifact, clean status, and every requirement in the approved spec.
- [ ] Have a fresh `gpt-5.6-luna` (`reasoning_effort=max`) launch agent start the packaged final artifact and keep it running. The user performs the final real-phone matrix: pair by QR, desktop capture visible on phone, identical sent screenshot/chat history both ways, phone capture/send/cancel, reconnect, replacement pairing, LAN disable, and restart-clears-everything.

---

## Plan B Completion Gate

- [ ] Every protected HTTP and WebSocket path has authentication, Host/Origin validation where applicable, bounded input, and no-store/path-safe output.
- [ ] Desktop and phone are verified as projections of one canonical revisioned event stream, not reconciled copies.
- [ ] Final packaged build passes automated checks and explicit real-phone user acceptance.
- [ ] The final `gpt-5.6-luna` (`reasoning_effort=max`) launch process remains alive until the user reports pass/fail.
