import {
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
  PROFILE_DEFAULT_LOCALE,
  PROFILE_DEFAULT_TIMEZONE,
  PROFILE_MANIFEST_VERSION,
  type BrowserProfile,
  type BrowserProfileCreateRequest,
  type BrowserProfileInventory,
  type BrowserProfileManifest,
  type BrowserProfileRenameRequest,
  type BrowserProfileSelectRequest,
} from "./contracts.js";

const profileSelectionSchema = z
  .object({
    version: z.literal(PROFILE_MANIFEST_VERSION),
    selectedProfileId: browserProfileIdSchema,
  })
  .strict();

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

export interface ProfileStoragePaths {
  hostStoragePath: string;
  profilesDirectory: string;
  profileDirectory: string;
  manifestPath: string;
  manifestBackupPath: string;
  selectionPath: string;
  browserDataPath: string;
}

export interface BrowserProfileStore {
  listProfiles(hostId: string): Promise<BrowserProfileInventory>;
  createProfile(request: BrowserProfileCreateRequest): Promise<BrowserProfile>;
  renameProfile(request: BrowserProfileRenameRequest): Promise<BrowserProfile>;
  selectProfile(
    request: BrowserProfileSelectRequest,
  ): Promise<BrowserProfileInventory>;
}

export interface FileBrowserProfileStoreOptions {
  rootDirectory: string;
  installationId: string;
  clock?: () => Date;
  idFactory?: () => string;
}

type ProfileClock = () => Date;
type ProfileIdFactory = () => string;

export type BrowserProfileErrorCode =
  | "profile-name-conflict"
  | "profile-not-found"
  | "profile-manifest-corrupt"
  | "profile-selection-corrupt"
  | "profile-host-mismatch"
  | "profile-unsupported-version"
  | "profile-id-conflict"
  | "profile-lock-timeout"
  | "profile-settings-invalid";

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

async function secureDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: PROFILE_DIRECTORY_MODE });
  const directoryStats = await lstat(path);
  if (!directoryStats.isDirectory()) {
    throw new Error(`Browser Profile storage path is not a directory: ${path}`);
  }
  await chmod(path, PROFILE_DIRECTORY_MODE);
}

