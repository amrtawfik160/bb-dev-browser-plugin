import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  chown,
  cp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  watch,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  BrowserExecutionRequest,
  BrowserLaunchBoundary,
  BrowserLaunchRequest,
  RunningBrowserProcess,
} from "./browser-runtime.js";

const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
const MAX_BROWSER_RESULT_BYTES = 256 * 1024;
const MAX_PROCESS_ERROR_BYTES = 64 * 1024;

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

async function stagedBrowserExecutable(request: BrowserLaunchRequest) {
  if (request.kind === "chrome-stable") return request.executablePath;
  const stagedDirectory = join(
    request.runtimeDirectory,
    "playwright-chromium-1208",
  );
  const stagedExecutable = join(stagedDirectory, "chrome");
  try {
    await access(stagedExecutable, constants.X_OK);
    return stagedExecutable;
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }
  const lockPath = `${stagedDirectory}.installing`;
  const stagingDirectory = `${stagedDirectory}.staging-${randomUUID()}`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Pinned Chromium fallback installation is in progress.", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await cp(dirname(request.executablePath), stagingDirectory, {
      recursive: true,
    });
    await rename(stagingDirectory, stagedDirectory);
    return stagedExecutable;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await lock.close();
    await unlink(lockPath);
  }
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
    groupId < 0
  ) {
    throw new Error("The unprivileged bb-browser user is not configured.");
  }
  return { userId, groupId };
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
  await collectOutput(devBrowserProcess);
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
    await stopProcess(browserProcess);
  }
}

async function launchProductionBrowser(
  context: ProductionProcessContext,
  request: BrowserLaunchRequest,
): Promise<RunningBrowserProcess> {
  const identity = browserUserIdentity(context.passwdPath);
  await ownedDirectory(request.profileDirectory, identity);
  await ownedDirectory(request.runtimeDirectory, identity);
  await removeDevToolsPortFile(request.profileDirectory);
  const executablePath = await stagedBrowserExecutable(request);
  const browserProcess = ownedProcess(
    context.setprivExecutable,
    identity,
    executablePath,
    ["--headless=new", ...request.chromeArguments],
    browserEnvironment(request),
  );
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
    stop: () => stopBrowserProcess(context, request, identity, browserProcess),
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
    launch: (request) => launchProductionBrowser(context, request),
    execute: (request) => executeBrowserHelper(context, request),
  };
}
