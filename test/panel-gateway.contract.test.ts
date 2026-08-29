import { describe, expect, it } from "vitest";
import {
  PANEL_GATEWAY_BANDWIDTH_BYTES_PER_SECOND,
  PANEL_GATEWAY_BIND_HOST,
  PANEL_GATEWAY_INPUT_MAX_PER_SECOND,
  PANEL_GATEWAY_MESSAGE_MAX_BYTES,
} from "../contracts.js";
import { createPanelCapabilityStore } from "../panel-capability.js";
import { createPanelGateway } from "../panel-gateway.js";

const hostId = "host-gateway";
const profileId = "profile-gateway";
const binding = {
  ownerSessionId: "owner-session-gateway",
  panelId: "panel-gateway",
  hostId,
  profileId,
};

function redeemMessage(capability: { capabilityId: string; secret: string }) {
  return {
    type: "redeem" as const,
    capabilityId: capability.capabilityId,
    secret: capability.secret,
    ownerSessionId: binding.ownerSessionId,
    panelId: binding.panelId,
  };
}

function setupGateway(options: { clock?: { now(): number } } = {}) {
  let now = 1_000_000;
  const clock = options.clock ?? { now: () => now };
  const capabilities = createPanelCapabilityStore({ clock });
  const gateway = createPanelGateway({
    capabilities,
    hostId,
    profileId,
    clock,
  });
  const issued = capabilities.issue(binding);
  return {
    clock,
    capabilities,
    gateway,
    issued,
    advanceTime(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("Panel gateway contract", () => {
  it("binds only to loopback and never exposes an external listener", () => {
    const { gateway } = setupGateway();
    expect(gateway.declaredBindHost()).toBe(PANEL_GATEWAY_BIND_HOST);
    const port = gateway.choosePort();
    expect(port).toBeGreaterThanOrEqual(49152);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("redeems the Panel Capability in the first WebSocket message", () => {
    const { gateway, issued } = setupGateway();
    const result = gateway.validate(json(redeemMessage(issued)));
    expect(result.outcome).toBe("accepted");
    expect(gateway.redeemedCapabilityId).toBe(issued.capabilityId);
  });

  it("rejects a second capability redemption on the same gateway", () => {
    const { gateway, capabilities, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const second = capabilities.issue(binding);
    const result = gateway.validate(json(redeemMessage(second)));
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("unauthorized");
      expect(result.message).not.toContain(second.secret);
    }
  });

  it("rejects any message before the capability is redeemed", () => {
    const { gateway } = setupGateway();
    const result = gateway.validate(json({ type: "ping" }));
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected")
      expect(result.reason).toBe("unauthorized");
  });

  it("rejects malformed JSON and malformed message shapes", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const malformedJson = gateway.validate("{not json");
    expect(malformedJson.outcome).toBe("rejected");
    if (malformedJson.outcome === "rejected")
      expect(malformedJson.reason).toBe("malformed");
    const nonObject = gateway.validate(json("hello"));
    expect(nonObject.outcome).toBe("rejected");
    if (nonObject.outcome === "rejected")
      expect(nonObject.reason).toBe("malformed");
    const badRedeem = gateway.validate(
      json({ type: "redeem", capabilityId: issued.capabilityId }),
    );
    expect(badRedeem.outcome).toBe("rejected");
    if (badRedeem.outcome === "rejected")
      expect(badRedeem.reason).toBe("malformed");
    const unknownType = gateway.validate(json({ type: "frobnicate" }));
    expect(unknownType.outcome).toBe("rejected");
    if (unknownType.outcome === "rejected")
      expect(unknownType.reason).toBe("malformed");
  });

  it("rejects messages that exceed the size cap without parsing them", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const oversized = `${"x".repeat(PANEL_GATEWAY_MESSAGE_MAX_BYTES + 1)}`;
    const result = gateway.validate(oversized);
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") expect(result.reason).toBe("too-large");
  });

  it("rate-limits input to the configured per-second cap", () => {
    let now = 1_000_000;
    const { gateway, issued } = setupGateway({ clock: { now: () => now } });
    gateway.validate(json(redeemMessage(issued)));
    let rejected: string | undefined;
    for (
      let sequence = 1;
      sequence <= PANEL_GATEWAY_INPUT_MAX_PER_SECOND;
      sequence += 1
    ) {
      const result = gateway.validate(
        json({ type: "input", sequence, payload: { kind: "move" } }),
      );
      expect(result.outcome).toBe("accepted");
    }
    const overLimit = gateway.validate(
      json({
        type: "input",
        sequence: PANEL_GATEWAY_INPUT_MAX_PER_SECOND + 1,
        payload: {},
      }),
    );
    expect(overLimit.outcome).toBe("rejected");
    if (overLimit.outcome === "rejected") {
      rejected = overLimit.reason;
    }
    expect(rejected).toBe("rate-limited");
    // A new one-second window resets the rate limit.
    now += 1000;
    const afterReset = gateway.validate(
      json({
        type: "input",
        sequence: PANEL_GATEWAY_INPUT_MAX_PER_SECOND + 2,
        payload: {},
      }),
    );
    expect(afterReset.outcome).toBe("accepted");
  });

  it("drops stale frames before delaying input and rejects older input sequences", () => {
    const now = 1_000_000;
    const { gateway, issued } = setupGateway({ clock: { now: () => now } });
    gateway.validate(json(redeemMessage(issued)));
    const firstFrame = gateway.validate(
      json({
        type: "frame",
        sequence: 10,
        bytes: 1024,
        deadlineAt: now + 1000,
      }),
    );
    expect(firstFrame.outcome).toBe("accepted");
    // A stale sequence is dropped so congestion never delays input behind old pixels.
    const staleFrame = gateway.validate(
      json({ type: "frame", sequence: 9, bytes: 1024, deadlineAt: now + 1000 }),
    );
    expect(staleFrame.outcome).toBe("rejected");
    if (staleFrame.outcome === "rejected")
      expect(staleFrame.reason).toBe("stale-frame");
    // A frame whose deadline passed is dropped.
    const expiredFrame = gateway.validate(
      json({ type: "frame", sequence: 11, bytes: 1024, deadlineAt: now - 1 }),
    );
    expect(expiredFrame.outcome).toBe("rejected");
    if (expiredFrame.outcome === "rejected")
      expect(expiredFrame.reason).toBe("stale-frame");
    // Older input sequences are dropped after a newer one has been accepted.
    gateway.validate(json({ type: "input", sequence: 7, payload: {} }));
    const staleInput = gateway.validate(
      json({ type: "input", sequence: 1, payload: {} }),
    );
    expect(staleInput.outcome).toBe("rejected");
    if (staleInput.outcome === "rejected")
      expect(staleInput.reason).toBe("stale-frame");
  });

  it("caps panel bandwidth per second and admits frames once the window resets", () => {
    let now = 1_000_000;
    const { gateway, issued } = setupGateway({ clock: { now: () => now } });
    gateway.validate(json(redeemMessage(issued)));
    const chunk = Math.floor(PANEL_GATEWAY_BANDWIDTH_BYTES_PER_SECOND / 2);
    const first = gateway.validate(
      json({
        type: "frame",
        sequence: 1,
        bytes: chunk,
        deadlineAt: now + 1000,
      }),
    );
    expect(first.outcome).toBe("accepted");
    const second = gateway.validate(
      json({
        type: "frame",
        sequence: 2,
        bytes: chunk + 1,
        deadlineAt: now + 1000,
      }),
    );
    expect(second.outcome).toBe("rejected");
    if (second.outcome === "rejected")
      expect(second.reason).toBe("bandwidth-exceeded");
    now += 1000;
    const afterReset = gateway.validate(
      json({
        type: "frame",
        sequence: 3,
        bytes: chunk,
        deadlineAt: now + 1000,
      }),
    );
    expect(afterReset.outcome).toBe("accepted");
  });

  it("revokes the capability when the gateway closes on panel close", () => {
    const { gateway, capabilities, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    expect(gateway.redeemedCapabilityId).toBe(issued.capabilityId);
    gateway.close();
    expect(gateway.redeemedCapabilityId).toBeUndefined();
    expect(capabilities.size()).toBe(0);
  });

  it("accepts an explicit clipboard copy action after redemption", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const result = gateway.validate(
      json({ type: "clipboard_copy", copyId: "copy-1" }),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.message).toEqual({
        kind: "clipboard_copy",
        copyId: "copy-1",
      });
    }
  });

  it("accepts an explicit clipboard paste action after redemption", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const result = gateway.validate(
      json({ type: "clipboard_paste", pasteId: "paste-1", bytes: 32 }),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.message).toEqual({
        kind: "clipboard_paste",
        pasteId: "paste-1",
        bytes: 32,
      });
    }
  });

  it("accepts a transfer cancellation after redemption", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const result = gateway.validate(
      json({ type: "transfer_cancel", transferId: "transfer-1" }),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.message).toEqual({
        kind: "transfer_cancel",
        transferId: "transfer-1",
      });
    }
  });

  it("accepts a download cancellation after redemption (issue #20)", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const result = gateway.validate(
      json({ type: "download_cancel", downloadId: "download-1" }),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted") {
      expect(result.message).toEqual({
        kind: "download_cancel",
        downloadId: "download-1",
      });
    }
  });

  it("rejects a download cancellation before redemption", () => {
    const { gateway } = setupGateway();
    const result = gateway.validate(
      json({ type: "download_cancel", downloadId: "download-1" }),
    );
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("unauthorized");
    }
  });

  it("rejects a malformed clipboard copy before redemption", () => {
    const { gateway } = setupGateway();
    const result = gateway.validate(json({ type: "clipboard_copy" }));
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected")
      expect(result.reason).toBe("unauthorized");
  });

  it("rejects a malformed clipboard paste shape after redemption", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const result = gateway.validate(
      json({ type: "clipboard_paste", pasteId: "paste-1" }),
    );
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") expect(result.reason).toBe("malformed");
  });

  it("rate-limits clipboard actions to the per-second cap", () => {
    let now = 1_000_000;
    const { gateway, issued } = setupGateway({ clock: { now: () => now } });
    gateway.validate(json(redeemMessage(issued)));
    let lastReason: string | undefined;
    for (let i = 0; i <= PANEL_GATEWAY_INPUT_MAX_PER_SECOND; i += 1) {
      const result = gateway.validate(
        json({ type: "clipboard_copy", copyId: `copy-${i}` }),
      );
      if (result.outcome === "rejected") lastReason = result.reason;
    }
    expect(lastReason).toBe("rate-limited");
    // After the window resets, clipboard actions are admitted again.
    now += 1000;
    const afterReset = gateway.validate(
      json({ type: "clipboard_copy", copyId: "copy-next" }),
    );
    expect(afterReset.outcome).toBe("accepted");
  });
});
