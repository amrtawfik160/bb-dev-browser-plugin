import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { startSessionCdpProxy } from "../src/browser/session-cdp-proxy.js";
import {
  axiSessionName,
  resolveAxiRuntime,
  runAxiCommand,
} from "../src/host/axi-runner.js";

const real = process.env.BB_BROWSER_REAL_INTEGRATION === "1";

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * The real chrome-devtools-axi drives an agent session's own tabs through its
 * Session CDP Proxy while the owner's tab stays hidden and untouched.
 */
describe.skipIf(!real)(
  "chrome-devtools-axi through a Session CDP Proxy",
  () => {
    it("opens, reads, clicks, and lists only the session's tabs", async () => {
      const server = createServer((request, response) => {
        response.setHeader("content-type", "text/html");
        response.end(
          request.url === "/next"
            ? "<title>Next</title><h1>Next page</h1>"
            : '<title>Start</title><h1>Start</h1><a href="/next">Go next</a>',
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      const userDataDir = await mkdtemp(join(tmpdir(), "bb-axi-browser-"));
      const home = await mkdtemp(join(tmpdir(), "bb-axi-home-"));
      const work = await mkdtemp(join(tmpdir(), "bb-axi-work-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      const owner = context.pages()[0]!;
      await owner.setContent("<title>Owner tab</title><h1>owner</h1>");
      const devToolsPort = (
        await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
      ).split("\n")[0]!;
      // The runtime reports Chromium's endpoint as ws://…/devtools/browser/…,
      // exactly as Chromium prints it; the proxy must accept that form.
      const browserSocket = (
        (await (
          await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)
        ).json()) as { webSocketDebuggerUrl: string }
      ).webSocketDebuggerUrl;
      expect(browserSocket).toMatch(/^ws:\/\//u);
      const proxy = await startSessionCdpProxy({
        upstreamEndpoint: async () => browserSocket,
      });
      const paths = resolveAxiRuntime();
      const session = axiSessionName(`thread:${work}`);
      const axi = (...args: string[]) =>
        runAxiCommand(paths, {
          args,
          endpoint: proxy.endpoint,
          session,
          cwd: work,
          homeDirectory: home,
        });
      try {
        const opened = await axi("open", `http://127.0.0.1:${port}/`);
        expect(opened.exitCode, opened.stderr).toBe(0);
        expect(opened.stdout).toContain("title: Start");
        const ref = /uid=(g\d+:[\w_]+) link "Go next"/u.exec(
          opened.stdout,
        )?.[1];
        expect(ref, opened.stdout).toBeDefined();
        expect(opened.stdout).toContain("bb plugin run browser axi");
        expect(opened.stdout).not.toMatch(/(^|\s|`)chrome-devtools-axi /mu);

        const clicked = await axi("click", `@${ref}`);
        expect(clicked.exitCode, clicked.stderr).toBe(0);
        expect(clicked.stdout).toContain("Next");

        const pages = await axi("pages");
        expect(pages.stdout).toMatch(/pages\[1\]/u);
        expect(pages.stdout).not.toContain("Owner tab");

        const shot = await axi("screenshot", "shot.png");
        expect(shot.exitCode, shot.stderr).toBe(0);
        expect((await stat(join(work, "shot.png"))).size).toBeGreaterThan(0);

        // A local file never loads: the page stays on the last web document.
        const local = await axi("open", "file:///etc/hostname");
        expect(local.stdout).toMatch(/RootWebArea "Next" url="http:/u);
        expect(local.stdout).not.toMatch(/RootWebArea "[^"]*" url="file:/u);

        expect(owner.url()).toBe("about:blank");
        expect(await owner.title()).toBe("Owner tab");
      } finally {
        await axi("stop").catch(() => undefined);
        await proxy.close();
        await context.close();
        await closeServer(server);
        await Promise.all(
          [userDataDir, home, work].map((dir) =>
            rm(dir, { recursive: true, force: true }),
          ),
        );
      }
    }, 180_000);

    it("ends an idle axi bridge on its own", async () => {
      const userDataDir = await mkdtemp(join(tmpdir(), "bb-axi-browser-"));
      const home = await mkdtemp(join(tmpdir(), "bb-axi-home-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      const devToolsPort = (
        await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
      ).split("\n")[0]!;
      const proxy = await startSessionCdpProxy({
        upstreamEndpoint: async () =>
          (
            (await (
              await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)
            ).json()) as { webSocketDebuggerUrl: string }
          ).webSocketDebuggerUrl,
      });
      const session = axiSessionName(`thread:${home}`);
      try {
        const opened = await runAxiCommand(resolveAxiRuntime(), {
          args: ["open", "about:blank"],
          endpoint: proxy.endpoint,
          session,
          homeDirectory: home,
          bridgeIdleTimeoutMs: 2_000,
        });
        expect(opened.exitCode, opened.stderr).toBe(0);
        const pidFile = join(
          home,
          ".chrome-devtools-axi",
          "sessions",
          session,
          "bridge.pid",
        );
        const { pid } = JSON.parse(await readFile(pidFile, "utf8")) as {
          pid: number;
        };
        const alive = () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        expect(alive()).toBe(true);
        const deadline = Date.now() + 30_000;
        while (alive() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(alive(), "bridge still running after its idle time").toBe(false);
      } finally {
        await proxy.close();
        await context.close();
        await Promise.all(
          [userDataDir, home].map((dir) =>
            rm(dir, { recursive: true, force: true }),
          ),
        );
      }
    }, 120_000);

    it("starts chrome-devtools-mcp with usage statistics turned off", async () => {
      const userDataDir = await mkdtemp(join(tmpdir(), "bb-axi-browser-"));
      const home = await mkdtemp(join(tmpdir(), "bb-axi-home-"));
      const context = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      const devToolsPort = (
        await readFile(join(userDataDir, "DevToolsActivePort"), "utf8")
      ).split("\n")[0]!;
      const proxy = await startSessionCdpProxy({
        upstreamEndpoint: async () =>
          (
            (await (
              await fetch(`http://127.0.0.1:${devToolsPort}/json/version`)
            ).json()) as { webSocketDebuggerUrl: string }
          ).webSocketDebuggerUrl,
      });
      const mcpBin = fileURLToPath(
        new URL("./fixtures/mcp-argv-recorder.mjs", import.meta.url),
      );
      const session = axiSessionName(`thread:${home}`);
      const axi = (...args: string[]) =>
        runAxiCommand(
          { ...resolveAxiRuntime(), mcpBin },
          { args, endpoint: proxy.endpoint, session, homeDirectory: home },
        );
      try {
        const opened = await axi("open", "about:blank");
        expect(opened.exitCode, opened.stderr).toBe(0);
        const argv = JSON.parse(
          await readFile(join(home, "mcp-argv.json"), "utf8"),
        ) as string[];
        expect(argv).toContain("--no-usage-statistics");
      } finally {
        await axi("stop").catch(() => undefined);
        await proxy.close();
        await context.close();
        await Promise.all(
          [userDataDir, home].map((dir) =>
            rm(dir, { recursive: true, force: true }),
          ),
        );
      }
    }, 120_000);
  },
);
