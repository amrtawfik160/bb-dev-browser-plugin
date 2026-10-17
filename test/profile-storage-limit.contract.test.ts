import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
  REBUILDABLE_DATA_PATHS,
  removeRebuildableData,
} from "../src/host/profile-storage.js";

const NOW = new Date("2026-10-17T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
const KB = 1024;

/** Site authentication and storage; never Rebuildable Data. */
const SITE_STATE = [
  "Default/Cookies",
  "Default/Login Data",
  "Default/Preferences",
  "Default/History",
  "Default/Local Storage/leveldb/000003.log",
  "Default/IndexedDB/https_example.com_0.indexeddb.leveldb/000003.log",
  "Default/Session Storage/000003.log",
  "Default/Service Worker/Database/000003.log",
  "Local State",
] as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeSized(path: string, bytes: number) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "x".repeat(bytes));
}

/** A profile's chrome-data with site state and every rebuildable path. */
async function fillBrowserData(browserDataPath: string, rebuildableKb = 64) {
  for (const path of SITE_STATE) {
    await writeSized(join(browserDataPath, path), 4 * KB);
  }
  for (const path of REBUILDABLE_DATA_PATHS) {
    await writeSized(join(browserDataPath, path, "data"), rebuildableKb * KB);
  }
}

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function setTreeTime(path: string, at: Date) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await setTreeTime(child, at);
    else if (!entry.isSymbolicLink()) await utimes(child, at, at);
  }
  await utimes(path, at, at);
}

async function storeFixture(clock: () => Date = () => NOW) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-limit-"));
  roots.push(rootDirectory);
  const store = createFileBrowserProfileStore({
    rootDirectory,
    installationId: "installation-test",
    clock,
    lifecycle: { stopProfile: async () => undefined },
  });
  await store.initialize("host-a");
  const paths = (profileId: string) =>
    profileStoragePaths({
      rootDirectory,
      installationId: "installation-test",
      hostId: "host-a",
      profileId,
    });
  async function profile(name: string, lastUsedDaysAgo: number) {
    const created = await store.createProfile({ hostId: "host-a", name });
    await fillBrowserData(paths(created.profileId).browserDataPath);
    await setTreeTime(
      paths(created.profileId).profileDirectory,
      new Date(NOW.getTime() - lastUsedDaysAgo * DAY),
    );
    return created.profileId;
  }
  return { rootDirectory, store, paths, profile };
}

async function siteStateIntact(browserDataPath: string) {
  for (const path of SITE_STATE) {
    expect(await exists(join(browserDataPath, path)), path).toBe(true);
  }
}

