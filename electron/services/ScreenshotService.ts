import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextScreenshot,
  IpcError,
  ScreenshotPermission,
  ScreenshotState,
} from "../../src/shared/ipc";
import { contextPreviewUrl, MAX_CONTEXT_SCREENSHOTS } from "../../src/shared/context-queue";

export interface ScreenshotSize {
  width: number;
  height: number;
}

export interface ScreenshotPoint {
  x: number;
  y: number;
}

export interface ScreenshotDisplay {
  id: number | string;
  bounds: ScreenshotSize;
  scaleFactor: number;
}

export interface ScreenshotThumbnail {
  toPNG(): Uint8Array;
  getSize(): ScreenshotSize;
}

export interface ScreenshotSource {
  display_id: string;
  thumbnail: ScreenshotThumbnail;
}

export interface DesktopCaptureAdapter {
  getSources(options: {
    types: ["screen"];
    thumbnailSize: ScreenshotSize;
  }): Promise<readonly ScreenshotSource[]>;
}

export interface ScreenAdapter {
  getCursorScreenPoint(): ScreenshotPoint;
  getDisplayNearestPoint(point: ScreenshotPoint): ScreenshotDisplay;
}

export interface SystemPreferencesAdapter {
  getMediaAccessStatus(type: "screen"): string;
}

