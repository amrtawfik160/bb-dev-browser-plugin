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
  activeBrowserTabScript,
  browserNavigationScript,
  projectLoopbackAddress,
  resolveBrowserAddress,
} from "./browser-navigation.js";
import type { LoopbackAddressMode } from "./browser-navigation.js";
import { isBrowserLoopbackHostname } from "./authorization.js";
import { inspectFallbackBrowser } from "./browser-fallback.js";
import {
  BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES,
  BROWSER_SCRIPT_MAX_SCREENSHOT_BASE64_LENGTH,
  BROWSER_SCRIPT_MAX_SCREENSHOTS,
  BROWSER_SCRIPT_RESULT_LIMIT_BYTES,
  browserScriptResultSchema,
  type BrowserScriptResult,
  type BrowserScriptRuntimeError,
} from "./contracts.js";

export type BrowserExecutable = {
  kind: "chrome-stable" | "playwright-chromium";
  executablePath: string;
};

export type BrowserInstanceTarget = {
  hostId: string;
  profileId: string;
  locale: string;
  timezone: string;
};

export type BrowserRuntimeTarget = BrowserInstanceTarget & {
  projectId: string;
  tabId?: string;
  loopbackMode?: LoopbackAddressMode;
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
  signal?: AbortSignal;
  screenshot?: {
    fileName: string;
    marker: string;
    mimeType: "image/png";
  };
};

export type BrowserOperationOptions = {
  signal?: AbortSignal;
  leaseSignal?: AbortSignal;
  screenshot?: boolean;
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
    identity: BrowserProcessIdentity | null,
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

export type BrowserRepairDiagnostics = {
  crashCount: number;
  windowMs: number;
};

export class BrowserInstanceError extends Error {
  constructor(
    public readonly code:
      | "browser-unavailable"
      | "awake-limit"
      | "endpoint-not-loopback"
      | "host-offline"
      | "profile-in-use"
      | "repair-required"
      | "unsafe-launch",
    message: string,
    public readonly diagnostics?: BrowserRepairDiagnostics,
  ) {
    super(message);
    this.name = "BrowserInstanceError";
  }
}

/**
 * A typed failure from Browser script execution that owns one of the public
 * {@link BrowserScriptRuntimeError} codes. Source modules (the Browser
 * process boundary, this runtime, and the Control Lease manager) throw this so
 * the host entry classifies from the typed `code` instead of sniffing message
 * substrings produced by other modules.
 */
export class BrowserScriptExecutionError extends Error {
  constructor(
    public readonly code: BrowserScriptRuntimeError["code"],
    message: string,
  ) {
    super(message);
    this.name = "BrowserScriptExecutionError";
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
  target: BrowserInstanceTarget;
  publicState: BrowserInstance;
  process: RunningBrowserProcess;
  lock: FileHandle;
  lockPath: string;
  manifestPath: string;
  runtimeDirectory: string;
  profileDirectory: string;
  crashHistoryPath: string;
  stopRequested: boolean;
  panelIds: Set<string>;
  activeLeases: number;
  lastActivityAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  cleanup?: Promise<void>;
};

type BrowserCrashHistory = {
  schemaVersion: 1;
  crashes: number[];
};

const CRASH_WINDOW_MS = 5 * 60 * 1_000;
const CRASH_LIMIT = 3;
export const DEFAULT_IDLE_SLEEP_MS = 30 * 60 * 1_000;
export const DEFAULT_AWAKE_INSTANCE_LIMIT = 3;

type StoredBrowserInstance =
  | {
      schemaVersion: 1;
      phase: "launching";
      identity: null;
      automationEndpoint: null;
      publicState: null;
    }
  | {
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
  idleSleepMs?: number;
  awakeInstanceLimit?: number;
};

function runtimeKey(
  target: Pick<BrowserInstanceTarget, "hostId" | "profileId">,
) {
  return `${target.hostId}\0${target.profileId}`;
}

async function browserArguments(
  target: BrowserInstanceTarget,
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
    if (typeof document !== "object" || document === null) {
      throw invalidRuntimeManifest();
    }
    const stored = document as Partial<StoredBrowserInstance>;
    const identity = stored.identity;
    if (
      stored.schemaVersion !== 1 ||
      !["launching", "starting", "running"].includes(stored.phase ?? "") ||
      (stored.automationEndpoint !== null &&
        typeof stored.automationEndpoint !== "string")
    ) {
      throw invalidRuntimeManifest();
    }
    if (stored.phase === "launching") {
      if (
        identity === null &&
        stored.automationEndpoint === null &&
        stored.publicState === null
      ) {
        return stored as StoredBrowserInstance;
      }
      throw invalidRuntimeManifest();
    }
    if (
      typeof identity !== "object" ||
      identity === null ||
      !Number.isSafeInteger(identity.pid) ||
      Number(identity.pid) <= 0 ||
      typeof identity.startedAtTicks !== "string" ||
      typeof identity.commandHash !== "string"
    ) {
      throw invalidRuntimeManifest();
    }
    return stored as StoredBrowserInstance;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    if (error instanceof SyntaxError) throw invalidRuntimeManifest();
    throw error;
  }
}

function invalidRuntimeManifest() {
  return new BrowserInstanceError(
    "repair-required",
    "Browser runtime metadata is corrupt; repair this Browser Profile before relaunch.",
  );
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
  target: BrowserInstanceTarget,
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
  target: BrowserInstanceTarget,
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
  await persistRuntimeDocument(manifestPath, instance);
}

async function persistRuntimeDocument(path: string, document: unknown) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(document), {
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, path);
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

function invalidCrashHistory() {
  return new BrowserInstanceError(
    "repair-required",
    "Browser crash diagnostics are corrupt; repair this Browser Profile.",
  );
}

function isBrowserCrashHistory(input: unknown): input is BrowserCrashHistory {
  if (typeof input !== "object" || input === null) return false;
  const candidate = input as Partial<BrowserCrashHistory>;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.crashes) &&
    candidate.crashes.every(
      (timestamp) => Number.isSafeInteger(timestamp) && timestamp >= 0,
    )
  );
}

