import { join, resolve } from "node:path";

type SqliteDatabase = {
  prepare(sql: string): { get: (...values: unknown[]) => unknown };
  close(): void;
};

function openReadOnlyDatabase(path: string): SqliteDatabase | null {
  const sqlite = (
    process as NodeJS.Process & {
      getBuiltinModule?(name: string): unknown;
    }
  ).getBuiltinModule?.("node:sqlite") as
    | {
        DatabaseSync: new (
          path: string,
          options: { readOnly: boolean },
        ) => SqliteDatabase;
      }
    | undefined;
  if (sqlite === undefined) return null;
  try {
    return new sqlite.DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
}

function textColumn(row: unknown, key: string): string | null {
  if (typeof row !== "object" || row === null) return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function integerColumn(row: unknown, key: string): number | null {
  if (typeof row !== "object" || row === null) return null;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function daemonRootFromHostDataDir(dataDir: string) {
  return resolve(dataDir, "../../..");
}

export function readDaemonConnectPairing(daemonRoot: string): boolean {
  const database = openReadOnlyDatabase(join(daemonRoot, "bb.db"));
  if (database === null) return false;
  try {
    const row = database
      .prepare(
        "SELECT length(value) AS n FROM plugin_kv WHERE plugin_id = ? AND key = ?",
      )
      .get("connect", "credential");
    const length = integerColumn(row, "n");
    return length !== null && length > 0;
  } catch {
    return false;
  } finally {
    database.close();
  }
}

export function readDaemonPluginSourcePath(
  daemonRoot: string,
  pluginId: string,
): string | null {
  const database = openReadOnlyDatabase(join(daemonRoot, "bb.db"));
  if (database === null) return null;
  try {
    const row = database
      .prepare(
        "SELECT source_path AS sourcePath FROM plugins WHERE id = ? AND removed_at IS NULL",
      )
      .get(pluginId);
    return textColumn(row, "sourcePath");
  } catch {
    return null;
  } finally {
    database.close();
  }
}
