import type { ControlLeaseManager } from "./control-lease.js";
import {
  clampPanelViewport,
  createPanelSession,
  DEFAULT_PANEL_VIEWPORT,
  type PanelClient,
  type PanelControlSession,
  type PanelControlState,
  type PanelControlStateListener,
  type PanelRole,
  type PanelSession,
  type PanelSessionClock,
  type PanelSessionConnection,
  type PanelViewport,
} from "./panel-session.js";

/**
 * Compatibility adapter for the former per-profile Control Lease registry.
 * Control Lease coordination, panel roles, reclaim, agent purpose, and the
 * controller viewport now live on the shared Panel session; this factory
 * delegates to that session.
 */

export type {
  PanelClient,
  PanelControlSession,
  PanelControlState,
  PanelControlStateListener,
  PanelRole,
  PanelViewport,
};

export type PanelConnectionState = PanelSessionConnection;

export type PanelControlClock = PanelSessionClock;

export type PanelControlStateOptions = {
  clock?: PanelControlClock;
  controlLeases: ControlLeaseManager;
  reclaimWindowMs?: number;
  session?: PanelSession;
};

export { clampPanelViewport, DEFAULT_PANEL_VIEWPORT };

export function createPanelControlState(options: PanelControlStateOptions) {
  return (
    options.session ??
    createPanelSession({
      clock: options.clock,
      controlLeases: options.controlLeases,
      reclaimWindowMs: options.reclaimWindowMs,
    })
  );
}
