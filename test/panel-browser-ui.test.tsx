// @vitest-environment jsdom
import { fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { browserStatusSchema } from "../contracts.js";
import {
  createPublicPluginHarness,
  createTabInventoryRuntime,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";

/**
 * The Browser Panel the owner actually sees (issue #50), asserted through the
 * real plugin rather than through re-declared components: the harness boots
 * the server plugin, the retained host worker, transactional storage, and the
 * panel protocol, and `renderPanel` mounts the panel the BB app mounts.
 *
 * Every assertion here is about what the owner can see and do — accessible
 * roles, labels, and text — so renaming a component leaves them passing while
 * a regression in the interface fails them.
 */
describe("Browser Panel", () => {
  it("mounts an independent client per panel, so a second panel is a second client", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
    });
    try {
      const first = browser.renderPanel();
      const second = browser.renderPanel();

      expect(second).not.toBe(first);
      expect(first.container.innerHTML).not.toBe("");
      expect(second.container.innerHTML).not.toBe("");
      // Each panel joins the shared session as its own client: two distinct
      // panel identities ask for their own stream authorization, which is what
      // makes a controller and a view-only spectator observable through this
      // seam.
      await waitFor(() =>
        expect(browser.panelCapabilityRequests.length).toBe(2),
      );
      const [firstRequest, secondRequest] = browser.panelCapabilityRequests;
      expect(firstRequest!.panelId).not.toBe(secondRequest!.panelId);
    } finally {
      await browser.dispose();
    }
  });

  it("gives a healthy host a browser toolbar and no readiness checklist", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
    });
    try {
      const panel = browser.renderPanel();

      // The toolbar is the whole of the chrome: history, one omnibox, the host
      // indicator, and everything else behind the options menu.
      await panel.findByRole("button", { name: "Go back" });
      await panel.findByRole("button", { name: "Go forward" });
      await panel.findByRole("button", { name: "Reload page" });
      await panel.findByRole("button", { name: "Browser status: Ready" });
      await panel.findByRole("button", { name: "Browser options" });
      const address = await panel.findByLabelText("Address or search");
      expect(address.tagName).toBe("INPUT");

      // A browser's address bar has no Go button, and a healthy host has
      // nothing to say about its own readiness.
      expect(panel.queryByRole("button", { name: "Go" })).toBeNull();
      expect(panel.queryByLabelText("Host readiness checklist")).toBeNull();
      // Automation Mode is the normal mode; announcing it permanently tells
      // the owner nothing (ADR 0014).
      expect(panel.container.textContent).not.toContain("Automation Mode");
    } finally {
      await browser.dispose();
    }
  });

  it("navigates from the omnibox on Enter and then shows where the browser is", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      navigationResponse: {
        address: { kind: "address", url: "https://example.test/account" },
        location: { url: "https://example.test/account" },
        tabId: "shared-tab-1",
      },
    });
    try {
      const panel = browser.renderPanel();
      const address = await panel.findByLabelText("Address or search");

      fireEvent.change(address, { target: { value: "example.test/account" } });
      fireEvent.submit(address);

      await waitFor(() => expect(browser.navigationRequests).toHaveLength(1));
      expect(browser.navigationRequests[0]).toMatchObject({
        input: "example.test/account",
        rawLocalhost: false,
      });
      await waitFor(() =>
        expect((address as HTMLInputElement).value).toBe(
          "https://example.test/account",
        ),
      );
    } finally {
      await browser.dispose();
    }
  });

  it.each([
    ["setup-required", "setup_required", "Setup required"],
    ["host-offline", "host_offline", "Host offline"],
    ["repair-required", "repair_required", "Repair required"],
    ["unsupported", "unsupported", "Unsupported"],
    ["safe-login-elsewhere", "safe_login_elsewhere", "Safe Login elsewhere"],
  ] as const)(
    "replaces the page with the failure when the host is %s",
    async (state, code, label) => {
      const browser = await createPublicPluginHarness({
        status: browserStatusSchema.parse({
          ...healthyBrowserStatus,
          state,
          code,
          label,
          message: `The host reports ${label}.`,
        }),
      });
      try {
        const panel = browser.renderPanel();

        await panel.findByRole("status", { name: label });
        // There is nothing to browse, so there is no browser: the failure and
        // the readiness detail that explains it take the panel.
        await panel.findByLabelText("Host readiness checklist");
        expect(panel.queryByLabelText("Address or search")).toBeNull();
        expect(
          panel.queryByRole("region", { name: "Browser page" }),
        ).toBeNull();
      } finally {
        await browser.dispose();
      }
    },
  );

  it.each([
    ["sleeping", "sleeping", "Sleeping"],
    ["waking", "waking", "Waking"],
  ] as const)(
    "keeps the browser on screen while the instance is %s",
    async (state, code, label) => {
      const browser = await createPublicPluginHarness({
        status: browserStatusSchema.parse({
          ...healthyBrowserStatus,
          state,
          code,
          label,
          message: `The instance is ${label.toLowerCase()}.`,
        }),
      });
      try {
        const panel = browser.renderPanel();

        // These resolve themselves in seconds; blanking the page for them
        // would read as a fault. The toolbar says so instead.
        await panel.findByLabelText("Address or search");
        await panel.findByRole("region", { name: "Browser page" });
        await panel.findByRole("status", { name: label });
        expect(panel.queryByLabelText("Host readiness checklist")).toBeNull();
      } finally {
        await browser.dispose();
      }
    },
  );

  it("lands on a new-tab surface with the address focused when there is nothing to restore", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
    });
    try {
      const panel = browser.renderPanel();

      const landing = await panel.findByRole("region", { name: "New tab" });
      // The owner learns where this browser runs and how agents get to use it,
      // rather than staring at a blank canvas that reads as a failed load.
      expect(landing.textContent).toMatch(/runs on/iu);
      expect(landing.textContent).toMatch(/bb browser trust/u);
      const address = await panel.findByLabelText("Address or search");
      await waitFor(() => expect(document.activeElement).toBe(address));
    } finally {
      await browser.dispose();
    }
  });

  it("starts the Browser Instance when the panel opens", async () => {
    const runtime = createTabInventoryRuntime();
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: runtime,
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Startup panel",
      });
      browser.renderPanel();

      // Opening the panel is what wakes the browser and restores the session:
      // the owner never has to find a separate action for it.
      await waitFor(() => expect(runtime.pinnedPanelIds).toHaveLength(1));
    } finally {
      await browser.dispose();
    }
  });

  it("lists, opens, switches, and closes tabs in the shared strip", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: createTabInventoryRuntime(),
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Tab strip panel",
      });
      const panel = browser.renderPanel();
      const strip = await panel.findByRole("list", { name: "Browser tabs" });
      // The strip says the tabs are not this panel's: another BB panel on the
      // same browser shows exactly these.
      expect(
        (await panel.findByText("Shared tabs")).getAttribute("title"),
      ).toMatch(/every bb panel/iu);

      const newTab = await panel.findByRole("button", {
        name: "Open a new tab",
      });
      fireEvent.click(newTab);
      await waitFor(() =>
        expect(within(strip).getAllByRole("listitem")).toHaveLength(1),
      );
      fireEvent.click(newTab);
      await waitFor(() =>
        expect(within(strip).getAllByRole("listitem")).toHaveLength(2),
      );

      // Switching marks the chosen tab as the one the browser is on, for every
      // panel using it.
      const [first] = within(strip).getAllByRole("button", { name: "New tab" });
      fireEvent.click(first!);
      await waitFor(() =>
        expect(first!.getAttribute("aria-current")).toBe("page"),
      );

      fireEvent.click(
        within(strip).getAllByRole("button", { name: "Close New tab" })[0]!,
      );
      await waitFor(() =>
        expect(within(strip).getAllByRole("listitem")).toHaveLength(1),
      );
    } finally {
      await browser.dispose();
    }
  });
});
