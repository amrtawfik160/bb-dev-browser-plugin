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
        effectiveGroupId: 1001,
        async launch() {
          return {
            pid: 4200,
            automationEndpoint: "http://127.0.0.1:14200",
            exited: new Promise<void>(() => {}),
            async stop() {},
          };
        },
        async recover() {
          return null;
        },
        async processIdentity(pid) {
          return {
            pid,
            startedAtTicks: `fixture-${pid}`,
            commandHash: `fixture-command-${pid}`,
          };
        },
        async execute() {
          return "fixture-output";
        },
        async configuredSearchUrl({ text }) {
          return `https://search.fixture.test/?q=${encodeURIComponent(text)}`;
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

  it.each(["disable", "uninstall"] as const)(
    "disposes retained Browser Instances before %s process administration",
    async (method) => {
      const rootDirectory = await mkdtemp(join(tmpdir(), "host-disposal-"));
      const calls: string[] = [];
      const runtime = {
        start: async () => {
          throw new Error("not used");
        },
        stop: async () => {},
        execute: async () => {
          throw new Error("not used");
        },
        navigate: async () => {
          throw new Error("not used");
        },
        dispose: async () => {
          calls.push("runtime-disposed");
        },
      };
      const administration = {
        inspect: healthyStatus,
        diagnostics: () => {
          throw new Error("not used");
        },
        setupPlan: () => {
          throw new Error("not used");
        },
        setup: () => {
          throw new Error("not used");
        },
        disable: async () => {
          calls.push("administration-disabled");
          return {
            action: "disable" as const,
            outcome: "stopped" as const,
            message: "stopped",
            confirmationText: "Stop Browser processes" as const,
            profilesRetained: true as const,
          };
        },
        uninstall: async () => {
          calls.push("administration-uninstalled");
          return {
            action: "uninstall" as const,
            outcome: "stopped" as const,
            message: "stopped",
            confirmationText: "Stop Browser processes" as const,
            profilesRetained: true as const,
          };
        },
        purgePlan: () => {
          throw new Error("not used");
        },
        purge: () => {
          throw new Error("not used");
        },
        stopProfile: async () => {},
        isProfileStopped: async () => true,
      };
      const host = experimental_createHostEntryHarness(
        createBrowserHostEntry(administration, undefined, undefined, runtime),
        {
          experimental_paths: {
            dataDir: rootDirectory,
            tempDir: join(rootDirectory, "tmp"),
          },
        },
      );
      try {
        await host.experimental_call(method, {
          hostId: HOST_ID,
          profileId: DEFAULT_PROFILE_ID,
          confirmation: "Stop Browser processes",
        });
        expect(calls).toEqual([
          "runtime-disposed",
          `administration-${method === "disable" ? "disabled" : "uninstalled"}`,
        ]);
      } finally {
        await host.experimental_dispose();
        await rm(rootDirectory, { recursive: true, force: true });
      }
    },
  );
});
