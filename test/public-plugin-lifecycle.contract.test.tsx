// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  PANEL_CAPABILITY_TTL_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
} from "../contracts.js";
import { createPublicPanelLifecycleHarness } from "./public-plugin-lifecycle-harness.js";

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

      const unknownHost = await browser.issuePanelCapability({
        hostId: "host-does-not-exist",
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-unknown-host",
        ownerSessionId: browser.ownerSessionId,
      });
      expect(unknownHost.outcome).toBe("unavailable");
      if (unknownHost.outcome === "unavailable") {
        expect(unknownHost.reason).toBe("host-offline");
      }

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

      await expect(
        browser.issuePanelCapability({
          hostId: browser.hostId,
          profileId: "profile-does-not-exist",
          panelId: "panel-unknown-profile",
          ownerSessionId: browser.ownerSessionId,
        }),
      ).rejects.toThrow(/Browser Profile/i);

      const preservedSession = "owner-session-does-not-match";
      await browser.issuePanelCapability({
        hostId: browser.hostId,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-mismatched-session",
        ownerSessionId: preservedSession,
      });
      expect(browser.panelCapabilityRequests.at(-1)?.ownerSessionId).toBe(
        preservedSession,
      );
    } finally {
      await browser.dispose();
    }
  });
});
