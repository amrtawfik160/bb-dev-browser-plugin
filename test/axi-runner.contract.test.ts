import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AXI_PACKAGE_VERSION,
  DEVTOOLS_MCP_PACKAGE_VERSION,
  axiSessionName,
  refusedAxiCommand,
  resolveAxiRuntime,
  rewriteAxiHints,
} from "../src/host/axi-runner.js";
import { navigableUrl } from "../src/browser/session-cdp-proxy.js";

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

  it("names one stable axi session per agent session", () => {
    expect(axiSessionName("thread:a")).toBe(axiSessionName("thread:a"));
    expect(axiSessionName("thread:a")).not.toBe(axiSessionName("thread:b"));
    expect(axiSessionName("thread:a")).toMatch(/^bb-[0-9a-f]{16}$/u);
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
