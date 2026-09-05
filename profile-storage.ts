import {
  chown,
  chmod,
  open,
  mkdir,
  readFile,
  readdir,
  lstat,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  browserHostStorageSegment,
  browserProfileIdSchema,
  browserProfileManifestSchema,
  browserProfileNameSchema,
  DEFAULT_PROFILE_ID,
  PROFILE_ARCHIVE_RETENTION_DAYS,
  PROFILE_DEFAULT_LOCALE,
  PROFILE_DEFAULT_TIMEZONE,
  PROFILE_MANIFEST_VERSION,
  RESET_PROFILE_CONFIRMATION,
  type BrowserProfile,
  type BrowserProfileCreateRequest,
  type BrowserProfileDeleteRequest,
  type BrowserProfileExpiryResponse,
  type BrowserProfileInventory,
  type BrowserProfileLifecycleProgress,
  type BrowserProfileLifecycleResponse,
  type BrowserProfileManifest,
  type BrowserProfileRenameRequest,
  type BrowserProfileResetRequest,
  type BrowserProfileSelectRequest,
  type BrowserProfileTarget,
} from "./contracts.js";

const PROFILE_DIRECTORY_MODE = 0o700;
const PROFILE_MANIFEST_MODE = 0o600;

const legacyProfileManifestSchema = z
  .object({
    version: z.literal(0),
    profileId: browserProfileIdSchema,
    name: browserProfileNameSchema,
    hostId: z.string().min(1),
    installationId: z.string().min(1),
    locale: z.string().min(2).max(64).optional(),
    timezone: z.string().min(1).max(128).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const profileLifecycleJournalSchema = z
  .object({
    operation: z.enum(["archive", "restore", "reset", "delete"]),
    hostId: z.string().min(1),
    profileId: browserProfileIdSchema,
    startedAt: z.string().datetime(),
    phase: z.enum(["planned", "stopped"]),
    replacementProfileId: browserProfileIdSchema.optional(),
  })
  .strict();

type ProfileLifecycleJournal = z.infer<typeof profileLifecycleJournalSchema>;

export interface ProfileStoragePaths {
  hostStoragePath: string;
  profilesDirectory: string;
  profileDirectory: string;
  manifestPath: string;
  manifestBackupPath: string;
  selectionPath: string;
  browserDataPath: string;
  downloadsDirectory: string;
  runtimeManifestsDirectory: string;
  runtimeManifestPath: string;
  lifecycleDirectory: string;
  lifecycleJournalPath: string;
}

export interface BrowserProfileLifecycleBoundary {
  stopProfile(hostId: string, profileId: string): Promise<void>;
  reportProgress?(
    progress: BrowserProfileLifecycleProgress,
  ): void | Promise<void>;
}

export interface BrowserProfileStore {
  listProfiles(hostId: string): Promise<BrowserProfileInventory>;
  initialize(hostId: string): Promise<void>;
  createProfile(request: BrowserProfileCreateRequest): Promise<BrowserProfile>;
  renameProfile(request: BrowserProfileRenameRequest): Promise<BrowserProfile>;
  selectProfile(
    request: BrowserProfileSelectRequest,
  ): Promise<BrowserProfileInventory>;
  archiveProfile(
    request: BrowserProfileTarget,
  ): Promise<BrowserProfileLifecycleResponse>;
  restoreArchivedProfile(
    request: BrowserProfileTarget,
  ): Promise<BrowserProfileLifecycleResponse>;
  resetProfile(
    request: BrowserProfileResetRequest,
  ): Promise<BrowserProfileLifecycleResponse>;
  deleteProfile(
    request: BrowserProfileDeleteRequest,
  ): Promise<BrowserProfileLifecycleResponse>;
  expireArchivedProfiles(hostId: string): Promise<BrowserProfileExpiryResponse>;
  reconcileProfileLifecycle(hostId: string): Promise<void>;
}

export interface FileBrowserProfileStoreOptions {
  rootDirectory: string;
  installationId: string;
  clock?: () => Date;
  idFactory?: () => string;
  ownership?: ProfileStorageOwnershipBoundary;
  lifecycle?: BrowserProfileLifecycleBoundary;
}

export interface ProfileStorageOwner {
  uid: number;
  gid: number;
}

export interface ProfileStorageOwnershipMetadata {
  uid: number;
  gid: number;
  mode: number;
}

export interface ProfileStorageOwnershipOperations {
  chown(path: string, uid: number, gid: number): Promise<void>;
  inspect(path: string): Promise<ProfileStorageOwnershipMetadata>;
}

export interface ProfileStorageOwnershipBoundary {
  ensureOwned(path: string, mode: number): Promise<void>;
  verifyOwned(path: string, mode: number): Promise<void>;
}

const filesystemOwnershipOperations: ProfileStorageOwnershipOperations = {
  chown,
  async inspect(path) {
    const metadata = await lstat(path);
    return { uid: metadata.uid, gid: metadata.gid, mode: metadata.mode };
  },
};

function validateProfileStorageOwner(owner: ProfileStorageOwner) {
  if (
    !Number.isSafeInteger(owner.uid) ||
    owner.uid < 0 ||
    !Number.isSafeInteger(owner.gid) ||
    owner.gid < 0
  ) {
    throw new Error("Browser Profile storage ownership is invalid.");
  }
}

export function createProfileStorageOwnershipBoundary(
  owner: ProfileStorageOwner,
  operations: ProfileStorageOwnershipOperations = filesystemOwnershipOperations,
): ProfileStorageOwnershipBoundary {
  validateProfileStorageOwner(owner);
  async function verifyOwned(path: string, mode: number) {
    const metadata = await operations.inspect(path);
    if (
      metadata.uid !== owner.uid ||
      metadata.gid !== owner.gid ||
      (metadata.mode & 0o7777) !== mode
    ) {
      throw new Error(
        `Browser Profile storage ownership or permissions are invalid: ${path}`,
      );
    }
  }
  return {
    async ensureOwned(path, mode) {
      await operations.chown(path, owner.uid, owner.gid);
      await verifyOwned(path, mode);
    },
    verifyOwned,
  };
}

async function browserUserOwner(
  passwdPath: string,
): Promise<ProfileStorageOwner> {
  const passwd = await readFile(passwdPath, "utf8");
  const fields = passwd
    .split("\n")
    .find((line) => line.startsWith("bb-browser:"))
    ?.split(":");
  const uid = Number(fields?.[2]);
  const gid = Number(fields?.[3]);
  if (
    fields === undefined ||
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    !Number.isSafeInteger(gid) ||
    gid <= 0
  ) {
    throw new Error("The bb-browser system user is not configured.");
  }
  return { uid, gid };
}

export function createBrowserUserProfileOwnershipBoundary(
  options: {
    passwdPath?: string;
    operations?: ProfileStorageOwnershipOperations;
  } = {},
): ProfileStorageOwnershipBoundary {
  let ownerPromise: Promise<ProfileStorageOwner> | undefined;
  let boundaryPromise: Promise<ProfileStorageOwnershipBoundary> | undefined;
  const passwdPath = options.passwdPath ?? "/etc/passwd";
  const operations = options.operations ?? filesystemOwnershipOperations;
  function browserUserBoundary() {
    ownerPromise ??= browserUserOwner(passwdPath);
    boundaryPromise ??= ownerPromise.then((owner) =>
      createProfileStorageOwnershipBoundary(owner, operations),
    );
    return boundaryPromise;
  }
  return {
    ensureOwned: (path, mode) =>
      browserUserBoundary().then((boundary) =>
        boundary.ensureOwned(path, mode),
      ),
    verifyOwned: (path, mode) =>
      browserUserBoundary().then((boundary) =>
        boundary.verifyOwned(path, mode),
      ),
  };
}

type ProfileClock = () => Date;
type ProfileIdFactory = () => string;

export type BrowserProfileErrorCode =
  | "profile-name-conflict"
  | "profile-not-found"
  | "profile-manifest-corrupt"
  | "profile-host-mismatch"
  | "profile-unsupported-version"
  | "profile-id-conflict"
  | "profile-lock-timeout"
  | "profile-settings-invalid"
  | "profile-confirmation-required"
  | "profile-default-protected"
  | "profile-archive-expired";

export class BrowserProfileError extends Error {
  constructor(
    readonly code: BrowserProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserProfileError";
  }
}

function validateInstallationId(installationId: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(installationId)) {
    throw new Error("Browser installation identifiers must be path-safe.");
  }
}

function profilePaths(
  rootDirectory: string,
  installationId: string,
  hostId: string,
  profileId: string,
): ProfileStoragePaths {
  validateInstallationId(installationId);
  browserProfileIdSchema.parse(profileId);
  const hostStoragePath = join(
    rootDirectory,
    "installations",
    installationId,
    "hosts",
    browserHostStorageSegment(hostId),
  );
  const profilesDirectory = join(hostStoragePath, "profiles");
  const profileDirectory = join(profilesDirectory, profileId);
  return {
    hostStoragePath,
    profilesDirectory,
    profileDirectory,
    manifestPath: join(profileDirectory, "manifest.json"),
    manifestBackupPath: join(profileDirectory, "manifest.json.v0.bak"),
    selectionPath: join(hostStoragePath, "selection.json"),
    browserDataPath: join(profileDirectory, "chrome-data"),
    downloadsDirectory: join(hostStoragePath, "downloads", profileId),
    runtimeManifestsDirectory: join(hostStoragePath, "runtime-manifests"),
    runtimeManifestPath: join(
      hostStoragePath,
      "runtime-manifests",
      `${profileId}.json`,
    ),
    lifecycleDirectory: join(hostStoragePath, "profile-lifecycle"),
    lifecycleJournalPath: join(
      hostStoragePath,
      "profile-lifecycle",
      `${profileId}.json`,
    ),
  };
}

export function profileStoragePaths(options: {
  rootDirectory: string;
  installationId: string;
  hostId: string;
  profileId: string;
}): ProfileStoragePaths {
  return profilePaths(
    options.rootDirectory,
    options.installationId,
    options.hostId,
    options.profileId,
  );
}

async function secureDirectory(
  path: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await mkdir(path, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  const directoryStats = await lstat(path);
  if (!directoryStats.isDirectory()) {
    throw new Error(`Browser Profile storage path is not a directory: ${path}`);
  }
  await chmod(path, PROFILE_DIRECTORY_MODE);
  await ownership.ensureOwned(path, PROFILE_DIRECTORY_MODE);
}

async function secureProfileNamespace(
  options: FileBrowserProfileStoreOptions,
  paths: ProfileStoragePaths,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const installationsDirectory = join(options.rootDirectory, "installations");
  const installationDirectory = join(
    installationsDirectory,
    options.installationId,
  );
  await secureDirectory(options.rootDirectory, ownership);
  await secureDirectory(installationsDirectory, ownership);
  await secureDirectory(installationDirectory, ownership);
  await secureDirectory(join(installationDirectory, "hosts"), ownership);
  await secureDirectory(paths.hostStoragePath, ownership);
  await secureDirectory(paths.profilesDirectory, ownership);
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeTemporaryJson(path: string) {
  try {
    await unlink(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function writeJson(
  path: string,
  jsonValue: unknown,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let moved = false;
  try {
    await writeFile(temporaryPath, JSON.stringify(jsonValue), {
      encoding: "utf8",
      mode: PROFILE_MANIFEST_MODE,
    });
    await chmod(temporaryPath, PROFILE_MANIFEST_MODE);
    await ownership.ensureOwned(temporaryPath, PROFILE_MANIFEST_MODE);
    await rename(temporaryPath, path);
    moved = true;
    await chmod(path, PROFILE_MANIFEST_MODE);
    await ownership.ensureOwned(path, PROFILE_MANIFEST_MODE);
  } finally {
    if (!moved) await removeTemporaryJson(temporaryPath);
  }
}

function startupConfiguration() {
  return {
    initialTabUrl: "about:blank" as const,
    suppressWelcome: true as const,
    chromeArguments: ["--no-first-run", "--no-default-browser-check"] as [
      "--no-first-run",
      "--no-default-browser-check",
    ],
  };
}

export function profileManifest(
  request: {
    profileId: string;
    name: string;
    hostId: string;
    installationId: string;
    locale: string;
    timezone: string;
  },
  clock: ProfileClock,
): BrowserProfileManifest {
  const timestamp = clock().toISOString();
  return browserProfileManifestSchema.parse({
    version: PROFILE_MANIFEST_VERSION,
    profileId: request.profileId,
    name: browserProfileNameSchema.parse(request.name),
    hostId: request.hostId,
    installationId: request.installationId,
    locale: request.locale,
    timezone: request.timezone,
    createdAt: timestamp,
    updatedAt: timestamp,
    state: "active",
    archivedAt: null,
    expiresAt: null,
    startup: startupConfiguration(),
    storage: {
      owner: "bb-browser",
      directoryMode: "0700",
      manifestMode: "0600",
    },
  });
}

async function writeProfile(
  options: FileBrowserProfileStoreOptions,
  paths: ProfileStoragePaths,
  manifest: BrowserProfileManifest,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await secureProfileNamespace(options, paths, ownership);
  const stagingDirectory = join(
    paths.hostStoragePath,
    `.profile-${manifest.profileId}-${randomUUID()}.tmp`,
  );
  let promoted = false;
  try {
    await secureDirectory(stagingDirectory, ownership);
    await secureDirectory(join(stagingDirectory, "chrome-data"), ownership);
    await writeJson(
      join(stagingDirectory, "manifest.json"),
      manifest,
      ownership,
    );
    await rename(stagingDirectory, paths.profileDirectory);
    promoted = true;
  } finally {
    if (!promoted) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

function profileFromManifest(
  manifest: BrowserProfileManifest,
  selectedProfileId: string,
): BrowserProfile {
  return {
    ...manifest,
    selected: manifest.profileId === selectedProfileId,
  };
}

function normalizedProfileName(name: string) {
  return name.trim().toLocaleLowerCase("en-US");
}

function validLocale(locale: string) {
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(locale.trim());
    if (canonicalLocale === undefined) throw new RangeError("empty locale");
    return canonicalLocale;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new BrowserProfileError(
      "profile-settings-invalid",
      `Browser Profile locale is not supported: ${locale}`,
    );
  }
}

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone.trim() }).format();
    return timezone.trim();
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new BrowserProfileError(
      "profile-settings-invalid",
      `Browser Profile timezone is not supported: ${timezone}`,
    );
  }
}

function profileSettings(locale: string, timezone: string) {
  return { locale: validLocale(locale), timezone: validTimezone(timezone) };
}

function profileNameConflict(
  profiles: readonly BrowserProfile[],
  name: string,
  ignoredProfileId?: string,
) {
  const normalizedName = normalizedProfileName(name);
  return profiles.some(
    (profile) =>
      profile.profileId !== ignoredProfileId &&
      normalizedProfileName(profile.name) === normalizedName,
  );
}

function manifestVersion(raw: unknown) {
  if (typeof raw !== "object" || raw === null || !("version" in raw)) {
    return null;
  }
  const version = raw.version;
  return typeof version === "number" ? version : null;
}

function migratedManifest(raw: unknown): {
  manifest: BrowserProfileManifest;
  legacy: unknown;
} | null {
  const legacy = legacyProfileManifestSchema.safeParse(raw);
  if (!legacy.success) return null;
  const settings = profileSettings(
    legacy.data.locale ?? PROFILE_DEFAULT_LOCALE,
    legacy.data.timezone ?? PROFILE_DEFAULT_TIMEZONE,
  );
  return {
    legacy: raw,
    manifest: browserProfileManifestSchema.parse({
      ...legacy.data,
      version: PROFILE_MANIFEST_VERSION,
      ...settings,
      state: "active",
      archivedAt: null,
      expiresAt: null,
      startup: startupConfiguration(),
      storage: {
        owner: "bb-browser",
        directoryMode: "0700",
        manifestMode: "0600",
      },
    }),
  };
}

const mutationQueues = new Map<string, Promise<void>>();

function lockKey(options: FileBrowserProfileStoreOptions, hostId: string) {
  return `${options.rootDirectory}\0${options.installationId}\0${hostId}`;
}

function lockPath(options: FileBrowserProfileStoreOptions, hostId: string) {
  return join(
    options.rootDirectory,
    ".locks",
    `${options.installationId}-${browserHostStorageSegment(hostId)}.lock`,
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

const profileLockOwnerSchema = z
  .object({ pid: z.number().int().positive() })
  .strict();

function isMissingFilesystemPath(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function deadProfileLock(path: string) {
  let owner: z.infer<typeof profileLockOwnerSchema>;
  try {
    owner = profileLockOwnerSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return false;
    if (isMissingFilesystemPath(error)) return false;
    throw error;
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return true;
    }
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return false;
    }
    throw error;
  }
}

async function removeDeadProfileLock(path: string) {
  if (!(await deadProfileLock(path))) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFilesystemPath(error)) throw error;
  }
}

async function createProfileLock(path: string) {
  const handle = await open(path, "wx", 0o600);
  let initialized = false;
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }), "utf8");
    await handle.sync();
    initialized = true;
  } finally {
    await handle.close();
    if (!initialized) await removeTemporaryJson(path);
  }
}

