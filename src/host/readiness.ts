import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, stat, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  inspectFallbackBrowser,
  fallbackBrowserPaths,
} from "./browser-fallback.js";
import {
  daemonRootFromHostDataDir,
  readDaemonConnectPairing,
} from "./daemon-data.js";
import {
  BROWSER_STORAGE_ROOT,
  browserHostStorageSegment,
} from "../shared/contracts.js";
import type {
  BrowserDiagnostics,
  BrowserHostTarget,
  BrowserStatus,
  BrowserStatusTarget,
  ReadinessCapability,
} from "../shared/contracts.js";
import { dependencyInventory } from "../shared/dependency-inventory.js";

const FIVE_GIB = 5 * 1024 ** 3;

export interface HostProbePaths {
  osRelease: string;
  passwd: string;
  packageStatus: string;
  userNamespaceSetting: string;
  chromeStable: string;
  chrome: string;
  sandboxHelpers: readonly string[];
  protectedStorageRoot: string;
}

const DEFAULT_PROBE_PATHS: HostProbePaths = {
  osRelease: "/etc/os-release",
  passwd: "/etc/passwd",
  packageStatus: "/var/lib/dpkg/status",
  userNamespaceSetting: "/proc/sys/kernel/unprivileged_userns_clone",
  chromeStable: "/usr/bin/google-chrome-stable",
  chrome: "/usr/bin/google-chrome",
  sandboxHelpers: [
    "/opt/google/chrome/chrome-sandbox",
    "/usr/lib/chromium/chrome-sandbox",
  ],
  protectedStorageRoot: "/var/lib/bb-browser",
};

const hostStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.string().min(1),
    hostId: z.string().min(1),
  })
  .strict();

const connectConfigSchema = z
  .object({
    machineCredential: z.string().min(1),
  })
  .passthrough();

