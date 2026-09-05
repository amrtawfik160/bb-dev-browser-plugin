import * as filesystem from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductionBrowserProcessBoundary } from "../src/browser/browser-process.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof filesystem>()),
}));
afterEach(() => vi.restoreAllMocks());

type FakeProcess = {
  parent: number;
  cmdline: string;
  children?: readonly number[];
  /** Error code thrown when the command line is read. */
  cmdlineError?: string;
  /** Error code thrown when the task directory is listed. */
  taskError?: string;
};

type FakeProcTable = Record<number, FakeProcess>;

function procError(code: string) {
  return Object.assign(new Error(code), { code });
}

/**
 * Model `/proc` for the two ways the monitor can walk it: the children files
 * of the browser's own subtree, or (when the kernel lacks them) a scan of
 * every process's stat file.
 */
function mockProc(table: FakeProcTable, options: { childrenFiles: boolean }) {
  const readdir = vi.spyOn(filesystem, "readdir");
  const readFile = vi.spyOn(filesystem, "readFile");
  const access = vi.spyOn(filesystem, "access");
  access.mockImplementation(async () => {
    if (!options.childrenFiles) throw procError("ENOENT");
  });
  readdir.mockImplementation((async (path: string) => {
    if (path === "/proc") return Object.keys(table);
    const task = /^\/proc\/(\d+)\/task$/u.exec(path);
    if (task !== null) {
      const process_ = table[Number(task[1])];
      if (process_ === undefined) throw procError("ENOENT");
      if (process_.taskError !== undefined) throw procError(process_.taskError);
      return [task[1]!];
    }
    throw new Error(`unexpected readdir ${path}`);
  }) as never);
  readFile.mockImplementation((async (path: string) => {
    const children = /^\/proc\/(\d+)\/task\/\d+\/children$/u.exec(path);
    if (children !== null) {
      if (!options.childrenFiles) throw procError("ENOENT");
      const process_ = table[Number(children[1])];
      if (process_ === undefined) throw procError("ENOENT");
      return (process_.children ?? []).join(" ");
    }
    const stat = /^\/proc\/(\d+)\/stat$/u.exec(path);
    if (stat !== null) {
      const process_ = table[Number(stat[1])];
      if (process_ === undefined) throw procError("ENOENT");
      return `${stat[1]} (chrome) S ${process_.parent}`;
    }
    const cmdline = /^\/proc\/(\d+)\/cmdline$/u.exec(path);
    if (cmdline !== null) {
      const process_ = table[Number(cmdline[1])];
      if (process_ === undefined) throw procError("ENOENT");
      if (process_.cmdlineError !== undefined) {
        throw procError(process_.cmdlineError);
      }
      return process_.cmdline;
    }
    throw new Error(`unexpected readFile ${path}`);
  }) as never);
  return { readdir, readFile };
}

const boundary = () =>
  createProductionBrowserProcessBoundary({ devBrowserExecutable: "/bin/true" });

const renderer = (parent: number): FakeProcess => ({
  parent,
  cmdline: "chrome\0--type=renderer",
});

describe("renderer monitoring through the browser subtree", () => {
  it("counts renderers without scanning every process on the host", async () => {
    const proc = mockProc(
      {
        100: { parent: 1, cmdline: "chrome", children: [101, 102] },
        101: { parent: 100, cmdline: "chrome\0--type=zygote", children: [103] },
        102: renderer(100),
        103: renderer(101),
        // An unrelated process whose command line must never be read.
        200: {
          parent: 1,
          cmdline: "secret --token=abc",
          cmdlineError: "EACCES",
        },
      },
      { childrenFiles: true },
    );

    await expect(boundary().assertRendererProcessLimit!(100)).resolves.toBe(
      undefined,
    );
    expect(proc.readdir).not.toHaveBeenCalledWith("/proc");
    // Renderers cannot fork, so their thread lists are never walked.
    expect(proc.readdir).not.toHaveBeenCalledWith("/proc/102/task");
    expect(proc.readdir).not.toHaveBeenCalledWith("/proc/103/task");
    const readPaths = proc.readFile.mock.calls.map((call) => String(call[0]));
    expect(readPaths.some((path) => path.startsWith("/proc/200/"))).toBe(false);
    expect(readPaths.some((path) => path.endsWith("/stat"))).toBe(false);
  });

  it("tolerates a child that exits during the walk", async () => {
    mockProc(
      {
        100: { parent: 1, cmdline: "chrome", children: [101, 300] },
        101: renderer(100),
      },
      { childrenFiles: true },
    );

    await expect(boundary().assertRendererProcessLimit!(100)).resolves.toBe(
      undefined,
    );
  });

  it("fails closed when the browser process itself is gone", async () => {
    mockProc({ 101: renderer(100) }, { childrenFiles: true });

    await expect(
      boundary().assertRendererProcessLimit!(100),
    ).rejects.toMatchObject({ code: "renderer-limit" });
  });

  it("fails closed if a browser descendant cannot be inspected", async () => {
    mockProc(
      {
        100: { parent: 1, cmdline: "chrome", children: [101] },
        101: { parent: 100, cmdline: "", cmdlineError: "EACCES" },
      },
      { childrenFiles: true },
    );

    await expect(
      boundary().assertRendererProcessLimit!(100),
    ).rejects.toMatchObject({ code: "renderer-limit" });
  });

  it("reports the ceiling when the subtree holds too many renderers", async () => {
    const table: FakeProcTable = {
      100: {
        parent: 1,
        cmdline: "chrome",
        children: Array.from({ length: 9 }, (_, index) => 101 + index),
      },
    };
    for (let pid = 101; pid <= 109; pid += 1) table[pid] = renderer(100);
    mockProc(table, { childrenFiles: true });

    await expect(boundary().assertRendererProcessLimit!(100)).rejects.toThrow(
      "has 9 renderer processes; the limit is 8",
    );
  });
});

describe("renderer monitoring without children files", () => {
  it.each(["ENOENT", "ESRCH"])(
    "keeps the browser alive when an unrelated process exits during a renderer check (%s)",
    async (code) => {
      mockProc(
        {
          100: { parent: 1, cmdline: "chrome" },
          101: renderer(100),
          200: { parent: 1, cmdline: "other", cmdlineError: code },
        },
        { childrenFiles: false },
      );

      await expect(boundary().assertRendererProcessLimit!(100)).resolves.toBe(
        undefined,
      );
    },
  );

  it("does not read protected command lines of processes outside the browser tree", async () => {
    mockProc(
      {
        100: { parent: 1, cmdline: "chrome" },
        101: renderer(100),
        200: { parent: 1, cmdline: "other", cmdlineError: "EACCES" },
      },
      { childrenFiles: false },
    );

    await expect(boundary().assertRendererProcessLimit!(100)).resolves.toBe(
      undefined,
    );
  });

  it("fails closed if a browser descendant cannot be inspected", async () => {
    mockProc(
      {
        100: { parent: 1, cmdline: "chrome" },
        101: { parent: 100, cmdline: "", cmdlineError: "EACCES" },
      },
      { childrenFiles: false },
    );

    await expect(
      boundary().assertRendererProcessLimit!(100),
    ).rejects.toMatchObject({ code: "renderer-limit" });
  });
});
