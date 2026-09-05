// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../src/shared/contracts.js";
import { ownerSessionIdFromContext } from "../src/shared/panel-owner-session.js";
import {
  createPublicPluginHarness,
  healthyBrowserStatus as healthyStatus,
} from "./public-plugin-harness.js";

const HOST_ID = "host-browser-test";
const THREAD_SESSION = ownerSessionIdFromContext({
  projectId: null,
  threadId: "thread-browser-test",
});
const PROJECT_SESSION = ownerSessionIdFromContext({
  projectId: "project-browser-test",
  threadId: null,
});

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
      ownerSessionId: THREAD_SESSION,
    });
    expect(first.role).toBe("controller");
    expect(first.control.controllerPanelId).toBe("panel-a");

    const second = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
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
      ownerSessionId: THREAD_SESSION,
    });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
    });

    const transferred = await browser.runBrowserTakeControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
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
      ownerSessionId: THREAD_SESSION,
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
      ownerSessionId: THREAD_SESSION,
    });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
    });

    // Release the controller so control becomes available, then take it from
    // the second panel.
    await browser.runBrowserReleaseControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: THREAD_SESSION,
    });
    const takeover = await browser.runBrowserTakeControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
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
      ownerSessionId: THREAD_SESSION,
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
      ownerSessionId: THREAD_SESSION,
    });
    // Reconnecting the same panel id resumes its role rather than duplicating.
    const reconnect = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: THREAD_SESSION,
    });
    expect(
      reconnect.control.panels.filter((p) => p.panelId === "panel-a"),
    ).toHaveLength(1);
    expect(reconnect.control.controllerPanelId).toBe("panel-a");
    await browser.dispose();
  });

  it("lets two owner sessions share one controller and both observe a transfer", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    // Two owner sessions open panels for the same profile; the first is the
    // controller and the second is view-only, but both observe the shared state.
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: THREAD_SESSION,
    });
    const second = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
    });
    expect(second.role).toBe("spectator");
    expect(second.control.panels).toHaveLength(2);

    const transferred = await browser.runBrowserTakeControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
    });
    expect(transferred.role).toBe("controller");

    // The first owner session observes the transfer through the shared state.
    const firstObserved = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: THREAD_SESSION,
    });
    expect(firstObserved.role).toBe("spectator");
    expect(firstObserved.control.controllerPanelId).toBe("panel-b");
    await browser.dispose();
  });

  it("drives layout from the controller viewport and keeps spectators from resizing it", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    // The first panel becomes the controller and its viewport drives layout.
    const first = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: THREAD_SESSION,
      viewport: { width: 1280, height: 720 },
    });
    expect(first.control.controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });
    // A second panel connects with a different viewport but is a spectator.
    const second = await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
      viewport: { width: 800, height: 600 },
    });
    expect(second.role).toBe("spectator");
    // The spectator's own viewport is recorded for its letterbox, not the page.
    const spectatorEntry = second.control.panels.find(
      (panel) => panel.panelId === "panel-b",
    );
    expect(spectatorEntry?.viewport).toEqual({ width: 800, height: 600 });
    // The shared controller viewport is unchanged by the spectator connecting.
    expect(second.control.controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });
    // Transferring control carries the new controller's viewport to every panel.
    const transferred = await browser.runBrowserTakeControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
      viewport: { width: 1600, height: 900 },
    });
    expect(transferred.control.controllerViewport).toEqual({
      width: 1600,
      height: 900,
    });
    await browser.dispose();
  });

  it("does not re-grant input on reclaim without an active reclaim window", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    await browser.runBrowserPanelControl({
      ...target(),
      panelId: "panel-a",
      ownerSessionId: THREAD_SESSION,
    });
    // A spectator with no disconnect/reclaim window that calls reclaim stays
    // view-only; reclaim only re-grants input within the 10-second window after
    // a controller disconnect.
    const reclaim = await browser.runBrowserReclaimControl({
      ...target(),
      panelId: "panel-b",
      ownerSessionId: PROJECT_SESSION,
    });
    expect(reclaim.role).toBe("spectator");
    expect(reclaim.control.controllerPanelId).toBe("panel-a");
    await browser.dispose();
  });

  it("takes the panel's own size as the shared viewport, clamped to the streaming ceiling", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    try {
      const joined = await browser.runBrowserPanelControl({
        ...target(),
        panelId: "panel-a",
        ownerSessionId: THREAD_SESSION,
        viewport: { width: 1024, height: 768 },
      });
      expect(joined.control.controllerViewport).toEqual({
        width: 1024,
        height: 768,
      });

      // A resize reports the new size through the same call, so what the host
      // captures is what the owner is looking at rather than a fixed size
      // unrelated to the panel.
      const resized = await browser.runBrowserPanelControl({
        ...target(),
        panelId: "panel-a",
        ownerSessionId: THREAD_SESSION,
        viewport: { width: 1440, height: 900 },
      });
      expect(resized.control.controllerViewport).toEqual({
        width: 1440,
        height: 900,
      });

      // ADR 0007 sets a ceiling, and a panel wider than it never asks for more.
      const clamped = await browser.runBrowserPanelControl({
        ...target(),
        panelId: "panel-a",
        ownerSessionId: THREAD_SESSION,
        viewport: { width: 5000, height: 4000 },
      });
      expect(clamped.control.controllerViewport).toEqual({
        width: 1920,
        height: 1080,
      });

      // A second client letterboxes the controller's viewport; its own size
      // never resizes the shared page.
      const spectator = await browser.runBrowserPanelControl({
        ...target(),
        panelId: "panel-b",
        ownerSessionId: PROJECT_SESSION,
        viewport: { width: 400, height: 300 },
      });
      expect(spectator.role).toBe("spectator");
      expect(spectator.control.controllerViewport).toEqual({
        width: 1920,
        height: 1080,
      });
    } finally {
      await browser.dispose();
    }
  });

  it("gives the panel that holds control the address bar, and a second panel the way to take it", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });
    try {
      const controller = browser.renderPanel();
      const spectator = browser.renderPanel();

      // The panel that holds control drives the browser, so it gets the
      // address bar and the history controls.
      await controller.findByLabelText("Address or search");
      await controller.findByRole("button", { name: "Go back" });

      // The second client is view-only, so where the address bar would be it
      // gets the one action that changes that.
      await waitFor(() =>
        expect(spectator.queryByLabelText("Address or search")).toBeNull(),
      );
      await spectator.findByRole("button", { name: "Take control" });
      expect(spectator.queryByRole("button", { name: "Go back" })).toBeNull();
    } finally {
      await browser.dispose();
    }
  });
});
