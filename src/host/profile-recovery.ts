import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_PROFILE_ID,
  browserProfileIdSchema,
  browserProfileManifestSchema,
  PROFILE_MANIFEST_VERSION,
  type BrowserProfileManifest,
} from "../shared/contracts.js";
import {
  createProfileStorageOwnershipBoundary,
  createFileBrowserProfileStore,
  profileStoragePaths,
  type ProfileStorageOwnershipBoundary,
} from "./profile-storage.js";

const PROFILE_ARCHIVE_MAGIC = "BB_BROWSER_PROFILE_BACKUP/1";
const PROFILE_ARCHIVE_VERSION = 1;
const ARCHIVE_FILE_MODE = 0o600;
const PROFILE_DIRECTORY_MODE = 0o700;
const COPY_BUFFER_BYTES = 64 * 1024;
const MINIMUM_RECOVERY_FREE_BYTES = 5 * 1024 ** 3;

const archiveHeaderSchema = z
  .object({
    format: z.literal(PROFILE_ARCHIVE_MAGIC),
    version: z.literal(PROFILE_ARCHIVE_VERSION),
    installationId: z.string().min(1),
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    manifest: browserProfileManifestSchema,
    encryptionState: z.enum(["plain", "encrypted", "unknown"]),
    entryCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

const archiveEntrySchema = z
  .object({
    kind: z.enum(["directory", "file"]),
    path: z.string().min(1).max(4096),
    mode: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();

type ArchiveHeader = z.infer<typeof archiveHeaderSchema>;
type ArchiveEntry = z.infer<typeof archiveEntrySchema>;
const recoveryJournalSchema = z
  .object({
    profileDirectory: z.string().min(1).max(4096),
    stagingDirectory: z.string().min(1).max(4096),
    rollbackDirectory: z.string().min(1).max(4096),
    phase: z.enum(["prepared", "old-profile-moved", "new-profile-moved"]),
  })
  .strict();
type RecoveryJournal = z.infer<typeof recoveryJournalSchema>;
const recoveryQueues = new Map<string, Promise<void>>();
export type BrowserProfileRecoveryTarget = {
  hostId: string;
  profileId: string;
};
export type BrowserProfileImportInput = {
  hostId: string;
  name: string;
  sourcePath: string;
};

export interface BrowserProfileRecoveryState {
  isProfileStopped(
    hostId: string,
    profileId: string,
  ): boolean | Promise<boolean>;
  isDevBrowserProfileStopped(sourcePath: string): boolean | Promise<boolean>;
}

export interface ProfileRecoveryDiskBoundary {
  freeBytes(path: string): number | Promise<number>;
}

export interface ProfileRecoveryCopyBoundary {
  copyFile(sourcePath: string, targetPath: string): void | Promise<void>;
}

export type ProfileRecoveryPhase =
  "validating" | "copying" | "promoting" | "completed";

export interface ProfileRecoveryProgress {
  phase: ProfileRecoveryPhase;
  completedBytes: number;
  totalBytes: number;
  phases?: ProfileRecoveryPhase[];
}

export interface BrowserProfileBackupResult {
  outcome: "backed-up";
  message: string;
  archivePath: string;
  credentialEquivalent: true;
  progress: ProfileRecoveryProgress;
}

export interface BrowserProfileRestoreResult {
  outcome: "restored";
  message: string;
  archivePath: string;
  credentialEquivalent: true;
  progress: ProfileRecoveryProgress;
}

export interface BrowserProfileImportResult {
  outcome: "imported";
  message: string;
  profileId: string;
  progress: ProfileRecoveryProgress;
}

export type BrowserProfileRecoveryResult =
  | BrowserProfileBackupResult
  | BrowserProfileRestoreResult
  | BrowserProfileImportResult;

export interface BrowserProfileRecovery {
  backupProfile(
    input: BrowserProfileRecoveryTarget & { archivePath: string },
  ): Promise<BrowserProfileBackupResult>;
  restoreProfile(
    input: BrowserProfileRecoveryTarget & { archivePath: string },
  ): Promise<BrowserProfileRestoreResult>;
  importDevBrowserProfile(
    input: BrowserProfileImportInput,
  ): Promise<BrowserProfileImportResult>;
}

export interface FileBrowserProfileRecoveryOptions {
  rootDirectory: string;
  installationId: string;
  state: BrowserProfileRecoveryState;
  ownership?: ProfileStorageOwnershipBoundary;
  idFactory?: () => string;
  clock?: () => Date;
  disk?: ProfileRecoveryDiskBoundary;
  copy?: ProfileRecoveryCopyBoundary;
}

export type BrowserProfileRecoveryErrorCode =
  | "profile-running"
  | "profile-not-found"
  | "recovery-archive-invalid"
  | "recovery-incompatible-installation"
  | "recovery-incompatible-version"
  | "recovery-incompatible-encryption"
  | "recovery-ownership-invalid"
  | "recovery-insufficient-disk"
  | "recovery-copy-failed"
  | "recovery-rollback-failed";

export class BrowserProfileRecoveryError extends Error {
  constructor(
    readonly code: BrowserProfileRecoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserProfileRecoveryError";
  }
}

type ArchiveFile = ArchiveEntry & { absolutePath: string };

const filesystemDiskBoundary: ProfileRecoveryDiskBoundary = {
  async freeBytes(path) {
    const filesystemStats = await statfs(path);
    return filesystemStats.bavail * filesystemStats.bsize;
  },
};

const filesystemCopyBoundary: ProfileRecoveryCopyBoundary = {
  async copyFile(sourcePath, targetPath) {
    const sourceMetadata = await lstat(sourcePath);
    const targetFile = await open(targetPath, "wx", ARCHIVE_FILE_MODE);
    try {
      await copyFileContents(sourcePath, targetFile, sourceMetadata.size);
    } finally {
      await targetFile.close();
    }
  },
};

function archiveLine(value: unknown) {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function profileArchivePath(
  rootDirectory: string,
  installationId: string,
  target: BrowserProfileRecoveryTarget,
) {
  return profileStoragePaths({
    rootDirectory,
    installationId,
    hostId: target.hostId,
    profileId: target.profileId,
  });
}

function recoveryError(
  code: BrowserProfileRecoveryErrorCode,
  message: string,
  cause?: unknown,
) {
  if (cause instanceof BrowserProfileRecoveryError) return cause;
  return new BrowserProfileRecoveryError(code, message);
}

async function withRecoveryFailure<T>(
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw recoveryError("recovery-copy-failed", message, error);
  }
}

function isMissingPath(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function verifyRecoveryOwnership(
  ownership: ProfileStorageOwnershipBoundary,
  path: string,
  mode: number,
  missingCode: BrowserProfileRecoveryErrorCode,
  missingMessage: string,
  invalidMessage: string,
) {
  try {
    await ownership.verifyOwned(path, mode);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new BrowserProfileRecoveryError(missingCode, missingMessage);
    }
    throw recoveryError("recovery-ownership-invalid", invalidMessage, error);
  }
}

async function ensureRecoveryDirectory(
  path: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await mkdir(path, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup contains an invalid directory.",
    );
  }
  await chmod(path, PROFILE_DIRECTORY_MODE);
  await ownership.ensureOwned(path, PROFILE_DIRECTORY_MODE);
}

function safeArchiveRelativePath(path: string) {
  return (
    path !== "." &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === ".." || segment === "")
  );
}

function pathIsWithin(path: string, parentDirectory: string) {
  const child = relative(resolve(parentDirectory), resolve(path));
  return child === "" || (!child.startsWith("..") && !child.startsWith("/"));
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}

async function removeCreatedRecoveryLock(
  lockPath: string,
  createdLockMetadata: Awaited<ReturnType<typeof lstat>>,
) {
  let currentLockMetadata;
  try {
    currentLockMetadata = await lstat(lockPath);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  if (
    currentLockMetadata.dev !== createdLockMetadata.dev ||
    currentLockMetadata.ino !== createdLockMetadata.ino
  ) {
    return;
  }
  await rm(lockPath, { force: true });
}

async function acquireRecoveryLock(
  lockPath: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let createdLockMetadata: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      const lockFile = await open(lockPath, "wx", ARCHIVE_FILE_MODE);
      createdLockMetadata = await lockFile.stat();
      try {
        await lockFile.writeFile(`${process.pid}\n`, "utf8");
        await lockFile.sync();
      } finally {
        await lockFile.close();
      }
      await chmod(lockPath, ARCHIVE_FILE_MODE);
      await ownership.ensureOwned(lockPath, ARCHIVE_FILE_MODE);
      return;
    } catch (error) {
      if (createdLockMetadata !== undefined) {
        await Promise.allSettled([
          removeCreatedRecoveryLock(lockPath, createdLockMetadata),
        ]);
      }
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code !== "EEXIST") throw error;
      if (await removeStaleRecoveryLock(lockPath)) continue;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new BrowserProfileRecoveryError(
    "recovery-copy-failed",
    "Timed out waiting for another Browser Profile recovery operation.",
  );
}

async function removeStaleRecoveryLock(lockPath: string) {
  let lockContents: string;
  try {
    lockContents = await readFile(lockPath, "utf8");
  } catch (error) {
    if (isMissingPath(error)) return true;
    throw error;
  }
  const ownerPid = Number(lockContents.trim());
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    if (error.code !== "ESRCH") return false;
    await rm(lockPath, { force: true });
    return true;
  }
}

async function withRecoveryLock<T>(
  hostStoragePath: string,
  ownership: ProfileStorageOwnershipBoundary,
  operation: () => Promise<T>,
) {
  const key = hostStoragePath;
  const previous = recoveryQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  recoveryQueues.set(key, current);
  await previous;
  const lockPath = join(hostStoragePath, ".recovery.lock");
  let lockAcquired = false;
  try {
    await ensureRecoveryDirectory(hostStoragePath, ownership);
    await acquireRecoveryLock(lockPath, ownership);
    lockAcquired = true;
    return await operation();
  } finally {
    try {
      if (lockAcquired) await rm(lockPath, { force: true });
    } finally {
      release();
      if (recoveryQueues.get(key) === current) recoveryQueues.delete(key);
    }
  }
}

async function writeRecoveryJournal(
  journalPath: string,
  journal: RecoveryJournal,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const temporaryPath = `${journalPath}.${randomUUID()}.tmp`;
  const journalFile = await open(temporaryPath, "wx", ARCHIVE_FILE_MODE);
  let closed = false;
  let promoted = false;
  try {
    await journalFile.writeFile(JSON.stringify(journal), "utf8");
    await journalFile.sync();
    await journalFile.close();
    closed = true;
    await chmod(temporaryPath, ARCHIVE_FILE_MODE);
    await ownership.ensureOwned(temporaryPath, ARCHIVE_FILE_MODE);
    await rename(temporaryPath, journalPath);
    promoted = true;
  } finally {
    if (!closed) await journalFile.close().catch(() => undefined);
    if (!promoted) await rm(temporaryPath, { force: true });
  }
}

async function recoverPromotionJournal(
  journalPath: string,
  journal: RecoveryJournal,
) {
  const journalDirectory = dirname(journalPath);
  if (
    !pathIsWithin(journal.profileDirectory, journalDirectory) ||
    !pathIsWithin(journal.stagingDirectory, journalDirectory) ||
    !pathIsWithin(journal.rollbackDirectory, journalDirectory)
  ) {
    throw new BrowserProfileRecoveryError(
      "recovery-rollback-failed",
      "Browser Profile recovery journal contains an unsafe path.",
    );
  }
  const profileExists = await pathExists(journal.profileDirectory);
  const rollbackExists = await pathExists(journal.rollbackDirectory);
  if (rollbackExists && profileExists) {
    if (journal.phase === "new-profile-moved") {
      await rm(journal.rollbackDirectory, { recursive: true, force: true });
    } else {
      await rm(journal.profileDirectory, { recursive: true, force: true });
      await rename(journal.rollbackDirectory, journal.profileDirectory);
    }
  } else if (rollbackExists) {
    await rename(journal.rollbackDirectory, journal.profileDirectory);
  } else if (!profileExists) {
    throw new BrowserProfileRecoveryError(
      "recovery-rollback-failed",
      "Browser Profile recovery cannot find the prior profile to restore.",
    );
  }
  await rm(journal.stagingDirectory, { recursive: true, force: true });
  await rm(journalPath, { force: true });
}

async function readRecoveryJournal(
  journalPath: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await verifyRecoveryOwnership(
    ownership,
    journalPath,
    ARCHIVE_FILE_MODE,
    "recovery-archive-invalid",
    "Browser Profile recovery journal is not available.",
    "Browser Profile recovery journal ownership or permissions are invalid.",
  );
  let serializedJournal: string;
  try {
    serializedJournal = await readFile(journalPath, "utf8");
  } catch (error) {
    throw recoveryError(
      "recovery-archive-invalid",
      "Browser Profile recovery journal is not available.",
      error,
    );
  }
  try {
    return recoveryJournalSchema.parse(JSON.parse(serializedJournal));
  } catch {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "Browser Profile recovery journal is invalid.",
    );
  }
}

