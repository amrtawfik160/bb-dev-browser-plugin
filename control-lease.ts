import {
  BROWSER_SCRIPT_MAX_TIMEOUT_MS,
  type BrowserControlLease,
} from "./contracts.js";

export const CONTROL_LEASE_AGENT_WAIT_MS = 5_000;

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
          leaseBusy("Another Browser operation still holds the Control Lease."),
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
    key: LeaseKey,
    purpose: string,
    signal?: AbortSignal,
  ): Promise<ControlLease> {
    assertAvailable();
    if (signal?.aborted) {
      throw leaseBusy("The Browser script request was cancelled.");
    }
    const current = active.get(key);
    if (current?.actor === "owner") {
      throw leaseBusy(
        "Owner control currently holds the Browser Control Lease.",
      );
    }
    if (current !== undefined) return enqueueAgent(key, purpose, signal);
    const lease = createActiveLease(key, "agent", purpose);
    active.set(key, lease);
    return publicLease(lease, () => releaseLease(lease));
  }

  async function acquireOwner(
    key: LeaseKey,
    signal?: AbortSignal,
  ): Promise<ControlLease> {
    assertAvailable();
    const current = active.get(key);
    if (current !== undefined) {
      rejectPending(
        key,
        leaseBusy("Owner control took priority over queued Browser agents."),
      );
      current.controller.abort();
      await waitForLease(current, signal);
    }
    if (signal?.aborted) throw rejectedOwnerRequest();
    const lease = createActiveLease(key, "owner", null);
    active.set(key, lease);
    return publicLease(lease, () => releaseLease(lease));
  }

  function state(key: LeaseKey): BrowserControlLease | undefined {
    const lease = active.get(key);
    return lease === undefined || lease.controller.signal.aborted
      ? undefined
      : { actor: lease.actor, purpose: lease.purpose };
  }

  function revoke(key: LeaseKey) {
    rejectPending(key, leaseBusy("Browser control was revoked."));
    active.get(key)?.controller.abort();
  }

  function revokeHost(hostId: string) {
    const prefix = `${hostId}\0`;
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      if (key.startsWith(prefix)) revoke(key);
    }
  }

  function revokeAll() {
    for (const key of new Set([...active.keys(), ...waiting.keys()])) {
      revoke(key);
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
    revokeHost,
    revokeAll,
    dispose,
  };
}

export type ControlLeaseManager = ReturnType<typeof createControlLeaseManager>;
