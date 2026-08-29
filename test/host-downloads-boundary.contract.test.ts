import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../contracts.js";
import { createBrowserHostEntry } from "../host.js";
import { createFileBrowserProfileStore } from "../profile-storage.js";

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
});
