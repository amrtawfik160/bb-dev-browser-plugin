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
 * One host-owned Panel session per Browser Profile. It is the authority for
 * panel membership, connection generations, panel roles, Control Lease
 * coordination, reconnect reclaim, agent purpose, and the controller
 * viewport (ADR 0005/0007/0012). Browser Profile data stays on the workspace
 * host (ADR 0012).
 */

export type PanelSessionClock = { now(): number };

export type PanelSessionConnection = "connected" | "disconnected";

export type PanelRole = "controller" | "spectator";

export type PanelViewport = { width: number; height: number };

export type PanelClient = {
  panelId: string;
  ownerSessionId: string;
  role: PanelRole;
  connection: PanelSessionConnection;
  viewport: PanelViewport;
  reclaimUntil: number | null;
};

export type PanelControlState = {
  controllerPanelId: string | null;
  controllerViewport: PanelViewport | null;
  agentPurpose: string | null;
  panels: PanelClient[];
};

export type PanelControlStateListener = (state: PanelControlState) => void;

export type PanelSessionMember = {
  panelId: string;
  ownerSessionId: string;
  connection: PanelSessionConnection;
  generation: number;
  reclaimUntil: number | null;
};

export type PanelSessionSnapshot = {
  panels: PanelSessionMember[];
};

export type PanelSessionJoin = { generation: number };

export type PanelSessionActivation =
  | { outcome: "activated"; supersededGenerations: number[] }
  | { outcome: "rejected" };

export type PanelSessionTarget = { hostId: string; profileId: string };

export type PanelSessionOptions = {
  clock?: PanelSessionClock;
  reclaimWindowMs?: number;
  controlLeases?: ControlLeaseManager;
};

export type PanelSessionRegistryOptions = PanelSessionOptions;

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

type PanelSessionRecord = {
  ownerSessionId: string;
  connection: PanelSessionConnection;
  role: PanelRole;
  viewport: PanelViewport;
  authoritativeGeneration: number | null;
  pendingGeneration: number | null;
  nextGeneration: number;
  reclaimUntil: number | null;
};

function panelSessionKey(target: PanelSessionTarget) {
  return `${target.hostId}\u0000${target.profileId}`;
}

