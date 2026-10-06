import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { startSessionCdpProxy } from "../src/browser/session-cdp-proxy.js";

/**
 * Real-browser gate for the per-session CDP proxy. It launches pinned
 * Chromium, so it runs only in the provisioned-host integration gate, like
 * the other *.integration.test.ts files that drive a real browser.
 */
const integrationEnabled = process.env.BB_BROWSER_REAL_INTEGRATION === "1";
const integrationRequired =
  process.env.BB_BROWSER_REAL_INTEGRATION_REQUIRED === "1";
if (integrationRequired && !integrationEnabled) {
  throw new Error("The mandatory real-browser gate cannot be skipped.");
}

async function targetIdOf(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

describe("session CDP proxy on pinned Chromium", () => {
  it.runIf(integrationEnabled)(
    "hides the owner's tab and keeps each session to its own pages",
    async () => {
      const userDataDir = await mkdtemp(join(tmpdir(), "bb-session-proxy-"));
      // The owner's side talks to the real endpoint, as the host does.
      const ownerContext = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      const proxies: Awaited<ReturnType<typeof startSessionCdpProxy>>[] = [];
      const agents: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = [];
      try {
        const ownerPage = ownerContext.pages()[0]!;
        await ownerPage.setContent("<title>owner-marker</title><h1>owner</h1>");
        const ownerUrl = ownerPage.url();
        const ownerTargetId = await targetIdOf(ownerPage);
        const ownerNavigations: string[] = [];
        ownerPage.on("framenavigated", (frame) =>
          ownerNavigations.push(frame.url()),
        );
        const devToolsPort = (
          await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
        ).split("\n")[0]!;
        const upstreamEndpoint = `http://127.0.0.1:${devToolsPort}`;

        const first = await startSessionCdpProxy({ upstreamEndpoint });
        proxies.push(first);
        const firstBrowser = await chromium.connectOverCDP(first.endpoint);
        agents.push(firstBrowser);
        const firstContext = firstBrowser.contexts()[0]!;
        expect(firstContext.pages()).toEqual([]);

        const agentPage = await firstContext.newPage();
        await agentPage.goto("data:text/html,<title>agent</title><p>agent</p>");
        expect(await agentPage.evaluate(() => document.title)).toBe("agent");
        const agentTargetId = await targetIdOf(agentPage);
        expect(first.isOwned(agentTargetId)).toBe(true);
        expect(first.isOwned(ownerTargetId)).toBe(false);

        const [popup] = await Promise.all([
          firstContext.waitForEvent("page"),
          agentPage.evaluate(() => {
            window.open("about:blank#popup");
          }),
        ]);
        await popup.waitForLoadState();
        expect(firstContext.pages()).toEqual([agentPage, popup]);
        expect(first.isOwned(await targetIdOf(popup))).toBe(true);

        const list = (await (
          await fetch(`${first.endpoint}/json/list`)
        ).json()) as { id: string }[];
        expect(list.map((entry) => entry.id)).not.toContain(ownerTargetId);
        expect(list.map((entry) => entry.id)).toContain(agentTargetId);

        const second = await startSessionCdpProxy({ upstreamEndpoint });
        proxies.push(second);
        const secondBrowser = await chromium.connectOverCDP(second.endpoint);
        agents.push(secondBrowser);
        const secondContext = secondBrowser.contexts()[0]!;
        expect(secondContext.pages()).toEqual([]);
        const secondPage = await secondContext.newPage();
        await secondPage.goto("data:text/html,<title>second</title>");
        expect(secondContext.pages()).toEqual([secondPage]);
        expect(second.isOwned(agentTargetId)).toBe(false);
        expect(first.isOwned(await targetIdOf(secondPage))).toBe(false);
        expect(firstContext.pages()).toEqual([agentPage, popup]);

        // A tab the owner opens while agents are connected is auto-attached
        // to every proxy upstream with waitForDebuggerOnStart. The proxy must
        // resume and release it, so it stays usable and stays hidden.
        const ownerSecondTab = await ownerContext.newPage();
        await ownerSecondTab.setContent("<title>owner-second</title>");
        expect(await ownerSecondTab.evaluate(() => 1 + 1)).toBe(2);
        const ownerSecondId = await targetIdOf(ownerSecondTab);
        expect(firstContext.pages()).toEqual([agentPage, popup]);
        expect(secondContext.pages()).toEqual([secondPage]);

        const browserSession = await firstBrowser.newBrowserCDPSession();
        const { targetInfos } = await browserSession.send("Target.getTargets");
        const visibleIds = targetInfos.map((info) => info.targetId);
        expect(visibleIds).toContain(agentTargetId);
        expect(visibleIds).not.toContain(ownerTargetId);
        expect(visibleIds).not.toContain(ownerSecondId);
        await expect(
          browserSession.send("Target.attachToTarget", {
            targetId: ownerTargetId,
            flatten: true,
          }),
        ).rejects.toThrow("Target is not available in this browser session.");
        await browserSession.detach();

        expect(ownerPage.isClosed()).toBe(false);
        expect(ownerPage.url()).toBe(ownerUrl);
        expect(await ownerPage.title()).toBe("owner-marker");
        expect(ownerNavigations).toEqual([]);
      } finally {
        for (const agent of agents) await agent.close().catch(() => undefined);
        for (const proxy of proxies) await proxy.close();
        await ownerContext.close();
        await rm(userDataDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
