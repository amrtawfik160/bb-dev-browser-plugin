import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  chown,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  symlink,
  unlink,
  watch,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  BrowserExecutionRequest,
  BrowserLaunchBoundary,
  BrowserLaunchRequest,
  BrowserProcessIdentity,
  RunningBrowserProcess,
} from "./browser-runtime.js";
import { BrowserScriptExecutionError } from "./browser-runtime.js";
import {
  BrowserOriginScopeDeniedError,
  installHostOriginScopeGuard,
  preferOriginScopeDenial,
  type HostOriginScopeGuard,
} from "./origin-scope.js";
import {
  BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES,
  BROWSER_SCRIPT_RESULT_LIMIT_BYTES,
  BROWSER_STORAGE_ROOT,
} from "./contracts.js";
import { DEV_BROWSER_PACKAGE_VERSION } from "./dev-browser-runtime.js";

const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
const MAX_BROWSER_RESULT_BYTES = BROWSER_SCRIPT_RESULT_LIMIT_BYTES;
const MAX_PROCESS_ERROR_BYTES = 64 * 1024;
const MAX_SCREENSHOT_BYTES = BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES;
const SCREENSHOT_READ_CHUNK_BYTES = 64 * 1024;
const HELPER_STOP_TIMEOUT_MS = 2_000;
const BROWSER_CLOSE_TIMEOUT_MS = 2_000;
const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const DEV_BROWSER_NODE_MODULES = [
  "playwright",
  "playwright-core",
  "quickjs-emscripten",
  "quickjs-emscripten-core",
] as const;

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
  const stagedDirectory = join(
    runtimeDirectory,
    `dev-browser-${DEV_BROWSER_PACKAGE_VERSION}`,
  );
  const stagedExecutable = join(stagedDirectory, "bin", "dev-browser.js");
  try {
    await access(stagedExecutable, constants.X_OK);
    await access(
      join(stagedDirectory, "node_modules", "playwright", "package.json"),
      constants.F_OK,
    );
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
    await stageDevBrowserNodeModules(
      options.devBrowserPackageDirectory,
      stagedDirectory,
    );
    await chmod(stagedExecutable, 0o755);
  }
  await chownTree(stagedDirectory, identity.userId, identity.groupId);
  return stagedExecutable;
}

async function stageDevBrowserNodeModules(
  packageDirectory: string,
  stagedDirectory: string,
) {
  const sourceRoot = dirname(packageDirectory);
  const targetRoot = join(stagedDirectory, "node_modules");
  await mkdir(targetRoot, { recursive: true });
  for (const name of DEV_BROWSER_NODE_MODULES) {
    await cp(join(sourceRoot, name), join(targetRoot, name), {
      recursive: true,
    });
  }
  await cp(join(sourceRoot, "@jitl"), join(targetRoot, "@jitl"), {
    recursive: true,
  });
}

async function chownTree(path: string, userId: number, groupId: number) {
  await chown(path, userId, groupId);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOTDIR" || error.code === "ENOENT")
    ) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    await chownTree(join(path, entry.name), userId, groupId);
  }
}

function helperRuntimeHome(runtimeDirectory: string, browserName: string) {
  const nested = join(runtimeDirectory, browserName);
  const socketPath = join(nested, ".dev-browser", "daemon.sock");
  if (Buffer.byteLength(socketPath) <= UNIX_SOCKET_PATH_MAX_BYTES) {
    return nested;
  }
  const digest = createHash("sha256")
    .update(socketPath)
    .digest("hex")
    .slice(0, 16);
  return join(BROWSER_STORAGE_ROOT, "run", digest);
}

