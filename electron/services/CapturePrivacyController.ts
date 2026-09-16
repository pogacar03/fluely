import type { BrowserWindow } from "electron";

export interface CapturePrivacyWindow {
  setContentProtection?: (enabled: boolean) => void;
  setHiddenInMissionControl?: (hidden: boolean) => void;
  on(event: "show", listener: () => void): unknown;
  removeListener(event: "show", listener: () => void): unknown;
  isDestroyed?: () => boolean;
}

export interface DockPrivacyAdapter {
  hide(): void | PromiseLike<unknown>;
  show(): void | PromiseLike<unknown>;
}

export interface DockPrivacyPolicy {
  setHidden(hidden: boolean, onSettled?: () => void, owner?: object): void | PromiseLike<void>;
}

export type PlatformDetector = NodeJS.Platform | (() => NodeJS.Platform);

interface DockPrivacyTask {
  hidden: boolean;
  generation: number;
  onSettled?: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function isDestroyed(window: CapturePrivacyWindow): boolean {
  return window.isDestroyed?.() ?? false;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null &&
    "then" in value && typeof (value as { then?: unknown }).then === "function";
}

/** Serializes public Dock hide/show calls and keeps the newest settled intent authoritative. */
export class DockPrivacyCoordinator implements DockPrivacyPolicy {
  private generation = 0;
  private processing = false;
  private readonly queue: DockPrivacyTask[] = [];
  private readonly owners = new Set<object>();
  private directIntent = false;

  public constructor(private readonly adapter: DockPrivacyAdapter) {}

  public setHidden(hidden: boolean, onSettled?: () => void, owner?: object): Promise<void> {
    const generation = ++this.generation;
    let actionHidden = hidden;
    if (owner) {
      if (hidden) {
        this.owners.add(owner);
      } else {
        this.owners.delete(owner);
      }
      actionHidden = this.owners.size > 0 || this.directIntent;
    } else {
      this.directIntent = hidden;
      actionHidden = this.owners.size > 0 || hidden;
    }

    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });

    this.queue.push({ hidden: actionHidden, generation, onSettled, resolve: resolveTask, reject: rejectTask });
    this.drain();
    return operation;
  }

  private drain(): void {
    if (this.processing) {
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.processing = true;
    let action: void | PromiseLike<unknown>;
    try {
      action = this.startAction(task.hidden, task.generation, task.onSettled);
    } catch (error) {
      task.reject(error);
      this.processing = false;
      this.drain();
      return;
    }

    if (!isPromiseLike(action)) {
      task.resolve();
      this.processing = false;
      this.drain();
      return;
    }

    void Promise.resolve(action).then(
      () => {
        task.resolve();
        this.processing = false;
        this.drain();
      },
      (error: unknown) => {
        task.reject(error);
        this.processing = false;
        this.drain();
      },
    );
  }

  private startAction(
    hidden: boolean,
    generation: number,
    onSettled: (() => void) | undefined,
  ): void | PromiseLike<unknown> {
    const action = hidden ? this.adapter.hide() : this.adapter.show();
    if (!isPromiseLike(action)) {
      this.reassertIfCurrent(generation, onSettled);
      return;
    }

    return Promise.resolve(action).then(() => {
      this.reassertIfCurrent(generation, onSettled);
    });
  }

  private reassertIfCurrent(generation: number, onSettled: (() => void) | undefined): void {
    if (generation !== this.generation || !onSettled) {
      return;
    }

    try {
      onSettled();
    } catch {
      // Content-protection reassertion is best-effort and must not break Dock ordering.
    }
  }
}

const sharedDockCoordinators = new WeakMap<object, DockPrivacyCoordinator>();

export class CapturePrivacyController {
  private window: CapturePrivacyWindow | null = null;
  private enabled = true;
  private ownsDockHide = false;
  private readonly dockOwner = {};
  private readonly platformDetector: () => NodeJS.Platform;
  private readonly dockPolicy: DockPrivacyPolicy | undefined;
  private readonly onShow = (): void => {
    this.reassert();
  };