export interface ScreenshotFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  writeFile(path: string, data: Uint8Array, options: { mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

export type ScreenshotPlatform = NodeJS.Platform | (() => NodeJS.Platform);

export interface ScreenshotServiceOptions {
  directory?: string;
  userDataPath?: string;
  rootDirectory?: string;
  rootDir?: string;
  screenshotDirectory?: string;
  platform?: ScreenshotPlatform;
  desktopCapturer: DesktopCaptureAdapter;
  screen: ScreenAdapter;
  systemPreferences?: SystemPreferencesAdapter;
  sourceTimeoutMs?: number;
  sourceEnumerationTimeoutMs?: number;
  idFactory?: () => string;
  now?: () => Date;
  clock?: () => Date;
  fileSystem?: ScreenshotFileSystem;
  onStateChanged?: (state: ScreenshotState) => void;
}

export type ScreenshotServiceError = IpcError;

const DEFAULT_SOURCE_TIMEOUT_MS = 5000;
const MANAGED_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png(?:\.tmp)?$/i;
const MANAGED_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVICE_ERROR_CODES = new Set<IpcError["code"]>([
  "SCREEN_CAPTURE_DENIED",
  "SCREEN_CAPTURE_RESTRICTED",
  "SCREEN_CAPTURE_PERMISSION_REQUIRED",
  "SCREEN_CAPTURE_FAILED",
  "CAPTURE_IN_PROGRESS",
  "SCREENSHOT_NOT_FOUND",
]);

const defaultFileSystem: ScreenshotFileSystem = {
  mkdir: (path, options) => mkdir(path, options),
  readdir: (path) => readdir(path),
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
};

function createError(code: IpcError["code"], message: string, action: string): ScreenshotServiceError {
  return { code, message, action };
}

function isServiceError(error: unknown): error is ScreenshotServiceError {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return typeof candidate.code === "string" &&
    SERVICE_ERROR_CODES.has(candidate.code as IpcError["code"]) &&
    typeof candidate.message === "string" &&
    typeof candidate.action === "string";
}

function permissionError(permission: ScreenshotPermission): ScreenshotServiceError | null {
  if (permission === "denied") {
    return createError(
      "SCREEN_CAPTURE_DENIED",
      "Fluely does not have permission to capture the screen.",
      "Open System Settings → Privacy & Security → Screen Recording, enable Fluely, then try again.",
    );
  }

  if (permission === "restricted") {
    return createError(
      "SCREEN_CAPTURE_RESTRICTED",
      "Screen capture is restricted by macOS.",
      "Ask your administrator to allow Screen Recording for Fluely.",
    );
  }

  if (permission === "not-determined") {
    return createError(
      "SCREEN_CAPTURE_PERMISSION_REQUIRED",
      "Fluely needs Screen Recording permission before it can capture.",
      "Open System Settings → Privacy & Security → Screen Recording and enable Fluely.",
    );
  }

  if (permission === "unavailable") {
    return createError(
      "SCREEN_CAPTURE_FAILED",
      "Fluely could not access the operating system screen-capture service.",
      "Check that a supported display is available and try again.",
    );
  }

  return null;
}

function captureFailed(): ScreenshotServiceError {
  return createError(
    "SCREEN_CAPTURE_FAILED",
    "Fluely could not capture the selected display.",
    "Check that a display is available and try again.",
  );
}

function captureTimedOut(): ScreenshotServiceError {
  return createError(
    "SCREEN_CAPTURE_FAILED",
    "Fluely could not finish the screen capture within five seconds.",
    "Restart Fluely and try again. A native capture request is still being released in the background.",
  );
}

function captureInProgress(): ScreenshotServiceError {
  return createError(
    "CAPTURE_IN_PROGRESS",
    "A screenshot capture is already in progress.",
    "Wait for the current capture to finish before trying again.",
  );
}

function screenshotNotFound(): ScreenshotServiceError {
  return createError(
    "SCREENSHOT_NOT_FOUND",
    "That screenshot is no longer in the queue.",
    "Refresh the screenshot queue and try again.",
  );
}

export class ScreenshotService {
  private readonly directory: string;
  private readonly platformDetector: () => NodeJS.Platform;
  private readonly sourceTimeoutMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly fileSystem: ScreenshotFileSystem;
  private readonly items: ContextScreenshot[] = [];
  private readonly initialization: Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();
  private capturing = false;
  private disposed = false;
  private permission: ScreenshotPermission = "unavailable";
  private cancelCapture: ((error: ScreenshotServiceError) => void) | null = null;
  private activeCapture: Promise<void> | null = null;

  public constructor(private readonly options: ScreenshotServiceOptions) {
    this.directory = options.directory ??
      (options.screenshotDirectory ??
        (options.userDataPath ? join(options.userDataPath, "screenshots") :
          options.rootDirectory ?? options.rootDir ?? ""));
    if (!this.directory) {
      throw new Error("ScreenshotService requires a managed directory.");
    }

    const platform = options.platform ?? process.platform;
    this.platformDetector = typeof platform === "function" ? platform : () => platform;
    this.sourceTimeoutMs = options.sourceTimeoutMs ?? options.sourceEnumerationTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? options.clock ?? (() => new Date());
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.initialization = this.cleanupManagedFiles();
  }

  public getState(): ScreenshotState {
    this.permission = this.readPermission();
    return {
      items: this.items.map((item) => ({ ...item })),
      capturing: this.capturing,
      permission: this.permission,
    };
  }

  /**
   * Resolves queue-owned PNG paths for main-process consumers only. Unknown,
   * malformed, or otherwise unqueued IDs are deliberately omitted so a
   * renderer-provided value can never escape the managed screenshot directory.
   */
  public getManagedPaths(ids?: readonly string[]): string[] {
    const queuedIds = new Set(this.items.map((item) => item.id));
    const requestedIds = ids === undefined
      ? this.items.map((item) => item.id)
      : Array.isArray(ids) ? ids : [];
    return requestedIds
      .filter((id): id is string => typeof id === "string" && MANAGED_ID_PATTERN.test(id) && queuedIds.has(id))
      .map((id) => join(this.directory, `${id}.png`));
  }

  public getManagedRoot(): string {
    return this.directory;
  }

  public capture(): Promise<ContextScreenshot> {
    if (this.capturing) {
      return Promise.reject(captureInProgress());
    }
    if (this.disposed) {
      return Promise.reject(captureFailed());
    }

    this.capturing = true;
    this.emitState();

    let notifyTimeout: ((error: ScreenshotServiceError) => void) | undefined;
    const timeoutNotice = new Promise<never>((_, reject) => {
      notifyTimeout = (error) => reject(error);
    });
    let cancelCapture!: (error: ScreenshotServiceError) => void;
    const cancellationNotice = new Promise<never>((_, reject) => {
      cancelCapture = reject;
    });
    this.cancelCapture = cancelCapture;

    const operation = this.enqueueMutation(async () => {
      let pendingSource: Promise<void> | undefined;
      let initialPermission: ScreenshotPermission = "unavailable";

      try {
        await this.initialization;
        initialPermission = this.readPermission();
        this.permission = initialPermission;
        const permissionFailure = this.getPlatform() === "darwin" && initialPermission !== "not-determined"
          ? permissionError(initialPermission)
          : null;
        if (permissionFailure) {
          throw permissionFailure;
        }

        const timeoutError = initialPermission === "not-determined"
          ? permissionError("not-determined") ?? captureFailed()
          : captureTimedOut();
        const source = await this.selectSource((settled) => {
          pendingSource = settled;
          let timeoutNotice = timeoutError;
          if (this.getPlatform() === "darwin" && initialPermission !== "not-determined") {
            this.permission = this.readPermission();
            timeoutNotice = permissionError(this.permission) ?? timeoutError;
          }
          notifyTimeout?.(timeoutNotice);
        }, timeoutError, cancellationNotice);
        if (this.getPlatform() === "darwin") {
          this.permission = this.readPermission();
          const permissionFailure = permissionError(this.permission);
          if (permissionFailure) {
            throw permissionFailure;
          }
        }
        const imageBytes = source.thumbnail.toPNG();
        const size = source.thumbnail.getSize();
        const id = this.idFactory();
        const item: ContextScreenshot = {
          id,
          capturedAt: this.now().getTime(),
          width: size.width,
          height: size.height,
          mimeType: "image/png",
          previewUrl: contextPreviewUrl(id),
        };

        await this.persist(item.id, imageBytes);
        this.items.push(item);
        await this.evictOldest();
        return { ...item };
      } catch (error) {
        if (this.getPlatform() === "darwin") {
          this.permission = this.readPermission();
          const refreshedPermissionError = permissionError(this.permission);
          if (refreshedPermissionError && this.permission !== "granted") {
            throw refreshedPermissionError;
          }
        }

        if (isServiceError(error)) {
          throw error;
        }
        throw captureFailed();
      } finally {
        if (pendingSource) {
          await pendingSource;
        }
        this.capturing = false;
        this.emitState();
      }
    });
    const activeCapture = operation.then(() => undefined, () => undefined);
    this.activeCapture = activeCapture;
    void activeCapture.finally(() => {
      if (this.activeCapture === activeCapture) {
        this.activeCapture = null;
        this.cancelCapture = null;
      }
    });
    return Promise.race([operation, timeoutNotice, cancellationNotice]);
  }

  /** Cancels the current capture boundary and waits until it can no longer persist queue state. */
  public async cancelPending(): Promise<void> {
    this.cancelCapture?.(captureFailed());
    await this.activeCapture;
  }

  /** Resolves only after all queued mutations, including a late native source settle, are idle. */
  public whenIdle(): Promise<void> {
    return this.initialization.then(() => this.mutationTail);
  }

  public delete(id: string): Promise<ScreenshotState> {
    return this.enqueueMutation(async () => {
      try {
        await this.initialization;
        const index = this.items.findIndex((item) => item.id === id);
        if (index < 0) {
          throw screenshotNotFound();
        }

        const [item] = this.items.splice(index, 1);
        await this.fileSystem.unlink(join(this.directory, `${item.id}.png`)).catch(() => undefined);
        return this.getState();
      } finally {
        this.emitState();
      }
    });
  }

  public clear(): Promise<ScreenshotState> {
    return this.enqueueMutation(async () => {
      try {
        await this.initialization;
        const items = this.items.splice(0);
        await Promise.all(items.map((item) => this.fileSystem.unlink(join(this.directory, `${item.id}.png`)).catch(() => undefined)));
        await this.cleanupManagedFiles();
        return this.getState();
      } finally {
        this.emitState();
      }
    });
  }

  public dispose(): void {
    this.disposed = true;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(mutation, mutation);
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private emitState(): void {
    try {
      this.options.onStateChanged?.(this.getState());
    } catch {
      // A state subscriber must not break capture or queue mutations.
    }
  }

  private readPermission(): ScreenshotPermission {
    if (this.getPlatform() !== "darwin") {
      return "unavailable";
    }

    try {
      const status = this.options.systemPreferences?.getMediaAccessStatus("screen");
      if (status === "granted" || status === "denied" || status === "restricted" || status === "not-determined") {
        return status;
      }
    } catch {
      // Treat unavailable system permission APIs as an unavailable capture service.
    }

    return "unavailable";
  }

  private getPlatform(): NodeJS.Platform {
    return this.platformDetector();
  }

  private async selectSource(
    onTimeout: (settled: Promise<void>) => void,
    timeoutError: ScreenshotServiceError,
    cancellation: Promise<never>,
  ): Promise<ScreenshotSource> {
    const point = this.options.screen.getCursorScreenPoint();
    const display = this.options.screen.getDisplayNearestPoint(point);
    const scaleFactor = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
    const thumbnailSize = {
      width: Math.max(1, Math.round(display.bounds.width * scaleFactor)),
      height: Math.max(1, Math.round(display.bounds.height * scaleFactor)),
    };
    const sources = await this.getSourcesWithTimeout(thumbnailSize, onTimeout, timeoutError, cancellation);
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    if (!source) {
      throw captureFailed();
    }
    return source;
  }

  private async getSourcesWithTimeout(
    thumbnailSize: ScreenshotSize,
    onTimeout: (settled: Promise<void>) => void,
    timeoutError: ScreenshotServiceError,
    cancellation: Promise<never>,
  ): Promise<readonly ScreenshotSource[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sourcePromise = Promise.resolve().then(() => this.options.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { ...thumbnailSize },
    }));
    const sourceSettled = sourcePromise.then(() => undefined, () => undefined);
    const timeoutPromise = new Promise<readonly ScreenshotSource[]>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout(sourceSettled);
        reject(timeoutError);
      }, this.sourceTimeoutMs);
    });

    try {
      return await Promise.race([sourcePromise, timeoutPromise, cancellation]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async persist(id: string, imageBytes: Uint8Array): Promise<void> {
    await this.fileSystem.mkdir(this.directory, { recursive: true });
    const temporaryPath = join(this.directory, `${id}.png.tmp`);
    const finalPath = join(this.directory, `${id}.png`);

    try {
      await this.fileSystem.writeFile(temporaryPath, imageBytes, { mode: 0o600 });
      await this.fileSystem.rename(temporaryPath, finalPath);
    } catch (error) {
      await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async evictOldest(): Promise<void> {
        while (this.items.length > MAX_CONTEXT_SCREENSHOTS) {
      const oldest = this.items.shift();
      if (!oldest) {
        return;
      }
      await this.fileSystem.unlink(join(this.directory, `${oldest.id}.png`)).catch(() => undefined);
    }
  }

  private async cleanupManagedFiles(): Promise<void> {
    let files: string[];
    try {
      files = await this.fileSystem.readdir(this.directory);
    } catch {
      return;
    }

    await Promise.all(files
      .filter((file) => MANAGED_FILE_PATTERN.test(file))
      .map((file) => this.fileSystem.unlink(join(this.directory, file)).catch(() => undefined)));
  }
}
