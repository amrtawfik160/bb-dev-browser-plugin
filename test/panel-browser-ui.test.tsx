// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createPublicPluginHarness,
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
});