describe("Rebuildable Data", () => {
  it("lists only browser-recreated paths, never site authentication or storage", () => {
    for (const path of REBUILDABLE_DATA_PATHS) {
      expect(path).not.toMatch(
        /Cookies|Local Storage|IndexedDB|Login Data|Session Storage|Preferences|History|Local State/u,
      );
      expect(path.split("/")).not.toContain("..");
    }
    expect(REBUILDABLE_DATA_PATHS).toEqual(
      expect.arrayContaining([
        "optimization_guide_model_store",
        "Safe Browsing",
        "Default/Cache",
        "Default/Code Cache",
        "Default/Service Worker/CacheStorage",
        "Default/Service Worker/ScriptCache",
      ]),
    );
  });

  it("removes every rebuildable path and keeps site state", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-rebuildable-"));
    roots.push(root);
    const browserDataPath = join(root, "chrome-data");
    await fillBrowserData(browserDataPath);

    const freed = await removeRebuildableData(browserDataPath);

    expect(freed).toBeGreaterThanOrEqual(
      REBUILDABLE_DATA_PATHS.length * 64 * KB,
    );
    for (const path of REBUILDABLE_DATA_PATHS) {
      expect(await exists(join(browserDataPath, path)), path).toBe(false);
    }
    await siteStateIntact(browserDataPath);
    expect(await removeRebuildableData(browserDataPath)).toBe(0);
  });

  it("never follows a symlink, whether the path or a folder above it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-rebuildable-"));
    roots.push(root);
    const outside = join(root, "outside");
    await writeSized(join(outside, "Cache", "keep"), KB);
    await writeSized(join(outside, "keep"), KB);
    const browserDataPath = join(root, "chrome-data");
    await mkdir(browserDataPath, { recursive: true });
    // chrome-data/Default points outside; chrome-data/ShaderCache too.
    await symlink(outside, join(browserDataPath, "Default"));
    await symlink(outside, join(browserDataPath, "ShaderCache"));

    await removeRebuildableData(browserDataPath);

    expect(await readFile(join(outside, "Cache", "keep"), "utf8")).toBe(
      "x".repeat(KB),
    );
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("x".repeat(KB));
    expect(await exists(join(browserDataPath, "ShaderCache"))).toBe(true);

    const linkedRoot = join(root, "linked-chrome-data");
    await symlink(outside, linkedRoot);
    expect(await removeRebuildableData(linkedRoot)).toBe(0);
    expect(await exists(join(outside, "Cache", "keep"))).toBe(true);
  });

  it("keeps the folders' modification times, so removal is not use", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-rebuildable-"));
    roots.push(root);
    const browserDataPath = join(root, "chrome-data");
    await fillBrowserData(browserDataPath);
    const old = new Date(NOW.getTime() - 5 * DAY);
    await setTreeTime(browserDataPath, old);

    await removeRebuildableData(browserDataPath);

    expect((await stat(browserDataPath)).mtimeMs).toBe(old.getTime());
    expect((await stat(join(browserDataPath, "Default"))).mtimeMs).toBe(
      old.getTime(),
    );
    expect(
      (await stat(join(browserDataPath, "Default", "Service Worker"))).mtimeMs,
    ).toBe(old.getTime());
  });

  it("is removed when a profile is archived, and the profile restores signed in", async () => {
    const fixture = await storeFixture();
    const profileId = await fixture.profile("Work", 1);
    const { browserDataPath } = fixture.paths(profileId);

    await fixture.store.archiveProfile({ hostId: "host-a", profileId });

    for (const path of REBUILDABLE_DATA_PATHS) {
      expect(await exists(join(browserDataPath, path)), path).toBe(false);
    }
    await siteStateIntact(browserDataPath);
    const restored = await fixture.store.restoreArchivedProfile({
      hostId: "host-a",
      profileId,
    });
    expect(restored.outcome).toBe("restored");
    await siteStateIntact(browserDataPath);
  });
});

