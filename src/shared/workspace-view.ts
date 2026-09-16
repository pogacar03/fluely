export type WorkspaceView = "settings" | "work";

const FIXED_TIMEOUT_POLICY_COPY =
  "Fluely uses fixed request deadlines: startup 120,000 ms, idle 120,000 ms, and a hard ceiling of 600,000 ms. These limits are not user-configurable.";

export function initialWorkspaceView(setupComplete: boolean): WorkspaceView {
  return setupComplete ? "work" : "settings";
}

export function canOpenWork(setupComplete: boolean): boolean {
  return setupComplete;
}

/** Keeps navigation session-only while preventing an incomplete setup from entering Work. */
export function navigateWorkspaceView(
  current: WorkspaceView,
  requested: WorkspaceView,
  setupComplete: boolean,
): WorkspaceView {
  if (requested === "work" && !canOpenWork(setupComplete)) {
    return current;
  }
  return requested;
}

export function timeoutPolicyCopy(): string {
  return FIXED_TIMEOUT_POLICY_COPY;
}
