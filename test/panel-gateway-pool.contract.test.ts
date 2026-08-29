import { describe, expect, it } from "vitest";
import { createPanelCapabilityStore } from "../panel-capability.js";
import { createPanelGatewayPool } from "../panel-gateway-pool.js";

const hostId = "host-pool";
const profileId = "profile-pool";
const ownerSessionId = "owner-session-pool";

function redeemMessage(
  capability: { capabilityId: string; secret: string },
  panelId: string,
) {
  return JSON.stringify({
    type: "redeem",
    capabilityId: capability.capabilityId,
    secret: capability.secret,
    ownerSessionId,
    panelId,
  });
}

describe("Panel gateway pool contract", () => {
  it("issues a fresh gateway per Panel Capability so remount-after-redeem succeeds", () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const pool = createPanelGatewayPool({ capabilities });

    // First mount: issue + redeem the capability on the bound gateway.
    const first = pool.openPanel({
      ownerSessionId,
      panelId: "panel-pool",
      hostId,
      profileId,
    });
    expect(
      first.gateway.validate(redeemMessage(first.issued, "panel-pool")).outcome,
    ).toBe("accepted");
    expect(first.gateway.redeemedCapabilityId).toBe(first.issued.capabilityId);

    // A React useEffect re-run issues a new capability for the same panel.
    // The reused panel key must not keep the old redeemed gateway, or the
    // fresh redeem returns unauthorized.
    const second = pool.openPanel({
      ownerSessionId,
      panelId: "panel-pool",
      hostId,
      profileId,
    });
    expect(second.issued.capabilityId).not.toBe(first.issued.capabilityId);
    expect(second.gateway).not.toBe(first.gateway);
    // The fresh gateway has no prior redemption blocking it.
    expect(second.gateway.redeemedCapabilityId).toBeUndefined();
    expect(
      second.gateway.validate(redeemMessage(second.issued, "panel-pool"))
        .outcome,
    ).toBe("accepted");

    // The prior connection was revoked when its gateway was retired; its
    // single-use secret remains replay-protected (never re-redeemable).
    expect(capabilities.connection(first.issued.capabilityId)).toBeUndefined();
    expect(
      capabilities.redeem(
        {
          type: "redeem",
          capabilityId: first.issued.capabilityId,
          secret: first.issued.secret,
          ownerSessionId,
          panelId: "panel-pool",
        },
        hostId,
        profileId,
      ).outcome,
    ).toBe("replayed");
  });

  it("closes a panel gateway and revokes its redeemed capability on release", () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const pool = createPanelGatewayPool({ capabilities });
    const opened = pool.openPanel({
      ownerSessionId,
      panelId: "panel-release",
      hostId,
      profileId,
    });
    opened.gateway.validate(redeemMessage(opened.issued, "panel-release"));
    expect(capabilities.size()).toBe(1);
    pool.closePanel({ hostId, profileId, panelId: "panel-release" });
    expect(capabilities.size()).toBe(0);
    expect(opened.gateway.redeemedCapabilityId).toBeUndefined();
  });
});
