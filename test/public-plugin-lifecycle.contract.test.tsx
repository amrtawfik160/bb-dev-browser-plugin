// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  PANEL_CAPABILITY_TTL_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
} from "../contracts.js";
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
      expect(first.connectionAttempts).toBeGreaterThan(attemptsAfterLoss);

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
      await first.findByText("Reconnecting to the browser…");

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