function archiveEntryMode(kind: ArchiveEntry["kind"]) {
  return kind === "directory" ? PROFILE_DIRECTORY_MODE : ARCHIVE_FILE_MODE;
}

function requireKnownEncryptionState(
  encryptionState: Awaited<ReturnType<typeof readEncryptionState>>,
) {
  if (encryptionState === "unknown") {
    throw new BrowserProfileRecoveryError(
      "recovery-incompatible-encryption",
      "Browser Profile encryption state could not be verified safely.",
    );
  }
  return encryptionState;
}

async function readEncryptionState(browserDataPath: string) {
  const localStatePath = join(browserDataPath, "Local State");
  let localStateContents: string;
  try {
    const localStateFile = await open(localStatePath, "r");
    try {
      localStateContents = await localStateFile.readFile("utf8");
    } finally {
      await localStateFile.close();
    }
  } catch (error) {
    if (isMissingPath(error)) return "plain" as const;
    return "unknown" as const;
  }
  try {
    const localState = JSON.parse(localStateContents) as {
      os_crypt?: { encrypted_key?: unknown; app_bound_encrypted_key?: unknown };
    };
    const encrypted =
      typeof localState.os_crypt?.encrypted_key === "string" ||
      typeof localState.os_crypt?.app_bound_encrypted_key === "string";
    return encrypted ? ("encrypted" as const) : ("plain" as const);
  } catch {
    return "unknown" as const;
  }
}

