import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AXI_COMMAND_TIMEOUT_MS } from "../shared/contracts.js";

/**
 * Agents drive the Workspace Browser with chrome-devtools-axi itself, so every
 * command, flag, output, ref, and hint is axi's own. The plugin only points
 * axi at the agent session's Session CDP Proxy and gives each session its own
 * named axi bridge.
 */
export const AXI_PACKAGE = "chrome-devtools-axi";
export const AXI_PACKAGE_VERSION = "0.1.39";
export const DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp";
export const DEVTOOLS_MCP_PACKAGE_VERSION = "1.10.1";

/** How agents run axi in BB; axi's own follow-up hints are rewritten to it. */
export const AXI_LAUNCHER = "bb plugin run browser axi";

/** Output kept per stream; axi truncates snapshots near 16k characters. */
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Commands that would change the host's axi install rather than drive the
 * browser. Everything else passes through untouched.
 */
const REFUSED_COMMANDS = new Set(["update", "setup"]);

export type AxiRuntimePaths = { axiBin: string; mcpBin: string };

/**
 * The vendored package, found under `vendor/node_modules/` beside the plugin source: next
 * to this file in development, beside `dist/` once built, or in the plugin
 * source and host data roots the host also searches for its helper.
 */
function vendoredManifest(
  packageName: string,
  startDirectories: readonly string[],
) {
  for (const start of startDirectories) {
    let directory = start;
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = join(
        directory,
        "vendor",
        "node_modules",
        packageName,
        "package.json",
      );
      if (existsSync(candidate)) return candidate;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  throw new Error(
    `The Browser plugin's bundled ${packageName} is missing; reinstall the plugin.`,
  );
}

function packageBin(
  packageName: string,
  version: string,
  bin: string,
  startDirectories: readonly string[],
): string {
  const manifestPath = vendoredManifest(packageName, startDirectories);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: unknown;
    bin?: Record<string, string> | string;
  };
  if (manifest.version !== version) {
    throw new Error(
      `The bundled ${packageName} is ${String(manifest.version)}; the Browser plugin needs ${version}.`,
    );
  }
  const relative =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (relative === undefined) {
    throw new Error(`${packageName} has no ${bin} executable.`);
  }
  return join(dirname(manifestPath), relative);
}

/**
 * The plugin's bundled axi and chrome-devtools-mcp executables
 * (`vendor/`, rebuilt by `scripts/vendor-axi.mjs`).
 */
export function resolveAxiRuntime(
  searchRoots: readonly string[] = [],
  fromFileUrl: string = import.meta.url,
): AxiRuntimePaths {
  const starts = [dirname(fileURLToPath(fromFileUrl)), ...searchRoots];
  return {
    axiBin: packageBin(AXI_PACKAGE, AXI_PACKAGE_VERSION, AXI_PACKAGE, starts),
    mcpBin: packageBin(
      DEVTOOLS_MCP_PACKAGE,
      DEVTOOLS_MCP_PACKAGE_VERSION,
      DEVTOOLS_MCP_PACKAGE,
      starts,
    ),
  };
}

/** A stable axi session name per agent session; axi derives its port from it. */
export function axiSessionName(lane: string): string {
  return `bb-${createHash("sha256").update(lane).digest("hex").slice(0, 16)}`;
}

/**
 * axi suggests its next commands as `chrome-devtools-axi …`. In BB the same
 * command runs as `bb plugin run browser axi …`, so the hints stay runnable.
 */
export function rewriteAxiHints(output: string): string {
  return output
    .replace(/npx -y chrome-devtools-axi(?=[\s`'"]|$)/gu, AXI_LAUNCHER)
    .replace(
      /(^|[\s`'"(])chrome-devtools-axi(?=[\s`'"]|$)/gmu,
      `$1${AXI_LAUNCHER}`,
    );
}

export type AxiCommandRequest = {
  args: readonly string[];
  /** The agent session's Session CDP Proxy. */
  endpoint: string;
  /** Unique per agent session; names axi's bridge, port, and state. */
  session: string;
  /** Where relative output paths resolve, as when running axi in a shell. */
  cwd?: string;
  /** axi's state directory for BB sessions, separate from any personal axi use. */
  homeDirectory: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AxiCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function usableDirectory(path: string | undefined) {
  if (path === undefined) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function refusedAxiCommand(args: readonly string[]): string | null {
  const command = args.find((arg) => !arg.startsWith("-"));
  if (command !== undefined && REFUSED_COMMANDS.has(command)) {
    return `\`${command}\` manages the axi install, which the Browser plugin pins. Drive the browser with the other commands.`;
  }
  return null;
}

/** Run one chrome-devtools-axi command for an agent session. */
export async function runAxiCommand(
  paths: AxiRuntimePaths,
  request: AxiCommandRequest,
): Promise<AxiCommandResult> {
  const refused = refusedAxiCommand(request.args);
  if (refused !== null)
    return { exitCode: 2, stdout: "", stderr: `error: ${refused}\n` };
  if (!existsSync(request.homeDirectory)) {
    mkdirSync(request.homeDirectory, { recursive: true, mode: 0o700 });
  }
  const cwd = usableDirectory(request.cwd)
    ? request.cwd!
    : request.homeDirectory;
  const child = spawn(process.execPath, [paths.axiBin, ...request.args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: request.homeDirectory,
      LANG: process.env.LANG ?? "C.UTF-8",
      CHROME_DEVTOOLS_AXI_BROWSER_URL: request.endpoint,
      CHROME_DEVTOOLS_AXI_SESSION: request.session,
      CHROME_DEVTOOLS_AXI_MCP_PATH: paths.mcpBin,
      // Agent browsing is the owner's business: no usage statistics to Google.
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (stream: NodeJS.ReadableStream) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - size));
      size += chunk.length;
    });
    return () =>
      Buffer.concat(chunks).toString("utf8") +
      (size > MAX_OUTPUT_BYTES ? "\n… output truncated\n" : "");
  };
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const timeout = setTimeout(
    () => child.kill("SIGTERM"),
    request.timeoutMs ?? AXI_COMMAND_TIMEOUT_MS,
  );
  const abort = () => child.kill("SIGTERM");
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) =>
        resolve(code ?? (signal === null ? 1 : 124)),
      );
    });
    return {
      exitCode,
      stdout: rewriteAxiHints(stdout()),
      stderr: rewriteAxiHints(stderr()),
    };
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", abort);
  }
}
