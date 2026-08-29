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
  setHidden(hidden: boolean, onSettled?: () => void): void | PromiseLike<void>;
}

export type PlatformDetector = NodeJS.Platform | (() => NodeJS.Platform);

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
  private busy = false;
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly adapter: DockPrivacyAdapter) {}

  public setHidden(hidden: boolean, onSettled?: () => void): Promise<void> {
    const generation = ++this.generation;
    const start = () => this.startAction(hidden, generation, onSettled);

    if (!this.busy) {
      this.busy = true;
      try {
        const action = start();
        if (!isPromiseLike(action)) {
          this.busy = false;
          this.tail = Promise.resolve();
          return Promise.resolve();
        }

        const operation = Promise.resolve(action).then(
          () => {
            this.busy = false;
          },
          (error: unknown) => {
            this.busy = false;
            throw error;
          },
        );
        this.tail = operation.then(() => undefined, () => undefined);
        return operation;
      } catch (error) {
        this.busy = false;
        const operation = Promise.reject(error);
        this.tail = operation.then(() => undefined, () => undefined);
        return operation;
      }
    }

    const operation = this.tail.then(start, start).then(
      () => {
        this.busy = false;
      },
      (error: unknown) => {
        this.busy = false;
        throw error;
      },
    );
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
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

    if (isDestroyed(window)) {
      this.ownsDockHide = false;
      if (previouslyOwnedDockHide) {
        this.requestDockPolicy(false);
      }
      return;
    }

    this.window = window;
    this.ownsDockHide = this.platformDetector() === "darwin" && enabled;
    if (!this.requestDockPolicy()) {
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
      this.requestDockPolicy(false);
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

  private requestDockPolicy(forceEnabled?: boolean): boolean {
    if (this.platformDetector() !== "darwin" || !this.dockPolicy) {
      return false;
    }

    const enabled = forceEnabled ?? this.enabled;
    if (enabled) {
      this.ownsDockHide = true;
    }

    try {
      let settledSynchronously = false;
      const result = this.dockPolicy.setHidden(enabled, () => {
        settledSynchronously = true;
        if (this.window && !isDestroyed(this.window)) {
          this.applyToWindow(this.window);
        }
      });
      void Promise.resolve(result).catch(() => undefined);
      return settledSynchronously;
    } catch {
      // Dock visibility is best-effort and can be unavailable during teardown.
      return false;
    }
  }
}
