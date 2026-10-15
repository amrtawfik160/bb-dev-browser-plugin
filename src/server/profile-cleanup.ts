import type Database from "better-sqlite3";

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
