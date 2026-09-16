# Fluely Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build a runnable Fluely Electron foundation with secure IPC, atomic settings, configurable shortcuts, and a polished status surface.

**Architecture:** Keep the renderer limited to React UI and a narrow preload API. Keep persistence and global shortcut registration in the Electron main process, with pure normalization and registration logic extracted into independently testable modules.

**Tech Stack:** Electron, TypeScript, React, Vite, Node.js built-in test runner, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-08-30-fluely-milestone-1-design.md`

## Global Constraints

- Product display name is `Fluely`.
- Package name is `fluely`.
- Provisional Bundle ID is `com.pogacar03.fluely`.
- `contextIsolation` must be `true`.
- `sandbox` must be `true`.
- `nodeIntegration` must be `false`.
- Renderer must not import Node.js modules or receive the settings file path.
- No provider, screenshot, voice, database, RAG, embedding, or model-download dependency is included in Milestone 1.
- Production packaging uses an allowlist and never uses a blanket `node_modules` file entry.
- Existing Natively applications and user data are out of scope and must not be touched.

---

### Task 1: Bootstrap the Fluely project shell

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `electron/tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `electron/main.ts`
- Create: `electron/preload.ts`
- Create: `electron/windowConfig.ts`
- Create: `electron/services/__tests__/windowConfig.test.mjs`
- Create: `src/shared/ipc.ts`
- Create: `src/renderer/main.tsx`
- Create: `src/renderer/App.tsx`
- Create: `src/renderer/styles.css`
- Create: `assets/icon.svg`

**Interfaces:**
- Produces the compiled entry points `dist/index.html`, `dist-electron/electron/main.js`, and `dist-electron/electron/preload.js`.
- Produces `window.fluely` type declarations for later service tasks.

- [x] **Step 1: Add the minimal package and compiler configuration**

Use this dependency shape and scripts:

```json
{
  "name": "fluely",
  "version": "0.1.0",
  "productName": "Fluely",
  "private": true,
  "main": "dist-electron/electron/main.js",
  "scripts": {
    "clean": "rimraf dist dist-electron release",
    "build:renderer": "vite build",
    "build:electron": "tsc -p electron/tsconfig.json",
    "build": "npm run clean && npm run build:renderer && npm run build:electron",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p electron/tsconfig.json --noEmit",
    "test": "npm run build:electron && node --test electron/services/__tests__/*.test.mjs",
    "package:dir": "npm run build && electron-builder --dir"
  },
  "dependencies": {},
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@types/node": "^22.10.2",
    "electron": "^40.10.2",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "electron-builder": "^25.1.8",
    "rimraf": "^6.0.1",
    "typescript": "^5.7.2",
    "vite": "^6.0.5"
  }
}
```

The exact versions may be updated only if the package manager resolves a compatible current patch release during install; do not add a UI component framework or runtime service dependency.

- [x] **Step 2: Configure the renderer and Electron compiler targets**

Set the renderer compiler to strict ES modules with DOM types and the Electron compiler to strict CommonJS output under `dist-electron`, including `electron/**/*.ts` and `src/shared/**/*.ts`. Configure Vite to use React, emit `dist`, and avoid source maps in production output.

- [x] **Step 3: Write the failing secure-window test**

Add a pure `getWindowPreferences(preloadPath)` contract test:

```js
test("window preferences enforce the Fluely security boundary", () => {
  const preferences = getWindowPreferences("/tmp/preload.js");
  assert.equal(preferences.preload, "/tmp/preload.js");
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.nodeIntegration, false);
});
```

Run:

```bash
npm test -- electron/services/__tests__/windowConfig.test.mjs
```

Expected: FAIL because `dist-electron/electron/windowConfig.js` does not exist yet.

- [x] **Step 4: Implement the secure window shell**

Create `electron/main.ts` with an app-ready lifecycle that creates a `BrowserWindow` using:

```ts
webPreferences: {
  preload: join(__dirname, "preload.js"),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
}
```

Keep the object-producing helper in `electron/windowConfig.ts` so the security contract is testable without starting Electron.

