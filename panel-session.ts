import { PANEL_RECLAIM_WINDOW_MS } from "./contracts.js";

/**
 * One host-owned Panel session per Browser Profile. It tracks connected panel
 * membership and the authoritative physical connection generation for each
 * panel so two Browser Panels can share a profile without duplicating members
 * or letting an obsolete connection act. Browser Profile data stays on the
 * workspace host (ADR 0012).
 */

export type PanelSessionClock = { now(): number };

export type PanelSessionConnection = "connected" | "disconnected";

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
};

export type PanelSessionRegistryOptions = PanelSessionOptions;

type PanelSessionRecord = {
  ownerSessionId: string;
  connection: PanelSessionConnection;
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
  const panels = new Map<string, PanelSessionRecord>();

  function expireReclaim() {
    const now = clock.now();
    for (const [panelId, member] of panels) {
      if (
        member.connection === "disconnected" &&
        member.reclaimUntil !== null &&
        now > member.reclaimUntil
      ) {
        panels.delete(panelId);
      }
    }
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
      return { generation: existing.pendingGeneration };
    }
    panels.set(panelId, {
      ownerSessionId,
      connection: "connected",
      authoritativeGeneration: null,
      pendingGeneration: 1,
      nextGeneration: 1,
      reclaimUntil: null,
    });
    return { generation: 1 };
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

  function disconnectPanel(panelId: string) {
    expireReclaim();
    const member = panels.get(panelId);
    if (member === undefined) return false;
    member.connection = "disconnected";
    member.reclaimUntil = clock.now() + reclaimWindowMs;
    return true;
  }

  function closePanel(panelId: string) {
    expireReclaim();
    return panels.delete(panelId);
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

  function dispose() {
    panels.clear();
  }

  return {
    joinPanel,
    activateGeneration,
    acceptsGeneration,
    disconnectPanel,
    closePanel,
    snapshot,
    dispose,
  };
}

export type PanelSession = ReturnType<typeof createPanelSession>;

export function createPanelSessionRegistry(
  options: PanelSessionRegistryOptions = {},
) {
  const sessions = new Map<string, PanelSession>();

  function sessionFor(target: PanelSessionTarget) {
    const key = panelSessionKey(target);
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const session = createPanelSession(options);
    sessions.set(key, session);
    return session;
  }

  function dispose() {
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  }

  return { sessionFor, dispose };
}

export type PanelSessionRegistry = ReturnType<
  typeof createPanelSessionRegistry
>;
