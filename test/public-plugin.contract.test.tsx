// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  browserScriptFailureSchema,
  browserStatusSchema,
  DEFAULT_PROFILE_ID,
} from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";

describe("Browser public plugin contract", () => {
  it("opens one full-bleed Setup required panel per profile on an existing thread", async () => {
    const browser = await createPublicPluginHarness();

    const firstOpen = await browser.openExistingThreadPanel();
    const secondOpen = await browser.openExistingThreadPanel();

    expect(firstOpen.layout).toBe("flush");
    expect(firstOpen.params).toEqual({ profileId: DEFAULT_PROFILE_ID });
    expect(firstOpen.created).toBe(true);
    expect(secondOpen.created).toBe(false);
    expect(secondOpen.panel).toBe(firstOpen.panel);
    await firstOpen.panel.findByText("Setup required");
    await browser.dispose();
  });

  it("opens one full-bleed Setup required panel per profile on New thread", async () => {
    const browser = await createPublicPluginHarness();

    const firstOpen = await browser.openNewThreadPanel();
    const secondOpen = await browser.openNewThreadPanel();

    expect(firstOpen.layout).toBe("flush");
    expect(firstOpen.params).toEqual({ profileId: DEFAULT_PROFILE_ID });
    expect(firstOpen.created).toBe(true);
    expect(secondOpen.created).toBe(false);
    expect(secondOpen.panel).toBe(firstOpen.panel);
    await firstOpen.panel.findByText("Setup required");
    await browser.dispose();
  });

  it("reports the typed Setup required state from bb browser status", async () => {
    const browser = await createPublicPluginHarness();

    const cli = await browser.runStatusCli();

    expect(cli.exitCode).toBe(0);
    expect(browserStatusSchema.parse(JSON.parse(cli.stdout))).toEqual(
      browser.expectedStatus,
    );
    await browser.dispose();
  });

  it("returns a typed setup-required tool failure without host mutation", async () => {
    const browser = await createPublicPluginHarness();

    const toolReply = await browser.runBrowserScript();
    const failure = browserScriptFailureSchema.parse(
      JSON.parse(toolReply.content[0]!.text),
    );

    expect(toolReply.isError).toBe(true);
    expect(failure.error).toEqual(browser.expectedStatus);
    expect(browser.hostMutationCount).toBe(0);
    await browser.dispose();
  });

  it("selects the static browser_script tool and bundled Browser skill", async () => {
    const browser = await createPublicPluginHarness();

    const capabilities = await browser.resolveAgentCapabilities();

    expect(capabilities.tools.map((tool) => tool.name)).toEqual([
      "browser_script",
    ]);
    expect(capabilities.skills).toEqual(["browser"]);
    await browser.dispose();
  });
});
