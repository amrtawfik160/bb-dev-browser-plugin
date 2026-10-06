import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  browserCommandScript,
  formatBrowserCommandResult,
  parseBrowserCommand,
  parseBrowserCommandOutput,
} from "../src/server/browser-commands.js";

const FIXTURE = `<!doctype html><title>Command fixture</title>
<h1>Orders</h1>
<label>Search <input id="q" aria-label="Search"></label>
<button onclick="document.getElementById('out').textContent = 'Searched: ' + document.getElementById('q').value">Go</button>
<p id="out">Nothing yet</p>
<a href="/second">Next page</a>`;

const SECOND = `<!doctype html><title>Second</title><h1>Second page</h1>`;

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Run one command's Browser Script the way the sandbox would, with `page` bound. */
async function runCommand(page: Page, line: string, generation: number) {
  const command = parseBrowserCommand(line);
  const sandboxPage = Object.assign(Object.create(page) as Page, {
    snapshotForAI: (options: { track?: string }) =>
      (
        page as unknown as {
          _snapshotForAI(o: unknown): Promise<{ full: string }>;
        }
      )._snapshotForAI(options),
  });
  const body = browserCommandScript(command);
  const run = new Function("page", `return (async () => {\n${body}\n})();`) as (
    page: Page,
  ) => Promise<string>;
  const output = await run(sandboxPage);
  const payload = parseBrowserCommandOutput(output);
  expect(payload, line).toBeDefined();
  return formatBrowserCommandResult(command, payload!, generation);
}

function refFor(output: string, label: string) {
  const line = output.split("\n").find((entry) => entry.includes(label));
  return /uid=(g\d+:e\d+)/.exec(line ?? "")?.[1];
}

describe("Browser Commands against real Chromium", () => {
  it("opens, reads, fills, clicks, and follows a link through snapshot refs", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(request.url === "/second" ? SECOND : FIXTURE);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no port");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const opened = await runCommand(page, `open ${origin}/`, 1);
      expect(opened).toContain('page: {title: "Command fixture"');
      const search = refFor(opened, 'textbox "Search"');
      const go = refFor(opened, 'button "Go"');
      expect(search).toMatch(/^g1:e\d+$/);
      expect(go).toMatch(/^g1:e\d+$/);

      await runCommand(page, `fill @${search} "blue shoes"`, 2);
      const clicked = await runCommand(page, `click @${go}`, 3);
      expect(clicked).toContain("Searched: blue shoes");

      const value = await runCommand(
        page,
        "eval document.getElementById('out').textContent",
        3,
      );
      expect(value).toContain('result: "Searched: blue shoes"');

      const next = refFor(clicked, 'link "Next page"');
      const followed = await runCommand(page, `click @${next}`, 4);
      expect(followed).toContain('page: {title: "Second"');
      const back = await runCommand(page, "back", 5);
      expect(back).toContain('page: {title: "Command fixture"');
    } finally {
      await browser.close();
      await closeServer(server);
    }
  }, 30_000);
});
