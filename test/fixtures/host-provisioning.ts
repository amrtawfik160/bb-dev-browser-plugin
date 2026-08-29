/**
 * Shared glue for issue #24 host-provisioning acceptance tests.
 *
 * Issue #24 provisions the current enrolled host and runs deterministic remote
 * acceptance through the owner's BB Connect session. The privileged
 * provisioning (creating the `bb-browser` user, protected storage, installing
 * Chrome, BB Connect enrollment) is performed by the human owner; this fixture
 * provides ONLY the agent-doable glue the gated tests reuse:
 *
 *   - `integrationEnabled` and `realBrowserProvisioned()` are re-exported from
 *     the #21 evidence helpers so every #24 test shares the single
 *     module-load throw (`BB_BROWSER_REAL_INTEGRATION_REQUIRED=1` without
 *     `BB_BROWSER_REAL_INTEGRATION=1` throws at module load) and the single
 *     source of truth for the provisioned-host gate.
 *   - `provisionedHostContext()` probes the REAL host readiness through the
 *     real `createDefaultHostSnapshotReader` and returns either a healthy
 *     context (snapshot, readiness, target, storage paths, worker env) or a
 *     skip descriptor naming the exact missing capability, so a #24 test can
 *     skip deterministically (not fail) when the host is not provisioned.
 *   - `runHostWorker()` spawns the EXISTING `test/fixtures/real-browser-worker.ts`
 *     fixture (the same worker the mandatory provisioned-host gate uses) and
 *     returns its JSON report, so #24 acceptance reuses the real-Chrome driver
 *     without duplicating it.
 *   - `assertDedicatedIdentity()`, `assertLoopbackSocket()`, and
 *     `assertLoopbackSocketClosed()` assert the bb-browser ownership,
 *     sandbox, and loopback-only listener boundaries against the worker's
 *     real-process report.
 *
 * This fixture never provisions or mutates the host. It reuses #21 helpers and
 * the existing real-browser worker fixture; it adds no parallel driver.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type http from "node:http";
import { DEFAULT_PROFILE_ID, type BrowserHostTarget } from "../../contracts.js";
import { profileStoragePaths } from "../../profile-storage.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  provisionedBrowserStorageRoot,
  type HostProbeSnapshot,
} from "../../readiness.js";
import {
  integrationEnabled,
  realBrowserProvisioned,
  findSensitiveData,
  SENSITIVE_DATA_PATTERNS,
  createEvidenceHarness,
} from "./evidence-helpers.js";
import {
  closeLoopbackFixture,
  createLoopbackAuthFixture,
  listenLoopbackFixture,
} from "./loopback-auth-fixture.js";

export {
  integrationEnabled,
  realBrowserProvisioned,
  findSensitiveData,
  SENSITIVE_DATA_PATTERNS,
  createEvidenceHarness,
};

const execFileAsync = promisify(execFile);

/**
 * The deterministic loopback authentication fixture the real-browser worker's
 * `signInScript` drives. Re-exported from the shared
 * `loopback-auth-fixture.ts` module so every #24 host-provisioning test and
 * `browser-auth.integration.test.ts` reuse one fixture rather than each
 * rebuilding it. Binds loopback only; never provisions or mutates the host.
 */
export const createAuthenticationFixture: () => http.Server =
  createLoopbackAuthFixture;

/** Start a loopback fixture server and return its bound port. */
export const listenFixture: (server: http.Server) => Promise<number> =
  listenLoopbackFixture;

/** Close a fixture server. */
export const closeFixture: (server: http.Server) => Promise<void> =
  closeLoopbackFixture;

/** Environment the owner sets on a provisioned host to run the gate. */
export interface ProvisionedHostEnvironment {
  /** BB daemon data directory; determines the installation id. */
  dataDir: string;
  /** Protected Browser storage root (defaults to /var/lib/bb-browser). */
  rootDirectory: string;
  /** Installation id derived from the data directory. */
  installationId: string;
  hostId: string;
  profileId: string;
  projectId: string;
}