  public constructor(
    platform: PlatformDetector = process.platform,
    dock?: DockPrivacyAdapter | DockPrivacyPolicy,
  ) {
    this.platformDetector = typeof platform === "function" ? platform : () => platform;
    this.dockPolicy = dock && "setHidden" in dock
      ? dock
      : dock ? this.getSharedDockCoordinator(dock) : undefined;
  }

  private getSharedDockCoordinator(dock: DockPrivacyAdapter): DockPrivacyCoordinator {
    const existing = sharedDockCoordinators.get(dock);
    if (existing) {
      return existing;
    }

    const coordinator = new DockPrivacyCoordinator(dock);
    sharedDockCoordinators.set(dock, coordinator);
    return coordinator;
  }

  public apply(window: CapturePrivacyWindow | BrowserWindow, enabled: boolean): void {
    const previouslyOwnedDockHide = this.ownsDockHide;
    this.detach();
    this.window = null;
    this.enabled = enabled;

    const nextOwnsDockHide = this.platformDetector() === "darwin" && enabled && !!this.dockPolicy && !isDestroyed(window);
    if (previouslyOwnedDockHide && !nextOwnsDockHide) {
      this.ownsDockHide = false;
      this.requestDockPolicy(false, this.dockOwner);
    }

    if (isDestroyed(window)) {
      return;
    }

    this.window = window;
    this.ownsDockHide = nextOwnsDockHide;
    if (nextOwnsDockHide) {
      if (!this.requestDockPolicy(true, this.dockOwner)) {
        this.applyToWindow(window);
      }
    } else if (!previouslyOwnedDockHide && !this.requestDockPolicy(false)) {
      this.applyToWindow(window);
    } else if (previouslyOwnedDockHide) {
      // The release request above owns Dock ordering; protect the replacement window now.
      this.applyToWindow(window);
    }
    try {
      window.on("show", this.onShow);
    } catch {
      // Ignore teardown races while a BrowserWindow is closing.
    }
  }

  public reassert(): void {
    if (!this.window || isDestroyed(this.window)) {
      return;
    }

    if (!this.requestDockPolicy()) {
      this.applyToWindow(this.window);
    }
  }

  public dispose(): void {
    this.detach();
    this.window = null;
    if (this.platformDetector() === "darwin" && this.ownsDockHide) {
      this.ownsDockHide = false;
      this.requestDockPolicy(false, this.dockOwner);
    }
  }

  private applyToWindow(window: CapturePrivacyWindow): void {
    if (isDestroyed(window)) {
      return;
    }

    try {
      window.setContentProtection?.(this.enabled);
    } catch {
      // A window can be destroyed between the liveness check and the call.
    }

    if (this.platformDetector() !== "darwin") {
      return;
    }

    if (isDestroyed(window)) {
      return;
    }

    try {
      window.setHiddenInMissionControl?.(this.enabled);
    } catch {
      // Mission Control hiding is best-effort and unavailable on some builds.
    }
  }

  private detach(): void {
    if (!this.window) {
      return;
    }

    try {
      this.window.removeListener("show", this.onShow);
    } catch {
      // Ignore teardown races with a destroyed BrowserWindow.
    }
  }

  private requestDockPolicy(forceEnabled?: boolean, owner?: object): boolean {
    if (this.platformDetector() !== "darwin" || !this.dockPolicy) {
      return false;
    }

    const enabled = forceEnabled ?? this.enabled;
    const policyOwner = owner ?? (enabled ? this.dockOwner : undefined);

    try {
      let settledSynchronously = false;
      const result = this.dockPolicy.setHidden(enabled, () => {
        settledSynchronously = true;
        if (this.window && !isDestroyed(this.window)) {
          this.applyToWindow(this.window);
        }
      }, policyOwner);
      void Promise.resolve(result).catch(() => undefined);
      return settledSynchronously;
    } catch {
      // Dock visibility is best-effort and can be unavailable during teardown.
      return false;
    }
  }
}