async function readProfileManifest(
  paths: ReturnType<typeof profileArchivePath>,
  target: BrowserProfileRecoveryTarget,
  installationId: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await verifyRecoveryOwnership(
    ownership,
    paths.profileDirectory,
    PROFILE_DIRECTORY_MODE,
    "profile-not-found",
    "The target Browser Profile is not available.",
    "Browser Profile ownership or permissions are invalid.",
  );
  await verifyRecoveryOwnership(
    ownership,
    paths.browserDataPath,
    PROFILE_DIRECTORY_MODE,
    "profile-not-found",
    "The target Browser Profile is not available.",
    "Browser Profile ownership or permissions are invalid.",
  );
  await verifyRecoveryOwnership(
    ownership,
    paths.manifestPath,
    ARCHIVE_FILE_MODE,
    "profile-not-found",
    "The target Browser Profile is not available.",
    "Browser Profile ownership or permissions are invalid.",
  );
  let manifestContents: string;
  try {
    const manifestFile = await open(paths.manifestPath, "r");
    try {
      manifestContents = await manifestFile.readFile("utf8");
    } finally {
      await manifestFile.close();
    }
  } catch (error) {
    throw recoveryError(
      "profile-not-found",
      "The target Browser Profile is not available.",
      error,
    );
  }
  let manifest: BrowserProfileManifest;
  try {
    manifest = browserProfileManifestSchema.parse(JSON.parse(manifestContents));
  } catch (error) {
    throw recoveryError(
      "recovery-archive-invalid",
      "The target Browser Profile manifest is invalid.",
      error,
    );
  }
  if (
    manifest.profileId !== target.profileId ||
    manifest.hostId !== target.hostId ||
    manifest.installationId !== installationId
  ) {
    throw new BrowserProfileRecoveryError(
      "recovery-incompatible-installation",
      "The target Browser Profile belongs to another Browser installation or host.",
    );
  }
  return manifest;
}

async function listArchiveFiles(
  profileDirectory: string,
  currentPath: string,
  ownership: ProfileStorageOwnershipBoundary,
): Promise<ArchiveFile[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const archiveFiles: ArchiveFile[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const absolutePath = join(currentPath, entry.name);
    const archivePath = relative(profileDirectory, absolutePath);
    if (!safeArchiveRelativePath(archivePath)) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "Browser Profile contains an unsafe path.",
      );
    }
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "Browser Profile contains an unsupported symbolic link.",
      );
    }
    const kind = metadata.isDirectory() ? "directory" : "file";
    await ownership.verifyOwned(
      absolutePath,
      kind === "directory" ? PROFILE_DIRECTORY_MODE : ARCHIVE_FILE_MODE,
    );
    if (kind === "directory") {
      archiveFiles.push({
        kind,
        path: archivePath,
        mode: archiveEntryMode(kind),
        size: 0,
        sha256: null,
        absolutePath,
      });
      archiveFiles.push(
        ...(await listArchiveFiles(profileDirectory, absolutePath, ownership)),
      );
    } else if (metadata.isFile()) {
      archiveFiles.push({
        kind,
        path: archivePath,
        mode: archiveEntryMode(kind),
        size: metadata.size,
        sha256: await fileSha256(absolutePath),
        absolutePath,
      });
    } else {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "Browser Profile contains an unsupported filesystem entry.",
      );
    }
  }
  return archiveFiles;
}

