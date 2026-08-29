import { randomUUID } from "node:crypto";
import type { ActivityRecordStore } from "./activity-records.js";
import {
  createActivityRecordProducers,
  newActivityEventId,
  type ActivityProducerInput,
} from "./activity-records.js";
import type { BrowserActivityEvent } from "./contracts.js";

/**
 * Safe Login Mode: a renewable, time-bounded owner-only browser mode for
 * sign-in flows that reject automation. While a profile is in Safe Login:
 *
 * - The owner relaunches the *same* stopped profile without a dev-browser or
 *   automation attachment, so automation-hostile sites see an ordinary
 *   interactive browser driven only by the owner through an isolated display.
 * - Only the initiating owner panel — bound through the authenticated Panel
 *   Capability transport — receives Safe Login pixels and input. Other owner
 *   panels observe an opaque "Safe Login elsewhere" state, while agents and
 *   the CLI are denied DOM, screenshot, and control access.
 * - The mode records only mode-transition metadata in Activity Records and
 *   never pixels, URLs, credentials, input, screenshots, or page content.
 *
 * This module is the authoritative policy and state machine. It owns the
 * per-profile mode, the initiating-panel binding, the lease expiry and
 * bounded extension, and the reconciliation of interrupted enter/exit
 * transitions to a safe explicit state after reconnect or worker restart.
 * The real display plumbing (Xvfb/x11vnc/noVNC) lives behind the injected
 * relaunch effects and is exercised only through the provisioned-host worker,
 * which fails closed without BB_BROWSER_HOST_DATA_DIR.
 */

export const SAFE_LOGIN_LEASE_MS = 15 * 60_000;
/** A Safe Login lease may be extended by at most one additional lease term. */
export const SAFE_LOGIN_MAX_EXTENSION_MS = SAFE_LOGIN_LEASE_MS;
/** A bounded total ceiling so a lease can never exceed 30 minutes. */
export const SAFE_LOGIN_MAX_TOTAL_MS = SAFE_LOGIN_LEASE_MS * 2;
export const SAFE_LOGIN_EXPIRY_WARNING_MS = 60_000;
export const SAFE_LOGIN_TRANSIENT_STATE_WARNING =
  "Entering Safe Login will restart this Browser Profile. Unsaved form input, transient tab state, and in-flight agent work will be lost; saved logins and tabs are preserved.";
export const SAFE_LOGIN_LIMITATIONS_NOTICE =
  "Safe Login improves compatibility with sites that reject automation, but hardware-bound passkeys, DRM content, corporate device policies, and site-specific anti-automation behavior may still prevent a login.";

export type SafeLoginModeState = "automation" | "safe-login";
export type SafeLoginTransition = "idle" | "entering" | "exiting";

export type SafeLoginProfileTarget = {
  hostId: string;
  profileId: string;
};

export type SafeLoginPanelBinding = {
  ownerSessionId: string;
  panelId: string;
  hostId: string;
  profileId: string;
};

export type SafeLoginSessionId = string;

export type SafeLoginRelaunchEffects = {
  /**
   * Relaunch the same stopped profile without a dev-browser or automation
   * attachment. Must resolve only after the safe-login display is committed;
   * rejection aborts the enter transition back to Automation Mode.
   */
  relaunchWithoutAutomation(target: SafeLoginProfileTarget): Promise<void>;
  /**
   * Return the same profile to Automation Mode. Must not copy credentials or
   * browser state through BB storage: it stops the safe-login display and
   * reattaches automation to the running profile. Rejection reconciles the
   * profile to a safe explicit Automation Mode state.
   */
  returnToAutomation(target: SafeLoginProfileTarget): Promise<void>;
};

export type SafeLoginInterruptionEffect = {
  /**
   * Gracefully interrupt every active agent for the profile. Returns whether
   * any agent was active and how many were interrupted so the enter transition
   * can record interruption metadata without retaining agent content.
   */
  interruptAgents(target: SafeLoginProfileTarget): Promise<{
    active: boolean;
    interrupted: number;
  }>;
};

export type SafeLoginActivitySink = {
  mode(input: ActivityProducerInput): BrowserActivityEvent;
};

export type SafeLoginClock = { now(): number };