async function browserCrashHistory(path: string): Promise<BrowserCrashHistory> {
  try {
    const parsedHistory = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isBrowserCrashHistory(parsedHistory)) throw invalidCrashHistory();
    return parsedHistory;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { schemaVersion: 1, crashes: [] };
    }
    if (error instanceof SyntaxError) throw invalidCrashHistory();
    throw error;
  }
}

function recentCrashTimestamps(history: BrowserCrashHistory, now: number) {
  return history.crashes.filter(
    (timestamp) => timestamp >= now - CRASH_WINDOW_MS,
  );
}

async function assertCrashPolicy(path: string) {
  const recentCrashes = recentCrashTimestamps(
    await browserCrashHistory(path),
    Date.now(),
  );
  if (recentCrashes.length < CRASH_LIMIT) return;
  throw new BrowserInstanceError(
    "repair-required",
    "Three Browser crashes occurred within five minutes; repair is required before relaunch.",
    {
      crashCount: recentCrashes.length,
      windowMs: CRASH_WINDOW_MS,
    },
  );
}

async function recordBrowserCrash(path: string) {
  const now = Date.now();
  const history = await browserCrashHistory(path);
  await persistRuntimeDocument(path, {
    schemaVersion: 1,
    crashes: [...recentCrashTimestamps(history, now), now],
  } satisfies BrowserCrashHistory);
}

function heldBrowserInstance(input: {
  target: BrowserInstanceTarget;
  paths: ProfileStoragePaths;
  lockPath: string;
  lock: FileHandle;
  process: RunningBrowserProcess;
  publicState: BrowserInstance;
}): HeldBrowserInstance {
  return {
    target: input.target,
    publicState: input.publicState,
    process: input.process,
    lock: input.lock,
    lockPath: input.lockPath,
    manifestPath: input.paths.runtimeManifestPath,
    runtimeDirectory: input.paths.runtimeManifestsDirectory,
    profileDirectory: input.paths.browserDataPath,
    crashHistoryPath: `${input.paths.runtimeManifestPath}.crashes.json`,
    stopRequested: false,
    panelIds: new Set(),
    activeLeases: 0,
    lastActivityAt: Date.now(),
  };
}

