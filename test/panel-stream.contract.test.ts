import { describe, expect, it } from "vitest";
import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_UNACKNOWLEDGED_FRAMES,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_MIN_FRAMES_PER_SECOND,
  PANEL_RECLAIM_WINDOW_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
  PANEL_RECONNECT_MAX_BACKOFF_MS,
} from "../src/shared/contracts.js";
import {
  clampViewport,
  createAutomationStreamAdapter,
  createFrameWindow,
  frameIntervalMs,
  reconnectBackoffMs,
} from "../src/panel/panel-stream.js";
import { createPanelCapabilityStore } from "../src/panel/panel-capability.js";

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

  it("starts at the frame-rate ceiling within the 5 to 15 FPS window", () => {
    const adapter = createAutomationStreamAdapter();
    expect(adapter.fps).toBe(PANEL_MAX_FRAMES_PER_SECOND);
    expect(adapter.minFps).toBe(PANEL_MIN_FRAMES_PER_SECOND);
    expect(frameIntervalMs(PANEL_MIN_FRAMES_PER_SECOND)).toBe(200);
    expect(frameIntervalMs(PANEL_MAX_FRAMES_PER_SECOND)).toBe(67);
  });

  it("sends frames only while no more than two await acknowledgement", () => {
    expect(PANEL_MAX_UNACKNOWLEDGED_FRAMES).toBe(2);
    const window = createFrameWindow<{ sequence: number }>();
    expect(window.canSend()).toBe(true);
    window.markSent(1);
    window.markSent(2);
    expect(window.canSend()).toBe(false);
    expect(window.unacknowledged).toBe(2);
    // Frames offered while the window is full are not queued: the newest
    // replaces the one held before it.
    window.hold({ sequence: 3 });
    window.hold({ sequence: 4 });
    expect(window.acknowledge(1)).toEqual({ sequence: 4 });
    // The held frame is handed out once.
    expect(window.acknowledge(1)).toBeUndefined();
  });

  it("treats an acknowledgement as covering every earlier frame", () => {
    const window = createFrameWindow<{ sequence: number }>();
    window.markSent(5);
    window.markSent(6);
    window.hold({ sequence: 7 });
    // The panel skipped drawing 5 because 6 decoded first.
    expect(window.acknowledge(6)).toEqual({ sequence: 7 });
    expect(window.unacknowledged).toBe(0);
    window.markSent(7);
    expect(window.acknowledge(99)).toBeUndefined();
    expect(window.unacknowledged).toBe(0);
  });

  it("keeps a held frame while the window stays full and forgets everything on reset", () => {
    const window = createFrameWindow<{ sequence: number }>();
    window.markSent(1);
    window.markSent(2);
    window.hold({ sequence: 3 });
    expect(window.acknowledge(0)).toBeUndefined();
    window.reset();
    expect(window.unacknowledged).toBe(0);
    expect(window.acknowledge(2)).toBeUndefined();
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

  it("drives a reconnect loop through the reconnecting state with bounded backoff", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    adapter.freezeInput();
    // beginReconnect transitions to "reconnecting" and yields the first delay.
    const firstDelay = adapter.beginReconnect();
    expect(adapter.state).toBe("reconnecting");
    expect(firstDelay).toBe(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
    // A failed attempt stays in "reconnecting" and advances the backoff.
    const secondDelay = adapter.reconnectFailed();
    expect(adapter.state).toBe("reconnecting");
    expect(secondDelay).toBe(1000);
    const thirdDelay = adapter.reconnectFailed();
    expect(thirdDelay).toBe(2000);
    // A successful attempt restores streaming and resets the backoff counter.
    expect(adapter.reconnectSucceeded()).toBe(true);
    expect(adapter.state).toBe("streaming");
    // A fresh disconnect starts a new reconnect loop at the initial backoff.
    adapter.freezeInput();
    expect(adapter.beginReconnect()).toBe(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
  });

  it("does not begin a reconnect loop after the stream is released", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    adapter.release();
    expect(adapter.beginReconnect()).toBe(0);
    expect(adapter.state).toBe("released");
  });

  it("keeps the stream live through a successful authorization rotation", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    expect(adapter.beginRotation()).toBe(true);
    expect(adapter.state).toBe("rotating");
    expect(adapter.rotationSucceeded()).toBe(true);
    expect(adapter.state).toBe("streaming");
  });

  it("does not freeze input during an in-flight authorization rotation", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    expect(adapter.beginRotation()).toBe(true);
    expect(adapter.freezeInput()).toBe(false);
    expect(adapter.state).toBe("rotating");
    expect(adapter.beginReconnect()).toBe(0);
    expect(adapter.state).toBe("rotating");
    expect(adapter.rotationSucceeded()).toBe(true);
    expect(adapter.state).toBe("streaming");
  });

  it("freezes input on a failed rotation so reconnect can begin", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    expect(adapter.beginRotation()).toBe(true);
    expect(adapter.rotationFailed()).toBe(true);
    expect(adapter.state).toBe("input-frozen");
    expect(adapter.beginReconnect()).toBe(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
    expect(adapter.state).toBe("reconnecting");
  });

  it("does not begin rotation after the stream is released", () => {
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    adapter.release();
    expect(adapter.beginRotation()).toBe(false);
    expect(adapter.state).toBe("released");
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
