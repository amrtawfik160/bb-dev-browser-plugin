import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveAxiRuntime } from "../src/host/axi-runner.js";

const SESSION = "bb-axi-snapshot-test";

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

async function fakeBridge(pages: string, calls: ToolCall[]) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/health")) {
      response.end(JSON.stringify({ status: "ok", session: SESSION }));
      return;
    }
    const call = JSON.parse(await readBody(request)) as ToolCall;
    calls.push(call);
    const results: Record<string, string> = {
      list_pages: pages,
      take_snapshot:
        'uid=1_0 RootWebArea "Only page" url="https://example.com/"\n',
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
  return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
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
  });
}

async function withSession(
  pages: string,
  run: (home: string, calls: ToolCall[]) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "axi-snapshot-"));
  const calls: ToolCall[] = [];
  const bridge = await fakeBridge(pages, calls);
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
    await run(home, calls);
  } finally {
    bridge.server.close();
    await rm(home, { recursive: true, force: true });
  }
}

it("selects the only open page when snapshot has no selection", async () => {
  await withSession(
    "## Pages\n1: https://example.com/\n",
    async (home, calls) => {
      const { axiBin } = resolveAxiRuntime();
      const snapped = await runAxi(axiBin, home, ["snapshot"]);
      expect(snapped.output).not.toContain("No page is currently selected");
      expect(snapped.exitCode).toBe(0);
      expect(
        calls.find((call) => call.name === "take_snapshot")?.args.pageId,
      ).toBe(1);
      const sessionDirectory = join(
        home,
        ".chrome-devtools-axi",
        "sessions",
        SESSION,
      );
      await expect(
        readFile(join(sessionDirectory, "selected-page-id"), "utf8"),
      ).resolves.toBe("1");
    },
  );
}, 20_000);

it("still asks for a selection when snapshot sees more than one page", async () => {
  await withSession(
    "## Pages\n1: https://example.com/a\n2: https://example.com/b\n",
    async (home, calls) => {
      const { axiBin } = resolveAxiRuntime();
      const snapped = await runAxi(axiBin, home, ["snapshot"]);
      expect(snapped.output).toContain("No page is currently selected");
      expect(snapped.exitCode).not.toBe(0);
      expect(calls.some((call) => call.name === "take_snapshot")).toBe(false);
    },
  );
}, 20_000);
