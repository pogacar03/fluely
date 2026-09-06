# Fluely

<p align="center">
  <strong>A quiet, fast AI copilot for the moment you need it.</strong>
</p>

<p align="center">
  Capture context. Ask clearly. Keep moving.
</p>
<p align="center">
  <a href="https://github.com/pogacar03/fluely/actions"><img src="https://img.shields.io/github/actions/workflow/status/pogacar03/fluely/ci.yml?style=flat-square&label=build" alt="Build status"></a>
  <a href="https://github.com/pogacar03/fluely/blob/main/LICENSE"><img src="https://img.shields.io/github/license/pogacar03/fluely?style=flat-square" alt="MIT License"></a>
  <a href="https://github.com/pogacar03/fluely"><img src="https://img.shields.io/github/stars/pogacar03/fluely?style=flat-square" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/status-early%20development-7c3aed?style=flat-square" alt="Early development">
</p>

> Fluely is a lightweight desktop AI assistant being rebuilt around one idea: the shortest path from what is on your screen to a useful answer.

## Why Fluely

Most AI desktop tools accumulate features until the useful path disappears. Fluely takes the opposite approach:

- **Context first** — capture one screen or a small queue of screenshots, then ask.
- **Fast by default** — keep the desktop loop local, explicit, and observable.
- **Provider freedom** — start with Codex CLI and OpenAI-compatible APIs; bring your own model and key.
- **One conversation** — the desktop and phone companion share the same lightweight context.
- **Private by design** — secrets stay out of the renderer, local services bind to localhost by default, and optional features stay optional.
- **Small enough to understand** — no database, RAG pipeline, embedding runtime, or bundled speech model in the MVP.

## What is being built

Fluely is currently in active early development. The first release is being delivered in focused milestones:

| Milestone | Focus | Status |
| --- | --- | --- |
| 1 | Electron foundation, secure IPC, settings, shortcuts, capture privacy, screenshot queue | Complete locally |
| 2 | Vision requests, streaming answers | Complete locally |
| 3 | Shared conversation context and phone mirror | Complete locally; physical LAN acceptance pending |
| 4 | Microphone input, VAD, pluggable STT | Planned |
| 5 | Packaging, performance, and release validation | Automated local gate complete; signing pending |

The product contract and acceptance criteria are intentionally kept separate from implementation details. As the project evolves, this README will remain the product-level map; the code and tests will carry the operational truth.

## Design principles

### A short core loop

```text
See something → Capture context → Ask → Receive a useful answer → Continue
```

Fluely keeps capture, analysis, and visibility as separate actions. Taking a screenshot should not unexpectedly send it. Asking for an answer should not unexpectedly change whether the window is visible.

### Explicit boundaries

```text
┌────────────────────────────────────────────┐
│ Renderer                                    │
│ Conversation UI · Queue · Settings · Status │
└───────────────────┬────────────────────────┘
                    │ typed, allow-listed IPC
┌───────────────────▼────────────────────────┐
│ Electron Main                               │
│ Shortcuts · Screenshots · Settings · LLM    │
│ Conversation · Phone Mirror · Voice        │
└───────────────────┬────────────────────────┘
                    │ explicit adapters
        ┌───────────▼───────────┐
        │ Local CLI / HTTP APIs  │
        └────────────────────────┘
```

The renderer does not get filesystem, shell, or secret access. Provider adapters share a stable interface, so a local CLI and a remote API can participate in the same conversation flow without coupling the UI to either one.

## Planned interaction model

| Action | Default shortcut | Behavior |
| --- | --- | --- |
| Show / hide | `⌘ B` | Changes visibility only |
| Capture screenshot | `⌘ ⇧ 8` | Adds a screenshot to the queue |
| Send images | `⌘ Enter` | Sends queued screenshots and the current question |
| Capture and analyze | `⌘ ⇧ Enter` | Captures first, then starts analysis |
| Cancel / clear | `⌘ R` | Cancels the request and clears the queue |

Shortcuts will be configurable, validated on registration, and surfaced when the operating system reports a conflict.

## Background screenshots and capture privacy

`⌘ ⇧ 8` captures the display nearest the pointer through Electron's documented `desktopCapturer` API, even when Fluely is in the background. Before capture, Fluely hides its own window, waits briefly for the compositor, and restores the previous visible state without activating the app on macOS. If the native request times out, Fluely returns an error while continuing to observe it safely; disabling the phone companion or quitting detaches a phone-owned pending request in bounded time, and a late native result cannot write a file or change the shared queue. The session-scoped queue stores at most five PNGs below Fluely's local user-data directory; startup and Clear remove only strict UUID-managed PNG/temp files and preserve unrelated files. The renderer receives only opaque IDs, timestamps, and dimensions, never filesystem paths or image bytes.