export function createPanelSession(options: PanelSessionOptions = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const reclaimWindowMs = options.reclaimWindowMs ?? PANEL_RECLAIM_WINDOW_MS;
  const controlLeases = options.controlLeases;
  const panels = new Map<string, PanelSessionRecord>();
  let leaseKey: string | undefined;
  let controllerPanelId: string | null = null;
  let controllerViewport: PanelViewport | null = null;
  let reclaimOwnerPanelId: string | null = null;
  let reclaimDeadline: number | null = null;
  const listeners = new Set<PanelControlStateListener>();

  function setLeaseKey(key: string) {
    leaseKey = key;
  }

  function reclaimActive() {
    return (
      reclaimOwnerPanelId !== null &&
      reclaimDeadline !== null &&
      clock.now() <= reclaimDeadline
    );
  }

  function clearControlReclaim() {
    reclaimOwnerPanelId = null;
    reclaimDeadline = null;
  }

  function leaseState(): BrowserControlLease | undefined {
    return leaseKey === undefined || controlLeases === undefined
      ? undefined
      : controlLeases.state(leaseKey);
  }

  function expireReclaim() {
    const now = clock.now();
    for (const [panelId, member] of panels) {
      if (
        member.connection === "disconnected" &&
        member.reclaimUntil !== null &&
        now > member.reclaimUntil
      ) {
        if (controllerPanelId === panelId) {
          controllerPanelId = null;
          controllerViewport = null;
        }
        if (reclaimOwnerPanelId === panelId) clearControlReclaim();
        panels.delete(panelId);
      }
    }
    if (
      reclaimDeadline !== null &&
      reclaimOwnerPanelId !== null &&
      now > reclaimDeadline
    ) {
      clearControlReclaim();
    }
  }

  function snapshot(): PanelSessionSnapshot {
    expireReclaim();
    return {
      panels: [...panels.entries()].map(([panelId, member]) => ({
        panelId,
        ownerSessionId: member.ownerSessionId,
        connection: member.connection,
        generation: member.authoritativeGeneration ?? 0,
        reclaimUntil: member.reclaimUntil,
      })),
    };
  }

  function state(): PanelControlState {
    expireReclaim();
    const lease = leaseState();
    return {
      controllerPanelId,
      controllerViewport,
      agentPurpose: lease?.actor === "agent" ? (lease.purpose ?? null) : null,
      panels: [...panels.entries()].map(([panelId, member]) => ({
        panelId,
        ownerSessionId: member.ownerSessionId,
        role: member.role,
        connection: member.connection,
        viewport: member.viewport,
        reclaimUntil:
          reclaimOwnerPanelId === panelId && reclaimDeadline !== null
            ? reclaimDeadline
            : null,
      })),
    };
  }

  function emit() {
    const next = state();
    for (const listener of listeners) listener(next);
  }

  function subscribe(listener: PanelControlStateListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function becomeController(panelId: string, member: PanelSessionRecord) {
    member.role = "controller";
    member.reclaimUntil = null;
    controllerPanelId = panelId;
    controllerViewport = clampPanelViewport(member.viewport);
  }

  function addPanel(
    panelId: string,
    ownerSessionId: string,
    viewport: PanelViewport = DEFAULT_PANEL_VIEWPORT,
  ) {
    const clamped = clampPanelViewport(viewport);
    const role: PanelRole =
      controllerPanelId === null ? "controller" : "spectator";
    const record: PanelSessionRecord = {
      ownerSessionId,
      connection: "connected",
      role,
      viewport: clamped,
      authoritativeGeneration: null,
      pendingGeneration: null,
      nextGeneration: 0,
      reclaimUntil: null,
    };
    panels.set(panelId, record);
    if (role === "controller") {
      controllerPanelId = panelId;
      controllerViewport = clamped;
    }
    return record;
  }

  function joinPanel(
    panelId: string,
    ownerSessionId: string,
  ): PanelSessionJoin {
    expireReclaim();
    const existing = panels.get(panelId);
    if (existing !== undefined) {
      existing.nextGeneration += 1;
      existing.pendingGeneration = existing.nextGeneration;
      existing.ownerSessionId = ownerSessionId;
      existing.connection = "connected";
      existing.reclaimUntil = null;
      emit();
      return { generation: existing.pendingGeneration };
    }
    const member = addPanel(panelId, ownerSessionId);
    member.pendingGeneration = 1;
    member.nextGeneration = 1;
    emit();
    return { generation: 1 };
  }

  function connectPanel(
    panelId: string,
    ownerSessionId: string,
    viewport: PanelViewport = DEFAULT_PANEL_VIEWPORT,
  ): PanelRole {
    expireReclaim();
    const existing = panels.get(panelId);
    if (existing !== undefined) {
      existing.connection = "connected";
      existing.ownerSessionId = ownerSessionId;
      existing.reclaimUntil = null;
      emit();
      return existing.role;
    }
    const member = addPanel(panelId, ownerSessionId, viewport);
    emit();
    return member.role;
  }

  function activateGeneration(
    panelId: string,
    generation: number,
  ): PanelSessionActivation {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return { outcome: "rejected" };
    if (member.pendingGeneration !== generation) return { outcome: "rejected" };
    const authoritative = member.authoritativeGeneration ?? 0;
    if (generation <= authoritative) return { outcome: "rejected" };
    const supersededGenerations =
      member.authoritativeGeneration === null
        ? []
        : [member.authoritativeGeneration];
    member.authoritativeGeneration = generation;
    member.pendingGeneration = null;
    return { outcome: "activated", supersededGenerations };
  }

  function acceptsGeneration(panelId: string, generation: number) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    if (member.connection !== "connected") return false;
    return member.authoritativeGeneration === generation;
  }

  function dropController(panelId: string) {
    if (controllerPanelId !== panelId) return;
    controllerPanelId = null;
    controllerViewport = null;
  }

  function disconnectPanel(panelId: string) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    member.connection = "disconnected";
    member.reclaimUntil = clock.now() + reclaimWindowMs;
    if (member.role === "controller") {
      reclaimOwnerPanelId = panelId;
      reclaimDeadline = member.reclaimUntil;
      member.role = "spectator";
      dropController(panelId);
    }
    emit();
    return true;
  }

  async function interruptAgentForOwner() {
    if (leaseKey === undefined || controlLeases === undefined) return;
    try {
      const lease = await controlLeases.acquireOwner(leaseKey);
      lease.release();
    } catch (error) {
      if (!(error instanceof ControlLeaseError)) throw error;
    }
  }

  function reclaimControl(panelId: string) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    if (member.connection !== "connected") return false;
    if (reclaimOwnerPanelId !== panelId) return false;
    if (!reclaimActive()) {
      member.role = "spectator";
      member.reclaimUntil = null;
      clearControlReclaim();
      emit();
      return false;
    }
    member.reclaimUntil = null;
    clearControlReclaim();
    if (controllerPanelId !== null) return controllerPanelId === panelId;
    becomeController(panelId, member);
    emit();
    return true;
  }

  async function takeControl(
    panelId: string,
    viewport?: PanelViewport,
  ): Promise<boolean> {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    if (member.connection !== "connected") return false;
    if (controllerPanelId === panelId) {
      if (viewport !== undefined) {
        member.viewport = clampPanelViewport(viewport);
        controllerViewport = member.viewport;
      }
      await interruptAgentForOwner();
      emit();
      return true;
    }
    if (reclaimActive() && reclaimOwnerPanelId !== panelId) return false;
    const priorController = controllerPanelId;
    if (priorController !== null) {
      const prior = panels.get(priorController);
      if (prior !== undefined) {
        prior.role = "spectator";
        prior.reclaimUntil = null;
      }
    }
    clearControlReclaim();
    if (viewport !== undefined) member.viewport = clampPanelViewport(viewport);
    becomeController(panelId, member);
    await interruptAgentForOwner();
    emit();
    return true;
  }

  function releaseControl(panelId: string) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    if (member.role !== "controller") return false;
    member.role = "spectator";
    member.reclaimUntil = null;
    dropController(panelId);
    clearControlReclaim();
    emit();
    return true;
  }

  function setViewport(panelId: string, viewport: PanelViewport) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    member.viewport = clampPanelViewport(viewport);
    if (member.role === "controller") {
      controllerViewport = member.viewport;
      emit();
    }
    return true;
  }

  function canInput(panelId: string) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    if (member.connection !== "connected") return false;
    return member.role === "controller";
  }

  function canNavigate(panelId: string) {
    expireReclaim();
    if (controllerPanelId !== null) return controllerPanelId === panelId;
    const member = panels.get(panelId);
    if (member !== undefined) return member.role !== "spectator";
    return panels.size === 0;
  }

  function role(panelId: string): PanelRole | undefined {
    expireReclaim();
    return panels.get(panelId)?.role;
  }

  function closePanel(panelId: string) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    if (member.role === "controller") {
      dropController(panelId);
      clearControlReclaim();
    }
    if (reclaimOwnerPanelId === panelId) clearControlReclaim();
    panels.delete(panelId);
    emit();
    return true;
  }

  function revoke() {
    expireReclaim();
    controllerPanelId = null;
    controllerViewport = null;
    clearControlReclaim();
    if (leaseKey !== undefined) controlLeases?.revoke(leaseKey);
    for (const member of panels.values()) {
      member.role = "spectator";
      member.reclaimUntil = null;
    }
    emit();
  }

  function dispose() {
    listeners.clear();
    panels.clear();
    controllerPanelId = null;
    controllerViewport = null;
    clearControlReclaim();
  }

  return {
    setLeaseKey,
    joinPanel,
    connectPanel,
    activateGeneration,
    acceptsGeneration,
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
    snapshot,
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

export type PanelSession = ReturnType<typeof createPanelSession>;
export type PanelControlSession = PanelSession;

export function createPanelSessionRegistry(
  options: PanelSessionRegistryOptions = {},
) {
  const sessions = new Map<string, PanelSession>();

  function sessionFor(target: PanelSessionTarget) {
    const key = panelSessionKey(target);
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const session = createPanelSession(options);
    session.setLeaseKey(key);
    sessions.set(key, session);
    return session;
  }

  function forEach(
    visitor: (session: PanelSession, target: PanelSessionTarget) => void,
  ) {
    for (const [key, session] of sessions) {
      const separator = key.indexOf("\u0000");
      visitor(session, {
        hostId: key.slice(0, separator),
        profileId: key.slice(separator + 1),
      });
    }
  }

  function dispose() {
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  }

  return { sessionFor, forEach, dispose };
}

export type PanelSessionRegistry = ReturnType<
  typeof createPanelSessionRegistry
>;
