// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  DEFAULT_PROFILE_ID,
  PANEL_AUTH_ROTATION_MS,
  PANEL_CAPABILITY_TTL_MS,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_RECLAIM_WINDOW_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
} from "../contracts.js";
import { waitForSettled } from "./wait.js";
import { ownerSessionIdFromContext } from "../panel-owner-session.js";
import { createPublicPanelLifecycleHarness } from "./public-plugin-lifecycle-harness.js";
import { createTabInventoryRuntime } from "./public-plugin-harness.js";

const LIFECYCLE_HOST_COMMANDS = new Set([
  "panelTransport",
  "panelVisibility",
  "panelRelease",
]);

const PANEL_OPERATION_HOST_COMMANDS = new Set([
  ...LIFECYCLE_HOST_COMMANDS,
  "navigate",
  "history",
  "tabAction",
  "tabs",
  "panelControl",
  "takeControl",
  "releaseControl",
  "reclaimControl",
]);

function lifecycleHostCommands(calls: readonly string[]) {
  return calls.filter((method) => LIFECYCLE_HOST_COMMANDS.has(method));
}

function panelOperationHostCommands(calls: readonly string[]) {
  return calls.filter((method) => PANEL_OPERATION_HOST_COMMANDS.has(method));
}

describe("public Browser Panel lifecycle seam", () => {
  it("restores the runtime tab inventory when a fresh panel session opens", async () => {
    const runtime = createTabInventoryRuntime();
    const restored = await runtime.openPage({
      hostId: "ci-host",
      profileId: DEFAULT_PROFILE_ID,
      locale: "en-US",
      timezone: "UTC",
    });
    const browser = await createPublicPanelLifecycleHarness({
      browserRuntime: runtime,
    });
    try {
      const strip = await browser.rpc.browser_tabs({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
      });
      expect(strip.tabs.map((tab) => tab.tabId)).toContain(restored.id);
      expect(strip.activeTabId).toBe(restored.id);
    } finally {
      await browser.dispose();
    }
  });
  it.each([false, true])(
    "copies an address to the displaying client's clipboard and reports refusal (%s)",
    async (refused) => {
      const writeText = vi.fn(async () => {
        if (refused) throw new Error("Permission denied");
      });
      const previousClipboard = Object.getOwnPropertyDescriptor(
        navigator,
        "clipboard",
      );
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const browser = await createPublicPanelLifecycleHarness({
        contextActions: [
          {
            actionId: "copy-link",
            kind: "copy-link",
            label: "Copy link address",
            targetUrl: "https://example.test/link",
          },
        ],
      });
      try {
        const [owner] = await browser.openTwoPanels();
        const canvas = await owner.findByRole("img", {
          name: "Browser page view",
        });
        canvas.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
        fireEvent.contextMenu(canvas, { clientX: 200, clientY: 200 });
        fireEvent.click(
          await owner.findByRole("menuitem", { name: "Copy link address" }),
        );
        await waitFor(() =>
          expect(writeText).toHaveBeenCalledExactlyOnceWith(
            "https://example.test/link",
          ),
        );
        if (refused) {
          expect((await owner.findByRole("alert")).textContent).toContain(
            "Could not copy the address",
          );
        } else {
          expect(owner.queryByRole("alert")).toBeNull();
        }
      } finally {
        await browser.dispose();
        if (previousClipboard === undefined)
          Reflect.deleteProperty(navigator, "clipboard");
        else Object.defineProperty(navigator, "clipboard", previousClipboard);
      }
    },
  );

  it("ignores letterbox margins, pastes text, and releases held input when the owner leaves the page", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [owner] = await browser.openTwoPanels();
      const canvas = await owner.findByRole("img", {
        name: "Browser page view",
      });
      const textInput = owner.getByRole("textbox", {
        name: "Browser page keyboard input",
      });
      canvas.getBoundingClientRect = () => new DOMRect(0, 0, 960, 960);
      fireEvent.mouseDown(canvas, { clientX: 480, clientY: 10 });
      fireEvent.wheel(canvas, { clientX: 480, clientY: 10, deltaY: 100 });
      fireEvent.mouseDown(canvas, { clientX: 480, clientY: 480, buttons: 1 });
      fireEvent.paste(textInput, {
        clipboardData: { getData: () => "café" },
      });
      fireEvent.keyDown(textInput, {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
      });
      fireEvent.keyDown(textInput, { key: "Escape", shiftKey: true });
      await waitFor(() => expect(browser.receivedInputs).toHaveLength(5));
      expect(browser.receivedInputs).toEqual([
        expect.objectContaining({
          kind: "mouse",
          action: "mousePressed",
          x: 960,
          y: 540,
        }),
        { kind: "text", text: "café" },
        expect.objectContaining({
          kind: "key",
          action: "keyDown",
          key: "Shift",
        }),
        expect.objectContaining({ kind: "key", action: "keyUp", key: "Shift" }),
        expect.objectContaining({
          kind: "mouse",
          action: "mouseReleased",
          buttons: 0,
        }),
      ]);
      expect(document.activeElement).not.toBe(canvas);
    } finally {
      await browser.dispose();
    }
  });

  it("forwards owner clicks, typing, and scrolling from the rendered page and blocks spectators", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [owner, spectator] = await browser.openTwoPanels();
      const canvas = await owner.findByRole("img", {
        name: "Browser page view",
      });
      const textInput = owner.getByRole("textbox", {
        name: "Browser page keyboard input",
      });
      const otherCanvas = await spectator.findByRole("img", {
        name: "Browser page view",
      });
      for (const surface of [canvas, otherCanvas]) {
        surface.getBoundingClientRect = () => new DOMRect(10, 20, 960, 540);
      }
      fireEvent.mouseDown(canvas, { clientX: 490, clientY: 290, button: 0 });
      fireEvent.mouseUp(canvas, { clientX: 490, clientY: 290, button: 0 });
      fireEvent.keyDown(textInput, { key: "a", code: "KeyA", keyCode: 65 });
      fireEvent.keyUp(textInput, { key: "a", code: "KeyA", keyCode: 65 });
      fireEvent.wheel(canvas, { clientX: 490, clientY: 290, deltaY: 120 });
      await waitFor(() => expect(browser.receivedInputs).toHaveLength(5));
      expect(browser.receivedInputs).toEqual([
        expect.objectContaining({
          kind: "mouse",
          action: "mousePressed",
          x: 960,
          y: 540,
        }),
        expect.objectContaining({
          kind: "mouse",
          action: "mouseReleased",
          x: 960,
          y: 540,
        }),
        expect.objectContaining({
          kind: "key",
          action: "keyDown",
          key: "a",
          text: "a",
        }),
        expect.objectContaining({ kind: "key", action: "keyUp", key: "a" }),
        expect.objectContaining({ kind: "wheel", x: 960, y: 540, deltaY: 240 }),
      ]);
      fireEvent.mouseDown(otherCanvas, { clientX: 490, clientY: 290 });
      fireEvent.keyDown(otherCanvas, { key: "x" });
      fireEvent.wheel(otherCanvas, { deltaY: 120 });
      fireEvent.keyDown(textInput, { key: "k", ctrlKey: true });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(browser.receivedInputs).toHaveLength(5);
      await browser.forcePhysicalSocketLoss(owner);
      await owner.findByText("Reconnecting to the browser…");
      fireEvent.mouseDown(canvas, { clientX: 490, clientY: 290 });
      fireEvent.keyDown(textInput, { key: "x" });
      fireEvent.wheel(canvas, { clientX: 490, clientY: 290, deltaY: 120 });
      expect(browser.receivedInputs).toHaveLength(5);
    } finally {
      await browser.dispose();
    }
  });

  it("gives two rendered Browser Panels distinct identities that redeem a Panel Capability and become ready", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();

      expect(first.panelId).not.toBe(second.panelId);
      expect(first.panelId).toMatch(/^browser-panel-/);
      expect(second.panelId).toMatch(/^browser-panel-/);
      expect(first.ownerSessionId).toBe(browser.ownerSessionId);
      expect(second.ownerSessionId).toBe(browser.ownerSessionId);
      expect(first.ownerSessionId).toBe(
        `bb-owner-session:thread:${browser.threadId}`,
      );
      expect(browser.threadLookups).not.toContain("panel-capability");
      expect(first.hostId).toBe(browser.hostId);
      expect(first.profileId).toBe(DEFAULT_PROFILE_ID);
      expect(first.capabilityId).not.toBe(second.capabilityId);

      expect(first.redeemed).toBe(true);
      expect(second.redeemed).toBe(true);
    } finally {
      await browser.dispose();
    }
  });

  it("joins two panels on one Browser Profile into a shared session and isolates another profile", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await waitFor(() => {
        const members = browser
          .latestSessionPanels(first)
          .map((panel) => panel.panelId);
        expect(members.sort()).toEqual([first.panelId, second.panelId].sort());
      });
      expect(
        browser
          .latestSessionPanels(second)
          .map((panel) => panel.panelId)
          .sort(),
      ).toEqual([first.panelId, second.panelId].sort());

      const created = await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Isolated session",
      });
      const isolated = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: created.profileId,
        panelId: "panel-isolated-profile",
        ownerSessionId: browser.ownerSessionId,
      });
      expect(isolated.outcome).toBe("issued");
      await waitForSettled(() => {
        const members = browser
          .latestSessionPanels(first)
          .map((panel) => panel.panelId);
        return (
          members.includes(first.panelId) &&
          members.includes(second.panelId) &&
          !members.includes("panel-isolated-profile")
        );
      });
    } finally {
      await browser.dispose();
    }
  });

  it("reconnects the same panel identity onto one membership and rejects the older generation", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByRole("img", { name: "Browser page view" });
      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });

      const replacement = await browser.issuePanelCapability({
        hostId: first.hostId,
        profileId: first.profileId,
        panelId: first.panelId,
        ownerSessionId: first.ownerSessionId,
      });
      if (replacement.outcome !== "issued") {
        throw new Error("expected a replacement Panel Capability");
      }
      const nextSocket = await browser.redeemIssuedCapability({
        ...replacement,
        hostId: first.hostId,
        profileId: first.profileId,
        panelId: first.panelId,
        ownerSessionId: first.ownerSessionId,
      });
      try {
        browser.sendAuthorizedInput(first, {
          kind: "click",
          generation: "stale",
        });
      } catch {
        // The superseded generation may already have closed.
      }
      await waitFor(() => {
        expect(browser.portHasOpenSocket(first.gatewayPort)).toBe(false);
      });
      expect(browser.latestIssuedGeneration(first)).toBe(2);
      await waitForSettled(() => {
        const live = browser
          .latestSessionPanels(first)
          .find((panel) => panel.panelId === first.panelId);
        return (
          live?.connection === "connected" &&
          !browser.receivedInputs.some(
            (input) =>
              input !== null &&
              typeof input === "object" &&
              "generation" in input &&
              input.generation === "stale",
          )
        );
      });
      browser.sendSocketInput(nextSocket, { kind: "click", generation: 2 });
      await waitFor(() => {
        expect(browser.receivedInputs).toContainEqual({
          kind: "click",
          generation: 2,
        });
      });
      await waitFor(() => {
        const members = browser.latestSessionPanels(second);
        expect(
          members.filter((panel) => panel.panelId === first.panelId),
        ).toHaveLength(1);
        expect(
          members.find((panel) => panel.panelId === first.panelId),
        ).toMatchObject({ connection: "connected" });
        expect(members.map((panel) => panel.panelId).sort()).toEqual(
          [first.panelId, second.panelId].sort(),
        );
      });
    } finally {
      await browser.dispose();
    }
  });

  it("keeps reclaim membership after abrupt disconnect and removes an explicit close immediately", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await waitFor(() =>
        expect(
          browser
            .latestSessionPanels(second)
            .map((panel) => panel.panelId)
            .sort(),
        ).toEqual([first.panelId, second.panelId].sort()),
      );

      await browser.forcePhysicalSocketLoss(first);
      await waitFor(() => {
        expect(
          browser
            .latestSessionPanels(second)
            .find((panel) => panel.panelId === first.panelId),
        ).toMatchObject({ connection: "disconnected" });
      });

      await browser.closePanel(first);
      await waitFor(() => {
        expect(
          browser
            .latestSessionPanels(second)
            .map((panel) => panel.panelId)
            .includes(first.panelId),
        ).toBe(false);
      });
      expect(
        browser.latestSessionPanels(second).map((panel) => panel.panelId),
      ).toEqual([second.panelId]);
    } finally {
      await browser.dispose();
    }
  });

  it("disposes every session generation and loopback listener on host-worker shutdown", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    const ports: number[] = [];
    try {
      const [first, second] = await browser.openTwoPanels();
      ports.push(first.gatewayPort, second.gatewayPort);
    } finally {
      await browser.dispose();
    }
    await Promise.all(
      ports.map(
        (port) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`);
            socket.once("open", () => {
              socket.close();
              reject(
                new Error(
                  `loopback port ${port} still accepted a Browser Panel connection`,
                ),
              );
            });
            socket.once("error", () => resolve());
          }),
      ),
    );
  });

  it("delivers a deterministic first frame to both rendered panels over the real loopback transport", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();

      await first.findByRole("img", { name: "Browser page view" });
      await second.findByRole("img", { name: "Browser page view" });
      expect(first.framesReceived).toBeGreaterThan(0);
      expect(second.framesReceived).toBeGreaterThan(0);
    } finally {
      await browser.dispose();
    }
  });

  it("routes remote panels to their shared gateway ports and paints the received page", async () => {
    class DecodedImage extends EventTarget {
      set src(_value: string) {
        queueMicrotask(() => this.dispatchEvent(new Event("load")));
      }
    }
    vi.stubGlobal("Image", DecodedImage);
    const painted = new Set<HTMLCanvasElement>();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(function (this: HTMLCanvasElement) {
        return {
          clearRect() {},
          drawImage: () => painted.add(this),
        } as unknown as CanvasRenderingContext2D;
      });
    const browser = await createPublicPanelLifecycleHarness({
      transport: "tunnel",
    });
    try {
      const [first, second] = await browser.openTwoPanels();
      for (const panel of [first, second]) {
        expect(browser.requestedSocketUrls).toContain(
          `wss://ci-gate--${panel.gatewayPort}.ci.getbb.app`,
        );
        const canvas = await panel.findByRole("img", {
          name: "Browser page view",
        });
        await waitFor(() =>
          expect(painted.has(canvas as HTMLCanvasElement)).toBe(true),
        );
      }
      await browser.forcePhysicalSocketLoss(first);
      const reconnecting = await first.findByText(
        "Reconnecting to the browser…",
      );
      expect(reconnecting.classList.contains("sr-only")).toBe(false);
      const framesBeforeReconnect = first.framesReceived;
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await first.findByText("The page is live.");
      await waitFor(() =>
        expect(first.framesReceived).toBeGreaterThan(framesBeforeReconnect),
      );
    } finally {
      await browser.dispose();
      getContext.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("accepts authorized input after a valid initial connection reaches a first frame", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first] = await browser.openTwoPanels();
      await first.findByRole("img", { name: "Browser page view" });
      expect(first.framesReceived).toBeGreaterThan(0);

      browser.sendAuthorizedInput(first, { kind: "click" });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([{ kind: "click" }]);
      });
    } finally {
      await browser.dispose();
    }
  });

  it("reconnects with a fresh Panel Capability after physical socket loss", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByRole("img", { name: "Browser page view" });
      await first.findByText("The page is live.");
      const framesBeforeLoss = first.framesReceived;
      const originalSecrets = browser.issuedSecrets(first.panelId);
      expect(originalSecrets).toHaveLength(1);
      const originalSecret = originalSecrets[0]!;
      expect(browser.redeemedSecrets(first.panelId)).toEqual([originalSecret]);

      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });

      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      await first.findByRole("img", { name: "Browser page view" });
      const reconnecting = first.container.textContent ?? "";
      expect(reconnecting).not.toMatch(/WebSocket/u);
      expect(reconnecting).not.toMatch(/panelTransport/u);
      expect(reconnecting).not.toContain(originalSecret);
      expect(reconnecting).not.toContain(first.capabilityId);
      expect(reconnecting).not.toContain(first.panelId);
      await second.findByText("The page is live.");
      expect(() =>
        browser.sendAuthorizedInput(first, { kind: "click", queued: true }),
      ).toThrow("Browser Panel has no live stream connection.");
      expect(browser.receivedInputs).toEqual([
        { kind: "click", generation: 1 },
      ]);

      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await waitFor(() => {
        expect(browser.issuedSecrets(first.panelId).length).toBeGreaterThan(1);
      });
      const nextSecret = browser.issuedSecrets(first.panelId).at(-1);
      expect(nextSecret).toBeDefined();
      expect(nextSecret).not.toBe(originalSecret);
      await waitFor(() => {
        expect(browser.redeemedSecrets(first.panelId)).toEqual([
          originalSecret,
          nextSecret,
        ]);
      });
      await first.findByText("The page is live.");
      await first.findByRole("img", { name: "Browser page view" });
      expect(first.framesReceived).toBeGreaterThan(framesBeforeLoss);
      await waitFor(() => {
        const member = browser
          .latestSessionPanels(first)
          .find((panel) => panel.panelId === first.panelId);
        expect(member).toMatchObject({
          connection: "connected",
          role: "spectator",
        });
      });
      await second.findByText("The page is live.");

      const liveSocket = [...browser.socketUrls()].find((url) =>
        url.includes("127.0.0.1"),
      );
      expect(liveSocket).toBeDefined();
      for (const secret of browser.issuedSecrets(first.panelId)) {
        expect(browser.socketUrls().join("\n")).not.toContain(secret);
        expect(
          browser.jsonContainsSecret(browser.diagnosticLogEntries(), secret),
        ).toBe(false);
        expect(
          browser.jsonContainsSecret(await browser.activityRecords(), secret),
        ).toBe(false);
        expect(
          browser.jsonContainsSecret(browser.persistedActivityRows(), secret),
        ).toBe(false);
        expect(
          browser.jsonContainsSecret(await browser.runDiagnostics(), secret),
        ).toBe(false);
      }
    } finally {
      await browser.dispose();
    }
  });

  it("does not let an aborted reconnect attempt poison the next live frame", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      const framesBeforeLoss = first.framesReceived;

      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await waitFor(() => {
        expect(browser.latestIssuedGeneration(first)).toBeGreaterThan(1);
      });
      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await first.findByText("The page is live.");
      expect(first.framesReceived).toBeGreaterThan(framesBeforeLoss);
      await second.findByText("The page is live.");
      expect(new Set(browser.issuedSecrets(first.panelId)).size).toBe(
        browser.issuedSecrets(first.panelId).length,
      );
    } finally {
      await browser.dispose();
    }
  });

  it("replaces Panel authorization at the five-minute boundary without blanking the page", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByRole("img", { name: "Browser page view" });
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      const framesBeforeRotation = first.framesReceived;
      const originalSecrets = browser.issuedSecrets(first.panelId);
      expect(originalSecrets).toHaveLength(1);
      const originalSecret = originalSecrets[0]!;
      const originalPort = first.gatewayPort;
      const hostCallsBeforeInput = browser.hostRpcCalls.length;
      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });
      expect(browser.hostRpcCalls.length).toBe(hostCallsBeforeInput);

      browser.holdNewSocketMessageEvents();
      browser.armAuthorizedInputOnNextReady(first, {
        kind: "click",
        generation: "stale",
      });
      await browser.advanceTime(PANEL_AUTH_ROTATION_MS);
      await waitFor(() => {
        expect(browser.issuedSecrets(first.panelId).length).toBeGreaterThan(1);
      });
      const nextSecret = browser.issuedSecrets(first.panelId).at(-1);
      expect(nextSecret).toBeDefined();
      expect(nextSecret).not.toBe(originalSecret);
      const replacementPort = browser.issuedGatewayPorts(first.panelId).at(-1);
      expect(replacementPort).toBeDefined();
      expect(replacementPort).not.toBe(originalPort);
      await waitFor(() => {
        expect(browser.redeemedSecrets(first.panelId)).toEqual([
          originalSecret,
          nextSecret,
        ]);
        expect(browser.portHasReady(replacementPort!)).toBe(true);
        expect(browser.overlapSend().sent).toBe(true);
      });
      expect(browser.overlapSend().error).toBeUndefined();
      await waitForSettled(() => {
        return !browser.receivedInputs.some(
          (input) =>
            input !== null &&
            typeof input === "object" &&
            "generation" in input &&
            input.generation === "stale",
        );
      });
      expect(first.queryByText("Reconnecting to the browser…")).toBeNull();
      await browser.releaseHeldSocketEvents();
      await first.findByText("The page is live.");
      await first.findByRole("img", { name: "Browser page view" });
      expect(first.queryByText("Reconnecting to the browser…")).toBeNull();
      expect(first.framesReceived).toBeGreaterThanOrEqual(framesBeforeRotation);
      await second.findByText("The page is live.");
      await waitFor(() => {
        expect(browser.portHasOpenSocket(originalPort)).toBe(false);
      });
      const hostCallsBeforeLiveInput = browser.hostRpcCalls.length;
      browser.sendLiveInput(first, { kind: "click", generation: 2 });
      await waitFor(() => {
        expect(browser.receivedInputs).toContainEqual({
          kind: "click",
          generation: 2,
        });
      });
      expect(browser.hostRpcCalls.length).toBe(hostCallsBeforeLiveInput);
      await waitFor(() => {
        const members = browser.latestSessionPanels(second);
        expect(
          members.filter((panel) => panel.panelId === first.panelId),
        ).toHaveLength(1);
        expect(
          members.find((panel) => panel.panelId === first.panelId),
        ).toMatchObject({ connection: "connected" });
        expect(members.map((panel) => panel.panelId).sort()).toEqual(
          [first.panelId, second.panelId].sort(),
        );
      });
      expect(new Set(browser.issuedSecrets(first.panelId)).size).toBe(
        browser.issuedSecrets(first.panelId).length,
      );
    } finally {
      await browser.dispose();
    }
  });

  it("closes an in-flight replacement connection when the panel unmounts during rotation", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      const originalSecret = browser.issuedSecrets(first.panelId)[0]!;

      browser.holdNewSocketOpenEvents();
      await browser.advanceTime(PANEL_AUTH_ROTATION_MS);
      await waitFor(() => {
        expect(browser.issuedSecrets(first.panelId).length).toBeGreaterThan(1);
      });
      const replacementPort = browser.issuedGatewayPorts(first.panelId).at(-1);
      expect(replacementPort).toBeDefined();
      await waitFor(() => {
        expect(browser.portHasOpenSocket(replacementPort!)).toBe(true);
      });
      expect(browser.redeemedSecrets(first.panelId)).toEqual([originalSecret]);

      act(() => {
        first.lifecycle.unmount();
      });
      expect(browser.appClosedPort(replacementPort!)).toBe(true);
      expect(browser.redeemedSecrets(first.panelId)).toEqual([originalSecret]);
      await second.findByText("The page is live.");
    } finally {
      await browser.dispose();
    }
  });

  it("freezes input and reconnects when authorization rotation fails", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByRole("img", { name: "Browser page view" });
      await first.findByText("The page is live.");
      const framesBeforeFailure = first.framesReceived;
      const originalSecrets = browser.issuedSecrets(first.panelId);
      expect(originalSecrets).toHaveLength(1);
      const originalSecret = originalSecrets[0]!;
      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });

      browser.setHostRpcFailure(
        "panelTransport",
        "replacement Panel Capability unavailable ws://127.0.0.1 leaked-secret",
      );
      await browser.advanceTime(PANEL_AUTH_ROTATION_MS);
      await first.findByText("Reconnecting to the browser…");
      await first.findByRole("img", { name: "Browser page view" });
      expect(first.framesReceived).toBeGreaterThanOrEqual(framesBeforeFailure);
      const recovering = first.container.textContent ?? "";
      expect(recovering).not.toMatch(/Panel Capability unavailable/u);
      expect(recovering).not.toMatch(/WebSocket/u);
      expect(recovering).not.toMatch(/127\.0\.0\.1/u);
      expect(recovering).not.toContain(originalSecret);
      expect(recovering).not.toContain(first.capabilityId);
      expect(recovering).not.toContain(first.panelId);
      expect(() =>
        browser.sendAuthorizedInput(first, { kind: "click", queued: true }),
      ).toThrow("Browser Panel has no live stream connection.");
      expect(browser.receivedInputs).toEqual([
        { kind: "click", generation: 1 },
      ]);
      expect(browser.issuedSecrets(first.panelId)).toEqual([originalSecret]);
      await second.findByRole("img", { name: "Browser page view" });

      browser.setHostRpcFailure("panelTransport");
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await waitFor(() => {
        expect(browser.issuedSecrets(first.panelId).length).toBeGreaterThan(1);
      });
      const recoveredSecret = browser.issuedSecrets(first.panelId).at(-1);
      expect(recoveredSecret).toBeDefined();
      expect(recoveredSecret).not.toBe(originalSecret);
      await first.findByText("The page is live.");
      await first.findByRole("img", { name: "Browser page view" });
      expect(first.framesReceived).toBeGreaterThan(framesBeforeFailure);
    } finally {
      await browser.dispose();
    }
  });

  it("does not start another reconnect after a closed or switched panel", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const created = await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Reconnect switch target",
      });
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      const issuedBeforeClose = browser.latestIssuedGeneration(first);

      await browser.closePanel(first);
      expect(first.container.innerHTML).toBe("");
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      expect(browser.latestIssuedGeneration(first)).toBe(issuedBeforeClose);
      await second.findByText("The page is live.");

      await browser.forcePhysicalSocketLoss(second);
      await second.findByText("Reconnecting to the browser…");
      const abandonedProfileId = second.profileId;
      const issuedBeforeSwitch = browser.latestIssuedGeneration(
        second,
        abandonedProfileId,
      );
      const switched = await browser.switchBrowserProfile(
        second,
        created.profileId,
      );
      expect(switched.selectedProfileId).toBe(created.profileId);
      expect(second.container.innerHTML).not.toBe("");
      expect(
        second.inspection.rpcCalls.some(
          (call: { method: string; input: unknown }) =>
            call.method === "browser_profile_select" &&
            (call.input as { profileId?: string }).profileId ===
              created.profileId,
        ),
      ).toBe(true);
      expect(
        second.inspection.rpcCalls.some(
          (call: { method: string; input: unknown }) =>
            call.method === "browser_status" &&
            (call.input as { profileId?: string }).profileId ===
              created.profileId,
        ),
      ).toBe(true);
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      expect(browser.latestIssuedGeneration(second, abandonedProfileId)).toBe(
        issuedBeforeSwitch,
      );
    } finally {
      await browser.dispose();
    }
  });

  it("can force physical socket loss, advance reconnect and expiry time, close either panel, and switch a Browser Profile", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");

      const issuedBefore = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-expiry-probe",
        ownerSessionId: browser.ownerSessionId,
      });
      if (issuedBefore.outcome !== "issued") {
        throw new Error("expected an issued Panel Capability");
      }
      expect(issuedBefore.expiresAt).toBe("2026-08-31T12:01:00.000Z");

      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      await second.findByText("The page is live.");
      const attemptsAfterLoss = first.connectionAttempts;

      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await waitFor(() => {
        expect(first.connectionAttempts).toBeGreaterThan(attemptsAfterLoss);
      });
      await first.findByText("The page is live.");

      await browser.advanceTime(PANEL_CAPABILITY_TTL_MS + 1);
      const issuedAfter = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-expiry-after",
        ownerSessionId: browser.ownerSessionId,
      });
      if (issuedAfter.outcome !== "issued") {
        throw new Error(
          "expected an issued Panel Capability after advancing time",
        );
      }
      expect(issuedAfter.expiresAt).toBe("2026-08-31T12:02:00.501Z");

      await browser.closePanel(second);
      expect(second.container.innerHTML).toBe("");
      expect(lifecycleHostCommands(browser.hostRpcCalls)).toContain(
        "panelRelease",
      );
      await first.findByText("The page is live.");

      const created = await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Lifecycle switch target",
      });
      const switched = await browser.switchBrowserProfile(created.profileId);
      expect(switched.selectedProfileId).toBe(created.profileId);
      const inventory = await browser.runBrowserProfiles();
      expect(inventory.selectedProfileId).toBe(created.profileId);
    } finally {
      await browser.dispose();
    }
  });

  it("rejects impossible or mismatched identities instead of replacing them with fixtures", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      await expect(
        browser.runBrowserStatus({
          surface: "thread",
          threadId: "thread-does-not-exist",
          profileId: DEFAULT_PROFILE_ID,
          hostId: browser.hostId,
        }),
      ).rejects.toThrow("HTTP 404: Thread not found");
      expect(browser.threadLookups).toEqual(["thread-does-not-exist"]);

      const unknownHostAt = browser.hostRpcCalls.length;
      const unknownHost = await browser.issuePanelCapability({
        hostId: "host-does-not-exist",
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-unknown-host",
        ownerSessionId: ownerSessionIdFromContext({
          projectId: null,
          threadId: null,
        }),
      });
      expect(unknownHost.outcome).toBe("unavailable");
      if (unknownHost.outcome === "unavailable") {
        expect(unknownHost.reason).toBe("host-offline");
      }
      expect(
        lifecycleHostCommands(browser.hostRpcCalls.slice(unknownHostAt)),
      ).toEqual([]);

      const mismatchedHostAt = browser.hostRpcCalls.length;
      const mismatchedHost = await browser.issuePanelCapability({
        hostId: "host-does-not-exist",
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-mismatched-host",
        ownerSessionId: browser.ownerSessionId,
      });
      expect(mismatchedHost).toMatchObject({
        outcome: "rejected",
        reason: "host-mismatch",
      });
      expect(
        lifecycleHostCommands(browser.hostRpcCalls.slice(mismatchedHostAt)),
      ).toEqual([]);

      await expect(
        browser.issuePanelCapability({
          hostId: browser.hostId,
          profileId: DEFAULT_PROFILE_ID,
          panelId: "",
          ownerSessionId: browser.ownerSessionId,
        }),
      ).rejects.toThrow();
      await expect(
        browser.issuePanelCapability({
          hostId: browser.hostId,
          profileId: DEFAULT_PROFILE_ID,
          panelId: "panel-empty-session",
          ownerSessionId: "",
        }),
      ).rejects.toThrow();

      const unknownProfileAt = browser.hostRpcCalls.length;
      const unknownProfile = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: "profile-does-not-exist",
        panelId: "panel-unknown-profile",
        ownerSessionId: browser.ownerSessionId,
      });
      expect(unknownProfile).toMatchObject({
        outcome: "rejected",
        reason: "profile-mismatch",
      });
      expect(
        browser.panelCapabilityExchanges.some(
          (exchange) =>
            exchange.request.panelId === "panel-unknown-profile" &&
            exchange.response.outcome === "issued",
        ),
      ).toBe(false);
      expect(
        lifecycleHostCommands(browser.hostRpcCalls.slice(unknownProfileAt)),
      ).toEqual(["panelTransport"]);

      const mismatchedSessionAt = browser.hostRpcCalls.length;
      const mismatchedSession = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-mismatched-session",
        ownerSessionId: "owner-session-does-not-match",
      });
      expect(mismatchedSession).toMatchObject({
        outcome: "rejected",
        reason: "owner-session-mismatch",
      });
      expect(
        lifecycleHostCommands(browser.hostRpcCalls.slice(mismatchedSessionAt)),
      ).toEqual([]);

      const missingThreadAt = browser.hostRpcCalls.length;
      const missingThread = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-missing-thread",
        ownerSessionId: ownerSessionIdFromContext({
          projectId: null,
          threadId: "thread-does-not-exist",
        }),
      });
      expect(missingThread).toMatchObject({
        outcome: "rejected",
        reason: "thread-mismatch",
      });
      expect(browser.threadLookups).toContain("thread-does-not-exist");
      expect(
        lifecycleHostCommands(browser.hostRpcCalls.slice(missingThreadAt)),
      ).toEqual([]);

      const missingProjectAt = browser.hostRpcCalls.length;
      const missingProject = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-missing-project",
        ownerSessionId: ownerSessionIdFromContext({
          projectId: "project-does-not-exist",
          threadId: null,
        }),
      });
      expect(missingProject).toMatchObject({
        outcome: "rejected",
        reason: "project-mismatch",
      });
      expect(browser.projectLookups).toContain("project-does-not-exist");
      expect(
        lifecycleHostCommands(browser.hostRpcCalls.slice(missingProjectAt)),
      ).toEqual([]);
    } finally {
      await browser.dispose();
    }
  });

  it.each([
    {
      reason: "host-mismatch" as const,
      override: { hostId: "host-does-not-exist" },
    },
    {
      reason: "owner-session-mismatch" as const,
      override: { ownerSessionId: "owner-session-does-not-match" },
    },
    {
      reason: "thread-mismatch" as const,
      override: {
        ownerSessionId: ownerSessionIdFromContext({
          projectId: null,
          threadId: "thread-does-not-exist",
        }),
      },
    },
  ])(
    "returns a typed $reason identity rejection for visibility matching capability and release",
    async ({ reason, override }) => {
      const browser = await createPublicPanelLifecycleHarness();
      try {
        const request = {
          hostId: browser.hostId,
          profileId: DEFAULT_PROFILE_ID,
          panelId: `panel-visibility-${reason}`,
          ownerSessionId: browser.ownerSessionId,
          ...override,
        };
        const expected = { outcome: "rejected" as const, reason };
        const before = browser.hostRpcCalls.length;

        const capability = await browser.issuePanelCapability(request);
        expect(capability).toMatchObject(expected);

        const released = await browser.releasePanel(request);
        expect(released).toMatchObject(expected);

        const visibility = await browser.setPanelVisibility({
          ...request,
          visibility: "hidden",
        });
        expect(visibility).toMatchObject(expected);
        expect(
          lifecycleHostCommands(browser.hostRpcCalls.slice(before)),
        ).toEqual([]);
      } finally {
        await browser.dispose();
      }
    },
  );

  it("resolves a valid public-plugin request to one host and one typed host command", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const before = browser.hostRpcCalls.length;
      const response = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-dispatch-valid",
        ownerSessionId: browser.ownerSessionId,
      });
      expect(response.outcome).toBe("issued");
      if (response.outcome !== "issued") {
        throw new Error("expected an issued Panel Capability");
      }
      expect(response.capabilityId).toMatch(/^panel-capability-/);
      expect(response.gatewayPort).toBeGreaterThan(0);
      expect(response.tunnel).toEqual({
        label: "ci-gate",
        baseDomain: "ci.getbb.app",
      });
      expect(browser.hostRpcCalls.slice(before)).toEqual(["panelTransport"]);
      expect(browser.threadLookups).toEqual([browser.threadId]);
    } finally {
      await browser.dispose();
    }
  });

  it.each([
    {
      reason: "host-mismatch" as const,
      override: { hostId: "host-does-not-exist" as const },
    },
    {
      reason: "thread-mismatch" as const,
      override: { threadId: "thread-does-not-exist" as const },
    },
    {
      reason: "project-mismatch" as const,
      surface: "new-thread" as const,
      override: { projectId: "project-does-not-exist" as const },
    },
  ])(
    "returns a typed $reason identity rejection for navigation, history, and Browser Tab actions without host mutation",
    async ({
      reason,
      override,
      surface,
    }: {
      reason: "host-mismatch" | "thread-mismatch" | "project-mismatch";
      surface?: "new-thread";
      override: { hostId?: string; threadId?: string; projectId?: string };
    }) => {
      const browser = await createPublicPanelLifecycleHarness({
        browserRuntime: createTabInventoryRuntime(),
      });
      try {
        const request =
          surface === "new-thread"
            ? {
                surface: "new-thread" as const,
                projectId: override.projectId ?? browser.projectId,
                hostId: override.hostId ?? browser.hostId,
                profileId: DEFAULT_PROFILE_ID,
                panelId: `panel-drive-${reason}`,
              }
            : {
                surface: "thread" as const,
                threadId: override.threadId ?? browser.threadId,
                hostId: override.hostId ?? browser.hostId,
                profileId: DEFAULT_PROFILE_ID,
                panelId: `panel-drive-${reason}`,
              };
        const expected = { outcome: "rejected" as const, reason };
        const before = browser.hostRpcCalls.length;

        const navigated = await browser.rpc.browser_navigate({
          ...request,
          input: "https://example.com/rejected",
        });
        expect(navigated).toMatchObject(expected);

        const history = await browser.rpc.browser_history({
          ...request,
          direction: "reload",
        });
        expect(history).toMatchObject(expected);

        const tabs = await browser.rpc.browser_tab_action({
          ...request,
          action: "open",
        });
        expect(tabs).toMatchObject(expected);
        expect(
          panelOperationHostCommands(browser.hostRpcCalls.slice(before)),
        ).toEqual([]);
      } finally {
        await browser.dispose();
      }
    },
  );

  it.each([
    {
      reason: "host-mismatch" as const,
      override: { hostId: "host-does-not-exist" },
    },
    {
      reason: "owner-session-mismatch" as const,
      override: { ownerSessionId: "owner-session-does-not-match" },
    },
    {
      reason: "thread-mismatch" as const,
      override: {
        ownerSessionId: ownerSessionIdFromContext({
          projectId: null,
          threadId: "thread-does-not-exist",
        }),
      },
    },
  ])(
    "returns a typed $reason identity rejection for Control Lease actions without host mutation",
    async ({ reason, override }) => {
      const browser = await createPublicPanelLifecycleHarness();
      try {
        const request = {
          hostId: browser.hostId,
          profileId: DEFAULT_PROFILE_ID,
          panelId: `panel-control-${reason}`,
          ownerSessionId: browser.ownerSessionId,
          ...override,
        };
        const expected = { outcome: "rejected" as const, reason };
        const before = browser.hostRpcCalls.length;

        expect(await browser.rpc.browser_panel_control(request)).toMatchObject(
          expected,
        );
        expect(
          await browser.rpc.browser_panel_take_control(request),
        ).toMatchObject(expected);
        expect(
          await browser.rpc.browser_panel_reclaim_control(request),
        ).toMatchObject(expected);
        expect(
          await browser.rpc.browser_panel_release_control(request),
        ).toMatchObject(expected);
        expect(
          panelOperationHostCommands(browser.hostRpcCalls.slice(before)),
        ).toEqual([]);
      } finally {
        await browser.dispose();
      }
    },
  );

  it("resolves navigation, history, Browser Tab, and Control Lease requests to one host command each", async () => {
    const browser = await createPublicPanelLifecycleHarness({
      browserRuntime: createTabInventoryRuntime(),
    });
    try {
      await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Dispatch target",
      });
      const surface = {
        surface: "thread" as const,
        threadId: browser.threadId,
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-dispatch-drive",
      };
      const session = {
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-dispatch-drive",
        ownerSessionId: browser.ownerSessionId,
      };

      let before = browser.hostRpcCalls.length;
      const joined = await browser.rpc.browser_panel_control(session);
      expect(joined).toMatchObject({ role: "controller" });
      expect(browser.hostRpcCalls.slice(before)).toEqual(["panelControl"]);

      before = browser.hostRpcCalls.length;
      const navigated = await browser.rpc.browser_navigate({
        ...surface,
        input: "https://example.com/dispatch",
      });
      expect(navigated).toMatchObject({
        address: { url: "https://example.com/dispatch" },
      });
      expect(browser.hostRpcCalls.slice(before)).toEqual(["navigate"]);

      before = browser.hostRpcCalls.length;
      const history = await browser.rpc.browser_history({
        ...surface,
        direction: "reload",
      });
      expect(history).toMatchObject({ address: { kind: "address" } });
      expect(browser.hostRpcCalls.slice(before)).toEqual(["history"]);

      before = browser.hostRpcCalls.length;
      const opened = await browser.rpc.browser_tab_action({
        ...surface,
        action: "open",
      });
      expect(opened.tabs).toHaveLength(1);
      expect(browser.hostRpcCalls.slice(before)).toEqual(["tabAction"]);

      before = browser.hostRpcCalls.length;
      const strip = await browser.rpc.browser_tabs({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
      });
      expect(strip).toEqual(opened);
      expect(browser.hostRpcCalls.slice(before)).toEqual(["tabs"]);
    } finally {
      await browser.dispose();
    }
  });

  it("rejects spectator navigation, history, and Browser Tab actions at the host when the interface is bypassed", async () => {
    const browser = await createPublicPanelLifecycleHarness({
      browserRuntime: createTabInventoryRuntime(),
    });
    try {
      const [first, second] = await browser.openTwoPanels();
      await waitFor(() => {
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          first.panelId,
        );
      });
      const spectator = {
        surface: "thread" as const,
        threadId: browser.threadId,
        hostId: second.hostId,
        profileId: second.profileId,
        panelId: second.panelId,
      };

      await expect(
        browser.rpc.browser_navigate({
          ...spectator,
          input: "https://example.com/spectator",
        }),
      ).rejects.toThrow(/view-only/iu);
      await expect(
        browser.rpc.browser_history({
          ...spectator,
          direction: "reload",
        }),
      ).rejects.toThrow(/view-only/iu);
      await expect(
        browser.rpc.browser_tab_action({
          ...spectator,
          action: "open",
        }),
      ).rejects.toThrow(/view-only/iu);

      expect(browser.latestTabs(first)?.tabs ?? []).toEqual([]);
      expect(browser.latestTabs(second)?.tabs ?? []).toEqual([]);
    } finally {
      await browser.dispose();
    }
  });

  it("keeps Profile Grants on the BB server while Browser Profiles stay host-owned", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const created = await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Host-owned profile",
      });
      const inventory = await browser.runBrowserProfiles();
      expect(inventory.profiles.map((profile) => profile.profileId)).toContain(
        created.profileId,
      );
      expect(browser.hostRpcCalls).toContain("createProfile");
      expect(browser.hostRpcCalls).toContain("listProfiles");

      const hostCallsBeforeGrants = browser.hostRpcCalls.length;
      const grants = await browser.rpc.browser_grants({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
      });
      expect(grants).toEqual([]);
      expect(browser.hostRpcCalls.slice(hostCallsBeforeGrants)).toEqual([]);
      expect(JSON.stringify(browser.persistedActivityRows())).toContain(
        '"kind":"lifecycle"',
      );
    } finally {
      await browser.dispose();
    }
  });

  it("revokes active lifecycle authority through an explicit public panel release", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const issued = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-explicit-release",
        ownerSessionId: browser.ownerSessionId,
      });
      if (issued.outcome !== "issued") {
        throw new Error("expected an issued Panel Capability");
      }

      const beforeRelease = browser.hostRpcCalls.length;
      const released = await browser.releasePanel({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-explicit-release",
        ownerSessionId: browser.ownerSessionId,
      });
      expect(released).toEqual({ outcome: "released" });
      expect(browser.hostRpcCalls.slice(beforeRelease)).toEqual([
        "panelRelease",
      ]);

      const reissued = await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-explicit-release",
        ownerSessionId: browser.ownerSessionId,
      });
      if (reissued.outcome !== "issued") {
        throw new Error("expected a replacement Panel Capability");
      }
      expect(reissued.capabilityId).not.toBe(issued.capabilityId);
      expect(reissued.secret).not.toBe(issued.secret);
    } finally {
      await browser.dispose();
    }
  });

  it("lets two panels observe one controller and the same ordered Control Lease transitions", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerPanelId).toBe(
          first.panelId,
        );
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          first.panelId,
        );
      });
      expect(browser.latestControl(first)?.agentPurpose).toBeNull();
      expect(browser.latestControl(second)?.agentPurpose).toBeNull();

      await browser.takeControl(second);
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerPanelId).toBe(
          second.panelId,
        );
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          second.panelId,
        );
      });

      await browser.releaseControl(second);
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerPanelId).toBeNull();
        expect(browser.latestControl(second)?.controllerPanelId).toBeNull();
      });

      await browser.takeControl(first);
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerPanelId).toBe(
          first.panelId,
        );
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          first.panelId,
        );
      });
    } finally {
      await browser.dispose();
    }
  });

  it("freezes a disconnected controller immediately and lets only that panel reclaim within ten seconds", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await waitFor(() => {
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          first.panelId,
        );
      });
      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });

      await browser.forcePhysicalSocketLoss(first);
      await waitFor(() => {
        expect(
          browser
            .latestSessionPanels(second)
            .find((panel) => panel.panelId === first.panelId),
        ).toMatchObject({ connection: "disconnected", role: "spectator" });
        expect(browser.latestControl(second)?.controllerPanelId).toBeNull();
      });
      await expect(browser.takeControl(second)).resolves.toMatchObject({
        role: "spectator",
        control: expect.objectContaining({ controllerPanelId: null }),
      });

      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await first.findByText("The page is live.");
      await waitFor(() => {
        expect(
          browser
            .latestSessionPanels(second)
            .find((panel) => panel.panelId === first.panelId),
        ).toMatchObject({ connection: "connected", role: "spectator" });
      });

      const reclaimed = await browser.reclaimControl(first);
      expect(reclaimed.role).toBe("controller");
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerPanelId).toBe(
          first.panelId,
        );
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          first.panelId,
        );
      });
      browser.sendLiveInput(first, { kind: "click", generation: 2 });
      await waitFor(() => {
        expect(browser.receivedInputs).toContainEqual({
          kind: "click",
          generation: 2,
        });
      });

      await browser.forcePhysicalSocketLoss(first);
      await waitFor(() => {
        expect(browser.latestControl(second)?.controllerPanelId).toBeNull();
      });
      await browser.advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);
      await first.findByText("The page is live.");
      await waitFor(() => {
        expect(
          browser
            .latestSessionPanels(second)
            .find((panel) => panel.panelId === first.panelId),
        ).toMatchObject({ connection: "connected", role: "spectator" });
        expect(browser.latestControl(second)?.controllerPanelId).toBeNull();
      });
      const inputsAfterExpiry = browser.receivedInputs.length;
      browser.sendLiveInput(first, { kind: "click", generation: 3 });
      await waitForSettled(
        () => browser.receivedInputs.length === inputsAfterExpiry,
      );
      const expiredReclaim = await browser.reclaimControl(first);
      expect(expiredReclaim.role).toBe("spectator");
      expect(expiredReclaim.control.controllerPanelId).toBeNull();
      const takeover = await browser.takeControl(second);
      expect(takeover.role).toBe("controller");
      const expired = await browser.reclaimControl(first);
      expect(expired.role).toBe("spectator");
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerPanelId).toBe(
          second.panelId,
        );
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          second.panelId,
        );
      });
    } finally {
      await browser.dispose();
    }
  });

  it("keeps the controller viewport shared and clamped while spectators only letterbox", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await waitFor(() => {
        expect(browser.latestControl(second)?.controllerPanelId).toBe(
          first.panelId,
        );
      });

      await browser.reportViewport(first, { width: 1280, height: 720 });
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerViewport).toEqual({
          width: 1280,
          height: 720,
        });
        expect(browser.latestControl(second)?.controllerViewport).toEqual({
          width: 1280,
          height: 720,
        });
      });

      await browser.reportViewport(second, { width: 400, height: 300 });
      await waitForSettled(() => {
        const firstViewport = browser.latestControl(first)?.controllerViewport;
        const secondViewport =
          browser.latestControl(second)?.controllerViewport;
        return (
          firstViewport?.width === 1280 &&
          firstViewport.height === 720 &&
          secondViewport?.width === 1280 &&
          secondViewport.height === 720
        );
      });

      await browser.reportViewport(first, { width: 5000, height: 4000 });
      await waitFor(() => {
        expect(browser.latestControl(first)?.controllerViewport).toEqual({
          width: PANEL_MAX_VIEWPORT_WIDTH,
          height: PANEL_MAX_VIEWPORT_HEIGHT,
        });
        expect(browser.latestControl(second)?.controllerViewport).toEqual({
          width: PANEL_MAX_VIEWPORT_WIDTH,
          height: PANEL_MAX_VIEWPORT_HEIGHT,
        });
      });
    } finally {
      await browser.dispose();
    }
  });

  it("lets two panels observe the same ordered Browser Tabs through shared-session updates", async () => {
    const browser = await createPublicPanelLifecycleHarness({
      browserRuntime: createTabInventoryRuntime(),
    });
    try {
      await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Shared tab strip",
      });
      const [first, second] = await browser.openTwoPanels();
      const opened = await browser.openTab(first);
      expect(opened.tabs).toHaveLength(1);
      const firstTab = opened.tabs[0]!.tabId;
      await waitFor(() => {
        expect(browser.latestTabs(first)).toEqual(opened);
        expect(browser.latestTabs(second)).toEqual(opened);
      });

      const secondOpened = await browser.openTab(first);
      const secondTab = secondOpened.tabs[1]!.tabId;
      expect(secondOpened.activeTabId).toBe(secondTab);
      await waitFor(() => {
        expect(browser.latestTabs(first)?.activeTabId).toBe(secondTab);
        expect(browser.latestTabs(second)?.activeTabId).toBe(secondTab);
        expect(browser.latestTabs(first)?.tabs.map((tab) => tab.tabId)).toEqual(
          [firstTab, secondTab],
        );
        expect(
          browser.latestTabs(second)?.tabs.map((tab) => tab.tabId),
        ).toEqual([firstTab, secondTab]);
      });

      const activated = await browser.activateTab(first, firstTab);
      expect(activated.activeTabId).toBe(firstTab);
      await waitFor(() => {
        expect(browser.latestTabs(first)?.activeTabId).toBe(firstTab);
        expect(browser.latestTabs(second)?.activeTabId).toBe(firstTab);
      });
    } finally {
      await browser.dispose();
    }
  });

  it("keeps the other panel streaming after one connection is replaced or disconnected", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      const secondFramesBefore = second.framesReceived;
      browser.sendAuthorizedInput(first, { kind: "click", generation: "keep" });
      await waitFor(() => {
        expect(browser.receivedInputs).toContainEqual({
          kind: "click",
          generation: "keep",
        });
      });

      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      await second.findByText("The page is live.");
      expect(second.framesReceived).toBeGreaterThanOrEqual(secondFramesBefore);

      const replacement = await browser.issuePanelCapability({
        hostId: first.hostId,
        profileId: first.profileId,
        panelId: first.panelId,
        ownerSessionId: first.ownerSessionId,
      });
      if (replacement.outcome !== "issued") {
        throw new Error("expected a replacement Panel Capability");
      }
      const nextSocket = await browser.redeemIssuedCapability({
        ...replacement,
        hostId: first.hostId,
        profileId: first.profileId,
        panelId: first.panelId,
        ownerSessionId: first.ownerSessionId,
      });
      await second.findByText("The page is live.");
      expect(second.framesReceived).toBeGreaterThanOrEqual(secondFramesBefore);
      expect(browser.receivedInputs).toEqual([
        { kind: "click", generation: "keep" },
      ]);
      nextSocket.close();
    } finally {
      await browser.dispose();
    }
  });

  it("revokes the old generation on close or profile switch so frames and input cannot cross profiles", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const created = await browser.createBrowserProfile({
        hostId: browser.hostId,
        name: "Switch isolation",
      });
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      const originalPort = second.gatewayPort;
      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });

      await browser.closePanel(first);
      expect(first.container.innerHTML).toBe("");
      await second.findByText("The page is live.");

      const switched = await browser.switchBrowserProfile(
        second,
        created.profileId,
      );
      expect(switched.selectedProfileId).toBe(created.profileId);
      await waitFor(() => {
        expect(browser.portHasOpenSocket(originalPort)).toBe(false);
      });
      const inputsAfterSwitch = browser.receivedInputs.length;
      await waitForSettled(
        () => browser.receivedInputs.length === inputsAfterSwitch,
      );
      expect(browser.portHasOpenSocket(originalPort)).toBe(false);
    } finally {
      await browser.dispose();
    }
  });

  it("fails closed on protocol incompatibility and recovers with a fresh Panel Capability", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      const framesBefore = first.framesReceived;
      const originalSecret = browser.issuedSecrets(first.panelId)[0]!;
      browser.sendAuthorizedInput(first, { kind: "click", generation: 1 });
      await waitFor(() => {
        expect(browser.receivedInputs).toEqual([
          { kind: "click", generation: 1 },
        ]);
      });

      browser.sendIncompatibleProtocol(first);
      await first.findByText("Reconnecting to the browser…");
      await first.findByRole("img", { name: "Browser page view" });
      expect(first.framesReceived).toBeGreaterThanOrEqual(framesBefore);
      const recovering = first.container.textContent ?? "";
      expect(recovering).not.toMatch(/protocolVersion/u);
      expect(recovering).not.toMatch(/WebSocket/u);
      expect(recovering).not.toContain("typed-owner-input");
      expect(recovering).not.toContain(originalSecret);
      expect(() =>
        browser.sendAuthorizedInput(first, { kind: "click", queued: true }),
      ).toThrow("Browser Panel has no live stream connection.");
      expect(browser.receivedInputs).toEqual([
        { kind: "click", generation: 1 },
      ]);
      await second.findByText("The page is live.");

      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await waitFor(() => {
        expect(browser.issuedSecrets(first.panelId).length).toBeGreaterThan(1);
      });
      expect(browser.issuedSecrets(first.panelId).at(-1)).not.toBe(
        originalSecret,
      );
      await first.findByText("The page is live.");
      expect(first.framesReceived).toBeGreaterThan(framesBefore);
    } finally {
      await browser.dispose();
    }
  });

  it("rejects a replayed Panel Capability and keeps the live panel on loopback", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    try {
      const [first, second] = await browser.openTwoPanels();
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      await browser.forcePhysicalSocketLoss(first);
      await first.findByText("Reconnecting to the browser…");
      const replay = await browser.replayRedeemedCapability(first);
      await waitFor(() => {
        expect(replay.readyState).not.toBe(WebSocket.OPEN);
      });
      expect(browser.receivedInputs).toEqual([]);
      await browser.advanceTime(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
      await first.findByText("The page is live.");
      await second.findByText("The page is live.");
      expect(browser.issuedSecrets(first.panelId).at(-1)).not.toBe(
        browser.issuedSecrets(first.panelId)[0],
      );
      expect(
        [...browser.socketUrls()].every((url) => url.includes("127.0.0.1")),
      ).toBe(true);
      for (const secret of browser.issuedSecrets(first.panelId)) {
        expect(browser.socketUrls().join("\n")).not.toContain(secret);
      }
    } finally {
      await browser.dispose();
    }
  });

  it("removes panel-only stream resources after the final panel closes", async () => {
    const browser = await createPublicPanelLifecycleHarness();
    const ports: number[] = [];
    try {
      const [first, second] = await browser.openTwoPanels();
      ports.push(first.gatewayPort, second.gatewayPort);
      await browser.closePanel(first);
      await waitFor(() => {
        expect(browser.portHasOpenSocket(first.gatewayPort)).toBe(false);
      });
      await second.findByText("The page is live.");
      await browser.closePanel(second);
      await waitFor(() => {
        expect(browser.portHasOpenSocket(second.gatewayPort)).toBe(false);
      });
    } finally {
      await browser.dispose();
    }
    await Promise.all(
      ports.map(
        (port) =>
          new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`);
            socket.once("open", () => {
              socket.close();
              reject(
                new Error(
                  `loopback port ${port} still accepted a Browser Panel connection`,
                ),
              );
            });
            socket.once("error", () => resolve());
          }),
      ),
    );
  });
});
