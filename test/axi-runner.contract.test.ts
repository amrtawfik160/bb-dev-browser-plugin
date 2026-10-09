import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AXI_PACKAGE_VERSION,
  DEVTOOLS_MCP_PACKAGE_VERSION,
  axiSessionName,
  refusedAxiCommand,
  resolveAxiRuntime,
  rewriteAxiHints,
  runAxiCommand,
} from "../src/host/axi-runner.js";
import {
  navigableUrl,
  upstreamHttpOrigin,
} from "../src/browser/session-cdp-proxy.js";

describe("chrome-devtools-axi launcher", () => {
  it("resolves the pinned axi and chrome-devtools-mcp executables", () => {
    const paths = resolveAxiRuntime();
    expect(paths.axiBin).toMatch(
      /chrome-devtools-axi[/\\]dist[/\\]bin[/\\]chrome-devtools-axi\.js$/u,
    );
    expect(paths.mcpBin).toMatch(
      /chrome-devtools-mcp[/\\]build[/\\]src[/\\]bin[/\\]chrome-devtools-mcp\.js$/u,
    );
    expect(AXI_PACKAGE_VERSION).toBe("0.1.39");
    expect(DEVTOOLS_MCP_PACKAGE_VERSION).toBe("1.10.1");
  });

  it("ships every bundled axi file in the repository, not just on disk", () => {
    // A checkout is all a host gets, so an ignored bundle file would leave
    // axi missing on every host but the one that built it.
    const paths = resolveAxiRuntime();
    for (const file of [
      paths.axiBin,
      join(dirname(paths.axiBin), "chrome-devtools-axi-bridge.js"),
      paths.mcpBin,
    ]) {
      expect(() =>
        execFileSync("git", ["ls-files", "--error-unmatch", file], {
          stdio: "pipe",
        }),
      ).not.toThrow();
    }
  });

  it("tells chrome-devtools-mcp not to send usage statistics", async () => {
    // The bridge starts chrome-devtools-mcp without our environment, so the
    // opt-out must reach it as an argument.
    const bridge = await readFile(
      join(
        dirname(resolveAxiRuntime().axiBin),
        "chrome-devtools-axi-bridge.js",
      ),
      "utf8",
    );
    const start = bridge.indexOf("var KEYCHAIN_ISOLATION_CHROME_ARGS");
    const end = bridge.indexOf("var DEFAULT_MCP_PATH_PROBE");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const buildTransportArgs = new Function(
      "process",
      `${bridge.slice(start, end)}\nreturn buildTransportArgs();`,
    ) as (process: { env: Record<string, string> }) => string[];
    const endpoint = "ws://127.0.0.1:1/devtools/browser/x";
    expect(
      buildTransportArgs({
        env: {
          CHROME_DEVTOOLS_AXI_BROWSER_URL: endpoint,
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        },
      }),
    ).toContain("--no-usage-statistics");
  });

  it("reads the browser's DevTools over HTTP from the ws:// endpoint Chromium reports", () => {
    expect(
      upstreamHttpOrigin("ws://127.0.0.1:9222/devtools/browser/abc").href,
    ).toBe("http://127.0.0.1:9222/");
    expect(upstreamHttpOrigin("http://127.0.0.1:9222").href).toBe(
      "http://127.0.0.1:9222/",
    );
  });

  it("names one stable axi session per agent session", () => {
    expect(axiSessionName("thread:a")).toBe(axiSessionName("thread:a"));
    expect(axiSessionName("thread:a")).not.toBe(axiSessionName("thread:b"));
    expect(axiSessionName("thread:a")).toMatch(/^bb-[0-9a-f]{16}$/u);
  });

  it("starts every axi bridge with a bounded idle time", async () => {
    const home = await mkdtemp(join(tmpdir(), "bb-axi-env-"));
    const axiBin = join(home, "fake-axi.mjs");
    await writeFile(
      axiBin,
      "process.stdout.write(String(process.env.CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS));",
    );
    try {
      const result = await runAxiCommand(
        { axiBin, mcpBin: join(home, "unused-mcp.js") },
        {
          args: ["pages"],
          endpoint: "http://127.0.0.1:9/",
          session: axiSessionName("thread:a"),
          homeDirectory: home,
        },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "300000" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("keeps axi's next-step hints runnable in BB", () => {
    expect(
      rewriteAxiHints(
        "help[2]:\n  Run `chrome-devtools-axi click @g1:3` to click\n  Run `npx -y chrome-devtools-axi pages` to list tabs",
      ),
    ).toBe(
      "help[2]:\n  Run `bb plugin run browser axi click @g1:3` to click\n  Run `bb plugin run browser axi pages` to list tabs",
    );
    // A URL or file name that merely contains the name is left alone.
    expect(
      rewriteAxiHints("url: https://x.test/chrome-devtools-axi-docs"),
    ).toBe("url: https://x.test/chrome-devtools-axi-docs");
  });

  it("refuses only commands that would change the pinned install", () => {
    expect(refusedAxiCommand(["update"])).not.toBeNull();
    expect(refusedAxiCommand(["setup", "hooks"])).not.toBeNull();
    expect(refusedAxiCommand(["open", "https://example.com"])).toBeNull();
    expect(refusedAxiCommand(["--help"])).toBeNull();
  });

  it("lets an agent session open web pages but not local or browser-internal ones", () => {
    for (const ok of [
      "https://example.com",
      "http://127.0.0.1:3000/",
      "about:blank",
      "",
      "data:text/html,hi",
    ]) {
      expect(navigableUrl(ok), ok).toBe(true);
    }
    for (const denied of [
      "file:///etc/passwd",
      "chrome://settings",
      "devtools://x",
      "view-source:https://a.test",
      "javascript:alert(1)",
    ]) {
      expect(navigableUrl(denied), denied).toBe(false);
    }
  });
});
