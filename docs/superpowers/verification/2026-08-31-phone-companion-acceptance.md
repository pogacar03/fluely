# Fluely phone companion acceptance

This document is the durable acceptance checklist for Plan B Task 4. The phone
companion is deliberately LAN-only, opt-in, single-phone, and session-scoped.

## Automated gates

Run from `/Users/yu/Documents/cluely二开/fluely`:

```text
npm run build:electron
npm run build:phone
node --test electron/services/__tests__/phone-companion-acceptance.test.mjs scripts/__tests__/package-allowlist.test.mjs
node --test \
  electron/phone/__tests__/phone-client.test.mjs \
  electron/services/__tests__/AttachmentStore.test.mjs \
  electron/services/__tests__/CommandRouter.test.mjs \
  electron/services/__tests__/ConversationStore.test.mjs \
  electron/services/__tests__/PhoneGateway.test.mjs \
  electron/services/__tests__/ScreenshotService.test.mjs \
  electron/services/__tests__/SessionProjectionStore.test.mjs \
  electron/services/__tests__/canonical-session.integration.test.mjs \
  electron/services/__tests__/context-media.test.mjs \
  electron/services/__tests__/network-address.test.mjs \
  electron/services/__tests__/pairing-rate-limiter.test.mjs \
  electron/services/__tests__/pairing-session.test.mjs \
  electron/services/__tests__/phone-companion-acceptance.test.mjs \
  electron/services/__tests__/phone-gateway-ipc.test.mjs \
  electron/services/__tests__/phone-gateway-lifecycle.test.mjs \
  electron/services/__tests__/phone-gateway-real-components.integration.test.mjs \
  electron/services/__tests__/phone-projection.test.mjs \
  electron/services/__tests__/secure-media-file.test.mjs \
  electron/services/__tests__/session-media-protocol.test.mjs \
  electron/services/__tests__/workspace-command-ipc.test.mjs \
  electron/services/__tests__/workspace-media-integration.test.mjs \
  scripts/__tests__/package-allowlist.test.mjs \
  scripts/__tests__/phone-assets.test.mjs \
  scripts/__tests__/phone-bundle.integration.test.mjs \
  scripts/__tests__/smoke-packaged.test.mjs \
  src/renderer/__tests__/App-phone-gateway.test.mjs \
  src/renderer/__tests__/Conversation.test.mjs \
  src/renderer/__tests__/PhoneConnectionPanel.test.mjs \
  src/renderer/__tests__/SetupView.test.mjs \
  src/renderer/__tests__/conversation-hydration.test.mjs \
  src/renderer/__tests__/workspace-navigation.test.mjs \
  src/renderer/__tests__/workspace-state.test.mjs \
  src/renderer/__tests__/workview-interactions.test.mjs \
  src/shared/__tests__/context-queue.test.mjs \
  src/shared/__tests__/conversation.test.mjs \
  src/shared/__tests__/phone-gateway.test.mjs \
  src/shared/__tests__/workspace-view.test.mjs
npm test
npm run typecheck
npm run build:phone
npm run build
npm run package:dir
npm run smoke:packaged
node scripts/check-package-allowlist.mjs
git diff --check
```

The focused acceptance covers real HTTP and WebSocket behavior with real
`PhoneGateway`, `ScreenshotService`, `AttachmentStore`,
`ConversationStore`, and `SessionProjectionStore` instances. It verifies that
disable/re-pair invalidates old authenticated requests and that a new runtime
starts with an empty queue, conversation, capture state, streaming state, and
attachment namespace. The package check requires the compiled Electron,
renderer, and phone entrypoints and rejects repository development sources,
maps, tests, and environment files inside `app.asar`.

The 2026-09-06 B4 fix round also verifies that `/`, `/phone.js`, and
`/phone.css` remain cookie-authenticated static assets without a media
capability, while context/attachment media URLs remain session-capability
bound. The real backpressure test proves that an authorized, non-revoked
cookie can reconnect after the gateway closes the overloaded socket. This fix
round passed the focused acceptance/capability/allowlist group 62/62, the
complete B1-B4 focused command 219/219, and `npm test` 369/369; typecheck,
`build:phone`, and `build` also passed. Directory packaging and packaged smoke
are intentionally left to the independent verifier for this round.

`smoke:packaged` may launch only the packaged executable it discovers, with a
new temporary user-data directory. It must survive the smoke interval, then
terminate that owned child and remove only its temporary directory. No
persistent application launch is part of Task 4.

## Security and lifecycle assertions

- Unauthenticated, stale-cookie, forged Host/Origin, traversal, wrong-media-namespace, malformed-frame, oversized-frame, prompt-limit, attachment-limit, rate-limit, duplicate-ID, and backpressure paths fail closed with bounded safe responses.
- Pairing secrets are one-use and expire after two minutes. Re-pairing closes the old phone session; disabling and quitting close listeners and sockets.
- Phone errors and default diagnostics contain stable public fields only; no local path, pairing secret, cookie, prompt, or provider detail is returned to the phone or renderer.
- Desktop and phone consume one canonical revisioned projection. Capture, send, remove, clear, cancel, reconnect, and streaming are reflected by the same queue/conversation state.
- Restart creates a fresh session. Old cookies and old context/attachment IDs do not authorize or resolve in the new runtime.

## Final physical-phone matrix

This matrix is intentionally left for the dedicated post-review launch agent and
the user. The implementation agent must not leave the application running.

| # | User action | Expected result |
|---|---|---|
| 1 | Open Settings and Work repeatedly | One window remains; only one view is mounted. Settings starts Work; Work returns to Settings. |
| 2 | Enable **Start phone companion on LAN** | LAN warning, private URL, and one-time QR appear; disabled state shows no QR. |
| 3 | Scan QR on a phone on the same trusted LAN | Pairing succeeds, URL is redirected to `/`, and the phone shows the canonical queue/chat. |
| 4 | Capture on the computer | The screenshot appears in the desktop and phone draft queues; no chat turn is created. |
| 5 | Send images / Capture & ask from either side | The same screenshot attachment, prompt, message order, and streaming answer appear on both sides. |
| 6 | Capture, Remove, Clear queue, Clear conversation, and Cancel from the phone | Each command affects the computer through the shared router; queue-retention and cancellation semantics match desktop. |
| 7 | Disconnect/reconnect while an answer streams | The phone reconnects with a fresh canonical snapshot; desktop analysis continues. |
| 8 | Pair a replacement phone | The old phone is revoked immediately; the replacement sees the current canonical session. |
| 9 | Disable the companion | Listener and phone session close; the old phone cannot reconnect or fetch media. |
| 10 | Quit and relaunch Fluely | Queue, screenshots, attachments, conversation, capture/streaming state, and transient command state are empty; old cookies/media IDs fail. |

## Release note

The local Developer ID identity is expired on the validation host. Unsigned
directory packaging and packaged smoke are the local acceptance target; signing
and notarization remain a release concern. HTTP/WebSocket transport is not TLS
in this first LAN slice and must not be exposed to an untrusted network.
