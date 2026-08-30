# Fluely Codex Workspace Design

**Status:** Approved for implementation by the current user request

**Product:** Fluely

**Repository:** `/Users/yu/Documents/cluely二开/fluely`

**Source references:** Fluely's existing capture-privacy slice, the local
`Natively-Lite-重构设计文档.md`, Natively's public UI, and the installed Codex
CLI (`codex-cli 0.148.0-alpha.21`).

## Goal

Turn the current foundation/settings surface into a usable, local-first screen
copilot: first-run Codex CLI configuration, a separate compact work overlay,
and a screenshot-question flow that streams answers from Codex CLI.

## User-visible flow

### First launch

1. Fluely opens the setup view instead of the foundation dashboard.
2. The setup view auto-detects the installed Codex executable when possible and
   permits a manual executable path.
3. The user chooses the normal model, fast model, reasoning effort, timeout,
   and capture-protection policy. Fluely validates the executable with
   `codex --version` and reports actionable auth/path failures.
4. Selecting **Start using Fluely** persists the configuration, marks setup as
   complete, and changes the renderer to the work view without opening a second
   application window.

### Work view

The work view is a compact, frameless-feeling dark overlay inspired by the
public Natively interaction pattern: a small title/control row, one central
answer surface, and a bottom ask/action row. It is not a copy of Natively's
source or private process-disguise behavior.

The work view contains:

- a title/status row with Fluely identity, Codex connection state, settings,
  hide, and window opacity control;
- an answer surface that renders streamed Markdown-like plain text safely as
  text, with an explicit empty/loading/error state;
- a screenshot queue strip showing count, dimensions, and remove/clear actions;
- a question composer with a multiline prompt and actions for **Capture & ask**,
  **Ask queue**, and **Cancel**;
- intent chips: **Answer**, **Explain**, **Follow-up**, and **Recap**;
- a route back to setup/settings without destroying the active conversation.

The default window opacity is `0.92`, clamped to `0.35..1.0`. The default work
window is always-on-top and draggable from its header; click-through is not
enabled by default because it makes the question composer unreliable.

### Codex CLI analysis

The main process owns the provider. It invokes the local executable with an
argument array, never a shell string:

```text
codex exec --ephemeral --json --color never --sandbox read-only \
  --model <model> --image <queue-image-1> --image <queue-image-2>
```

The prompt is written to stdin. The provider parses JSONL events and emits
answer deltas to the renderer. `AbortSignal` terminates the child process on
Cancel or on a new request. Existing local Codex CLI authentication is reused;
Fluely never exposes an API key to the renderer or invents a reusable session
protocol unsupported by the installed CLI.

Capture routes:

- **Capture & ask** hides Fluely through the existing screenshot session,
  captures the display, appends it to the managed queue, and starts analysis.
- **Ask queue** analyzes the selected queued screenshots without changing
  Fluely's visibility state.
- `CommandOrControl+Shift+Enter` invokes Capture & ask.
- `CommandOrControl+Enter` invokes Ask queue.
- `CommandOrControl+R` cancels the active request and clears the screenshot
  queue.

The provider receives managed screenshot paths only in the main process. The
renderer receives queue metadata and answer events, never filesystem paths,
raw PNG bytes, or child-process handles.

## State and IPC contracts

Persisted settings extend the existing contract with:

```ts
interface CodexCliSettings {
  enabled: boolean;
  path: string;
  model: string;
  fastModel: string;
  timeoutMs: number;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  modelReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
}

interface WindowSettings {
  width: number;
  height: number;
  opacity: number;
}

interface FluelySettings {
  setupComplete: boolean;
  shortcuts: ShortcutSettings;
  window: WindowSettings;
  privacy: PrivacySettings;
  codex: CodexCliSettings;
}
```

New renderer-facing operations are narrow and typed:

```text
codex:get-status       () => CodexStatus
codex:validate         (path) => CodexStatus
analysis:start         ({ prompt, screenshotIds, intent, fast }) => AnalysisState
analysis:cancel        () => AnalysisState
analysis:get-status    () => AnalysisState
analysis:state-changed (event)       // main → renderer stream
window:set-opacity     (opacity) => WindowSettings
window:set-mode        ("setup" | "work") => void
```

`AnalysisState` includes `idle | running | completed | cancelled | error`, the
current answer text, active screenshot IDs, timestamps, model, and an
actionable error when applicable. Every input is validated in the main process.

## Error handling

- Missing executable: show the configured path and the exact next step.
- `codex --version` failure: distinguish missing binary, non-zero exit, and
  timeout.
- Not logged in: tell the user to run `codex login` in Terminal.
- Empty or malformed JSONL: preserve stderr/error detail and show a retry path.
- Provider timeout: kill the child, restore `idle/error`, and leave the queue
  intact for retry.
- Cancel: terminate the child, mark the request cancelled, and never append a
  partial answer as a completed answer.
- Renderer unmount or window close: unsubscribe listeners and cancel in-flight
  analysis without unhandled promise rejections.

## Security and privacy boundary

- Keep `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- Keep all CLI spawn, filesystem paths, and screenshot bytes in the main
  process.
- Use public Electron window APIs only; do not add process disguise, private
  display-server APIs, monitoring detection, or permission bypass.
- Keep the existing best-effort capture-protection limitation documented.

## Testing and acceptance

The implementation is test-first and must add coverage for:

- settings normalization/defaults for setup state, Codex config, and opacity;
- Codex argv construction, JSONL delta parsing, validation, timeout, and
  AbortSignal termination;
- analysis queue path lookup and analysis state ordering;
- IPC allow-list and input validation;
- setup-to-work transition and work-view actions;
- opacity clamping and persistence;
- full capture-and-analyze composition including timeout/cancel cleanup.

The existing 93-test suite must remain green. `npm run typecheck`, `npm run
build`, `npm run package:dir`, the package allowlist, and `git diff --check`
must pass. A real macOS smoke test remains necessary for window compositing,
always-on-top behavior, TCC permissions, and the installed Codex account.