Set the app name to `Fluely`, open `dist/index.html`, show the window after `ready-to-show`, and quit on non-macOS `window-all-closed`. Keep service registration in named functions so later tasks can attach handlers without turning `main.ts` into a service implementation.

- [x] **Step 5: Run the secure-window test green**

Run:

```bash
npm test -- electron/services/__tests__/windowConfig.test.mjs
```

Expected: PASS with the four security assertions above.

- [x] **Step 6: Add the renderer status surface**

Build a compact dark Fluely shell with a header, status badge, shortcut summary, and an empty-state card explaining that capture and providers arrive in later milestones. Use semantic HTML, CSS variables, and no external font or icon package. The UI must not use `require`, `process`, `fs`, `path`, or any Electron import.

- [x] **Step 7: Build the shell and verify entry points**

Run:

```bash
npm install
npm run typecheck
npm run build
```

Expected: all commands pass and the three output entry points exist. Do not add service behavior until the service tests in later tasks are written first.

- [x] **Step 8: Commit the bootstrap**

```bash
git add package.json package-lock.json tsconfig.json electron/tsconfig.json vite.config.ts index.html electron src assets/icon.svg
git commit -m "feat: bootstrap Fluely desktop shell"
```

### Task 2: Implement settings normalization and atomic persistence

**Files:**
- Create: `electron/services/settings-core.ts`
- Create: `electron/services/SettingsService.ts`
- Create: `electron/services/__tests__/settings-core.test.mjs`
- Create: `electron/services/__tests__/SettingsService.test.mjs`
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- `settings-core.ts` produces `DEFAULT_SETTINGS`, `normalizeSettings(input: unknown): FluelySettings`, `normalizeSettingsPatch(input: unknown): SettingsPatch`, and `validateSettingsPatch(input: unknown): IpcError | null`.
- `SettingsService` produces `load(): Promise<SettingsLoadResult>`, `get(): FluelySettings`, `update(patch: SettingsPatch): Promise<ServiceResult<FluelySettings>>`, and `reset(): Promise<ServiceResult<FluelySettings>>`.

- [x] **Step 1: Write failing normalization tests**

Add tests for the exact defaults, whitespace shortcut fallback, unknown key removal, and dimension clamping:

```js
test("normalizeSettings returns Fluely defaults for empty input", () => {
  assert.deepEqual(normalizeSettings({}), DEFAULT_SETTINGS);
});

test("normalizeSettings clamps unsafe window dimensions", () => {
  const settings = normalizeSettings({ window: { width: 20, height: 99999 } });
  assert.equal(settings.window.width, 480);
  assert.equal(settings.window.height, 1400);
});

test("normalizeSettings ignores unknown keys and blank shortcuts", () => {
  const settings = normalizeSettings({ shortcuts: { toggleVisibility: "   " }, leaked: "secret" });
  assert.equal(settings.shortcuts.toggleVisibility, DEFAULT_SETTINGS.shortcuts.toggleVisibility);
  assert.equal(Object.hasOwn(settings, "leaked"), false);
});
```

- [x] **Step 2: Run the tests and verify the expected missing-module failure**

Run:

```bash
npm test -- electron/services/__tests__/settings-core.test.mjs
```

Expected: FAIL because `dist-electron/electron/services/settings-core.js` does not exist yet.

- [x] **Step 3: Implement the smallest pure normalization module**

Define the default object once, clone nested objects when returning it, clamp width to `480..1600` and height to `360..1400`, trim non-empty shortcut strings, and ignore all unknown input keys. Keep this module independent of Electron and filesystem APIs.

- [x] **Step 4: Run the normalization tests green**

Run:

```bash
npm test -- electron/services/__tests__/settings-core.test.mjs
```

Expected: PASS for all normalization tests.

- [x] **Step 5: Write failing atomic persistence tests**

Use a temporary directory and a small injected filesystem adapter. Verify that `save()` writes JSON to a temporary sibling and renames it into place, that the final file is mode `0600`, and that a malformed existing file is backed up before defaults are used. Do not assert implementation-private helper calls; assert the final file content and backup result.

- [x] **Step 6: Implement `SettingsService` with atomic writes**

