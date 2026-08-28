import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  chown,
  cp,
  mkdir,
  readFile,
  unlink,
  watch,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserExecutionRequest,
  BrowserLaunchBoundary,
  BrowserLaunchRequest,
  BrowserProcessIdentity,
  RunningBrowserProcess,
} from "./browser-runtime.js";

const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
const MAX_BROWSER_RESULT_BYTES = 256 * 1024;
const MAX_PROCESS_ERROR_BYTES = 64 * 1024;
const HELPER_STOP_TIMEOUT_MS = 2_000;
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;

type BrowserProcessBoundaryOptions = {
  devBrowserExecutable: string;
  devBrowserPackageDirectory?: string;
  passwdPath?: string;
  setprivExecutable?: string;
};

async function stagedDevBrowserExecutable(
  options: BrowserProcessBoundaryOptions,
  runtimeDirectory: string,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  if (options.devBrowserPackageDirectory === undefined) {
    return options.devBrowserExecutable;
  }
  const stagedDirectory = join(runtimeDirectory, "dev-browser-0.2.9");
  const stagedExecutable = join(stagedDirectory, "bin", "dev-browser.js");
  try {
    await access(stagedExecutable, constants.X_OK);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
    await cp(options.devBrowserPackageDirectory, stagedDirectory, {
      recursive: true,
    });
    await chmod(stagedExecutable, 0o755);
  }
  await chown(stagedDirectory, identity.userId, identity.groupId);
  return stagedExecutable;
}

function browserUserIdentity(passwdPath: string) {
  const entry = readFileSync(passwdPath, "utf8")
    .split("\n")
    .find((line) => line.startsWith("bb-browser:"));
  const fields = entry?.split(":");
  const userId = Number(fields?.[2]);
  const groupId = Number(fields?.[3]);
  if (
    !Number.isSafeInteger(userId) ||
    userId <= 0 ||
    !Number.isSafeInteger(groupId) ||
    groupId <= 0
  ) {
    throw new Error("The unprivileged bb-browser user is not configured.");
  }
  return { userId, groupId };
}

function configuredSearchTemplate(preferences: unknown) {
  if (typeof preferences !== "object" || preferences === null) return null;
  const provider = (preferences as Record<string, unknown>)[
    "default_search_provider_data"
  ];
  if (typeof provider !== "object" || provider === null) return null;
  const templateData = (provider as Record<string, unknown>)[
    "template_url_data"
  ];
  if (typeof templateData !== "object" || templateData === null) return null;
  const url = (templateData as Record<string, unknown>).url;
  return typeof url === "string" ? url : null;
}

async function configuredSearchUrl(profileDirectory: string, text: string) {
  const preferencesPath = join(profileDirectory, "Default", "Preferences");
  const preferences = JSON.parse(
    await readFile(preferencesPath, "utf8"),
  ) as unknown;
  const template = configuredSearchTemplate(preferences);
  if (template === null || !template.includes("{searchTerms}")) {
    throw new Error("Chrome's configured search engine is unavailable.");
  }
  const searchUrl = new URL(
    template.replaceAll("{searchTerms}", encodeURIComponent(text)),
  );
  if (searchUrl.protocol !== "http:" && searchUrl.protocol !== "https:") {
    throw new Error(
      "Chrome's configured search engine returned an unsafe URL.",
    );
  }
  return searchUrl.href;
}

