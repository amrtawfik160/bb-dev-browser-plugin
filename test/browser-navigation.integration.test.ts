import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import {
  activeBrowserTabScript,
  browserHistoryScript,
  browserNavigationScript,
} from "../src/browser/browser-navigation.js";
import { requireDevBrowserRuntime } from "../src/browser/dev-browser-runtime.js";

it.runIf(process.env.BB_BROWSER_REAL_INTEGRATION === "1")(
  "navigates the current foreground through pinned QuickJS after its prior tab closes",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-navigation-quickjs-"));
    const helperHome = join(directory, "helper");
    const helperDirectory = join(helperHome, ".dev-browser");
    const devBrowser = requireDevBrowserRuntime();
    await mkdir(helperDirectory, { recursive: true });
    await symlink(
      join(devBrowser.packageDirectory, "node_modules"),
      join(helperDirectory, "node_modules"),
      "dir",
    );
    const context = await chromium.launchPersistentContext(
      join(directory, "chrome"),
      {
        headless: true,
        executablePath: process.env.BB_BROWSER_TEST_EXECUTABLE,
        args: ["--remote-debugging-port=0"],
      },
    );
    const server = createServer((_request, response) =>
      response.end("<title>Navigation fixture</title>"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture did not bind");
    const url = `http://127.0.0.1:${address.port}/`;
    const [port, path] = (
      await readFile(join(directory, "chrome", "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split("\n");
    const executable = devBrowser.executable;
    function run(code: string, stop = false) {
      return new Promise<{
        code: number | null;
        output: string;
        error: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            executable,
            ...(stop
              ? ["stop"]
              : [
                  "--browser",
                  "navigation-fixture",
                  "--connect",
                  `ws://127.0.0.1:${port}${path}`,
                  "--timeout",
                  "10",
                ]),
          ],
          {
            env: {
              ...process.env,
              HOME: helperHome,
              XDG_CONFIG_HOME: helperHome,
            },
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 15_000,
          },
        );
        let output = "";
        let error = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          error += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) =>
          resolve({ code, output: output.trim(), error }),
        );
        child.stdin.end(code);
      });
    }
    try {
      const original = context.pages()[0]!;
      const selected = await run(activeBrowserTabScript());
      expect(selected.code, selected.error).toBe(0);
      const previousTabId = (JSON.parse(selected.output) as { id: string }).id;
      const replacement = await context.newPage();
      await original.close();
      await replacement.bringToFront();
      const stale = await run(
        browserNavigationScript({ kind: "address", url }, previousTabId),
      );
      expect(stale.code).not.toBe(0);
      expect(stale.error).toContain(
        "Browser Tab is invalid or belongs to a previous runtime",
      );
      expect(replacement.url()).toBe("about:blank");
      const navigation = await run(
        browserNavigationScript({ kind: "address", url }),
      );
      expect(navigation.code, navigation.error).toBe(0);
      expect(JSON.parse(navigation.output)).toMatchObject({ url });
      expect(replacement.url()).toBe(url);
      const history = await run(browserHistoryScript("reload"));
      expect(history.code, history.error).toBe(0);
      expect(JSON.parse(history.output).tabId).toBe(
        JSON.parse(navigation.output).tabId,
      );
    } finally {
      await run("", true);
      await context.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
