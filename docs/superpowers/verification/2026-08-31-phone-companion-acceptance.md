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

The 2026-09-06 B4 hardening round also verifies that `/`, `/phone.js`, and
`/phone.css` remain cookie-authenticated static assets without a media
capability, while every context/attachment media request requires the current
session capability even when no projection adapter is configured. The real
backpressure test proves that an authorized, non-revoked cookie can reconnect
after the gateway closes the overloaded socket. Phone disable quiesces and
waits for phone-origin capture/analysis/queued work while preserving unrelated
desktop-origin analysis; app quit applies global quiescence. The package policy
allows only its explicit compiled application manifest and hashed renderer
assets referenced by `dist/index.html`. Runtime dependency package roots may
retain their own test files, but global secret, credential, key, map, env,
`.npmrc`, and coverage patterns remain denied.

TDD evidence for this round was RED `70/76`, followed by GREEN `106/106` for
the directly related focused group. A final missing-capability projection test
was RED `2/3` then GREEN `3/3`. The built phone-bundle regression passed `4/4`;
the exact complete B1-B4 command above passed `225/225`; and `npm test`
passed `375/375`. `npm run typecheck`, `npm run build:phone`, `npm run build`,
and `git diff --check` also passed. `npm run package:dir`, packaged smoke, and
real app.asar/allowlist inspection are intentionally left to the independent
verifier for this round.

The final 2026-09-06 review round added bounded detachment for a native capture
promise that remains pending after the public timeout. `cancelPending()`, phone
disable, and app quit return without waiting forever; generation/cancellation
guards keep any late resolve or rejection from writing a file, queue item, or
conversation update. Lifecycle quiescence remains source-scoped: phone disable
cancels only phone-origin work, while app quit/restart uses global quiescence.
This is separate from the user's phone **Cancel** and **Clear conversation**
commands, which intentionally control the shared active analysis regardless of
which device started it.

Package admission now rejects every basename ending in `.env` as well as
`.env`/`.env.*`, and continues to reject maps, `.npmrc`, keys, credentials,
secrets, and coverage paths everywhere, including runtime dependencies.
Application-owned tests and fixtures are always rejected; a declared runtime
dependency may retain ordinary test files for ecosystem compatibility. The
checker reads `dist/index.html` from the archive and requires each referenced
hashed renderer asset to exist. `npm run package:dir` invokes the checker after
`electron-builder --dir` with fail-fast command chaining.

Final-round TDD was RED `52/58` and GREEN `58/58`. The exact B1-B4 command
above passed `230/230`; `npm test` passed `380/380`; typecheck, phone build,
desktop build, `package:dir` with its embedded allowlist, packaged smoke,
standalone app.asar/allowlist inspection, and diff-check all passed. The
physical-phone matrix below remains pending the dedicated user-run launch and
is not claimed complete here.

`smoke:packaged` may launch only the packaged executable it discovers, with a
new temporary user-data directory. It must survive the smoke interval, then
terminate that owned child and remove only its temporary directory. No
persistent application launch is part of Task 4.

The final RFC6598 closeout was independently verified on 2026-09-06. The
fresh B1-B4 verifier passed `238/238`, and `npm test` passed `388/388`; the
previously recorded typecheck, phone build, desktop build, and diff checks
also remained green. `npm run package:dir` passed, including its embedded
strict package allowlist. One initial packaged-smoke attempt hit a transient
macOS `NSApplication` `SIGABRT` before entering the project JavaScript; an
independent fresh rerun then exited `0`, kept the packaged app alive for the
required five seconds, terminated only its owned child, and left no smoke
child or temporary directory behind. The standalone
`node scripts/check-package-allowlist.mjs` check also passed for the current
`app.asar`, including required entries, renderer assets, unpacked content,
symlink policy, and sensitive-file exclusions. PID 74415 was confirmed as
the expected packaged executable, received only a graceful `SIGTERM`, and
exited; protected PIDs 34152, 34165, and 34166 were not touched. No Fluely
process was left resident.

## Security and lifecycle assertions

- RFC6598 shared space (`100.64.0.0/10`) is offered only when the user confirms
  that the address is reachable on a trusted LAN or shared network. Selection
  still rejects public, loopback, link-local, and obvious virtual or
  point-to-point interfaces; RFC1918 addresses remain preferred when both are
  available.
- Unauthenticated, stale-cookie, forged Host/Origin, traversal, wrong-media-namespace, malformed-frame, oversized-frame, prompt-limit, attachment-limit, rate-limit, duplicate-ID, and backpressure paths fail closed with bounded safe responses.
- Pairing secrets are one-use and expire after two minutes. Re-pairing closes the old phone session; disabling and quitting close listeners and sockets. Disable returns only after phone-origin router work is quiescent; quit globally quiesces shared router work.
- Phone errors and default diagnostics contain stable public fields only; no local path, pairing secret, cookie, prompt, or provider detail is returned to the phone or renderer.
- Desktop and phone consume one canonical revisioned projection. Capture, send, remove, clear, cancel, reconnect, and streaming are reflected by the same queue/conversation state.
- Restart creates a fresh session. Old cookies and old context/attachment capabilities/IDs do not authorize or resolve in the new runtime.

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
