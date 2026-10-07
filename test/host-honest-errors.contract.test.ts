import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_PROFILE_ID, type BrowserStatus } from "../src/shared/contracts.js";
import { createBrowserHostEntry } from "../src/host/host.js";
import { createFileBrowserProfileStore } from "../src/host/profile-storage.js";

const HOST_ID = "host-honest-errors";

function healthyStatus(target: {
  hostId: string;
  profileId: string;
}): BrowserStatus {
  return {
    hostId: target.hostId,
    profileId: target.profileId,
    capabilities: [],
    state: "healthy",
    code: "healthy",
    label: "Ready",
    message: "Workspace Browser is ready on this host.",
  };
}

function unusedRuntimeMethod(): never {
  throw new Error("not used");
}

const scriptRequest = {
  purpose: "Read a page while the browser is busy",
  code: "return page.url();",
  hostId: HOST_ID,
  projectId: "project-honest-errors",
  threadId: "thread-honest-errors",
  activityEventId: "honest-errors-event-1",
  activityOccurredAt: "2026-10-07T00:00:00.000Z",
  profileId: DEFAULT_PROFILE_ID,
  timeoutMs: 30_000,
};

async function hostWithExecute(execute: () => Promise<unknown>) {
  const rootDirectory = await mkdtemp(join(tmpdir(), "host-honest-errors-"));
  const profiles = createFileBrowserProfileStore({
    rootDirectory,
    installationId: "installation-honest-errors",
  });
  await profiles.initialize(HOST_ID);
  const runtime = {
    start: unusedRuntimeMethod,
    stop: async () => {},
    execute,
    navigate: unusedRuntimeMethod,
    history: unusedRuntimeMethod,
    openPage: unusedRuntimeMethod,
    focusPage: unusedRuntimeMethod,
    closePages: async () => 0,
    listPages: async () => [],
    status: async (target: { hostId: string; profileId: string }) => ({
      state: "running" as const,
      ...target,
    }),
    pinPanel: unusedRuntimeMethod,
    unpinPanel: async () => {},
    hostDisconnected: () => {},
    hostReconnected: async () => {},
    dispose: async () => {},
  };
  const host = experimental_createHostEntryHarness(
    createBrowserHostEntry(
      { inspect: healthyStatus, diagnostics: unusedRuntimeMethod },
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
  return {
    host,
    async dispose() {
      await host.experimental_dispose();
      await rm(rootDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    },
  };
}

it("reports a failed origin-guard install as guard_install_failed", async () => {
  const harness = await hostWithExecute(async () => {
    const busy = new Error("browser busy, retry");
    busy.name = "BrowserOriginGuardInstallError";
    throw Object.assign(busy, { code: "guard_install_failed" });
  });
  try {
    const response = await harness.host.experimental_call(
      "browserScript",
      scriptRequest,
    );
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("guard_install_failed");
    expect(response.error.message).toContain("browser busy, retry");
    expect(response.error.message).not.toContain("non-web URL");
  } finally {
    await harness.dispose();
  }
});

it("reports a CDP connect timeout as browser_busy, not a revoked lease", async () => {
  let releaseExecution!: () => void;
  const started = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  let continueExecution!: () => void;
  const gate = new Promise<void>((resolve) => {
    continueExecution = resolve;
  });
  const harness = await hostWithExecute(async () => {
    releaseExecution();
    await gate;
    throw new Error(
      "browserType.connectOverCDP: Timeout 30000ms exceeded.\nCall log:\n  - connecting to ws://127.0.0.1:9222/devtools/browser/test",
    );
  });
  try {
    const operation = harness.host.experimental_call("browserScript", {
      ...scriptRequest,
      activityEventId: "honest-errors-event-2",
    });
    await started;
    await harness.host.experimental_call("sleepProfile", {
      hostId: HOST_ID,
      profileId: DEFAULT_PROFILE_ID,
    });
    continueExecution();
    const response = await operation;
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("browser_busy");
    expect(response.error.message).toContain("Retry this call.");
  } finally {
    continueExecution();
    await harness.dispose();
  }
});
