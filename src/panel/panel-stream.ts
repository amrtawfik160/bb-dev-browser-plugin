import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_UNACKNOWLEDGED_FRAMES,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_MIN_FRAMES_PER_SECOND,
  PANEL_RECLAIM_WINDOW_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
  PANEL_RECONNECT_MAX_BACKOFF_MS,
} from "../shared/contracts.js";
import type { PanelCapabilityStore } from "./panel-capability.js";

/**
 * Automation Mode stream policy. The controlling panel drives one shared
 * logical viewport within supported bounds (up to 1920x1080). Other panels
 * scale and letterbox it. The browser produces at most 15 frames per second,
 * and each panel receives them only as fast as it acknowledges displaying
 * them, so a slow link lowers its frame rate rather than its currency. Input
 * freezes immediately on disconnect; the same panel has a
 * 10-second reclaim window and stream reconnect uses bounded backoff.
 * Scheduled authorization rotation replaces the live connection without
 * blanking the stream; a failed rotation freezes input and reconnects. v1
 * streams no audio and makes no DRM or high-fidelity media promise.
 */
export type PanelViewport = { width: number; height: number };

export type PanelStreamClock = { now(): number };

export type PanelStreamState =
  | "idle"
  | "streaming"
  | "rotating"
  | "input-frozen"
  | "reconnecting"
  | "released";

export type PanelStreamAdapterOptions = {
  clock?: PanelStreamClock;
  capabilities?: PanelCapabilityStore;
  reclaimWindowMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  minFps?: number;
  maxFps?: number;
};

export type PanelStreamAdapter = ReturnType<
  typeof createAutomationStreamAdapter
>;

export function clampViewport(viewport: PanelViewport): PanelViewport {
  return {
    width: Math.max(1, Math.min(viewport.width, PANEL_MAX_VIEWPORT_WIDTH)),
    height: Math.max(1, Math.min(viewport.height, PANEL_MAX_VIEWPORT_HEIGHT)),
  };
}

/**
 * Frame flow control for one panel connection. A frame is sent only while
 * fewer than {@link PANEL_MAX_UNACKNOWLEDGED_FRAMES} await the panel's
 * acknowledgement. A frame offered while the window is full is held, never
 * queued: a newer frame replaces it, and it goes out as soon as an
 * acknowledgement frees room, so the panel always catches up to the present.
 * An acknowledgement covers every frame up to its sequence, because the panel
 * skips drawing a frame that a newer one overtook.
 */
export function createFrameWindow<Frame extends { sequence: number }>(
  limit = PANEL_MAX_UNACKNOWLEDGED_FRAMES,
) {
  let inFlight: number[] = [];
  let held: Frame | undefined;

  return {
    canSend() {
      return inFlight.length < limit;
    },
    markSent(sequence: number) {
      inFlight.push(sequence);
    },
    hold(frame: Frame) {
      held = frame;
    },
    /** Returns the held frame when the acknowledgement made room for it. */
    acknowledge(sequence: number): Frame | undefined {
      inFlight = inFlight.filter((sent) => sent > sequence);
      if (held === undefined || inFlight.length >= limit) return undefined;
      const next = held;
      held = undefined;
      return next;
    },
    reset() {
      inFlight = [];
      held = undefined;
    },
    get unacknowledged() {
      return inFlight.length;
    },
  };
}

export function frameIntervalMs(fps: number): number {
  return Math.round(1000 / Math.max(1, fps));
}

/**
 * Bounded reconnect backoff. Each failure doubles the delay up to the cap,
 * with full jitter removed to keep the schedule deterministic and bounded.
 */
export function reconnectBackoffMs(
  attempt: number,
  options: { initialBackoffMs?: number; maxBackoffMs?: number } = {},
): number {
  const initial =
    options.initialBackoffMs ?? PANEL_RECONNECT_INITIAL_BACKOFF_MS;
  const max = options.maxBackoffMs ?? PANEL_RECONNECT_MAX_BACKOFF_MS;
  const exponent = Math.max(0, attempt - 1);
  const raw = initial * 2 ** exponent;
  return Math.min(max, Math.round(raw));
}

