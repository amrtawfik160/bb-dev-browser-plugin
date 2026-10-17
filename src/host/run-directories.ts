import { lstat, readdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

/**
 * Helper homes whose socket path would be too long live under the storage
 * root's `run` directory, one folder per lane and launch (see
 * `helperRuntimeHome`). Nothing removed them, so they piled up by the
 * hundred.
 */
export const RUN_DIRECTORY_NAME = "run";
export const RUN_DIRECTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** `helperRuntimeHome` names its folders with 16 hex digits. */
const LAUNCH_FOLDER = /^[0-9a-f]{16}$/u;
const SOCKET_PROBE_TIMEOUT_MS = 1_000;

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Newest modification time in a tree, in ms, without following symlinks. */
async function newestChange(path: string): Promise<number> {
  const metadata = await lstat(path);
  let newest = metadata.mtimeMs;
  if (!metadata.isDirectory()) return newest;
  for (const entry of await readdir(path)) {
    try {
      newest = Math.max(newest, await newestChange(join(path, entry)));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return newest;
}

/** A helper daemon still answers on its socket; a stale socket does not. */
function helperAnswers(home: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(join(home, ".dev-browser", "daemon.sock"));
    const finish = (live: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Delete launch folders untouched for {@link RUN_DIRECTORY_RETENTION_MS}
 * whose helper is not running. Symlinks are never followed, and entries
 * that are not launch folders are left alone. Returns how many were deleted.
 */
export async function removeStaleRunDirectories(
  runDirectory: string,
  now = Date.now(),
) {
  let entries;
  try {
    const metadata = await lstat(runDirectory);
    if (!metadata.isDirectory()) return 0;
    entries = await readdir(runDirectory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !LAUNCH_FOLDER.test(entry.name)) continue;
    const home = join(runDirectory, entry.name);
    try {
      if (now - (await newestChange(home)) <= RUN_DIRECTORY_RETENTION_MS) {
        continue;
      }
      if (await helperAnswers(home)) continue;
      // rm unlinks symlinks inside the tree rather than following them.
      await rm(home, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return removed;
}