function ownedProcess(
  setprivExecutable: string,
  identity: ReturnType<typeof browserUserIdentity>,
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawn(
    setprivExecutable,
    [
      `--reuid=${identity.userId}`,
      `--regid=${identity.groupId}`,
      "--clear-groups",
      "--",
      command,
      ...arguments_,
    ],
    { env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
}

async function ownedDirectory(
  path: string,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  await mkdir(path, { recursive: true });
  await chown(path, identity.userId, identity.groupId);
  await chmod(path, 0o700);
}

function devToolsEndpoint(contents: string) {
  const [port, path] = contents.trim().split("\n");
  if (!/^\d+$/u.test(port ?? "") || !path?.startsWith("/devtools/browser/")) {
    throw new Error("Chrome returned an invalid Automation Mode endpoint.");
  }
  return `ws://127.0.0.1:${port}${path}`;
}

async function activeDevToolsEndpoint(profileDirectory: string) {
  try {
    return devToolsEndpoint(
      await readFile(join(profileDirectory, DEVTOOLS_PORT_FILE), "utf8"),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function waitForDevToolsEndpoint(
  profileDirectory: string,
  browserProcess: ChildProcessWithoutNullStreams,
  standardError: () => string,
) {
  const currentEndpoint = await activeDevToolsEndpoint(profileDirectory);
  if (currentEndpoint !== null) return currentEndpoint;
  const watcherAbort = new AbortController();
  const changes = watch(profileDirectory, { signal: watcherAbort.signal });
  const exited = new Promise<never>((_resolve, reject) => {
    const rejectExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(
        new Error(
          standardError().trim() ||
            `Chrome exited before Automation Mode was ready (${signal ?? code ?? "unknown"}).`,
        ),
      );
    };
    if (
      browserProcess.exitCode !== null ||
      browserProcess.signalCode !== null
    ) {
      rejectExit(browserProcess.exitCode, browserProcess.signalCode);
      return;
    }
    browserProcess.once("exit", (code, signal) => {
      rejectExit(code, signal);
    });
  });
  const discovered = (async () => {
    for await (const change of changes) {
      if (change.filename !== DEVTOOLS_PORT_FILE) continue;
      const endpoint = await activeDevToolsEndpoint(profileDirectory);
      if (endpoint !== null) return endpoint;
    }
    throw new Error("Chrome stopped exposing Automation Mode readiness.");
  })();
  try {
    return await Promise.race([discovered, exited]);
  } finally {
    watcherAbort.abort();
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

async function processIdentity(pid: number): Promise<BrowserProcessIdentity> {
  const [statContents, commandLine] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile(`/proc/${pid}/cmdline`),
  ]);
  const fields = statContents
    .slice(statContents.lastIndexOf(")") + 2)
    .split(" ");
  const startedAtTicks = fields[19];
  if (startedAtTicks === undefined || !/^\d+$/u.test(startedAtTicks)) {
    throw new Error("Browser process identity is unavailable.");
  }
  return {
    pid,
    startedAtTicks,
    commandHash: createHash("sha256").update(commandLine).digest("hex"),
  };
}

function sameProcessIdentity(
  expected: BrowserProcessIdentity,
  actual: BrowserProcessIdentity,
) {
  return (
    expected.pid === actual.pid &&
    expected.startedAtTicks === actual.startedAtTicks &&
    expected.commandHash === actual.commandHash
  );
}

function waitForProcessExit(pid: number) {
  return new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ) {
          clearInterval(poll);
          resolve();
          return;
        }
        clearInterval(poll);
        reject(error);
      }
    }, 250);
    poll.unref();
  });
}

async function stopRecoveredProcess(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }
  const limit = deadline(10_000, "Recovered browser shutdown timed out.");
  const graceful = await Promise.race([
    waitForProcessExit(pid).then(() => true),
    limit.elapsed.then(
      () => false,
      () => false,
    ),
  ]);
  limit.cancel();
  if (graceful) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return;
    throw error;
  }
  await waitForProcessExit(pid);
}

async function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let deadline: NodeJS.Timeout | undefined;
  const forcedExit = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      child.kill("SIGKILL");
      void waitForExit(child).then(resolve);
    }, 10_000);
    deadline.unref();
  });
  await Promise.race([waitForExit(child), forcedExit]);
  if (deadline !== undefined) clearTimeout(deadline);
}

function deadline(milliseconds: number, message: string) {
  let timeout: NodeJS.Timeout;
  const elapsed = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    timeout.unref();
  });
  return { elapsed, cancel: () => clearTimeout(timeout) };
}

async function boundedOutput(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number,
  message: string,
) {
  const limit = deadline(milliseconds, message);
  try {
    return await Promise.race([collectOutput(child), limit.elapsed]);
  } finally {
    limit.cancel();
  }
}

