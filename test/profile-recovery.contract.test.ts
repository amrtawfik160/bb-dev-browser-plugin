import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../contracts.js";
import {
  createFileBrowserProfileRecovery,
  type BrowserProfileRecoveryState,
} from "../profile-recovery.js";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../profile-storage.js";

describe("Browser Profile recovery", () => {
  it("requires a stopped profile and restores a credential-equivalent backup", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-recovery-"));
    const archivePath = join(rootDirectory, "profile.bb-backup");
    let profileStopped = false;
    const recoveryState: BrowserProfileRecoveryState = {
      isProfileStopped: async () => profileStopped,
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
        state: { isProfileStopped: async () => true },
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
});
