import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  BrowserOriginScopeDeniedError,
  createBrowserInstanceRuntime,
} from "../browser-runtime.js";

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
  it("issue #12 exposes lifecycle state and pins a visible Browser Panel", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-panel-runtime-"));
    let lifecycleState: "sleeping" | "running" = "sleeping";
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
      status: async ({
        hostId,
        profileId,
      }: {
        hostId: string;
        profileId: string;
      }) => ({
        state: lifecycleState,
        hostId,
        profileId,
      }),
      pinPanel: async () => {
        lifecycleState = "running";
        return {} as never;
      },
      unpinPanel: async () => {
        lifecycleState = "sleeping";
      },
      hostDisconnected: () => {},
      hostReconnected: async () => {},
      dispose: async () => {},
    };
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-panel-runtime",
    });
    await profiles.initialize(HOST_ID);
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        profiles,
        undefined,
        runtime,
      ),
      {
        experimental_paths: {
          dataDir: rootDirectory,
          tempDir: join(rootDirectory, "tmp"),
        },
      },
    );
    try {
      await expect(
        host.experimental_call("status", {
          hostId: HOST_ID,
          profileId: DEFAULT_PROFILE_ID,
        }),
      ).resolves.toMatchObject({
        state: "sleeping",
        label: "Sleeping",
        message:
          "This Browser Instance is sleeping and will wake without changing its Browser Profile.",
      });
      await expect(
        host.experimental_call("panelVisibility", {
          hostId: HOST_ID,
          profileId: DEFAULT_PROFILE_ID,
          panelId: "panel-visible",
          visibility: "visible",
        }),
      ).resolves.toMatchObject({ state: "healthy" });
      await expect(
        host.experimental_call("panelVisibility", {
          hostId: HOST_ID,
          profileId: DEFAULT_PROFILE_ID,
          panelId: "panel-visible",
          visibility: "hidden",
        }),
      ).resolves.toMatchObject({ state: "sleeping" });
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
  it("issue #12 keeps one Browser Instance across the production host reconnect bridge", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-runtime-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-runtime",
    });
    await profiles.initialize(HOST_ID);
    const browserExecutable = join(rootDirectory, "chrome-fixture");
    await writeFile(browserExecutable, "fixture");
    await chmod(browserExecutable, 0o755);
    let launchCount = 0;
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
          launchCount += 1;
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

      await host.experimental_call("hostConnection", {
        hostId: HOST_ID,
        generation: 1,
        state: "disconnected",
      });
      await expect(
        host.experimental_call("browserScript", {
          purpose: "Inspect the disconnected fixture",
          code: "console.log(await browser.listPages())",
          hostId: HOST_ID,
          projectId: "project-runtime",
          threadId: "thread-runtime",
          activityEventId: "runtime-event-2",
          activityOccurredAt: "2026-08-28T00:00:01.000Z",
          profileId: DEFAULT_PROFILE_ID,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: "host-offline" });
      await host.experimental_call("hostConnection", {
        hostId: HOST_ID,
        generation: 2,
        state: "connected",
      });
      await expect(
        host.experimental_call("hostConnection", {
          hostId: HOST_ID,
          generation: 1,
          state: "disconnected",
        }),
      ).resolves.toMatchObject({ applied: false });
      await expect(
        host.experimental_call("browserScript", {
          purpose: "Inspect the reconnected fixture",
          code: "console.log(await browser.listPages())",
          hostId: HOST_ID,
          projectId: "project-runtime",
          threadId: "thread-runtime",
          activityEventId: "runtime-event-3",
          activityOccurredAt: "2026-08-28T00:00:02.000Z",
          profileId: DEFAULT_PROFILE_ID,
          timeoutMs: 5_000,
        }),
      ).resolves.toEqual({ ok: true, result: "fixture-output" });
      expect(launchCount).toBe(1);
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
        status: async ({
          hostId,
          profileId,
        }: {
          hostId: string;
          profileId: string;
        }) => ({
          state: "sleeping" as const,
          hostId,
          profileId,
        }),
        pinPanel: async () => {
          throw new Error("not used");
        },
        unpinPanel: async () => {},
        hostDisconnected: () => {},
        hostReconnected: async () => {},
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

  it("issue #13 records a Control Lease revocation as interruption context when a script completes before the lease aborts", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-lease-race-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-lease-race",
    });
    await profiles.initialize(HOST_ID);
    let executionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    const runtime = {
      start: async () => {
        throw new Error("not used");
      },
      stop: async () => {},
      execute: async (
        _target: unknown,
        _code: string,
        _timeoutMs: number,
        options: { leaseSignal?: AbortSignal } | undefined,
      ) => {
        await new Promise<void>((resolve) => {
          if (options?.leaseSignal?.aborted) {
            resolve();
            return;
          }
          executionStarted();
          options?.leaseSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return "completed despite the lease revoking";
      },
      navigate: async (target: { tabId?: string }, input: string) => ({
        address: {
          kind: "address" as const,
          url: "https://example.com/navigated",
        },
        location: { url: input },
        tabId: target.tabId ?? "host-tab",
      }),
      status: async ({
        hostId,
        profileId,
      }: {
        hostId: string;
        profileId: string;
      }) => ({
        state: "sleeping" as const,
        hostId,
        profileId,
      }),
      pinPanel: async () => {
        throw new Error("not used");
      },
      unpinPanel: async () => {},
      hostDisconnected: () => {},
      hostReconnected: async () => {},
      dispose: async () => {},
    };
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
      const operation = host.experimental_call("browserScript", {
        purpose: "Complete before owner takeover",
        code: "return page.url();",
        hostId: HOST_ID,
        projectId: "project-lease-race",
        threadId: "thread-lease-race",
        activityEventId: "lease-race-event-1",
        activityOccurredAt: "2026-08-28T00:00:00.000Z",
        profileId: DEFAULT_PROFILE_ID,
        timeoutMs: 5_000,
      });
      await started;
      await host.experimental_call("navigate", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        projectId: "project-lease-race",
        input: "https://example.com/owner-takes-control",
        rawLocalhost: false,
      });
      const response = await operation;
      expect(response).toEqual({
        ok: true,
        result: "completed despite the lease revoking",
      });
      const outboxState = JSON.parse(
        await readFile(
          join(rootDirectory, "browser-activity-outbox.json"),
          "utf8",
        ),
      );
      const scriptEvent = outboxState.events.find(
        (event: { action: string }) => event.action === "browser-script",
      );
      expect(scriptEvent).toMatchObject({
        outcome: "succeeded",
        interrupted: true,
        interruptionReason: "control-lease-revoked",
      });
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});