async function requestBrowserClose(endpoint: string) {
  let socket: WebSocket | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    const closeSocket = new WebSocket(endpoint);
    socket = closeSocket;
    closeSocket.addEventListener("open", () => {
      closeSocket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    closeSocket.addEventListener("close", () => resolve());
    closeSocket.addEventListener("error", () =>
      reject(new Error("Automation Mode browser close failed.")),
    );
  });
  const limit = deadline(
    BROWSER_CLOSE_TIMEOUT_MS,
    "Automation Mode browser close timed out.",
  );
  try {
    await Promise.race([closed, limit.elapsed]);
  } finally {
    limit.cancel();
    const activeSocket = socket;
    if (
      activeSocket?.readyState === WebSocket.CONNECTING ||
      activeSocket?.readyState === WebSocket.OPEN
    ) {
      activeSocket.close();
    }
  }
}

async function attemptBrowserClose(profileDirectory: string) {
  const endpoint = await activeDevToolsEndpoint(profileDirectory);
  if (endpoint === null) return;
  await requestBrowserClose(endpoint).then(
    () => undefined,
    () => undefined,
  );
}

async function helperIsRunning(helperHome: string) {
  try {
    await access(join(helperHome, ".dev-browser", "daemon.sock"));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function collectOutput(child: ChildProcessWithoutNullStreams) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BROWSER_RESULT_BYTES) {
        child.kill("SIGTERM");
        reject(new Error("Browser Result exceeds the 256 KiB limit."));
        return;
      }
      chunks.push(chunk);
    });
    let standardError = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (standardError.length < MAX_PROCESS_ERROR_BYTES) {
        standardError += chunk.slice(
          0,
          MAX_PROCESS_ERROR_BYTES - standardError.length,
        );
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString("utf8").trimEnd());
        return;
      }
      reject(
        new Error(
          standardError.trim() ||
            `dev-browser exited with ${signal ?? code ?? "unknown"}.`,
        ),
      );
    });
  });
}

type ProductionProcessContext = {
  options: BrowserProcessBoundaryOptions;
  passwdPath: string;
  setprivExecutable: string;
};

