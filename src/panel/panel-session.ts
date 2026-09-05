import {
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_RECLAIM_WINDOW_MS,
  type BrowserControlLease,
} from "../shared/contracts.js";
import {
  ControlLeaseError,
  type ControlLeaseManager,
} from "../browser/control-lease.js";
import {
  createBrowserTabStrip,
  type BrowserTabStrip,
} from "../browser/browser-tabs.js";
import type { ScreencastFrame, ScreencastSource } from "./panel-transport.js";

/**
 * One host-owned Panel session per Browser Profile. It is the authority for
 * panel membership, connection generations, panel roles, Control Lease
 * coordination, reconnect reclaim, agent purpose, the controller viewport,
 * the shared Browser Tab snapshot, stream fan-out, and panel cleanup
 * (ADR 0005/0007/0012). Browser Profile data stays on the workspace host
 * (ADR 0012).
 */

export type PanelSessionClock = {
  now(): number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (id: unknown) => void;
};

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
  tabs: BrowserTabStrip;
};

export type PanelVisibility = "visible" | "hidden";

export type PanelSessionTransport = {
  stop(): Promise<void>;
  dismissOpenDialogs(): void;
};

type PanelSessionBoundTransport = PanelSessionTransport & {
  generation: number;
};

type PanelSessionActivation =
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

function createSessionStreamFanout() {
  let source: ScreencastSource | undefined;
  let sharedAbort: AbortController | undefined;
  let started = false;
  let running: Promise<void> | undefined;
  let lastFrame: ScreencastFrame | undefined;
  const sinks = new Set<(frame: ScreencastFrame) => void>();

  function attach(create: () => ScreencastSource): ScreencastSource {
    source ??= create();
    const real = source;
    let sink: ((frame: ScreencastFrame) => void) | undefined;
    return {
      async start(onFrame, signal) {
        sink = (frame) => onFrame(frame);
        sinks.add(sink);
        if (lastFrame !== undefined) onFrame(lastFrame);
        if (!started) {
          started = true;
          sharedAbort = new AbortController();
          running = real.start((frame) => {
            lastFrame = frame;
            for (const next of sinks) next(frame);
          }, sharedAbort.signal);
        }
        let stopWaiting: (() => void) | undefined;
        const disconnected = new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          stopWaiting = () => resolve();
          signal.addEventListener("abort", stopWaiting, { once: true });
        });
        try {
          await Promise.race([running, disconnected]);
        } finally {
          if (stopWaiting !== undefined)
            signal.removeEventListener("abort", stopWaiting);
          if (!signal.aborted && source === real) {
            source = undefined;
            started = false;
            lastFrame = undefined;
            await real.stop();
          }
        }
      },
      input(payload) {
        real.input(payload);
      },
      async stop() {
        if (sink !== undefined) sinks.delete(sink);
        sink = undefined;
      },
      setViewport: real.setViewport?.bind(real),
      subscribeDialogs: real.subscribeDialogs?.bind(real),
      respondToDialog: real.respondToDialog?.bind(real),
      dismissOpenDialogs: real.dismissOpenDialogs?.bind(real),
      resolveContextActions: real.resolveContextActions?.bind(real),
      performContextAction: real.performContextAction?.bind(real),
      copyClipboard: real.copyClipboard?.bind(real),
      pasteClipboard: real.pasteClipboard?.bind(real),
    };
  }

  async function release() {
    sharedAbort?.abort();
    sharedAbort = undefined;
    started = false;
    lastFrame = undefined;
    sinks.clear();
    const stopping = source;
    source = undefined;
    await stopping?.stop();
  }

  return {
    attach,
    release,
    get live() {
      return source !== undefined;
    },
  };
}

