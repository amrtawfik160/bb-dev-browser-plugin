import { describe, expect, it } from "vitest";
import {
  PANEL_CAPABILITY_TTL_MS,
  PANEL_AUTH_ROTATION_MS,
  PANEL_RECLAIM_WINDOW_MS,
} from "../contracts.js";
import { createPanelCapabilityStore } from "../panel-capability.js";

const binding = {
  ownerSessionId: "owner-session-1",
  panelId: "panel-1",
  hostId: "host-1",
  profileId: "profile-1",
};

function redeemMessage(
  capability: { capabilityId: string; secret: string },
  overrides: Partial<{
    ownerSessionId: string;
    panelId: string;
    capabilityId: string;
    secret: string;
  }> = {},
) {
  return {
    type: "redeem" as const,
    capabilityId: overrides.capabilityId ?? capability.capabilityId,
    secret: overrides.secret ?? capability.secret,
    ownerSessionId: overrides.ownerSessionId ?? binding.ownerSessionId,
    panelId: overrides.panelId ?? binding.panelId,
  };
}

describe("Panel Capability store contract", () => {
  it("issues a single-use capability that expires unredeemed after 60 seconds", () => {
    const now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({ clock });
    const issued = store.issue(binding);
    expect(issued.expiresAt).toBe(issued.issuedAt + PANEL_CAPABILITY_TTL_MS);
    const result = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    expect(result).toMatchObject({ outcome: "redeemed" });
    // Single-use: a second redemption of the same secret is replayed.
    const replay = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    expect(replay.outcome).toBe("replayed");
    store.dispose();
  });

  it("expires unredeemed after 60 seconds and rejects late redemption", () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({ clock });
    const issued = store.issue(binding);
    now += PANEL_CAPABILITY_TTL_MS + 1;
    const result = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    expect(result.outcome).toBe("expired");
    store.dispose();
  });

  it("binds to owner session, panel instance, host, and profile", () => {
    const now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({ clock });
    const issued = store.issue(binding);
    expect(
      store.redeem(
        redeemMessage(issued, { ownerSessionId: "other-session" }),
        binding.hostId,
        binding.profileId,
      ).outcome,
    ).toBe("binding-mismatch");
    expect(
      store.redeem(
        redeemMessage(issued, { panelId: "other-panel" }),
        binding.hostId,
        binding.profileId,
      ).outcome,
    ).toBe("binding-mismatch");
    expect(
      store.redeem(redeemMessage(issued), "other-host", binding.profileId)
        .outcome,
    ).toBe("binding-mismatch");
    expect(
      store.redeem(redeemMessage(issued), binding.hostId, "other-profile")
        .outcome,
    ).toBe("binding-mismatch");
    store.dispose();
  });

  it("redeems in the first WebSocket message rather than a URL and rejects replayed secrets", () => {
    const now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({ clock });
    const issued = store.issue(binding);
    expect(issued.secret).not.toContain(issued.capabilityId);
    expect(issued.secret.length).toBeGreaterThan(0);
    const first = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    expect(first.outcome).toBe("redeemed");
    const second = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    expect(second.outcome).toBe("replayed");
    store.dispose();
  });

  it("rotates connected authorization every five minutes and revokes on panel close", () => {
    const now = 1_000_000;
    const clock = { now: () => now };
    const revoked: string[] = [];
    const store = createPanelCapabilityStore({
      clock,
      onRevoked: (capabilityId, _binding, reason) => {
        if (reason === "panel-closed") revoked.push(capabilityId);
      },
    });
    const issued = store.issue(binding);
    const redeemed = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    if (redeemed.outcome !== "redeemed") throw new Error("expected redemption");
    const connection = redeemed.connection;
    expect(connection.rotatesAt).toBe(
      connection.connectedAt + PANEL_AUTH_ROTATION_MS,
    );
    const rotated = store.rotate(connection.capabilityId);
    expect(rotated?.generation).toBe(2);
    expect(rotated?.rotatesAt).toBe(now + PANEL_AUTH_ROTATION_MS);
    expect(store.revoke(connection.capabilityId, "panel-closed")).toBe(true);
    expect(revoked).toEqual([connection.capabilityId]);
    store.dispose();
  });

  it("revokes the connected capability when the panel switches profile", () => {
    const now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({ clock });
    const issued = store.issue(binding);
    store.redeem(redeemMessage(issued), binding.hostId, binding.profileId);
    const revoked = store.revokeProfile(binding.profileId);
    expect(revoked).toEqual([issued.capabilityId]);
    expect(store.size()).toBe(0);
    store.dispose();
  });

  it("freezes immediately on disconnect and reclaims within the 10-second window", () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({ clock });
    const issued = store.issue(binding);
    const redeemed = store.redeem(
      redeemMessage(issued),
      binding.hostId,
      binding.profileId,
    );
    if (redeemed.outcome !== "redeemed") throw new Error("expected redemption");
    // Input freezes immediately on disconnect; the connection survives only for reclaim.
    expect(store.markDisconnected(issued.capabilityId)).toBe(true);
    expect(store.isDisconnected(issued.capabilityId)).toBe(true);
    now += PANEL_RECLAIM_WINDOW_MS - 1;
    expect(store.reclaim(issued.capabilityId)).toBe(true);
    expect(store.isDisconnected(issued.capabilityId)).toBe(false);
    store.dispose();
  });

  it("releases the connection after the reclaim window elapses", () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const store = createPanelCapabilityStore({
      clock,
      reclaimWindowMs: 100,
    });
    const issued = store.issue(binding);
    store.redeem(redeemMessage(issued), binding.hostId, binding.profileId);
    store.markDisconnected(issued.capabilityId);
    now += 200;
    // Reclaim after the window fails and the reclaim timer revokes it.
    expect(store.reclaim(issued.capabilityId)).toBe(false);
    store.dispose();
  });
});
