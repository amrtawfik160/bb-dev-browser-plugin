import type Database from "better-sqlite3";
import type { BrowserProfile } from "../shared/contracts.js";
import {
  isThreadProfileId,
  threadProfileDefaultName,
} from "../shared/profile-scope.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The owner's cleanup takes worker profiles untouched for over a day. */
export const OWNER_CLEANUP_IDLE_MS = DAY_MS;
/** Automatic cleanup waits longer, so the owner's list is never surprised. */
export const AUTOMATIC_CLEANUP_IDLE_MS = 2 * DAY_MS;

export type ProfileCleanupFacts = {
  profile: BrowserProfile;
  /** Newest change to the profile's storage on the host, in ms. */
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

/**
 * The owner's automatic cleanup setting. No row means the owner has not
 * confirmed it yet, which reads as off.
 */
export const BROWSER_PROFILE_CLEANUP_MIGRATION = `
CREATE TABLE browser_profile_cleanup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  updated_at TEXT NOT NULL
);
`;

export type AutomaticCleanupSetting = "not-confirmed" | "on" | "off";

export function automaticCleanupSetting(
  database: Database.Database,
): AutomaticCleanupSetting {
  const row = database
    .prepare("SELECT automatic FROM browser_profile_cleanup WHERE id = 1")
    .get() as { automatic: number } | undefined;
  if (row === undefined) return "not-confirmed";
  return row.automatic === 1 ? "on" : "off";
}

export function setAutomaticCleanup(
  database: Database.Database,
  enabled: boolean,
) {
  database
    .prepare(
      `INSERT INTO browser_profile_cleanup (id, automatic, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET automatic = excluded.automatic,
                                      updated_at = excluded.updated_at`,
    )
    .run(enabled ? 1 : 0, new Date().toISOString());
  return enabled;
}
