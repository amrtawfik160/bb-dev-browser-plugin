// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPublicPluginHarness,
  createTabInventoryRuntime,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";
import { DEFAULT_PROFILE_ID } from "../src/shared/contracts.js";
import { scopedProfileId } from "../src/shared/profile-scope.js";

const HOST_ID = "host-browser-test";
const PROJECT_ID = "project-browser-test";
const THREAD_ID = "thread-browser-test";
const threadProfileId = scopedProfileId({
  projectId: PROJECT_ID,
  threadId: THREAD_ID,
});
const secondThreadProfileId = scopedProfileId({
  projectId: PROJECT_ID,
  threadId: "thread-second",
});

async function threadHarness(
  sharedProfile = false,
  archivedThreads?: { id: string; projectId: string; archivedAt: number }[],
) {
  const runtime = createTabInventoryRuntime();
  const stopped: string[] = [];
  const executed: string[] = [];
  runtime.stop = async (target) => {
    stopped.push(target.profileId);
  };
  runtime.execute = async (target) => {
    executed.push(target.profileId);
    return "ok";
  };
  const browser = await createPublicPluginHarness({
    status: healthyBrowserStatus,
    browserRuntime: runtime,
    sharedProfile,
    archivedThreads,
  });
  async function useBrowser(threadId = THREAD_ID) {
    const result = await browser.runBrowserScriptWithProfile(undefined, {
      threadId,
      destinationOrigin: "https://example.com",
    });
    expect(result.isError).not.toBe(true);
  }
  async function profileState(profileId: string) {
    const inventory = await browser.runBrowserProfiles(HOST_ID, {
      projectId: PROJECT_ID,
    });
    return inventory.profiles.find((profile) => profile.profileId === profileId)
      ?.state;
  }
  function lifecycleCalls() {
    return browser.hostRpcCalls.filter(
      (method) =>
        method === "sleepProfile" || method === "archiveUnsavedProfile",
    );
  }
  return {
    browser,
    runtime,
    stopped,
    executed,
    useBrowser,
    profileState,
    lifecycleCalls,
  };
}