export type SafeLoginOptions = {
  clock?: SafeLoginClock;
  leaseMs?: number;
  maxExtensionMs?: number;
  maxTotalMs?: number;
  expiryWarningMs?: number;
  /**
   * A store-backed producer sink. When omitted the mode records nothing,
   * which keeps the pure state machine testable without a database. Real
   * wiring passes the `mode` producer from createActivityRecordProducers.
   */
  activity?: SafeLoginActivitySink;
};

export type SafeLoginWarning = {
  transientStateLoss: string;
  limitations: string;
};

export type SafeLoginEnterRequest = {
  binding: SafeLoginPanelBinding;
  relaunch: SafeLoginRelaunchEffects;
  interruption: SafeLoginInterruptionEffect;
};

export type SafeLoginEnterResult = {
  sessionId: SafeLoginSessionId;
  expiresAt: number;
  warning: SafeLoginWarning;
  interruptedAgents: number;
  agentsWereActive: boolean;
};

export type SafeLoginExtendResult = {
  sessionId: SafeLoginSessionId;
  expiresAt: number;
  extendedByMs: number;
};

export type SafeLoginExpiryWarning = {
  sessionId: SafeLoginSessionId;
  target: SafeLoginProfileTarget;
  expiresAt: number;
  warnAt: number;
};

export type SafeLoginStatusForPanel =
  "automation" | "safe-login-initiator" | "safe-login-elsewhere";

export type SafeLoginPersistedIntent = {
  target: SafeLoginProfileTarget;
  transition: "entering" | "exiting";
  startedAt: number;
};

export class SafeLoginModeError extends Error {
  constructor(
    public readonly code:
      | "safe_login_active"
      | "safe_login_inactive"
      | "safe_login_transition_in_progress"
      | "safe_login_not_initiator"
      | "safe_login_extension_unbounded"
      | "safe_login_unknown_session",
    message: string,
  ) {
    super(message);
    this.name = "SafeLoginModeError";
  }
}

export class SafeLoginAgentDeniedError extends Error {
  constructor(
    public readonly target: SafeLoginProfileTarget,
    public readonly code: "safe_login_active",
  ) {
    super(
      "Browser automation is denied while this Browser Profile is in owner-only Safe Login Mode.",
    );
    this.name = "SafeLoginAgentDeniedError";
  }
}

type ActiveSession = {
  sessionId: SafeLoginSessionId;
  binding: SafeLoginPanelBinding;
  target: SafeLoginProfileTarget;
  startedAt: number;
  expiresAt: number;
  totalExtensionMs: number;
  initiatingPanels: Set<string>;
  expiryTimer: ReturnType<typeof setTimeout>;
  warningTimer: ReturnType<typeof setTimeout>;
  warningDelivered: boolean;
};

type ProfileState = {
  target: SafeLoginProfileTarget;
  mode: SafeLoginModeState;
  transition: SafeLoginTransition;
  intent: SafeLoginPersistedIntent | null;
  session: ActiveSession | null;
};

function profileKey(target: SafeLoginProfileTarget): string {
  return `${target.hostId}\0${target.profileId}`;
}

function panelKey(binding: SafeLoginPanelBinding): string {
  return `${binding.ownerSessionId}\0${binding.panelId}`;
}

function bindingTarget(binding: SafeLoginPanelBinding): SafeLoginProfileTarget {
  return { hostId: binding.hostId, profileId: binding.profileId };
}

function sameBinding(
  a: SafeLoginPanelBinding,
  b: SafeLoginPanelBinding,
): boolean {
  return (
    a.ownerSessionId === b.ownerSessionId &&
    a.panelId === b.panelId &&
    a.hostId === b.hostId &&
    a.profileId === b.profileId
  );
}

