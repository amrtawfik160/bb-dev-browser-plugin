import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { join } from "node:path";
import { profileStoragePaths } from "./profile-storage.js";
import type { ProfileStoragePaths } from "./profile-storage.js";
import {
  browserNavigationScript,
  resolveBrowserAddress,
} from "./browser-navigation.js";

export type BrowserExecutable = {
  kind: "chrome-stable" | "playwright-chromium";
  executablePath: string;
};

export type BrowserRuntimeTarget = {
  hostId: string;
  profileId: string;
  locale: string;
  timezone: string;
};

export type BrowserLaunchRequest = BrowserExecutable & {
  browserName: string;
  profileDirectory: string;
  runtimeDirectory: string;
  locale: string;
  timezone: string;
  chromeArguments: readonly string[];
};

export type RunningBrowserProcess = {
  pid: number;
  automationEndpoint: string;
  stop(): Promise<void>;
};

export type BrowserExecutionRequest = {
  endpoint: string;
  browserName: string;
  code: string;
  timeoutMs: number;
  runtimeDirectory: string;
};

export interface BrowserLaunchBoundary {
  runAsUser: string;
  effectiveUserId: number;
  launch(request: BrowserLaunchRequest): Promise<RunningBrowserProcess>;
  execute(request: BrowserExecutionRequest): Promise<unknown>;
}

export type BrowserInstance = {
  state: "running";
  hostId: string;
  profileId: string;
  pid: number;
  browser: BrowserExecutable["kind"];
  automationEndpoint: string;
};

export class BrowserInstanceError extends Error {
  constructor(
    public readonly code:
      | "browser-unavailable"
      | "endpoint-not-loopback"
      | "profile-in-use"
      | "unsafe-launch",
    message: string,
  ) {
    super(message);
    this.name = "BrowserInstanceError";
  }
}

export function validateBrowserLaunchPolicy(launch: {
  runAsUser: string;
  effectiveUserId: number;
  chromeArguments: readonly string[];
}) {
  if (launch.runAsUser !== "bb-browser" || launch.effectiveUserId === 0) {
    throw new BrowserInstanceError(
      "unsafe-launch",
      "Browser processes must run as the unprivileged bb-browser user, never root.",
    );
  }
  if (launch.chromeArguments.includes("--no-sandbox")) {
    throw new BrowserInstanceError(
      "unsafe-launch",
      "Browser sandboxing is required; --no-sandbox is forbidden.",
    );
  }
}

export async function selectBrowserExecutable(options: {
  chromeStablePaths: readonly string[];
  playwrightChromiumPath: string;
}): Promise<BrowserExecutable> {
  for (const executablePath of options.chromeStablePaths) {
    if (await isExecutable(executablePath)) {
      return { kind: "chrome-stable", executablePath };
    }
  }
  if (await isExecutable(options.playwrightChromiumPath)) {
    return {
      kind: "playwright-chromium",
      executablePath: options.playwrightChromiumPath,
    };
  }
  throw new BrowserInstanceError(
    "browser-unavailable",
    "Chrome Stable and the pinned Playwright Chromium are unavailable.",
  );
}

async function isExecutable(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EACCES")
    ) {
      return false;
    }
    throw error;
  }
}

function assertLoopbackEndpoint(endpoint: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new BrowserInstanceError(
        "endpoint-not-loopback",
        "Automation Mode returned an invalid CDP endpoint.",
      );
    }
    throw error;
  }
  if (
    !["http:", "ws:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new BrowserInstanceError(
      "endpoint-not-loopback",
      "Automation Mode must bind its CDP endpoint to loopback only.",
    );
  }
}

type HeldBrowserInstance = {
  publicState: BrowserInstance;
  process: RunningBrowserProcess;
  lock: FileHandle;
  lockPath: string;
  manifestPath: string;
  runtimeDirectory: string;
};

type BrowserInstanceRuntimeOptions = {
  rootDirectory: string;
  installationId: string;
  chromeStablePaths: readonly string[];
  playwrightChromiumPath: string;
  launchBoundary: BrowserLaunchBoundary;
};

function runtimeKey(
  target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">,
) {
  return `${target.hostId}\0${target.profileId}`;
}

async function browserArguments(
  target: BrowserRuntimeTarget,
  profileDirectory: string,
) {
  const arguments_ = [
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-notifications",
    "--disable-save-password-bubble",
    "--password-store=basic",
    "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication",
    `--lang=${target.locale}`,
    "--restore-last-session",
  ];
  if (!(await fileExists(join(profileDirectory, "Local State")))) {
    arguments_.push("about:blank");
  }
  return arguments_;
}

async function fileExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function processIsAlive(processId: number) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function storedProcessId(path: string, field: string) {
  try {
    const document = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof document !== "object" || document === null) return null;
    const processId = (document as Record<string, unknown>)[field];
    return Number.isSafeInteger(processId) && Number(processId) > 0
      ? Number(processId)
      : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function removeStaleProfileLock(path: string, manifestPath: string) {
  const workerPid = await storedProcessId(path, "workerPid");
  const browserPid = await storedProcessId(manifestPath, "pid");
  if (
    workerPid === null ||
    processIsAlive(workerPid) ||
    (browserPid !== null && processIsAlive(browserPid))
  ) {
    throw new BrowserInstanceError(
      "profile-in-use",
      "Another Browser Instance already owns this Browser Profile.",
    );
  }
  const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, stalePath);
    await unlink(stalePath);
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

async function acquireProfileLock(path: string, manifestPath: string) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(path, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ workerPid: process.pid }));
      return lock;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
      await removeStaleProfileLock(path, manifestPath);
    }
  }
  throw new BrowserInstanceError(
    "profile-in-use",
    "Another Browser Instance already owns this Browser Profile.",
  );
}

