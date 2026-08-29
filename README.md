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
| 2 | Vision requests, streaming answers | Planned |
| 3 | Shared conversation context and phone mirror | Planned |
| 4 | Microphone input, VAD, pluggable STT | Planned |
| 5 | Packaging, performance, and release validation | Planned |

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
| Analyze queue | `⌘ Enter` | Sends queued screenshots and the current question |
| Capture and analyze | `⌘ ⇧ Enter` | Captures first, then starts analysis |
| Cancel / clear | `⌘ R` | Cancels the request and clears the queue |

Shortcuts will be configurable, validated on registration, and surfaced when the operating system reports a conflict.

## Background screenshots and capture privacy

`⌘ ⇧ 8` captures the display nearest the pointer through Electron's documented `desktopCapturer` API, even when Fluely is in the background. Before capture, Fluely hides its own window, waits briefly for the compositor, and restores the previous visible state without activating the app on macOS. If the native request times out, Fluely returns an error while keeping the window hidden until that request settles; restart Fluely if it never settles. The session-scoped queue stores at most five PNGs below Fluely's local user-data directory; startup and Clear remove only strict UUID-managed PNG/temp files and preserve unrelated files. The renderer receives only opaque IDs, timestamps, and dimensions, never filesystem paths or image bytes.

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
- Phone mirror bound to `127.0.0.1` by default
- Random pairing token for phone sessions
- No arbitrary client-supplied file paths
- Strict content security policy and `Cache-Control: no-store` for local phone pages

Fluely is not a security product. Please review the threat model before exposing the phone mirror to a LAN or using it with sensitive material.

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
