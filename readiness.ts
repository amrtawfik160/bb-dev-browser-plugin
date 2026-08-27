import { constants } from "node:fs";
import { access, readFile, stat, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { z } from "zod";
import type {
  BrowserDiagnostics,
  BrowserHostTarget,
  BrowserStatus,
  BrowserStatusTarget,
  ReadinessCapability,
} from "./contracts.js";

const FIVE_GIB = 5 * 1024 ** 3;
const PROTECTED_STORAGE_PATH = "/var/lib/bb-browser";
const HOST_STATE_PATH = `${PROTECTED_STORAGE_PATH}/host-state.json`;
const EXIT_LOG_PATH = `${PROTECTED_STORAGE_PATH}/exit.log`;

const hostStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.string().min(1),
    hostId: z.string().min(1),
  })
  .strict();

export interface HostProbeSnapshot {
  operatingSystem: { id: string; version: string; name: string };
  architecture: string;
  browser: { name: string; version: string | null } | null;
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

function targetWithoutEnrollment(
  target: BrowserHostTarget,
): BrowserStatusTarget {
  return { hostId: target.hostId, profileId: target.profileId };
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
      target.connectEnrolled ? "ready" : "missing",
      target.connectEnrolled
        ? "The host is enrolled in BB Connect."
        : "Enroll this host in BB Connect before Browser setup.",
    ),
    capability(
      "browser",
      "Browser",
      snapshot.browser === null ? "missing" : "ready",
      snapshot.browser === null
        ? "Install supported Chrome Stable or the pinned Chromium fallback."
        : `${snapshot.browser.name}${snapshot.browser.version === null ? "" : ` ${snapshot.browser.version}`} is available.`,
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
      snapshot.dedicatedUser.state === "ready"
        ? "ready"
        : snapshot.dedicatedUser.state === "missing"
          ? "missing"
          : "failed",
      snapshot.dedicatedUser.state === "ready"
        ? "The unprivileged bb-browser user is configured."
        : snapshot.dedicatedUser.state === "missing"
          ? "Create the unprivileged bb-browser user through explicit Browser setup."
          : "Repair the bb-browser user so it is unprivileged and cannot log in.",
    ),
    capability(
      "protected-storage",
      "Protected storage",
      snapshot.protectedStorage.state === "ready"
        ? "ready"
        : ["missing", "partial"].includes(snapshot.protectedStorage.state)
          ? "missing"
          : "failed",
      snapshot.protectedStorage.state === "ready"
        ? "Browser storage is owner-only and its host state is valid."
        : snapshot.protectedStorage.state === "missing"
          ? "Create protected Browser storage through explicit Browser setup."
          : snapshot.protectedStorage.state === "partial"
            ? "Resume Browser setup to finish protected storage."
            : snapshot.protectedStorage.state === "corrupt"
              ? "Repair the corrupt Browser host state before continuing."
              : "Repair Browser storage ownership and permissions before continuing.",
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

  if (!platformSupported) {
    return {
      ...targetWithoutEnrollment(target),
      state: "unsupported",
      code: "unsupported",
      label: "Unsupported",
      message: "Workspace Browser supports Ubuntu and Debian on x86_64 only.",
      capabilities,
    };
  }

  const repairRequired =
    ["corrupt", "insecure"].includes(snapshot.protectedStorage.state) ||
    snapshot.dedicatedUser.state === "invalid" ||
    snapshot.disk.freeBytes < FIVE_GIB ||
    !snapshot.loopback.available;
  if (repairRequired) {
    return {
      ...targetWithoutEnrollment(target),
      state: "repair-required",
      code: "repair_required",
      label: "Repair required",
      message: "Repair the failed host checks before using Workspace Browser.",
      capabilities,
    };
  }

  if (capabilities.some((item) => item.status !== "ready")) {
    return {
      ...targetWithoutEnrollment(target),
      state: "setup-required",
      code: "setup_required",
      label: "Setup required",
      message:
        "Complete the missing host checks through explicit Browser setup.",
      capabilities,
    };
  }

  return {
    ...targetWithoutEnrollment(target),
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
          { name: "bb-plugin-browser", version: "0.1.0" },
          { name: "@get-bb/plugin-sdk", version: "0.4.21" },
          { name: "dev-browser", version: "0.2.9" },
          { name: "playwright", version: "1.58.2" },
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

async function browserAvailability() {
  const candidates = [
    { path: "/usr/bin/google-chrome-stable", name: "Google Chrome Stable" },
    { path: "/usr/bin/google-chrome", name: "Google Chrome" },
    {
      path: `${PROTECTED_STORAGE_PATH}/browsers/chromium/chrome`,
      name: "Pinned Playwright Chromium",
    },
  ];
  const browser = (
    await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        available: await fileExists(candidate.path),
      })),
    )
  ).find((candidate) => candidate.available);
  if (browser === undefined) return null;
  const packageStatus = await readFile("/var/lib/dpkg/status", "utf8").catch(
    () => "",
  );
  const packageName = browser.name.startsWith("Google")
    ? "google-chrome-stable"
    : "playwright";
  return {
    name: browser.name,
    version:
      packageName === "playwright"
        ? "1.58.2"
        : packageVersion(packageStatus, packageName),
  };
}

