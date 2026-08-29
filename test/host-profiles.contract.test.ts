import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupRequiredStatus, DEFAULT_PROFILE_ID } from "../contracts.js";
import { createBrowserHostEntry } from "../host.js";
import { createFileBrowserProfileStore } from "../profile-storage.js";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

describe("Browser Profile host boundary", () => {
  it("R5-01 keeps profile storage read-only and blocks mutations before setup", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-host-"));
    const hostId = "host-a";
    const readiness = {
      inspect: () =>
        setupRequiredStatus({ hostId, profileId: DEFAULT_PROFILE_ID }),
      diagnostics: () => ({
        hostId,
        profileId: DEFAULT_PROFILE_ID,
        generatedAt: "2026-08-27T00:00:00.000Z",
        readiness: setupRequiredStatus({
          hostId,
          profileId: DEFAULT_PROFILE_ID,
        }),
        dependencies: [],
        processes: [],
        resourceUse: { diskFreeBytes: 0, diskTotalBytes: 0, workerRssBytes: 0 },
        exitLogs: [],
      }),
    };
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-test",
    });
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(readiness, profileStore),
    );

    try {
      await expect(
        host.experimental_call("listProfiles", { hostId }),
      ).resolves.toMatchObject({
        profiles: [],
      });
      await expect(
        host.experimental_call("createProfile", {
          hostId,
          name: "Must wait for setup",
        }),
      ).rejects.toThrow("setup");
      await expect(readdir(rootDirectory)).resolves.toEqual([]);
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("exposes profile metadata and selection without exposing browser contents", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-host-"));
    const hostId = "host-a";
    const readinessStatus = setupRequiredStatus({
      hostId,
      profileId: DEFAULT_PROFILE_ID,
    });
    const readiness = {
      inspect: () => ({
        ...readinessStatus,
        state: "healthy" as const,
        code: "healthy" as const,
        label: "Ready" as const,
        message: "Workspace Browser is ready on this host.",
        capabilities: readinessStatus.capabilities.map((capability) => ({
          ...capability,
          status: "ready" as const,
        })),
      }),
      diagnostics: () => ({
        hostId,
        profileId: DEFAULT_PROFILE_ID,
        generatedAt: "2026-08-27T00:00:00.000Z",
        readiness: {
          ...readinessStatus,
          state: "healthy" as const,
          code: "healthy" as const,
          label: "Ready" as const,
          message: "Workspace Browser is ready on this host.",
          capabilities: readinessStatus.capabilities.map((capability) => ({
            ...capability,
            status: "ready" as const,
          })),
        },
        dependencies: [],
        processes: [],
        resourceUse: { diskFreeBytes: 0, diskTotalBytes: 0, workerRssBytes: 0 },
        exitLogs: [],
      }),
    };
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-test",
    });
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(readiness, profileStore),
    );

    try {
      const initial = await host.experimental_call("listProfiles", { hostId });
      const created = await host.experimental_call("createProfile", {
        hostId,
        name: "Work",
        locale: "en-GB",
        timezone: "Europe/London",
      });
      const selected = await host.experimental_call("selectProfile", {
        hostId,
        profileId: created.profileId,
      });

      expect(initial.selectedProfileId).toBe(DEFAULT_PROFILE_ID);
      expect(created.name).toBe("Work");
      expect(selected.selectedProfileId).toBe(created.profileId);
      expect(JSON.stringify(selected)).not.toMatch(
        /cookies|chrome-data|password/i,
      );
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
