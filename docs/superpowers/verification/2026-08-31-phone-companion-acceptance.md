# Fluely phone companion acceptance

This document is the durable acceptance checklist for Plan B Task 4. The phone
companion is deliberately LAN-only, opt-in, single-phone, and session-scoped.

## Automated gates

Run from `/Users/yu/Documents/cluely二开/fluely`:

```text
npm run build:electron
npm run build:phone
node --test electron/services/__tests__/phone-companion-acceptance.test.mjs scripts/__tests__/package-allowlist.test.mjs
node --test <complete B1-B4 focused file set>
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
