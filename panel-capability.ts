import { randomUUID } from "node:crypto";
import {
  PANEL_CAPABILITY_TTL_MS,
  PANEL_AUTH_ROTATION_MS,
  PANEL_RECLAIM_WINDOW_MS,
  type BrowserPanelRedeemMessage,
} from "./contracts.js";

/**
 * A single-use, short-lived authorization that bootstraps a renewable stream
 * connection to one Workspace Browser. It binds to one owner session, panel
 * instance, host, and profile, expires unredeemed after 60 seconds, is
 * redeemed in the first WebSocket message rather than a URL, rotates every
 * five minutes once connected, and is revoked on panel close or profile
 * switch. It never grants agent access and never carries a transport address.
 */
export type PanelCapabilityBinding = {
  ownerSessionId: string;
  panelId: string;
  hostId: string;
  profileId: string;
};

export type PanelCapabilityIssue = {
  capabilityId: string;
  secret: string;
  binding: PanelCapabilityBinding;
  issuedAt: number;
  expiresAt: number;
};

export type PanelCapabilityConnection = {
  capabilityId: string;
  binding: PanelCapabilityBinding;
  connectedAt: number;
  rotatesAt: number;
  generation: number;
};

export type PanelCapabilityRedeemResult =
  | { outcome: "redeemed"; connection: PanelCapabilityConnection }
  | { outcome: "expired" | "replayed" | "binding-mismatch" | "unknown" };

export type PanelCapabilityClock = { now(): number };

export type PanelCapabilityRevokeReason =
  "panel-closed" | "profile-switched" | "rotated" | "disconnected";

export type PanelCapabilityRevocationListener = (
  capabilityId: string,
  binding: PanelCapabilityBinding,
  reason: PanelCapabilityRevokeReason,
) => void;

export type PanelCapabilityStoreOptions = {
  clock?: PanelCapabilityClock;
  ttlMs?: number;
  rotationMs?: number;
  reclaimWindowMs?: number;
  onRevoked?: PanelCapabilityRevocationListener;
};

export type PanelCapabilityStore = ReturnType<
  typeof createPanelCapabilityStore
>;