Capture protection is enabled by default with Electron's `setContentProtection(true)` and is reapplied when the window is shown. On macOS, Screen Recording permission is required. The first capture may display the macOS system authorization dialog; Fluely cannot bypass or suppress that consent. If consent is denied or restricted, the corresponding state and Settings guidance are reported.

When capture protection is enabled on macOS, Fluely also asks Electron's public Dock API to hide the Dock, and restores it when the policy is disabled. This is ordinary application visibility policy, not process disguise or a private API.

This protection is best-effort. macOS applications that capture through ScreenCaptureKit can still capture a protected Electron window, so Fluely does not claim universal invisibility. The hide-before-capture session is the additional measure used to keep Fluely out of the PNG it creates; supported capture tools may still differ in how they honor content protection.

## Technology direction

- Electron
- TypeScript
- React
- Vite
- Node.js HTTP and WebSocket primitives
- `electron-builder`

Fluely favors platform primitives and small dependencies. Native image handling will use Electron's `nativeImage` first. Local speech models, when enabled, will be downloaded on demand rather than shipped inside the default installer.

## Security posture

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` unless a documented platform constraint requires an exception
- Provider keys stored outside ordinary settings JSON when platform-secure storage is available
- Phone companion disabled by default; when explicitly enabled it binds to the trusted LAN only
- Random pairing token for phone sessions
- No arbitrary client-supplied file paths
- Strict content security policy and `Cache-Control: no-store` for local phone pages

Fluely is not a security product. Please review the threat model before exposing the phone mirror to a LAN or using it with sensitive material.

## Phone companion on a trusted LAN

The optional phone companion is enabled from Settings with **Start phone companion on LAN**. Fluely shows a one-time QR code and text URL; scan it from a phone on the same local network, then keep the phone page open. Only one phone is paired at a time. Re-pairing a replacement phone, disabling the companion, quitting, or restarting invalidates the previous phone session.

The first LAN slice uses HTTP and WebSocket without TLS. Use it only on a trusted private network; anyone who can observe that network may observe the companion traffic. Pairing codes expire after two minutes, are single-use, and are never retained across restart. Restarting Fluely intentionally starts a new empty session: queued screenshots, conversation messages, attachments, capture/streaming state, and transient phone command state are cleared.

Desktop and phone project one canonical session. **Capture** adds a computer screenshot to the shared draft queue, **Send images** sends the queue without capturing or clearing it, **Capture & ask** performs both actions, and **Cancel**, **Clear queue**, **Clear conversation**, and **Remove** remain explicit controls. The desktop Settings and Work views are two mutually exclusive views in one window; Settings starts the workspace and Work returns to Settings.

Phone-issued **Cancel** and **Clear conversation** are intentional remote controls of the shared conversation, so they may stop the current analysis even when it was started on the desktop. Lifecycle shutdown is narrower: disabling the phone companion cancels only phone-origin work, while quitting or restarting Fluely globally quiesces all work before transient state is cleared.

## Development

Milestone 1 is runnable locally. The standard verification loop is:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:dir
```

The current package target is an unsigned macOS Apple Silicon directory build. Public release signing, final artwork, and the next screenshot/provider milestone are still ahead.

The phone companion's copyable automated acceptance command, security/lifecycle
matrix, packaging policy, and final physical-phone checklist live in
[`docs/superpowers/verification/2026-08-31-phone-companion-acceptance.md`](docs/superpowers/verification/2026-08-31-phone-companion-acceptance.md).
The local automated B4 fix gates cover real HTTP/WebSocket pairing, session-bound
media URLs, restart clearing, static phone assets, reconnect, and the shared
desktop/phone canonical projection. Gateway shutdown now quiesces phone-origin
capture and analysis work before returning, without cancelling independent
desktop-origin work. Every phone context/attachment URL requires a rotating
session capability, including store-only gateway configurations. Package
validation uses an explicit application runtime manifest plus renderer assets
referenced by the built index; undeclared application files and globally
sensitive dependency files fail closed. `package:dir` runs this strict check
automatically after packaging, so a manifest failure makes the package command
fail. The final physical-phone matrix remains
pending the dedicated user launch; this implementation task does not leave
Fluely running.

## Scope guardrails

The MVP deliberately does not include:

- RAG, embeddings, or a knowledge-base database
- Meeting databases, calendar integrations, or profile intelligence
- Automatic Ollama startup
- A large UI component library
- A bundled local Whisper model
- A broad cross-platform feature matrix before the macOS path is stable

These are not forgotten features; they are boundaries that protect the first useful release.

## Contributing

Small, testable changes are preferred. Before opening a pull request:

1. Explain the user-facing behavior and the boundary it belongs to.
2. Add a failing test for new behavior before implementation.
3. Run type checking, unit tests, and the production build.
4. Keep credentials, screenshots, model files, and build output out of commits.

Please open an issue before undertaking a large architectural change. The project is intentionally being built in milestones so each step can be evaluated on its own.

## License

Fluely is available under the [MIT License](LICENSE).
