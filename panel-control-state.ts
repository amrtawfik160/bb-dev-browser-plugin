import {
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_RECLAIM_WINDOW_MS,
  type BrowserControlLease,
} from "./contracts.js";
import {
  ControlLeaseError,
  type ControlLeaseManager,
} from "./control-lease.js";

/**
 * Multi-client Control Lease coordination for one Browser Profile
 * (ADR 0005/0007/0012). Every Browser Panel that opens one profile joins one
 * shared control session. Exactly one panel is the controller at a time and
 * owns the logical viewport that drives page layout; the rest are view-only
 * spectators that scale and letterbox that viewport. A second client starts
 * view-only and cannot send browser input until the owner explicitly chooses
 * Take control. Control transfer is atomic and visible to every panel, and
 * updates the controller and live agent-purpose indicators.
 *
 * Owner interaction has priority: Take control acquires the owner Control
 * Lease, which interrupts any active agent lease while preserving the page
 * for continued human use. The owner lease is then released so the
 * controller's input is gated by this coordination layer (not by a held
 * lease); the host rejects agent scripts while a controller is connected so
 * automation never races a human controller. On controller disconnect, input
 * freezes immediately and only the same panel can reclaim within a 10-second
 * window before control becomes generally available. Repeated launches and
 * reconnects never create duplicate panels or controllers.
 */

export type PanelRole = "controller" | "spectator";

export type PanelConnectionState = "connected" | "disconnected";

export type PanelClient = {
  panelId: string;
  ownerSessionId: string;
  role: PanelRole;
  connection: PanelConnectionState;
  viewport: PanelViewport;
  /**
   * Deadline (clock ms) until which this panel may reclaim control after a
   * disconnect, or null when it has no reclaim window.
   */
  reclaimUntil: number | null;
};

export type PanelViewport = { width: number; height: number };

export type PanelControlState = {
  controllerPanelId: string | null;
  /**
   * The controller's logical viewport that drives page layout. Spectators
   * scale and letterbox this viewport rather than resizing it independently.
   */
  controllerViewport: PanelViewport | null;
  /** The live agent-purpose indicator, when an agent holds the lease. */
  agentPurpose: string | null;
  panels: PanelClient[];
};

export type PanelControlStateListener = (state: PanelControlState) => void;

export type PanelControlClock = { now(): number };

export type PanelControlStateOptions = {
  clock?: PanelControlClock;
  controlLeases: ControlLeaseManager;
  reclaimWindowMs?: number;
};

export type PanelControlSession = ReturnType<typeof createPanelControlState>;

export const DEFAULT_PANEL_VIEWPORT: PanelViewport = {
  width: PANEL_MAX_VIEWPORT_WIDTH,
  height: PANEL_MAX_VIEWPORT_HEIGHT,
};

export function clampPanelViewport(viewport: PanelViewport): PanelViewport {
  return {
    width: Math.max(1, Math.min(viewport.width, PANEL_MAX_VIEWPORT_WIDTH)),
    height: Math.max(1, Math.min(viewport.height, PANEL_MAX_VIEWPORT_HEIGHT)),
  };
}

