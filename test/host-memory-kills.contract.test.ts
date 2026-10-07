import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  type BrowserStatus,
} from "../src/shared/contracts.js";
import { createBrowserHostEntry } from "../src/host/host.js";
import { cgroupMemoryKills } from "../src/host/memory-kills.js";
import { createFileBrowserProfileStore } from "../src/host/profile-storage.js";

const HOST_ID = "host-memory-kills";

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

function unused(): never {
  throw new Error("not used");
}

it("tells the agent a script failed because the host ran out of memory", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "host-memory-kills-"));
  const profiles = createFileBrowserProfileStore({
    rootDirectory,
    installationId: "installation-memory-kills",
  });
  await profiles.initialize(HOST_ID);
  let kills = 157;
  const runtime = {
    start: unused,
    stop: async () => {},
    execute: async () => {
      kills += 2;
      throw new Error("Target page, context or browser has been closed");
    },
    navigate: unused,
    history: unused,
    openPage: unused,
    focusPage: unused,
    closePages: async () => 0,
    listPages: async () => [],
    status: async (target: { hostId: string; profileId: string }) => ({
      state: "running" as const,
      ...target,
    }),
    pinPanel: unused,
    unpinPanel: async () => {},
    hostDisconnected: () => {},
    hostReconnected: async () => {},
    dispose: async () => {},
  };
  const host = experimental_createHostEntryHarness(
    createBrowserHostEntry(
      { inspect: healthyStatus, diagnostics: unused },
      profiles,
      undefined,
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      { count: async () => kills },
    ),
    {
      experimental_paths: {
        dataDir: rootDirectory,
        tempDir: join(rootDirectory, "tmp"),
      },
    },
  );
  try {
    const response = await host.experimental_call("browserScript", {
      purpose: "Open the mention picker",
      code: "await page.click('#mention');",
      hostId: HOST_ID,
      projectId: "project-memory-kills",
      threadId: "thread-memory-kills",
      activityEventId: "memory-kills-event-1",
      activityOccurredAt: "2026-10-07T00:00:00.000Z",
      profileId: DEFAULT_PROFILE_ID,
      timeoutMs: 30_000,
    });
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error.message).toMatch(
      /^The host ran out of memory during this call: the kernel killed 2 processes in BB's host service/u,
    );
    expect(response.ok === false && response.error.message).toContain(
      "Target page, context or browser has been closed",
    );
  } finally {
    await host.experimental_dispose();
    await rm(rootDirectory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

it("reads the memory kill count of the worker's own cgroup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cgroup-root-"));
  try {
    await mkdir(join(root, "proc", "self"), { recursive: true });
    await writeFile(
      join(root, "proc", "self", "cgroup"),
      "0::/system.slice/bb-host-daemon.service\n",
    );
    const service = join(
      root,
      "sys",
      "fs",
      "cgroup",
      "system.slice",
      "bb-host-daemon.service",
    );
    await mkdir(service, { recursive: true });
    await writeFile(
      join(service, "memory.events"),
      "low 0\nhigh 8668979\nmax 1042081\noom 13641\noom_kill 157\noom_group_kill 0\n",
    );
    await expect(cgroupMemoryKills(root).count()).resolves.toBe(157);
    await expect(
      cgroupMemoryKills(join(root, "missing")).count(),
    ).resolves.toBe(null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
