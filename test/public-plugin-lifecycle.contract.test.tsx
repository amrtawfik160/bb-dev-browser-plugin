// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  DEFAULT_PROFILE_ID,
  PANEL_CAPABILITY_TTL_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
} from "../contracts.js";
import { waitForSettled } from "./wait.js";
import { ownerSessionIdFromContext } from "../panel-owner-session.js";
import { createPublicPanelLifecycleHarness } from "./public-plugin-lifecycle-harness.js";

const LIFECYCLE_HOST_COMMANDS = new Set([
  "panelTransport",
  "panelVisibility",
  "panelRelease",
]);

function lifecycleHostCommands(calls: readonly string[]) {
  return calls.filter((method) => LIFECYCLE_HOST_COMMANDS.has(method));
}

describe("public Browser Panel lifecycle seam", () => {
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

      const released = await browser.releasePanel({
        hostId: first.hostId,
        profileId: first.profileId,
        panelId: first.panelId,
        ownerSessionId: first.ownerSessionId,
      });
      expect(released).toEqual({ outcome: "released" });
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
});
