// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { scopedProfileId } from "../src/shared/profile-scope.js";
import { browserSessionSiteSchema } from "../src/shared/contracts.js";
import type { BrowserRuntimeTarget } from "../src/browser/browser-runtime.js";
import {
  createPublicPluginHarness,
  createTabInventoryRuntime,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";

const hostId = "host-browser-test";
const projectId = "project-browser-test";
const threadId = "thread-browser-test";
const origin = "https://acme.my.salesforce.com";
const profileId = scopedProfileId({ projectId, threadId });
const catalogSchema = z.object({
  selectedProfileId: z.string(),
  sessions: z.array(
    z.object({
      profileId: z.string(),
      state: z.string(),
      sites: z.array(browserSessionSiteSchema),
      recentOrigins: z.array(z.string()),
    }),
  ),
  nextOffset: z.number().nullable(),
  total: z.number(),
});

function resultJson(reply: unknown) {
  const result = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    })
    .parse(reply);
  if (result.isError) throw new Error(result.content[0]?.text);
  return JSON.parse(result.content[0]!.text) as unknown;
}

async function fixture() {
  const calls: BrowserRuntimeTarget[] = [];
  const runtime = createTabInventoryRuntime();
  runtime.execute = async (target) => {
    calls.push(target);
    return "authenticated fixture";
  };
  const browser = await createPublicPluginHarness({
    status: healthyBrowserStatus,
    browserRuntime: runtime,
    sharedProfile: false,
  });
  await browser.runBrowserScriptWithProfile(undefined, {
    destinationOrigin: origin,
  });
  return { browser, calls };
}

