import {
  BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  type BrowserControlLease,
} from "../shared/contracts.js";

// A normal script can hold control for 30 seconds. Let the next caller wait
// for that script, while cancellation and owner takeover still remove it.
export const CONTROL_LEASE_AGENT_WAIT_MS = BROWSER_SCRIPT_MAX_TIMEOUT_MS;

export type ControlLease = BrowserControlLease & {
  signal: AbortSignal;
  release(): void;
};

export class ControlLeaseError extends Error {
  constructor(
    public readonly code: "browser_busy" | "lease_revoked",
    message: string,
  ) {
    super(message);
    this.name = "ControlLeaseError";
  }
}

type LeaseKey = string;

/**
 * Control is held per lane, not per profile. The owner has one lane; each
 * agent session (one thread's tab, or one explicit tab) has its own. Lanes on
 * the same profile run side by side, so the owner keeps browsing while agents
 * work, and two agents never wait on each other's tabs. Work inside one lane
 * still runs in arrival order.
 */
const OWNER_LANE = "\u0001owner";
const DEFAULT_AGENT_LANE = "agent";

function laneKey(profileKey: LeaseKey, lane: string): LeaseKey {
  return `${profileKey}\0${lane}`;
}

function belongsToProfile(key: LeaseKey, profileKey: LeaseKey) {
  return key.startsWith(`${profileKey}\0`);
}

type ActiveLease = {
  key: LeaseKey;
  token: symbol;
  actor: ControlLease["actor"];
  purpose: string | null;
  controller: AbortController;
  expiryTimer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  resolveDone: () => void;
  released: boolean;
};

