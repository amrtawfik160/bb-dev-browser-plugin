import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_CLEANUP_IDLE_MS,
  OWNER_CLEANUP_IDLE_MS,
  profileKeepReason,
  type ProfileCleanupFacts,
} from "../src/server/profile-cleanup.js";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../src/host/profile-storage.js";
import type { BrowserProfile } from "../src/shared/contracts.js";
import { scopedProfileId } from "../src/shared/profile-scope.js";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const WORKER_ID = scopedProfileId({ projectId: "project-a", threadId: "t-1" });

function workerProfile(overrides: Partial<BrowserProfile> = {}) {
  return {
    version: 1,
    profileId: WORKER_ID,
    name: `Thread ${WORKER_ID.split("-").at(-1)}`,
    hostId: "host-a",
    installationId: "installation-test",
    locale: "en-US",
    timezone: "UTC",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    startup: {
      initialTabUrl: "about:blank",
      suppressWelcome: true,
      chromeArguments: ["--no-first-run", "--no-default-browser-check"],
    },
    storage: { owner: "bb-browser", directoryMode: "0700", manifestMode: "0600" },
    state: "active",
    archivedAt: null,
    expiresAt: null,
    selected: false,
    ...overrides,
  } as BrowserProfile;
}

function facts(
  overrides: Partial<ProfileCleanupFacts> = {},
): ProfileCleanupFacts {
  return {
    profile: workerProfile(),
    lastUsedAt: NOW - 3 * DAY,
    running: false,
    selected: false,
    ...overrides,
  };
}

const ownerRule = { now: NOW, idleMs: OWNER_CLEANUP_IDLE_MS };

describe("unused worker profile rule", () => {
  it("matches an unrenamed, idle worker profile with no sign-in", () => {
    expect(profileKeepReason(facts(), ownerRule)).toBeNull();
  });

  it("keeps a profile with a signed-in site", () => {
    const profile = workerProfile({
      sites: [
        {
          origin: "https://mail.example.com",
          status: "signed-in",
          source: "owner-confirmed",
          checkedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    expect(profileKeepReason(facts({ profile }), ownerRule)).toBe("signed-in");
  });

  it("does not keep a profile whose only site is signed out", () => {
    const profile = workerProfile({
      sites: [
        {
          origin: "https://mail.example.com",
          status: "signed-out",
          source: "agent-verified",
          checkedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    expect(profileKeepReason(facts({ profile }), ownerRule)).toBeNull();
  });

  it("keeps a saved profile", () => {
    const profile = workerProfile({ reusable: true });
    expect(profileKeepReason(facts({ profile }), ownerRule)).toBe("saved");
  });

  it("keeps a selected profile", () => {
    expect(profileKeepReason(facts({ selected: true }), ownerRule)).toBe(
      "selected",
    );
    const hostSelected = workerProfile({ selected: true });
    expect(profileKeepReason(facts({ profile: hostSelected }), ownerRule)).toBe(
      "selected",
    );
  });

  it("keeps a profile with a running browser", () => {
    expect(profileKeepReason(facts({ running: true }), ownerRule)).toBe(
      "running",
    );
  });

  it("keeps a profile used within the idle period", () => {
    expect(
      profileKeepReason(facts({ lastUsedAt: NOW - 23 * 60 * 60 * 1_000 }), ownerRule),
    ).toBe("recent");
    expect(
      profileKeepReason(facts({ lastUsedAt: NOW - 1.5 * DAY }), {
        now: NOW,
        idleMs: AUTOMATIC_CLEANUP_IDLE_MS,
      }),
    ).toBe("recent");
  });

  it("keeps a worker profile the owner renamed", () => {
    const profile = workerProfile({ name: "Bank login" });
    expect(profileKeepReason(facts({ profile }), ownerRule)).toBe("named");
  });

  it("keeps profiles that are not worker profiles", () => {
    for (const profileId of [
      "bb-personal",
      scopedProfileId({ projectId: "project-a" }),
      "work",
    ]) {
      const profile = workerProfile({ profileId, name: "Thread x" });
      expect(profileKeepReason(facts({ profile }), ownerRule)).toBe(
        "not-worker",
      );
    }
  });

  it("keeps an already archived profile", () => {
    const profile = workerProfile({
      state: "archived",
      archivedAt: "2026-10-10T00:00:00.000Z",
      expiresAt: "2026-11-09T00:00:00.000Z",
    } as Partial<BrowserProfile>);
    expect(profileKeepReason(facts({ profile }), ownerRule)).toBe("archived");
  });
});

describe("host profile usage", () => {
  it("reports the newest browser-data change and the size on disk", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-usage-"));
    const store = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-test",
      lifecycle: { stopProfile: async () => undefined },
    });
    await store.initialize("host-a");
    const profile = await store.ensureScopedProfile({
      hostId: "host-a",
      projectId: "project-a",
      threadId: "t-1",
    });
    const paths = profileStoragePaths({
      rootDirectory,
      installationId: "installation-test",
      hostId: "host-a",
      profileId: profile.profileId,
    });
    await writeFile(join(paths.browserDataPath, "Cookies"), "x".repeat(5_000));
    const old = new Date(NOW - 5 * DAY);
    await utimes(paths.profileDirectory, old, old);
    await utimes(paths.browserDataPath, old, old);

    const [usage] = await store.profileUsage("host-a", [profile.profileId], {
      measureSize: true,
    });
    expect(usage).toMatchObject({ profileId: profile.profileId });
    expect(Date.parse(usage!.lastUsedAt)).toBe(old.getTime());
    expect(usage!.sizeBytes).toBeGreaterThanOrEqual(5_000);

    const [unmeasured] = await store.profileUsage(
      "host-a",
      [profile.profileId],
      { measureSize: false },
    );
    expect(unmeasured!.sizeBytes).toBeNull();
  });
});
