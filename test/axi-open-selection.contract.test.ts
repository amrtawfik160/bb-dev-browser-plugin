import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveAxiRuntime } from "../src/host/axi-runner.js";

const SESSION = "bb-axi-open-test";

type ToolCall = { name: string; args: Record<string, unknown> };

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/**
 * Stands in for axi's bridge to chrome-devtools-mcp. Like the real server,
 * `new_page` selects the page it created and lists it under its final URL,
 * which a redirect has moved away from the URL axi asked for.
 */
async function fakeBridge(calls: ToolCall[]) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/health")) {
      response.end(JSON.stringify({ status: "ok", session: SESSION }));
      return;
    }
    const call = JSON.parse(await readBody(request)) as ToolCall;
    calls.push(call);
    const results: Record<string, string> = {
      new_page:
        "## Pages\n1: http://127.0.0.1:5199/old-tab\n2: http://127.0.0.1:5199/dashboard [selected]\n",
      take_snapshot:
        'uid=1_0 RootWebArea "Dashboard" url="http://127.0.0.1:5199/dashboard"\n',
    };
    response.end(JSON.stringify({ result: results[call.name] ?? "" }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fake axi bridge did not bind.");
  }
  return { server, port: address.port };
}

function runAxi(axiBin: string, home: string, args: string[]) {
  return new Promise<{ exitCode: number | null; output: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [axiBin, ...args], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          CHROME_DEVTOOLS_AXI_SESSION: SESSION,
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("close", (exitCode) => resolve({ exitCode, output }));
    },
  );
}

it("selects the page axi open created when its address redirected", async () => {
  const home = await mkdtemp(join(tmpdir(), "axi-open-"));
  const calls: ToolCall[] = [];
  const bridge = await fakeBridge(calls);
  try {
    const sessionDirectory = join(
      home,
      ".chrome-devtools-axi",
      "sessions",
      SESSION,
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      join(sessionDirectory, "bridge.pid"),
      JSON.stringify({ pid: process.pid, port: bridge.port }),
    );
    const { axiBin } = resolveAxiRuntime();

    const opened = await runAxi(axiBin, home, [
      "open",
      "http://127.0.0.1:5199",
    ]);

    expect(opened.output).not.toContain("No page is currently selected");
    expect(opened.exitCode).toBe(0);
    expect(calls.map((call) => call.name)).toContain("new_page");
    expect(
      calls.find((call) => call.name === "take_snapshot")?.args.pageId,
    ).toBe(2);
    await expect(
      readFile(join(sessionDirectory, "selected-page-id"), "utf8"),
    ).resolves.toBe("2");
  } finally {
    bridge.server.close();
    await rm(home, { recursive: true, force: true });
  }
}, 20_000);
