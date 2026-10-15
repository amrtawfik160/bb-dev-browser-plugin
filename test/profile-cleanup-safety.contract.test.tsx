// @vitest-environment jsdom
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../src/host/profile-storage.js";
import {
  createPublicPluginHarness,
  createTabInventoryRuntime,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";

const HOST_ID = "host-browser-test";
const PROJECT_ID = "project-browser-test";
const INSTALLATION_ID = "installation-public-test";
const DAY = 24 * 60 * 60 * 1_000;

/** Set every file and folder in a tree to one modification time. */
async function age(path: string, at: Date) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await age(child, at);
    else await utimes(child, at, at);
  }
  await utimes(path, at, at);
}

/** The identity a browser launch writes into the profile lock it holds. */
async function liveWorkerIdentity() {
  const [stat, commandLine] = await Promise.all([
    readFile(`/proc/${process.pid}/stat`, "utf8"),
    readFile(`/proc/${process.pid}/cmdline`),
  ]);
  return {
    pid: process.pid,
    startedAtTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    commandHash: createHash("sha256").update(commandLine).digest("hex"),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "browser-cleanup-safety-"));
  let onDelete: ((profileId: string) => Promise<void>) | null = null;
  const store = createFileBrowserProfileStore({
    rootDirectory: root,
    installationId: INSTALLATION_ID,
    lifecycle: { stopProfile: async () => {} },
  });
  await store.initialize(HOST_ID);
  // Runs once, right after the first profile is deleted.
  const deleteProfile = store.deleteProfile.bind(store);
  store.deleteProfile = async (request, running) => {
    const response = await deleteProfile(request, running);
    const hook = onDelete;
    onDelete = null;
    if (response.outcome === "deleted") await hook?.(request.profileId);
    return response;
  };
  const runtime = createTabInventoryRuntime();
  const running = new Set<string>();
  runtime.status = async (target) => ({
    state: running.has(target.profileId) ? "running" : "sleeping",
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const browser = await createPublicPluginHarness({
    status: healthyBrowserStatus,
    browserRuntime: runtime,
    sharedProfile: false,
    profileStore: store,
  });
  const paths = (profileId: string) =>
    profileStoragePaths({
      rootDirectory: root,
      installationId: INSTALLATION_ID,
      hostId: HOST_ID,
      profileId,
    });
  /** A worker profile whose files were last written three days ago. */
  async function idleWorker(threadId: string) {
    const profile = await store.ensureScopedProfile({
      hostId: HOST_ID,
      projectId: PROJECT_ID,
      threadId,
    });
    const { profileDirectory, browserDataPath } = paths(profile.profileId);
    await mkdir(join(browserDataPath, "Default"), { recursive: true });
    await writeFile(join(browserDataPath, "Default", "Cookies"), "old");
    await age(profileDirectory, new Date(Date.now() - 3 * DAY));
    return profile.profileId;
  }
  async function exists(profileId: string) {
    const { profiles } = await store.listProfiles(HOST_ID);
    return profiles.some((profile) => profile.profileId === profileId);
  }
  return {
    browser,
    store,
    running,
    paths,
    idleWorker,
    exists,
    afterFirstDelete(hook: (deletedProfileId: string) => Promise<void>) {
      onDelete = hook;
    },
    async dispose() {
      await browser.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("cleanup checks each profile again right before deleting it", () => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** Each change returns work that may finish only after the run. */
  const changes: Record<
    string,
    (f: Fixture, id: string) => Promise<{ settled?: Promise<unknown> } | void>
  > = {
    /** Another thread selects it; the selection is saved before its turn. */
    selected: async (f, id) => {
      const settled = f.browser.selectBrowserProfile(
        { hostId: HOST_ID, profileId: id },
        { projectId: PROJECT_ID, threadId: "thread-selected" },
      );
      // Let the selection reach its turn behind the deletion in progress.
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { settled };
    },
    "signed-in": async (f, id) => {
      await f.store.recordSessionSite({
        hostId: HOST_ID,
        profileId: id,
        origin: "https://mail.example.com",
        status: "signed-in",
        source: "owner-confirmed",
      });
    },
    running: async (f, id) => {
      f.running.add(id);
    },
    used: async (f, id) => {
      await writeFile(
        join(f.paths(id).browserDataPath, "Default", "Cookies"),
        "new sign-in",
      );
    },
  };

  for (const [change, apply] of Object.entries(changes)) {
    it(`keeps a listed profile that became ${change} during the run`, async () => {
      const f = await fixture();
      try {
        const first = await f.idleWorker("thread-a");
        const second = await f.idleWorker("thread-b");
        const plan = await f.browser.browserProfileCleanupPlan();
        expect([...plan.profileIds].sort()).toEqual([first, second].sort());
        let settled: Promise<unknown> | undefined;
        f.afterFirstDelete(async (deleted) => {
          const applied = await apply(f, deleted === first ? second : first);
          settled = applied?.settled;
          settled?.catch(() => {});
        });
        const result = await f.browser.cleanUpBrowserProfiles({
          profileIds: plan.profileIds,
          automatic: false,
        });
        await settled;
        expect(result).toMatchObject({ deleted: 1, skipped: 1 });
        expect(
          (await f.exists(first)) || (await f.exists(second)),
          `the ${change} profile is kept`,
        ).toBe(true);
      } finally {
        await f.dispose();
      }
    });
  }

  it("keeps a profile whose browser launch holds the profile lock", async () => {
    const f = await fixture();
    try {
      const profileId = await f.idleWorker("thread-a");
      const plan = await f.browser.browserProfileCleanupPlan();
      expect(plan.profileIds).toEqual([profileId]);
      const { runtimeManifestPath } = f.paths(profileId);
      await mkdir(join(runtimeManifestPath, ".."), { recursive: true });
      await writeFile(
        `${runtimeManifestPath}.instance.lock`,
        JSON.stringify({ workerIdentity: await liveWorkerIdentity() }),
      );
      const result = await f.browser.cleanUpBrowserProfiles({
        profileIds: plan.profileIds,
        automatic: false,
      });
      expect(result).toMatchObject({ deleted: 0, skipped: 1 });
      expect(await f.exists(profileId)).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});

describe("last use of a worker profile", () => {
  it("counts a write inside an existing browser file", async () => {
    const f = await fixture();
    try {
      const profileId = await f.idleWorker("thread-a");
      await writeFile(
        join(f.paths(profileId).browserDataPath, "Default", "Cookies"),
        "new sign-in",
      );
      const plan = await f.browser.browserProfileCleanupPlan();
      expect(plan.profileIds).not.toContain(profileId);
    } finally {
      await f.dispose();
    }
  });

  it("counts the plugin's recorded browser activity", async () => {
    const f = await fixture();
    try {
      const result = await f.browser.runBrowserScriptWithProfile(undefined, {
        threadId: "thread-browser-test",
        destinationOrigin: "https://example.com",
      });
      expect(result.isError).not.toBe(true);
      const { profiles } = await f.store.listProfiles(HOST_ID);
      const worker = profiles.find(({ profileId }) =>
        profileId.startsWith("bb-thread-"),
      )!;
      await age(
        f.paths(worker.profileId).profileDirectory,
        new Date(Date.now() - 3 * DAY),
      );
      const plan = await f.browser.browserProfileCleanupPlan();
      expect(plan.profileIds).not.toContain(worker.profileId);
    } finally {
      await f.dispose();
    }
  });
});

describe("cleanup runs in the background", () => {
  function within<T>(promise: Promise<T>, ms: number) {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms),
      ),
    ]);
  }

  it("returns at once, reports progress, and runs one job at a time", async () => {
    const f = await fixture();
    let release = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    try {
      await f.idleWorker("thread-a");
      await f.idleWorker("thread-b");
      const plan = await f.browser.browserProfileCleanupPlan();
      f.afterFirstDelete(() => blocked);

      const started = await within(
        f.browser.startBrowserProfileCleanup({
          profileIds: plan.profileIds,
          automatic: false,
        }),
        5_000,
      );
      expect(started.job).toMatchObject({ state: "running", total: 2 });
      const again = await f.browser.startBrowserProfileCleanup({
        profileIds: plan.profileIds,
        automatic: false,
      });
      expect(again.job?.id).toBe(started.job?.id);
      expect((await f.browser.browserProfileCleanupStatus()).job).toMatchObject(
        { id: started.job?.id, state: "running" },
      );

      release();
      await vi.waitFor(
        async () =>
          expect(
            (await f.browser.browserProfileCleanupStatus()).job,
          ).toMatchObject({ state: "finished", deleted: 2, skipped: 0 }),
        { timeout: 5_000 },
      );
    } finally {
      release();
      await f.dispose();
    }
  }, 15_000);

  it("shows the last result when the owner opens the card again", async () => {
    const f = await fixture();
    try {
      await f.idleWorker("thread-a");
      const plan = await f.browser.browserProfileCleanupPlan();
      await f.browser.cleanUpBrowserProfiles({
        profileIds: plan.profileIds,
        automatic: false,
      });
      const settings = f.browser.renderSettings();
      await settings.findByText(/Deleted 1 profile\(s\)\./);
    } finally {
      await f.dispose();
    }
  });
});
