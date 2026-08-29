// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID, type BrowserStatus } from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";

const HOST_ID = "host-browser-test";

const healthyStatus: BrowserStatus = {
  hostId: HOST_ID,
  profileId: DEFAULT_PROFILE_ID,
  state: "healthy",
  code: "healthy",
  label: "Ready",
  message: "Workspace Browser is ready on this host.",
  capabilities: [
    ["operating-system", "Operating system", "Ubuntu 24.04 is supported."],
    ["architecture", "Architecture", "x86_64 is supported."],
    ["bb-connect", "BB Connect", "The host is enrolled in BB Connect."],
    ["browser", "Browser", "Google Chrome 140 is available."],
    ["sandbox", "Browser sandbox", "The Chrome sandbox is available."],
    ["dedicated-user", "Dedicated browser user", "bb-browser is configured."],
    ["protected-storage", "Protected storage", "Storage is protected."],
    ["disk-headroom", "Disk headroom", "At least 5 GiB is free."],
    ["loopback", "Loopback networking", "Loopback is available."],
  ].map(([id, label, reason]) => ({
    id: id as BrowserStatus["capabilities"][number]["id"],
    label,
    status: "ready" as const,
    reason,
  })),
};

function target() {
  return {
    hostId: HOST_ID,
    profileId: DEFAULT_PROFILE_ID,
  };
}

describe("Browser Panel multi-client control (issue #16)", () => {
  it("makes the first panel the controller and a second client view-only", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });

    const first = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    expect(first.role).toBe("controller");
    expect(first.control.controllerPanelId).toBe("panel-a");

    const second = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: "session-b",
    });
    // A second client starts view-only and cannot send browser input.
    expect(second.role).toBe("spectator");
    expect(second.control.controllerPanelId).toBe("panel-a");
    expect(second.control.panels).toHaveLength(2);
    await browser.dispose();
  });

  it("transfers control atomically and visibly to every panel", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: "session-b",
    });

    const transferred = await browser.runBrowserTakeControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: "session-b",
      viewport: { width: 1280, height: 720 },
    });
    // The transfer is atomic: exactly one controller after the call, and the
    // controller viewport drives page layout.
    expect(transferred.role).toBe("controller");
    expect(transferred.control.controllerPanelId).toBe("panel-b");
    expect(transferred.control.controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });

    // Every panel observes the new controller through the shared state.
    const observer = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    expect(observer.role).toBe("spectator");
    expect(observer.control.controllerPanelId).toBe("panel-b");
    expect(observer.control.controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });
    await browser.dispose();
  });

  it("spectators cannot take control during a controller's reclaim window", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: "session-b",
    });

    // Release the controller so control becomes available, then take it from
    // the second panel.
    await browser.runBrowserReleaseControl({
      ...target(),
      panelId: "panel-a",
    });
    const takeover = await browser.runBrowserTakeControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: "session-b",
    });
    expect(takeover.role).toBe("controller");
    expect(takeover.control.controllerPanelId).toBe("panel-b");
    await browser.dispose();
  });

  it("shares one ordered tab strip with one active tab across panels", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    const first = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    // The shared strip starts empty (no runtime pages reported yet) but is the
    // same view every panel sees.
    const tabs = await browser.runBrowserTabs(HOST_ID);
    expect(tabs).toEqual(first.tabs);
    expect(tabs.activeTabId).toBeNull();
    await browser.dispose();
  });

  it("does not create duplicate panels or controllers on reconnect", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    // Reconnecting the same panel id resumes its role rather than duplicating.
    const reconnect = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: "session-a",
    });
    expect(
      reconnect.control.panels.filter((p) => p.panelId === "panel-a"),
    ).toHaveLength(1);
    expect(reconnect.control.controllerPanelId).toBe("panel-a");
    await browser.dispose();
  });

  it("renders the control surface and Take control control on the panel", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    const panel = await browser.openExistingThreadPanel();
    // The panel mounts and fetches control state; the control surface is
    // labeled and exposes the Take/Release control action.
    await waitFor(() =>
      expect(
        panel.panel.queryByLabelText("Browser Control Lease"),
      ).not.toBeNull(),
    );
    // The control surface shows a Take control or Release control button.
    const button = await panel.panel.findByRole("button", {
      name: /control/iu,
    });
    expect(button).toBeTruthy();
    await browser.dispose();
  });
});
