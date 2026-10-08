import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readServerFacts, writeServerFacts } from "../src/host/server-facts.js";
import {
  createServerFactsSync,
  resolvePluginSourcePath,
} from "../src/server/server-facts.js";

const SOURCE_ROOT = join(import.meta.dirname, "../src");

/**
 * Opening the server's live `bb.db` from another process can truncate its
 * shared wal-index and kill the server with SIGBUS. Nothing the plugin ships
 * may open it, or load a SQLite driver that could.
 */
const FORBIDDEN = [
  /bb\.db/u,
  /node:sqlite/u,
  /bun:sqlite/u,
  /DatabaseSync/u,
  /getBuiltinModule/u,
  /from\s+["']better-sqlite3["']/u,
  /require\(\s*["']better-sqlite3["']\s*\)/u,
];

describe("server database isolation", () => {
  it("ships no code that opens the server database", async () => {
    const entries = await readdir(SOURCE_ROOT, {
      recursive: true,
      withFileTypes: true,
    });
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:ts|tsx|mjs|js)$/u.test(entry.name))
        continue;
      const path = join(entry.parentPath, entry.name);
      // Type-only imports of the driver describe `bb.storage`; they load nothing.
      const source = (await readFile(path, "utf8")).replace(
        /^import type .*$/gmu,
        "",
      );
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${relative(SOURCE_ROOT, path)}: ${pattern.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the facts the server sent in the host's own data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "browser-server-facts-"));
    try {
      expect(readServerFacts(dataDir)).toEqual({
        connectEnrolled: false,
        pluginSourcePath: null,
      });
      await writeServerFacts(dataDir, {
        connectEnrolled: true,
        pluginSourcePath: "/opt/bb-plugin-browser",
      });
      expect(readServerFacts(dataDir)).toEqual({
        connectEnrolled: true,
        pluginSourcePath: "/opt/bb-plugin-browser",
      });
      await writeFile(join(dataDir, "server-facts.json"), "{ not json");
      expect(readServerFacts(dataDir)).toEqual({
        connectEnrolled: false,
        pluginSourcePath: null,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("finds the plugin's install directory from the running server entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-plugin-source-"));
    try {
      await mkdir(join(root, "dist"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "bb-plugin-browser" }),
      );
      await writeFile(join(root, "dist/package.json"), '{"type":"module"}');
      expect(
        resolvePluginSourcePath(
          pathToFileURL(join(root, "dist/server.js")).href,
        ),
      ).toBe(root);
      expect(resolvePluginSourcePath(pathToFileURL("/server.js").href)).toBe(
        null,
      );
      expect(resolvePluginSourcePath()).toBe(join(SOURCE_ROOT, ".."));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends each host the Connect pairing and install directory, then refreshes them", async () => {
    let paired = false;
    let clock = 0;
    const callRpc = vi.fn(async () => ({ paired }));
    const send = vi.fn(async () => ({ stored: true }));
    const sync = createServerFactsSync(
      { sdk: { plugins: { callRpc } } } as unknown as BbPluginApi,
      send,
      { pluginSourcePath: "/opt/bb-plugin-browser", now: () => clock },
    );

    await Promise.all([sync.ensure("host-a"), sync.ensure("host-a")]);
    await sync.ensure("host-a");
    expect(callRpc).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "connect", method: "status" }),
    );
    expect(send.mock.calls).toEqual([
      [
        "host-a",
        { connectEnrolled: false, pluginSourcePath: "/opt/bb-plugin-browser" },
      ],
    ]);

    paired = true;
    clock += 10_000;
    await sync.ensure("host-a");
    expect(send).toHaveBeenLastCalledWith("host-a", {
      connectEnrolled: true,
      pluginSourcePath: "/opt/bb-plugin-browser",
    });

    send.mockRejectedValueOnce(new Error("host offline"));
    callRpc.mockRejectedValueOnce(new Error("connect is not running"));
    await expect(sync.ensure("host-b")).resolves.toBeUndefined();
    await sync.ensure("host-b");
    expect(send).toHaveBeenLastCalledWith("host-b", {
      connectEnrolled: true,
      pluginSourcePath: "/opt/bb-plugin-browser",
    });
  });
});
