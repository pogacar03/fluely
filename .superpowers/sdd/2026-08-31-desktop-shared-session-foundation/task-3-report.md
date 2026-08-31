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