describe("thread lifecycle releases thread browsers", () => {
  it("sweeps profiles of threads archived past the grace only with --apply", async () => {
    const day = 24 * 60 * 60 * 1_000;
    const { browser, useBrowser, profileState } = await threadHarness(false, [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        archivedAt: Date.now() - 30 * day,
      },
      {
        id: "thread-second",
        projectId: PROJECT_ID,
        archivedAt: Date.now() - 1 * day,
      },
    ]);
    try {
      await useBrowser();
      await useBrowser("thread-second");

      const dryRun = await browser.runBrowserCli([
        "sweep-thread-profiles",
        "--json",
      ]);
      expect(dryRun.exitCode).toBe(0);
      expect(JSON.parse(dryRun.stdout!)).toMatchObject({
        applied: false,
        released: 0,
        profiles: [{ profileId: threadProfileId, threadId: THREAD_ID }],
      });
      expect(await profileState(threadProfileId)).toBe("active");

      const applied = await browser.runBrowserCli([
        "sweep-thread-profiles",
        "--apply",
        "--json",
      ]);
      expect(JSON.parse(applied.stdout!)).toMatchObject({
        applied: true,
        released: 1,
      });
      expect(await profileState(threadProfileId)).toBe("archived");
      expect(await profileState(secondThreadProfileId)).toBe("active");
      expect(await profileState(DEFAULT_PROFILE_ID)).toBe("active");
    } finally {
      await browser.dispose();
    }
  });

  it("sleeps only the archived thread's default profile and wakes it again", async () => {
    const { browser, stopped, executed, useBrowser, profileState } =
      await threadHarness();
    try {
      await useBrowser();
      await useBrowser("thread-second");
      const { errors } = await browser.emitThreadEvent("thread.archived");
      expect(errors).toEqual([]);
      expect(stopped).toEqual([threadProfileId]);
      expect(await profileState(threadProfileId)).toBe("active");
      expect(await profileState(secondThreadProfileId)).toBe("active");
      const grants = await browser.listBrowserGrants({
        profileId: threadProfileId,
      });
      expect(JSON.stringify(grants)).toContain(threadProfileId);
      await useBrowser();
      expect(executed.at(-1)).toBe(threadProfileId);
    } finally {
      await browser.dispose();
    }
  });

  it("archives only the deleted thread's default profile as a system action", async () => {
    const { browser, useBrowser, profileState, lifecycleCalls } =
      await threadHarness();
    try {
      await useBrowser();
      await useBrowser("thread-second");
      const { errors } = await browser.emitThreadEvent("thread.deleted");
      expect(errors).toEqual([]);
      expect(await profileState(threadProfileId)).toBe("archived");
      expect(await profileState(secondThreadProfileId)).toBe("active");
      expect(await profileState(DEFAULT_PROFILE_ID)).toBe("active");
      const rows = browser.persistedActivityRows() as Record<string, unknown>[];
      expect(rows).toContainEqual(
        expect.objectContaining({
          actor: "system",
          kind: "lifecycle",
          action: "archive",
          outcome: "archived",
          project_id: PROJECT_ID,
          profile_id: threadProfileId,
        }),
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          actor: "system",
          kind: "grant",
          action: "profile-archived",
          outcome: "revoked",
          profile_id: threadProfileId,
        }),
      );
      expect(
        rows.some(
          (row) =>
            row.actor !== "agent" && row.profile_id === secondThreadProfileId,
        ),
      ).toBe(false);
      await browser.emitThreadEvent("thread.deleted");
      expect(lifecycleCalls()).toEqual(["archiveUnsavedProfile"]);
    } finally {
      await browser.dispose();
    }
  });

  it("leaves explicitly selected shared profiles untouched", async () => {
    const { browser, stopped, useBrowser, profileState, lifecycleCalls } =
      await threadHarness(true);
    try {
      await useBrowser();
      await browser.emitThreadEvent("thread.archived");
      await browser.emitThreadEvent("thread.deleted");
      expect(stopped).toEqual([]);
      expect(lifecycleCalls()).toEqual([]);
      expect(await profileState(DEFAULT_PROFILE_ID)).toBe("active");
    } finally {
      await browser.dispose();
    }
  });

  it("leaves a thread default that an owner selected elsewhere untouched", async () => {
    const { browser, stopped, useBrowser, profileState, lifecycleCalls } =
      await threadHarness();
    try {
      await useBrowser();
      await browser.selectBrowserProfile(
        { hostId: HOST_ID, profileId: threadProfileId },
        { projectId: "project-a" },
      );
      await browser.emitThreadEvent("thread.archived");
      await browser.emitThreadEvent("thread.deleted");
      expect(stopped).toEqual([]);
      expect(lifecycleCalls()).toEqual([]);
      expect(await profileState(threadProfileId)).toBe("active");
    } finally {
      await browser.dispose();
    }
  });

  it("tolerates a disconnected host without releasing its profile", async () => {
    const { browser, useBrowser, profileState, lifecycleCalls } =
      await threadHarness();
    try {
      await useBrowser();
      browser.setHostConnection("disconnected");
      const archived = await browser.emitThreadEvent("thread.archived");
      const deleted = await browser.emitThreadEvent("thread.deleted");
      expect(archived.errors).toEqual([]);
      expect(deleted.errors).toEqual([]);
      expect(lifecycleCalls()).toEqual([]);
      const warnings = browser
        .diagnosticLogEntries()
        .filter(({ level }) => level === "warn");
      expect(warnings.map(({ message }) => message)).toContain(
        "Browser skipped 1 disconnected workspace host(s) while releasing an ended thread's browser.",
      );
      expect(JSON.stringify(warnings)).not.toContain(threadProfileId);
      browser.setHostConnection("connected");
      expect(await profileState(threadProfileId)).toBe("active");
    } finally {
      await browser.dispose();
    }
  });
});

