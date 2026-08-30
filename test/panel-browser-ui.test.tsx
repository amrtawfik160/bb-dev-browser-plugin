// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import { browserStatusSchema, DEFAULT_PROFILE_ID } from "../contracts.js";
import {
  createPublicPluginHarness,
  createTabInventoryRuntime,
  healthyBrowserStatus,
} from "./public-plugin-harness.js";

/**
 * jsdom lays nothing out and has no ResizeObserver, so the panel's own size is
 * driven here instead of measured. The stub reports what a real observer would
 * report when the owner drags a panel edge.
 */
function installResizeObserverStub() {
  const callbacks: ResizeObserverCallback[] = [];
  const original = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  class StubResizeObserver implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    StubResizeObserver;
  return {
    resizeTo(size: { width: number; height: number }) {
      for (const callback of callbacks) {
        callback(
          [{ contentRect: size } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      }
    },
    restore() {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    },
  };
}

/** Every viewport this panel asked the shared session to capture at. */
function reportedViewports(panel: RenderedSlot) {
  return panel.inspection.rpcCalls
    .filter((call) => call.method === "browser_panel_control")
    .map((call) => (call.input as { viewport?: unknown }).viewport)
    .filter((viewport) => viewport !== undefined);
}

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

  it("keeps session actions in the overflow menu and management out of the panel", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      navigationResponse: {
        address: { kind: "address", url: "http://localhost:4173/" },
        location: { url: "http://localhost:4173/" },
        tabId: "shared-tab-1",
      },
    });
    try {
      const panel = browser.renderPanel();
      // Nothing configured once sits above the page: profiles, agent access,
      // activity, and downloads are managed in Browser Settings.
      await panel.findByLabelText("Address or search");
      expect(panel.queryByRole("combobox", { name: "Browser Profile" })).toBe(
        null,
      );
      expect(
        panel.queryByLabelText("Browser Host Downloads quarantine"),
      ).toBeNull();
      expect(panel.container.textContent).not.toContain("Browser Activity");

      fireEvent.click(
        await panel.findByRole("button", { name: "Browser options" }),
      );
      const menu = await panel.findByRole("menu", { name: "Browser options" });
      expect(menu.textContent).toMatch(/settings/iu);
      // A rarely-used compatibility toggle is a menu item, not a permanent
      // checkbox under the address bar.
      const rawLocalhost = within(menu).getByRole("menuitemcheckbox", {
        name: /plain localhost/iu,
      });
      expect(rawLocalhost.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(rawLocalhost);
      await waitFor(() =>
        expect(rawLocalhost.getAttribute("aria-checked")).toBe("true"),
      );

      const address = await panel.findByLabelText("Address or search");
      fireEvent.change(address, { target: { value: "localhost:4173" } });
      fireEvent.submit(address);
      await waitFor(() => expect(browser.navigationRequests).toHaveLength(1));
      expect(browser.navigationRequests[0]).toMatchObject({
        rawLocalhost: true,
      });
    } finally {
      await browser.dispose();
    }
  });

  it("says where this browser runs and where it is managed when asked", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
    });
    try {
      const panel = browser.renderPanel();

      fireEvent.click(
        await panel.findByRole("button", { name: "Browser status: Ready" }),
      );
      const hint = await panel.findByText(/ready on/iu);
      expect(hint.textContent).toMatch(/browser contract host/iu);
      expect(hint.textContent).toMatch(/settings/iu);
    } finally {
      await browser.dispose();
    }
  });

  it("asks the host to capture at the panel's own size, once a resize settles", async () => {
    const resizes = installResizeObserverStub();
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
    });
    try {
      const panel = browser.renderPanel();
      await panel.findByLabelText("Address or search");

      // Dragging a panel edge produces a stream of sizes; only the size the
      // owner let go at reaches the live page.
      act(() => {
        resizes.resizeTo({ width: 900.4, height: 600.6 });
        resizes.resizeTo({ width: 1024, height: 768 });
      });
      await waitFor(() => expect(reportedViewports(panel)).toHaveLength(1), {
        timeout: 5_000,
      });
      expect(reportedViewports(panel)[0]).toEqual({
        width: 1024,
        height: 768,
      });
    } finally {
      await browser.dispose();
      resizes.restore();
    }
  });

  it("shows no other clients when the owner browses alone, and counts them when they arrive", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
    });
    try {
      const panel = browser.renderPanel();
      await panel.findByLabelText("Address or search");
      // "0 spectators" is precise and tells a solitary owner nothing.
      expect(panel.container.textContent).not.toMatch(/watching/iu);

      browser.renderPanel();
      await waitFor(
        () => expect(panel.container.textContent).toMatch(/1 watching/iu),
        { timeout: 5_000 },
      );
    } finally {
      await browser.dispose();
    }
  });

  it("marks the page and names the purpose while an agent drives the browser, and clears when it stops", async () => {
    let releaseAgent!: () => void;
    const agentFinished = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: {
        ...createTabInventoryRuntime(),
        execute: async () => {
          await agentFinished;
          return "";
        },
      },
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Agent control target",
      });
      await browser.createBrowserGrant({
        projectId: "project-browser-test",
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        originScope: "https://agent-control.example.test",
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      });
      const script = browser.runBrowserScriptWithProfile(undefined, {
        purpose: "Book the flight",
        destinationOrigin: "https://agent-control.example.test",
      });

      const panel = browser.renderPanel();
      // The owner never mistakes agent-driven navigation for their own: the
      // page is marked and the agent says what it is doing.
      await panel.findByText(/Book the flight/u, undefined, { timeout: 5_000 });
      const page = await panel.findByRole("region", { name: "Browser page" });
      expect(page.getAttribute("style")).toContain("box-shadow");
      // And the owner can take the browser back from here.
      await panel.findByRole("button", { name: "Interrupt the agent" });

      releaseAgent();
      await script;
      // The moment the agent gives control back, the panel stops saying it has
      // it.
      await waitFor(
        () => expect(panel.queryByText(/Book the flight/u)).toBeNull(),
        { timeout: 5_000 },
      );
      expect(
        (
          await panel.findByRole("region", { name: "Browser page" })
        ).getAttribute("style") ?? "",
      ).not.toContain("box-shadow");
    } finally {
      await browser.dispose();
    }
  });

  it("asks about a denied site by name, with allowing that one site the primary answer", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: createTabInventoryRuntime(),
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Denied site target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://denied-site.example.test",
      });
      expect(denied.isError).toBe(true);

      const panel = browser.renderPanel();
      const question = await panel.findByRole("region", {
        name: "Site access requests",
      });
      expect(question.textContent).toContain(
        "https://denied-site.example.test",
      );
      // Nothing on screen is an identifier the owner cannot act on.
      expect(panel.container.textContent).not.toMatch(/grant-request-/u);
      await panel.findByRole("button", {
        name: "Deny https://denied-site.example.test",
      });
      await panel.findByRole("button", {
        name: "Allow every site for this project",
      });

      fireEvent.click(
        panel.getByRole("button", {
          name: "Allow https://denied-site.example.test",
        }),
      );

      // Answering it grants this project that one site and takes the question
      // off the panel.
      await waitFor(() =>
        expect(
          panel.queryByRole("region", { name: "Site access requests" }),
        ).toBeNull(),
      );
      const grants = await browser.listBrowserGrants({
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
      });
      expect(grants.map((grant) => grant.originScope)).toContain(
        "https://denied-site.example.test",
      );
      expect(grants.every((grant) => !grant.wholeWeb)).toBe(true);
    } finally {
      await browser.dispose();
    }
  });

  it("trusts the whole project from the panel when the owner is tired of being asked", async () => {
    const browser = await createPublicPluginHarness({
      status: healthyBrowserStatus,
      browserRuntime: createTabInventoryRuntime(),
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Trust project target",
      });
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://trust-project.example.test",
      });

      const panel = browser.renderPanel();
      await panel.findByRole("region", { name: "Site access requests" });
      fireEvent.click(
        panel.getByRole("button", {
          name: "Allow every site for this project",
        }),
      );

      await waitFor(() =>
        expect(
          panel.queryByRole("region", { name: "Site access requests" }),
        ).toBeNull(),
      );
      const grants = await browser.listBrowserGrants({
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
      });
      expect(grants.some((grant) => grant.wholeWeb)).toBe(true);
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