async function fileSha256(path: string) {
  const sourceFile = await open(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  try {
    while (true) {
      const read = await sourceFile.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      digest.update(buffer.subarray(0, read.bytesRead));
    }
  } finally {
    await sourceFile.close();
  }
  return digest.digest("hex");
}

async function copyFileContents(
  sourcePath: string,
  archiveFile: Awaited<ReturnType<typeof open>>,
  expectedSize: number,
) {
  const sourceFile = await open(sourcePath, "r");
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  let copiedBytes = 0;
  try {
    while (copiedBytes < expectedSize) {
      const read = await sourceFile.read(
        buffer,
        0,
        Math.min(buffer.length, expectedSize - copiedBytes),
        null,
      );
      if (read.bytesRead === 0) break;
      await archiveFile.write(buffer, 0, read.bytesRead);
      copiedBytes += read.bytesRead;
    }
  } finally {
    await sourceFile.close();
  }
  if (copiedBytes !== expectedSize) {
    throw new BrowserProfileRecoveryError(
      "recovery-copy-failed",
      "Browser Profile backup stopped before all profile data was copied.",
    );
  }
}

async function writeArchive(
  archivePath: string,
  header: ArchiveHeader,
  archiveFiles: readonly ArchiveFile[],
  ownership: ProfileStorageOwnershipBoundary,
) {
  let existingArchive;
  try {
    existingArchive = await lstat(archivePath);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  if (existingArchive !== undefined && !existingArchive.isFile()) {
    throw new BrowserProfileRecoveryError(
      "recovery-ownership-invalid",
      "The Browser Profile backup destination is not a regular file.",
    );
  }
  const temporaryArchivePath = `${archivePath}.${randomUUID()}.tmp`;
  const archiveFile = await open(temporaryArchivePath, "wx", ARCHIVE_FILE_MODE);
  let promoted = false;
  let closed = false;
  try {
    await archiveFile.write(Buffer.from(`${PROFILE_ARCHIVE_MAGIC}\n`, "utf8"));
    await archiveFile.write(archiveLine(header));
    for (const archiveEntry of archiveFiles) {
      await archiveFile.write(
        archiveLine({
          kind: archiveEntry.kind,
          path: archiveEntry.path,
          mode: archiveEntry.mode,
          size: archiveEntry.size,
          sha256: archiveEntry.sha256,
        }),
      );
      if (archiveEntry.kind === "file") {
        await copyFileContents(
          archiveEntry.absolutePath,
          archiveFile,
          archiveEntry.size,
        );
      }
    }
    await archiveFile.sync();
    await archiveFile.close();
    closed = true;
    await chmod(temporaryArchivePath, ARCHIVE_FILE_MODE);
    await ownership.ensureOwned(temporaryArchivePath, ARCHIVE_FILE_MODE);
    await rename(temporaryArchivePath, archivePath);
    await chmod(archivePath, ARCHIVE_FILE_MODE);
    await ownership.ensureOwned(archivePath, ARCHIVE_FILE_MODE);
    promoted = true;
  } finally {
    if (!closed) await archiveFile.close().catch(() => undefined);
    if (!promoted) {
      await rm(temporaryArchivePath, { force: true });
    }
  }
}

class RecoveryArchiveReader {
  private offset = 0;
  private bufferedBytes = Buffer.alloc(0);

  constructor(
    private readonly archiveFile: Awaited<ReturnType<typeof open>>,
    private readonly archiveSize: number,
  ) {}

  async readLine() {
    while (true) {
      const newlineIndex = this.bufferedBytes.indexOf(10);
      if (newlineIndex >= 0) {
        const line = this.bufferedBytes
          .subarray(0, newlineIndex)
          .toString("utf8");
        this.bufferedBytes = this.bufferedBytes.subarray(newlineIndex + 1);
        return line;
      }
      if (this.offset >= this.archiveSize) {
        if (this.bufferedBytes.length === 0) return null;
        throw new BrowserProfileRecoveryError(
          "recovery-archive-invalid",
          "The Browser Profile backup has an incomplete record.",
        );
      }
      await this.readChunk();
    }
  }

  async readPayload(
    size: number,
    destination: Awaited<ReturnType<typeof open>>,
  ) {
    const digest = createHash("sha256");
    let remainingBytes = size;
    while (remainingBytes > 0) {
      const chunk = this.bufferedBytes.subarray(
        0,
        Math.min(remainingBytes, this.bufferedBytes.length),
      );
      if (chunk.length > 0) {
        await destination.write(chunk);
        digest.update(chunk);
        this.bufferedBytes = this.bufferedBytes.subarray(chunk.length);
        remainingBytes -= chunk.length;
        continue;
      }
      await this.readChunk();
    }
    return digest.digest("hex");
  }

  async skipPayload(size: number) {
    let remainingBytes = size;
    while (remainingBytes > 0) {
      const chunk = this.bufferedBytes.subarray(
        0,
        Math.min(remainingBytes, this.bufferedBytes.length),
      );
      if (chunk.length > 0) {
        this.bufferedBytes = this.bufferedBytes.subarray(chunk.length);
        remainingBytes -= chunk.length;
        continue;
      }
      await this.readChunk();
    }
  }

  get hasRemainingBytes() {
    return this.bufferedBytes.length > 0 || this.offset < this.archiveSize;
  }

  private async readChunk() {
    const chunk = Buffer.alloc(
      Math.min(COPY_BUFFER_BYTES, this.archiveSize - this.offset),
    );
    const read = await this.archiveFile.read(
      chunk,
      0,
      chunk.length,
      this.offset,
    );
    if (read.bytesRead === 0) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup ended unexpectedly.",
      );
    }
    this.offset += read.bytesRead;
    this.bufferedBytes = Buffer.concat([
      this.bufferedBytes,
      chunk.subarray(0, read.bytesRead),
    ]);
  }
}

function parseArchiveJson<T>(
  serializedValue: string | null,
  schema: z.ZodType<T>,
  invalidMessage: string,
) {
  if (serializedValue === null) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      invalidMessage,
    );
  }
  try {
    return schema.parse(JSON.parse(serializedValue));
  } catch (error) {
    if (error instanceof BrowserProfileRecoveryError) throw error;
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      invalidMessage,
    );
  }
}