async function releaseProfileLock(lock: FileHandle, path: string) {
  await lock.close();
  try {
    await unlink(path);
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

async function launchRequest(
  options: BrowserInstanceRuntimeOptions,
  target: BrowserRuntimeTarget,
  paths: ProfileStoragePaths,
) {
  const browser = await selectBrowserExecutable(options);
  const chromeArguments = await browserArguments(target, paths.browserDataPath);
  validateBrowserLaunchPolicy({
    runAsUser: options.launchBoundary.runAsUser,
    effectiveUserId: options.launchBoundary.effectiveUserId,
    chromeArguments,
  });
  return {
    browser,
    request: {
      ...browser,
      browserName: `bb-${target.profileId}`,
      profileDirectory: paths.browserDataPath,
      runtimeDirectory: paths.runtimeManifestsDirectory,
      locale: target.locale,
      timezone: target.timezone,
      chromeArguments,
    },
  };
}

function browserInstanceState(
  target: BrowserRuntimeTarget,
  browser: BrowserExecutable,
  browserProcess: RunningBrowserProcess,
): BrowserInstance {
  return {
    state: "running",
    hostId: target.hostId,
    profileId: target.profileId,
    pid: browserProcess.pid,
    browser: browser.kind,
    automationEndpoint: browserProcess.automationEndpoint,
  };
}

async function persistBrowserInstance(
  paths: ProfileStoragePaths,
  publicState: BrowserInstance,
) {
  await writeFile(paths.runtimeManifestPath, JSON.stringify(publicState), {
    mode: 0o600,
  });
}

function heldBrowserInstance(input: {
  paths: ProfileStoragePaths;
  lockPath: string;
  lock: FileHandle;
  process: RunningBrowserProcess;
  publicState: BrowserInstance;
}): HeldBrowserInstance {
  return {
    publicState: input.publicState,
    process: input.process,
    lock: input.lock,
    lockPath: input.lockPath,
    manifestPath: input.paths.runtimeManifestPath,
    runtimeDirectory: input.paths.runtimeManifestsDirectory,
  };
}

async function launchBrowserInstance(
  options: BrowserInstanceRuntimeOptions,
  target: BrowserRuntimeTarget,
) {
  const paths = profileStoragePaths({
    rootDirectory: options.rootDirectory,
    installationId: options.installationId,
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const lockPath = `${paths.runtimeManifestPath}.instance.lock`;
  const lock = await acquireProfileLock(lockPath, paths.runtimeManifestPath);
  let browserProcess: RunningBrowserProcess | undefined;
  try {
    const launch = await launchRequest(options, target, paths);
    browserProcess = await options.launchBoundary.launch(launch.request);
    assertLoopbackEndpoint(browserProcess.automationEndpoint);
    const publicState = browserInstanceState(
      target,
      launch.browser,
      browserProcess,
    );
    await persistBrowserInstance(paths, publicState);
    return heldBrowserInstance({
      paths,
      lockPath,
      lock,
      process: browserProcess,
      publicState,
    });
  } catch (error) {
    await browserProcess?.stop();
    await releaseProfileLock(lock, lockPath);
    throw error;
  }
}

export function createBrowserInstanceRuntime(
  options: BrowserInstanceRuntimeOptions,
) {
  const starts = new Map<string, Promise<HeldBrowserInstance>>();

  async function heldInstance(target: BrowserRuntimeTarget) {
    const key = runtimeKey(target);
    let start = starts.get(key);
    if (start === undefined) {
      start = launchBrowserInstance(options, target);
      starts.set(key, start);
      void start.catch(() => starts.delete(key));
    }
    return start;
  }

  async function stopHeld(key: string, held: HeldBrowserInstance) {
    try {
      await held.process.stop();
    } finally {
      await unlink(held.manifestPath).catch((error: unknown) => {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
      });
      await releaseProfileLock(held.lock, held.lockPath);
      starts.delete(key);
    }
  }

  return {
    async start(target: BrowserRuntimeTarget) {
      return (await heldInstance(target)).publicState;
    },
    async stop(target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">) {
      const key = runtimeKey(target);
      const start = starts.get(key);
      if (start === undefined) return;
      await stopHeld(key, await start);
    },
    async execute(
      target: BrowserRuntimeTarget,
      code: string,
      timeoutMs: number,
    ) {
      const held = await heldInstance(target);
      return options.launchBoundary.execute({
        endpoint: held.publicState.automationEndpoint,
        browserName: `bb-${target.profileId}`,
        code,
        timeoutMs,
        runtimeDirectory: held.runtimeDirectory,
      });
    },
    async navigate(target: BrowserRuntimeTarget, input: string) {
      const address = resolveBrowserAddress(input);
      const held = await heldInstance(target);
      const location = await options.launchBoundary.execute({
        endpoint: held.publicState.automationEndpoint,
        browserName: `bb-${target.profileId}`,
        code: browserNavigationScript(address),
        timeoutMs: 30_000,
        runtimeDirectory: held.runtimeDirectory,
      });
      return { address, location };
    },
    async dispose() {
      const instances = await Promise.allSettled(starts.values());
      await Promise.all(
        instances.flatMap((instance) =>
          instance.status === "fulfilled"
            ? [stopHeld(runtimeKey(instance.value.publicState), instance.value)]
            : [],
        ),
      );
    },
  };
}

export type BrowserInstanceRuntime = ReturnType<
  typeof createBrowserInstanceRuntime
>;
