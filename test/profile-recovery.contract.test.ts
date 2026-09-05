import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../src/shared/contracts.js";
import {
  BrowserProfileRecoveryError,
  createFileBrowserProfileRecovery,
  type BrowserProfileRecoveryState,
} from "../src/host/profile-recovery.js";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../src/host/profile-storage.js";

describe("Browser Profile recovery", () => {
  it("requires a stopped profile and restores a credential-equivalent backup", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    let profileStopped = false;
    const recoveryState: BrowserProfileRecoveryState = {
      isProfileStopped: async () => profileStopped,
      isDevBrowserProfileStopped: async () => true,
    };

    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(
        join(profilePaths.browserDataPath, "Cookies"),
        "signed-in",
        {
          mode: 0o600,
        },
      );

      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: recoveryState,
      });

      await expect(
        recovery.backupProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "profile-running" });

      profileStopped = true;
      await expect(
        recovery.backupProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).resolves.toMatchObject({
        outcome: "backed-up",
        credentialEquivalent: true,
      });
      expect((await stat(archivePath)).mode & 0o777).toBe(0o600);

      await writeFile(
        join(profilePaths.browserDataPath, "Cookies"),
        "changed",
        {
          mode: 0o600,
        },
      );
      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).resolves.toMatchObject({ outcome: "restored" });
      await expect(
        readFile(join(profilePaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("signed-in");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a newer backup format before replacing the target profile", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "prior", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });

      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      const archiveContents = await readFile(archivePath, "utf8");
      await writeFile(
        archivePath,
        archiveContents.replace(
          '"version":1,"installationId"',
          '"version":2,"installationId"',
        ),
        { mode: 0o600 },
      );
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "changed", {
        mode: 0o600,
      });

      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-incompatible-version" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("changed");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("rejects a backup with widened permissions before replacing the target", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "prior", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      await chmod(archivePath, 0o644);
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "changed", {
        mode: 0o600,
      });

      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-ownership-invalid" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("changed");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("rejects incompatible encryption before replacing the target", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "prior", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      const archiveContents = await readFile(archivePath, "utf8");
      await writeFile(
        archivePath,
        archiveContents.replace(
          '"encryptionState":"plain"',
          '"encryptionState":"encrypted"',
        ),
        { mode: 0o600 },
      );
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "changed", {
        mode: 0o600,
      });

      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-incompatible-encryption" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("changed");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-03 rejects encrypted staged content even when archive encryption metadata is plain", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(
        join(targetPaths.browserDataPath, "Local State"),
        JSON.stringify({ os_crypt: { encrypted_key: "encrypted" } }),
        { mode: 0o600 },
      );
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      const archiveContents = await readFile(archivePath, "utf8");
      await writeFile(
        archivePath,
        archiveContents.replace(
          '"encryptionState":"encrypted"',
          '"encryptionState":"plain"',
        ),
        { mode: 0o600 },
      );
      const plainLocalState = JSON.stringify({ os_crypt: {} });
      await writeFile(
        join(targetPaths.browserDataPath, "Local State"),
        plainLocalState,
        { mode: 0o600 },
      );

      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-incompatible-encryption" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Local State"), "utf8"),
      ).resolves.toBe(plainLocalState);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-04 checks free space on the backup archive destination filesystem", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    let checkedPath: string | undefined;
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "session", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        disk: {
          freeBytes: async (path) => {
            checkedPath = path;
            return path === rootDirectory ? 1 : 6 * 1024 ** 3;
          },
        },
      });

      await expect(
        recovery.backupProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-insufficient-disk" });
      expect(checkedPath).toBe(rootDirectory);
      await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-04 checks cumulative archive payload size before extracting staged data", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "session", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      const archiveLines = (await readFile(archivePath, "utf8")).split("\n");
      const archiveHeader = JSON.parse(archiveLines[1]!) as {
        totalBytes: number;
      };
      archiveHeader.totalBytes = 0;
      archiveLines[1] = JSON.stringify(archiveHeader);
      await writeFile(archivePath, archiveLines.join("\n"), { mode: 0o600 });
      const plainTargetContents = "changed";
      await writeFile(
        join(targetPaths.browserDataPath, "Cookies"),
        plainTargetContents,
        { mode: 0o600 },
      );
      const restore = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        disk: { freeBytes: async () => 5 * 1024 ** 3 + 1 },
      });

      await expect(
        restore.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-insufficient-disk" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe(plainTargetContents);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("rejects corrupt archive data before replacing the target", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "prior", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      const archiveContents = await readFile(archivePath);
      archiveContents[archiveContents.length - 1] ^= 1;
      await writeFile(archivePath, archiveContents, { mode: 0o600 });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "changed", {
        mode: 0o600,
      });

      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-archive-invalid" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("changed");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("writes deterministic backup bytes for an unchanged stopped profile", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const firstArchivePath = join(rootDirectory, "first.bb-backup");
    const secondArchivePath = join(rootDirectory, "second.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "stable", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });

      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath: firstArchivePath,
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath: secondArchivePath,
      });

      await expect(readFile(secondArchivePath)).resolves.toEqual(
        await readFile(firstArchivePath),
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("imports a stopped dev-browser profile into a new stable profile", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const sourcePath = join(rootDirectory, "dev-browser-default");
    try {
      await mkdir(sourcePath, { recursive: true, mode: 0o700 });
      await writeFile(join(sourcePath, "Cookies"), "source-session", {
        mode: 0o600,
      });
      const sourceBefore = await readFile(join(sourcePath, "Cookies"));
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "imported",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });

      await expect(
        recovery.importDevBrowserProfile({
          hostId: "host-a",
          name: "Imported dev-browser",
          sourcePath,
        }),
      ).resolves.toMatchObject({
        outcome: "imported",
        profileId: "profile-imported",
      });
      await expect(readFile(join(sourcePath, "Cookies"))).resolves.toEqual(
        sourceBefore,
      );
      await expect(
        readFile(
          join(
            profileStoragePaths({
              rootDirectory,
              installationId: "installation-test",
              hostId: "host-a",
              profileId: "profile-imported",
            }).browserDataPath,
            "Cookies",
          ),
        ),
      ).resolves.toEqual(sourceBefore);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("refuses a backup before copying when host free space is insufficient", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(
        join(profilePaths.browserDataPath, "Cookies"),
        "session",
        {
          mode: 0o600,
        },
      );
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        disk: { freeBytes: async () => 1 },
      });

      await expect(
        recovery.backupProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-insufficient-disk" });
      await expect(stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("cleans an interrupted import without changing the source", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const sourcePath = join(rootDirectory, "dev-browser-default");
    try {
      await mkdir(sourcePath, { recursive: true, mode: 0o700 });
      await writeFile(join(sourcePath, "Cookies"), "source-session", {
        mode: 0o600,
      });
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "interrupted",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        copy: {
          copyFile: async () => {
            throw new Error("copy interrupted");
          },
        },
      });

      await expect(
        recovery.importDevBrowserProfile({
          hostId: "host-a",
          name: "Interrupted profile",
          sourcePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-copy-failed" });
      await expect(store.listProfiles("host-a")).resolves.toMatchObject({
        profiles: [expect.objectContaining({ profileId: DEFAULT_PROFILE_ID })],
      });
      await expect(readFile(join(sourcePath, "Cookies"), "utf8")).resolves.toBe(
        "source-session",
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back the prior profile when promotion fails after staging", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    let failPromotion = false;
    try {
      const targetPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      const ownership = {
        ensureOwned: async (path: string) => {
          if (failPromotion && path === targetPaths.profileDirectory) {
            throw new Error("promotion ownership check interrupted");
          }
        },
        verifyOwned: async () => undefined,
      };
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        ownership,
      });
      await store.initialize("host-a");
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "prior", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        ownership,
      });
      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      await writeFile(join(targetPaths.browserDataPath, "Cookies"), "changed", {
        mode: 0o600,
      });
      failPromotion = true;

      await expect(
        recovery.restoreProfile({
          hostId: "host-a",
          profileId: DEFAULT_PROFILE_ID,
          archivePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-copy-failed" });
      await expect(
        readFile(join(targetPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("changed");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("cleans abandoned recovery staging before a later operation", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      const abandonedPath = join(
        profilePaths.hostStoragePath,
        ".recovery-bb-personal-abandoned.tmp",
      );
      await mkdir(abandonedPath, { recursive: true, mode: 0o700 });
      await writeFile(join(abandonedPath, "Cookies"), "orphan", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });

      await recovery.backupProfile({
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      await expect(stat(abandonedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-01 fails closed when the dev-browser stop authority is absent", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const sourcePath = join(rootDirectory, "dev-browser-default");
    try {
      await mkdir(sourcePath, { recursive: true, mode: 0o700 });
      await writeFile(join(sourcePath, "Cookies"), "source-session", {
        mode: 0o600,
      });
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "missing-stop-authority",
        state: {
          isProfileStopped: async () => true,
        } as unknown as BrowserProfileRecoveryState,
      });

      await expect(
        recovery.importDevBrowserProfile({
          hostId: "host-a",
          name: "Unadmitted dev-browser profile",
          sourcePath,
        }),
      ).rejects.toMatchObject({ code: "profile-running" });
      await expect(store.listProfiles("host-a")).resolves.toMatchObject({
        profiles: [expect.objectContaining({ profileId: DEFAULT_PROFILE_ID })],
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-01 rejects an encrypted or overlapping dev-browser source before publication", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const sourcePath = join(rootDirectory, "dev-browser-default");
    try {
      await mkdir(sourcePath, { recursive: true, mode: 0o700 });
      await writeFile(
        join(sourcePath, "Local State"),
        JSON.stringify({ os_crypt: { encrypted_key: "encrypted" } }),
        { mode: 0o600 },
      );
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "incompatible-source",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });

      await expect(
        recovery.importDevBrowserProfile({
          hostId: "host-a",
          name: "Encrypted source",
          sourcePath,
        }),
      ).rejects.toMatchObject({ code: "recovery-incompatible-encryption" });

      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      const sourceEntriesBefore = await readdir(profilePaths.profilesDirectory);
      await expect(
        recovery.importDevBrowserProfile({
          hostId: "host-a",
          name: "Overlapping source",
          sourcePath: profilePaths.profilesDirectory,
        }),
      ).rejects.toMatchObject({ code: "recovery-archive-invalid" });
      await expect(readdir(profilePaths.profilesDirectory)).resolves.toEqual(
        sourceEntriesBefore,
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-02 keeps an imported profile invisible until its data publishes atomically", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const sourcePath = join(rootDirectory, "dev-browser-default");
    let releaseCopy!: () => void;
    let signalCopyStarted!: () => void;
    const copyStarted = new Promise<void>((resolve) => {
      signalCopyStarted = resolve;
    });
    const copyReleased = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    try {
      await mkdir(sourcePath, { recursive: true, mode: 0o700 });
      await writeFile(join(sourcePath, "Cookies"), "source-session", {
        mode: 0o600,
      });
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "atomic-publication",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        copy: {
          copyFile: async (sourceFilePath, targetFilePath) => {
            signalCopyStarted();
            await copyReleased;
            await writeFile(targetFilePath, await readFile(sourceFilePath), {
              mode: 0o600,
            });
          },
        },
      });

      const importOperation = recovery.importDevBrowserProfile({
        hostId: "host-a",
        name: "Atomic imported profile",
        sourcePath,
      });
      await copyStarted;
      const visibleInventory = await store.listProfiles("host-a");
      expect(
        visibleInventory.profiles.some(
          (profile) => profile.name === "Atomic imported profile",
        ),
      ).toBe(false);
      releaseCopy();
      await expect(importOperation).resolves.toMatchObject({
        outcome: "imported",
        profileId: "profile-atomic-publication",
      });
    } finally {
      releaseCopy();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-05 serializes imports so concurrent recovery cannot delete active staging", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const sourceA = join(rootDirectory, "dev-browser-a");
    const sourceB = join(rootDirectory, "dev-browser-b");
    let releaseA!: () => void;
    let releaseB!: () => void;
    let signalA!: () => void;
    let signalB!: () => void;
    const startedA = new Promise<void>((resolve) => {
      signalA = resolve;
    });
    const startedB = new Promise<void>((resolve) => {
      signalB = resolve;
    });
    const copyReleasedA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const copyReleasedB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    try {
      await mkdir(sourceA, { recursive: true, mode: 0o700 });
      await mkdir(sourceB, { recursive: true, mode: 0o700 });
      await writeFile(join(sourceA, "Cookies"), "session-a", { mode: 0o600 });
      await writeFile(join(sourceB, "Cookies"), "session-b", { mode: 0o600 });
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const recoveryA = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "concurrent-a",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        copy: {
          copyFile: async (sourcePath, targetPath) => {
            signalA();
            await copyReleasedA;
            await writeFile(targetPath, await readFile(sourcePath), {
              mode: 0o600,
            });
          },
        },
      });
      const recoveryB = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "concurrent-b",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        copy: {
          copyFile: async (sourcePath, targetPath) => {
            signalB();
            await copyReleasedB;
            await writeFile(targetPath, await readFile(sourcePath), {
              mode: 0o600,
            });
          },
        },
      });

      const importA = recoveryA.importDevBrowserProfile({
        hostId: "host-a",
        name: "Concurrent A",
        sourcePath: sourceA,
      });
      await startedA;
      const importB = recoveryB.importDevBrowserProfile({
        hostId: "host-a",
        name: "Concurrent B",
        sourcePath: sourceB,
      });
      releaseA();
      await expect(importA).resolves.toMatchObject({
        outcome: "imported",
        profileId: "profile-concurrent-a",
      });
      await startedB;
      releaseB();
      await expect(importB).resolves.toMatchObject({
        outcome: "imported",
        profileId: "profile-concurrent-b",
      });
      await expect(store.listProfiles("host-a")).resolves.toMatchObject({
        profiles: expect.arrayContaining([
          expect.objectContaining({ name: "Concurrent A" }),
          expect.objectContaining({ name: "Concurrent B" }),
        ]),
      });
    } finally {
      releaseA();
      releaseB();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-05 cleans abandoned staging when recovery is reconstructed after a restart", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      await store.initialize("host-a");
      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      const abandonedPath = join(
        profilePaths.hostStoragePath,
        ".recovery-import-restarted.tmp",
      );
      await mkdir(abandonedPath, { recursive: true, mode: 0o700 });
      await writeFile(join(abandonedPath, "Cookies"), "orphan", {
        mode: 0o600,
      });
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
      });
      await recovery.ready;
      await expect(stat(abandonedPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-05 removes a lock created before ownership validation fails", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    let lockPath = "";
    const ownershipFailure = new BrowserProfileRecoveryError(
      "recovery-copy-failed",
      "ownership setup failed",
    );
    const ownership = {
      ensureOwned: async (path: string) => {
        if (path === lockPath) throw ownershipFailure;
      },
      verifyOwned: async () => undefined,
    };

    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        ownership,
      });
      await store.initialize("host-a");
      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      lockPath = join(profilePaths.hostStoragePath, ".recovery.lock");
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-test",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        ownership,
      });

      await expect(recovery.ready).rejects.toBe(ownershipFailure);
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