describe("owner cleanup of unused worker profiles", () => {
  const day = 24 * 60 * 60 * 1_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  async function cleanupHarness() {
    const harness = await threadHarness();
    const running = new Set<string>();
    harness.runtime.status = async (target) => ({
      state: running.has(target.profileId) ? "running" : "sleeping",
      hostId: target.hostId,
      profileId: target.profileId,
    });
    return { ...harness, running };
  }

  it("shows and deletes only idle, unsigned, unselected, stopped worker profiles", async () => {
    const { browser, useBrowser, profileState, running } =
      await cleanupHarness();
    try {
      await useBrowser();
      await useBrowser("thread-second");
      await useBrowser("thread-signed-in");
      await useBrowser("thread-selected");
      const signedInId = scopedProfileId({
        projectId: PROJECT_ID,
        threadId: "thread-signed-in",
      });
      const selectedId = scopedProfileId({
        projectId: PROJECT_ID,
        threadId: "thread-selected",
      });
      await browser.runBrowserSessions(
        {
          action: "report",
          origin: "https://mail.example.com",
          status: "signed-in",
        },
        { threadId: "thread-signed-in" },
      );
      await browser.selectBrowserProfile(
        { hostId: HOST_ID, profileId: selectedId },
        { projectId: "project-a" },
      );
      running.add(secondThreadProfileId);

      expect(await browser.browserProfileCleanupPlan()).toMatchObject({
        automatic: "not-confirmed",
        profileIds: [],
      });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 3 * day);

      const plan = await browser.browserProfileCleanupPlan();
      expect(plan.profileIds).toEqual([threadProfileId]);
      expect(plan.sizeBytes).toBeGreaterThan(0);

      const result = await browser.cleanUpBrowserProfiles({
        profileIds: plan.profileIds,
        automatic: true,
      });
      expect(result).toMatchObject({ deleted: 1, automatic: true });
      expect(await profileState(threadProfileId)).toBeUndefined();
      for (const kept of [secondThreadProfileId, signedInId, selectedId]) {
        expect(await profileState(kept)).toBe("active");
      }
      expect(await browser.browserProfileCleanupPlan()).toMatchObject({
        automatic: "on",
      });
      expect(await browser.setAutomaticProfileCleanup(false)).toEqual({
        enabled: false,
      });
    } finally {
      await browser.dispose();
    }
  });

  it("skips a listed profile that was used after the owner saw the list", async () => {
    const { browser, useBrowser, profileState } = await cleanupHarness();
    try {
      await useBrowser();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 3 * day);
      const plan = await browser.browserProfileCleanupPlan();
      expect(plan.profileIds).toEqual([threadProfileId]);
      vi.useRealTimers();
      const result = await browser.cleanUpBrowserProfiles({
        profileIds: plan.profileIds,
        automatic: false,
      });
      expect(result).toMatchObject({ deleted: 0, automatic: false });
      expect(await profileState(threadProfileId)).toBe("active");
    } finally {
      await browser.dispose();
    }
  });

  it("lets the owner check and delete them from Settings in one step", async () => {
    const { browser, useBrowser, profileState } = await cleanupHarness();
    try {
      await useBrowser();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 3 * day);
      const settings = browser.renderSettings();
      fireEvent.click(
        await settings.findByRole("button", {
          name: "Check unused worker profiles",
        }),
      );
      await settings.findByText(/^1 unused worker profile\(s\), \d+\.\d GB/);
      const automatic = settings.getByRole("checkbox", {
        name: "Delete unused worker profiles automatically",
      });
      expect((automatic as HTMLInputElement).checked).toBe(true);
      fireEvent.click(
        settings.getByRole("button", { name: "Delete 1 profile(s)" }),
      );
      await settings.findByText(
        /Deleted 1 profile\(s\)\. Automatic cleanup is on\./,
      );
      expect(await profileState(threadProfileId)).toBeUndefined();
    } finally {
      await browser.dispose();
    }
  });

  it("keeps agents from running the cleanup", async () => {
    const { browser } = await cleanupHarness();
    try {
      const commands = browser.registeredBrowserCliCommands();
      expect(JSON.stringify(commands)).not.toContain("cleanup");
    } finally {
      await browser.dispose();
    }
  });
});