async function copyDirectoryTree(
  sourceDirectory: string,
  targetDirectory: string,
  ownership: ProfileStorageOwnershipBoundary,
  copy: ProfileRecoveryCopyBoundary,
): Promise<number> {
  const sourceMetadata = await lstat(sourceDirectory);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The dev-browser profile source is not a regular directory.",
    );
  }
  await mkdir(targetDirectory, {
    recursive: true,
    mode: PROFILE_DIRECTORY_MODE,
  });
  await chmod(targetDirectory, PROFILE_DIRECTORY_MODE);
  await ownership.ensureOwned(targetDirectory, PROFILE_DIRECTORY_MODE);
  let copiedBytes = 0;
  const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const sourceEntry of sourceEntries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const sourcePath = join(sourceDirectory, sourceEntry.name);
    const targetPath = join(targetDirectory, sourceEntry.name);
    const sourceEntryMetadata = await lstat(sourcePath);
    if (sourceEntryMetadata.isSymbolicLink()) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The dev-browser profile source contains an unsupported symbolic link.",
      );
    }
    if (sourceEntryMetadata.isDirectory()) {
      copiedBytes += await copyDirectoryTree(
        sourcePath,
        targetPath,
        ownership,
        copy,
      );
      continue;
    }
    if (!sourceEntryMetadata.isFile()) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The dev-browser profile source contains an unsupported filesystem entry.",
      );
    }
    await copy.copyFile(sourcePath, targetPath);
    await chmod(targetPath, ARCHIVE_FILE_MODE);
    await ownership.ensureOwned(targetPath, ARCHIVE_FILE_MODE);
    copiedBytes += sourceEntryMetadata.size;
  }
  return copiedBytes;
}

async function directoryByteSize(sourceDirectory: string): Promise<number> {
  const sourceEntries = await readdir(sourceDirectory, { withFileTypes: true });
  let totalBytes = 0;
  for (const sourceEntry of sourceEntries) {
    const sourcePath = join(sourceDirectory, sourceEntry.name);
    const sourceMetadata = await lstat(sourcePath);
    if (sourceMetadata.isSymbolicLink()) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The dev-browser profile source contains an unsupported symbolic link.",
      );
    }
    if (sourceMetadata.isDirectory()) {
      totalBytes += await directoryByteSize(sourcePath);
    } else if (sourceMetadata.isFile()) {
      totalBytes += sourceMetadata.size;
    } else {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The dev-browser profile source contains an unsupported filesystem entry.",
      );
    }
  }
  return totalBytes;
}

async function cleanRecoveryStaging(hostStoragePath: string) {
  let storageEntries;
  try {
    storageEntries = await readdir(hostStoragePath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  for (const storageEntry of storageEntries) {
    if (
      !storageEntry.name.startsWith(".recovery-") ||
      !storageEntry.name.endsWith(".tmp")
    ) {
      continue;
    }
    await rm(join(hostStoragePath, storageEntry.name), {
      recursive: true,
      force: true,
    });
  }
}

async function recoverRecoveryState(
  hostStoragePath: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  let storageEntries;
  try {
    storageEntries = await readdir(hostStoragePath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  for (const storageEntry of storageEntries) {
    if (
      !storageEntry.isFile() ||
      !storageEntry.name.startsWith(".recovery-") ||
      !storageEntry.name.endsWith(".journal")
    ) {
      continue;
    }
    const journalPath = join(hostStoragePath, storageEntry.name);
    const journal = await readRecoveryJournal(journalPath, ownership);
    await recoverPromotionJournal(journalPath, journal);
  }
  await cleanRecoveryStaging(hostStoragePath);
}

async function recoverAllHostStorage(
  rootDirectory: string,
  installationId: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const hostsDirectory = join(
    rootDirectory,
    "installations",
    installationId,
    "hosts",
  );
  let hostEntries;
  try {
    hostEntries = await readdir(hostsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  for (const hostEntry of hostEntries) {
    if (!hostEntry.isDirectory() || hostEntry.isSymbolicLink()) continue;
    const hostStoragePath = join(hostsDirectory, hostEntry.name);
    await withRecoveryLock(hostStoragePath, ownership, async () => {
      await recoverRecoveryState(hostStoragePath, ownership);
    });
  }
}

async function requireRecoveryCapacity(
  disk: ProfileRecoveryDiskBoundary,
  capacityPath: string,
  copiedBytes: number,
) {
  const freeBytes = await disk.freeBytes(capacityPath);
  const requiredBytes = MINIMUM_RECOVERY_FREE_BYTES + copiedBytes;
  if (freeBytes >= requiredBytes) return;
  throw new BrowserProfileRecoveryError(
    "recovery-insufficient-disk",
    "Browser Profile recovery needs at least 5 GiB of free host space plus the copied profile data.",
  );
}

function parseArchiveHeader(serializedHeader: string | null): ArchiveHeader {
  if (serializedHeader === null) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup metadata is missing.",
    );
  }
  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(serializedHeader);
  } catch {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup metadata is invalid.",
    );
  }
  const archiveVersion =
    typeof rawHeader === "object" &&
    rawHeader !== null &&
    "version" in rawHeader
      ? rawHeader.version
      : null;
  if (archiveVersion !== PROFILE_ARCHIVE_VERSION) {
    throw new BrowserProfileRecoveryError(
      "recovery-incompatible-version",
      "The Browser Profile backup was created by an incompatible Browser version.",
    );
  }
  const parsedHeader = archiveHeaderSchema.safeParse(rawHeader);
  if (!parsedHeader.success) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup metadata is invalid.",
    );
  }
  return parsedHeader.data;
}

async function inspectArchiveEntries(
  reader: RecoveryArchiveReader,
  header: ArchiveHeader,
) {
  const archiveEntries: ArchiveEntry[] = [];
  const archivePaths = new Set<string>();
  let totalBytes = 0;
  while (archiveEntries.length < header.entryCount) {
    const archiveEntry = parseArchiveJson(
      await reader.readLine(),
      archiveEntrySchema,
      "The Browser Profile backup contains invalid entry metadata.",
    );
    validateArchiveEntry(archiveEntry);
    if (archivePaths.has(archiveEntry.path)) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup contains a duplicate entry.",
      );
    }
    archivePaths.add(archiveEntry.path);
    if (archiveEntry.kind === "file") {
      await reader.skipPayload(archiveEntry.size);
      totalBytes += archiveEntry.size;
    }
    archiveEntries.push(archiveEntry);
  }
  return { archiveEntries, totalBytes };
}