function executionRequest(
  held: HeldBrowserInstance,
  profileId: string,
  code: string,
  timeoutMs: number,
  signal?: AbortSignal,
  screenshot?: BrowserExecutionRequest["screenshot"],
): BrowserExecutionRequest {
  return {
    endpoint: held.publicState.automationEndpoint,
    browserName: `bb-${profileId}`,
    code,
    timeoutMs,
    runtimeDirectory: held.runtimeDirectory,
    ...(signal === undefined ? {} : { signal }),
    ...(screenshot === undefined ? {} : { screenshot }),
  };
}

const TAB_INVALID_MESSAGE =
  "Browser Tab is invalid or belongs to a previous runtime";

/**
 * Classifies a worker-execution error from a typed signal this runtime owns.
 * Typed {@link BrowserScriptExecutionError} instances (timeout, result bounds)
 * pass straight through. The tab-validity preamble is generated by this module,
 * so recognizing its own message and lifting it to a typed `tab_invalid` error
 * is classification from the owning source, not message sniffing of another
 * module. Unrecognized worker errors are left untouched so the host reports
 * them as `script_failed`.
 */
function classifyExecutionError(error: unknown): unknown {
  if (error instanceof BrowserScriptExecutionError) return error;
  if (error instanceof Error && error.message.includes(TAB_INVALID_MESSAGE)) {
    return new BrowserScriptExecutionError("tab_invalid", error.message);
  }
  return error;
}

function targetedTabPreamble(tabId: string) {
  return `const __bbTargetPages = await browser.listPages();
if (!__bbTargetPages.some((entry) => entry.id === ${JSON.stringify(tabId)})) throw new Error(${JSON.stringify(
    TAB_INVALID_MESSAGE,
  )});
const __bbTargetPage = await browser.getPage(${JSON.stringify(tabId)});
await __bbTargetPage.bringToFront();`;
}

function activateTargetedTab(tabId: string, code: string) {
  return `${targetedTabPreamble(tabId)}
${code}`;
}

function appendNativeScreenshot(
  code: string,
  tabId: string | undefined,
  screenshot: NonNullable<BrowserExecutionRequest["screenshot"]>,
) {
  const suffix = screenshot.marker.replace(/[^A-Za-z0-9]/gu, "");
  const pageVariable = `__bbScreenshotPage${suffix}`;
  const entryVariable = `__bbScreenshotEntry${suffix}`;
  const pagesVariable = `__bbScreenshotPages${suffix}`;
  const markerLine = JSON.stringify({ __bbScreenshot: screenshot.marker });
  const pageSelection =
    tabId === undefined
      ? `const ${pagesVariable} = await browser.listPages();
if (${pagesVariable}.length === 0) throw new Error("The Browser Profile has no open tabs");
let ${pageVariable} = await browser.getPage(${pagesVariable}[0].id);
for (const ${entryVariable} of ${pagesVariable}) {
  const candidate = await browser.getPage(${entryVariable}.id);
  if (await candidate.evaluate(() => document.visibilityState === "visible")) {
    ${pageVariable} = candidate;
    break;
  }
}`
      : `const ${pageVariable} = __bbTargetPage;`;
  return `try {
${code}
} finally {
${pageSelection}
await saveScreenshot(await ${pageVariable}.screenshot({ type: "png" }), ${JSON.stringify(screenshot.fileName)});
console.log(${JSON.stringify(markerLine)});
}`;
}