async function removeDevToolsPortFile(profileDirectory: string) {
  try {
    await unlink(join(profileDirectory, DEVTOOLS_PORT_FILE));
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
}

function browserEnvironment(request: BrowserLaunchRequest) {
  return {
    ...process.env,
    HOME: request.runtimeDirectory,
    XDG_CONFIG_HOME: request.runtimeDirectory,
    TZ: request.timezone,
  };
}

async function browserAutomationEndpoint(
  request: BrowserLaunchRequest,
  browserProcess: ChildProcessWithoutNullStreams,
) {
  let standardError = "";
  browserProcess.stderr.setEncoding("utf8");
  const captureError = (chunk: string) => {
    if (standardError.length >= MAX_PROCESS_ERROR_BYTES) return;
    standardError += chunk.slice(
      0,
      MAX_PROCESS_ERROR_BYTES - standardError.length,
    );
  };
  browserProcess.stderr.on("data", captureError);
  try {
    return await waitForDevToolsEndpoint(
      request.profileDirectory,
      browserProcess,
      () => standardError,
    );
  } finally {
    browserProcess.stderr.off("data", captureError);
    browserProcess.stderr.resume();
  }
}

async function stopAttachedHelper(
  context: ProductionProcessContext,
  request: BrowserLaunchRequest,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  const helperHome = join(request.runtimeDirectory, request.browserName);
  if (!(await helperIsRunning(helperHome))) return;
  const executable = await stagedDevBrowserExecutable(
    context.options,
    request.runtimeDirectory,
    identity,
  );
  const devBrowserProcess = ownedProcess(
    context.setprivExecutable,
    identity,
    executable,
    ["stop"],
    { ...process.env, HOME: helperHome },
  );
  devBrowserProcess.stdin.end();
  try {
    await boundedOutput(
      devBrowserProcess,
      HELPER_STOP_TIMEOUT_MS,
      "dev-browser attachment shutdown timed out.",
    );
  } finally {
    await stopProcess(devBrowserProcess);
  }
}

async function stopBrowserProcess(
  context: ProductionProcessContext,
  request: BrowserLaunchRequest,
  identity: ReturnType<typeof browserUserIdentity>,
  browserProcess: ChildProcessWithoutNullStreams,
) {
  try {
    await stopAttachedHelper(context, request, identity);
  } finally {
    await attemptBrowserClose(request.profileDirectory);
    await stopProcess(browserProcess);
  }
}

async function launchProductionBrowser(
  context: ProductionProcessContext,
  request: BrowserLaunchRequest,
  onSpawn: (identity: BrowserProcessIdentity) => Promise<void> = async () => {},
): Promise<RunningBrowserProcess> {
  const identity = browserUserIdentity(context.passwdPath);
  await ownedDirectory(request.profileDirectory, identity);
  await ownedDirectory(request.runtimeDirectory, identity);
  await removeDevToolsPortFile(request.profileDirectory);
  const executablePath = request.executablePath;
  const browserProcess = ownedProcess(
    context.setprivExecutable,
    identity,
    executablePath,
    ["--headless=new", ...request.chromeArguments],
    browserEnvironment(request),
  );
  try {
    await onSpawn(await processIdentity(browserProcess.pid!));
  } catch (error) {
    await stopProcess(browserProcess);
    throw error;
  }
  let automationEndpoint: string;
  try {
    automationEndpoint = await browserAutomationEndpoint(
      request,
      browserProcess,
    );
  } catch (error) {
    await stopProcess(browserProcess);
    throw error;
  }
  return {
    pid: browserProcess.pid!,
    automationEndpoint,
    exited: waitForExit(browserProcess),
    stop: () => stopBrowserProcess(context, request, identity, browserProcess),
  };
}

async function recoverProductionBrowser(
  context: ProductionProcessContext,
  request: BrowserLaunchRequest,
  expectedIdentity: BrowserProcessIdentity,
  storedEndpoint: string | null,
): Promise<RunningBrowserProcess | null> {
  let actualIdentity: BrowserProcessIdentity;
  try {
    actualIdentity = await processIdentity(expectedIdentity.pid);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  if (!sameProcessIdentity(expectedIdentity, actualIdentity)) return null;
  const automationEndpoint =
    storedEndpoint ?? (await activeDevToolsEndpoint(request.profileDirectory));
  if (automationEndpoint === null) return null;
  const identity = browserUserIdentity(context.passwdPath);
  return {
    pid: expectedIdentity.pid,
    automationEndpoint,
    exited: waitForProcessExit(expectedIdentity.pid),
    stop: async () => {
      try {
        await stopAttachedHelper(context, request, identity);
      } finally {
        await requestBrowserClose(automationEndpoint).then(
          () => undefined,
          () => undefined,
        );
        await stopRecoveredProcess(expectedIdentity.pid);
      }
    },
  };
}

async function executeBrowserHelper(
  context: ProductionProcessContext,
  request: BrowserExecutionRequest,
) {
  const helperHome = join(request.runtimeDirectory, request.browserName);
  const identity = browserUserIdentity(context.passwdPath);
  await ownedDirectory(helperHome, identity);
  const executable = await stagedDevBrowserExecutable(
    context.options,
    request.runtimeDirectory,
    identity,
  );
  const devBrowserProcess = ownedProcess(
    context.setprivExecutable,
    identity,
    executable,
    [
      "--browser",
      request.browserName,
      "--connect",
      request.endpoint,
      "--timeout",
      String(Math.ceil(request.timeoutMs / 1000)),
    ],
    { ...process.env, HOME: helperHome },
  );
  devBrowserProcess.stdin.end(request.code);
  return collectOutput(devBrowserProcess);
}

export function createProductionBrowserProcessBoundary(
  options: BrowserProcessBoundaryOptions,
): BrowserLaunchBoundary {
  const passwdPath = options.passwdPath ?? "/etc/passwd";
  const setprivExecutable = options.setprivExecutable ?? "/usr/bin/setpriv";
  const context = { options, passwdPath, setprivExecutable };
  return {
    runAsUser: "bb-browser",
    get effectiveUserId() {
      return browserUserIdentity(passwdPath).userId;
    },
    get effectiveGroupId() {
      return browserUserIdentity(passwdPath).groupId;
    },
    launch: (request, onSpawn) =>
      launchProductionBrowser(context, request, onSpawn),
    recover: (request, identity, endpoint) =>
      recoverProductionBrowser(context, request, identity, endpoint),
    processIdentity,
    execute: (request) => executeBrowserHelper(context, request),
    configuredSearchUrl: ({ profileDirectory, text }) =>
      configuredSearchUrl(profileDirectory, text),
  };
}