function jsonDocument(contents: string) {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export interface HostProbeSnapshot {
  operatingSystem: { id: string; version: string; name: string };
  architecture: string;
  connect: { enrolled: boolean };
  browser: {
    name: string;
    version: string | null;
    compatible: boolean;
  } | null;
  sandbox: { available: boolean };
  dedicatedUser: { state: "ready" | "missing" | "invalid" };
  protectedStorage: {
    state: "ready" | "missing" | "partial" | "insecure" | "corrupt";
  };
  disk: { freeBytes: number; totalBytes: number };
  loopback: { available: boolean };
  processes: readonly {
    name: string;
    state: "running" | "stopped" | "failed";
    pid?: number;
  }[];
  exitLogs: readonly string[];
}

export interface HostSnapshotReader {
  snapshot(
    target: BrowserHostTarget,
  ): HostProbeSnapshot | Promise<HostProbeSnapshot>;
}

export interface HostReadinessBoundary {
  inspect(target: BrowserHostTarget): BrowserStatus | Promise<BrowserStatus>;
  diagnostics(
    target: BrowserHostTarget,
  ): BrowserDiagnostics | Promise<BrowserDiagnostics>;
}

function capability(
  id: ReadinessCapability["id"],
  label: string,
  status: ReadinessCapability["status"],
  reason: string,
): ReadinessCapability {
  return { id, label, status, reason };
}

function statusTarget(target: BrowserHostTarget): BrowserStatusTarget {
  return { hostId: target.hostId, profileId: target.profileId };
}

type CapabilityEvaluation = Pick<ReadinessCapability, "status" | "reason">;

const DEDICATED_USER_EVALUATIONS: Record<
  HostProbeSnapshot["dedicatedUser"]["state"],
  CapabilityEvaluation
> = {
  ready: {
    status: "ready",
    reason: "The unprivileged bb-browser user is configured.",
  },
  missing: {
    status: "missing",
    reason:
      "Create the unprivileged bb-browser user through explicit Browser setup.",
  },
  invalid: {
    status: "failed",
    reason:
      "Repair the bb-browser user so it is unprivileged and cannot log in.",
  },
};

const PROTECTED_STORAGE_EVALUATIONS: Record<
  HostProbeSnapshot["protectedStorage"]["state"],
  CapabilityEvaluation
> = {
  ready: {
    status: "ready",
    reason: "Browser storage is owner-only and its host state is valid.",
  },
  missing: {
    status: "missing",
    reason: "Create protected Browser storage through explicit Browser setup.",
  },
  partial: {
    status: "missing",
    reason: "Resume Browser setup to finish protected storage.",
  },
  corrupt: {
    status: "failed",
    reason: "Repair the corrupt Browser host state before continuing.",
  },
  insecure: {
    status: "failed",
    reason:
      "Repair Browser storage ownership and permissions before continuing.",
  },
};

type OverallReadinessState = Exclude<
  BrowserStatus["state"],
  "host-offline" | "sleeping" | "waking"
>;

function overallReadinessState(
  platformSupported: boolean,
  capabilities: readonly ReadinessCapability[],
): OverallReadinessState {
  if (!platformSupported) return "unsupported";
  if (capabilities.some(({ status }) => status === "failed")) {
    return "repair-required";
  }
  if (capabilities.some(({ status }) => status !== "ready")) {
    return "setup-required";
  }
  return "healthy";
}

function report(
  target: BrowserHostTarget,
  snapshot: HostProbeSnapshot,
): BrowserStatus {
  const supportedOs = ["ubuntu", "debian"].includes(
    snapshot.operatingSystem.id.toLowerCase(),
  );
  const supportedArchitecture = ["x64", "amd64"].includes(
    snapshot.architecture.toLowerCase(),
  );
  const platformSupported = supportedOs && supportedArchitecture;
  const dedicatedUserEvaluation =
    DEDICATED_USER_EVALUATIONS[snapshot.dedicatedUser.state];
  const protectedStorageEvaluation =
    PROTECTED_STORAGE_EVALUATIONS[snapshot.protectedStorage.state];
  const capabilities: ReadinessCapability[] = [
    capability(
      "operating-system",
      "Operating system",
      supportedOs ? "ready" : "unsupported",
      supportedOs
        ? `${snapshot.operatingSystem.name} is supported.`
        : `Install on Ubuntu or Debian; ${snapshot.operatingSystem.name} is unsupported.`,
    ),
    capability(
      "architecture",
      "Architecture",
      supportedArchitecture ? "ready" : "unsupported",
      supportedArchitecture
        ? "x86_64 is supported."
        : `Use an x86_64 host; ${snapshot.architecture} is unsupported.`,
    ),
    capability(
      "bb-connect",
      "BB Connect",
      snapshot.connect.enrolled ? "ready" : "missing",
      snapshot.connect.enrolled
        ? "The host is enrolled in BB Connect."
        : "Enroll this host in BB Connect before Browser setup.",
    ),
    capability(
      "browser",
      "Browser",
      snapshot.browser === null
        ? "missing"
        : snapshot.browser.compatible
          ? "ready"
          : "failed",
      snapshot.browser === null
        ? "Install supported Chrome Stable or the pinned Chromium fallback."
        : snapshot.browser.compatible
          ? `${snapshot.browser.name}${snapshot.browser.version === null ? "" : ` ${snapshot.browser.version}`} is available.`
          : `${snapshot.browser.name}${snapshot.browser.version === null ? " has an unknown version" : ` ${snapshot.browser.version}`} is incompatible with this Browser plugin.`,
    ),
    capability(
      "sandbox",
      "Browser sandbox",
      snapshot.sandbox.available ? "ready" : "missing",
      snapshot.sandbox.available
        ? "The Chrome sandbox can run without disabling isolation."
        : "Enable user namespaces or install the supported Chrome sandbox helper.",
    ),
    capability(
      "dedicated-user",
      "Dedicated browser user",
      dedicatedUserEvaluation.status,
      dedicatedUserEvaluation.reason,
    ),
    capability(
      "protected-storage",
      "Protected storage",
      protectedStorageEvaluation.status,
      protectedStorageEvaluation.reason,
    ),
    capability(
      "disk-headroom",
      "Disk headroom",
      snapshot.disk.freeBytes >= FIVE_GIB ? "ready" : "failed",
      snapshot.disk.freeBytes >= FIVE_GIB
        ? "At least 5 GiB of host disk space is free."
        : "Free at least 5 GiB of host disk space before starting a Browser Instance.",
    ),
    capability(
      "loopback",
      "Loopback networking",
      snapshot.loopback.available ? "ready" : "failed",
      snapshot.loopback.available
        ? "Required helpers can bind to loopback-only ports."
        : "Repair host loopback networking before Browser setup.",
    ),
  ];

  const state = overallReadinessState(platformSupported, capabilities);
  if (state === "unsupported") {
    return {
      ...statusTarget(target),
      state: "unsupported",
      code: "unsupported",
      label: "Unsupported",
      message: "Workspace Browser supports Ubuntu and Debian on x86_64 only.",
      capabilities,
    };
  }

  if (state === "repair-required") {
    return {
      ...statusTarget(target),
      state: "repair-required",
      code: "repair_required",
      label: "Repair required",
      message: "Repair the failed host checks before using Workspace Browser.",
      capabilities,
    };
  }

  if (state === "setup-required") {
    return {
      ...statusTarget(target),
      state: "setup-required",
      code: "setup_required",
      label: "Setup required",
      message:
        "Complete the missing host checks through explicit Browser setup.",
      capabilities,
    };
  }

  return {
    ...statusTarget(target),
    state: "healthy",
    code: "healthy",
    label: "Ready",
    message: "Workspace Browser is ready on this host.",
    capabilities,
  };
}

export function createHostReadinessBoundary(
  reader: HostSnapshotReader,
): HostReadinessBoundary {
  async function snapshotAndReport(target: BrowserHostTarget) {
    const snapshot = await reader.snapshot(target);
    return { snapshot, readiness: report(target, snapshot) };
  }
  return {
    async inspect(target) {
      return (await snapshotAndReport(target)).readiness;
    },
    async diagnostics(target) {
      const { snapshot, readiness } = await snapshotAndReport(target);
      return {
        hostId: target.hostId,
        profileId: target.profileId,
        generatedAt: new Date().toISOString(),
        readiness,
        dependencies: [
          ...dependencyInventory(),
          ...(snapshot.browser === null
            ? []
            : [
                {
                  name: snapshot.browser.name,
                  version: snapshot.browser.version,
                },
              ]),
        ],
        processes: [...snapshot.processes],
        resourceUse: {
          diskFreeBytes: snapshot.disk.freeBytes,
          diskTotalBytes: snapshot.disk.totalBytes,
          workerRssBytes: process.memoryUsage().rss,
        },
        exitLogs: snapshot.exitLogs.slice(-50).map(redactExitLog),
      };
    },
  };
}

export function redactExitLog(line: string) {
  const processName =
    line.match(/\b(Chrome|Chromium|Xvfb|x11vnc|noVNC|host-worker)\b/i)?.[1] ??
    "Browser helper";
  const exitCode = line.match(
    /\b(?:exit(?:ed)?(?: with)? code)\s*[:=]?\s*(\d+)\b/i,
  )?.[1];
  const signal = line.match(/\b(?:signal)\s*[:=]?\s*(SIG[A-Z0-9]+)\b/i)?.[1];
  return [
    `${processName} exited`,
    exitCode === undefined ? null : `code ${exitCode}`,
    signal === undefined ? null : `signal ${signal}`,
    "[details redacted]",
  ]
    .filter((part) => part !== null)
    .join("; ");
}

function parseOsRelease(contents: string) {
  const fields = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^['"]|['"]$/g, "");
    fields.set(key, value);
  }
  return {
    id: fields.get("ID") ?? "unknown",
    version: fields.get("VERSION_ID") ?? "unknown",
    name: fields.get("PRETTY_NAME") ?? "Unknown operating system",
  };
}

async function fileExists(path: string) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function packageVersion(contents: string, packageName: string) {
  for (const paragraph of contents.split("\n\n")) {
    if (!paragraph.includes(`Package: ${packageName}\n`)) continue;
    if (!paragraph.includes("Status: install ok installed")) continue;
    return paragraph.match(/^Version: (.+)$/m)?.[1] ?? null;
  }
  return null;
}

async function chromeAvailability(paths: HostProbePaths) {
  const packageStatus = await readFile(paths.packageStatus, "utf8").catch(
    () => "",
  );
  for (const candidate of [
    { path: paths.chromeStable, name: "Google Chrome Stable" },
    { path: paths.chrome, name: "Google Chrome" },
  ]) {
    if (!(await fileExists(candidate.path))) continue;
    const version = packageVersion(packageStatus, "google-chrome-stable");
    return { name: candidate.name, version, compatible: version !== null };
  }
  return null;
}

async function fallbackBrowserAvailability(
  hostStorage: string,
  browserUser: Awaited<ReturnType<typeof dedicatedUser>>,
) {
  if (browserUser.uid === null || browserUser.gid === null) return null;
  const installed = await inspectFallbackBrowser({
    hostStoragePath: hostStorage,
    uid: browserUser.uid,
    gid: browserUser.gid,
  });
  if (installed === null) {
    const fallbackPaths = fallbackBrowserPaths(hostStorage);
    try {
      await lstat(fallbackPaths.executablePath);
      return {
        name: "Pinned Playwright Chromium",
        version: null,
        compatible: false,
      };
    } catch {
      return null;
    }
  }
  return {
    name: "Pinned Playwright Chromium",
    version: installed.manifest.chromiumVersion,
    compatible: true,
  };
}

async function browserAvailability(
  paths: HostProbePaths,
  hostStorage: string,
  browserUser: Awaited<ReturnType<typeof dedicatedUser>>,
) {
  const chrome = await chromeAvailability(paths);
  if (chrome?.compatible === true) return chrome;
  const fallback = await fallbackBrowserAvailability(hostStorage, browserUser);
  return fallback?.compatible === true ? fallback : (chrome ?? fallback);
}

async function validSandboxHelper(path: string) {
  try {
    const metadata = await lstat(path);
    const validMode =
      (metadata.mode & 0o111) !== 0 &&
      (metadata.mode & 0o022) === 0 &&
      (metadata.mode & 0o4000) !== 0;
    if (!metadata.isFile() || metadata.uid !== 0 || !validMode) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function sandboxAvailability(paths: HostProbePaths) {
  const userNamespaceSetting = await readFile(
    paths.userNamespaceSetting,
    "utf8",
  ).catch(() => "0");
  if (userNamespaceSetting.trim() === "1") return { available: true };
  for (const path of paths.sandboxHelpers) {
    if (await validSandboxHelper(path)) return { available: true };
  }
  return { available: false };
}

async function dedicatedUser(paths: HostProbePaths) {
  const passwd = await readFile(paths.passwd, "utf8").catch(() => "");
  const fields = passwd
    .split("\n")
    .find((line) => line.startsWith("bb-browser:"))
    ?.split(":");
  if (fields === undefined) {
    return { state: "missing" as const, uid: null, gid: null };
  }
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const shell = fields[6] ?? "";
  const unprivileged =
    Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0;
  const noLogin = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"].includes(
    shell,
  );
  return {
    state: unprivileged && noLogin ? ("ready" as const) : ("invalid" as const),
    uid,
    gid,
  };
}

async function protectedStorage(
  storagePath: string,
  installationId: string,
  hostId: string,
  browserUser: Awaited<ReturnType<typeof dedicatedUser>>,
) {
  let metadata;
  try {
    metadata = await stat(storagePath);
  } catch {
    return { state: "missing" as const };
  }
  if (
    !metadata.isDirectory() ||
    browserUser.uid === null ||
    metadata.uid !== browserUser.uid ||
    (metadata.mode & 0o077) !== 0
  ) {
    return { state: "insecure" as const };
  }
  let manifest;
  try {
    manifest = hostStateSchema.parse(
      JSON.parse(await readFile(join(storagePath, "host-state.json"), "utf8")),
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    return {
      state: code === "ENOENT" ? ("partial" as const) : ("corrupt" as const),
    };
  }
  return {
    state:
      manifest.installationId === installationId && manifest.hostId === hostId
        ? ("ready" as const)
        : ("corrupt" as const),
  };
}

async function diskHeadroom(storagePath: string) {
  const filesystem = await statfs(storagePath).catch(() => statfs("/"));
  return {
    freeBytes: filesystem.bavail * filesystem.bsize,
    totalBytes: filesystem.blocks * filesystem.bsize,
  };
}

async function loopbackAvailability() {
  return new Promise<{ available: boolean }>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve({ available: false }));
    server.listen(0, "127.0.0.1", () => {
      server.close((error) => resolve({ available: error === undefined }));
    });
  });
}

