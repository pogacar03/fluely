import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export const MAX_SECURE_MEDIA_BYTES = 20 * 1024 * 1024;

const SECURE_FILE_MODE = 0o600;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

type FileStats = Pick<Stats, "size" | "mode" | "uid" | "dev" | "ino"> & {
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

export interface SecureMediaFileHandle {
  stat(): Promise<FileStats>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type SecureMediaOpenFile = (filePath: string, flags: number) => Promise<SecureMediaFileHandle>;

export interface SecureMediaReaderOptions {
  openFile?: SecureMediaOpenFile;
  maxBytes?: number;
}

function secureMediaError(): Error {
  return new Error("The media file is not available.");
}

function isSafeIdentity(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertSafeStats(stats: FileStats, expected?: FileStats, maxBytes = MAX_SECURE_MEDIA_BYTES): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== (typeof process.getuid === "function" ? process.getuid() : stats.uid) ||
    (stats.mode & 0o777) !== SECURE_FILE_MODE ||
    !isSafeIdentity(stats.dev) ||
    !isSafeIdentity(stats.ino) ||
    !Number.isSafeInteger(stats.size) ||
    stats.size < 0 ||
    stats.size > maxBytes
  ) {
    throw secureMediaError();
  }

  if (expected && (stats.dev !== expected.dev || stats.ino !== expected.ino)) {
    throw secureMediaError();
  }
}

function defaultOpenFile(filePath: string, flags: number): Promise<FileHandle> {
  return open(filePath, flags);
}

/**
 * Reads one managed media file from an opened descriptor. The path is checked
 * before open, the descriptor is checked after open, and the final fstat must
 * still describe the same inode and size before the bytes are returned.
 */
export function createSecureMediaReader(options: SecureMediaReaderOptions = {}): (filePath: string) => Promise<Uint8Array> {
  const openFile = options.openFile ?? defaultOpenFile;
  const configuredMaxBytes = options.maxBytes ?? MAX_SECURE_MEDIA_BYTES;
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : MAX_SECURE_MEDIA_BYTES;

  return async (filePath: string): Promise<Uint8Array> => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw secureMediaError();
    }

    let expected: FileStats;
    try {
      expected = await lstat(filePath);
      assertSafeStats(expected, undefined, maxBytes);
    } catch {
      throw secureMediaError();
    }

    let handle: SecureMediaFileHandle | null = null;
    try {
      handle = await openFile(filePath, OPEN_FLAGS);
      const opened = await handle.stat();
      assertSafeStats(opened, expected, maxBytes);
      const bytes = new Uint8Array(await handle.readFile());
      const final = await handle.stat();
      assertSafeStats(final, opened, maxBytes);
      if (final.size !== opened.size || bytes.byteLength !== final.size || bytes.byteLength > maxBytes) {
        throw secureMediaError();
      }
      await handle.close();
      handle = null;
      return bytes;
    } catch {
      throw secureMediaError();
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The caller receives the same generic media failure either way.
        }
      }
    }
  };
}

export const readSecureMediaFile = createSecureMediaReader();

export { OPEN_FLAGS, SECURE_FILE_MODE };
