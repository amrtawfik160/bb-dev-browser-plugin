import type { BrowserProfile } from "./contracts.js";
import {
  isThreadProfileId,
  threadProfileDefaultName,
} from "./profile-scope.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The owner's cleanup takes worker profiles untouched for over a day. */
export const OWNER_CLEANUP_IDLE_MS = DAY_MS;
/** Automatic cleanup waits longer, so the owner's list is never surprised. */
export const AUTOMATIC_CLEANUP_IDLE_MS = 2 * DAY_MS;

export type ProfileCleanupFacts = {
  profile: BrowserProfile;
  /**
   * Newest of the profile's file changes on the host and the plugin's
   * recorded browser activity for it, in ms.
   */
  lastUsedAt: number;
  /** A Browser Instance is running or starting for the profile. */
  running: boolean;
  /** Some project or thread explicitly selected the profile. */
  selected: boolean;
};

export type ProfileKeepReason =
  | "not-worker"
  | "archived"
  | "named"
  | "saved"
  | "signed-in"
  | "selected"
  | "running"
  | "recent";

/**
 * A saved profile, or one with a confirmed sign-in, holds a login someone
 * may reuse. Cleanup never deletes it, though it may remove its Rebuildable
 * Data.
 */
export function keepsSavedSignIn(profile: BrowserProfile) {
  return (
    profile.reusable === true ||
    (profile.sites ?? []).some(({ status }) => status === "signed-in")
  );
}

/**
 * Why cleanup keeps a profile, or null when it is an unused worker profile:
 * a thread's default profile, still under its default name, never saved or
 * signed in, selected nowhere, not running, and untouched for `idleMs`.
 */
export function profileKeepReason(
  { profile, lastUsedAt, running, selected }: ProfileCleanupFacts,
  { now, idleMs }: { now: number; idleMs: number },
): ProfileKeepReason | null {
  if (!isThreadProfileId(profile.profileId)) return "not-worker";
  if (profile.state !== "active") return "archived";
  if (profile.name !== threadProfileDefaultName(profile.profileId)) {
    return "named";
  }
  if (profile.reusable === true) return "saved";
  if ((profile.sites ?? []).some(({ status }) => status === "signed-in")) {
    return "signed-in";
  }
  if (selected || profile.selected) return "selected";
  if (running) return "running";
  if (now - lastUsedAt <= idleMs) return "recent";
  return null;
}
