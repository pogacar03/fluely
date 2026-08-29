# Fluely Milestone 1 Design

**Status:** Approved for implementation

**Source design:** `/Users/yu/Documents/cluely二开/Natively-Lite-重构设计文档.md`

**Product:** Fluely

**Repository:** `https://github.com/pogacar03/fluely`

## Goal

Deliver the first runnable Fluely desktop slice: a small Electron application with a React renderer, a secure typed IPC boundary, atomic JSON settings, configurable global shortcuts, and a compact status/settings surface. The slice must run without a provider, screenshot capture, voice model, database, RAG runtime, or other large optional dependency.

## Scope

### In scope

- Electron main process and BrowserWindow lifecycle.
- React + Vite renderer.
- `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- A preload API exposing only allow-listed typed operations.
- Shared TypeScript contracts for settings, shortcuts, and IPC results.
- Settings stored below the Fluely-specific application data directory.
- Atomic settings writes using a temporary file and rename.
- Default shortcut registration for show/hide, screenshot placeholder, analyze placeholder, capture-and-analyze placeholder, and cancel/clear placeholder.
- Configurable shortcut validation and registration error reporting.
- Minimal UI showing app status, registered shortcut state, settings, and reset-to-defaults action.
- Node built-in unit tests for pure settings and shortcut behavior.
- Development build, production build, and packaging configuration with a file allowlist.

### Out of scope for this slice

- Real screenshot capture and image queue.
- Codex CLI or HTTP provider execution.
- API key storage in macOS Keychain.
- Phone mirror, QR pairing, WebSocket transport, VAD, STT, or model downloads.
- Conversation persistence beyond settings.
- Automatic updates.
- Final production icon artwork or final notarization/signing identity.

## Architecture

```text
Renderer (React)
  └─ window.fluely.settings / window.fluely.shortcuts
       └─ Preload allow-list
            └─ typed IPC
                 └─ Main process services
                      ├─ SettingsService
                      └─ ShortcutManager
```

The renderer never imports Node.js modules and never receives a filesystem path to the settings file. The main process owns persistence and global shortcut registration. The preload bridge translates only the operations needed by the UI; it does not expose generic `ipcRenderer`, `fs`, `path`, or shell access.

## Product identity for Milestone 1

- Display name: `Fluely`.
- Package name: `fluely`.
- Provisional Bundle ID: `com.pogacar03.fluely`.
- Provisional data directory name: `Fluely`.
- The provisional Bundle ID and placeholder icon remain explicitly replaceable before packaging a public release.

## Contracts

### Settings

```ts
interface FluelySettings {
  shortcuts: ShortcutSettings;
  window: {
    width: number;
    height: number;
  };
}

interface ShortcutSettings {
  toggleVisibility: string;
  captureScreenshot: string;
  analyzeQueue: string;
  captureAndAnalyze: string;
  cancelAndClear: string;
}
```

Defaults:

```ts
{
  shortcuts: {
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+Shift+8",
    analyzeQueue: "CommandOrControl+Enter",
    captureAndAnalyze: "CommandOrControl+Shift+Enter",
    cancelAndClear: "CommandOrControl+R"
  },
  window: { width: 960, height: 720 }
}
```

Settings input is normalized before persistence. Unknown keys are ignored, shortcut values must be non-empty strings, window dimensions are clamped to safe minimum and maximum values, and malformed or unreadable settings fall back to defaults while preserving the invalid file with a timestamped backup when possible.

### IPC

The first slice exposes these operations:

```text
settings:get       () => FluelySettings
settings:update    (patch: SettingsPatch) => FluelySettings
settings:reset     () => FluelySettings
shortcuts:get      () => ShortcutStatus
shortcuts:update   (shortcuts: ShortcutSettings) => ShortcutStatus
app:get-status     () => AppStatus
```

All handlers validate structured inputs and return serializable values. Renderer-facing errors use a stable `{ code, message, action }` shape so the UI can tell the user what to do next.

### Shortcut behavior

`CommandOrControl+B` is the only fully implemented behavior in this slice: it toggles the BrowserWindow visibility. The other default registrations are reserved for later milestones and report a clear status without changing window visibility. Registering a shortcut must be idempotent: a re-registration first unregisters the previous registration, then records success or the operating-system conflict.

## Error handling

- Settings read failure: use defaults, show a recoverable warning, and never block app startup.
- Settings write failure: keep the in-memory settings, return an actionable error, and avoid reporting the write as successful.
- Shortcut conflict: retain the requested setting, mark that shortcut unavailable, and show the conflict in the UI.
- IPC validation failure: reject before reaching the service and return `INVALID_ARGUMENT`.
- Renderer load failure: log to the main process and show a minimal fallback message.

## Testing

Pure service tests must cover:

- default settings shape;
- normalization of empty, malformed, and out-of-range settings;
- atomic write target selection without exposing secrets;
- shortcut validation and duplicate detection;
- registration state after a simulated conflict;
- visibility toggle behavior independent of analysis actions.

Integration smoke checks must cover:

- compiled Electron entry points exist;
- the preload bridge exposes only the documented API names;
- the renderer bundle builds without Node.js imports;
- the production package configuration includes only runtime files.

## Acceptance criteria

- `npm run typecheck` passes.
- `npm test` passes with the new service tests.
- `npm run build` produces renderer and Electron output.
- `npm run package:dir` produces a runnable unpacked app directory without test files, source maps, or a blanket `node_modules` allowlist.
- Launching the app displays Fluely and a status/settings surface.
- `CommandOrControl+B` toggles visibility and does not trigger analysis.
- No provider, screenshot, voice, database, RAG, or model download code is loaded by default.
- Existing Natively directories and installed applications remain untouched.