function linkedOperationSignal(options: BrowserOperationOptions) {
  const signals = [options.signal, options.leaseSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0) return { signal: undefined, dispose: () => {} };
  if (signals.length === 1) {
    return { signal: signals[0], dispose: () => {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    },
  };
}

function activeTabId(activeTabOutput: unknown) {
  if (typeof activeTabOutput !== "string") {
    throw new Error("Automation Mode returned an invalid active Browser Tab.");
  }
  const active = JSON.parse(activeTabOutput) as unknown;
  if (
    typeof active !== "object" ||
    active === null ||
    !("id" in active) ||
    typeof active.id !== "string" ||
    active.id === ""
  ) {
    throw new Error("Automation Mode returned an invalid active Browser Tab.");
  }
  return active.id;
}

function screenshotLimitError() {
  return new BrowserScriptExecutionError(
    "result_too_large",
    `Browser Screenshot exceeds ${BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES / 1024 / 1024} MiB limit.`,
  );
}

function assertScreenshotWithinBounds(screenshot: { data: string }) {
  if (screenshot.data.length > BROWSER_SCRIPT_MAX_SCREENSHOT_BASE64_LENGTH) {
    throw screenshotLimitError();
  }
  if (
    Buffer.from(screenshot.data, "base64").length >
    BROWSER_SCRIPT_MAX_SCREENSHOT_BYTES
  ) {
    throw screenshotLimitError();
  }
}

function assertStructuredBrowserResultWithinBounds(
  structured: BrowserScriptResult,
) {
  const outputBytes = Buffer.byteLength(structured.output, "utf8");
  if (outputBytes > BROWSER_SCRIPT_RESULT_LIMIT_BYTES) {
    throw browserResultLimitError();
  }
  for (const screenshot of structured.screenshots) {
    assertScreenshotWithinBounds(screenshot);
  }
}

function browserResultLimitError() {
  return new BrowserScriptExecutionError(
    "result_too_large",
    `Browser Result exceeds ${BROWSER_SCRIPT_RESULT_LIMIT_BYTES / 1024} KiB limit.`,
  );
}

function assertSerializedBrowserResultWithinBounds(browserResult: unknown) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(browserResult);
  } catch {
    throw new Error("Browser Result is not JSON-serializable.");
  }
  if (serialized === undefined) {
    throw new Error("Browser Result is not JSON-serializable.");
  }
  const resultBytes =
    typeof browserResult === "string"
      ? Buffer.byteLength(browserResult, "utf8")
      : Buffer.byteLength(serialized, "utf8");
  if (resultBytes > BROWSER_SCRIPT_RESULT_LIMIT_BYTES) {
    throw browserResultLimitError();
  }
}