type PendingAgent = {
  key: LeaseKey;
  purpose: string;
  resolve: (lease: ControlLease) => void;
  reject: (error: ControlLeaseError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort: () => void;
};

function leaseBusy(message: string) {
  return new ControlLeaseError("browser_busy", message);
}

function rejectedOwnerRequest() {
  return leaseBusy(
    "Browser control is busy and the owner request was cancelled.",
  );
}

function createActiveLease(
  key: LeaseKey,
  actor: ControlLease["actor"],
  purpose: string | null,
): ActiveLease {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const controller = new AbortController();
  const expiryTimer =
    actor === "agent"
      ? setTimeout(() => {
          controller.abort(
            new ControlLeaseError(
              "lease_revoked",
              "The Browser Control Lease expired after 30 seconds.",
            ),
          );
        }, BROWSER_SCRIPT_MAX_TIMEOUT_MS)
      : undefined;
  expiryTimer?.unref?.();
  return {
    key,
    token: Symbol("browser-control-lease"),
    actor,
    purpose,
    controller,
    ...(expiryTimer === undefined ? {} : { expiryTimer }),
    done,
    resolveDone,
    released: false,
  };
}

function publicLease(active: ActiveLease, release: () => void): ControlLease {
  return {
    actor: active.actor,
    purpose: active.purpose,
    signal: active.controller.signal,
    release,
  };
}

export function createControlLeaseManager() {
  const active = new Map<LeaseKey, ActiveLease>();
  const waiting = new Map<LeaseKey, Set<PendingAgent>>();
  let disposed = false;

  function removePending(pending: PendingAgent) {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    const queue = waiting.get(pending.key);
    queue?.delete(pending);
    if (queue?.size === 0) waiting.delete(pending.key);
  }

  function rejectPending(key: LeaseKey, error: ControlLeaseError) {
    const queue = waiting.get(key);
    if (queue === undefined) return;
    waiting.delete(key);
    for (const pending of queue) {
      removePending(pending);
      pending.reject(error);
    }
  }

  function releaseLease(lease: ActiveLease) {
    if (lease.released) return;
    lease.released = true;
    if (lease.expiryTimer !== undefined) clearTimeout(lease.expiryTimer);
    if (active.get(lease.key)?.token !== lease.token) {
      lease.resolveDone();
      return;
    }
    active.delete(lease.key);
    lease.resolveDone();
    if (lease.actor === "agent" && !disposed) grantNext(lease.key);
  }

  function grantNext(key: LeaseKey) {
    if (active.has(key)) return;
    const queue = waiting.get(key);
    const next = queue?.values().next().value as PendingAgent | undefined;
    if (next === undefined) return;
    removePending(next);
    const lease = createActiveLease(key, "agent", next.purpose);
    active.set(key, lease);
    next.resolve(publicLease(lease, () => releaseLease(lease)));
  }

  function enqueueAgent(key: LeaseKey, purpose: string, signal?: AbortSignal) {
    return new Promise<ControlLease>((resolve, reject) => {
      const timer = setTimeout(() => {
        removePending(pending);
        reject(
          leaseBusy(
            "An earlier call in this browser session still holds its tab after 30 seconds. This call did not run. Wait for that call to finish, then retry once.",
          ),
        );
      }, CONTROL_LEASE_AGENT_WAIT_MS);
      timer.unref?.();
      const pending: PendingAgent = {
        key,
        purpose,
        resolve,
        reject,
        timer,
        signal,
        abort: () => {
          removePending(pending);
          reject(
            leaseBusy(
              "Browser control became unavailable while the agent waited.",
            ),
          );
        },
      };
      const queue = waiting.get(key) ?? new Set<PendingAgent>();
      queue.add(pending);
      waiting.set(key, queue);
      if (signal?.aborted) {
        pending.abort();
      } else {
        signal?.addEventListener("abort", pending.abort, { once: true });
      }
    });
  }

  async function waitForLease(
    lease: ActiveLease,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal === undefined) {
      await lease.done;
      return;
    }
    if (signal.aborted) throw rejectedOwnerRequest();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
      };
      const complete = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(rejectedOwnerRequest());
      };
      signal.addEventListener("abort", abort, { once: true });
      lease.done.then(complete, complete);
      if (signal.aborted) abort();
    });
  }

  function assertAvailable() {
    if (disposed) {
      throw leaseBusy("The Browser worker is shutting down.");
    }
  }

  async function acquireAgent(
    profileKey: LeaseKey,
    purpose: string,
    signal?: AbortSignal,
    lane: string = DEFAULT_AGENT_LANE,
  ): Promise<ControlLease> {
    assertAvailable();
    if (signal?.aborted) {
      throw leaseBusy("The Browser script request was cancelled.");
    }
    // The owner's own browsing never blocks an agent: it works in its lane.
    const key = laneKey(profileKey, lane);
    const current = active.get(key);
    if (current !== undefined) return enqueueAgent(key, purpose, signal);
    const lease = createActiveLease(key, "agent", purpose);
    active.set(key, lease);
    return publicLease(lease, () => releaseLease(lease));
  }

  async function acquireOwner(
    profileKey: LeaseKey,
    signal?: AbortSignal,
  ): Promise<ControlLease> {
    assertAvailable();
    if (signal?.aborted) throw rejectedOwnerRequest();
    // Owner actions serialize with each other, never with agents: browsing in
    // the owner's tabs does not interrupt or cancel an agent's work.
    const key = laneKey(profileKey, OWNER_LANE);
    let current = active.get(key);
    while (current !== undefined) {
      // Rapid tab selections must finish in order instead of cancelling
      // earlier owner work. Only the first waiter acquires the lane.
      await waitForLease(current, signal);
      assertAvailable();
      current = active.get(key);
    }
    if (signal?.aborted) throw rejectedOwnerRequest();
    const lease = createActiveLease(key, "owner", null);
    active.set(key, lease);
    return publicLease(lease, () => releaseLease(lease));
  }

  /**
   * What the profile is doing now: a working agent takes precedence in the
   * report, so the panel can say an agent is busy in its own tab.
   */
  function state(profileKey: LeaseKey): BrowserControlLease | undefined {
    let owner: BrowserControlLease | undefined;
    for (const lease of active.values()) {
      if (!belongsToProfile(lease.key, profileKey)) continue;
      if (lease.controller.signal.aborted) continue;
      if (lease.actor === "agent") {
        return { actor: lease.actor, purpose: lease.purpose };
      }
      owner = { actor: lease.actor, purpose: lease.purpose };
    }
    return owner;
  }

  function revokeKey(key: LeaseKey) {
    rejectPending(key, leaseBusy("Browser control was revoked."));
    active.get(key)?.controller.abort();
  }

  /** Stop every lane on a profile: profile stop, Safe Login, revoked access. */
  function revoke(profileKey: LeaseKey) {
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      if (belongsToProfile(key, profileKey)) revokeKey(key);
    }
  }

  /** Stop only the agent lanes on a profile, leaving owner actions to finish. */
  function revokeAgents(profileKey: LeaseKey) {
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      if (!belongsToProfile(key, profileKey)) continue;
      if (key === laneKey(profileKey, OWNER_LANE)) continue;
      revokeKey(key);
    }
  }

  function revokeHost(hostId: string) {
    const prefix = `${hostId}\0`;
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      if (key.startsWith(prefix)) revokeKey(key);
    }
  }

  function revokeAll() {
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      revokeKey(key);
    }
  }

  function dispose() {
    disposed = true;
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      rejectPending(key, leaseBusy("The Browser worker is shutting down."));
      const lease = active.get(key);
      if (lease === undefined) continue;
      lease.controller.abort();
      releaseLease(lease);
    }
  }

  return {
    acquireAgent,
    acquireOwner,
    state,
    revoke,
    revokeAgents,
    revokeHost,
    revokeAll,
    dispose,
  };
}

export type ControlLeaseManager = ReturnType<typeof createControlLeaseManager>;