async function redactedLogSource(storagePath: string) {
  const contents = await readFile(join(storagePath, "exit.log"), "utf8").catch(
    () => "",
  );
  return contents.split("\n").filter(Boolean).slice(-50);
}

export function hostInstallationId(dataDir: string) {
  const daemonDataDir = resolve(dataDir, "../../..");
  return createHash("sha256").update(daemonDataDir).digest("hex").slice(0, 32);
}

export function provisionedBrowserStorageRoot(configuredRoot?: string) {
  if (
    configuredRoot !== undefined &&
    resolve(configuredRoot) !== BROWSER_STORAGE_ROOT
  ) {
    throw new Error(
      `The mandatory provisioned-host gate must use the protected Browser storage root ${BROWSER_STORAGE_ROOT}.`,
    );
  }
  return BROWSER_STORAGE_ROOT;
}

function hostStoragePath(
  paths: HostProbePaths,
  installationId: string,
  hostId: string,
) {
  return join(
    paths.protectedStorageRoot,
    "installations",
    installationId,
    "hosts",
    browserHostStorageSegment(hostId),
  );
}

async function connectEnrollment(dataDir: string) {
  if (process.env.BB_CONNECT_MACHINE_CREDENTIAL?.trim()) {
    return { enrolled: true };
  }
  const configPath = resolve(dataDir, "../../../config.json");
  const contents = await readFile(configPath, "utf8").catch(() => null);
  if (
    contents !== null &&
    connectConfigSchema.safeParse(jsonDocument(contents)).success
  ) {
    return { enrolled: true };
  }
  return {
    enrolled: readDaemonConnectPairing(daemonRootFromHostDataDir(dataDir)),
  };
}

