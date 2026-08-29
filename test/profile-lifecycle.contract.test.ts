import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESET_PROFILE_CONFIRMATION,
  type BrowserProfileLifecycleProgress,
} from "../contracts.js";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../profile-storage.js";

const RETENTION_START = new Date("2026-08-28T00:00:00.000Z");
const AFTER_RETENTION = new Date("2026-09-27T00:00:00.001Z");

async function profileFixture(options?: {
  installationId?: string;
  clock?: () => Date;
  stopProfile?: (hostId: string, profileId: string) => Promise<void>;
  reportProgress?: (
    progress: BrowserProfileLifecycleProgress,
  ) => void | Promise<void>;
}) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-lifecycle-"));
  const installationId = options?.installationId ?? "installation-test";
  const store = createFileBrowserProfileStore({
    rootDirectory,
    installationId,
    clock: options?.clock ?? (() => RETENTION_START),
    lifecycle: {
      stopProfile: options?.stopProfile ?? (async () => undefined),
      reportProgress: options?.reportProgress,
    },
  });
  await store.initialize("host-a");
  const profile = await store.createProfile({ hostId: "host-a", name: "Work" });
  const paths = profileStoragePaths({
    rootDirectory,
    installationId,
    hostId: "host-a",
    profileId: profile.profileId,
  });
  await writeFile(join(paths.browserDataPath, "Cookies"), "signed-in");
  await mkdir(paths.downloadsDirectory, { recursive: true });
  await writeFile(join(paths.downloadsDirectory, "report.pdf"), "quarantine");
  await mkdir(paths.runtimeManifestsDirectory, { recursive: true });
  await writeFile(paths.runtimeManifestPath, "runtime");
  return { rootDirectory, installationId, store, profile, paths };
}