export function createPanelSession(options: PanelSessionOptions = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const reclaimWindowMs = options.reclaimWindowMs ?? PANEL_RECLAIM_WINDOW_MS;
  const controlLeases = options.controlLeases;
  const panels = new Map<string, PanelSessionRecord>();
  const visiblePanelIds = new Set<string>();
  const boundTransports = new Map<string, PanelSessionBoundTransport[]>();
  const tabStrip = createBrowserTabStrip();
  const streamFanout = createSessionStreamFanout();
  let leaseKey: string | undefined;
  let controllerPanelId: string | null = null;
  let controllerViewport: PanelViewport | null = null;
  let reclaimOwnerPanelId: string | null = null;
  let reclaimDeadline: number | null = null;
  let cancelReclaimExpiry: (() => void) | undefined;
  // Identities whose reclaim membership expired. A later join of the same
  // panel restores observation only; vacant control is not granted again.
  const expiredPanelIds = new Set<string>();
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

  function scheduleWithClock(callback: () => void, delayMs: number) {
    if (clock.setTimeout !== undefined) {
      const id = clock.setTimeout(callback, delayMs);
      return () => clock.clearTimeout?.(id);
    }
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
  }

  function nextDisconnectedReclaimDeadline() {
    let nextDeadline: number | null = null;
    for (const member of panels.values()) {
      if (
        member.connection !== "disconnected" ||
        member.reclaimUntil === null
      ) {
        continue;
      }
      if (nextDeadline === null || member.reclaimUntil < nextDeadline) {
        nextDeadline = member.reclaimUntil;
      }
    }
    return nextDeadline;
  }

  function armReclaimExpiry() {
    cancelReclaimExpiry?.();
    cancelReclaimExpiry = undefined;
    const nextDeadline = nextDisconnectedReclaimDeadline();
    if (nextDeadline === null) return;
    // expireReclaim keeps membership until now is strictly after reclaimUntil.
    cancelReclaimExpiry = scheduleWithClock(
      onReclaimDeadline,
      Math.max(0, nextDeadline - clock.now() + 1),
    );
  }

  function onReclaimDeadline() {
    cancelReclaimExpiry = undefined;
    expireReclaim();
    armReclaimExpiry();
    emit();
    void releaseIfIdle();
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
        expiredPanelIds.add(panelId);
        panels.delete(panelId);
        // A dropped socket never unmounts, so leftover visibility must not
        // keep the session pinned after membership is gone.
        visiblePanelIds.delete(panelId);
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
      tabs: tabStrip.snapshot(),
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

  tabStrip.subscribe(() => emit());

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
    const expiredRejoin = expiredPanelIds.delete(panelId);
    const role: PanelRole =
      !expiredRejoin && controllerPanelId === null ? "controller" : "spectator";
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

  function reserveConnection(panelId: string, ownerSessionId: string): number {
    expireReclaim();
    const existing = panels.get(panelId);
    if (existing !== undefined) {
      existing.nextGeneration += 1;
      existing.pendingGeneration = existing.nextGeneration;
      existing.ownerSessionId = ownerSessionId;
      existing.connection = "connected";
      existing.reclaimUntil = null;
      emit();
      armReclaimExpiry();
      return existing.pendingGeneration;
    }
    const member = addPanel(panelId, ownerSessionId);
    member.pendingGeneration = 1;
    member.nextGeneration = 1;
    emit();
    armReclaimExpiry();
    return 1;
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
      armReclaimExpiry();
      return existing.role;
    }
    const member = addPanel(panelId, ownerSessionId, viewport);
    emit();
    armReclaimExpiry();
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
    armReclaimExpiry();
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
    armReclaimExpiry();
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

  function isIdle() {
    expireReclaim();
    return (
      panels.size === 0 &&
      visiblePanelIds.size === 0 &&
      !reclaimActive() &&
      leaseState() === undefined
    );
  }

  function setVisibility(panelId: string, visibility: PanelVisibility) {
    if (visibility === "visible") visiblePanelIds.add(panelId);
    else visiblePanelIds.delete(panelId);
    return true;
  }

  function attachStreamSource(create: () => ScreencastSource) {
    return streamFanout.attach(create);
  }

  function hasLiveStream() {
    return streamFanout.live;
  }

  async function releaseIfIdle() {
    expireReclaim();
    if (!isIdle()) return;
    await streamFanout.release();
    await stopAllTransports();
  }

  function bindTransport(
    panelId: string,
    transport: PanelSessionBoundTransport,
  ) {
    const bound = boundTransports.get(panelId) ?? [];
    boundTransports.set(panelId, [...bound, transport]);
  }

  async function stopTransports(
    panelId: string,
    generations?: readonly number[],
  ) {
    const bound = boundTransports.get(panelId) ?? [];
    const stopping =
      generations === undefined
        ? bound
        : bound.filter((entry) => generations.includes(entry.generation));
    await Promise.all(
      stopping.map((entry) => entry.stop().catch(() => undefined)),
    );
    const remaining = bound.filter((entry) => !stopping.includes(entry));
    if (remaining.length === 0) boundTransports.delete(panelId);
    else boundTransports.set(panelId, remaining);
  }

  async function stopAllTransports() {
    const stopping = [...boundTransports.values()].flat();
    boundTransports.clear();
    await Promise.all(
      stopping.map((entry) => entry.stop().catch(() => undefined)),
    );
  }

  function dismissOpenDialogs() {
    for (const transports of boundTransports.values()) {
      for (const transport of transports) transport.dismissOpenDialogs();
    }
  }

  async function joinPanel(panelId: string, ownerSessionId: string) {
    const generation = reserveConnection(panelId, ownerSessionId);
    const authoritative = panels.get(panelId)?.authoritativeGeneration;
    const obsolete = (boundTransports.get(panelId) ?? [])
      .map((transport) => transport.generation)
      .filter((bound) => bound !== authoritative && bound !== generation);
    if (obsolete.length > 0) await stopTransports(panelId, obsolete);
    return connectionFor(panelId, generation);
  }

  function connectionFor(panelId: string, generation: number) {
    return {
      isActive: () => acceptsGeneration(panelId, generation),
      async activate() {
        const activated = activateGeneration(panelId, generation);
        if (activated.outcome !== "activated") return false;
        await stopTransports(panelId, activated.supersededGenerations);
        return true;
      },
      disconnect() {
        // Superseded transports must not disconnect their replacement.
        if (!acceptsGeneration(panelId, generation)) return false;
        return disconnectPanel(panelId);
      },
      bindTransport(transport: PanelSessionTransport) {
        bindTransport(panelId, { ...transport, generation });
      },
    };
  }

  async function dispose() {
    cancelReclaimExpiry?.();
    cancelReclaimExpiry = undefined;
    listeners.clear();
    panels.clear();
    expiredPanelIds.clear();
    visiblePanelIds.clear();
    controllerPanelId = null;
    controllerViewport = null;
    clearControlReclaim();
    tabStrip.dispose();
    await stopAllTransports();
    await streamFanout.release();
  }

  return {
    setLeaseKey,
    joinPanel,
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
    snapshot,
    tabStrip() {
      return tabStrip;
    },
    attachStreamSource,
    hasLiveStream,
    releaseIfIdle,
    isIdle,
    setVisibility,
    visiblePanelIds() {
      return [...visiblePanelIds];
    },
    stopPanelTransports: (panelId: string) => stopTransports(panelId),
    dismissOpenDialogs,
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

  async function dropIdle(target: PanelSessionTarget) {
    const key = panelSessionKey(target);
    const session = sessions.get(key);
    if (session === undefined || !session.isIdle()) return;
    sessions.delete(key);
    await session.dispose();
  }

  async function releaseIfIdle(target: PanelSessionTarget) {
    const session = sessions.get(panelSessionKey(target));
    if (session === undefined) return;
    await session.releaseIfIdle();
    await dropIdle(target);
  }

  async function dispose() {
    const disposing = [...sessions.values()];
    sessions.clear();
    await Promise.all(disposing.map((session) => session.dispose()));
  }

  return { sessionFor, forEach, dropIdle, releaseIfIdle, dispose };
}

export type PanelSessionRegistry = ReturnType<
  typeof createPanelSessionRegistry
>;
