import * as filesystem from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createProductionBrowserProcessBoundary } from "../browser-process.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof filesystem>()),
}));
afterEach(() => vi.restoreAllMocks());

it.each(["ENOENT", "ESRCH"])(
  "keeps the browser alive when an unrelated process exits during a renderer check (%s)",
  async (code) => {
    vi.spyOn(filesystem, "readdir").mockResolvedValue([
      "100",
      "101",
      "200",
    ] as never);
    vi.spyOn(filesystem, "readFile").mockImplementation(async (path) => {
      if (String(path).startsWith("/proc/200/"))
        throw Object.assign(new Error("gone"), { code });
      if (String(path).endsWith("/stat"))
        return String(path).includes("/101/")
          ? "101 (renderer) S 100"
          : "100 (chrome) S 1";
      return String(path).includes("/101/")
        ? "chrome\0--type=renderer"
        : "chrome";
    });
    const boundary = createProductionBrowserProcessBoundary({
      devBrowserExecutable: "/bin/true",
    });
    await expect(
      boundary.assertRendererProcessLimit!(100),
    ).resolves.toBeUndefined();
  },
);

it("does not read protected command lines of processes outside the browser tree", async () => {
  vi.spyOn(filesystem, "readdir").mockResolvedValue([
    "100",
    "101",
    "200",
  ] as never);
  vi.spyOn(filesystem, "readFile").mockImplementation(async (path) => {
    if (String(path) === "/proc/200/cmdline")
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (String(path).endsWith("/stat"))
      return String(path).includes("/101/")
        ? "101 (renderer) S 100"
        : "100 (process) S 1";
    return String(path).includes("/101/")
      ? "chrome\0--type=renderer"
      : "chrome";
  });
  const boundary = createProductionBrowserProcessBoundary({
    devBrowserExecutable: "/bin/true",
  });
  await expect(
    boundary.assertRendererProcessLimit!(100),
  ).resolves.toBeUndefined();
});

it("fails closed if a browser descendant cannot be inspected", async () => {
  vi.spyOn(filesystem, "readdir").mockResolvedValue(["100", "101"] as never);
  vi.spyOn(filesystem, "readFile").mockImplementation(async (path) => {
    if (String(path) === "/proc/101/cmdline")
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    if (String(path).endsWith("/stat"))
      return String(path).includes("/101/")
        ? "101 (renderer) S 100"
        : "100 (chrome) S 1";
    return "chrome";
  });
  const boundary = createProductionBrowserProcessBoundary({
    devBrowserExecutable: "/bin/true",
  });
  await expect(boundary.assertRendererProcessLimit!(100)).rejects.toMatchObject(
    { code: "renderer-limit" },
  );
});
