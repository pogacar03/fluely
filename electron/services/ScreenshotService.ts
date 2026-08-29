import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IpcError,
  ScreenshotItem,
  ScreenshotPermission,
  ScreenshotState,
} from "../../src/shared/ipc";

export interface ScreenshotSize {
  width: number;
  height: number;
}

export interface ScreenshotPoint {
  x: number;
  y: number;
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
  getDisplayNearestPoint(point: ScreenshotPoint): { id: number | string };
}

export interface SystemPreferencesAdapter {
  getMediaAccessStatus(type: "screen"): string;
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
  thumbnailSize?: ScreenshotSize;
  sourceTimeoutMs?: number;
  sourceEnumerationTimeoutMs?: number;
  idFactory?: () => string;
  now?: () => Date;
  clock?: () => Date;
}

export type ScreenshotServiceError = IpcError;

const MAX_ITEMS = 5;
const DEFAULT_SOURCE_TIMEOUT_MS = 5000;
const DEFAULT_THUMBNAIL_SIZE: ScreenshotSize = { width: 3840, height: 2160 };
const SERVICE_ERROR_CODES = new Set<IpcError["code"]>([
  "SCREEN_CAPTURE_DENIED",
  "SCREEN_CAPTURE_RESTRICTED",
  "SCREEN_CAPTURE_PERMISSION_REQUIRED",
  "SCREEN_CAPTURE_FAILED",
  "CAPTURE_IN_PROGRESS",
  "SCREENSHOT_NOT_FOUND",
]);

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
  private readonly thumbnailSize: ScreenshotSize;
  private readonly sourceTimeoutMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly items: ScreenshotItem[] = [];
  private capturing = false;
  private disposed = false;
  private permission: ScreenshotPermission = "unavailable";

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
    this.thumbnailSize = options.thumbnailSize ?? DEFAULT_THUMBNAIL_SIZE;
    this.sourceTimeoutMs = options.sourceTimeoutMs ?? options.sourceEnumerationTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? options.clock ?? (() => new Date());
  }

  public getState(): ScreenshotState {
    this.permission = this.readPermission();
    return {
      items: this.items.map((item) => ({ ...item })),
      capturing: this.capturing,
      permission: this.permission,
    };
  }

  public async capture(): Promise<ScreenshotItem> {
    if (this.capturing) {
      throw captureInProgress();
    }
    if (this.disposed) {
      throw captureFailed();
    }

    this.capturing = true;
    try {
      this.permission = this.readPermission();
      const permissionFailure = this.getPlatform() === "darwin" ? permissionError(this.permission) : null;
      if (permissionFailure) {
        throw permissionFailure;
      }

      const source = await this.selectSource();
      const imageBytes = source.thumbnail.toPNG();
      const size = source.thumbnail.getSize();
      const item: ScreenshotItem = {
        id: this.idFactory(),
        createdAt: this.now().toISOString(),
        width: size.width,
        height: size.height,
      };

      await this.persist(item.id, imageBytes);
      this.items.push(item);
      await this.evictOldest();
      return { ...item };
    } catch (error) {
      if (isServiceError(error)) {
        throw error;
      }
      throw captureFailed();
    } finally {
      this.capturing = false;
    }
  }

  public async delete(id: string): Promise<ScreenshotState> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) {
      throw screenshotNotFound();
    }

    const [item] = this.items.splice(index, 1);
    await unlink(join(this.directory, `${item.id}.png`)).catch(() => undefined);
    return this.getState();
  }

  public async clear(): Promise<ScreenshotState> {
    const items = this.items.splice(0);
    await Promise.all(items.map((item) => unlink(join(this.directory, `${item.id}.png`)).catch(() => undefined)));
    return this.getState();
  }

  public dispose(): void {
    this.disposed = true;
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

  private async selectSource(): Promise<ScreenshotSource> {
    const point = this.options.screen.getCursorScreenPoint();
    const display = this.options.screen.getDisplayNearestPoint(point);
    const sources = await this.getSourcesWithTimeout();
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    if (!source) {
      throw captureFailed();
    }
    return source;
  }

  private async getSourcesWithTimeout(): Promise<readonly ScreenshotSource[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sourcePromise = Promise.resolve().then(() => this.options.desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { ...this.thumbnailSize },
    }));
    const timeoutPromise = new Promise<readonly ScreenshotSource[]>((_, reject) => {
      timer = setTimeout(() => reject(captureFailed()), this.sourceTimeoutMs);
    });

    try {
      return await Promise.race([sourcePromise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async persist(id: string, imageBytes: Uint8Array): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporaryPath = join(this.directory, `${id}.png.tmp`);
    const finalPath = join(this.directory, `${id}.png`);

    try {
      await writeFile(temporaryPath, imageBytes, { mode: 0o600 });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async evictOldest(): Promise<void> {
    while (this.items.length > MAX_ITEMS) {
      const oldest = this.items.shift();
      if (!oldest) {
        return;
      }
      await unlink(join(this.directory, `${oldest.id}.png`)).catch(() => undefined);
    }
  }
}