describe("host storage limit", () => {
  it("does nothing under the limit", async () => {
    const fixture = await storeFixture();
    const profileId = await fixture.profile("Work", 3);

    const result = await fixture.store.enforceStorageLimit(
      "host-a",
      1024 * 1024 * 1024,
    );

    expect(result).toMatchObject({
      rebuildableDataProfileIds: [],
      deletedProfileIds: [],
    });
    expect(
      await exists(
        join(fixture.paths(profileId).browserDataPath, "Default", "Cache"),
      ),
    ).toBe(true);
  });

  it("removes Rebuildable Data from least recently used profiles first", async () => {
    const fixture = await storeFixture();
    const oldest = await fixture.profile("Oldest", 9);
    const middle = await fixture.profile("Middle", 5);
    const newest = await fixture.profile("Newest", 1);
    const before = await fixture.store.enforceStorageLimit(
      "host-a",
      Number.MAX_SAFE_INTEGER,
    );
    const perProfileRebuildable = REBUILDABLE_DATA_PATHS.length * 64 * KB;

    // Room for everything except about one and a half profiles' caches.
    const result = await fixture.store.enforceStorageLimit(
      "host-a",
      before.usedBytes - Math.round(perProfileRebuildable * 1.5),
    );

    expect(result.rebuildableDataProfileIds).toEqual([oldest, middle]);
    expect(result.deletedProfileIds).toEqual([]);
    expect(
      await exists(
        join(fixture.paths(newest).browserDataPath, "Default/Cache"),
      ),
    ).toBe(true);
    for (const profileId of [oldest, middle, newest]) {
      await siteStateIntact(fixture.paths(profileId).browserDataPath);
    }
  });

  it("removes Rebuildable Data from a signed-in profile but keeps its site state", async () => {
    const fixture = await storeFixture();
    const signedIn = await fixture.profile("Mail", 4);
    await fixture.store.recordSessionSite({
      hostId: "host-a",
      profileId: signedIn,
      origin: "https://mail.example.com",
      status: "signed-in",
      source: "owner-confirmed",
    });

    const result = await fixture.store.enforceStorageLimit("host-a", 1);

    expect(result.rebuildableDataProfileIds).toContain(signedIn);
    const { browserDataPath } = fixture.paths(signedIn);
    for (const path of REBUILDABLE_DATA_PATHS) {
      expect(await exists(join(browserDataPath, path)), path).toBe(false);
    }
    await siteStateIntact(browserDataPath);
    const inventory = await fixture.store.listProfiles("host-a");
    expect(
      inventory.profiles.find(({ profileId }) => profileId === signedIn),
    ).toMatchObject({ state: "active", reusable: true });
  });

  it("then deletes Archived Profiles oldest first, never a saved or signed-in one", async () => {
    let now = new Date(NOW.getTime() - 20 * DAY);
    const fixture = await storeFixture(() => now);
    const oldestArchive = await fixture.profile("Oldest archive", 30);
    const newerArchive = await fixture.profile("Newer archive", 30);
    const savedArchive = await fixture.profile("Saved archive", 30);
    const active = await fixture.profile("Active", 30);
    await fixture.store.recordSessionSite({
      hostId: "host-a",
      profileId: savedArchive,
      origin: "https://bank.example.com",
      status: "signed-in",
      source: "owner-confirmed",
    });
    await fixture.store.archiveProfile({
      hostId: "host-a",
      profileId: savedArchive,
    });
    await fixture.store.archiveProfile({
      hostId: "host-a",
      profileId: oldestArchive,
    });
    now = new Date(NOW.getTime() - 10 * DAY);
    await fixture.store.archiveProfile({
      hostId: "host-a",
      profileId: newerArchive,
    });
    now = NOW;
    // With no Rebuildable Data left, only deleting an archive makes room.
    await removeRebuildableData(fixture.paths(active).browserDataPath);
    const { usedBytes } = await fixture.store.enforceStorageLimit(
      "host-a",
      Number.MAX_SAFE_INTEGER,
    );
    const oldestSize = (
      await fixture.store.profileUsage("host-a", [oldestArchive])
    )[0]!.sizeBytes;

    const result = await fixture.store.enforceStorageLimit(
      "host-a",
      usedBytes - oldestSize,
    );

    expect(result.rebuildableDataProfileIds).toEqual([]);

    expect(result.deletedProfileIds).toEqual([oldestArchive]);
    const remaining = (await fixture.store.listProfiles("host-a")).profiles.map(
      ({ profileId }) => profileId,
    );
    expect(remaining).toEqual(
      expect.arrayContaining([newerArchive, savedArchive, active]),
    );
    expect(remaining).not.toContain(oldestArchive);

    // Even a limit nothing can meet keeps saved and active profiles.
    const all = await fixture.store.enforceStorageLimit("host-a", 1);
    expect(all.deletedProfileIds).toEqual([newerArchive]);
    const left = (await fixture.store.listProfiles("host-a")).profiles.map(
      ({ profileId }) => profileId,
    );
    expect(left).toEqual(expect.arrayContaining([savedArchive, active]));
    await siteStateIntact(fixture.paths(savedArchive).browserDataPath);
    await siteStateIntact(fixture.paths(active).browserDataPath);
  });

  it("skips a profile with a running Browser Instance", async () => {
    const fixture = await storeFixture();
    const running = await fixture.profile("Running", 9);
    const idle = await fixture.profile("Idle", 1);

    const result = await fixture.store.enforceStorageLimit(
      "host-a",
      1,
      async (profileId) => profileId === running,
    );

    expect(result.rebuildableDataProfileIds).not.toContain(running);
    expect(result.rebuildableDataProfileIds).toContain(idle);
    expect(
      await exists(
        join(fixture.paths(running).browserDataPath, "Default", "Cache"),
      ),
    ).toBe(true);
  });
});
