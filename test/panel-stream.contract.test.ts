import { describe, expect, it } from "vitest";
import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_MIN_FRAMES_PER_SECOND,
  PANEL_RECLAIM_WINDOW_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
  PANEL_RECONNECT_MAX_BACKOFF_MS,
} from "../contracts.js";
import {
  adaptFrameRate,
  clampViewport,
  createAutomationStreamAdapter,
  frameIntervalMs,
  reconnectBackoffMs,
} from "../panel-stream.js";
import { createPanelCapabilityStore } from "../panel-capability.js";

const binding = {
  ownerSessionId: "owner-session-stream",
  panelId: "panel-stream",
  hostId: "host-stream",
  profileId: "profile-stream",
};

describe("Automation Mode stream policy contract", () => {
  it("clamps the logical viewport to the supported 1920x1080 bounds", () => {
    expect(clampViewport({ width: 2560, height: 1440 })).toEqual({
      width: PANEL_MAX_VIEWPORT_WIDTH,
      height: PANEL_MAX_VIEWPORT_HEIGHT,
    });
    expect(clampViewport({ width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
    });
    expect(clampViewport({ width: 0, height: -10 })).toEqual({
      width: 1,
      height: 1,
    });
    const adapter = createAutomationStreamAdapter();
    expect(adapter.setViewport({ width: 4000, height: 2000 })).toEqual({
      width: PANEL_MAX_VIEWPORT_WIDTH,
      height: PANEL_MAX_VIEWPORT_HEIGHT,
    });
  });

  it("adapts between 5 and 15 frames per second under congestion", () => {
    expect(adaptFrameRate(15, 0)).toBe(PANEL_MAX_FRAMES_PER_SECOND);
    expect(adaptFrameRate(15, 1)).toBe(10);
    expect(adaptFrameRate(15, 3)).toBe(PANEL_MIN_FRAMES_PER_SECOND);
    // Congestion never lowers below the floor and headroom never exceeds the ceiling.
    expect(adaptFrameRate(2, 5)).toBe(PANEL_MIN_FRAMES_PER_SECOND);
    expect(adaptFrameRate(30, 0)).toBe(PANEL_MAX_FRAMES_PER_SECOND);
    const adapter = createAutomationStreamAdapter();
    expect(adapter.applyCongestion(2)).toBe(PANEL_MIN_FRAMES_PER_SECOND);
    expect(adapter.fps).toBe(PANEL_MIN_FRAMES_PER_SECOND);
    expect(frameIntervalMs(PANEL_MIN_FRAMES_PER_SECOND)).toBe(200);
    expect(frameIntervalMs(PANEL_MAX_FRAMES_PER_SECOND)).toBe(67);
  });

  it("freezes input immediately on disconnect and reclaims within the 10-second window", () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const capabilities = createPanelCapabilityStore({ clock });
    const issued = capabilities.issue(binding);
    capabilities.redeem(
      {
        type: "redeem",
        capabilityId: issued.capabilityId,
        secret: issued.secret,
        ownerSessionId: binding.ownerSessionId,
        panelId: binding.panelId,
      },
      binding.hostId,
      binding.profileId,
    );
    const adapter = createAutomationStreamAdapter({ clock, capabilities });
    adapter.start();
    expect(adapter.state).toBe("streaming");
    expect(adapter.freezeInput()).toBe(true);
    expect(adapter.state).toBe("input-frozen");
    expect(adapter.markCapabilityDisconnected(issued.capabilityId)).toBe(true);
    // Reclaim within the window restores the stream.
    now += PANEL_RECLAIM_WINDOW_MS - 1;
    expect(adapter.reclaim(issued.capabilityId)).toBe(true);
    expect(adapter.state).toBe("streaming");
    expect(adapter.reclaimWindowRemainingMs()).toBe(PANEL_RECLAIM_WINDOW_MS);
  });

  it("rejects reclaim after the 10-second reclaim window elapses", () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const adapter = createAutomationStreamAdapter({
      clock,
      reclaimWindowMs: 100,
    });
    adapter.start();
    adapter.freezeInput();
    now += 200;
    expect(adapter.reclaim("any-capability")).toBe(false);
  });

  it("reconnects with bounded backoff up to the cap", () => {
    const delays: number[] = [];
    // Simulate a sequence of reconnect attempts.
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    adapter.freezeInput();
    for (let i = 0; i < 6; i += 1) {
      delays.push(adapter.nextReconnectDelayMs());
    }
    // Bounded exponential: 500, 1000, 2000, 4000, 8000, 8000 (capped).
    expect(delays[0]).toBe(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
    expect(delays[1]).toBe(1000);
    expect(delays[2]).toBe(2000);
    expect(delays[3]).toBe(4000);
    expect(delays[4]).toBe(PANEL_RECONNECT_MAX_BACKOFF_MS);
    expect(delays[5]).toBe(PANEL_RECONNECT_MAX_BACKOFF_MS);
    expect(reconnectBackoffMs(1)).toBe(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
    expect(reconnectBackoffMs(10)).toBe(PANEL_RECONNECT_MAX_BACKOFF_MS);
  });

  it("never streams audio or exceeds the declared viewport after release", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    adapter.release();
    expect(adapter.state).toBe("released");
    expect(adapter.reclaim("any")).toBe(false);
    expect(adapter.viewport).toEqual({
      width: PANEL_MAX_VIEWPORT_WIDTH,
      height: PANEL_MAX_VIEWPORT_HEIGHT,
    });
  });
});