export function createPanelControlState(options: PanelControlStateOptions) {
  const clock = options.clock ?? { now: () => Date.now() };
  const controlLeases = options.controlLeases;
  const reclaimWindowMs = options.reclaimWindowMs ?? PANEL_RECLAIM_WINDOW_MS;
  let leaseKey: string | undefined;
  const panels = new Map<
    string,
    {
      ownerSessionId: string;
      role: PanelRole;
      connection: PanelConnectionState;
      viewport: PanelViewport;
      reclaimUntil: number | null;
    }
  >();
  let controllerPanelId: string | null = null;
  let controllerViewport: PanelViewport | null = null;
  /**
   * When the controller disconnects, only the same panel may reclaim within
   * this window. Other panels cannot take control until it expires.
   */
  let reclaimOwnerPanelId: string | null = null;
  let reclaimDeadline: number | null = null;
  const listeners = new Set<PanelControlStateListener>();

  function setLeaseKey(key: string) {
    leaseKey = key;
  }

  function reclaimActive(): boolean {
    return (
      reclaimOwnerPanelId !== null &&
      reclaimDeadline !== null &&
      clock.now() <= reclaimDeadline
    );
  }

  function clearReclaim() {
    reclaimOwnerPanelId = null;
    reclaimDeadline = null;
  }

  function leaseState(): BrowserControlLease | undefined {
    return leaseKey === undefined ? undefined : controlLeases.state(leaseKey);
  }

  function snapshot(): PanelControlState {
    const lease = leaseState();
    return {
      controllerPanelId,
      controllerViewport,
      agentPurpose: lease?.actor === "agent" ? (lease.purpose ?? null) : null,
      panels: [...panels.entries()].map(([panelId, client]) => ({
        panelId,
        ownerSessionId: client.ownerSessionId,
        role: client.role,
        connection: client.connection,
        viewport: client.viewport,
        /**
         * Deadline (clock ms) until which this panel may reclaim control after
         * a disconnect, or null when it has no reclaim window. A spectator with
         * an unexpired deadline must reclaim explicitly to regain input.
         */
        reclaimUntil: client.reclaimUntil,
      })),
    };
  }

  function emit() {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }

  /**
   * Acquire the owner Control Lease to interrupt any active agent lease, then
   * release it. The owner "controls" through this coordination layer rather
   * than by holding the lease; the host rejects agent scripts while a
   * controller is connected so automation never races a human controller.
   */
  async function interruptAgentForOwner(): Promise<void> {
    if (leaseKey === undefined) return;
    try {
      const lease = await controlLeases.acquireOwner(leaseKey);
      lease.release();
    } catch (error) {
      // acquireOwner throws ControlLeaseError when the owner request is
      // cancelled (for example the worker is shutting down). The transfer is
      // best-effort interruption; callers roll back control on failure.
      if (!(error instanceof ControlLeaseError)) throw error;
    }
  }

  /**
   * A panel joins the shared control session for its profile. The first panel
   * to connect becomes the controller; every later panel is a view-only
   * spectator. A reconnecting panel with the same id resumes its prior role
   * rather than creating a duplicate.
   */
  function connectPanel(
    panelId: string,
    ownerSessionId: string,
    viewport: PanelViewport = DEFAULT_PANEL_VIEWPORT,
  ): PanelRole {
    const existing = panels.get(panelId);
    if (existing !== undefined) {
      // A reconnect resumes the same panel; never duplicate it. A disconnected
      // controller that reconnects within its reclaim window must reclaim
      // explicitly so the reclaim path is observable and atomic.
      existing.connection = "connected";
      existing.ownerSessionId = ownerSessionId;
      emit();
      return existing.role;
    }
    const clamped = clampPanelViewport(viewport);
    if (controllerPanelId === null) {
      panels.set(panelId, {
        ownerSessionId,
        role: "controller",
        connection: "connected",
        viewport: clamped,
        reclaimUntil: null,
      });
      controllerPanelId = panelId;
      controllerViewport = clamped;
    } else {
      panels.set(panelId, {
        ownerSessionId,
        role: "spectator",
        connection: "connected",
        viewport: clamped,
        reclaimUntil: null,
      });
    }
    emit();
    return panels.get(panelId)!.role;
  }

  function disconnectPanel(panelId: string): boolean {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    client.connection = "disconnected";
    if (client.role === "controller") {
      // Input freezes immediately. Only the same panel can reclaim within the
      // window before control becomes available to other panels or agents.
      // The disconnected controller drops to spectator so a reconnect cannot
      // silently re-grant input; it must call reclaimControl explicitly.
      reclaimOwnerPanelId = panelId;
      reclaimDeadline = clock.now() + reclaimWindowMs;
      client.reclaimUntil = reclaimDeadline;
      client.role = "spectator";
      controllerPanelId = null;
      controllerViewport = null;
    }
    emit();
    return true;
  }

  /**
   * Reclaim control after a disconnect. Only the same panel that was the
   * controller may reclaim, and only within the reclaim window. After the
   * window expires, control becomes generally available.
   */
  function reclaimControl(panelId: string): boolean {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    if (client.connection !== "connected") return false;
    if (reclaimOwnerPanelId !== panelId) return false;
    if (!reclaimActive()) {
      // The window expired: control is now generally available.
      client.role = "spectator";
      client.reclaimUntil = null;
      clearReclaim();
      emit();
      return false;
    }
    // Within the window: restore the controller so input is re-granted only by
    // an explicit reclaim, never automatically on reconnect.
    client.reclaimUntil = null;
    clearReclaim();
    if (controllerPanelId !== null) return controllerPanelId === panelId;
    client.role = "controller";
    controllerPanelId = panelId;
    controllerViewport = clampPanelViewport(client.viewport);
    emit();
    return true;
  }

  /**
   * Atomically transfer control to a panel. The prior controller (if any)
   * becomes a spectator. Owner interaction interrupts an active agent Control
   * Lease via the lease manager and preserves the page for human use. The
   * transfer is visible to every panel through the broadcast state.
   */
  async function takeControl(
    panelId: string,
    viewport?: PanelViewport,
  ): Promise<boolean> {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    if (client.connection !== "connected") return false;
    if (controllerPanelId === panelId) {
      if (viewport !== undefined) {
        client.viewport = clampPanelViewport(viewport);
        controllerViewport = client.viewport;
      }
      await interruptAgentForOwner();
      emit();
      return true;
    }
    // During a controller's reclaim window, only that panel may reclaim;
    // another panel cannot take control until the window expires.
    if (reclaimActive() && reclaimOwnerPanelId !== panelId) return false;
    const priorController = controllerPanelId;
    if (priorController !== null) {
      const prior = panels.get(priorController);
      if (prior !== undefined) {
        prior.role = "spectator";
        prior.reclaimUntil = null;
      }
    }
    clearReclaim();
    client.role = "controller";
    client.reclaimUntil = null;
    if (viewport !== undefined) client.viewport = clampPanelViewport(viewport);
    controllerPanelId = panelId;
    controllerViewport = clampPanelViewport(client.viewport);
    // Interrupt any active agent lease before declaring the transfer, so the
    // transfer is atomic and the page is preserved for human use.
    await interruptAgentForOwner();
    emit();
    return true;
  }

  /**
   * The controller explicitly releases control and returns to spectator.
   * Control becomes available to other panels and agents. Still atomic and
   * broadcast to every panel.
   */
  function releaseControl(panelId: string): boolean {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    if (client.role !== "controller") return false;
    client.role = "spectator";
    client.reclaimUntil = null;
    controllerPanelId = null;
    controllerViewport = null;
    clearReclaim();
    emit();
    return true;
  }

  /**
   * Set the controller's logical viewport. Only the controller may change the
   * shared viewport; spectators scale and letterbox it. A spectator viewport
   * change only affects its own letterbox and never resizes the page.
   */
  function setViewport(panelId: string, viewport: PanelViewport): boolean {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    client.viewport = clampPanelViewport(viewport);
    if (client.role === "controller") {
      controllerViewport = client.viewport;
      emit();
    }
    return true;
  }

  /**
   * Whether a panel may send browser input. Only the connected controller may
   * send input; spectators and disconnected controllers are view-only.
   */
  function canInput(panelId: string): boolean {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    if (client.connection !== "connected") return false;
    return client.role === "controller";
  }

  /**
   * Whether a Browser Panel may drive the shared browser: navigate it, move
   * through its history, or change its tab set. Only the panel holding control
   * may, so a second panel that is view-only in the interface is view-only at
   * the boundary too, and two panels can never fight over one address bar.
   *
   * A panel this session has never seen is refused while another panel holds
   * control, and allowed when nobody does: a panel whose join failed is not a
   * reason to freeze a browser no one else is driving, and a request that
   * carries no panel identity at all — an agent script, the CLI, an owner tool
   * — never asks this question.
   */
  function canNavigate(panelId: string): boolean {
    if (controllerPanelId !== null) return controllerPanelId === panelId;
    return panels.get(panelId)?.role !== "spectator";
  }

  function role(panelId: string): PanelRole | undefined {
    return panels.get(panelId)?.role;
  }

  function state(): PanelControlState {
    return snapshot();
  }

  function subscribe(listener: PanelControlStateListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function closePanel(panelId: string): boolean {
    const client = panels.get(panelId);
    if (client === undefined) return false;
    if (client.role === "controller") {
      controllerPanelId = null;
      controllerViewport = null;
      clearReclaim();
    }
    panels.delete(panelId);
    emit();
    return true;
  }

  /**
   * Revoke control for a profile (for example on profile switch or host
   * disconnect). Every panel becomes a spectator and any agent lease is
   * revoked.
   */
  function revoke() {
    controllerPanelId = null;
    controllerViewport = null;
    clearReclaim();
    if (leaseKey !== undefined) controlLeases.revoke(leaseKey);
    for (const client of panels.values()) {
      client.role = "spectator";
      client.reclaimUntil = null;
    }
    emit();
  }

  function dispose() {
    listeners.clear();
    panels.clear();
    controllerPanelId = null;
    controllerViewport = null;
    clearReclaim();
  }

  return {
    setLeaseKey,
    connectPanel,
    disconnectPanel,
    reclaimControl,
    takeControl,
    releaseControl,
    setViewport,
    canInput,
    canNavigate,
    role,
    state,
    subscribe,
    closePanel,
    revoke,
    dispose,
    get reclaimWindowMs() {
      return reclaimWindowMs;
    },
    get controllerPanelId() {
      return controllerPanelId;
    },
    get controllerViewport() {
      return controllerViewport;
    },
  };
}