Resolve the file as `join(userDataPath, "settings.json")`; create the directory recursively; write to `${file}.tmp-${process.pid}-${randomSuffix}`; call `rename`; and clean up a failed temporary write. When JSON parsing fails, copy the original to `settings.invalid-${timestamp}.json` when possible, return defaults, and expose an actionable warning without aborting startup. Keep the in-memory settings unchanged when an update write fails.

- [x] **Step 7: Run service tests and typecheck**

Run:

```bash
npm test -- electron/services/__tests__/SettingsService.test.mjs
npm run typecheck
```

Expected: PASS with no type errors.

- [x] **Step 8: Commit settings**

```bash
git add src/shared/ipc.ts electron/services/settings-core.ts electron/services/SettingsService.ts electron/services/__tests__
git commit -m "feat: add atomic Fluely settings service"
```

### Task 3: Implement shortcut validation and registration

**Files:**
- Create: `electron/services/ShortcutManager.ts`
- Create: `electron/services/__tests__/ShortcutManager.test.mjs`
- Modify: `src/shared/ipc.ts`

**Interfaces:**
- `ShortcutManager` consumes an injected `GlobalShortcutAdapter`, a `WindowAdapter`, and action callbacks.
- `ShortcutManager` produces `registerAll(shortcuts): IpcResult<ShortcutStatus>`, `update(shortcuts): IpcResult<ShortcutStatus>`, `getStatus(): ShortcutStatus`, and `dispose(): void`.
- `ShortcutStatus` contains every configured shortcut, `registered`, `errorCode`, `message`, and `action` fields in serializable form.

- [x] **Step 1: Write failing shortcut tests**

Cover duplicate detection, successful registration, conflict reporting, idempotent re-registration, and the visibility-only rule:

```js
test("duplicate accelerators are rejected before registration", () => {
  const manager = makeManager();
  const result = manager.registerAll({
    toggleVisibility: "CommandOrControl+B",
    captureScreenshot: "CommandOrControl+B",
    analyzeQueue: "CommandOrControl+Enter",
    captureAndAnalyze: "CommandOrControl+Shift+Enter",
    cancelAndClear: "CommandOrControl+R",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("toggle shortcut changes visibility without invoking analysis", () => {
  const window = makeWindow(false);
  const actions = { analyze: 0 };
  const manager = makeManager({ window, actions });
  manager.registerAll(DEFAULT_SETTINGS.shortcuts);
  manager.invoke("toggleVisibility");
  assert.equal(window.visible, true);
  assert.equal(actions.analyze, 0);
});
```

- [x] **Step 2: Run the shortcut tests to verify the expected missing-module failure**

Run:

```bash
npm test -- electron/services/__tests__/ShortcutManager.test.mjs
```

Expected: FAIL because the manager module is not present.

- [x] **Step 3: Implement validation and registration**

Validate every shortcut as a trimmed non-empty string, reject duplicate accelerators before changing the active registration, unregister prior accelerators on successful updates, and preserve the requested settings when the OS rejects a registration. Register `toggleVisibility` to call `window.show()` / `window.hide()` only. Register later-milestone actions as no-op callbacks whose status says `Not available in this milestone`.

- [x] **Step 4: Run the shortcut tests green**

Run:

```bash
npm test -- electron/services/__tests__/ShortcutManager.test.mjs
```

Expected: PASS for all shortcut tests.

- [x] **Step 5: Commit shortcut management**

```bash
git add src/shared/ipc.ts electron/services/ShortcutManager.ts electron/services/__tests__/ShortcutManager.test.mjs
git commit -m "feat: add configurable shortcut manager"
```

