# Task 3 report: explicit screenshot capture/send controls

## Status

Implemented Plan A Task 3 against `e36d0f54f74945a23d03f9121e90e78b71257c1f`. No application launch was performed; packaged PID 34152 was preserved. No subagents were dispatched, per instruction. The requested commit message is `feat: add explicit screenshot send controls`.

## TDD evidence

- RED: the first pure queue run failed with `ERR_MODULE_NOT_FOUND` for the absent `dist-electron/src/shared/context-queue.js`.
- RED: the first workspace IPC run had six expected failures because `workspace.execute` and `workspace:execute` did not exist.
- RED: the first renderer state run had two expected failures for the old `Ask queue` label and missing workspace action state.
- GREEN: the final focused set passed 63/63; the full suite passed 190/190.

## Queue and action semantics

`ContextScreenshot` is `{ id, capturedAt, width, height, mimeType: "image/png", previewUrl }`. The shared queue is capped at five and appends in order, evicting the oldest item only when the cap is exceeded. `Capture` appends only and never starts analysis. `Send images` sends every queued ID in display order, never captures or mutates the draft queue, and normalizes blank/whitespace input to exactly `Analyze the attached screenshots.`. `Capture & ask` captures first and calls analysis only after capture succeeds. Send success, failure, and cancellation preserve the draft queue; only per-item remove and `clear-queue` mutate it. Same request IDs/fingerprints coalesce; reuse with a different command is rejected.

## IPC and renderer behavior

One shared `WorkspaceCommand` union covers capture, remove, clear-queue, clear-conversation, send, capture-and-send, and cancel. Preload exposes only `workspace.execute` for the new command path. Main validates object shape, supported type, trimmed request IDs (max 128), strict UUID remove IDs, and string prompts (max 3000) before services run. The private `fluely-media://context/<id>` handler serves only queued strict UUIDs as PNG with `no-store`; invalid, evicted, deleted, or unknown IDs return 404. No renderer/DOM state contains filesystem paths.

The Work view now exposes Capture, Send images, Capture & ask, Cancel, per-thumbnail remove, and Clear all. It renders ordered thumbnails, capacity, permission state, accessible labels, disabled states, and button spinners. A main-process command result refreshes queue/analysis state; there are no optimistic chat messages. Errors and cancellation remain visible/retryable.

## Changed paths

`src/shared/context-queue.ts`, `src/shared/__tests__/context-queue.test.mjs`, `src/shared/ipc.ts`, `src/shared/workspace-state.ts`, `electron/preload.ts`, `electron/preloadBridge.ts`, `electron/main.ts`, `electron/services/ScreenshotService.ts`, `electron/services/ipcHandlers.ts`, `electron/services/__tests__/ScreenshotService.test.mjs`, `electron/services/__tests__/ipc-contract.test.mjs`, `electron/services/__tests__/workspace-command-ipc.test.mjs`, `src/renderer/App.tsx`, `src/renderer/components/ContextQueue.tsx`, `src/renderer/components/QueueStrip.tsx`, `src/renderer/components/WorkView.tsx`, `src/renderer/styles.css`, and `src/renderer/__tests__/workspace-state.test.mjs`.

## Verification and concerns

- `node --test ...` focused Task 3 set: 63 passed, 0 failed.
- `npm test`: 190 passed, 0 failed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- App launch/user gate was intentionally deferred. The known spinner/no-output integration blocker remains; it was not hidden with local messages. Immutable sent attachment copies and canonical conversation/controller integration remain Task 4 work.

## Fix Round 1

### Findings and bounded design

The renderer previously generated `desktop-<action>-<counter>` IDs, so a reload reset the counter while the process-lifetime main deduper retained old promises indefinitely. Request IDs now include one cryptographically random UUID nonce per renderer mount plus the action and monotonic sequence; the factory accepts an injectable nonce source for deterministic tests. The main deduper keeps all in-flight entries and exactly the 512 most recently completed IDs in deterministic completion-order FIFO. Same-ID/same-command requests still join one promise, and reuse for another command still fails.

### RED/GREEN evidence

- RED request-ID run: 15 tests produced 3 expected failures—the factory was absent in the pure and reload integration tests, and the 513th completion did not evict the oldest cached result. The pre-existing pending-join test remained green.
- RED media run: 1 expected failure reported `private context media handler seam is missing` before the production protocol handler was extracted.
- Renderer harness note: the six real-component interaction tests were characterization coverage for behavior already present and passed on their first run; they mount the compiled `App`/actual `WorkView`, use the production preload and workspace handler, and click the actual controls.
- GREEN focused run: 61 passed, 0 failed, covering request IDs/deduplication, real WorkView interactions, workspace IPC, real screenshot store/private preview retrieval and cleanup, screenshot service, IPC contract, and renderer workspace state.
- GREEN full verification: `npm test` 201/201; `npm run typecheck` passed; `npm run build` passed; `git diff --check` passed.

### Queue/actions, IPC, and renderer behavior

All binding Task 3 semantics remain unchanged: at most five PNGs; Capture only appends; Send images sends every queued ID with blank input normalized exactly to `Analyze the attached screenshots.`; Capture & ask completes capture before send; success, failure, and cancel retain the draft queue; only remove/clear-queue mutate it. The shared `WorkspaceCommand` remains the sole command union. The mounted renderer tests prove action ordering, all-image send, busy/disabled duplicate prevention, cancel routing, and retry after an error without queue loss or an optimistic answer. The real workspace handler plus real `ScreenshotService` and extracted production media handler prove opaque `fluely-media` retrieval, no serialized filesystem path, and 404 after clear-queue (including invalid traversal input).

### Changed paths

`src/shared/context-queue.ts`, `src/shared/__tests__/context-queue.test.mjs`, `src/renderer/App.tsx`, `src/renderer/__tests__/workview-interactions.test.mjs`, `electron/services/context-media.ts`, `electron/main.ts`, `electron/services/__tests__/workspace-command-ipc.test.mjs`, `electron/services/__tests__/workspace-media-integration.test.mjs`, `electron/tsconfig.json`, `package.json`, and `package-lock.json`. The requested commit subject is `fix: close screenshot queue review findings`.

### Concerns

No app was launched and packaged PID 34152 remained running. The known spinner/no-output issue remains a final integration blocker for controller/Task 4; this round found no new deterministic cause and added no optimistic local answer. Immutable sent copies remain Task 4. Installing the minimum renderer harness dependency (`jsdom`) left npm reporting 14 audit findings (13 high, 1 critical); no out-of-scope audit mutation was attempted.
