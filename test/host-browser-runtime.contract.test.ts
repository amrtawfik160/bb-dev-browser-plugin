import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createBrowserInstanceRuntime } from "../browser-runtime.js";

const HOST_ID = "host-runtime";

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

describe("Browser host runtime boundary", () => {
  it("wakes the selected Browser Profile and returns the attached dev-browser result", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-runtime-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-runtime",
    });
    await profiles.initialize(HOST_ID);
    const browserExecutable = join(rootDirectory, "chrome-fixture");
    await writeFile(browserExecutable, "fixture");
    await chmod(browserExecutable, 0o755);
    const runtime = createBrowserInstanceRuntime({
      rootDirectory,
      installationId: "installation-runtime",
      chromeStablePaths: [browserExecutable],
      playwrightChromiumPath: join(rootDirectory, "fallback-chromium"),
      launchBoundary: {
        runAsUser: "bb-browser",
        effectiveUserId: 1001,
        async launch() {
          return {
            pid: 4200,
            automationEndpoint: "http://127.0.0.1:14200",
            async stop() {},
          };
        },
        async execute() {
          return "fixture-output";
        },
      },
    });
    const readiness = {
      inspect: healthyStatus,
      diagnostics: () => {
        throw new Error("diagnostics not used");
      },
    };
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(readiness, profiles, undefined, runtime),
      {
        experimental_paths: {
          dataDir: rootDirectory,
          tempDir: join(rootDirectory, "tmp"),
        },
      },
    );
    try {
      await expect(
        host.experimental_call("browserScript", {
          purpose: "Inspect the local fixture",
          code: "console.log(await browser.listPages())",
          hostId: HOST_ID,
          projectId: "project-runtime",
          threadId: "thread-runtime",
          activityEventId: "runtime-event-1",
          activityOccurredAt: "2026-08-28T00:00:00.000Z",
          profileId: DEFAULT_PROFILE_ID,
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({ ok: true, result: "fixture-output" });
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
