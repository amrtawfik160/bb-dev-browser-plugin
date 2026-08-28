import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
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
} from "./contracts.js";
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
  isDevBrowserProfileStopped?(sourcePath: string): boolean | Promise<boolean>;
}

export interface ProfileRecoveryDiskBoundary {
  freeBytes(path: string): number | Promise<number>;
}

export interface ProfileRecoveryCopyBoundary {
  copyFile(sourcePath: string, targetPath: string): void | Promise<void>;
}

export interface ProfileRecoveryProgress {
  phase: "validating" | "copying" | "promoting" | "completed";
  completedBytes: number;
  totalBytes: number;
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
    await requireRecoveryCapacity(disk, capacityPath, header.totalBytes);
    await ensureRecoveryDirectory(stagingDirectory, ownership);
    let extractedEntryCount = 0;
    let extractedBytes = 0;
    const extractedPaths = new Set<string>();
    while (extractedEntryCount < header.entryCount) {
      const archiveEntry = parseArchiveJson(
        await reader.readLine(),
        archiveEntrySchema,
        "The Browser Profile backup contains invalid entry metadata.",
      );
      validateArchiveEntry(archiveEntry);
      if (extractedPaths.has(archiveEntry.path)) {
        throw new BrowserProfileRecoveryError(
          "recovery-archive-invalid",
          "The Browser Profile backup contains a duplicate entry.",
        );
      }
      extractedPaths.add(archiveEntry.path);
      const entryPath = join(stagingDirectory, archiveEntry.path);
      if (archiveEntry.kind === "directory") {
        await ensureRecoveryDirectory(entryPath, ownership);
      } else {
        await ensureRecoveryDirectory(dirname(entryPath), ownership);
        const targetFile = await open(entryPath, "wx", ARCHIVE_FILE_MODE);
        try {
          const sha256 = await reader.readPayload(
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
        extractedBytes += archiveEntry.size;
      }
      extractedEntryCount += 1;
    }
    if (reader.hasRemainingBytes || extractedBytes !== header.totalBytes) {
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
  const rollbackDirectory = `${profileDirectory}.${randomUUID()}.rollback`;
  let oldProfileMoved = false;
  let newProfileMoved = false;
  let preserveRollback = false;
  try {
    await rename(profileDirectory, rollbackDirectory);
    oldProfileMoved = true;
    await rename(stagingDirectory, profileDirectory);
    newProfileMoved = true;
    await ownership.ensureOwned(profileDirectory, PROFILE_DIRECTORY_MODE);
    return;
  } catch (error) {
    try {
      if (newProfileMoved)
        await rm(profileDirectory, { recursive: true, force: true });
      if (oldProfileMoved) await rename(rollbackDirectory, profileDirectory);
    } catch (rollbackError) {
      preserveRollback = true;
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
  } finally {
    if (!preserveRollback) {
      await rm(rollbackDirectory, { recursive: true, force: true });
    }
  }
}

function recoveryMessage(
  outcome: BrowserProfileRecoveryResult["outcome"],
  archivePath: string,
) {
  return outcome === "backed-up"
    ? `Browser Profile backup created at ${archivePath}. Treat this archive as credential-equivalent.`
    : outcome === "restored"
      ? `Browser Profile restored from ${archivePath}.`
      : "The dev-browser profile was imported into a new Browser Profile.";
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

  async function requireStopped(target: BrowserProfileRecoveryTarget) {
    if (await options.state.isProfileStopped(target.hostId, target.profileId))
      return;
    throw new BrowserProfileRecoveryError(
      "profile-running",
      "Stop the Browser Profile before creating or restoring a backup.",
    );
  }

  async function requireSourceStopped(sourcePath: string) {
    if (options.state.isDevBrowserProfileStopped === undefined) return;
    if (await options.state.isDevBrowserProfileStopped(sourcePath)) return;
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
        if (pathIsWithin(input.archivePath, paths.profileDirectory)) {
          throw new BrowserProfileRecoveryError(
            "recovery-archive-invalid",
            "The Browser Profile backup destination cannot be inside the source profile.",
          );
        }
        await cleanRecoveryStaging(paths.hostStoragePath);
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
          paths.hostStoragePath,
          header.totalBytes,
        );
        await writeArchive(input.archivePath, header, archiveFiles, ownership);
        return {
          outcome: "backed-up" as const,
          message: recoveryMessage("backed-up", input.archivePath),
          archivePath: input.archivePath,
          credentialEquivalent: true as const,
          progress: {
            phase: "completed" as const,
            completedBytes: header.totalBytes,
            totalBytes: header.totalBytes,
          },
        };
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
        await cleanRecoveryStaging(paths.hostStoragePath);
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
            progress: {
              phase: "completed" as const,
              completedBytes: header.totalBytes,
              totalBytes: header.totalBytes,
            },
          };
        } finally {
          await rm(stagingDirectory, { recursive: true, force: true });
        }
      },
    );
  }

  async function importDevBrowserProfile(input: BrowserProfileImportInput) {
    return withRecoveryFailure(
      "dev-browser profile import could not be completed.",
      async () => {
        await requireSourceStopped(input.sourcePath);
        await requirePlainSource(input.sourcePath);
        const hostPaths = profileArchivePath(
          options.rootDirectory,
          options.installationId,
          {
            hostId: input.hostId,
            profileId: DEFAULT_PROFILE_ID,
          },
        );
        await cleanRecoveryStaging(hostPaths.hostStoragePath);
        const sourceBytes = await directoryByteSize(input.sourcePath);
        await requireRecoveryCapacity(disk, options.rootDirectory, sourceBytes);
        const importedProfile = await profileStore.createProfile({
          hostId: input.hostId,
          name: input.name,
        });
        const importedPaths = profileArchivePath(
          options.rootDirectory,
          options.installationId,
          {
            hostId: input.hostId,
            profileId: importedProfile.profileId,
          },
        );
        const stagingDirectory = join(
          importedPaths.hostStoragePath,
          `.recovery-${importedProfile.profileId}-${randomUUID()}.tmp`,
        );
        try {
          const importedBrowserDataPath = join(stagingDirectory, "chrome-data");
          const copiedBytes = await copyDirectoryTree(
            input.sourcePath,
            importedBrowserDataPath,
            ownership,
            copy,
          );
          await promoteRestoredProfile(
            importedPaths.browserDataPath,
            importedBrowserDataPath,
            ownership,
          );
          return {
            outcome: "imported" as const,
            message: recoveryMessage("imported", input.sourcePath),
            profileId: importedProfile.profileId,
            progress: {
              phase: "completed" as const,
              completedBytes: copiedBytes,
              totalBytes: copiedBytes,
            },
          };
        } catch (error) {
          await rm(importedPaths.profileDirectory, {
            recursive: true,
            force: true,
          });
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
  }

  return { backupProfile, restoreProfile, importDevBrowserProfile };
}