### Task 4: Wire typed IPC, preload, and the settings UI

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/styles.css`
- Create: `electron/services/ipcHandlers.ts`
- Create: `electron/services/__tests__/ipc-contract.test.mjs`

**Interfaces:**
- Preload exposes only `window.fluely.settings`, `window.fluely.shortcuts`, and `window.fluely.app` methods defined in `src/shared/ipc.ts`.
- `registerIpcHandlers(dependencies): () => void` consumes `SettingsService`, `ShortcutManager`, and `BrowserWindow` adapters.
- IPC failures serialize as `{ ok: false, error: { code, message, action } }`.

- [x] **Step 1: Write the failing IPC contract test**

Add a source-level smoke test that imports the compiled preload and asserts the exposed key set is exactly:

```js
["app", "settings", "shortcuts"]
```

Also assert that the preload does not expose `ipcRenderer`, `fs`, `path`, `shell`, or a generic `invoke` function.

- [x] **Step 2: Run the contract test and verify it fails for the missing bridge**

Run:

```bash
npm test -- electron/services/__tests__/ipc-contract.test.mjs
```

Expected: FAIL until the preload bridge exposes the documented API.

- [x] **Step 3: Implement shared contracts and preload allow-list**

Use `contextBridge.exposeInMainWorld("fluely", { ... })` with one wrapper per allowed method. The wrappers pass fixed channel names to `ipcRenderer.invoke`; no channel string or Electron object is accepted from renderer input.

- [x] **Step 4: Implement main-process handlers**

Register `settings:get`, `settings:update`, `settings:reset`, `shortcuts:get`, `shortcuts:update`, and `app:get-status`. Validate update payloads before invoking services, return stable error objects, and keep the settings file path inside the main process. Register shortcuts after settings load and dispose them on `will-quit`.

- [x] **Step 5: Connect the React UI to real settings and status**

On mount, load status, settings, and shortcut status in parallel. Render each shortcut with a success/conflict/unavailable badge. Add a controlled settings form for window width/height and shortcut strings, a save button, and a reset button. Show the actionable error message returned by IPC and keep the last known good UI state after failed writes.

- [x] **Step 6: Run build, tests, and manual launch**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run package:dir
```

Then launch the unpacked app generated under `release/` and verify that Fluely renders, settings can be saved/reset, and `CommandOrControl+B` toggles visibility without starting analysis.

- [x] **Step 7: Commit the integrated foundation**

```bash
git add src/shared/ipc.ts electron/main.ts electron/preload.ts electron/services/ipcHandlers.ts electron/services/__tests__/ipc-contract.test.mjs src/renderer
git commit -m "feat: wire secure Fluely IPC foundation"
```

### Task 5: Add packaging guardrails and final verification

**Files:**
- Create: `electron-builder.yml`
- Create: `.gitignore`
- Create: `.github/workflows/ci.yml`
- Create: `scripts/check-package-allowlist.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- `npm run package:dir` produces an unpacked package using only `dist/**`, `dist-electron/**`, `package.json`, and required runtime assets.
- CI runs `npm run typecheck`, `npm test`, and `npm run build` on a supported Node version.

- [x] **Step 1: Add an allowlisted Electron Builder configuration**

Use a configuration equivalent to:

```yaml
appId: com.pogacar03.fluely
productName: Fluely
directories:
  output: release
  buildResources: assets
files:
  - dist/**
  - dist-electron/**
  - package.json
  - assets/icon.svg
asar: true
mac:
  target:
    - zip
  category: public.app-category.productivity
```

Do not add `node_modules` as a file pattern. Keep the final icon replacement documented as a release task.

- [x] **Step 2: Add packaging and repository hygiene checks**

Ignore `node_modules`, `dist`, `dist-electron`, `release`, local settings, screenshots, model files, and `.DS_Store`. Have `scripts/check-package-allowlist.mjs` fail if the builder config contains a blanket `node_modules` pattern or if the release tree contains test files, source maps, or `.env` files.

- [x] **Step 3: Add CI and update the README status**

Add a GitHub Actions workflow that installs with `npm ci`, runs typecheck/tests/build, and updates the README milestone table from `In progress` to `Complete` only after all local acceptance checks pass. Keep README claims aligned with the actual build.

- [x] **Step 4: Run the complete verification set**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run package:dir
node scripts/check-package-allowlist.mjs
git diff --check
git status --short
```

Expected: all checks pass, the package is created under `release/`, and no files under the old Natively directory or `/Applications` have changed.

- [x] **Step 5: Push the development branch**

```bash
git push -u origin codex/fluely-foundation
```

Report the branch, commits, test count, build output, and any remaining provisional identity decisions. Do not delete or modify old Natively installations.