async function extractArchive(
  archivePath: string,
  stagingDirectory: string,
  target: BrowserProfileRecoveryTarget,
  installationId: string,
  ownership: ProfileStorageOwnershipBoundary,
  disk: ProfileRecoveryDiskBoundary,
  capacityPath: string,
) {
  let archiveStats;
  try {
    archiveStats = await lstat(archivePath);
  } catch (error) {
    throw recoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup is not available.",
      error,
    );
  }
  if (!archiveStats.isFile()) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup is not a regular file.",
    );
  }
  await verifyRecoveryOwnership(
    ownership,
    archivePath,
    ARCHIVE_FILE_MODE,
    "recovery-archive-invalid",
    "The Browser Profile backup is not available.",
    "Browser Profile backup ownership or permissions are invalid.",
  );
  const archiveFile = await open(archivePath, "r");
  const reader = new RecoveryArchiveReader(archiveFile, archiveStats.size);
  try {
    const magic = await reader.readLine();
    if (magic !== PROFILE_ARCHIVE_MAGIC) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup format is not recognized.",
      );
    }
    const header = parseArchiveHeader(await reader.readLine());
    if (
      header.installationId !== installationId ||
      header.hostId !== target.hostId ||
      header.profileId !== target.profileId
    ) {
      throw new BrowserProfileRecoveryError(
        "recovery-incompatible-installation",
        "The Browser Profile backup belongs to another Browser installation, host, or profile.",
      );
    }
    const archiveContents = await inspectArchiveEntries(reader, header);
    await requireRecoveryCapacity(
      disk,
      capacityPath,
      archiveContents.totalBytes,
    );
    if (
      reader.hasRemainingBytes ||
      archiveContents.totalBytes !== header.totalBytes
    ) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup contains unexpected data.",
      );
    }
    await ensureRecoveryDirectory(stagingDirectory, ownership);
    const extractionReader = new RecoveryArchiveReader(
      archiveFile,
      archiveStats.size,
    );
    if ((await extractionReader.readLine()) !== PROFILE_ARCHIVE_MAGIC) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup format is not recognized.",
      );
    }
    if (
      JSON.stringify(parseArchiveHeader(await extractionReader.readLine())) !==
      JSON.stringify(header)
    ) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup metadata changed during validation.",
      );
    }
    for (const expectedEntry of archiveContents.archiveEntries) {
      const archiveEntry = parseArchiveJson(
        await extractionReader.readLine(),
        archiveEntrySchema,
        "The Browser Profile backup contains invalid entry metadata.",
      );
      if (JSON.stringify(archiveEntry) !== JSON.stringify(expectedEntry)) {
        throw new BrowserProfileRecoveryError(
          "recovery-archive-invalid",
          "The Browser Profile backup metadata changed during validation.",
        );
      }
      const entryPath = join(stagingDirectory, archiveEntry.path);
      if (archiveEntry.kind === "directory") {
        await ensureRecoveryDirectory(entryPath, ownership);
      } else {
        await ensureRecoveryDirectory(dirname(entryPath), ownership);
        const targetFile = await open(entryPath, "wx", ARCHIVE_FILE_MODE);
        try {
          const sha256 = await extractionReader.readPayload(
            archiveEntry.size,
            targetFile,
          );
          if (sha256 !== archiveEntry.sha256) {
            throw new BrowserProfileRecoveryError(
              "recovery-archive-invalid",
              "The Browser Profile backup contains corrupted profile data.",
            );
          }
        } finally {
          await targetFile.close();
        }
        await chmod(entryPath, ARCHIVE_FILE_MODE);
        await ownership.ensureOwned(entryPath, ARCHIVE_FILE_MODE);
      }
    }
    if (extractionReader.hasRemainingBytes) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The Browser Profile backup contains unexpected data.",
      );
    }
    await validateExtractedProfile(
      stagingDirectory,
      target,
      installationId,
      header,
      ownership,
    );
    const archiveEncryptionState = requireKnownEncryptionState(
      header.encryptionState,
    );
    const stagedEncryptionState = requireKnownEncryptionState(
      await readEncryptionState(join(stagingDirectory, "chrome-data")),
    );
    if (stagedEncryptionState !== archiveEncryptionState) {
      throw new BrowserProfileRecoveryError(
        "recovery-incompatible-encryption",
        "The Browser Profile backup content uses incompatible encryption state.",
      );
    }
    return header;
  } finally {
    await archiveFile.close();
  }
}

function validateArchiveEntry(archiveEntry: ArchiveEntry) {
  if (!safeArchiveRelativePath(archiveEntry.path)) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup contains an unsafe path.",
    );
  }
  if (
    archiveEntry.mode !== archiveEntryMode(archiveEntry.kind) ||
    (archiveEntry.kind === "directory" &&
      (archiveEntry.size !== 0 || archiveEntry.sha256 !== null)) ||
    (archiveEntry.kind === "file" && archiveEntry.sha256 === null)
  ) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup contains inconsistent entry metadata.",
    );
  }
}

async function validateExtractedProfile(
  stagingDirectory: string,
  target: BrowserProfileRecoveryTarget,
  installationId: string,
  header: ArchiveHeader,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const stagedManifestPath = join(stagingDirectory, "manifest.json");
  const stagedBrowserDataPath = join(stagingDirectory, "chrome-data");
  await verifyRecoveryOwnership(
    ownership,
    stagingDirectory,
    PROFILE_DIRECTORY_MODE,
    "recovery-archive-invalid",
    "The Browser Profile backup is missing its staged profile.",
    "The staged Browser Profile ownership or permissions are invalid.",
  );
  let browserDataStats;
  let manifestStats;
  try {
    browserDataStats = await lstat(stagedBrowserDataPath);
    manifestStats = await lstat(stagedManifestPath);
  } catch (error) {
    throw recoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup is missing required profile data.",
      error,
    );
  }
  if (!browserDataStats.isDirectory() || !manifestStats.isFile()) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup has invalid required profile entries.",
    );
  }
  await verifyRecoveryOwnership(
    ownership,
    stagedBrowserDataPath,
    PROFILE_DIRECTORY_MODE,
    "recovery-archive-invalid",
    "The Browser Profile backup is missing its staged profile data.",
    "The staged Browser Profile ownership or permissions are invalid.",
  );
  await verifyRecoveryOwnership(
    ownership,
    stagedManifestPath,
    ARCHIVE_FILE_MODE,
    "recovery-archive-invalid",
    "The Browser Profile backup is missing its staged manifest.",
    "The staged Browser Profile ownership or permissions are invalid.",
  );
  const manifestFile = await open(stagedManifestPath, "r");
  let manifest: BrowserProfileManifest;
  try {
    manifest = browserProfileManifestSchema.parse(
      JSON.parse(await manifestFile.readFile("utf8")),
    );
  } finally {
    await manifestFile.close();
  }
  if (
    manifest.profileId !== target.profileId ||
    manifest.hostId !== target.hostId ||
    manifest.installationId !== installationId ||
    manifest.version !== header.manifest.version ||
    JSON.stringify(manifest) !== JSON.stringify(header.manifest)
  ) {
    throw new BrowserProfileRecoveryError(
      "recovery-archive-invalid",
      "The Browser Profile backup manifest does not match its metadata.",
    );
  }
}

