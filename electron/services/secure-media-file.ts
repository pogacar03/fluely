import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, parse, relative, resolve, sep } from "node:path";

export const MAX_SECURE_MEDIA_BYTES = 20 * 1024 * 1024;

const SECURE_FILE_MODE = 0o600;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const READ_WRITE_FLAGS = constants.O_WRONLY | constants.O_RDWR;

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

export type SecureMediaReader = (filePath: string, managedRoot?: string) => Promise<Uint8Array>;

export interface SecureMediaReaderOptions {
  openFile?: SecureMediaOpenFile;
  maxBytes?: number;
  getUid?: () => number | undefined;
  noFollowFlag?: number | null;
  rootDirectory?: string;
}

function secureMediaError(): Error {
  return new Error("The media file is not available.");
}

function isSafeIdentity(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertSafeStats(
  stats: FileStats,
  expected: FileStats | undefined,
  maxBytes: number,
  ownerUid: number,
): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== ownerUid ||
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

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

async function inspectDirectoryChain(
  filePath: string,
  managedRoot: string | undefined,
  ownerUid: number,
): Promise<DirectoryIdentity[]> {
  const resolvedFilePath = resolve(filePath);
  const directoryPath = dirname(resolvedFilePath);
  const resolvedRoot = resolve(managedRoot ?? parse(resolvedFilePath).root);
  const relativeDirectory = relative(resolvedRoot, directoryPath);
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || relativeDirectory.startsWith(sep)) {
    throw secureMediaError();
  }

  const directories = [
    resolvedRoot,
    ...(relativeDirectory ? relativeDirectory.split(sep).map((part) => resolve(resolvedRoot, part)) : []),
  ];
  const identities: DirectoryIdentity[] = [];
  for (const directory of directories) {
    const stats = await lstat(directory);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      !isSafeIdentity(stats.dev) ||
      !isSafeIdentity(stats.ino) ||
      (managedRoot !== undefined && stats.uid !== ownerUid)
    ) {
      throw secureMediaError();
    }
    identities.push({ path: directory, dev: stats.dev, ino: stats.ino });
  }
  return identities;
}

function assertSameDirectoryChain(expected: DirectoryIdentity[], actual: DirectoryIdentity[]): void {
  if (
    expected.length !== actual.length ||
    expected.some((directory, index) => {
      const candidate = actual[index];
      return directory.path !== candidate.path || directory.dev !== candidate.dev || directory.ino !== candidate.ino;
    })
  ) {
    throw secureMediaError();
  }
}

function resolveOwnerUid(getUid: (() => number | undefined) | undefined): number | undefined {
  try {
    return getUid ? getUid() : process.getuid?.();
  } catch {
    return undefined;
  }
}

function resolveOpenFlags(noFollowFlag: number | null | undefined): number | undefined {
  const resolvedNoFollowFlag = noFollowFlag === undefined ? constants.O_NOFOLLOW : noFollowFlag;
  if (
    typeof resolvedNoFollowFlag !== "number" ||
    !Number.isSafeInteger(resolvedNoFollowFlag) ||
    resolvedNoFollowFlag <= 0
  ) {
    return undefined;
  }
  const flags = constants.O_RDONLY | resolvedNoFollowFlag;
  return (flags & READ_WRITE_FLAGS) === constants.O_RDONLY ? flags : undefined;
}

function defaultOpenFile(filePath: string, flags: number): Promise<FileHandle> {
  return open(filePath, flags);
}

/**
 * Reads one managed media file from an opened descriptor. The path is checked
 * before open, the descriptor is checked after open, and the final fstat must
 * still describe the same inode and size before the bytes are returned.
 */
export function createSecureMediaReader(options: SecureMediaReaderOptions = {}): SecureMediaReader {
  const openFile = options.openFile ?? defaultOpenFile;
  const configuredMaxBytes = options.maxBytes ?? MAX_SECURE_MEDIA_BYTES;
  const maxBytes = Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : MAX_SECURE_MEDIA_BYTES;

  return async (filePath: string, managedRootOverride?: string): Promise<Uint8Array> => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw secureMediaError();
    }
    const ownerUid = resolveOwnerUid(options.getUid);
    const openFlags = resolveOpenFlags(options.noFollowFlag);
    if (!isSafeIdentity(ownerUid) || openFlags === undefined) {
      throw secureMediaError();
    }
    const managedRoot = managedRootOverride ?? options.rootDirectory;

    let expected: FileStats;
    let expectedDirectories: DirectoryIdentity[];
    try {
      expectedDirectories = await inspectDirectoryChain(filePath, managedRoot, ownerUid);
      expected = await lstat(filePath);
      assertSafeStats(expected, undefined, maxBytes, ownerUid);
    } catch {
      throw secureMediaError();
    }

    let handle: SecureMediaFileHandle | null = null;
    try {
      handle = await openFile(filePath, openFlags);
      const opened = await handle.stat();
      assertSafeStats(opened, expected, maxBytes, ownerUid);
      assertSameDirectoryChain(expectedDirectories, await inspectDirectoryChain(filePath, managedRoot, ownerUid));
      const bytes = new Uint8Array(await handle.readFile());
      const final = await handle.stat();
      assertSafeStats(final, opened, maxBytes, ownerUid);
      assertSameDirectoryChain(expectedDirectories, await inspectDirectoryChain(filePath, managedRoot, ownerUid));
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
