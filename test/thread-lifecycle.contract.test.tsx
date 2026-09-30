// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
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

async function threadHarness(sharedProfile = false) {
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
    stopped,
    executed,
    useBrowser,
    profileState,
    lifecycleCalls,
  };
}

describe("thread lifecycle releases thread browsers", () => {
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