export function assertBrowserScriptResultWithinBounds(browserResult: unknown) {
  const structured = browserScriptResultSchema.safeParse(browserResult);
  const hasScreenshotEnvelope =
    typeof browserResult === "object" &&
    browserResult !== null &&
    "screenshots" in browserResult;
  if (hasScreenshotEnvelope && !structured.success) {
    const screenshots = (browserResult as { screenshots?: unknown })
      .screenshots;
    if (
      Array.isArray(screenshots) &&
      screenshots.length > BROWSER_SCRIPT_MAX_SCREENSHOTS
    ) {
      throw new BrowserScriptExecutionError(
        "result_too_large",
        `Browser Screenshot exceeds the ${BROWSER_SCRIPT_MAX_SCREENSHOTS}-image limit.`,
      );
    }
    if (
      Array.isArray(screenshots) &&
      screenshots.some(
        (screenshot) =>
          typeof screenshot === "object" &&
          screenshot !== null &&
          "data" in screenshot &&
          typeof screenshot.data === "string" &&
          screenshot.data.length > BROWSER_SCRIPT_MAX_SCREENSHOT_BASE64_LENGTH,
      )
    ) {
      throw screenshotLimitError();
    }
    throw new Error("Browser Screenshot output is invalid.");
  }
  if (structured.success) {
    assertStructuredBrowserResultWithinBounds(structured.data);
    return browserResult;
  }
  assertSerializedBrowserResultWithinBounds(browserResult);
  return browserResult;
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
  await persistBrowserInstance(manifestPath, {
    schemaVersion: 1,
    phase: "launching",
    identity: null,
    automationEndpoint: null,
    publicState: null,
  });
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
  target: BrowserInstanceTarget,
) {
  const paths = profileStoragePaths({
    rootDirectory: options.rootDirectory,
    installationId: options.installationId,
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const lockPath = `${paths.runtimeManifestPath}.instance.lock`;
  await assertCrashPolicy(`${paths.runtimeManifestPath}.crashes.json`);
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
      target,
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
  const visiblePanelPins = new Map<string, Set<string>>();
  const cleanupFailures = new Map<string, unknown>();
  const retirements = new Map<string, Promise<void>>();
  const lifecycleStates = new Map<
    string,
    "sleeping" | "waking" | "running" | "repair-required"
  >();
  const disconnectedHosts = new Set<string>();
  let capacityChanges = Promise.resolve();
  let disposed = false;

  function assertHostConnected(hostId: string) {
    if (!disconnectedHosts.has(hostId)) return;
    throw new BrowserInstanceError(
      "host-offline",
      "The workspace host disconnected; Browser work is frozen until it reconnects.",
    );
  }

  function cancelIdleSleep(held: HeldBrowserInstance) {
    if (held.idleTimer !== undefined) clearTimeout(held.idleTimer);
    held.idleTimer = undefined;
  }

  function isPinned(held: HeldBrowserInstance) {
    return held.panelIds.size > 0 || held.activeLeases > 0;
  }

  function scheduleIdleSleep(key: string, held: HeldBrowserInstance) {
    cancelIdleSleep(held);
    if (isPinned(held)) return;
    const remaining = Math.max(
      (options.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS) -
        (Date.now() - held.lastActivityAt),
      0,
    );
    held.idleTimer = setTimeout(() => {
      if (isPinned(held) || starts.get(key) === undefined) return;
      void stopHeld(key, held).catch((error: unknown) => {
        cleanupFailures.set(key, error);
      });
    }, remaining);
  }

  function noteActivity(key: string, held: HeldBrowserInstance) {
    held.lastActivityAt = Date.now();
    scheduleIdleSleep(key, held);
  }

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

  async function retireExitedBrowser(key: string, held: HeldBrowserInstance) {
    starts.delete(key);
    activeTabs.delete(key);
    cancelIdleSleep(held);
    try {
      if (!held.stopRequested) await recordBrowserCrash(held.crashHistoryPath);
      await cleanupHeld(held);
      lifecycleStates.set(key, "sleeping");
    } catch (error) {
      cleanupFailures.set(key, error);
    }
  }

  function recordRestartFailure(key: string, error: unknown) {
    if (error instanceof BrowserInstanceError) {
      if (error.code === "repair-required") {
        lifecycleStates.set(key, "repair-required");
        return;
      }
      if (error.code === "host-offline") {
        lifecycleStates.set(key, "sleeping");
        return;
      }
    }
    cleanupFailures.set(key, error);
  }

  async function restartExitedBrowser(
    key: string,
    held: HeldBrowserInstance,
    retirement: Promise<void>,
  ) {
    await retirement;
    if (disposed) return;
    try {
      await heldInstance(held.target);
    } catch (error) {
      recordRestartFailure(key, error);
    }
  }

  function watchBrowserExit(key: string, held: HeldBrowserInstance) {
    const beginRetirement = () => {
      const retirement = retireExitedBrowser(key, held);
      trackRetirement(key, retirement);
      if (held.stopRequested) return;
      void restartExitedBrowser(key, held, retirement);
    };
    void held.process.exited.then(beginRetirement, beginRetirement);
  }

  function trackRetirement(key: string, retirement: Promise<void>) {
    retirements.set(key, retirement);
    void retirement.finally(() => {
      if (retirements.get(key) === retirement) retirements.delete(key);
    });
  }

  async function heldInstance(target: BrowserInstanceTarget) {
    if (disposed) {
      throw new BrowserInstanceError(
        "browser-unavailable",
        "This Browser worker generation has been disposed.",
      );
    }
    assertHostConnected(target.hostId);
    const key = runtimeKey(target);
    await retirements.get(key);
    assertNoCleanupFailure(key);
    const existingStart = starts.get(key);
    if (existingStart !== undefined) return existingStart;
    const awakeLimit =
      options.awakeInstanceLimit ?? DEFAULT_AWAKE_INSTANCE_LIMIT;
    if (starts.size < awakeLimit) return beginStart(target, key);
    return serializedCapacityStart(target, key);
  }

  function assertNoCleanupFailure(key: string) {
    const cleanupFailure = cleanupFailures.get(key);
    if (cleanupFailure === undefined) return;
    cleanupFailures.delete(key);
    throw cleanupFailure;
  }

  function failedStart(key: string, error: unknown): never {
    starts.delete(key);
    lifecycleStates.set(
      key,
      error instanceof BrowserInstanceError && error.code === "repair-required"
        ? "repair-required"
        : "sleeping",
    );
    throw error;
  }

  function beginStart(target: BrowserInstanceTarget, key: string) {
    lifecycleStates.set(key, "waking");
    const start = launchBrowserInstance(options, target).then(
      (held) => {
        for (const panelId of visiblePanelPins.get(key) ?? []) {
          held.panelIds.add(panelId);
        }
        watchBrowserExit(key, held);
        lifecycleStates.set(key, "running");
        scheduleIdleSleep(key, held);
        return held;
      },
      (error: unknown) => failedStart(key, error),
    );
    starts.set(key, start);
    return start;
  }

  async function serializedCapacityStart(
    target: BrowserInstanceTarget,
    key: string,
  ) {
    const reservation = capacityChanges.then(async () => {
      const existingStart = starts.get(key);
      if (existingStart !== undefined) return { start: existingStart };
      await makeAwakeCapacity(key);
      return { start: beginStart(target, key) };
    });
    capacityChanges = reservation.then(
      () => undefined,
      () => undefined,
    );
    return (await reservation).start;
  }

  async function makeAwakeCapacity(requestedKey: string) {
    if (starts.has(requestedKey)) return;
    const awakeLimit =
      options.awakeInstanceLimit ?? DEFAULT_AWAKE_INSTANCE_LIMIT;
    if (starts.size < awakeLimit) return;
    const candidates = await Promise.all(
      [...starts.entries()].map(
        async ([key, start]) => [key, await start] as const,
      ),
    );
    const evictable = candidates
      .filter(([, held]) => !isPinned(held))
      .sort(
        (left, right) => left[1].lastActivityAt - right[1].lastActivityAt,
      )[0];
    if (evictable === undefined) {
      throw new BrowserInstanceError(
        "awake-limit",
        `All ${awakeLimit} awake Browser Instances are pinned by a visible panel or active Control Lease.`,
      );
    }
    await stopHeld(evictable[0], evictable[1]);
  }

  async function stopHeld(key: string, held: HeldBrowserInstance) {
    held.stopRequested = true;
    cancelIdleSleep(held);
    lifecycleStates.set(key, "sleeping");
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

  async function repairLifecycleStatus(
    target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">,
  ) {
    const paths = profileStoragePaths({
      rootDirectory: options.rootDirectory,
      installationId: options.installationId,
      hostId: target.hostId,
      profileId: target.profileId,
    });
    const crashes = recentCrashTimestamps(
      await browserCrashHistory(`${paths.runtimeManifestPath}.crashes.json`),
      Date.now(),
    );
    return {
      state: "repair-required" as const,
      hostId: target.hostId,
      profileId: target.profileId,
      diagnostics: { crashCount: crashes.length, windowMs: CRASH_WINDOW_MS },
    };
  }

  async function lifecycleStatus(
    target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">,
  ) {
    if (disconnectedHosts.has(target.hostId)) {
      return {
        state: "host-offline" as const,
        hostId: target.hostId,
        profileId: target.profileId,
      };
    }
    const state = lifecycleStates.get(runtimeKey(target)) ?? "sleeping";
    return state === "repair-required"
      ? repairLifecycleStatus(target)
      : { state, hostId: target.hostId, profileId: target.profileId };
  }

  return {
    async start(target: BrowserInstanceTarget) {
      return (await heldInstance(target)).publicState;
    },
    async stop(target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">) {
      const key = runtimeKey(target);
      const start = starts.get(key);
      if (start === undefined) return;
      await stopHeld(key, await start);
    },
    status: lifecycleStatus,
    hostDisconnected(hostId: string) {
      disconnectedHosts.add(hostId);
    },
    async hostReconnected(hostId: string) {
      disconnectedHosts.delete(hostId);
      await Promise.all(
        [...retirements.entries()]
          .filter(([key]) => key.startsWith(`${hostId}\0`))
          .map(([, retirement]) => retirement),
      );
    },
    async pinPanel(target: BrowserInstanceTarget, panelId: string) {
      const key = runtimeKey(target);
      const held = await heldInstance(target);
      held.panelIds.add(panelId);
      const profilePanelPins = visiblePanelPins.get(key) ?? new Set<string>();
      profilePanelPins.add(panelId);
      visiblePanelPins.set(key, profilePanelPins);
      noteActivity(key, held);
      return held.publicState;
    },
    async unpinPanel(
      target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">,
      panelId: string,
    ) {
      const key = runtimeKey(target);
      const profilePanelPins = visiblePanelPins.get(key);
      profilePanelPins?.delete(panelId);
      if (profilePanelPins?.size === 0) visiblePanelPins.delete(key);
      const start = starts.get(key);
      if (start === undefined) return;
      const held = await start;
      held.panelIds.delete(panelId);
      noteActivity(key, held);
    },
    async execute(
      target: BrowserRuntimeTarget,
      code: string,
      timeoutMs: number,
      operationOptions: BrowserOperationOptions = {},
    ) {
      const held = await heldInstance(target);
      const key = runtimeKey(target);
      held.activeLeases += 1;
      noteActivity(key, held);
      const screenshot = operationOptions.screenshot
        ? {
            fileName: `bb-screenshot-${randomUUID()}.png`,
            marker: `bb-screenshot-${randomUUID()}`,
            mimeType: "image/png" as const,
          }
        : undefined;
      const codeForTarget =
        target.tabId === undefined
          ? code
          : activateTargetedTab(target.tabId, code);
      const executionCode =
        screenshot === undefined
          ? codeForTarget
          : appendNativeScreenshot(codeForTarget, target.tabId, screenshot);
      const operationSignal = linkedOperationSignal(operationOptions);
      try {
        try {
          const browserResult = assertBrowserScriptResultWithinBounds(
            await options.launchBoundary.execute(
              executionRequest(
                held,
                target.profileId,
                executionCode,
                timeoutMs,
                operationSignal.signal,
                screenshot,
              ),
            ),
          );
          if (target.tabId !== undefined) activeTabs.set(key, target.tabId);
          return browserResult;
        } catch (error) {
          throw classifyExecutionError(error);
        }
      } finally {
        operationSignal.dispose();
        held.activeLeases -= 1;
        noteActivity(key, held);
      }
    },
    async navigate(
      target: BrowserRuntimeTarget,
      input: string,
      operationOptions: BrowserOperationOptions = {},
    ) {
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
      const operationSignal = linkedOperationSignal(operationOptions);
      let tabId = target.tabId ?? activeTabs.get(key);
      try {
        if (tabId === undefined) {
          const discovered = await options.launchBoundary.execute(
            executionRequest(
              held,
              target.profileId,
              activeBrowserTabScript(),
              30_000,
              operationSignal.signal,
            ),
          );
          tabId = activeTabId(discovered);
        }
        const location = await options.launchBoundary.execute(
          executionRequest(
            held,
            target.profileId,
            browserNavigationScript(address, tabId),
            30_000,
            operationSignal.signal,
          ),
        );
        activeTabs.set(key, tabId);
        noteActivity(key, held);
        return { address, location, tabId };
      } finally {
        operationSignal.dispose();
      }
    },
    async dispose() {
      disposed = true;
      await capacityChanges;
      const instances = await Promise.allSettled(starts.values());
      await Promise.all(
        instances.flatMap((instance) =>
          instance.status === "fulfilled"
            ? [stopHeld(runtimeKey(instance.value.publicState), instance.value)]
            : [],
        ),
      );
      await Promise.all(retirements.values());
    },
  };
}

export type BrowserInstanceRuntime = ReturnType<
  typeof createBrowserInstanceRuntime
>;