export function createPanelCapabilityStore(
  options: PanelCapabilityStoreOptions = {},
) {
  const clock = options.clock ?? { now: () => Date.now() };
  const ttlMs = options.ttlMs ?? PANEL_CAPABILITY_TTL_MS;
  const rotationMs = options.rotationMs ?? PANEL_AUTH_ROTATION_MS;
  const reclaimWindowMs = options.reclaimWindowMs ?? PANEL_RECLAIM_WINDOW_MS;
  const onRevoked = options.onRevoked;
  const pending = new Map<string, PanelCapabilityIssue>();
  const connected = new Map<string, PanelCapabilityConnection>();
  const redeemedSecrets = new Set<string>();
  /**
   * The reclaim window: a disconnected connection may reclaim its lease for a
   * bounded period before the store releases it. Input freezes immediately on
   * disconnect; the connection survives only for reclaim.
   */
  const disconnected = new Map<string, { until: number }>();
  const revocationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function issue(binding: PanelCapabilityBinding): PanelCapabilityIssue {
    const issuedAt = clock.now();
    const capability: PanelCapabilityIssue = {
      capabilityId: `panel-capability-${randomUUID()}`,
      secret: randomUUID(),
      binding,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    };
    pending.set(capability.capabilityId, capability);
    scheduleExpiry(capability);
    return capability;
  }

  function scheduleExpiry(capability: PanelCapabilityIssue) {
    const handle = setTimeout(() => {
      const current = pending.get(capability.capabilityId);
      if (current === undefined) return;
      pending.delete(capability.capabilityId);
    }, ttlMs);
    revocationTimers.set(capability.capabilityId, handle);
  }

  function bindingMatches(
    capability: { binding: PanelCapabilityBinding },
    message: BrowserPanelRedeemMessage,
    hostId: string,
    profileId: string,
  ): boolean {
    return (
      capability.binding.ownerSessionId === message.ownerSessionId &&
      capability.binding.panelId === message.panelId &&
      capability.binding.hostId === hostId &&
      capability.binding.profileId === profileId
    );
  }

  function redeem(
    message: BrowserPanelRedeemMessage,
    hostId: string,
    profileId: string,
  ): PanelCapabilityRedeemResult {
    const capability = pending.get(message.capabilityId);
    if (capability === undefined) {
      if (redeemedSecrets.has(message.secret)) {
        return { outcome: "replayed" };
      }
      const existing = connected.get(message.capabilityId);
      if (existing !== undefined) {
        return { outcome: "replayed" };
      }
      return { outcome: "unknown" };
    }
    if (clock.now() >= capability.expiresAt) {
      pending.delete(message.capabilityId);
      return { outcome: "expired" };
    }
    if (redeemedSecrets.has(capability.secret)) {
      return { outcome: "replayed" };
    }
    if (!bindingMatches(capability, message, hostId, profileId)) {
      return { outcome: "binding-mismatch" };
    }
    pending.delete(message.capabilityId);
    const handle = revocationTimers.get(message.capabilityId);
    if (handle !== undefined) {
      clearTimeout(handle);
      revocationTimers.delete(message.capabilityId);
    }
    redeemedSecrets.add(capability.secret);
    const connectedAt = clock.now();
    const connection: PanelCapabilityConnection = {
      capabilityId: capability.capabilityId,
      binding: capability.binding,
      connectedAt,
      rotatesAt: connectedAt + rotationMs,
      generation: 1,
    };
    connected.set(capability.capabilityId, connection);
    return { outcome: "redeemed", connection };
  }

  function connection(
    capabilityId: string,
  ): PanelCapabilityConnection | undefined {
    return connected.get(capabilityId);
  }

  /**
   * Rotate connected authorization. Returns the new generation and rotation
   * deadline, or null if the connection no longer exists. Rotation does not
   * reissue a capability; it refreshes the renewable stream credential.
   */
  function rotate(
    capabilityId: string,
  ): { generation: number; rotatesAt: number } | null {
    const connection = connected.get(capabilityId);
    if (connection === undefined) return null;
    const rotatesAt = clock.now() + rotationMs;
    const next: PanelCapabilityConnection = {
      ...connection,
      generation: connection.generation + 1,
      rotatesAt,
    };
    connected.set(capabilityId, next);
    return { generation: next.generation, rotatesAt };
  }

  function revoke(
    capabilityId: string,
    reason: PanelCapabilityRevokeReason,
  ): boolean {
    const handle = revocationTimers.get(capabilityId);
    if (handle !== undefined) {
      clearTimeout(handle);
      revocationTimers.delete(capabilityId);
    }
    const pendingCapability = pending.get(capabilityId);
    if (pendingCapability !== undefined) {
      pending.delete(capabilityId);
      onRevoked?.(capabilityId, pendingCapability.binding, reason);
      return true;
    }
    const connection = connected.get(capabilityId);
    if (connection !== undefined) {
      connected.delete(capabilityId);
      disconnected.delete(capabilityId);
      onRevoked?.(capabilityId, connection.binding, reason);
      return true;
    }
    return false;
  }

  /**
   * Revoke every capability bound to a profile. Used when the owner switches
   * the panel's profile: the prior connection is revoked even if it was still
   * connected, so the stream cannot follow the profile across the binding.
   */
  function revokeProfile(profileId: string): string[] {
    const revoked: string[] = [];
    for (const capabilityId of [...pending.keys()]) {
      const capability = pending.get(capabilityId);
      if (capability?.binding.profileId === profileId) {
        revoke(capabilityId, "profile-switched");
        revoked.push(capabilityId);
      }
    }
    for (const capabilityId of [...connected.keys()]) {
      const connection = connected.get(capabilityId);
      if (connection?.binding.profileId === profileId) {
        revoke(capabilityId, "profile-switched");
        revoked.push(capabilityId);
      }
    }
    return revoked;
  }

  /**
   * Mark a connection disconnected. Input freezes immediately; the same panel
   * has a bounded reclaim window before its connection is released.
   */
  function markDisconnected(capabilityId: string): boolean {
    const connection = connected.get(capabilityId);
    if (connection === undefined) return false;
    if (disconnected.has(capabilityId)) return true;
    disconnected.set(capabilityId, { until: clock.now() + reclaimWindowMs });
    const handle = setTimeout(() => {
      if (disconnected.has(capabilityId)) {
        revoke(capabilityId, "disconnected");
      }
    }, reclaimWindowMs);
    revocationTimers.set(`reclaim-${capabilityId}`, handle);
    return true;
  }

  /**
   * Reclaim a connection that was marked disconnected. The same panel reclaims
   * its Control Lease within the reclaim window; stream reconnect then uses
   * bounded backoff handled by the stream policy.
   */
  function reclaim(capabilityId: string): boolean {
    const entry = disconnected.get(capabilityId);
    if (entry === undefined) return false;
    if (clock.now() > entry.until) return false;
    disconnected.delete(capabilityId);
    const handle = revocationTimers.get(`reclaim-${capabilityId}`);
    if (handle !== undefined) {
      clearTimeout(handle);
      revocationTimers.delete(`reclaim-${capabilityId}`);
    }
    return connected.has(capabilityId);
  }

  function isDisconnected(capabilityId: string): boolean {
    return disconnected.has(capabilityId);
  }

  function size() {
    return pending.size + connected.size;
  }

  function dispose() {
    for (const handle of revocationTimers.values()) clearTimeout(handle);
    revocationTimers.clear();
    pending.clear();
    connected.clear();
    redeemedSecrets.clear();
    disconnected.clear();
  }

  return {
    issue,
    redeem,
    connection,
    rotate,
    revoke,
    revokeProfile,
    markDisconnected,
    reclaim,
    isDisconnected,
    size,
    dispose,
    get ttlMs() {
      return ttlMs;
    },
    get rotationMs() {
      return rotationMs;
    },
    get reclaimWindowMs() {
      return reclaimWindowMs;
    },
  };
}