async function promoteRestoredProfile(
  profileDirectory: string,
  stagingDirectory: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const journalPath = `${stagingDirectory}.journal`;
  const rollbackDirectory = `${profileDirectory}.${randomUUID()}.rollback`;
  let phase: RecoveryJournal["phase"] = "prepared";
  const journal = () => ({
    profileDirectory,
    stagingDirectory,
    rollbackDirectory,
    phase,
  });
  await writeRecoveryJournal(journalPath, journal(), ownership);
  try {
    await rename(profileDirectory, rollbackDirectory);
    phase = "old-profile-moved";
    await writeRecoveryJournal(journalPath, journal(), ownership);
    await rename(stagingDirectory, profileDirectory);
    await ownership.ensureOwned(profileDirectory, PROFILE_DIRECTORY_MODE);
    phase = "new-profile-moved";
    await writeRecoveryJournal(journalPath, journal(), ownership);
    await rm(rollbackDirectory, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    return;
  } catch (error) {
    try {
      await recoverPromotionJournal(journalPath, journal());
    } catch (rollbackError) {
      throw recoveryError(
        "recovery-rollback-failed",
        "Browser Profile restore failed and rollback could not be completed.",
        rollbackError,
      );
    }
    throw recoveryError(
      "recovery-copy-failed",
      "Browser Profile restore failed; the prior profile remains usable.",
      error,
    );
  }
}

function recoveryMessage(
  outcome: BrowserProfileRecoveryResult["outcome"],
  archivePath: string,
) {
  return outcome === "backed-up"
    ? `Browser Profile backup created at ${archivePath}. Treat this archive as credential-equivalent.`
    : outcome === "restored"
      ? `Browser Profile restored from ${archivePath}. Treat this archive as credential-equivalent.`
      : "The dev-browser profile was imported into a new Browser Profile.";
}

function completedRecoveryProgress(
  phases: readonly ProfileRecoveryPhase[],
  totalBytes: number,
): ProfileRecoveryProgress {
  return {
    phase: "completed",
    completedBytes: totalBytes,
    totalBytes,
    phases: [...phases],
  };
}

export function createFileBrowserProfileRecovery(
  options: FileBrowserProfileRecoveryOptions,
) {
  const ownership =
    options.ownership ??
    createProfileStorageOwnershipBoundary({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
  const disk = options.disk ?? filesystemDiskBoundary;
  const copy = options.copy ?? filesystemCopyBoundary;
  const profileStore = createFileBrowserProfileStore({
    rootDirectory: options.rootDirectory,
    installationId: options.installationId,
    ownership,
    idFactory: options.idFactory,
    clock: options.clock,
  });
  const startupReady = recoverAllHostStorage(
    options.rootDirectory,
    options.installationId,
    ownership,
  );
  void startupReady.catch(() => undefined);

  async function requireStartupCleanup() {
    await startupReady;
  }

  async function requireStopped(target: BrowserProfileRecoveryTarget) {
    if (await options.state.isProfileStopped(target.hostId, target.profileId))
      return;
    throw new BrowserProfileRecoveryError(
      "profile-running",
      "Stop the Browser Profile before creating or restoring a backup.",
    );
  }

  async function requireSourceStopped(sourcePath: string) {
    const stopAuthority = options.state.isDevBrowserProfileStopped;
    if (
      typeof stopAuthority === "function" &&
      (await stopAuthority(sourcePath))
    ) {
      return;
    }
    throw new BrowserProfileRecoveryError(
      "profile-running",
      "Stop the dev-browser profile before importing it.",
    );
  }

  async function requirePlainSource(sourcePath: string) {
    let sourceMetadata;
    try {
      sourceMetadata = await lstat(sourcePath);
    } catch (error) {
      throw recoveryError(
        "profile-not-found",
        "The dev-browser profile source is not available.",
        error,
      );
    }
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The dev-browser profile source is not a regular directory.",
      );
    }
    if ((await readEncryptionState(sourcePath)) !== "plain") {
      throw new BrowserProfileRecoveryError(
        "recovery-incompatible-encryption",
        "The dev-browser profile uses encryption that cannot be imported safely.",
      );
    }
  }

  async function requireImportSourceOutsideStorage(
    sourcePath: string,
    hostStoragePath: string,
  ) {
    const canonicalSourcePath = await realpath(sourcePath);
    const canonicalRootDirectory = await realpath(options.rootDirectory);
    const protectedRelativePath = relative(
      resolve(options.rootDirectory),
      resolve(hostStoragePath),
    );
    const canonicalHostStoragePath = join(
      canonicalRootDirectory,
      protectedRelativePath,
    );
    if (
      pathIsWithin(canonicalSourcePath, canonicalHostStoragePath) ||
      pathIsWithin(canonicalHostStoragePath, canonicalSourcePath)
    ) {
      throw new BrowserProfileRecoveryError(
        "recovery-archive-invalid",
        "The dev-browser profile source overlaps protected Browser Profile storage.",
      );
    }
  }

  async function backupProfile(
    input: BrowserProfileRecoveryTarget & { archivePath: string },
  ) {
    return withRecoveryFailure(
      "Browser Profile backup could not be created.",
      async () => {
        const paths = profileArchivePath(
          options.rootDirectory,
          options.installationId,
          input,
        );
        await requireStartupCleanup();
        return withRecoveryLock(paths.hostStoragePath, ownership, async () => {
          await recoverRecoveryState(paths.hostStoragePath, ownership);
          if (pathIsWithin(input.archivePath, paths.profileDirectory)) {
            throw new BrowserProfileRecoveryError(
              "recovery-archive-invalid",
              "The Browser Profile backup destination cannot be inside the source profile.",
            );
          }
          await requireStopped(input);
          const manifest = await readProfileManifest(
            paths,
            input,
            options.installationId,
            ownership,
          );
          const archiveFiles = await listArchiveFiles(
            paths.profileDirectory,
            paths.profileDirectory,
            ownership,
          );
          const header: ArchiveHeader = {
            format: PROFILE_ARCHIVE_MAGIC,
            version: PROFILE_ARCHIVE_VERSION,
            installationId: options.installationId,
            hostId: input.hostId,
            profileId: input.profileId,
            manifest,
            encryptionState: requireKnownEncryptionState(
              await readEncryptionState(paths.browserDataPath),
            ),
            entryCount: archiveFiles.length,
            totalBytes: archiveFiles.reduce(
              (totalBytes, archiveEntry) => totalBytes + archiveEntry.size,
              0,
            ),
          };
          await requireRecoveryCapacity(
            disk,
            dirname(input.archivePath),
            header.totalBytes,
          );
          await writeArchive(
            input.archivePath,
            header,
            archiveFiles,
            ownership,
          );
          return {
            outcome: "backed-up" as const,
            message: recoveryMessage("backed-up", input.archivePath),
            archivePath: input.archivePath,
            credentialEquivalent: true as const,
            progress: completedRecoveryProgress(
              ["validating", "copying", "completed"],
              header.totalBytes,
            ),
          };
        });
      },
    );
  }

  async function restoreProfile(
    input: BrowserProfileRecoveryTarget & { archivePath: string },
  ) {
    return withRecoveryFailure(
      "Browser Profile restore could not be completed.",
      async () => {
        const paths = profileArchivePath(
          options.rootDirectory,
          options.installationId,
          input,
        );
        await requireStartupCleanup();
        return withRecoveryLock(paths.hostStoragePath, ownership, async () => {
          await recoverRecoveryState(paths.hostStoragePath, ownership);
          await requireStopped(input);
          const manifest = await readProfileManifest(
            paths,
            input,
            options.installationId,
            ownership,
          );
          const currentEncryptionState = await readEncryptionState(
            paths.browserDataPath,
          );
          requireKnownEncryptionState(currentEncryptionState);
          const stagingDirectory = join(
            paths.hostStoragePath,
            `.recovery-${input.profileId}-${randomUUID()}.tmp`,
          );
          try {
            const header = await extractArchive(
              input.archivePath,
              stagingDirectory,
              input,
              options.installationId,
              ownership,
              disk,
              paths.hostStoragePath,
            );
            if (
              requireKnownEncryptionState(header.encryptionState) !==
              currentEncryptionState
            ) {
              throw new BrowserProfileRecoveryError(
                "recovery-incompatible-encryption",
                "The Browser Profile backup uses incompatible encryption state.",
              );
            }
            if (manifest.version !== PROFILE_MANIFEST_VERSION) {
              throw new BrowserProfileRecoveryError(
                "recovery-incompatible-version",
                "The Browser Profile uses an unsupported profile version.",
              );
            }
            await promoteRestoredProfile(
              paths.profileDirectory,
              stagingDirectory,
              ownership,
            );
            return {
              outcome: "restored" as const,
              message: recoveryMessage("restored", input.archivePath),
              archivePath: input.archivePath,
              credentialEquivalent: true as const,
              progress: completedRecoveryProgress(
                ["validating", "copying", "promoting", "completed"],
                header.totalBytes,
              ),
            };
          } finally {
            await rm(stagingDirectory, { recursive: true, force: true });
          }
        });
      },
    );
  }

  async function importDevBrowserProfile(input: BrowserProfileImportInput) {
    return withRecoveryFailure(
      "dev-browser profile import could not be completed.",
      async () => {
        const hostPaths = profileArchivePath(
          options.rootDirectory,
          options.installationId,
          {
            hostId: input.hostId,
            profileId: DEFAULT_PROFILE_ID,
          },
        );
        await requireSourceStopped(input.sourcePath);
        await requirePlainSource(input.sourcePath);
        await requireImportSourceOutsideStorage(
          input.sourcePath,
          hostPaths.hostStoragePath,
        );
        await requireStartupCleanup();
        return withRecoveryLock(
          hostPaths.hostStoragePath,
          ownership,
          async () => {
            await recoverRecoveryState(hostPaths.hostStoragePath, ownership);
            const sourceBytes = await directoryByteSize(input.sourcePath);
            await requireRecoveryCapacity(
              disk,
              hostPaths.hostStoragePath,
              sourceBytes,
            );
            const stagingDirectory = join(
              hostPaths.hostStoragePath,
              `.recovery-import-${randomUUID()}.tmp`,
            );
            try {
              await ensureRecoveryDirectory(stagingDirectory, ownership);
              const importedBrowserDataPath = join(
                stagingDirectory,
                "chrome-data",
              );
              const copiedBytes = await copyDirectoryTree(
                input.sourcePath,
                importedBrowserDataPath,
                ownership,
                copy,
              );
              const importedProfile = await profileStore.publishStagedProfile(
                {
                  hostId: input.hostId,
                  name: input.name,
                },
                stagingDirectory,
              );
              return {
                outcome: "imported" as const,
                message: recoveryMessage("imported", input.sourcePath),
                profileId: importedProfile.profileId,
                progress: completedRecoveryProgress(
                  ["validating", "copying", "promoting", "completed"],
                  copiedBytes,
                ),
              };
            } catch (error) {
              throw recoveryError(
                "recovery-copy-failed",
                "dev-browser profile import failed; no partial Browser Profile was kept.",
                error,
              );
            } finally {
              await rm(stagingDirectory, { recursive: true, force: true });
            }
          },
        );
      },
    );
  }

  return {
    backupProfile,
    restoreProfile,
    importDevBrowserProfile,
    ready: startupReady,
  };
}