export function createAutomationStreamAdapter(
  options: PanelStreamAdapterOptions = {},
) {
  const clock = options.clock ?? { now: () => Date.now() };
  const reclaimWindowMs = options.reclaimWindowMs ?? PANEL_RECLAIM_WINDOW_MS;
  const initialBackoffMs =
    options.initialBackoffMs ?? PANEL_RECONNECT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? PANEL_RECONNECT_MAX_BACKOFF_MS;
  const minFps = options.minFps ?? PANEL_MIN_FRAMES_PER_SECOND;
  const maxFps = options.maxFps ?? PANEL_MAX_FRAMES_PER_SECOND;
  const capabilities = options.capabilities;
  let viewport: PanelViewport = {
    width: PANEL_MAX_VIEWPORT_WIDTH,
    height: PANEL_MAX_VIEWPORT_HEIGHT,
  };
  const fps = maxFps;
  let state: PanelStreamState = "idle";
  let disconnectedAt: number | undefined;
  let reconnectAttempt = 0;

  function setViewport(next: PanelViewport): PanelViewport {
    viewport = clampViewport(next);
    return viewport;
  }

  function start() {
    state = "streaming";
    reconnectAttempt = 0;
  }

  function freezeInput(): boolean {
    if (state === "released" || state === "rotating") return false;
    state = "input-frozen";
    disconnectedAt = clock.now();
    return true;
  }

  function markCapabilityDisconnected(capabilityId: string): boolean {
    if (capabilities === undefined) return false;
    return capabilities.markDisconnected(capabilityId);
  }

  function reclaim(capabilityId: string): boolean {
    if (state === "released") return false;
    if (disconnectedAt === undefined) return false;
    if (clock.now() - disconnectedAt > reclaimWindowMs) return false;
    if (capabilities !== undefined && !capabilities.reclaim(capabilityId)) {
      return false;
    }
    state = "streaming";
    reconnectAttempt = 0;
    disconnectedAt = undefined;
    return true;
  }

  function reclaimWindowRemainingMs(): number {
    if (disconnectedAt === undefined) return reclaimWindowMs;
    return Math.max(0, reclaimWindowMs - (clock.now() - disconnectedAt));
  }

  function nextReconnectDelayMs(): number {
    reconnectAttempt += 1;
    return reconnectBackoffMs(reconnectAttempt, {
      initialBackoffMs,
      maxBackoffMs,
    });
  }

  /**
   * Begin a reconnect loop after input froze on disconnect. Transitions the
   * stream to "reconnecting" and yields the first bounded backoff delay. The
   * caller schedules the attempt after the delay; {@link reconnectFailed}
   * advances the backoff and {@link reconnectSucceeded} restores streaming.
   * Returns 0 when the stream is released and cannot reconnect.
   */
  /**
   * Begin scheduled authorization rotation. Observation continues on the
   * current generation until a replacement connection is ready. Returns false
   * when the stream cannot rotate.
   */
  function beginRotation(): boolean {
    if (state !== "streaming") return false;
    state = "rotating";
    return true;
  }

  function rotationSucceeded(): boolean {
    if (state !== "rotating") return false;
    state = "streaming";
    return true;
  }

  function rotationFailed(): boolean {
    if (state !== "rotating") return false;
    state = "input-frozen";
    disconnectedAt = clock.now();
    return true;
  }

  function beginReconnect(): number {
    if (state === "released") return 0;
    if (state === "streaming") return 0;
    if (state === "rotating") return 0;
    state = "reconnecting";
    reconnectAttempt = 0;
    return nextReconnectDelayMs();
  }

  function reconnectFailed(): number {
    if (state !== "reconnecting") return 0;
    return nextReconnectDelayMs();
  }

  function reconnectSucceeded(): boolean {
    if (state !== "reconnecting") return false;
    state = "streaming";
    reconnectAttempt = 0;
    disconnectedAt = undefined;
    return true;
  }

  function release(): boolean {
    state = "released";
    disconnectedAt = undefined;
    return true;
  }

  return {
    setViewport,
    start,
    freezeInput,
    markCapabilityDisconnected,
    reclaim,
    reclaimWindowRemainingMs,
    nextReconnectDelayMs,
    beginRotation,
    rotationSucceeded,
    rotationFailed,
    beginReconnect,
    reconnectFailed,
    reconnectSucceeded,
    release,
    get viewport() {
      return viewport;
    },
    get fps() {
      return fps;
    },
    get state() {
      return state;
    },
    get reclaimWindowMs() {
      return reclaimWindowMs;
    },
    get minFps() {
      return minFps;
    },
    get maxFps() {
      return maxFps;
    },
  };
}
