import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  type BrowserStatus,
} from "../src/shared/contracts.js";
import { createBrowserHostEntry } from "../src/host/host.js";
import { createFileBrowserProfileStore } from "../src/host/profile-storage.js";

const HOST_ID = "host-cancellation";

/** BB force-kills the whole host worker this long after cancelling a call. */
const BB_WORKER_KILL_GRACE_MS = 5_000;

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

function unusedRuntimeMethod() {
  throw new Error("not used");
}

it("answers a cancelled browser script before BB would kill the host worker", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "host-cancellation-"));
  const profiles = createFileBrowserProfileStore({
    rootDirectory,
    installationId: "installation-cancellation",
  });
  await profiles.initialize(HOST_ID);
  let executionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    executionStarted = resolve;
  });
  let releaseStuckStage!: () => void;
  const stuckStage = new Promise<void>((resolve) => {
    releaseStuckStage = resolve;
  });
  const runtime = {
    start: unusedRuntimeMethod,
    stop: async () => {},
    execute: async () => {
      executionStarted();
      await stuckStage;
      return "finished after the caller gave up";
    },
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
  const cancellation = new AbortController();
  let operation: Promise<unknown> = Promise.resolve();
  try {
    operation = host.experimental_call(
      "browserScript",
      {
        purpose: "Run on a host too loaded to answer",
        code: "return page.url();",
        hostId: HOST_ID,
        projectId: "project-cancellation",
        threadId: "thread-cancellation",
        activityEventId: "cancellation-event-1",
        activityOccurredAt: "2026-10-07T00:00:00.000Z",
        profileId: DEFAULT_PROFILE_ID,
        timeoutMs: 30_000,
      },
      { signal: cancellation.signal },
    );
    const settled = operation.then(
      () => "resolved",
      (error: unknown) =>
        error instanceof Error ? error.name : "non-error rejection",
    );
    await started;
    const cancelledAt = Date.now();
    cancellation.abort();
    const answer = await Promise.race([
      settled,
      new Promise((resolve) =>
        setTimeout(() => resolve("still running"), BB_WORKER_KILL_GRACE_MS),
      ),
    ]);
    expect(answer).toBe("AbortError");
    expect(Date.now() - cancelledAt).toBeLessThan(BB_WORKER_KILL_GRACE_MS);
  } finally {
    releaseStuckStage();
    await operation.catch(() => undefined);
    await host.experimental_dispose();
    await rm(rootDirectory, { recursive: true, force: true });
  }
}, 15_000);