async function seedDaemonNodeModules(
  stagedDirectory: string,
  helperHome: string,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  const daemonHome = join(helperHome, ".dev-browser");
  const target = join(daemonHome, "node_modules");
  try {
    await access(target, constants.F_OK);
    return;
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
  await mkdir(daemonHome, { recursive: true });
  await symlink(join(stagedDirectory, "node_modules"), target);
  await chownTree(daemonHome, identity.userId, identity.groupId);
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
  cwd?: string,
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
    { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] },
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

function processRunsAsBrowserUser(
  status: string,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  return (
    new RegExp(`^Uid:\\s+${identity.userId}\\s`, "mu").test(status) &&
    new RegExp(`^Gid:\\s+${identity.groupId}\\s`, "mu").test(status)
  );
}

async function discoverLaunchedBrowser(
  request: BrowserLaunchRequest,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  const profileArgument = `--user-data-dir=${request.profileDirectory}`;
  const loopbackArgument = "--remote-debugging-address=127.0.0.1";
  const processIds = (await readdir("/proc"))
    .filter((entry) => /^\d+$/u.test(entry))
    .map(Number);
  const candidates: BrowserProcessIdentity[] = [];
  for (const pid of processIds) {
    const candidate = await matchingBrowserIdentity(
      pid,
      profileArgument,
      loopbackArgument,
      identity,
    );
    if (candidate !== null) candidates.push(candidate);
  }
  if (candidates.length > 1) {
    throw new Error("Multiple orphaned browsers claim one Browser Profile.");
  }
  return candidates[0] ?? null;
}

async function matchingBrowserIdentity(
  pid: number,
  profileArgument: string,
  loopbackArgument: string,
  identity: ReturnType<typeof browserUserIdentity>,
) {
  try {
    const [commandLine, status] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
    ]);
    const arguments_ = commandLine.split("\0");
    if (
      !arguments_.includes(profileArgument) ||
      !arguments_.includes(loopbackArgument) ||
      !processRunsAsBrowserUser(status, identity)
    ) {
      return null;
    }
    return await processIdentity(pid);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function processMatchesIdentity(identity: BrowserProcessIdentity) {
  try {
    return sameProcessIdentity(identity, await processIdentity(identity.pid));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function recoveredAutomationEndpoint(
  request: BrowserLaunchRequest,
  identity: BrowserProcessIdentity,
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const endpoint = await activeDevToolsEndpoint(request.profileDirectory);
    if (endpoint !== null) return endpoint;
    if (!(await processMatchesIdentity(identity))) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/**
 * Identify the Browser Instance that currently owns a Browser Profile.
 *
 * The recorded identity is the fast path, but it goes stale whenever the host
 * worker restarts while its Chromium keeps running — a plugin reload, a daemon
 * recycle, a crashed worker. Trusting only the record left the live browser
 * orphaned, and the relaunch that followed was rejected by Chromium's profile
 * singleton, which rewrote the record with the rejected process and wedged the
 * profile for good. Scanning for the real owner when the record does not match
 * turns that dead end back into a reattach.
 */
async function recoverableBrowserIdentity(
  context: ProductionProcessContext,
  request: BrowserLaunchRequest,
  expectedIdentity: BrowserProcessIdentity | null,
) {
  if (
    expectedIdentity !== null &&
    (await processMatchesIdentity(expectedIdentity))
  ) {
    return expectedIdentity;
  }
  const browserUser = browserUserIdentity(context.passwdPath);
  return discoverLaunchedBrowser(request, browserUser);
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

const PROCESS_STOP_GRACE_MS = 10_000;
/**
 * A helper being stopped because its own deadline passed has nothing left to
 * flush, and the full grace period spent waiting for it to notice SIGTERM was
 * long enough for the surrounding host call to blow its transport deadline —
 * replacing a typed `browser_timeout` with an opaque transport error.
 */
const ABORTED_PROCESS_STOP_GRACE_MS = 1_500;

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
  graceMs = PROCESS_STOP_GRACE_MS,
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let deadline: NodeJS.Timeout | undefined;
  const forcedExit = new Promise<void>((resolve) => {
    deadline = setTimeout(() => {
      child.kill("SIGKILL");
      void waitForExit(child).then(resolve);
    }, graceMs);
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

function processAbortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Browser script aborted.");
}

function collectOutput(
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(processAbortError(signal!)));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BROWSER_RESULT_BYTES) {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new BrowserScriptExecutionError(
              "result_too_large",
              `Browser Result exceeds the ${MAX_BROWSER_RESULT_BYTES / 1024} KiB limit.`,
            ),
          ),
        );
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
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(() => resolve(Buffer.concat(chunks).toString("utf8").trimEnd()));
        return;
      }
      finish(() =>
        reject(
          new Error(
            standardError.trim() ||
              `dev-browser exited with ${signal ?? code ?? "unknown"}.`,
          ),
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

const SAFE_BROWSER_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

function restrictedEnvironment(overrides: NodeJS.ProcessEnv) {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_BROWSER_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}

function browserEnvironment(request: BrowserLaunchRequest) {
  return restrictedEnvironment({
    HOME: request.runtimeDirectory,
    XDG_CONFIG_HOME: request.runtimeDirectory,
    TZ: request.timezone,
  });
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
  const helperHome = helperRuntimeHome(
    request.runtimeDirectory,
    request.browserName,
  );
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
    restrictedEnvironment({ HOME: helperHome, XDG_CONFIG_HOME: helperHome }),
    helperHome,
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
    request.runtimeDirectory,
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
  recordedIdentity: BrowserProcessIdentity | null,
  storedEndpoint: string | null,
): Promise<RunningBrowserProcess | null> {
  const expectedIdentity = await recoverableBrowserIdentity(
    context,
    request,
    recordedIdentity,
  );
  if (expectedIdentity === null) return null;
  // A discovered owner is not the process the record described, so its
  // endpoint has to be read from the profile rather than taken on faith.
  const trustedEndpoint =
    recordedIdentity !== null &&
    sameProcessIdentity(recordedIdentity, expectedIdentity)
      ? storedEndpoint
      : null;
  const automationEndpoint =
    trustedEndpoint ??
    (await recoveredAutomationEndpoint(request, expectedIdentity));
  if (automationEndpoint === null) {
    await stopRecoveredProcess(expectedIdentity.pid);
    return null;
  }
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

async function prepareHelperRuntime(
  context: ProductionProcessContext,
  request: BrowserExecutionRequest,
) {
  const helperHome = helperRuntimeHome(
    request.runtimeDirectory,
    request.browserName,
  );
  const identity = browserUserIdentity(context.passwdPath);
  await ownedDirectory(helperHome, identity);
  const executable = await stagedDevBrowserExecutable(
    context.options,
    request.runtimeDirectory,
    identity,
  );
  if (context.options.devBrowserPackageDirectory !== undefined) {
    await seedDaemonNodeModules(
      join(
        request.runtimeDirectory,
        `dev-browser-${DEV_BROWSER_PACKAGE_VERSION}`,
      ),
      helperHome,
      identity,
    );
  }
  return { executable, helperHome, identity };
}

function spawnDevBrowserHelper(
  context: ProductionProcessContext,
  request: BrowserExecutionRequest,
  helperRuntime: Awaited<ReturnType<typeof prepareHelperRuntime>>,
) {
  return ownedProcess(
    context.setprivExecutable,
    helperRuntime.identity,
    helperRuntime.executable,
    [
      "--browser",
      request.browserName,
      "--connect",
      request.endpoint,
      "--timeout",
      String(Math.ceil(request.timeoutMs / 1000)),
    ],
    restrictedEnvironment({
      HOME: helperRuntime.helperHome,
      XDG_CONFIG_HOME: helperRuntime.helperHome,
    }),
    helperRuntime.helperHome,
  );
}

async function readScreenshotResult(
  output: string,
  screenshot: NonNullable<BrowserExecutionRequest["screenshot"]>,
  screenshotPath: string,
) {
  const screenshotFile = await open(
    screenshotPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let image: Buffer;
  try {
    const screenshotStats = await screenshotFile.stat();
    if (!screenshotStats.isFile()) {
      throw new Error("Browser Screenshot file is invalid.");
    }
    if (screenshotStats.size > MAX_SCREENSHOT_BYTES) {
      throw new BrowserScriptExecutionError(
        "result_too_large",
        `Browser Screenshot exceeds the ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MiB limit.`,
      );
    }
    image = await readBoundedScreenshot(screenshotFile);
  } finally {
    await screenshotFile.close();
  }
  return {
    output: removeScreenshotMarker(output, screenshot.marker),
    screenshots: [
      { data: image.toString("base64"), mimeType: screenshot.mimeType },
    ],
  };
}

type CollectHelperResultInput = {
  child: ChildProcessWithoutNullStreams;
  request: BrowserExecutionRequest;
  signal: AbortSignal;
  guard: HostOriginScopeGuard | null;
  screenshotPath?: string;
};

async function collectHelperResult(input: CollectHelperResultInput) {
  try {
    const output = await collectOutput(input.child, input.signal);
    const denial = preferOriginScopeDenial(input.guard, null);
    if (denial !== null) throw denial;
    if (input.request.screenshot === undefined) return output;
    if (input.screenshotPath === undefined) {
      throw new Error("Browser Screenshot path was not prepared.");
    }
    return readScreenshotResult(
      output,
      input.request.screenshot,
      input.screenshotPath,
    );
  } catch (error) {
    throw preferOriginScopeDenial(input.guard, error);
  }
}

async function removeScreenshot(path: string | undefined) {
  if (path === undefined) return;
  try {
    await unlink(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function cleanupBrowserHelper(
  child: ChildProcessWithoutNullStreams,
  aborted: boolean,
  guard: HostOriginScopeGuard | null,
  screenshotPath: string | undefined,
) {
  const cleanupErrors: unknown[] = [];
  for (const action of [
    () =>
      stopProcess(
        child,
        aborted ? ABORTED_PROCESS_STOP_GRACE_MS : PROCESS_STOP_GRACE_MS,
      ),
    () => guard?.dispose() ?? Promise.resolve(),
    () => removeScreenshot(screenshotPath),
  ]) {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Browser helper cleanup failed.");
  }
}

function preserveExecutionFailure(
  executionError: unknown,
  cleanupError: unknown,
) {
  if (executionError instanceof BrowserOriginScopeDeniedError) {
    const cause =
      executionError.cause === undefined
        ? cleanupError
        : new AggregateError(
            [executionError.cause, cleanupError],
            "Browser execution and cleanup failed.",
          );
    return new BrowserOriginScopeDeniedError(executionError.origin, {
      cause,
    });
  }
  return new AggregateError(
    [executionError, cleanupError],
    "Browser execution and cleanup failed.",
  );
}

async function executeBrowserHelper(
  context: ProductionProcessContext,
  request: BrowserExecutionRequest,
) {
  const helperRuntime = await prepareHelperRuntime(context, request);
  const screenshot = request.screenshot;
  const screenshotPath =
    screenshot === undefined
      ? undefined
      : safeScreenshotPath(helperRuntime.helperHome, screenshot.fileName);
  const devBrowserProcess = spawnDevBrowserHelper(
    context,
    request,
    helperRuntime,
  );
  const executionSignal = timedExecutionSignal(
    request.timeoutMs,
    request.signal,
  );
  let originGuard: HostOriginScopeGuard | null = null;
  let executionError: unknown;
  try {
    if (request.originPolicy !== undefined) {
      originGuard = await installHostOriginScopeGuard(
        request.endpoint,
        request.originPolicy,
      );
    }
    devBrowserProcess.stdin.end(request.code);
    return await collectHelperResult({
      child: devBrowserProcess,
      request,
      signal: executionSignal.signal,
      guard: originGuard,
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
    });
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    const aborted = executionSignal.signal.aborted;
    executionSignal.dispose();
    await cleanupBrowserHelper(
      devBrowserProcess,
      aborted,
      originGuard,
      screenshotPath,
    ).catch((error: unknown) => {
      if (executionError === undefined) throw error;
      throw preserveExecutionFailure(executionError, error);
    });
  }
}

function safeScreenshotPath(helperHome: string, fileName: string) {
  if (!/^bb-screenshot-[0-9a-f-]+\.png$/u.test(fileName)) {
    throw new Error("Browser screenshot filename is invalid.");
  }
  return join(helperHome, ".dev-browser", "tmp", fileName);
}

function removeScreenshotMarker(output: string, marker: string) {
  const markerLine = JSON.stringify({ __bbScreenshot: marker });
  return output
    .split("\n")
    .filter((line) => line !== markerLine)
    .join("\n")
    .trimEnd();
}

async function readBoundedScreenshot(screenshotFile: FileHandle) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (totalBytes <= MAX_SCREENSHOT_BYTES) {
    const chunk = Buffer.alloc(
      Math.min(
        SCREENSHOT_READ_CHUNK_BYTES,
        MAX_SCREENSHOT_BYTES + 1 - totalBytes,
      ),
    );
    const { bytesRead } = await screenshotFile.read(
      chunk,
      0,
      chunk.length,
      null,
    );
    if (bytesRead === 0) return Buffer.concat(chunks, totalBytes);
    totalBytes += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  throw new BrowserScriptExecutionError(
    "result_too_large",
    `Browser Screenshot exceeds the ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MiB limit.`,
  );
}

function timedExecutionSignal(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(signal === undefined ? undefined : signal.reason);
  const timer = setTimeout(
    () =>
      controller.abort(
        new BrowserScriptExecutionError(
          "browser_timeout",
          `Browser script timed out after ${timeoutMs}ms.`,
        ),
      ),
    timeoutMs,
  );
  timer.unref?.();
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
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