it("issue #14 returns a typed origin_denied result when the runtime blocks a real-browser navigation", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "host-origin-scope-"));
  const profiles = createFileBrowserProfileStore({
    rootDirectory,
    installationId: "installation-origin-scope",
  });
  await profiles.initialize(HOST_ID);
  const deniedOrigin = "https://evil.example.test";
  const runtime = {
    start: async () => {
      throw new Error("not used");
    },
    stop: async () => {},
    execute: async (
      _target: unknown,
      _code: string,
      _timeoutMs: number,
      options: { originScope?: string } | undefined,
    ) => {
      if (options?.originScope !== undefined) {
        throw new BrowserOriginScopeDeniedError(deniedOrigin);
      }
      return "fixture-output";
    },
    navigate: async () => {
      throw new Error("not used");
    },
    status: async ({
      hostId,
      profileId,
    }: {
      hostId: string;
      profileId: string;
    }) => ({
      state: "sleeping" as const,
      hostId,
      profileId,
    }),
    pinPanel: async () => {
      throw new Error("not used");
    },
    unpinPanel: async () => {},
    hostDisconnected: () => {},
    hostReconnected: async () => {},
    dispose: async () => {},
  };
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
    const response = await host.experimental_call("browserScript", {
      purpose: "Reach a permitted page that escapes its grant",
      code: "return page.url();",
      hostId: HOST_ID,
      projectId: "project-origin-scope",
      threadId: "thread-origin-scope",
      activityEventId: "origin-scope-event-1",
      activityOccurredAt: "2026-08-28T00:00:00.000Z",
      profileId: DEFAULT_PROFILE_ID,
      timeoutMs: 5_000,
      originScope: "https://app.example.test",
    });
    expect(response).toEqual({
      ok: false,
      error: {
        state: "origin-denied",
        code: "origin_denied",
        label: "Origin denied",
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        message: expect.stringContaining(deniedOrigin),
        origin: deniedOrigin,
        grantRequest: null,
      },
    });
  } finally {
    await host.experimental_dispose();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});

it("issue #14 AC4 forwards per-origin invalid-certificate flags from the script request to the runtime", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "host-cert-bypass-"));
  const profiles = createFileBrowserProfileStore({
    rootDirectory,
    installationId: "installation-cert-bypass",
  });
  await profiles.initialize(HOST_ID);
  let forwardedOrigins: readonly string[] | undefined;
  const runtime = {
    start: async () => {
      throw new Error("not used");
    },
    stop: async () => {},
    execute: async (
      _target: unknown,
      _code: string,
      _timeoutMs: number,
      options:
        | {
            originScope?: string;
            invalidCertificateOrigins?: readonly string[];
          }
        | undefined,
    ) => {
      forwardedOrigins = options?.invalidCertificateOrigins;
      return "fixture-output";
    },
    navigate: async () => {
      throw new Error("not used");
    },
    status: async ({
      hostId,
      profileId,
    }: {
      hostId: string;
      profileId: string;
    }) => ({
      state: "sleeping" as const,
      hostId,
      profileId,
    }),
    pinPanel: async () => {
      throw new Error("not used");
    },
    unpinPanel: async () => {},
    hostDisconnected: () => {},
    hostReconnected: async () => {},
    dispose: async () => {},
  };
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
    await host.experimental_call("browserScript", {
      purpose: "Load a granted invalid-certificate origin",
      code: "return page.url();",
      hostId: HOST_ID,
      projectId: "project-cert-bypass",
      threadId: "thread-cert-bypass",
      activityEventId: "cert-bypass-event-1",
      activityOccurredAt: "2026-08-28T00:00:00.000Z",
      profileId: DEFAULT_PROFILE_ID,
      timeoutMs: 5_000,
      originScope: "https://app.example.test:8443",
      invalidCertificateOrigins: ["https://app.example.test:8443"],
    });
    expect(forwardedOrigins).toEqual(["https://app.example.test:8443"]);
  } finally {
    await host.experimental_dispose();
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
