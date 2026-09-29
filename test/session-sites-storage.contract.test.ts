import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../src/host/profile-storage.js";
import { RESET_PROFILE_CONFIRMATION } from "../src/shared/contracts.js";

describe("host-local sign-in metadata", () => {
  it("persists concurrent confirmations with profile ownership and clears metadata on reset", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "browser-session-sites-"),
    );
    const options = {
      rootDirectory,
      installationId: "session-test",
      lifecycle: { stopProfile: async () => undefined },
    };
    try {
      const store = createFileBrowserProfileStore(options);
      const profile = await store.ensureScopedProfile({
        hostId: "host-a",
        projectId: "project-a",
        threadId: "thread-a",
      });
      const target = { hostId: "host-a", profileId: profile.profileId };
      await Promise.all(
        ["https://Salesforce.com/", "https://github.com"].map((origin) =>
          store.recordSessionSite({
            ...target,
            origin,
            source: "owner-confirmed",
            status: "signed-in",
          }),
        ),
      );
      const restarted = createFileBrowserProfileStore(options);
      const restored = (
        await restarted.listProfiles(target.hostId)
      ).profiles.find((entry) => entry.profileId === profile.profileId)!;
      expect(restored.reusable).toBe(true);
      expect(restored.sites?.map(({ origin }) => origin).sort()).toEqual([
        "https://github.com",
        "https://salesforce.com",
      ]);
      const paths = profileStoragePaths({ ...options, ...target });
      expect((await stat(paths.manifestPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(paths.manifestPath, "utf8")).not.toMatch(
        /cookie|password|token|email/iu,
      );
      const reset = await restarted.resetProfile({
        ...target,
        confirmation: RESET_PROFILE_CONFIRMATION,
      });
      expect(reset.outcome).toBe("reset");
      if (reset.outcome !== "reset") throw new Error("Profile was not reset.");
      expect(reset.profile.sites).toBeUndefined();
      expect(reset.profile.reusable).toBeUndefined();
      await expect(
        store.recordSessionSite({
          ...target,
          origin: "https://github.com",
          source: "agent-verified",
          status: "signed-out",
        }),
      ).rejects.toThrow();
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
