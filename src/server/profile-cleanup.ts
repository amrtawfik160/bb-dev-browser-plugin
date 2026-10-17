import type Database from "better-sqlite3";
import { DEFAULT_PROFILE_STORAGE_LIMIT_BYTES } from "../shared/contracts.js";

/**
 * The owner's automatic cleanup setting. No row means the owner has not
 * chosen, which reads as on; only an explicit off turns it off.
 */
export const BROWSER_PROFILE_CLEANUP_MIGRATION = `
CREATE TABLE browser_profile_cleanup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  updated_at TEXT NOT NULL
);
`;

/**
 * The owner's storage limit for all profiles on a host. No row means the
 * default, {@link DEFAULT_PROFILE_STORAGE_LIMIT_BYTES}.
 */
export const BROWSER_PROFILE_STORAGE_LIMIT_MIGRATION = `
CREATE TABLE browser_profile_storage_limit (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  limit_bytes INTEGER NOT NULL CHECK (limit_bytes > 0),
  updated_at TEXT NOT NULL
);
`;

export type AutomaticCleanupSetting = "on" | "off";

export function automaticCleanupSetting(
  database: Database.Database,
): AutomaticCleanupSetting {
  const row = database
    .prepare("SELECT automatic FROM browser_profile_cleanup WHERE id = 1")
    .get() as { automatic: number } | undefined;
  return row?.automatic === 0 ? "off" : "on";
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

export function profileStorageLimitBytes(database: Database.Database) {
  const row = database
    .prepare(
      "SELECT limit_bytes FROM browser_profile_storage_limit WHERE id = 1",
    )
    .get() as { limit_bytes: number } | undefined;
  return row?.limit_bytes ?? DEFAULT_PROFILE_STORAGE_LIMIT_BYTES;
}

export function setProfileStorageLimitBytes(
  database: Database.Database,
  limitBytes: number,
) {
  database
    .prepare(
      `INSERT INTO browser_profile_storage_limit (id, limit_bytes, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET limit_bytes = excluded.limit_bytes,
                                      updated_at = excluded.updated_at`,
    )
    .run(limitBytes, new Date().toISOString());
  return limitBytes;
}
