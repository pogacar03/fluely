import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { ContextScreenshot } from "../../src/shared/context-queue";
import type { ConversationAttachment } from "../../src/shared/conversation";
import { readSecureMediaFile } from "./secure-media-file";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_DIRECTORY_NAME = "session-attachments";

const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type AttachmentStoreErrorCode =
  | "ATTACHMENT_TOO_LARGE"
  | "INVALID_ATTACHMENT"
  | "ATTACHMENT_NOT_FOUND"
  | "ATTACHMENT_CLEANUP_FAILED"
  | "ATTACHMENT_STORE_INVALID_ROOT"
  | "ATTACHMENT_STORE_DISPOSED";

export interface AttachmentStoreError extends Error {
  code: AttachmentStoreErrorCode;
  cause?: unknown;
}

export interface AttachmentStoreOptions {
  rootDirectory?: string;
  sessionDataPath?: string;
  userDataPath?: string;
  sessionId?: string;
  idFactory?: () => string;
  now?: () => number | Date;
  clock?: () => number | Date;
  maxAttachmentBytes?: number;
  unlinkFile?: (path: string) => Promise<void>;
}

export interface AttachmentFileMetadata {
  width: number;
  height: number;
  mimeType?: "image/png";
}

function createError(code: AttachmentStoreErrorCode, message: string): AttachmentStoreError {
  const error = new Error(message) as AttachmentStoreError;
  error.name = "AttachmentStoreError";
  error.code = code;
  return error;
}

function withCause(error: AttachmentStoreError, cause: unknown): AttachmentStoreError {
  error.cause = cause;
  return error;
}