describe("Browser Profile destructive lifecycle", () => {
  it("stops an active instance and retains a grant-free Archived Profile for exactly 30 days", async () => {
    const stopped: string[] = [];
    const fixture = await profileFixture({
      stopProfile: async (_hostId, profileId) => void stopped.push(profileId),
    });
    try {
      const archived = await fixture.store.archiveProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
      });

      expect(stopped).toEqual([fixture.profile.profileId]);
      expect(archived).toMatchObject({
        outcome: "archived",
        profile: {
          profileId: fixture.profile.profileId,
          state: "archived",
          archivedAt: "2026-08-28T00:00:00.000Z",
          expiresAt: "2026-09-27T00:00:00.000Z",
        },
      });
      await expect(
        readFile(join(fixture.paths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("signed-in");

      const restored = await fixture.store.restoreArchivedProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
      });
      expect(restored).toMatchObject({
        outcome: "restored",
        profile: { state: "active" },
      });
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("expires Archived Profiles after 30 days and removes only their installation-scoped artifacts", async () => {
    let now = RETENTION_START;
    const fixture = await profileFixture({ clock: () => now });
    try {
      const retainedProfile = await fixture.store.createProfile({
        hostId: "host-a",
        name: "Retained",
      });
      const retainedPaths = profileStoragePaths({
        rootDirectory: fixture.rootDirectory,
        installationId: fixture.installationId,
        hostId: "host-a",
        profileId: retainedProfile.profileId,
      });
      await writeFile(join(retainedPaths.browserDataPath, "Cookies"), "keep");
      const otherInstallation = join(
        fixture.rootDirectory,
        "installations",
        "installation-other",
        "hosts",
        "unrelated",
      );
      await mkdir(otherInstallation, { recursive: true });
      await writeFile(join(otherInstallation, "keep"), "safe");
      await fixture.store.archiveProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
      });

      now = new Date("2026-09-27T00:00:00.000Z");
      await expect(
        fixture.store.expireArchivedProfiles("host-a"),
      ).resolves.toEqual({
        deletedProfileIds: [],
      });
      now = AFTER_RETENTION;
      await expect(
        fixture.store.restoreArchivedProfile({
          hostId: "host-a",
          profileId: fixture.profile.profileId,
        }),
      ).rejects.toMatchObject({ code: "profile-archive-expired" });
      const expired = await fixture.store.expireArchivedProfiles("host-a");

      expect(expired.deletedProfileIds).toEqual([fixture.profile.profileId]);
      await expect(
        readdir(fixture.paths.profileDirectory),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readdir(fixture.paths.downloadsDirectory),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(fixture.paths.runtimeManifestPath, "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(otherInstallation, "keep"), "utf8"),
      ).resolves.toBe("safe");
      await expect(
        readFile(join(retainedPaths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("keep");
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("R10-04 reset archives the old identity and creates a fresh selected identity with preserved logical settings", async () => {
    const fixture = await profileFixture();
    try {
      await fixture.store.renameProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
        name: "Work laptop",
        locale: "fr-FR",
        timezone: "Europe/Paris",
      });
      await expect(
        fixture.store.resetProfile({
          hostId: "host-a",
          profileId: fixture.profile.profileId,
          confirmation: "reset",
        }),
      ).rejects.toMatchObject({ code: "profile-confirmation-required" });

      const reset = await fixture.store.resetProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
        confirmation: RESET_PROFILE_CONFIRMATION,
      });

      expect(reset).toMatchObject({
        outcome: "reset",
        profile: {
          name: "Work laptop",
          locale: "fr-FR",
          timezone: "Europe/Paris",
          state: "active",
        },
      });
      if (!("profile" in reset)) throw new Error("Expected reset profile.");
      expect(reset.profile.profileId).not.toBe(fixture.profile.profileId);
      const inventory = await fixture.store.listProfiles("host-a");
      expect(
        inventory.profiles.find(
          ({ profileId }) => profileId === fixture.profile.profileId,
        ),
      ).toMatchObject({ state: "archived", name: "Work laptop" });
      const replacementPaths = profileStoragePaths({
        rootDirectory: fixture.rootDirectory,
        installationId: fixture.installationId,
        hostId: "host-a",
        profileId: reset.profile.profileId,
      });
      expect(await readdir(replacementPaths.browserDataPath)).toEqual([]);
      await expect(
        readFile(join(fixture.paths.browserDataPath, "Cookies"), "utf8"),
      ).resolves.toBe("signed-in");
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("R10-06 refuses an interrupted restore when journal replay occurs after archive expiry", async () => {
    let now = RETENTION_START;
    let interruptRestore = false;
    const fixture = await profileFixture({
      clock: () => now,
      reportProgress: ({ phase }) => {
        if (phase === "updating-storage" && interruptRestore) {
          interruptRestore = false;
          throw new Error("simulated restore interruption");
        }
      },
    });
    try {
      await fixture.store.archiveProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
      });
      interruptRestore = true;
      await expect(
        fixture.store.restoreArchivedProfile({
          hostId: "host-a",
          profileId: fixture.profile.profileId,
        }),
      ).rejects.toThrow("simulated restore interruption");

      now = AFTER_RETENTION;
      const restarted = createFileBrowserProfileStore({
        rootDirectory: fixture.rootDirectory,
        installationId: fixture.installationId,
        clock: () => now,
        lifecycle: { stopProfile: async () => undefined },
      });
      await restarted.reconcileProfileLifecycle("host-a");
      const inventory = await restarted.listProfiles("host-a");
      expect(
        inventory.profiles.find(
          ({ profileId }) => profileId === fixture.profile.profileId,
        ),
      ).toMatchObject({ state: "archived" });
      await expect(
        readFile(fixture.paths.lifecycleJournalPath),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("R10-07 rejects archived reset before journaling and clears a legacy invalid reset journal", async () => {
    const fixture = await profileFixture();
    try {
      await fixture.store.archiveProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
      });
      await expect(
        fixture.store.resetProfile({
          hostId: "host-a",
          profileId: fixture.profile.profileId,
          confirmation: RESET_PROFILE_CONFIRMATION,
        }),
      ).rejects.toThrow("Restore the Archived Profile before resetting it");
      await expect(
        readFile(fixture.paths.lifecycleJournalPath),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await mkdir(fixture.paths.lifecycleDirectory, { recursive: true });
      await writeFile(
        fixture.paths.lifecycleJournalPath,
        JSON.stringify({
          operation: "reset",
          hostId: "host-a",
          profileId: fixture.profile.profileId,
          startedAt: RETENTION_START.toISOString(),
          phase: "stopped",
        }),
      );
      await fixture.store.reconcileProfileLifecycle("host-a");
      await expect(
        readFile(fixture.paths.lifecycleJournalPath),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("requires the exact profile name for permanent deletion and protects the current default", async () => {
    const fixture = await profileFixture();
    try {
      await expect(
        fixture.store.deleteProfile({
          hostId: "host-a",
          profileId: fixture.profile.profileId,
          confirmation: "work",
          defaultProfileId: fixture.profile.profileId,
        }),
      ).rejects.toMatchObject({ code: "profile-confirmation-required" });
      await expect(
        fixture.store.deleteProfile({
          hostId: "host-a",
          profileId: fixture.profile.profileId,
          confirmation: "Work",
          defaultProfileId: fixture.profile.profileId,
        }),
      ).rejects.toMatchObject({ code: "profile-default-protected" });

      await expect(
        Promise.all([
          fixture.store.deleteProfile({
            hostId: "host-a",
            profileId: fixture.profile.profileId,
            confirmation: "Work",
            defaultProfileId: "bb-personal",
          }),
          fixture.store.deleteProfile({
            hostId: "host-a",
            profileId: fixture.profile.profileId,
            confirmation: "Work",
            defaultProfileId: "bb-personal",
          }),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ outcome: "deleted" }),
        expect.objectContaining({ outcome: "already-deleted" }),
      ]);
      await expect(
        readdir(fixture.paths.downloadsDirectory),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(fixture.paths.runtimeManifestPath),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles an interrupted archive before a restarted store can expose the profile as active", async () => {
    let releaseStopped!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStopped = resolve;
    });
    let crashOnce = true;
    const fixture = await profileFixture({
      stopProfile: async () => stopped,
      reportProgress: ({ phase }) => {
        if (phase === "updating-storage" && crashOnce) {
          crashOnce = false;
          throw new Error("simulated worker crash");
        }
      },
    });
    try {
      const archive = fixture.store.archiveProfile({
        hostId: "host-a",
        profileId: fixture.profile.profileId,
      });
      releaseStopped();
      await expect(archive).rejects.toThrow("simulated worker crash");
      const lockDirectory = join(fixture.rootDirectory, ".locks");
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        join(lockDirectory, `${fixture.installationId}-host-a.lock`),
        JSON.stringify({ pid: 2_147_483_647 }),
      );

      const restarted = createFileBrowserProfileStore({
        rootDirectory: fixture.rootDirectory,
        installationId: fixture.installationId,
        clock: () => RETENTION_START,
        lifecycle: { stopProfile: async () => undefined },
      });
      await restarted.reconcileProfileLifecycle("host-a");
      const inventory = await restarted.listProfiles("host-a");
      expect(
        inventory.profiles.find(
          ({ profileId }) => profileId === fixture.profile.profileId,
        ),
      ).toMatchObject({ state: "archived" });
    } finally {
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it.each(["restore", "reset", "delete"] as const)(
    "reconciles an interrupted %s without leaving profile storage half-changed",
    async (operation) => {
      let crashEnabled = false;
      const fixture = await profileFixture({
        reportProgress: ({ phase }) => {
          if (phase === "updating-storage" && crashEnabled) {
            crashEnabled = false;
            throw new Error("simulated worker crash");
          }
        },
      });
      try {
        if (operation === "restore") {
          await fixture.store.archiveProfile({
            hostId: "host-a",
            profileId: fixture.profile.profileId,
          });
        }
        crashEnabled = true;
        const interrupted =
          operation === "restore"
            ? fixture.store.restoreArchivedProfile({
                hostId: "host-a",
                profileId: fixture.profile.profileId,
              })
            : operation === "reset"
              ? fixture.store.resetProfile({
                  hostId: "host-a",
                  profileId: fixture.profile.profileId,
                  confirmation: RESET_PROFILE_CONFIRMATION,
                })
              : fixture.store.deleteProfile({
                  hostId: "host-a",
                  profileId: fixture.profile.profileId,
                  confirmation: fixture.profile.name,
                  defaultProfileId: "bb-personal",
                });
        await expect(interrupted).rejects.toThrow("simulated worker crash");

        const restarted = createFileBrowserProfileStore({
          rootDirectory: fixture.rootDirectory,
          installationId: fixture.installationId,
          lifecycle: { stopProfile: async () => undefined },
        });
        await restarted.reconcileProfileLifecycle("host-a");
        const inventory = await restarted.listProfiles("host-a");
        const reconciled = inventory.profiles.find(
          ({ profileId }) => profileId === fixture.profile.profileId,
        );
        if (operation === "restore") {
          expect(reconciled).toMatchObject({ state: "active" });
        }
        if (operation === "reset") {
          expect(reconciled).toMatchObject({ state: "archived" });
          const replacement = inventory.profiles.find(
            ({ profileId, state, name }) =>
              profileId !== fixture.profile.profileId &&
              state === "active" &&
              name === fixture.profile.name,
          );
          expect(replacement).toMatchObject({
            state: "active",
            name: fixture.profile.name,
          });
        }
        if (operation === "delete") {
          expect(reconciled).toBeUndefined();
        }
      } finally {
        await rm(fixture.rootDirectory, { recursive: true, force: true });
      }
    },
  );
});
