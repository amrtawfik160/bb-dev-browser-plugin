import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  link,
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
  projectLoopbackAddress,
  resolveBrowserAddress,
} from "./browser-navigation.js";
import type { LoopbackAddressMode } from "./browser-navigation.js";
import { isBrowserLoopbackHostname } from "./authorization.js";
import { inspectFallbackBrowser } from "./browser-fallback.js";

export type BrowserExecutable = {
  kind: "chrome-stable" | "playwright-chromium";
  executablePath: string;
};

export type BrowserRuntimeTarget = {
  hostId: string;
  profileId: string;
  projectId: string;
  tabId?: string;
  loopbackMode?: LoopbackAddressMode;
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
  exited: Promise<void>;
  stop(): Promise<void>;
};

export type BrowserProcessIdentity = {
  pid: number;
  startedAtTicks: string;
  commandHash: string;
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
  effectiveGroupId: number;
  launch(
    request: BrowserLaunchRequest,
    onSpawn?: (identity: BrowserProcessIdentity) => Promise<void>,
  ): Promise<RunningBrowserProcess>;
  recover(
    request: BrowserLaunchRequest,
    identity: BrowserProcessIdentity,
    automationEndpoint: string | null,
  ): Promise<RunningBrowserProcess | null>;
  processIdentity(pid: number): Promise<BrowserProcessIdentity>;
  execute(request: BrowserExecutionRequest): Promise<unknown>;
  configuredSearchUrl(request: {
    profileDirectory: string;
    text: string;
  }): Promise<string>;
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
  effectiveGroupId: number;
  chromeArguments: readonly string[];
}) {
  if (launch.runAsUser !== "bb-browser" || launch.effectiveUserId <= 0) {
    throw new BrowserInstanceError(
      "unsafe-launch",
      "Browser processes must run as the unprivileged bb-browser user, never root.",
    );
  }
  if (launch.effectiveGroupId <= 0) {
    throw new BrowserInstanceError(
      "unsafe-launch",
      "Browser processes must never run with the root group.",
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
    !isBrowserLoopbackHostname(url.hostname)
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
  profileDirectory: string;
  cleanup?: Promise<void>;
};

type StoredBrowserInstance = {
  schemaVersion: 1;
  phase: "starting" | "running";
  identity: BrowserProcessIdentity;
  automationEndpoint: string | null;
  publicState: BrowserInstance | null;
};

type BrowserInstanceRuntimeOptions = {
  rootDirectory: string;
  installationId: string;
  chromeStablePaths: readonly string[];
  playwrightChromiumPath?: string;
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
    "--disable-features=PasswordManagerEnabled,AutofillAddressEnabled,AutofillCreditCardEnabled,AutofillServerCommunication",
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

async function operatingProcessIdentity(processId: number) {
  try {
    const [statContents, commandLine] = await Promise.all([
      readFile(`/proc/${processId}/stat`, "utf8"),
      readFile(`/proc/${processId}/cmdline`),
    ]);
    const fields = statContents
      .slice(statContents.lastIndexOf(")") + 2)
      .split(" ");
    const startedAtTicks = fields[19];
    if (startedAtTicks === undefined || !/^\d+$/u.test(startedAtTicks)) {
      return null;
    }
    return {
      pid: processId,
      startedAtTicks,
      commandHash: createHash("sha256").update(commandLine).digest("hex"),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameIdentity(
  left: BrowserProcessIdentity,
  right: BrowserProcessIdentity,
) {
  return (
    left.pid === right.pid &&
    left.startedAtTicks === right.startedAtTicks &&
    left.commandHash === right.commandHash
  );
}

async function storedWorkerIdentity(path: string) {
  try {
    const document = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof document !== "object" || document === null) return null;
    const identity = (document as { workerIdentity?: unknown }).workerIdentity;
    if (typeof identity !== "object" || identity === null) return null;
    const candidate = identity as Partial<BrowserProcessIdentity>;
    return Number.isSafeInteger(candidate.pid) &&
      Number(candidate.pid) > 0 &&
      typeof candidate.startedAtTicks === "string" &&
      typeof candidate.commandHash === "string"
      ? (candidate as BrowserProcessIdentity)
      : null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function storedBrowserInstance(path: string) {
  try {
    const document = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof document !== "object" || document === null) return null;
    const stored = document as Partial<StoredBrowserInstance>;
    const identity = stored.identity;
    if (
      stored.schemaVersion !== 1 ||
      (stored.phase !== "starting" && stored.phase !== "running") ||
      typeof identity !== "object" ||
      identity === null ||
      !Number.isSafeInteger(identity.pid) ||
      Number(identity.pid) <= 0 ||
      typeof identity.startedAtTicks !== "string" ||
      typeof identity.commandHash !== "string" ||
      (stored.automationEndpoint !== null &&
        typeof stored.automationEndpoint !== "string")
    ) {
      return null;
    }
    return stored as StoredBrowserInstance;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function removeStaleProfileLock(path: string) {
  const workerIdentity = await storedWorkerIdentity(path);
  const currentIdentity =
    workerIdentity === null
      ? null
      : await operatingProcessIdentity(workerIdentity.pid);
  if (
    workerIdentity === null ||
    (currentIdentity !== null && sameIdentity(workerIdentity, currentIdentity))
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

async function acquireProfileLock(path: string) {
  await mkdir(dirname(path), { recursive: true });
  const workerIdentity = await operatingProcessIdentity(process.pid);
  if (workerIdentity === null) {
    throw new Error("Host worker process identity is unavailable.");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pendingPath = `${path}.pending-${process.pid}-${randomUUID()}`;
    let published = false;
    try {
      const lock = await open(pendingPath, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({ workerIdentity }));
        await lock.sync();
        await link(pendingPath, path);
        published = true;
        await unlink(pendingPath);
        return lock;
      } catch (error) {
        const cleanup = await Promise.allSettled([
          lock.close(),
          unlink(pendingPath),
          ...(published ? [unlink(path)] : []),
        ]);
        const failures = cleanup.flatMap((outcome) =>
          outcome.status === "rejected" &&
          !(
            outcome.reason instanceof Error &&
            "code" in outcome.reason &&
            outcome.reason.code === "ENOENT"
          )
            ? [outcome.reason]
            : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(
            [error, ...failures],
            "Browser Profile lock publication and cleanup failed.",
            { cause: error },
          );
        }
        throw error;
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
      await removeStaleProfileLock(path);
    }
  }
  throw new BrowserInstanceError(
    "profile-in-use",
    "Another Browser Instance already owns this Browser Profile.",
  );
}

async function releaseProfileLock(lock: FileHandle, path: string) {
  const opened = await lock.stat();
  const current = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  await lock.close();
  if (
    current === null ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino
  ) {
    return;
  }
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
  const browser = await runtimeBrowser(options, paths);
  const chromeArguments = await browserArguments(target, paths.browserDataPath);
  validateBrowserLaunchPolicy({
    runAsUser: options.launchBoundary.runAsUser,
    effectiveUserId: options.launchBoundary.effectiveUserId,
    effectiveGroupId: options.launchBoundary.effectiveGroupId,
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

async function runtimeBrowser(
  options: BrowserInstanceRuntimeOptions,
  paths: ProfileStoragePaths,
): Promise<BrowserExecutable> {
  if (options.playwrightChromiumPath !== undefined) {
    return selectBrowserExecutable({
      chromeStablePaths: options.chromeStablePaths,
      playwrightChromiumPath: options.playwrightChromiumPath,
    });
  }
  const stable = await selectFirstStable(options.chromeStablePaths);
  if (stable !== null) return stable;
  const fallback = await inspectFallbackBrowser({
    hostStoragePath: paths.hostStoragePath,
    uid: options.launchBoundary.effectiveUserId,
    gid: options.launchBoundary.effectiveGroupId,
  });
  if (fallback !== null) {
    return {
      kind: "playwright-chromium",
      executablePath: fallback.paths.executablePath,
    };
  }
  throw new BrowserInstanceError(
    "browser-unavailable",
    "Chrome Stable and the pinned Playwright Chromium are unavailable.",
  );
}

async function selectFirstStable(paths: readonly string[]) {
  for (const executablePath of paths) {
    if (await isExecutable(executablePath)) {
      return { kind: "chrome-stable" as const, executablePath };
    }
  }
  return null;
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
  manifestPath: string,
  instance: StoredBrowserInstance,
) {
  const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(instance), {
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, manifestPath);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    });
  }
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
    profileDirectory: input.paths.browserDataPath,
  };
}

function executionRequest(
  held: HeldBrowserInstance,
  profileId: string,
  code: string,
  timeoutMs: number,
): BrowserExecutionRequest {
  return {
    endpoint: held.publicState.automationEndpoint,
    browserName: `bb-${profileId}`,
    code,
    timeoutMs,
    runtimeDirectory: held.runtimeDirectory,
  };
}

function activateTargetedTab(tabId: string, code: string) {
  return `const __bbTargetPage = await browser.getPage(${JSON.stringify(tabId)});
await __bbTargetPage.bringToFront();
${code}`;
}

async function recoverOrLaunchBrowser(
  options: BrowserInstanceRuntimeOptions,
  request: BrowserLaunchRequest,
  manifestPath: string,
) {
  const stored = await storedBrowserInstance(manifestPath);
  const recovered =
    stored === null
      ? null
      : await options.launchBoundary.recover(
          request,
          stored.identity,
          stored.automationEndpoint,
        );
  if (recovered !== null) return recovered;
  return options.launchBoundary.launch(request, (identity) =>
    persistBrowserInstance(manifestPath, {
      schemaVersion: 1,
      phase: "starting",
      identity,
      automationEndpoint: null,
      publicState: null,
    }),
  );
}

async function publishRunningBrowser(
  boundary: BrowserLaunchBoundary,
  manifestPath: string,
  browserProcess: RunningBrowserProcess,
  publicState: BrowserInstance,
) {
  const identity = await boundary.processIdentity(browserProcess.pid);
  await persistBrowserInstance(manifestPath, {
    schemaVersion: 1,
    phase: "running",
    identity,
    automationEndpoint: browserProcess.automationEndpoint,
    publicState,
  });
}

async function cleanupFailedLaunch(
  lock: FileHandle,
  lockPath: string,
  browserProcess?: RunningBrowserProcess | null,
) {
  const cleanup = await Promise.allSettled([
    browserProcess?.stop(),
    releaseProfileLock(lock, lockPath),
  ]);
  return cleanup.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
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
  const launch = await launchRequest(options, target, paths);
  const lock = await acquireProfileLock(lockPath);
  let browserProcess: RunningBrowserProcess | null | undefined;
  try {
    browserProcess = await recoverOrLaunchBrowser(
      options,
      launch.request,
      paths.runtimeManifestPath,
    );
    assertLoopbackEndpoint(browserProcess.automationEndpoint);
    const publicState = browserInstanceState(
      target,
      launch.browser,
      browserProcess,
    );
    await publishRunningBrowser(
      options.launchBoundary,
      paths.runtimeManifestPath,
      browserProcess,
      publicState,
    );
    return heldBrowserInstance({
      paths,
      lockPath,
      lock,
      process: browserProcess,
      publicState,
    });
  } catch (error) {
    const cleanupFailures = await cleanupFailedLaunch(
      lock,
      lockPath,
      browserProcess,
    );
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Browser Instance launch and cleanup failed.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function createBrowserInstanceRuntime(
  options: BrowserInstanceRuntimeOptions,
) {
  const starts = new Map<string, Promise<HeldBrowserInstance>>();
  const activeTabs = new Map<string, string>();
  const cleanupFailures = new Map<string, unknown>();

  async function cleanupHeld(held: HeldBrowserInstance) {
    held.cleanup ??= (async () => {
      const cleanup = await Promise.allSettled([
        unlink(held.manifestPath).catch((error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return;
          throw error;
        }),
        releaseProfileLock(held.lock, held.lockPath),
      ]);
      const failures = cleanup.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "Browser Instance cleanup failed.");
    })();
    return held.cleanup;
  }

  function watchBrowserExit(key: string, held: HeldBrowserInstance) {
    const retire = async () => {
      starts.delete(key);
      activeTabs.delete(key);
      try {
        await cleanupHeld(held);
      } catch (error) {
        cleanupFailures.set(key, error);
      }
    };
    void held.process.exited.then(retire, retire);
  }

  async function heldInstance(target: BrowserRuntimeTarget) {
    const key = runtimeKey(target);
    const cleanupFailure = cleanupFailures.get(key);
    if (cleanupFailure !== undefined) {
      cleanupFailures.delete(key);
      throw cleanupFailure;
    }
    let start = starts.get(key);
    if (start === undefined) {
      start = launchBrowserInstance(options, target).then((held) => {
        watchBrowserExit(key, held);
        return held;
      });
      starts.set(key, start);
      void start.catch(() => starts.delete(key));
    }
    return start;
  }

  async function stopHeld(key: string, held: HeldBrowserInstance) {
    const processOutcome = await Promise.allSettled([held.process.stop()]);
    const cleanupOutcome = await Promise.allSettled([cleanupHeld(held)]);
    const outcomes = [...processOutcome, ...cleanupOutcome];
    starts.delete(key);
    activeTabs.delete(key);
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0) {
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Browser Instance shutdown failed.");
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
      const codeForTarget =
        target.tabId === undefined
          ? code
          : activateTargetedTab(target.tabId, code);
      if (target.tabId !== undefined) {
        activeTabs.set(runtimeKey(target), target.tabId);
      }
      return options.launchBoundary.execute(
        executionRequest(held, target.profileId, codeForTarget, timeoutMs),
      );
    },
    async navigate(target: BrowserRuntimeTarget, input: string) {
      const requestedAddress = resolveBrowserAddress(input);
      const held = await heldInstance(target);
      const address =
        requestedAddress.kind === "search"
          ? {
              kind: "address" as const,
              url: await options.launchBoundary.configuredSearchUrl({
                profileDirectory: held.profileDirectory,
                text: requestedAddress.text,
              }),
            }
          : {
              ...requestedAddress,
              url: projectLoopbackAddress(
                target.projectId,
                requestedAddress.url,
                target.loopbackMode,
              ),
            };
      const key = runtimeKey(target);
      const tabId = target.tabId ?? activeTabs.get(key) ?? "workspace";
      const location = await options.launchBoundary.execute(
        executionRequest(
          held,
          target.profileId,
          browserNavigationScript(address, tabId),
          30_000,
        ),
      );
      activeTabs.set(key, tabId);
      return { address, location, tabId };
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
