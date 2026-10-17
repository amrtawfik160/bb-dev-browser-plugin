import {
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_DIRECTORY_RETENTION_MS,
  removeStaleRunDirectories,
} from "../src/host/run-directories.js";

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse("2026-10-17T00:00:00.000Z");

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** One helper home as the browser leaves it, last touched `daysAgo`. */
async function helperHome(runDirectory: string, name: string, daysAgo: number) {
  const home = join(runDirectory, name);
  const daemon = join(home, ".dev-browser");
  await mkdir(join(daemon, "tmp"), { recursive: true });
  await writeFile(join(daemon, "daemon.mjs"), "daemon");
  const at = new Date(NOW - daysAgo * DAY);
  for (const path of [
    join(daemon, "daemon.mjs"),
    join(daemon, "tmp"),
    daemon,
    home,
  ]) {
    await utimes(path, at, at);
  }
  return home;
}

describe("browser run directory cleanup", () => {
  it("keeps launch folders for seven days", () => {
    expect(RUN_DIRECTORY_RETENTION_MS).toBe(7 * DAY);
  });

  it("removes launch folders older than seven days and keeps newer ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-run-"));
    roots.push(root);
    const runDirectory = join(root, "run");
    const old = await helperHome(runDirectory, "00aa11bb22cc33dd", 8);
    const recent = await helperHome(runDirectory, "44ee55ff66aa77bb", 6);

    const removed = await removeStaleRunDirectories(runDirectory, NOW);

    expect(removed).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  it("keeps an old folder whose helper is still running", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-run-"));
    roots.push(root);
    const runDirectory = join(root, "run");
    const live = await helperHome(runDirectory, "8899aabbccddeeff", 30);
    const stale = await helperHome(runDirectory, "0011223344556677", 30);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(join(live, ".dev-browser", "daemon.sock"), resolve),
    );
    // A socket left by a helper that is gone accepts no connection.
    const dead = createServer();
    const deadSocket = join(stale, ".dev-browser", "daemon.sock");
    await new Promise<void>((resolve) => dead.listen(deadSocket, resolve));
    await new Promise((resolve) => dead.close(resolve));
    await writeFile(deadSocket, "").catch(() => undefined);
    for (const home of [live, stale]) {
      const at = new Date(NOW - 30 * DAY);
      await utimes(join(home, ".dev-browser", "daemon.sock"), at, at);
      await utimes(join(home, ".dev-browser"), at, at);
      await utimes(home, at, at);
    }

    const removed = await removeStaleRunDirectories(runDirectory, NOW);

    expect(removed).toBe(1);
    expect(await exists(live)).toBe(true);
    expect(await exists(stale)).toBe(false);
  });

  it("never follows symlinks and leaves unrecognized entries alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-run-"));
    roots.push(root);
    const runDirectory = join(root, "run");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep"), "keep");
    const home = await helperHome(runDirectory, "aabbccddeeff0011", 30);
    // The helper's node_modules link points at shared, staged packages.
    await symlink(outside, join(home, ".dev-browser", "node_modules"));
    await symlink(outside, join(runDirectory, "ffeeddccbbaa9988"));
    await mkdir(join(runDirectory, "not-a-launch-folder"));
    const at = new Date(NOW - 30 * DAY);
    await lutimes(join(home, ".dev-browser", "node_modules"), at, at);
    await utimes(join(home, ".dev-browser"), at, at);
    await utimes(join(runDirectory, "not-a-launch-folder"), at, at);

    await removeStaleRunDirectories(runDirectory, NOW);

    expect(await exists(home)).toBe(false);
    expect(await exists(join(outside, "keep"))).toBe(true);
    expect(await exists(join(runDirectory, "ffeeddccbbaa9988"))).toBe(true);
    expect(await exists(join(runDirectory, "not-a-launch-folder"))).toBe(true);
  });

  it("does nothing without a run directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-browser-run-"));
    roots.push(root);
    expect(await removeStaleRunDirectories(join(root, "run"), NOW)).toBe(0);
  });
});
