import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID, PROFILE_MANIFEST_VERSION } from "../contracts.js";
import {
  createProfileStorageOwnershipBoundary,
  createBrowserUserProfileOwnershipBoundary,
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../profile-storage.js";

describe("host-local Browser Profile storage", () => {
  it("lists an uninitialized host without creating Browser Profile storage", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });

      await expect(store.listProfiles("host-a")).resolves.toEqual({
        hostId: "host-a",
        installationId: "installation-test",
        selectedProfileId: DEFAULT_PROFILE_ID,
        profiles: [],
      });
      await expect(readdir(rootDirectory)).resolves.toEqual([]);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R5-01 does not repair initialized storage during inventory reads", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    const ownershipCalls: string[] = [];
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        ownership: {
          ensureOwned: async (path) => {
            ownershipCalls.push(path);
          },
          verifyOwned: async () => undefined,
        },
      });

      await store.initialize!("host-a");
      ownershipCalls.length = 0;
      await store.listProfiles("host-a");

      expect(ownershipCalls).toEqual([]);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R5-01 does not expose a profile directory before its manifest is ready", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    const knownOwnedPaths = new Set<string>();
    let profileCreationStarted = false;
    let newProfileDirectoryReady!: () => void;
    let releaseProfileCreation!: () => void;
    const newProfileDirectoryReadyPromise = new Promise<void>((resolve) => {
      newProfileDirectoryReady = resolve;
    });
    const profileCreationReleased = new Promise<void>((resolve) => {
      releaseProfileCreation = resolve;
    });
    const store = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-test",
      idFactory: () => "race",
      ownership: {
        ensureOwned: async (path) => {
          if (!profileCreationStarted) {
            knownOwnedPaths.add(path);
          } else if (!knownOwnedPaths.has(path)) {
            newProfileDirectoryReady();
            await profileCreationReleased;
          }
        },
        verifyOwned: async () => undefined,
      },
    });

    try {
      await store.initialize("host-a");
      profileCreationStarted = true;
      const creating = store.createProfile({
        hostId: "host-a",
        name: "Racing profile",
      });
      await newProfileDirectoryReadyPromise;

      const inventory = await store.listProfiles("host-a");
      expect(inventory.profiles.map((profile) => profile.profileId)).toEqual([
        DEFAULT_PROFILE_ID,
      ]);
      releaseProfileCreation();
      await expect(creating).resolves.toMatchObject({
        profileId: "profile-race",
      });
    } finally {
      releaseProfileCreation();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("creates profile storage with the configured browser-user ownership", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const owner = {
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
      };
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        ownership: createProfileStorageOwnershipBoundary(owner, {
          chown: async () => undefined,
          inspect: async (path) => {
            const metadata = await stat(path);
            return {
              uid: metadata.uid,
              gid: metadata.gid,
              mode: metadata.mode,
            };
          },
        }),
      });

      const created = await store.createProfile({
        hostId: "host-a",
        name: "Owned profile",
      });

      const paths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: created.profileId,
      });
      const entries = [
        rootDirectory,
        join(rootDirectory, "installations"),
        join(rootDirectory, "installations", "installation-test"),
        join(rootDirectory, "installations", "installation-test", "hosts"),
        paths.hostStoragePath,
        paths.profilesDirectory,
        paths.profileDirectory,
        paths.browserDataPath,
        paths.manifestPath,
      ];

      for (const path of entries) {
        const metadata = await stat(path);
        expect({ uid: metadata.uid, gid: metadata.gid }).toEqual(owner);
      }
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R5-02 resolves bb-browser ownership through a safe host boundary", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    const passwdPath = join(rootDirectory, "passwd");
    const ownershipCalls: Array<{ path: string; uid: number; gid: number }> =
      [];
    try {
      await writeFile(
        passwdPath,
        "bb-browser:x:1001:1002:Browser:/var/lib/bb-browser:/usr/sbin/nologin\n",
      );
      const ownership = createBrowserUserProfileOwnershipBoundary({
        passwdPath,
        operations: {
          async chown(path, uid, gid) {
            ownershipCalls.push({ path, uid, gid });
          },
          async inspect(path) {
            const metadata = await stat(path);
            return { uid: 1001, gid: 1002, mode: metadata.mode };
          },
        },
      });
      const store = createFileBrowserProfileStore({
        rootDirectory: join(rootDirectory, "storage"),
        installationId: "installation-test",
        ownership,
      });

      await store.createProfile({ hostId: "host-a", name: "Safe owner" });

      expect(ownershipCalls.length).toBeGreaterThan(0);
      expect(
        new Set(ownershipCalls.map(({ uid, gid }) => `${uid}:${gid}`)),
      ).toEqual(new Set(["1001:1002"]));
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("creates bb-personal with stable clean-start metadata after initialization", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        clock: () => new Date("2026-08-27T00:00:00.000Z"),
      });

      await store.initialize!("host-a");
      const inventory = await store.listProfiles("host-a");
      const personal = inventory.profiles.find(
        (profile) => profile.profileId === DEFAULT_PROFILE_ID,
      );

      expect(inventory.selectedProfileId).toBe(DEFAULT_PROFILE_ID);
      expect(personal).toMatchObject({
        profileId: DEFAULT_PROFILE_ID,
        name: "bb-personal",
        hostId: "host-a",
        installationId: "installation-test",
        locale: "en-US",
        timezone: "UTC",
        selected: true,
        state: "active",
        startup: {
          initialTabUrl: "about:blank",
          suppressWelcome: true,
          chromeArguments: ["--no-first-run", "--no-default-browser-check"],
        },
        storage: {
          owner: "bb-browser",
          directoryMode: "0700",
          manifestMode: "0600",
        },
      });

      const paths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));

      expect(manifest.version).toBe(PROFILE_MANIFEST_VERSION);
      expect(paths.profileDirectory).not.toContain("dev-browser");
      expect((await stat(paths.profileDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.browserDataPath)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.manifestPath)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(join(rootDirectory, "installations"))).mode & 0o777,
      ).toBe(0o700);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("creates, renames, selects, and lists profiles without allowing name conflicts", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "work-profile",
        clock: () => new Date("2026-08-27T00:00:00.000Z"),
      });

      const created = await store.createProfile({
        hostId: "host-a",
        name: "Work",
        locale: "fr-FR",
        timezone: "Europe/Paris",
      });
      expect(created).toMatchObject({
        profileId: "profile-work-profile",
        name: "Work",
        locale: "fr-FR",
        timezone: "Europe/Paris",
        selected: false,
      });

      const renamed = await store.renameProfile({
        hostId: "host-a",
        profileId: created.profileId,
        name: "Work laptop",
        locale: "en-GB",
        timezone: "Europe/London",
      });
      expect(renamed).toMatchObject({
        name: "Work laptop",
        locale: "en-GB",
        timezone: "Europe/London",
      });

      await expect(
        store.createProfile({ hostId: "host-a", name: "work laptop" }),
      ).rejects.toMatchObject({
        code: "profile-name-conflict",
      });

      const selected = await store.selectProfile({
        hostId: "host-a",
        profileId: created.profileId,
      });
      expect(selected.selectedProfileId).toBe(created.profileId);
      expect(
        selected.profiles.find(
          (profile) => profile.profileId === created.profileId,
        )?.selected,
      ).toBe(true);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing profile when an internal id collides", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "same-id",
      });

      await store.createProfile({ hostId: "host-a", name: "First" });
      await expect(
        store.createProfile({ hostId: "host-a", name: "Second" }),
      ).rejects.toMatchObject({ code: "profile-id-conflict" });

      await expect(store.listProfiles("host-a")).resolves.toMatchObject({
        profiles: expect.arrayContaining([
          expect.objectContaining({ name: "First" }),
        ]),
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("keeps hosts separate and serializes concurrent name creation", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const hostA = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "host-a-profile",
      });
      const hostB = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "host-b-profile",
      });

      await hostA.createProfile({ hostId: "host-a", name: "Only A" });
      await hostB.initialize!("host-b");
      const hostBProfiles = await hostB.listProfiles("host-b");
      expect(hostBProfiles.profiles.map((profile) => profile.name)).toEqual([
        DEFAULT_PROFILE_ID,
      ]);

      const firstStore = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "first",
      });
      const secondStore = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        idFactory: () => "second",
      });
      const outcomes = await Promise.allSettled([
        firstStore.createProfile({ hostId: "host-b", name: "Concurrent" }),
        secondStore.createProfile({ hostId: "host-b", name: "Concurrent" }),
      ]);

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.status === "rejected"),
      ).toHaveLength(1);
      const finalInventory = await hostB.listProfiles("host-b");
      expect(
        finalInventory.profiles.filter(
          (profile) => profile.name === "Concurrent",
        ),
      ).toHaveLength(1);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("migrates legacy manifests with a backup and rejects corrupt manifests", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
        clock: () => new Date("2026-08-27T00:00:00.000Z"),
      });
      const legacyPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: "legacy",
      });
      await mkdir(legacyPaths.profileDirectory, { recursive: true });
      await writeFile(
        legacyPaths.manifestPath,
        JSON.stringify({
          version: 0,
          profileId: "legacy",
          name: "Legacy",
          hostId: "host-a",
          installationId: "installation-test",
          locale: "de-DE",
          timezone: "Europe/Berlin",
          createdAt: "2026-08-26T00:00:00.000Z",
          updatedAt: "2026-08-26T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );

      await store.initialize!("host-a");
      const migrated = await store.listProfiles("host-a");
      expect(
        migrated.profiles.find((profile) => profile.profileId === "legacy"),
      ).toMatchObject({
        name: "Legacy",
        locale: "de-DE",
        timezone: "Europe/Berlin",
        startup: { initialTabUrl: "about:blank", suppressWelcome: true },
      });
      expect(
        JSON.parse(await readFile(legacyPaths.manifestPath, "utf8")),
      ).toMatchObject({ version: PROFILE_MANIFEST_VERSION });
      expect(
        JSON.parse(await readFile(legacyPaths.manifestBackupPath, "utf8")),
      ).toMatchObject({ version: 0, profileId: "legacy" });

      const corruptPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(corruptPaths.manifestPath, "{not-json", {
        encoding: "utf8",
        mode: 0o600,
      });
      await expect(store.listProfiles("host-a")).rejects.toMatchObject({
        code: "profile-manifest-corrupt",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("rejects locale and timezone values that the host cannot apply", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });

      await expect(
        store.createProfile({
          hostId: "host-a",
          name: "Invalid locale",
          locale: "not a locale",
        }),
      ).rejects.toMatchObject({
        code: "profile-settings-invalid",
      });
      await expect(
        store.createProfile({
          hostId: "host-a",
          name: "Invalid timezone",
          timezone: "Mars/Base",
        }),
      ).rejects.toMatchObject({
        code: "profile-settings-invalid",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R5-03 ignores legacy host-global selection state", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-profile-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-test",
      });
      const paths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-test",
        hostId: "host-a",
        profileId: DEFAULT_PROFILE_ID,
      });

      await store.initialize!("host-a");
      const created = await store.createProfile({
        hostId: "host-a",
        name: "Project profile",
      });
      await writeFile(
        paths.selectionPath,
        JSON.stringify({
          version: PROFILE_MANIFEST_VERSION,
          selectedProfileId: "missing",
        }),
        { encoding: "utf8", mode: 0o600 },
      );

      await expect(store.listProfiles("host-a")).resolves.toMatchObject({
        selectedProfileId: DEFAULT_PROFILE_ID,
      });
      await expect(
        store.selectProfile({ hostId: "host-a", profileId: created.profileId }),
      ).resolves.toMatchObject({ selectedProfileId: created.profileId });
      await expect(store.listProfiles("host-a")).resolves.toMatchObject({
        selectedProfileId: DEFAULT_PROFILE_ID,
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