export function createSafeLoginMode(options: SafeLoginOptions = {}) {
  const clock = options.clock ?? { now: () => Date.now() };
  const leaseMs = options.leaseMs ?? SAFE_LOGIN_LEASE_MS;
  const maxExtensionMs = options.maxExtensionMs ?? SAFE_LOGIN_MAX_EXTENSION_MS;
  const maxTotalMs = options.maxTotalMs ?? SAFE_LOGIN_MAX_TOTAL_MS;
  const expiryWarningMs =
    options.expiryWarningMs ?? SAFE_LOGIN_EXPIRY_WARNING_MS;
  const activity = options.activity;
  const profiles = new Map<string, ProfileState>();
  const expiryListeners = new Set<(warning: SafeLoginExpiryWarning) => void>();
  let disposed = false;

  function stateFor(target: SafeLoginProfileTarget): ProfileState {
    const key = profileKey(target);
    let state = profiles.get(key);
    if (state === undefined) {
      state = {
        target,
        mode: "automation",
        transition: "idle",
        intent: null,
        session: null,
      };
      profiles.set(key, state);
    }
    return state;
  }

  function record(
    target: SafeLoginProfileTarget,
    input: Omit<
      ActivityProducerInput,
      | "hostId"
      | "profileId"
      | "kind"
      | "actor"
      | "projectId"
      | "destinationOrigin"
      | "occurredAt"
    >,
  ) {
    if (activity === undefined) return;
    activity.mode({
      ...input,
      actor: "owner",
      projectId: null,
      hostId: target.hostId,
      profileId: target.profileId,
      destinationOrigin: null,
      occurredAt: new Date(clock.now()).toISOString(),
    });
  }

  function clearTimers(session: ActiveSession) {
    clearTimeout(session.expiryTimer);
    clearTimeout(session.warningTimer);
  }

  function scheduleExpiry(state: ProfileState, session: ActiveSession) {
    const warnAt = Math.max(
      session.startedAt,
      session.expiresAt - expiryWarningMs,
    );
    session.warningTimer = setTimeout(
      () => {
        if (disposed) return;
        session.warningDelivered = true;
        for (const listener of expiryListeners) {
          listener({
            sessionId: session.sessionId,
            target: state.target,
            expiresAt: session.expiresAt,
            warnAt,
          });
        }
      },
      Math.max(0, warnAt - clock.now()),
    );
    session.warningTimer.unref?.();
    session.expiryTimer = setTimeout(
      () => {
        if (disposed) return;
        void expire(state, session.sessionId).catch(() => {
          /* expiry errors are recorded below; never throw from a timer */
        });
      },
      Math.max(0, session.expiresAt - clock.now()),
    );
    session.expiryTimer.unref?.();
  }

  function armSessionTimers(state: ProfileState, session: ActiveSession) {
    clearTimers(session);
    scheduleExpiry(state, session);
  }

  async function runExit(
    state: ProfileState,
    relaunch: SafeLoginRelaunchEffects,
    action: "safe-login-exited" | "safe-login-expired",
    interrupted: boolean,
    interruptionReason: string | null,
    startedAt: number,
  ) {
    const exitingSession = state.session;
    state.transition = "exiting";
    state.intent = {
      target: state.target,
      transition: "exiting",
      startedAt: clock.now(),
    };
    if (exitingSession !== null) clearTimers(exitingSession);
    let outcome = "succeeded";
    let exitInterrupted = interrupted;
    let exitReason = interruptionReason;
    try {
      await relaunch.returnToAutomation(state.target);
    } catch (error) {
      outcome = "failed";
      exitInterrupted = true;
      exitReason =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "Safe Login exit transition failed.";
      // Reconcile to the safe explicit terminal state: Automation Mode. The
      // profile is no longer usable in Safe Login after a failed exit, so the
      // owner must re-enter; agents stay denied only while a session exists.
    }
    state.session = null;
    state.intent = null;
    state.transition = "idle";
    state.mode = "automation";
    record(state.target, {
      eventId: newActivityEventId("safe-login"),
      action,
      outcome,
      interrupted: exitInterrupted,
      interruptionReason: exitReason,
      durationMs: clock.now() - startedAt,
    });
    if (outcome === "failed") {
      throw new SafeLoginModeError(
        "safe_login_inactive",
        "Safe Login could not return to Automation Mode and was reconciled to a safe explicit state.",
      );
    }
  }

  async function expire(state: ProfileState, sessionId: SafeLoginSessionId) {
    const session = state.session;
    if (session === null || session.sessionId !== sessionId) return;
    const relaunch = await consumeRelaunch(state);
    if (relaunch === null) return;
    await runExit(
      state,
      relaunch,
      "safe-login-expired",
      false,
      null,
      session.startedAt,
    );
  }

  // The relaunch effects are supplied per enter() and held on the session so
  // expiry and panel-close exits can reattach automation without re-supplying
  // them. They are never serialized; a worker restart reconciles instead.
  const relaunchBySession = new Map<
    SafeLoginSessionId,
    SafeLoginRelaunchEffects
  >();

  async function consumeRelaunch(
    state: ProfileState,
  ): Promise<SafeLoginRelaunchEffects | null> {
    const session = state.session;
    if (session === null) return null;
    return relaunchBySession.get(session.sessionId) ?? null;
  }

  function assertNotDisposed() {
    if (disposed) {
      throw new SafeLoginModeError(
        "safe_login_transition_in_progress",
        "The Safe Login policy is shutting down.",
      );
    }
  }

  async function enter(
    request: SafeLoginEnterRequest,
  ): Promise<SafeLoginEnterResult> {
    assertNotDisposed();
    const target = bindingTarget(request.binding);
    const state = stateFor(target);
    if (state.mode === "safe-login") {
      throw new SafeLoginModeError(
        "safe_login_active",
        "This Browser Profile is already in Safe Login Mode.",
      );
    }
    if (state.transition !== "idle") {
      throw new SafeLoginModeError(
        "safe_login_transition_in_progress",
        "A Safe Login transition is already in progress.",
      );
    }
    const startedAt = clock.now();
    state.transition = "entering";
    state.intent = {
      target,
      transition: "entering",
      startedAt,
    };
    let outcome = "succeeded";
    let interruptionReason: string | null = null;
    let interruption: { active: boolean; interrupted: number } | undefined;
    try {
      interruption = await request.interruption.interruptAgents(target);
      if (interruption.active) {
        interruptionReason = "Active agents were interrupted for Safe Login.";
      } else if (interruption.interrupted > 0) {
        interruptionReason = "Queued agents were interrupted for Safe Login.";
      }
      await request.relaunch.relaunchWithoutAutomation(target);
    } catch (error) {
      outcome = "failed";
      interruptionReason =
        error instanceof Error && error.message.length > 0
          ? error.message
          : "The Safe Login enter transition failed.";
      state.transition = "idle";
      state.intent = null;
      state.mode = "automation";
      record(target, {
        eventId: newActivityEventId("safe-login"),
        action: "safe-login-entered",
        outcome,
        interrupted: true,
        interruptionReason,
        durationMs: clock.now() - startedAt,
      });
      throw new SafeLoginModeError(
        "safe_login_inactive",
        "Safe Login could not relaunch the profile and stayed in Automation Mode.",
      );
    }
    const sessionId = `safe-login-${randomUUID()}`;
    const expiresAt = startedAt + leaseMs;
    const session: ActiveSession = {
      sessionId,
      binding: request.binding,
      target,
      startedAt,
      expiresAt,
      totalExtensionMs: 0,
      initiatingPanels: new Set<string>([panelKey(request.binding)]),
      expiryTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      warningTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      warningDelivered: false,
    };
    state.session = session;
    relaunchBySession.set(sessionId, request.relaunch);
    state.transition = "idle";
    state.intent = null;
    state.mode = "safe-login";
    scheduleExpiry(state, session);
    record(target, {
      eventId: newActivityEventId("safe-login"),
      action: "safe-login-entered",
      outcome,
      interrupted: interruption?.active ?? false,
      interruptionReason,
      durationMs: clock.now() - startedAt,
    });
    return {
      sessionId,
      expiresAt,
      warning: {
        transientStateLoss: SAFE_LOGIN_TRANSIENT_STATE_WARNING,
        limitations: SAFE_LOGIN_LIMITATIONS_NOTICE,
      },
      interruptedAgents: interruption?.interrupted ?? 0,
      agentsWereActive: interruption?.active ?? false,
    };
  }

  function sessionFor(
    target: SafeLoginProfileTarget,
    sessionId: SafeLoginSessionId,
  ): ActiveSession {
    const state = stateFor(target);
    const session = state.session;
    if (session === null || session.sessionId !== sessionId) {
      throw new SafeLoginModeError(
        "safe_login_unknown_session",
        "The Safe Login session was not found for this Browser Profile.",
      );
    }
    return session;
  }

  function extend(
    target: SafeLoginProfileTarget,
    sessionId: SafeLoginSessionId,
    extensionMs: number,
  ): SafeLoginExtendResult {
    assertNotDisposed();
    if (
      !Number.isInteger(extensionMs) ||
      extensionMs <= 0 ||
      extensionMs > maxExtensionMs
    ) {
      throw new SafeLoginModeError(
        "safe_login_extension_unbounded",
        `Safe Login extension must be a positive bounded value up to ${maxExtensionMs}ms.`,
      );
    }
    const session = sessionFor(target, sessionId);
    const state = stateFor(target);
    if (state.mode !== "safe-login" || state.transition !== "idle") {
      throw new SafeLoginModeError(
        "safe_login_transition_in_progress",
        "A Safe Login transition is in progress.",
      );
    }
    const projectedExpiry = session.expiresAt + extensionMs;
    if (projectedExpiry > session.startedAt + maxTotalMs) {
      throw new SafeLoginModeError(
        "safe_login_extension_unbounded",
        `Safe Login total lease time cannot exceed ${maxTotalMs}ms.`,
      );
    }
    session.expiresAt = projectedExpiry;
    session.totalExtensionMs += extensionMs;
    session.warningDelivered = false;
    armSessionTimers(state, session);
    record(target, {
      eventId: newActivityEventId("safe-login"),
      action: "safe-login-extended",
      outcome: "succeeded",
      interrupted: false,
      interruptionReason: null,
      durationMs: extensionMs,
    });
    return {
      sessionId,
      expiresAt: session.expiresAt,
      extendedByMs: extensionMs,
    };
  }

  async function done(
    target: SafeLoginProfileTarget,
    sessionId: SafeLoginSessionId,
  ): Promise<void> {
    assertNotDisposed();
    const session = sessionFor(target, sessionId);
    const state = stateFor(target);
    if (state.mode !== "safe-login") {
      throw new SafeLoginModeError(
        "safe_login_inactive",
        "This Browser Profile is not in Safe Login Mode.",
      );
    }
    if (!session.initiatingPanels.has(panelKey(session.binding))) {
      throw new SafeLoginModeError(
        "safe_login_not_initiator",
        "Only the initiating panel can end Safe Login.",
      );
    }
    const relaunch = (await consumeRelaunch(state)) ?? null;
    relaunchBySession.delete(session.sessionId);
    await runExit(
      state,
      relaunch ?? {
        returnToAutomation: async () => {},
        relaunchWithoutAutomation: async () => {},
      },
      "safe-login-exited",
      false,
      null,
      session.startedAt,
    );
  }

  async function panelClosed(binding: SafeLoginPanelBinding): Promise<void> {
    if (disposed) return;
    const target = bindingTarget(binding);
    const state = profiles.get(profileKey(target));
    if (state === undefined || state.session === null) return;
    const session = state.session;
    const key = panelKey(binding);
    if (!session.initiatingPanels.has(key)) return;
    session.initiatingPanels.delete(key);
    if (session.initiatingPanels.size > 0) return;
    const relaunch = relaunchBySession.get(session.sessionId) ?? null;
    relaunchBySession.delete(session.sessionId);
    await runExit(
      state,
      relaunch ?? {
        returnToAutomation: async () => {},
        relaunchWithoutAutomation: async () => {},
      },
      "safe-login-exited",
      false,
      null,
      session.startedAt,
    );
  }

  function joinPanel(binding: SafeLoginPanelBinding): {
    accepted: boolean;
    reason: string;
  } {
    const target = bindingTarget(binding);
    const state = profiles.get(profileKey(target));
    if (state === undefined || state.session === null) {
      return {
        accepted: false,
        reason: "This Browser Profile is not in Safe Login Mode.",
      };
    }
    const session = state.session;
    if (!sameBinding(session.binding, binding)) {
      return {
        accepted: false,
        reason: "Safe Login pixels are available only to the initiating panel.",
      };
    }
    session.initiatingPanels.add(panelKey(binding));
    return { accepted: true, reason: "Safe Login session rejoined." };
  }

  function mode(target: SafeLoginProfileTarget): SafeLoginModeState {
    return stateFor(target).mode;
  }

  function transitionOf(target: SafeLoginProfileTarget): SafeLoginTransition {
    return stateFor(target).transition;
  }

  function initiatingBinding(
    target: SafeLoginProfileTarget,
  ): SafeLoginPanelBinding | null {
    return stateFor(target).session?.binding ?? null;
  }

  function sessionOf(target: SafeLoginProfileTarget):
    | {
        sessionId: SafeLoginSessionId;
        expiresAt: number;
        startedAt: number;
        initiatingPanels: number;
      }
    | undefined {
    const session = stateFor(target).session;
    if (session === null) return undefined;
    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      startedAt: session.startedAt,
      initiatingPanels: session.initiatingPanels.size,
    };
  }

  function statusFor(
    target: SafeLoginProfileTarget,
    requesting: SafeLoginPanelBinding,
  ): SafeLoginStatusForPanel {
    const state = profiles.get(profileKey(target));
    if (state === undefined || state.session === null) return "automation";
    if (sameBinding(state.session.binding, requesting)) {
      return "safe-login-initiator";
    }
    return "safe-login-elsewhere";
  }

  function canStreamPixels(binding: SafeLoginPanelBinding): boolean {
    const state = profiles.get(profileKey(bindingTarget(binding)));
    const session = state?.session;
    if (session === null || session === undefined) return false;
    return sameBinding(session.binding, binding);
  }

  function canControl(binding: SafeLoginPanelBinding): boolean {
    return canStreamPixels(binding);
  }

  function isAgentDenied(target: SafeLoginProfileTarget): boolean {
    return mode(target) === "safe-login";
  }

  function assertAgentAllowed(target: SafeLoginProfileTarget): void {
    if (isAgentDenied(target)) {
      throw new SafeLoginAgentDeniedError(target, "safe_login_active");
    }
  }

  function onExpiryWarning(
    listener: (warning: SafeLoginExpiryWarning) => void,
  ): () => void {
    expiryListeners.add(listener);
    return () => expiryListeners.delete(listener);
  }

  /**
   * Return the persisted transition intent for a profile. A worker persists
   * this before relaunching; after a reconnect or worker restart it calls
   * reconcile() with whatever it persisted so an interrupted enter or exit
   * resolves to a safe explicit state instead of a half-applied mode.
   */
  function persistedIntent(
    target: SafeLoginProfileTarget,
  ): SafeLoginPersistedIntent | null {
    return stateFor(target).intent;
  }

  /**
   * Reconcile an interrupted transition to a safe explicit state. The safe
   * terminal state for a half-entered or half-exited Safe Login is Automation
   * Mode: the profile is returned to automation (reattaching if needed) and
   * any in-flight Safe Login session is dropped. Records a transition-failure
   * activity with interruption metadata and never retains sensitive content.
   */
  async function reconcile(
    intent: SafeLoginPersistedIntent,
    relaunch?: SafeLoginRelaunchEffects,
  ): Promise<{ resolved: SafeLoginModeState; failed: boolean }> {
    const state = stateFor(intent.target);
    const failed = true;
    if (state.session !== null) {
      clearTimers(state.session);
      relaunchBySession.delete(state.session.sessionId);
    }
    state.session = null;
    state.transition = "idle";
    state.intent = null;
    state.mode = "automation";
    let interruptionReason =
      intent.transition === "entering"
        ? "The Safe Login enter transition was interrupted and rolled back to Automation Mode."
        : "The Safe Login exit transition was interrupted and reconciled to Automation Mode.";
    try {
      if (relaunch !== undefined) {
        await relaunch.returnToAutomation(intent.target);
      }
    } catch (error) {
      interruptionReason =
        error instanceof Error && error.message.length > 0
          ? error.message
          : interruptionReason;
    }
    record(intent.target, {
      eventId: newActivityEventId("safe-login"),
      action: "safe-login-transition-failed",
      outcome: "failed",
      interrupted: true,
      interruptionReason,
      durationMs: clock.now() - intent.startedAt,
    });
    return { resolved: "automation", failed };
  }

  function dispose() {
    disposed = true;
    for (const state of profiles.values()) {
      if (state.session !== null) clearTimers(state.session);
    }
    profiles.clear();
    relaunchBySession.clear();
    expiryListeners.clear();
  }

  return {
    enter,
    extend,
    done,
    panelClosed,
    joinPanel,
    mode,
    transition: transitionOf,
    initiatingBinding,
    session: sessionOf,
    statusFor,
    canStreamPixels,
    canControl,
    isAgentDenied,
    assertAgentAllowed,
    onExpiryWarning,
    persistedIntent,
    reconcile,
    dispose,
    get leaseMs() {
      return leaseMs;
    },
    get maxExtensionMs() {
      return maxExtensionMs;
    },
    get maxTotalMs() {
      return maxTotalMs;
    },
    get expiryWarningMs() {
      return expiryWarningMs;
    },
  };
}

export type SafeLoginModeManager = ReturnType<typeof createSafeLoginMode>;

/**
 * Bind the Safe Login mode machine to an Activity Record store, returning the
 * producer sink the policy records through. The sink reuses the existing
 * `mode` producer so Safe Login transitions share the mode activity stream
 * with other mode events and never carry pixels, URLs, or credentials.
 */
export function safeLoginActivitySink(
  store: Pick<ActivityRecordStore, "append">,
): SafeLoginActivitySink {
  return createActivityRecordProducers(store);
}