/** A healthy provisioned host ready for deterministic acceptance. */
export interface ProvisionedHostContext extends ProvisionedHostEnvironment {
  snapshot: HostProbeSnapshot;
  target: BrowserHostTarget;
  /** Worker environment for spawning the real-browser worker fixture. */
  workerEnv: (
    action: WorkerAction,
    extra?: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
}

/** The exact actions the existing real-browser worker fixture accepts. */
export type WorkerAction =
  | "start"
  | "crash-recover"
  | "lifecycle"
  | "cleanup"
  | "origin-scope"
  | "panel-transport"
  | "dialogs"
  | "safe-login"
  | "transfer"
  | "disable-re-enable";

/** A skip descriptor naming the exact missing capability. */
export interface MissingHostCapability {
  ready: false;
  missingCapability: string;
  reason: string;
}

/**
 * Skip the current test deterministically when the host is not provisioned,
 * surfacing the exact missing capability and reason in vitest's skip output so
 * a non-provisioned run names which capability is missing (issue #24 P1).
 * Returns a type guard so the caller keeps the narrowed `ProvisionedHostContext`
 * after a successful (non-skipped) probe.
 */
export function skipIfNotProvisioned(
  ctx: { skip: (note?: string) => never },
  result: ProvisionedHostContext | MissingHostCapability,
): result is ProvisionedHostContext {
  if ("missingCapability" in result) {
    ctx.skip(
      `host not provisioned: ${result.missingCapability} — ${result.reason}`,
    );
    return false;
  }
  return true;
}

/** The JSON report emitted by `test/fixtures/real-browser-worker.ts`. */
export interface WorkerReport {
  instance: { pid: number; automationEndpoint: string; browser: string };
  scriptOutput: string;
  uid: number;
  gid: number;
  ownedProcesses: { pid: number; command: string; status: string }[];
  helperProcess: { pid: number; status: string; socketReady: boolean } | null;
  navigation?: { before: { id?: unknown }[]; after: unknown[]; tabId: string };
  recovery?: { crashedPid: number; recoveredPid: number } | null;
  lifecycle?: {
    initialPid: number;
    lruState: string;
    pinnedLimitCode: string | null;
    disconnectedCode: string | null;
    reconciledPid: number;
    idleStates: string[];
    crashPids: number[];
    crashLoopState: {
      state: string;
      diagnostics?: { crashCount: number; windowMs: number };
    };
    corruptCode: string | null;
    lazyState: string;
    reloadPids: number[];
  };
  originScope?: {
    attacks: { kind: string; blocked: boolean; deniedOrigin?: string }[];
    inScope: { ok: boolean };
    revocation: { interrupted: boolean; browserStillRunning: boolean };
    ownerPage: { present: boolean };
  };
  panelTransport?: {
    gatewayBindHost: string;
    redeemed: boolean;
    replayed: boolean;
    viewport: { width: number; height: number };
    fps: number;
    reconnectBackoffMs: number[];
    reclaimWindowMs: number;
    revoked: boolean;
  };
  safeLogin?: {
    entered: boolean;
    warned: boolean;
    agentsInterrupted: number;
    initiatorOnlyPixels: boolean;
    elsewhereOpaque: boolean;
    agentDenied: boolean;
    authenticatedThroughFixture: boolean;
    extended: boolean;
    doneReturnedToAutomation: boolean;
    reconciledToAutomation: boolean;
    activityMetadataOnly: boolean;
  };
  /**
   * Issue #24 S4/P2: the real worker `transfer` action exercises Transfer
   * Staging (client/workspace upload) AND quarantined download export through
   * the real host worker path, so AC3 is genuinely exercisable on a
   * provisioned host rather than only delegated to in-memory suites.
   */
  transfer?: {
    failClosedWithoutDataDir: boolean;
    stagedWorkspace: boolean;
    privacySafeNoPath: boolean;
    removedAfterUse: boolean;
    symlinkEscapeRejected: boolean;
    traversalRejected: boolean;
  };
  downloadExport?: {
    /** The download entered the profile-scoped quarantine. */
    quarantined: boolean;
    /** Owner export to the displaying client returns the base64 bytes. */
    exportedToClient: boolean;
    /** Exported bytes match the bytes written into quarantine. */
    clientBytesMatch: boolean;
    /** Owner export into the workspace copies host-to-host without escaping. */
    exportedToWorkspace: boolean;
    /** A workspace export resolving outside the environment is rejected. */
    outsideEnvironmentRejected: boolean;
    /** The quarantine file remains for later expiry after export. */
    quarantineRetained: boolean;
    /** Privacy-safe listing never echoes the quarantine path. */
    privacySafeNoPath: boolean;
  };
  /**
   * Issue #24 S3/P2: the real worker `disable-re-enable` action stops every
   * Browser-owned process (disable), rebuilds a fresh runtime (re-enable), and
   * verifies the profile's persisted sign-in/local/session state is retained
   * across the cycle through the real worker path.
   */
  disableReEnable?: {
    /** The profile's signed-in account heading is retained after re-enable. */
    accountHeadingRetained: boolean;
    /** localStorage survives the disable/re-enable cycle. */
    localStorageRetained: boolean;
    /** sessionStorage is restored from the persistent profile. */
    sessionStorageRetained: boolean;
    /** Locale/timezone preferences are retained. */
    localeRetained: boolean;
    timezoneRetained: boolean;
    /** The pre-disable process is gone after re-enable (processes restarted). */
    preDisableProcessGone: boolean;
  };
  postStop?: {
    ownedProcesses: { pid: number; command: string; status: string }[];
    browserPresent: boolean;
    helperPresent: boolean;
    helperSocketPresent: boolean;
  };
}

function requiredEnvironment(name: string): string | undefined {
  const setting = process.env[name];
  if (setting === undefined || setting === "") return undefined;
  return setting;
}

function readWorkerEnv(): {
  dataDir: string;
  hostId: string;
  profileId: string;
  projectId: string;
  rootDirectory: string;
  fixtureAddress: string | undefined;
} | null {
  const dataDir = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
  if (dataDir === undefined) return null;
  const hostId =
    requiredEnvironment("BB_BROWSER_REAL_HOST_ID") ?? "ci-browser-host";
  const profileId =
    requiredEnvironment("BB_BROWSER_REAL_PROFILE_ID") ?? "ci-auth-fixture";
  const projectId =
    requiredEnvironment("BB_BROWSER_REAL_PROJECT_ID") ?? "ci-browser-project";
  let rootDirectory: string;
  try {
    rootDirectory = provisionedBrowserStorageRoot(
      requiredEnvironment("BB_BROWSER_REAL_ROOT"),
    );
  } catch {
    return null;
  }
  return {
    dataDir,
    hostId,
    profileId,
    projectId,
    rootDirectory,
    fixtureAddress: requiredEnvironment("BB_BROWSER_FIXTURE_ADDRESS"),
  };
}

/**
 * Probe the real host readiness and return a healthy context, or a skip
 * descriptor naming the exact missing capability so the caller can
 * `ctx.skip()` deterministically. Returns `ready: false` (never throws) when
 * the host is not provisioned, so a #24 test never fails on a bare host.
 */
export async function provisionedHostContext(
  fixtureAddressFallback?: string,
): Promise<ProvisionedHostContext | MissingHostCapability> {
  if (!realBrowserProvisioned()) {
    return {
      ready: false,
      missingCapability: "provisioned-host-gate",
      reason:
        "Set BB_BROWSER_REAL_INTEGRATION=1 (and BB_BROWSER_HOST_DATA_DIR) on a provisioned, BB-Connect-enrolled host to run host-provisioning acceptance.",
    };
  }
  const env = readWorkerEnv();
  if (env === null) {
    return {
      ready: false,
      missingCapability: "host-data-dir",
      reason:
        "BB_BROWSER_HOST_DATA_DIR is not set; provision the host's BB daemon data directory before running host-provisioning acceptance.",
    };
  }
  const installationId = hostInstallationId(env.dataDir);
  const target: BrowserHostTarget = {
    hostId: env.hostId,
    profileId: env.profileId,
  };
  let snapshot: HostProbeSnapshot;
  try {
    const reader = createDefaultHostSnapshotReader(env.dataDir);
    snapshot = await reader.snapshot(target);
  } catch (error) {
    return {
      ready: false,
      missingCapability: "readiness-probe",
      reason: `The host readiness probe failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  let readiness;
  try {
    readiness = await createHostReadinessBoundary(
      createDefaultHostSnapshotReader(env.dataDir),
    ).inspect(target);
  } catch (error) {
    return {
      ready: false,
      missingCapability: "readiness-probe",
      reason: `The host readiness boundary failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (readiness.state !== "healthy") {
    const failed = readiness.capabilities.find(
      (capability) => capability.status !== "ready",
    );
    return {
      ready: false,
      missingCapability: failed?.id ?? readiness.state,
      reason:
        failed?.reason ??
        `The host readiness state is ${readiness.state}; provision the host before running host-provisioning acceptance.`,
    };
  }
  const fixtureAddress =
    env.fixtureAddress ??
    fixtureAddressFallback ??
    "http://127.0.0.1:0/account";
  return {
    dataDir: env.dataDir,
    rootDirectory: env.rootDirectory,
    installationId,
    hostId: env.hostId,
    profileId: env.profileId,
    projectId: env.projectId,
    snapshot,
    target,
    workerEnv: (action, extra) => ({
      BB_BROWSER_REAL_ROOT: env.rootDirectory,
      BB_BROWSER_REAL_INSTALLATION_ID: installationId,
      BB_BROWSER_REAL_HOST_ID: env.hostId,
      BB_BROWSER_REAL_PROFILE_ID: env.profileId,
      BB_BROWSER_REAL_PROJECT_ID: env.projectId,
      BB_BROWSER_FIXTURE_ADDRESS: fixtureAddress,
      BB_BROWSER_HOST_DATA_DIR: env.dataDir,
      BB_BROWSER_WORKER_ACTION: action,
      ...(extra ?? {}),
    }),
  };
}

/**
 * Spawn the existing `test/fixtures/real-browser-worker.ts` fixture with the
 * given action and environment, and return its parsed JSON report. Reuses the
 * same worker the mandatory provisioned-host gate uses; does not duplicate it.
 */
export async function runHostWorker(
  workerEnv: NodeJS.ProcessEnv,
): Promise<WorkerReport> {
  const { stdout } = await execFileAsync(
    join(process.cwd(), "node_modules/.bin/vite-node"),
    ["--script", "test/fixtures/real-browser-worker.ts"],
    { env: { ...process.env, ...workerEnv }, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim()) as WorkerReport;
}

/** Parse the worker's `scriptOutput` JSON for start/crash-recover scenarios. */
export function parsedScriptOutput(
  report: WorkerReport,
): Record<string, unknown> {
  return JSON.parse(report.scriptOutput) as Record<string, unknown>;
}

/**
 * Assert the worker and its helpers run as the dedicated unprivileged
 * `bb-browser` user with the Chrome sandbox enabled (no `--no-sandbox`).
 */
export function assertDedicatedIdentity(report: WorkerReport): void {
  if (report.uid <= 0 || report.gid <= 0) {
    throw new Error(
      `The browser process did not drop to an unprivileged user (uid=${report.uid}, gid=${report.gid}).`,
    );
  }
  if (report.ownedProcesses.length === 0) {
    throw new Error("No bb-browser-owned processes were found on the host.");
  }
  for (const process of report.ownedProcesses) {
    if (!new RegExp(`^Uid:\\s+${report.uid}\\s`, "mu").test(process.status)) {
      throw new Error(
        `Process ${process.pid} is not owned by the bb-browser uid ${report.uid}.`,
      );
    }
    if (!new RegExp(`^Gid:\\s+${report.gid}\\s`, "mu").test(process.status)) {
      throw new Error(
        `Process ${process.pid} is not owned by the bb-browser gid ${report.gid}.`,
      );
    }
    if (process.command.includes("--no-sandbox")) {
      throw new Error(
        `Process ${process.pid} launched Chrome with --no-sandbox; the sandbox is required.`,
      );
    }
  }
  if (report.helperProcess === null) {
    throw new Error("The dev-browser helper process was not observed.");
  }
  if (!report.helperProcess.socketReady) {
    throw new Error("The dev-browser helper socket was not ready.");
  }
  if (
    !new RegExp(`^Uid:\\s+${report.uid}\\s`, "mu").test(
      report.helperProcess.status,
    ) ||
    !new RegExp(`^Gid:\\s+${report.gid}\\s`, "mu").test(
      report.helperProcess.status,
    )
  ) {
    throw new Error(
      `The dev-browser helper (pid ${report.helperProcess.pid}) is not owned by the bb-browser user.`,
    );
  }
}

/** Assert a Chrome/CDP/VNC/helper/gateway endpoint binds to loopback only. */
export async function assertLoopbackSocket(endpoint: string): Promise<void> {
  const url = new URL(endpoint);
  if (url.hostname !== "127.0.0.1") {
    throw new Error(
      `Endpoint ${endpoint} does not bind to loopback (127.0.0.1).`,
    );
  }
  const port = Number(url.port).toString(16).toUpperCase().padStart(4, "0");
  const sockets = `${await readFile("/proc/net/tcp", "utf8")}\n${await readFile(
    "/proc/net/tcp6",
    "utf8",
  )}`;
  if (!hasLoopbackListener(sockets, port)) {
    throw new Error(
      `No loopback listener for ${endpoint} (port 0x${port}) was found in /proc/net/tcp.`,
    );
  }
}

/** Assert a previously-bound loopback socket has closed. */
export async function assertLoopbackSocketClosed(
  endpoint: string,
): Promise<void> {
  const url = new URL(endpoint);
  const port = Number(url.port).toString(16).toUpperCase().padStart(4, "0");
  const sockets = `${await readFile("/proc/net/tcp", "utf8")}\n${await readFile(
    "/proc/net/tcp6",
    "utf8",
  )}`;
  if (hasLoopbackListener(sockets, port)) {
    throw new Error(
      `The loopback listener for ${endpoint} (port 0x${port}) is still open.`,
    );
  }
}

function hasLoopbackListener(sockets: string, port: string): boolean {
  return sockets.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/u);
    return fields[1] === `0100007F:${port}` && fields[3] === "0A";
  });
}

/**
 * Remove the fixture profiles the real-browser worker creates so a run leaves
 * no partial state on a failed provisioned-host run. Called in `finally`; the
 * owner's no-purge decision (issue #24 AC8) applies to RETAINED test profile
 * data, not to these short-lived worker-scoped fixture profiles which the
 * mandatory gate already cleans up.
 */
export async function cleanupFixtureProfiles(
  context: ProvisionedHostContext,
): Promise<void> {
  const profileIds = [
    context.profileId,
    "lru-b",
    "lru-c",
    "lru-d",
    "pinned-refused",
    "crash-loop",
    "corrupt",
    "reload",
  ].map((suffix) =>
    suffix === context.profileId ? suffix : `${context.profileId}-${suffix}`,
  );
  for (const profileId of profileIds) {
    const paths = profileStoragePaths({
      rootDirectory: context.rootDirectory,
      installationId: context.installationId,
      hostId: context.hostId,
      profileId,
    });
    for (const path of [
      paths.profileDirectory,
      paths.runtimeManifestPath,
      `${paths.runtimeManifestPath}.crashes.json`,
      `${paths.runtimeManifestPath}.instance.lock`,
      join(paths.runtimeManifestsDirectory, `bb-${profileId}`),
    ]) {
      const { rm } = await import("node:fs/promises");
      await rm(path, { recursive: true, force: true });
    }
  }
}

/** The default profile id used by the Browser plugin. */
export { DEFAULT_PROFILE_ID };
