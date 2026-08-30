// The renderer state suite lives beside the renderer sources for discoverability.
// This bridge keeps it in the existing Node test glob after the shared helper
// is compiled by `build:electron`.
await import("../../../src/renderer/__tests__/workspace-state.test.mjs");

