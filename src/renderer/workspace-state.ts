// Renderer-facing entrypoint for the pure workspace view-model helpers.
// Keeping the implementation in shared code also lets the Electron test
// compiler exercise the same functions without bundling React.
export * from "../shared/workspace-state";