async function sandboxAvailability() {
  const userNamespaceSetting = await readFile(
    "/proc/sys/kernel/unprivileged_userns_clone",
    "utf8",
  ).catch(() => "0");
  if (userNamespaceSetting.trim() === "1") return { available: true };
  for (const path of [
    "/opt/google/chrome/chrome-sandbox",
    "/usr/lib/chromium/chrome-sandbox",
  ]) {
    try {
      const metadata = await stat(path);
      if ((metadata.mode & 0o4000) !== 0 && metadata.uid === 0) {
        return { available: true };
      }
    } catch {
      // The next supported sandbox location may still be available.
    }
  }
  return { available: false };
}

async function dedicatedUser() {
  const passwd = await readFile("/etc/passwd", "utf8").catch(() => "");
  const fields = passwd
    .split("\n")
    .find((line) => line.startsWith("bb-browser:"))
    ?.split(":");
  if (fields === undefined) {
    return { state: "missing" as const, uid: null };
  }
  const uid = Number(fields[2]);
  const shell = fields[6] ?? "";
  const unprivileged = Number.isInteger(uid) && uid > 0;
  const noLogin = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"].includes(
    shell,
  );
  return {
    state: unprivileged && noLogin ? ("ready" as const) : ("invalid" as const),
    uid,
  };
}

async function protectedStorage(
  hostId: string,
  browserUser: Awaited<ReturnType<typeof dedicatedUser>>,
) {
  let metadata;
  try {
    metadata = await stat(PROTECTED_STORAGE_PATH);
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
      JSON.parse(await readFile(HOST_STATE_PATH, "utf8")),
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
      manifest.hostId === hostId ? ("ready" as const) : ("corrupt" as const),
  };
}

async function diskHeadroom() {
  const filesystem = await statfs(PROTECTED_STORAGE_PATH).catch(() =>
    statfs("/"),
  );
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

async function redactedLogSource() {
  const contents = await readFile(EXIT_LOG_PATH, "utf8").catch(() => "");
  return contents.split("\n").filter(Boolean).slice(-50);
}

export const defaultHostSnapshotReader: HostSnapshotReader = {
  async snapshot(target) {
    const browserUser = await dedicatedUser();
    const [
      operatingSystemContents,
      browser,
      sandbox,
      storage,
      disk,
      loopback,
      exitLogs,
    ] = await Promise.all([
      readFile("/etc/os-release", "utf8").catch(() => ""),
      browserAvailability(),
      sandboxAvailability(),
      protectedStorage(target.hostId, browserUser),
      diskHeadroom(),
      loopbackAvailability(),
      redactedLogSource(),
    ]);
    return {
      operatingSystem: parseOsRelease(operatingSystemContents),
      architecture: process.arch,
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