function timestamp(value: number | Date | undefined): number {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : Date.now();
  }
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function cloneMetadata(metadata: ConversationAttachment): ConversationAttachment {
  return { ...metadata };
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.byteLength && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

/**
 * Main-process-only registry and byte store for immutable sent screenshots.
 * The public metadata never contains the backing path; getPath is intentionally
 * a narrow internal seam for the main-process media protocol.
 */
export class AttachmentStore {
  public readonly rootDirectory: string;
  public readonly sessionId: string;
  public readonly directory: string;

  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly unlinkFile: (path: string) => Promise<void>;
  private readonly attachments = new Map<string, ConversationAttachment>();
  private readonly initialization: Promise<void>;
  private disposed = false;

  public constructor(options: AttachmentStoreOptions) {
    const rootDirectory = options.rootDirectory ??
      (options.sessionDataPath ? join(options.sessionDataPath, ATTACHMENT_DIRECTORY_NAME) :
        options.userDataPath ? join(options.userDataPath, ATTACHMENT_DIRECTORY_NAME) : "");
    if (!rootDirectory) {
      throw new Error("AttachmentStore requires a session attachment root directory.");
    }
    const sessionId = options.sessionId ?? randomUUID();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("AttachmentStore requires a safe session ID.");
    }

    this.rootDirectory = rootDirectory;
    this.sessionId = sessionId;
    this.directory = join(rootDirectory, sessionId);
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = () => timestamp((options.now ?? options.clock)?.());
    this.maxBytes = Math.max(1, Math.floor(options.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES));
    this.unlinkFile = options.unlinkFile ?? unlink;
    this.initialization = this.initialize();
  }

  public async whenReady(): Promise<void> {
    await this.initialization;
  }

  public getPath(id: string): string | undefined {
    if (this.disposed || !isAttachmentId(id) || !this.attachments.has(id)) {
      return undefined;
    }
    return join(this.directory, `${id}.png`);
  }

  public getManagedPath(id: string): string | undefined {
    return this.getPath(id);
  }

  public getMetadata(id: string): ConversationAttachment | undefined {
    const metadata = isAttachmentId(id) ? this.attachments.get(id) : undefined;
    return metadata ? cloneMetadata(metadata) : undefined;
  }

  public list(): ConversationAttachment[] {
    return [...this.attachments.values()].map(cloneMetadata);
  }

  public totalBytes(): number {
    return [...this.attachments.values()].reduce((total, attachment) => total + attachment.byteLength, 0);
  }

  public async addFromFile(
    sourcePath: string,
    metadata: AttachmentFileMetadata,
  ): Promise<ConversationAttachment> {
    await this.whenReady();
    this.ensureUsable();
    if (typeof sourcePath !== "string" || sourcePath.length === 0 ||
      !Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) ||
      metadata.width <= 0 || metadata.height <= 0 ||
      (metadata.mimeType !== undefined && metadata.mimeType !== "image/png")) {
      throw createError("INVALID_ATTACHMENT", "Attachment metadata is invalid.");
    }

    const sourceStats = await stat(sourcePath).catch((error) => {
      throw withCause(createError("INVALID_ATTACHMENT", "The source screenshot could not be read."), error);
    });
    if (sourceStats.size > this.maxBytes) {
      throw createError("ATTACHMENT_TOO_LARGE", "A screenshot attachment exceeds the 20 MiB limit.");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(sourcePath));
    } catch (error) {
      throw withCause(createError("INVALID_ATTACHMENT", "The source screenshot could not be read."), error);
    }
    if (bytes.byteLength > this.maxBytes) {
      throw createError("ATTACHMENT_TOO_LARGE", "A screenshot attachment exceeds the 20 MiB limit.");
    }
    if (!isPng(bytes)) {
      throw createError("INVALID_ATTACHMENT", "Conversation attachments must be PNG screenshots.");
    }

    const id = this.idFactory();
    if (!isAttachmentId(id) || this.attachments.has(id)) {
      throw createError("INVALID_ATTACHMENT", "The attachment ID generator returned a duplicate or malformed ID.");
    }
    const attachment: ConversationAttachment = {
      id,
      mimeType: "image/png",
      width: Math.round(metadata.width),
      height: Math.round(metadata.height),
      byteLength: bytes.byteLength,
      createdAt: this.now(),
    };
    const temporaryPath = join(this.directory, `${id}.png.tmp`);
    const finalPath = join(this.directory, `${id}.png`);
    try {
      await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, finalPath);
      await chmod(finalPath, 0o600);
    } catch (error) {
      let cleanupError: unknown;
      for (const path of [temporaryPath, finalPath]) {
        try {
          await this.unlinkFile(path);
        } catch (candidate) {
          if ((candidate as NodeJS.ErrnoException).code !== "ENOENT" && cleanupError === undefined) {
            cleanupError = candidate;
          }
        }
      }
      if (cleanupError !== undefined) {
        throw withCause(
          createError("ATTACHMENT_CLEANUP_FAILED", "The failed attachment could not be rolled back."),
          cleanupError,
        );
      }
      throw withCause(createError("INVALID_ATTACHMENT", "The attachment could not be stored."), error);
    }

    try {
      const finalStats = await lstat(finalPath);
      this.assertPrivateFile(finalStats);
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.unlinkFile(finalPath);
      } catch (candidate) {
        if ((candidate as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupError = candidate;
        }
      }
      if (cleanupError !== undefined) {
        throw withCause(
          createError("ATTACHMENT_CLEANUP_FAILED", "The failed attachment could not be rolled back."),
          cleanupError,
        );
      }
      throw withCause(createError("INVALID_ATTACHMENT", "The attachment could not be stored."), error);
    }

    this.attachments.set(id, attachment);
    return cloneMetadata(attachment);
  }

  public addFromScreenshot(
    screenshot: Pick<ContextScreenshot, "width" | "height">,
    sourcePath: string,
  ): Promise<ConversationAttachment> {
    return this.addFromFile(sourcePath, {
      width: screenshot.width,
      height: screenshot.height,
      mimeType: "image/png",
    });
  }

  public copyFromScreenshot(
    screenshot: Pick<ContextScreenshot, "width" | "height">,
    sourcePath: string,
  ): Promise<ConversationAttachment> {
    return this.addFromScreenshot(screenshot, sourcePath);
  }

  public async read(id: string): Promise<Uint8Array | undefined> {
    await this.whenReady();
    const managedPath = this.getPath(id);
    if (!managedPath) {
      return undefined;
    }
    try {
      return await readSecureMediaFile(managedPath);
    } catch {
      return undefined;
    }
  }

  public async deleteUnreferenced(
    candidateIds: readonly string[],
    referencedIds: ReadonlySet<string> | readonly string[] = new Set(),
  ): Promise<string[]> {
    await this.whenReady();
    const referenced = referencedIds instanceof Set ? referencedIds : new Set(referencedIds);
    const removed: string[] = [];
    for (const id of candidateIds) {
      if (!isAttachmentId(id) || referenced.has(id) || !this.attachments.has(id)) {
        continue;
      }
      await this.removeRegistered(id);
      removed.push(id);
    }
    return removed;
  }

  public async delete(id: string): Promise<boolean> {
    return (await this.deleteUnreferenced([id])).length > 0;
  }

  public async clear(): Promise<void> {
    await this.whenReady();
    for (const id of [...this.attachments.keys()]) {
      await this.removeRegistered(id);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.whenReady();
    try {
      await rm(this.directory, { recursive: true, force: true });
    } catch (error) {
      throw withCause(createError("ATTACHMENT_CLEANUP_FAILED", "The session attachments could not be cleaned up."), error);
    }
    this.disposed = true;
    this.attachments.clear();
  }

  private async initialize(): Promise<void> {
    await this.ensurePrivateDirectory(this.rootDirectory, true);
    await this.ensureExistingPrivateDirectory(this.directory);
    let entries: Array<{ name: string }>;
    try {
      entries = await readdir(this.rootDirectory, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      throw withCause(createError("ATTACHMENT_STORE_INVALID_ROOT", "The attachment storage root could not be read."), error);
    }
    for (const entry of entries) {
      const entryPath = join(this.rootDirectory, entry.name);
      let entryStats;
      try {
        entryStats = await lstat(entryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw withCause(createError("ATTACHMENT_CLEANUP_FAILED", "A stale attachment session could not be inspected."), error);
      }
      try {
        if (entryStats.isSymbolicLink()) {
          await unlink(entryPath);
        } else if (entryStats.isDirectory()) {
          await rm(entryPath, { recursive: entryStats.isDirectory(), force: true });
        }
      } catch (error) {
        throw withCause(createError("ATTACHMENT_CLEANUP_FAILED", "A stale attachment session could not be cleaned up."), error);
      }
    }
    await this.ensurePrivateDirectory(this.directory, false);
  }

  private async ensureExistingPrivateDirectory(directory: string): Promise<void> {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw withCause(createError("ATTACHMENT_STORE_INVALID_ROOT", "The session attachment directory could not be inspected."), error);
    }
    this.assertPrivateDirectory(stats);
  }

  private async ensurePrivateDirectory(directory: string, recursive: boolean): Promise<void> {
    let stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw withCause(createError("ATTACHMENT_STORE_INVALID_ROOT", "The attachment storage root could not be inspected."), error);
      }
      try {
        await mkdir(directory, { recursive, mode: 0o700 });
        stats = await lstat(directory);
      } catch (creationError) {
        throw withCause(createError("ATTACHMENT_STORE_INVALID_ROOT", "The attachment storage root could not be created."), creationError);
      }
    }

    this.assertPrivateDirectory(stats);
    try {
      await chmod(directory, 0o700);
      const verified = await lstat(directory);
      this.assertPrivateDirectory(verified);
    } catch (error) {
      if ((error as AttachmentStoreError).code === "ATTACHMENT_STORE_INVALID_ROOT") {
        throw error;
      }
      throw withCause(createError("ATTACHMENT_STORE_INVALID_ROOT", "The attachment storage root could not be secured."), error);
    }
  }

  private assertPrivateDirectory(stats: { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }): void {
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw createError("ATTACHMENT_STORE_INVALID_ROOT", "The attachment storage root must be a private directory.");
    }
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (owner !== undefined && stats.uid !== owner) {
      throw createError("ATTACHMENT_STORE_INVALID_ROOT", "The attachment storage root has an unexpected owner.");
    }
  }

  private assertPrivateFile(stats: { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }): void {
    if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      throw createError("INVALID_ATTACHMENT", "The stored attachment is not a private file.");
    }
    const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (owner !== undefined && stats.uid !== owner) {
      throw createError("INVALID_ATTACHMENT", "The stored attachment has an unexpected owner.");
    }
  }

  private ensureUsable(): void {
    if (this.disposed) {
      throw createError("ATTACHMENT_STORE_DISPOSED", "The session attachment store is disposed.");
    }
  }

  private async removeRegistered(id: string): Promise<void> {
    const managedPath = this.getPath(id);
    if (!managedPath) {
      return;
    }
    try {
      for (const path of [managedPath, `${managedPath}.tmp`]) {
        try {
          await this.unlinkFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      }
    } catch (error) {
      throw withCause(createError("ATTACHMENT_CLEANUP_FAILED", "The session attachment could not be removed."), error);
    }
    this.attachments.delete(id);
  }
}

export function isAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_ID_PATTERN.test(value);
}