export function createDefaultHostSnapshotReader(
  dataDir: string,
  paths: HostProbePaths = DEFAULT_PROBE_PATHS,
): HostSnapshotReader {
  const installationId = hostInstallationId(dataDir);
  return {
    async snapshot(target) {
      const storagePath = hostStoragePath(paths, installationId, target.hostId);
      const browserUser = await dedicatedUser(paths);
      const [
        operatingSystemContents,
        connect,
        browser,
        sandbox,
        storage,
        disk,
        loopback,
        exitLogs,
      ] = await Promise.all([
        readFile(paths.osRelease, "utf8").catch(() => ""),
        connectEnrollment(dataDir),
        browserAvailability(paths, storagePath, browserUser),
        sandboxAvailability(paths),
        protectedStorage(
          storagePath,
          installationId,
          target.hostId,
          browserUser,
        ),
        diskHeadroom(storagePath),
        loopbackAvailability(),
        redactedLogSource(storagePath),
      ]);
      return {
        operatingSystem: parseOsRelease(operatingSystemContents),
        architecture: process.arch,
        connect,
        browser,
        sandbox,
        dedicatedUser: { state: browserUser.state },
        protectedStorage: storage,
        disk,
        loopback,
        processes: [
          { name: "host-worker", state: "running", pid: process.pid },
          { name: "browser", state: "stopped" },
        ],
        exitLogs,
      };
    },
  };
}