async function secureProfileNamespace(
  options: FileBrowserProfileStoreOptions,
  paths: ProfileStoragePaths,
) {
  const installationsDirectory = join(options.rootDirectory, "installations");
  const installationDirectory = join(
    installationsDirectory,
    options.installationId,
  );
  await secureDirectory(options.rootDirectory);
  await secureDirectory(installationsDirectory);
  await secureDirectory(installationDirectory);
  await secureDirectory(join(installationDirectory, "hosts"));
  await secureDirectory(paths.hostStoragePath);
  await secureDirectory(paths.profilesDirectory);
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

async function writeJson(path: string, jsonValue: unknown) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let moved = false;
  try {
    await writeFile(temporaryPath, JSON.stringify(jsonValue), {
      encoding: "utf8",
      mode: PROFILE_MANIFEST_MODE,
    });
    await chmod(temporaryPath, PROFILE_MANIFEST_MODE);
    await rename(temporaryPath, path);
    moved = true;
    await chmod(path, PROFILE_MANIFEST_MODE);
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

function profileManifest(
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
) {
  await secureProfileNamespace(options, paths);
  await secureDirectory(paths.profileDirectory);
  await secureDirectory(paths.browserDataPath);
  await writeJson(paths.manifestPath, manifest);
}

async function writeSelection(path: string, profileId: string) {
  await writeJson(path, {
    version: PROFILE_MANIFEST_VERSION,
    selectedProfileId: profileId,
  });
}

async function readSelection(path: string): Promise<string | null> {
  let selectionStats;
  try {
    selectionStats = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw new BrowserProfileError(
      "profile-selection-corrupt",
      `Browser Profile selection cannot be read: ${path}`,
    );
  }
  if (!selectionStats.isFile()) {
    throw new BrowserProfileError(
      "profile-selection-corrupt",
      `Browser Profile selection is not a regular file: ${path}`,
    );
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (!(error instanceof Error)) throw error;
    throw new BrowserProfileError(
      "profile-selection-corrupt",
      `Browser Profile selection cannot be read: ${path}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new BrowserProfileError(
      "profile-selection-corrupt",
      `Browser Profile selection is invalid: ${path}`,
    );
  }
  const selection = profileSelectionSchema.safeParse(raw);
  if (!selection.success) {
    throw new BrowserProfileError(
      "profile-selection-corrupt",
      `Browser Profile selection is invalid: ${path}`,
    );
  }
  return selection.data.selectedProfileId;
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

async function acquireFileLock(path: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error)) throw error;
      if (error.code !== "EEXIST") throw error;
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
    await secureDirectory(join(options.rootDirectory, ".locks"));
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

async function readManifest(
  paths: ProfileStoragePaths,
  hostId: string,
  installationId: string,
): Promise<BrowserProfileManifest> {
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
  await secureDirectory(paths.profileDirectory);
  await secureDirectory(paths.browserDataPath);
  await chmod(paths.manifestPath, PROFILE_MANIFEST_MODE);
  const settings = profileSettings(
    migrated.manifest.locale,
    migrated.manifest.timezone,
  );
  const validatedManifest = browserProfileManifestSchema.parse({
    ...migrated.manifest,
    ...settings,
  });
  if (migrated.legacy !== null) {
    await writeJson(paths.manifestBackupPath, migrated.legacy);
    await writeJson(paths.manifestPath, validatedManifest);
  }
  return validatedManifest;
}

function profileIdFromFactory(factory: ProfileIdFactory): string {
  const profileId = `profile-${factory()}`;
  return browserProfileIdSchema.parse(profileId);
}

export function createFileBrowserProfileStore(
  options: FileBrowserProfileStoreOptions,
): BrowserProfileStore {
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  async function ensureDefaultProfile(hostId: string) {
    const paths = profilePaths(
      options.rootDirectory,
      options.installationId,
      hostId,
      DEFAULT_PROFILE_ID,
    );
    await secureProfileNamespace(options, paths);
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
      await readManifest(paths, hostId, options.installationId);
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
      await writeProfile(options, paths, manifest);
    }
    const selectedProfileId = await readSelection(paths.selectionPath);
    if (selectedProfileId === null) {
      await writeSelection(paths.selectionPath, DEFAULT_PROFILE_ID);
    }
  }

  async function listProfilesUnlocked(
    hostId: string,
  ): Promise<BrowserProfileInventory> {
    await ensureDefaultProfile(hostId);
    const defaultPaths = profilePaths(
      options.rootDirectory,
      options.installationId,
      hostId,
      DEFAULT_PROFILE_ID,
    );
    const selectedProfileId =
      (await readSelection(defaultPaths.selectionPath)) ?? DEFAULT_PROFILE_ID;
    const entries = await readdir(defaultPaths.profilesDirectory, {
      withFileTypes: true,
    });
    const profiles = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry) => {
          const parsedProfileId = browserProfileIdSchema.safeParse(entry.name);
          if (!parsedProfileId.success) {
            throw new BrowserProfileError(
              "profile-manifest-corrupt",
              `Browser Profile directory is invalid: ${entry.name}`,
            );
          }
          const manifest = await readManifest(
            profilePaths(
              options.rootDirectory,
              options.installationId,
              hostId,
              parsedProfileId.data,
            ),
            hostId,
            options.installationId,
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
    if (!profiles.some((profile) => profile.profileId === selectedProfileId)) {
      throw new BrowserProfileError(
        "profile-selection-corrupt",
        `Browser Profile selection references a missing profile on host ${hostId}.`,
      );
    }
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
    return withMutationLock(options, hostId, () =>
      listProfilesUnlocked(hostId),
    );
  }

  async function createProfile(
    request: BrowserProfileCreateRequest,
  ): Promise<BrowserProfile> {
    return withMutationLock(options, request.hostId, async () => {
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
        await writeProfile(options, paths, manifest);
      } catch (error) {
        await rm(paths.profileDirectory, { recursive: true, force: true });
        throw error;
      }
      return profileFromManifest(manifest, inventory.selectedProfileId);
    });
  }

  async function renameProfile(
    request: BrowserProfileRenameRequest,
  ): Promise<BrowserProfile> {
    return withMutationLock(options, request.hostId, async () => {
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
      const manifest = await readManifest(
        paths,
        request.hostId,
        options.installationId,
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
      await writeJson(paths.manifestPath, renamed);
      return profileFromManifest(renamed, inventory.selectedProfileId);
    });
  }

  async function selectProfile(
    request: BrowserProfileSelectRequest,
  ): Promise<BrowserProfileInventory> {
    return withMutationLock(options, request.hostId, async () => {
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
      const paths = profilePaths(
        options.rootDirectory,
        options.installationId,
        request.hostId,
        DEFAULT_PROFILE_ID,
      );
      await writeSelection(paths.selectionPath, request.profileId);
      return listProfilesUnlocked(request.hostId);
    });
  }

  return {
    listProfiles,
    createProfile,
    renameProfile,
    selectProfile,
  };
}