describe("discovering and reusing signed-in Browser Profiles", () => {
  it("preserves an unsaved profile selected while thread cleanup waits in the grant queue", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: createTabInventoryRuntime(),
      sharedProfile: false,
      deferSessionSiteUpdate: true,
      deferProfileInventory: true,
      deferProfileInventoryAfterCalls: 3,
    });
    try {
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: origin,
      });
      const report = browser.runBrowserSessions({
        action: "report",
        origin,
        status: "signed-out",
      });
      await browser.sessionSiteUpdateStarted;
      const selection = browser.runBrowserSessions(
        { action: "select", profileId },
        { threadId: "thread-second" },
      );
      await vi.waitFor(() => {
        expect(
          browser.hostRpcCalls.filter((method) => method === "listProfiles"),
        ).toHaveLength(3);
      });
      const deletion = browser.emitThreadEvent("thread.deleted");
      await browser.profileInventoryStarted;
      browser.releaseProfileInventory();
      // Selection is queued ahead of cleanup while the report holds the queue.
      browser.releaseSessionSiteUpdate();
      resultJson(await report);
      resultJson(await selection);
      await deletion;
      const inventory = await browser.runBrowserProfiles(hostId);
      expect(
        inventory.profiles.find((entry) => entry.profileId === profileId),
      ).toMatchObject({ state: "active", reusable: false });
      const catalog = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions(
            { action: "list" },
            { threadId: "thread-second" },
          ),
        ),
      );
      expect(catalog.selectedProfileId).toBe(profileId);
    } finally {
      browser.releaseSessionSiteUpdate();
      browser.releaseProfileInventory();
      await browser.dispose();
    }
  });

  it("keeps a sign-in saved after thread deletion reads an older inventory", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: createTabInventoryRuntime(),
      sharedProfile: false,
      deferProfileInventory: true,
      deferProfileInventoryAfterCalls: 1,
    });
    try {
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: origin,
      });
      const deletion = browser.emitThreadEvent("thread.deleted");
      await browser.profileInventoryStarted;
      await browser.rpc.browser_sign_in_done({ threadId, profileId, origin });
      browser.releaseProfileInventory();
      await deletion;
      const inventory = await browser.runBrowserProfiles(hostId);
      expect(
        inventory.profiles.find((entry) => entry.profileId === profileId),
      ).toMatchObject({ state: "active", reusable: true });
      expect(await browser.listBrowserGrants({ profileId })).toHaveLength(1);
    } finally {
      browser.releaseProfileInventory();
      await browser.dispose();
    }
  });

  it("binds the originating thread consistently before sharing and saving its default", async () => {
    const { browser, calls } = await fixture();
    try {
      resultJson(
        await browser.runBrowserSessions(
          { action: "select", profileId },
          { threadId: "thread-second" },
        ),
      );
      await browser.runBrowserScriptWithProfile(undefined, {
        threadId: "thread-second",
        destinationOrigin: origin,
      });
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: origin,
      });
      expect(calls[0]?.threadPageName).toBeDefined();
      expect(calls[0]?.threadPageName).toBe(calls[2]?.threadPageName);
      expect(calls[1]?.threadPageName).not.toBe(calls[2]?.threadPageName);
      resultJson(
        await browser.runBrowserSessions({
          action: "report",
          origin,
          status: "signed-in",
        }),
      );
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: origin,
      });
      expect(calls[3]?.threadPageName).toBe(calls[0]?.threadPageName);
    } finally {
      await browser.dispose();
    }
  });

  it("lets another thread find the owner's login and reuse its profile with a separate tab", async () => {
    const { browser, calls } = await fixture();
    try {
      await browser.rpc.browser_sign_in_done({
        threadId,
        hostId,
        profileId,
        origin,
      });
      const catalog = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions(
            { action: "list", site: "salesforce" },
            { threadId: "thread-second" },
          ),
        ),
      );
      expect(catalog.sessions).toEqual([
        expect.objectContaining({
          profileId,
          sites: [
            expect.objectContaining({
              origin,
              status: "signed-in",
              source: "owner-confirmed",
            }),
          ],
        }),
      ]);
      expect(catalog.selectedProfileId).not.toBe(profileId);
      resultJson(
        await browser.runBrowserSessions(
          { action: "select", profileId },
          { threadId: "thread-second" },
        ),
      );
      await browser.runBrowserScriptWithProfile(undefined, {
        threadId: "thread-second",
        destinationOrigin: origin,
      });
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: origin,
      });
      expect(calls.map((call) => call.profileId)).toEqual([
        profileId,
        profileId,
        profileId,
      ]);
      expect(calls[0]?.threadPageName).toBe(calls[2]?.threadPageName);
      expect(calls[1]?.threadPageName).not.toBe(calls[2]?.threadPageName);
      expect(calls[1]?.initialOrigin).toBe(origin);
      expect(calls[2]?.initialOrigin).toBe(origin);
      expect(browser.hostRpcCalls).toContain("recordSessionSite");
    } finally {
      await browser.dispose();
    }
  });

  it("shares profiles across projects on the same host without changing the first thread's selection", async () => {
    const { browser, calls } = await fixture();
    try {
      await browser.rpc.browser_sign_in_done({ threadId, profileId, origin });
      const context = {
        threadId: "thread-foreign-project",
        projectId: "project-foreign",
      };
      const catalog = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions(
            { action: "list", site: "salesforce" },
            context,
          ),
        ),
      );
      expect(catalog.sessions[0]?.profileId).toBe(profileId);
      resultJson(
        await browser.runBrowserSessions(
          { action: "select", profileId },
          context,
        ),
      );
      await browser.runBrowserScriptWithProfile(undefined, {
        ...context,
        destinationOrigin: origin,
      });
      expect(calls.at(-1)?.profileId).toBe(profileId);
      const first = catalogSchema.parse(
        resultJson(await browser.runBrowserSessions({ action: "list" })),
      );
      expect(first.selectedProfileId).toBe(profileId);
    } finally {
      await browser.dispose();
    }
  });

  it("retains confirmed logins when the originating thread is deleted", async () => {
    const { browser } = await fixture();
    try {
      await browser.rpc.browser_sign_in_done({ threadId, profileId, origin });
      await browser.emitThreadEvent("thread.deleted");
      const catalog = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions(
            { action: "list", site: "salesforce" },
            { threadId: "thread-second" },
          ),
        ),
      );
      expect(catalog.sessions[0]).toMatchObject({ profileId, state: "active" });
      expect(browser.hostRpcCalls).not.toContain("archiveProfile");
    } finally {
      await browser.dispose();
    }
  });

  it("records expired authentication and keeps unverified activity separate from sign-ins", async () => {
    const { browser } = await fixture();
    try {
      let catalog = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions({
            action: "list",
            site: "salesforce",
          }),
        ),
      );
      expect(catalog.sessions[0]?.sites).toEqual([]);
      expect(catalog.sessions[0]?.recentOrigins).toContain(origin);
      resultJson(
        await browser.runBrowserSessions({
          action: "report",
          origin,
          status: "signed-in",
        }),
      );
      resultJson(
        await browser.runBrowserSessions({
          action: "report",
          origin,
          status: "signed-out",
        }),
      );
      catalog = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions({
            action: "list",
            site: "salesforce",
          }),
        ),
      );
      expect(catalog.sessions[0]?.sites).toEqual([
        expect.objectContaining({
          origin,
          status: "signed-out",
          source: "agent-verified",
        }),
      ]);
    } finally {
      await browser.dispose();
    }
  });

  it("keeps grant revocation effective after selecting a signed-in profile", async () => {
    const { browser } = await fixture();
    try {
      await browser.rpc.browser_sign_in_done({ threadId, profileId, origin });
      const grants = await browser.rpc.browser_grants({
        hostId,
        projectId,
        profileId,
      });
      await browser.rpc.browser_grant_revoke({ grantId: grants[0]!.grantId });
      resultJson(
        await browser.runBrowserSessions(
          { action: "select", profileId },
          { threadId: "thread-second" },
        ),
      );
      const response = await browser.runBrowserScriptWithProfile(undefined, {
        threadId: "thread-second",
        destinationOrigin: origin,
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain("origin_denied");
      const report = await browser.runBrowserSessions({
        action: "report",
        origin,
        status: "signed-in",
      });
      expect(report).toMatchObject({ isError: true });
    } finally {
      await browser.dispose();
    }
  });

  it("paginates discovery, supports CLI selection, and refuses archived profiles", async () => {
    const { browser } = await fixture();
    try {
      const page = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions({ action: "list", limit: 1 }),
        ),
      );
      expect(page.sessions).toHaveLength(1);
      expect(page.nextOffset).toBe(1);
      const cli = await browser.runBrowserCli(
        ["sessions", "select", profileId, "--json"],
        { threadId: "thread-second" },
      );
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ profileId });
      await browser.rpc.browser_profile_archive({ hostId, profileId });
      expect(
        await browser.runBrowserSessions({ action: "select", profileId }),
      ).toMatchObject({ isError: true });
      const archived = catalogSchema.parse(
        resultJson(
          await browser.runBrowserSessions({
            action: "list",
            includeArchived: true,
          }),
        ),
      );
      expect(archived.sessions).toContainEqual(
        expect.objectContaining({ profileId, state: "archived" }),
      );
    } finally {
      await browser.dispose();
    }
  });
});