async function acquireFileLock(path: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await createProfileLock(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code !== "EEXIST") throw error;
      await removeDeadProfileLock(path);
      await delay(10);
    }
  }
  throw new BrowserProfileError(
    "profile-lock-timeout",
    `Timed out waiting for Browser Profile storage lock: ${path}`,
  );
}

async function withMutationLock<T>(
  options: FileBrowserProfileStoreOptions,
  hostId: string,
  ownership: ProfileStorageOwnershipBoundary,
  operation: () => Promise<T>,
): Promise<T> {
  const key = lockKey(options, hostId);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueues.set(key, current);
  await previous;
  const path = lockPath(options, hostId);
  let lockAcquired = false;
  try {
    await secureDirectory(join(options.rootDirectory, ".locks"), ownership);
    await acquireFileLock(path);
    lockAcquired = true;
    return await operation();
  } finally {
    try {
      if (lockAcquired) {
        await unlink(path).catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return;
          }
          throw error;
        });
      }
    } finally {
      release();
      if (mutationQueues.get(key) === current) mutationQueues.delete(key);
    }
  }
}

type ReadProfileManifest = {
  manifest: BrowserProfileManifest;
  legacy: unknown | null;
};

async function readManifest(
  paths: ProfileStoragePaths,
  hostId: string,
  installationId: string,
): Promise<ReadProfileManifest> {
  let manifestStats;
  try {
    manifestStats = await lstat(paths.manifestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile manifest is missing: ${paths.manifestPath}`,
      );
    }
    throw new BrowserProfileError(
      "profile-manifest-corrupt",
      `Browser Profile manifest cannot be read: ${paths.manifestPath}`,
    );
  }
  if (!manifestStats.isFile()) {
    throw new BrowserProfileError(
      "profile-manifest-corrupt",
      `Browser Profile manifest is not a regular file: ${paths.manifestPath}`,
    );
  }
  let contents: string;
  try {
    contents = await readFile(paths.manifestPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile manifest is missing: ${paths.manifestPath}`,
      );
    }
    throw new BrowserProfileError(
      "profile-manifest-corrupt",
      `Browser Profile manifest cannot be read: ${paths.manifestPath}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new BrowserProfileError(
      "profile-manifest-corrupt",
      `Browser Profile manifest is invalid: ${paths.manifestPath}`,
    );
  }
  const parsed = browserProfileManifestSchema.safeParse(raw);
  const migrated = parsed.success
    ? { manifest: parsed.data, legacy: null }
    : migratedManifest(raw);
  if (migrated === null) {
    if ((manifestVersion(raw) ?? 0) > PROFILE_MANIFEST_VERSION) {
      throw new BrowserProfileError(
        "profile-unsupported-version",
        `Browser Profile manifest version is newer than this Browser installation: ${paths.manifestPath}`,
      );
    }
    throw new BrowserProfileError(
      "profile-manifest-corrupt",
      `Browser Profile manifest is invalid: ${paths.manifestPath}`,
    );
  }
  if (
    migrated.manifest.hostId !== hostId ||
    migrated.manifest.installationId !== installationId
  ) {
    throw new BrowserProfileError(
      "profile-host-mismatch",
      `Browser Profile manifest is for another host or installation: ${paths.manifestPath}`,
    );
  }
  const settings = profileSettings(
    migrated.manifest.locale,
    migrated.manifest.timezone,
  );
  const validatedManifest = browserProfileManifestSchema.parse({
    ...migrated.manifest,
    ...settings,
  });
  return { manifest: validatedManifest, legacy: migrated.legacy };
}

async function profileDirectoryMetadata(path: string) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile storage path is not a directory: ${path}`,
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof BrowserProfileError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile storage directory is missing: ${path}`,
      );
    }
    throw new BrowserProfileError(
      "profile-manifest-corrupt",
      `Browser Profile storage directory cannot be read: ${path}`,
    );
  }
}

async function verifyProfileDirectory(
  path: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await profileDirectoryMetadata(path);
  await ownership.verifyOwned(path, PROFILE_DIRECTORY_MODE);
}

async function verifyProfileStorage(
  paths: ProfileStoragePaths,
  ownership: ProfileStorageOwnershipBoundary,
) {
  await verifyProfileDirectory(paths.profileDirectory, ownership);
  await verifyProfileDirectory(paths.browserDataPath, ownership);
  await ownership.verifyOwned(paths.manifestPath, PROFILE_MANIFEST_MODE);
}

async function readVerifiedManifest(
  paths: ProfileStoragePaths,
  hostId: string,
  installationId: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const parsed = await readManifest(paths, hostId, installationId);
  await verifyProfileStorage(paths, ownership);
  return parsed;
}

async function repairManifest(
  paths: ProfileStoragePaths,
  hostId: string,
  installationId: string,
  ownership: ProfileStorageOwnershipBoundary,
) {
  const parsed = await readManifest(paths, hostId, installationId);
  await secureDirectory(paths.profileDirectory, ownership);
  await secureDirectory(paths.browserDataPath, ownership);
  await chmod(paths.manifestPath, PROFILE_MANIFEST_MODE);
  await ownership.ensureOwned(paths.manifestPath, PROFILE_MANIFEST_MODE);
  if (parsed.legacy !== null) {
    await writeJson(paths.manifestBackupPath, parsed.legacy, ownership);
    await writeJson(paths.manifestPath, parsed.manifest, ownership);
  }
  return parsed.manifest;
}

function profileIdFromFactory(factory: ProfileIdFactory): string {
  const profileId = `profile-${factory()}`;
  return browserProfileIdSchema.parse(profileId);
}

function archiveExpiration(archivedAt: Date) {
  const expiresAt = new Date(archivedAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + PROFILE_ARCHIVE_RETENTION_DAYS);
  return expiresAt;
}

function completedProgress(message: string): BrowserProfileLifecycleProgress {
  return { phase: "completed", message };
}

async function readLifecycleJournal(path: string) {
  if (!(await pathExists(path))) return null;
  return profileLifecycleJournalSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
}

async function removeProfileArtifacts(paths: ProfileStoragePaths) {
  await rm(paths.profileDirectory, { recursive: true, force: true });
  await rm(paths.downloadsDirectory, { recursive: true, force: true });
  await rm(paths.runtimeManifestPath, { force: true });
}

function lifecycleMessage(operation: ProfileLifecycleJournal["operation"]) {
  if (operation === "archive") return "Archiving Browser Profile storage.";
  if (operation === "restore") return "Restoring Archived Profile storage.";
  if (operation === "reset") return "Resetting Browser Profile storage.";
  return "Permanently deleting Browser Profile storage.";
}

function profileNotFound(target: BrowserProfileTarget) {
  return new BrowserProfileError(
    "profile-not-found",
    `Browser Profile ${target.profileId} does not exist on host ${target.hostId}.`,
  );
}

function lifecycleProfileResponse(
  outcome:
    "archived" | "already-archived" | "restored" | "already-restored" | "reset",
  profile: BrowserProfile,
): BrowserProfileLifecycleResponse {
  const message = `Browser Profile ${profile.name} is ${outcome.replace("already-", "already ")}.`;
  return {
    outcome,
    profile,
    progress: completedProgress("Lifecycle completed."),
    message,
  };
}

function lifecycleDeleteResponse(
  profileId: string,
  outcome: "deleted" | "already-deleted" = "already-deleted",
): BrowserProfileLifecycleResponse {
  const message =
    outcome === "deleted"
      ? `Browser Profile ${profileId} was permanently deleted.`
      : `Browser Profile ${profileId} was already permanently deleted.`;
  return {
    outcome,
    profileId,
    progress: completedProgress("Lifecycle completed."),
    message,
  };
}

function assertDeleteConfirmation(
  profile: BrowserProfile,
  request: BrowserProfileDeleteRequest,
) {
  if (request.confirmation !== profile.name) {
    throw new BrowserProfileError(
      "profile-confirmation-required",
      `Type the exact Browser Profile name "${profile.name}" to delete it.`,
    );
  }
  const defaultProfileId = request.defaultProfileId ?? DEFAULT_PROFILE_ID;
  if (defaultProfileId === profile.profileId) {
    throw new BrowserProfileError(
      "profile-default-protected",
      "Select another default Browser Profile before permanent deletion.",
    );
  }
}

export function createFileBrowserProfileStore(
  options: FileBrowserProfileStoreOptions,
) {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const ownership =
    options.ownership ??
    createProfileStorageOwnershipBoundary({
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
  const lifecycle = options.lifecycle ?? {
    async stopProfile() {
      throw new Error("Browser Profile process control is unavailable.");
    },
  };

  async function reportLifecycleProgress(
    phase: BrowserProfileLifecycleProgress["phase"],
    message: string,
  ) {
    await lifecycle.reportProgress?.({ phase, message });
  }

  async function persistLifecycleJournal(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    await secureDirectory(paths.lifecycleDirectory, ownership);
    await writeJson(paths.lifecycleJournalPath, journal, ownership);
  }

  async function stoppedLifecycleJournal(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    await reportLifecycleProgress("stopping", "Stopping the Browser Instance.");
    await lifecycle.stopProfile(journal.hostId, journal.profileId);
    const stopped = { ...journal, phase: "stopped" as const };
    await persistLifecycleJournal(paths, stopped);
    return stopped;
  }

  async function archivedManifest(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    const manifest = await repairManifest(
      paths,
      journal.hostId,
      options.installationId,
      ownership,
    );
    if (manifest.state === "archived") return manifest;
    const archivedAt = clock();
    return browserProfileManifestSchema.parse({
      ...manifest,
      state: "archived",
      archivedAt: archivedAt.toISOString(),
      expiresAt: archiveExpiration(archivedAt).toISOString(),
      updatedAt: archivedAt.toISOString(),
    });
  }

  async function activeManifest(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    const manifest = await repairManifest(
      paths,
      journal.hostId,
      options.installationId,
      ownership,
    );
    if (manifest.state === "active") return manifest;
    if (clock() > new Date(manifest.expiresAt)) {
      throw new BrowserProfileError(
        "profile-archive-expired",
        `Archived Profile ${journal.profileId} has expired.`,
      );
    }
    return browserProfileManifestSchema.parse({
      ...manifest,
      state: "active",
      archivedAt: null,
      expiresAt: null,
      updatedAt: clock().toISOString(),
    });
  }

  async function resetBrowserState(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    const manifest = await repairManifest(
      paths,
      journal.hostId,
      options.installationId,
      ownership,
    );
    const replacementProfileId = journal.replacementProfileId;
    if (manifest.state !== "active" && replacementProfileId === undefined) {
      throw new BrowserProfileError(
        "profile-not-found",
        "Restore the Archived Profile before resetting it.",
      );
    }
    if (replacementProfileId === undefined) {
      throw new BrowserProfileError(
        "profile-not-found",
        "Legacy reset journal has no replacement Browser Profile.",
      );
    }
    const resetAt = new Date(journal.startedAt);
    await writeJson(
      paths.manifestPath,
      resetArchivedManifest(manifest, resetAt),
      ownership,
    );
    return resetReplacementProfile(manifest, journal, replacementProfileId);
  }

  function resetArchivedManifest(
    manifest: BrowserProfileManifest,
    resetAt: Date,
  ) {
    return browserProfileManifestSchema.parse({
      ...manifest,
      state: "archived",
      archivedAt: resetAt.toISOString(),
      expiresAt: archiveExpiration(resetAt).toISOString(),
      updatedAt: resetAt.toISOString(),
    });
  }

  function resetReplacementManifest(
    manifest: BrowserProfileManifest,
    journal: ProfileLifecycleJournal,
    replacementProfileId: string,
  ) {
    return profileManifest(
      {
        profileId: replacementProfileId,
        name: manifest.name,
        hostId: journal.hostId,
        installationId: options.installationId,
        locale: manifest.locale,
        timezone: manifest.timezone,
      },
      () => new Date(journal.startedAt),
    );
  }

  async function resetReplacementProfile(
    manifest: BrowserProfileManifest,
    journal: ProfileLifecycleJournal,
    replacementProfileId: string,
  ) {
    const replacementPaths = profilePaths(
      options.rootDirectory,
      options.installationId,
      journal.hostId,
      replacementProfileId,
    );
    if (await pathExists(replacementPaths.profileDirectory)) {
      return repairManifest(
        replacementPaths,
        journal.hostId,
        options.installationId,
        ownership,
      );
    }
    const replacement = resetReplacementManifest(
      manifest,
      journal,
      replacementProfileId,
    );
    await writeProfile(options, replacementPaths, replacement, ownership);
    return replacement;
  }

  async function applyLifecycleStorage(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    await reportLifecycleProgress(
      "updating-storage",
      lifecycleMessage(journal.operation),
    );
    if (journal.operation === "delete") {
      await removeProfileArtifacts(paths);
      return null;
    }
    const manifest =
      journal.operation === "archive"
        ? await archivedManifest(paths, journal)
        : journal.operation === "restore"
          ? await activeManifest(paths, journal)
          : await resetBrowserState(paths, journal);
    if (journal.operation !== "reset") {
      await writeJson(paths.manifestPath, manifest, ownership);
    }
    return manifest;
  }

  async function executeLifecycleJournal(
    paths: ProfileStoragePaths,
    journal: ProfileLifecycleJournal,
  ) {
    const stopped =
      journal.phase === "planned"
        ? await stoppedLifecycleJournal(paths, journal)
        : journal;
    const manifest = await applyLifecycleStorage(paths, stopped);
    await reportLifecycleProgress(
      "completed",
      `Browser Profile ${journal.operation} completed.`,
    );
    await rm(paths.lifecycleJournalPath, { force: true });
    return manifest;
  }

  function beginLifecycle(
    operation: "delete",
    request: BrowserProfileTarget,
  ): Promise<{ paths: ProfileStoragePaths; manifest: null }>;
  function beginLifecycle(
    operation: "archive" | "restore" | "reset",
    request: BrowserProfileTarget,
  ): Promise<{ paths: ProfileStoragePaths; manifest: BrowserProfileManifest }>;
  async function beginLifecycle(
    operation: ProfileLifecycleJournal["operation"],
    request: BrowserProfileTarget,
  ) {
    const paths = profilePaths(
      options.rootDirectory,
      options.installationId,
      request.hostId,
      request.profileId,
    );
    const journal = {
      operation,
      hostId: request.hostId,
      profileId: request.profileId,
      startedAt: clock().toISOString(),
      phase: "planned" as const,
    };
    await persistLifecycleJournal(paths, journal);
    return { paths, manifest: await executeLifecycleJournal(paths, journal) };
  }

  async function beginResetLifecycle(request: BrowserProfileTarget) {
    const paths = profilePaths(
      options.rootDirectory,
      options.installationId,
      request.hostId,
      request.profileId,
    );
    const journal: ProfileLifecycleJournal = {
      operation: "reset",
      hostId: request.hostId,
      profileId: request.profileId,
      replacementProfileId: profileIdFromFactory(idFactory),
      startedAt: clock().toISOString(),
      phase: "planned",
    };
    await persistLifecycleJournal(paths, journal);
    return {
      paths,
      manifest: (await executeLifecycleJournal(paths, journal))!,
    };
  }

  async function ensureDefaultProfile(hostId: string) {
    const paths = profilePaths(
      options.rootDirectory,
      options.installationId,
      hostId,
      DEFAULT_PROFILE_ID,
    );
    await secureProfileNamespace(options, paths, ownership);
    const profileDirectoryEntries = await readdir(paths.profilesDirectory, {
      withFileTypes: true,
    });
    if (profileDirectoryEntries.some((entry) => !entry.isDirectory())) {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile directory contains a non-directory entry on host ${hostId}.`,
      );
    }
    const defaultDirectoryExists = profileDirectoryEntries.some(
      (entry) => entry.isDirectory() && entry.name === DEFAULT_PROFILE_ID,
    );
    if (defaultDirectoryExists) {
      await repairManifest(paths, hostId, options.installationId, ownership);
    } else {
      const manifest = profileManifest(
        {
          profileId: DEFAULT_PROFILE_ID,
          name: DEFAULT_PROFILE_ID,
          hostId,
          installationId: options.installationId,
          locale: PROFILE_DEFAULT_LOCALE,
          timezone: PROFILE_DEFAULT_TIMEZONE,
        },
        clock,
      );
      await writeProfile(options, paths, manifest, ownership);
    }
    for (const entry of profileDirectoryEntries) {
      if (entry.name === DEFAULT_PROFILE_ID) continue;
      const parsedProfileId = browserProfileIdSchema.safeParse(entry.name);
      if (!parsedProfileId.success) {
        throw new BrowserProfileError(
          "profile-manifest-corrupt",
          `Browser Profile directory is invalid: ${entry.name}`,
        );
      }
      await repairManifest(
        profilePaths(
          options.rootDirectory,
          options.installationId,
          hostId,
          parsedProfileId.data,
        ),
        hostId,
        options.installationId,
        ownership,
      );
    }
  }

  async function listProfilesUnlocked(
    hostId: string,
    selectedProfileId = DEFAULT_PROFILE_ID,
  ): Promise<BrowserProfileInventory> {
    const defaultPaths = profilePaths(
      options.rootDirectory,
      options.installationId,
      hostId,
      DEFAULT_PROFILE_ID,
    );
    let profilesDirectoryStats;
    try {
      profilesDirectoryStats = await lstat(defaultPaths.profilesDirectory);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {
          hostId,
          installationId: options.installationId,
          selectedProfileId: DEFAULT_PROFILE_ID,
          profiles: [],
        };
      }
      throw error;
    }
    if (!profilesDirectoryStats.isDirectory()) {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile storage path is not a directory: ${defaultPaths.profilesDirectory}`,
      );
    }
    const entries = await readdir(defaultPaths.profilesDirectory, {
      withFileTypes: true,
    });
    if (entries.some((entry) => !entry.isDirectory())) {
      throw new BrowserProfileError(
        "profile-manifest-corrupt",
        `Browser Profile directory contains a non-directory entry on host ${hostId}.`,
      );
    }
    const profiles = await Promise.all(
      entries
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const parsedProfileId = browserProfileIdSchema.safeParse(entry.name);
          if (!parsedProfileId.success) {
            throw new BrowserProfileError(
              "profile-manifest-corrupt",
              `Browser Profile directory is invalid: ${entry.name}`,
            );
          }
          const { manifest } = await readVerifiedManifest(
            profilePaths(
              options.rootDirectory,
              options.installationId,
              hostId,
              parsedProfileId.data,
            ),
            hostId,
            options.installationId,
            ownership,
          );
          if (manifest.profileId !== parsedProfileId.data) {
            throw new BrowserProfileError(
              "profile-manifest-corrupt",
              `Browser Profile manifest does not match its directory: ${entry.name}`,
            );
          }
          return profileFromManifest(manifest, selectedProfileId);
        }),
    );
    return {
      hostId,
      installationId: options.installationId,
      selectedProfileId,
      profiles,
    };
  }

  async function listProfiles(
    hostId: string,
  ): Promise<BrowserProfileInventory> {
    return listProfilesUnlocked(hostId);
  }

  async function initialize(hostId: string): Promise<void> {
    await withMutationLock(options, hostId, ownership, () =>
      ensureDefaultProfile(hostId),
    );
  }

  async function createProfile(
    request: BrowserProfileCreateRequest,
  ): Promise<BrowserProfile> {
    return withMutationLock(options, request.hostId, ownership, async () => {
      await ensureDefaultProfile(request.hostId);
      const inventory = await listProfilesUnlocked(request.hostId);
      if (profileNameConflict(inventory.profiles, request.name)) {
        throw new BrowserProfileError(
          "profile-name-conflict",
          `A Browser Profile named "${request.name.trim()}" already exists on host ${request.hostId}.`,
        );
      }
      const profileId = profileIdFromFactory(idFactory);
      const paths = profilePaths(
        options.rootDirectory,
        options.installationId,
        request.hostId,
        profileId,
      );
      if (await pathExists(paths.profileDirectory)) {
        throw new BrowserProfileError(
          "profile-id-conflict",
          `Browser Profile identifier ${profileId} already exists on host ${request.hostId}.`,
        );
      }
      const manifest = profileManifest(
        {
          profileId,
          name: request.name,
          hostId: request.hostId,
          installationId: options.installationId,
          ...profileSettings(
            request.locale ?? PROFILE_DEFAULT_LOCALE,
            request.timezone ?? PROFILE_DEFAULT_TIMEZONE,
          ),
        },
        clock,
      );
      try {
        await writeProfile(options, paths, manifest, ownership);
      } catch (error) {
        await rm(paths.profileDirectory, { recursive: true, force: true });
        throw error;
      }
      return profileFromManifest(manifest, inventory.selectedProfileId);
    });
  }

  async function publishStagedProfile(
    request: BrowserProfileCreateRequest,
    stagedProfileDirectory: string,
  ): Promise<BrowserProfile> {
    return withMutationLock(options, request.hostId, ownership, async () => {
      await ensureDefaultProfile(request.hostId);
      const inventory = await listProfilesUnlocked(request.hostId);
      if (profileNameConflict(inventory.profiles, request.name)) {
        throw new BrowserProfileError(
          "profile-name-conflict",
          `A Browser Profile named "${request.name.trim()}" already exists on host ${request.hostId}.`,
        );
      }
      const profileId = profileIdFromFactory(idFactory);
      const paths = profilePaths(
        options.rootDirectory,
        options.installationId,
        request.hostId,
        profileId,
      );
      if (await pathExists(paths.profileDirectory)) {
        throw new BrowserProfileError(
          "profile-id-conflict",
          `Browser Profile identifier ${profileId} already exists on host ${request.hostId}.`,
        );
      }
      await verifyProfileDirectory(stagedProfileDirectory, ownership);
      await verifyProfileDirectory(
        join(stagedProfileDirectory, "chrome-data"),
        ownership,
      );
      const manifest = profileManifest(
        {
          profileId,
          name: request.name,
          hostId: request.hostId,
          installationId: options.installationId,
          ...profileSettings(
            request.locale ?? PROFILE_DEFAULT_LOCALE,
            request.timezone ?? PROFILE_DEFAULT_TIMEZONE,
          ),
        },
        clock,
      );
      await writeJson(
        join(stagedProfileDirectory, "manifest.json"),
        manifest,
        ownership,
      );
      await rename(stagedProfileDirectory, paths.profileDirectory);
      return profileFromManifest(manifest, inventory.selectedProfileId);
    });
  }

  async function renameProfile(
    request: BrowserProfileRenameRequest,
  ): Promise<BrowserProfile> {
    return withMutationLock(options, request.hostId, ownership, async () => {
      await ensureDefaultProfile(request.hostId);
      const inventory = await listProfilesUnlocked(request.hostId);
      const current = inventory.profiles.find(
        (profile) => profile.profileId === request.profileId,
      );
      if (current === undefined) {
        throw new BrowserProfileError(
          "profile-not-found",
          `Browser Profile ${request.profileId} does not exist on host ${request.hostId}.`,
        );
      }
      if (
        profileNameConflict(inventory.profiles, request.name, request.profileId)
      ) {
        throw new BrowserProfileError(
          "profile-name-conflict",
          `A Browser Profile named "${request.name.trim()}" already exists on host ${request.hostId}.`,
        );
      }
      const paths = profilePaths(
        options.rootDirectory,
        options.installationId,
        request.hostId,
        request.profileId,
      );
      const manifest = await repairManifest(
        paths,
        request.hostId,
        options.installationId,
        ownership,
      );
      const renamed = browserProfileManifestSchema.parse({
        ...manifest,
        name: request.name,
        ...profileSettings(
          request.locale ?? manifest.locale,
          request.timezone ?? manifest.timezone,
        ),
        updatedAt: clock().toISOString(),
      });
      await writeJson(paths.manifestPath, renamed, ownership);
      return profileFromManifest(renamed, inventory.selectedProfileId);
    });
  }

  async function selectProfile(
    request: BrowserProfileSelectRequest,
  ): Promise<BrowserProfileInventory> {
    return withMutationLock(options, request.hostId, ownership, async () => {
      await ensureDefaultProfile(request.hostId);
      const inventory = await listProfilesUnlocked(request.hostId);
      const selected = inventory.profiles.some(
        (profile) => profile.profileId === request.profileId,
      );
      if (!selected) {
        throw new BrowserProfileError(
          "profile-not-found",
          `Browser Profile ${request.profileId} does not exist on host ${request.hostId}.`,
        );
      }
      return listProfilesUnlocked(request.hostId, request.profileId);
    });
  }

  async function reconcileProfileLifecycleUnlocked(hostId: string) {
    const paths = profilePaths(
      options.rootDirectory,
      options.installationId,
      hostId,
      DEFAULT_PROFILE_ID,
    );
    if (!(await pathExists(paths.lifecycleDirectory))) return;
    const entries = await readdir(paths.lifecycleDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const journalPath = join(paths.lifecycleDirectory, entry.name);
      const journal = await readLifecycleJournal(journalPath);
      if (journal === null || journal.hostId !== hostId) continue;
      const journalPaths = profilePaths(
        options.rootDirectory,
        options.installationId,
        hostId,
        journal.profileId,
      );
      try {
        await executeLifecycleJournal(journalPaths, journal);
      } catch (error) {
        if (!recoverableLifecycleJournalError(journal, error)) throw error;
        await rm(journalPath, { force: true });
      }
    }
  }

  function recoverableLifecycleJournalError(
    journal: ProfileLifecycleJournal,
    error: unknown,
  ) {
    if (!(error instanceof BrowserProfileError)) return false;
    const expiredRestore =
      journal.operation === "restore" &&
      error.code === "profile-archive-expired";
    const invalidLegacyReset =
      journal.operation === "reset" &&
      journal.replacementProfileId === undefined;
    return expiredRestore || invalidLegacyReset;
  }

  async function reconcileBeforeLifecycle(hostId: string) {
    await reconcileProfileLifecycleUnlocked(hostId);
    return listProfilesUnlocked(hostId);
  }

  async function archiveProfile(request: BrowserProfileTarget) {
    return withMutationLock(options, request.hostId, ownership, async () => {
      const inventory = await reconcileBeforeLifecycle(request.hostId);
      const current = inventory.profiles.find(
        (profile) => profile.profileId === request.profileId,
      );
      if (current === undefined) throw profileNotFound(request);
      if (current.state === "archived") {
        return lifecycleProfileResponse("already-archived", current);
      }
      const { manifest } = await beginLifecycle("archive", request);
      return lifecycleProfileResponse(
        "archived",
        profileFromManifest(manifest, inventory.selectedProfileId),
      );
    });
  }

  async function restoreArchivedProfile(request: BrowserProfileTarget) {
    return withMutationLock(options, request.hostId, ownership, async () => {
      const inventory = await reconcileBeforeLifecycle(request.hostId);
      const current = inventory.profiles.find(
        (profile) => profile.profileId === request.profileId,
      );
      if (current === undefined) throw profileNotFound(request);
      if (current.state === "active") {
        return lifecycleProfileResponse("already-restored", current);
      }
      if (clock() > new Date(current.expiresAt)) {
        throw new BrowserProfileError(
          "profile-archive-expired",
          `Archived Profile ${request.profileId} has expired.`,
        );
      }
      const { manifest } = await beginLifecycle("restore", request);
      return lifecycleProfileResponse(
        "restored",
        profileFromManifest(manifest, inventory.selectedProfileId),
      );
    });
  }

  async function resetProfile(request: BrowserProfileResetRequest) {
    if (request.confirmation !== RESET_PROFILE_CONFIRMATION) {
      throw new BrowserProfileError(
        "profile-confirmation-required",
        `Type exactly "${RESET_PROFILE_CONFIRMATION}" to confirm credential loss.`,
      );
    }
    return withMutationLock(options, request.hostId, ownership, async () => {
      const inventory = await reconcileBeforeLifecycle(request.hostId);
      const current = inventory.profiles.find(
        (profile) => profile.profileId === request.profileId,
      );
      if (current === undefined) throw profileNotFound(request);
      if (current.state !== "active") {
        throw new BrowserProfileError(
          "profile-not-found",
          "Restore the Archived Profile before resetting it.",
        );
      }
      const { manifest } = await beginResetLifecycle(request);
      return lifecycleProfileResponse(
        "reset",
        profileFromManifest(
          manifest,
          inventory.selectedProfileId === request.profileId
            ? manifest.profileId
            : inventory.selectedProfileId,
        ),
      );
    });
  }

  async function deleteProfile(request: BrowserProfileDeleteRequest) {
    return withMutationLock(options, request.hostId, ownership, async () => {
      const inventory = await reconcileBeforeLifecycle(request.hostId);
      const current = inventory.profiles.find(
        (profile) => profile.profileId === request.profileId,
      );
      if (current === undefined)
        return lifecycleDeleteResponse(request.profileId);
      assertDeleteConfirmation(current, request);
      await beginLifecycle("delete", request);
      return lifecycleDeleteResponse(request.profileId, "deleted");
    });
  }

  async function expireArchivedProfiles(hostId: string) {
    return withMutationLock(options, hostId, ownership, async () => {
      const inventory = await reconcileBeforeLifecycle(hostId);
      const expired = inventory.profiles.filter(
        (profile) =>
          profile.state === "archived" && clock() > new Date(profile.expiresAt),
      );
      for (const profile of expired) {
        await beginLifecycle("delete", {
          hostId,
          profileId: profile.profileId,
        });
      }
      return { deletedProfileIds: expired.map(({ profileId }) => profileId) };
    });
  }

  async function reconcileProfileLifecycle(hostId: string) {
    await withMutationLock(options, hostId, ownership, () =>
      reconcileProfileLifecycleUnlocked(hostId),
    );
  }

  return {
    listProfiles,
    initialize,
    createProfile,
    publishStagedProfile,
    renameProfile,
    selectProfile,
    archiveProfile,
    restoreArchivedProfile,
    resetProfile,
    deleteProfile,
    expireArchivedProfiles,
    reconcileProfileLifecycle,
  };
}
