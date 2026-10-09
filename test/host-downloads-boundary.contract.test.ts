import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../src/shared/contracts.js";
import { createBrowserHostEntry } from "../src/host/host.js";
import { createFileBrowserProfileStore } from "../src/host/profile-storage.js";
import {
  createHostDownloadsManager,
  resolveHostDownloadsRoot,
} from "../src/host/host-downloads.js";
import { createNodeHostDownloadsFilesystem } from "../src/host/host-downloads-filesystem.js";

const HOST_ID = "host-downloads-reconnect";

function healthyStatus(): BrowserStatus {
  const unavailable = setupRequiredStatus({
    hostId: HOST_ID,
    profileId: DEFAULT_PROFILE_ID,
  });
  return {
    ...unavailable,
    state: "healthy",
    code: "healthy",
    label: "Ready",
    message: "Workspace Browser is ready on this host.",
    capabilities: unavailable.capabilities.map((capability) => ({
      ...capability,
      status: "ready",
    })),
  };
}

/**
 * The host routes Host Downloads RPCs to the manager and returns privacy-safe
 * defaults (limits) without mutating the host when no downloads exist. This
 * mirrors the Transfer Staging host-boundary pattern so a non-provisioned host
 * is never touched by a download (issue #20).
 */
describe("Host Downloads host boundary (issue #20)", () => {
  it("lists downloads and reports documented default limits through the host boundary", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-downloads-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-downloads",
    });
    await profiles.initialize(HOST_ID);
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry({
        inspect: healthyStatus,
        diagnostics: () => undefined as never,
      }),
      {
        experimental_paths: {
          dataDir: rootDirectory,
          tempDir: rootDirectory,
        },
      },
    );
    const result = await host.experimental_call("downloadList", {
      hostId: HOST_ID,
      profileId: DEFAULT_PROFILE_ID,
    });
    expect(result.downloads).toEqual([]);
    expect(result.limits).toMatchObject({
      maxFileBytes: 1 * 1024 * 1024 * 1024,
      maxProfileBytes: 5 * 1024 * 1024 * 1024,
    });
  });

  // P1 (issue #20 findings): time-based expiry of a live quarantined download
  // must actually fire in production. The host calls the manager's `expire()`
  // on the `downloadList` path (and the panel's `subscribeDownloads` path), so
  // a download whose quarantine lease has elapsed is removed without requiring
  // a profile lifecycle event (archive/reset/delete/worker restart).
  it("reaps a live quarantined download after its expiry elapses on downloadList, without a profile lifecycle event", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-downloads-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-downloads",
    });
    await profiles.initialize(HOST_ID);
    let now = 1_000_000;
    const clock = { now: () => now };
    // Inject a manager with a controllable clock and a short expiry so the
    // test can advance past the lease without waiting a real seven days.
    const quarantineRoot = resolveHostDownloadsRoot(rootDirectory)!;
    const manager = createHostDownloadsManager({
      filesystem: createNodeHostDownloadsFilesystem(),
      quarantineRoot,
      clock,
      expiryMs: 60_000,
    });
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => undefined as never,
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        () => manager,
      ),
      {
        experimental_paths: {
          dataDir: rootDirectory,
          tempDir: rootDirectory,
        },
      },
    );
    // Stage a live quarantined download through the host boundary RPCs.
    const payload = new TextEncoder().encode("deterministic-download");
    const start = await host.experimental_call("downloadStart", {
      hostId: HOST_ID,
      downloadId: "expirable",
      profileId: DEFAULT_PROFILE_ID,
      suggestedName: "report.pdf",
      contentType: "application/pdf",
      totalBytes: payload.byteLength,
    });
    expect(start.outcome).toBe("quarantined");
    await host.experimental_call("downloadAppend", {
      hostId: HOST_ID,
      downloadId: "expirable",
      data: Buffer.from(payload).toString("base64"),
      chunkBytes: payload.byteLength,
    });
    const complete = await host.experimental_call("downloadComplete", {
      hostId: HOST_ID,
      downloadId: "expirable",
    });
    expect(complete.outcome).toBe("quarantined");
    // The download is live before expiry elapses.
    const before = await host.experimental_call("downloadList", {
      hostId: HOST_ID,
      profileId: DEFAULT_PROFILE_ID,
    });
    expect(before.downloads).toHaveLength(1);
    // Advance past the expiry and list again; `expire()` runs on the list
    // path and reaps the download without any profile lifecycle event.
    now += 61_000;
    const after = await host.experimental_call("downloadList", {
      hostId: HOST_ID,
      profileId: DEFAULT_PROFILE_ID,
    });
    expect(after.downloads).toEqual([]);
    expect(manager.size()).toBe(0);
  });

  it("refuses a workspace export through a symlink that leaves the workspace, on a real filesystem", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-downloads-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-downloads",
    });
    await profiles.initialize(HOST_ID);
    const manager = createHostDownloadsManager({
      filesystem: createNodeHostDownloadsFilesystem(),
      quarantineRoot: resolveHostDownloadsRoot(rootDirectory)!,
    });
    const payload = new TextEncoder().encode("website-chosen-bytes");
    const start = await manager.startDownload({
      downloadId: "planted",
      profileId: DEFAULT_PROFILE_ID,
      suggestedName: "payload.txt",
      contentType: "text/plain",
      totalBytes: payload.byteLength,
    });
    expect(start.outcome).toBe("quarantined");
    await manager.appendChunk({
      hostId: HOST_ID,
      downloadId: "planted",
      data: Buffer.from(payload).toString("base64"),
      chunkBytes: payload.byteLength,
    });
    await manager.completeDownload({ hostId: HOST_ID, downloadId: "planted" });

    const workspace = await mkdtemp(join(tmpdir(), "host-downloads-ws-"));
    const outside = await mkdtemp(join(tmpdir(), "host-downloads-outside-"));
    // A cloned repo may contain a directory symlink and a dangling file
    // symlink that both point outside the workspace.
    await symlink(outside, join(workspace, "evil"));
    await symlink(join(outside, "dangling.txt"), join(workspace, "link.txt"));
    const exportTo = (relativePath: string) =>
      manager.exportToWorkspace(
        {
          hostId: HOST_ID,
          downloadId: "planted",
          environmentRoot: workspace,
          relativePath,
        },
        { actor: "owner", leaseActive: false },
        workspace,
      );

    for (const relativePath of [
      "evil/payload.txt",
      "evil/nested/payload.txt",
    ]) {
      const refused = await exportTo(relativePath);
      expect(refused.outcome, relativePath).toBe("rejected");
      if (refused.outcome === "rejected") {
        expect(refused.reason, relativePath).toBe("outside-environment");
      }
    }
    expect((await exportTo("link.txt")).outcome).toBe("rejected");
    expect(await readdir(outside)).toEqual([]);

    const exported = await exportTo("a/b/payload.txt");
    expect(exported.outcome).toBe("exported");
    expect(
      new Uint8Array(await readFile(join(workspace, "a/b/payload.txt"))),
    ).toEqual(payload);
  });
});
