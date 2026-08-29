/**
 * Shared helpers for issue #21 cross-cutting evidence tests.
 *
 * These tests prove privacy, recovery, and performance boundaries by driving
 * the real black-box public-plugin harness, retained host worker,
 * transactional storage, in-memory browser engine, panel protocol, CLI,
 * browser_script, and the local authenticated fixture. They reuse the existing
 * fixtures (`deterministicLoginFixture`, `real-browser-worker`,
 * `createPublicPluginHarness`) and contract constants; they do not duplicate
 * the focused contract suites.
 *
 * Boundaries that require a provisioned Chrome/host this environment cannot
 * provision are registered with `it.runIf(integrationEnabled)(...)` so they
 * surface as skipped (not passed) when the provisioned-host gate is off, and
 * fail the run at module load when `BB_BROWSER_REAL_INTEGRATION_REQUIRED=1`
 * is set without integration enabled (the repo's "mandatory real-browser gate
 * cannot be skipped" invariant). The host is never mutated and Chrome is never
 * provisioned by these helpers.
 */

import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserInstanceRuntime } from "../../browser-runtime.js";
import type { BrowserInstanceRuntime } from "../../browser-runtime.js";
import type { HostProbeSnapshot } from "../../readiness.js";
import type { BrowserProfileStore } from "../../profile-storage.js";
import { DEFAULT_PROFILE_ID } from "../../contracts.js";
import { createPublicPluginHarness } from "../public-plugin-harness";

export { createPublicPluginHarness };

/**
 * The real provisioned-browser/host capability is present only when the
 * integration gate opts in. Provisioned-host evidence tests register with
 * `it.runIf(integrationEnabled)(...)` so a non-provisioned host reports them
 * as skipped (not passed), keeping the version-one limitation visible to the
 * release gate.
 */
export const integrationEnabled =
  process.env.BB_BROWSER_REAL_INTEGRATION === "1";

const integrationRequired =
  process.env.BB_BROWSER_REAL_INTEGRATION_REQUIRED === "1";

if (integrationRequired && !integrationEnabled) {
  throw new Error("The mandatory real-browser gate cannot be skipped.");
}

/**
 * The real provisioned-browser/host capability is present only when the
 * integration gate opts in. Used by provisioned-host evidence test bodies to
 * confirm they only run when the gate is genuinely on.
 */
export function realBrowserProvisioned(): boolean {
  return integrationEnabled;
}

/**
 * Sensitive-data scan patterns shared across logs, Activity Records,
 * diagnostics, database state, transport errors, and retained manifests.
 * These match the categories the spec excludes from plugin persistence
 * (passwords, credentials, cookies, tokens, secrets, page contents, scripts,
 * purposes, screenshots, clipboard, full URLs, form input).
 */
export const SENSITIVE_DATA_PATTERNS: readonly {
  label: string;
  pattern: RegExp;
}[] = [
  { label: "password", pattern: /password/i },
  { label: "credential", pattern: /credential/i },
  { label: "cookie", pattern: /cookie/i },
  { label: "bearer-token", pattern: /bearer\s+[A-Za-z0-9._-]+/i },
  { label: "api-key", pattern: /api[_-]?key/i },
  { label: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "local-token", pattern: /local-token/i },
  { label: "session-token", pattern: /session-token/i },
  { label: "screenshot-payload", pattern: /iVBORw0KGgo|data:image\/png/i },
  { label: "clipboard-content", pattern: /clipboard-contents/i },
  { label: "fixture-session-cookie", pattern: /fixture-session=valid/i },
];

/**
 * Scan a serializable evidence blob for sensitive data. Returns the labels that
 * matched so a test can report exactly which category leaked.
 */
export function findSensitiveData(haystack: string): string[] {
  const matches: string[] = [];
  for (const { label, pattern } of SENSITIVE_DATA_PATTERNS) {
    if (pattern.test(haystack)) matches.push(label);
  }
  return matches;
}

/**
 * A fake launch boundary for the real `createBrowserInstanceRuntime`. It models
 * a loopback-only, unprivileged browser process without provisioning Chrome:
 * the launched "process" is a recorded fixture with a loopback automation
 * endpoint, so the real lifecycle state machine (sleep, wake, crash loop,
 * reconnect, lazy wake) is exercised against in-memory bookkeeping rather than
 * a real OS process.
 */
export interface InMemoryLaunchLog {
  launches: number;
  stops: number;
  lastEndpoint: string;
  crashOnLaunch: boolean;
}

export async function createInMemoryBrowserRuntime(options?: {
  idleSleepMs?: number;
}): Promise<{
  runtime: BrowserInstanceRuntime;
  launchLog: InMemoryLaunchLog;
  rootDirectory: string;
  cleanup: () => Promise<void>;
}> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "bb-evidence-runtime-"));
  const browserExecutable = join(rootDirectory, "chrome-fixture");
  await writeFile(browserExecutable, "fixture");
  await chmod(browserExecutable, 0o755);
  const launchLog: InMemoryLaunchLog = {
    launches: 0,
    stops: 0,
    lastEndpoint: "http://127.0.0.1:0",
    crashOnLaunch: false,
  };
  const runtime = createBrowserInstanceRuntime({
    rootDirectory,
    installationId: "installation-evidence",
    chromeStablePaths: [browserExecutable],
    playwrightChromiumPath: join(rootDirectory, "fallback-chromium"),
    ...(options?.idleSleepMs === undefined
      ? {}
      : { idleSleepMs: options.idleSleepMs }),
    launchBoundary: {
      runAsUser: "bb-browser",
      effectiveUserId: 1001,
      effectiveGroupId: 1001,
      async launch() {
        launchLog.launches += 1;
        if (launchLog.crashOnLaunch) {
          throw new Error("The in-memory browser fixture crashed on launch.");
        }
        const pid = 4000 + launchLog.launches;
        launchLog.lastEndpoint = `http://127.0.0.1:${14000 + pid}`;
        return {
          pid,
          automationEndpoint: launchLog.lastEndpoint,
          exited: new Promise<void>(() => {}),
          async stop() {
            launchLog.stops += 1;
          },
        };
      },
      async recover() {
        return null;
      },
      async processIdentity(pid) {
        return {
          pid,
          startedAtTicks: `fixture-${pid}`,
          commandHash: `fixture-command-${pid}`,
        };
      },
      async execute() {
        return "fixture-output";
      },
      async configuredSearchUrl({ text }) {
        return `https://search.fixture.test/?q=${encodeURIComponent(text)}`;
      },
    },
  });
  return {
    runtime,
    launchLog,
    rootDirectory,
    cleanup: async () => {
      await runtime.dispose();
    },
  };
}

/**
 * A minimal healthy host-setup boundary used to satisfy the retained host
 * worker's readiness contract without provisioning anything. It reuses the
 * `HostSetupBoundary` shape the public harness expects.
 */
/**
 * A healthy host probe snapshot, matching the shape the public harness uses
 * to mark a host ready. Reused by every evidence file so the retained host
 * worker's readiness contract is satisfied without provisioning anything.
 */
export const preparedEvidenceSnapshot: HostProbeSnapshot = {
  operatingSystem: { id: "ubuntu", version: "24.04", name: "Ubuntu 24.04 LTS" },
  architecture: "x64",
  connect: { enrolled: true },
  browser: {
    name: "Google Chrome",
    version: "140.0.7339.80",
    compatible: true,
  },
  sandbox: { available: true },
  dedicatedUser: { state: "ready" },
  protectedStorage: { state: "ready" },
  disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
  loopback: { available: true },
  processes: [],
  exitLogs: [],
};

/**
 * Build a black-box evidence harness wired to the real server plugin, real
 * retained host worker, real transactional database, and a real in-memory
 * browser engine (via `createBrowserInstanceRuntime` + a fake loopback launch
 * boundary). The returned `runtime`/`launchLog` let callers observe lifecycle
 * transitions; `cleanup` disposes both the harness and the runtime.
 */
export async function createEvidenceHarness(options?: {
  idleSleepMs?: number;
  /**
   * A caller-supplied Browser Profile store wired into the public harness so
   * evidence flows drive it directly. Used by the sensitive-data scan to scan
   * the SAME store the sensitive flow drives (not a separate never-exposed
   * store). When omitted the harness builds its own private store.
   */
  profileStore?: BrowserProfileStore;
}) {
  const engine = await createInMemoryBrowserRuntime({
    ...(options?.idleSleepMs === undefined
      ? {}
      : { idleSleepMs: options.idleSleepMs }),
  });
  const harness = await createPublicPluginHarness({
    snapshot: preparedEvidenceSnapshot,
    browserRuntime: engine.runtime,
    ...(options?.profileStore === undefined
      ? {}
      : { profileStore: options.profileStore }),
  });
  // Pre-warm the default profile instance so the agent browser_script path
  // (which refuses to dispatch while the retained instance reports sleeping)
  // can drive the real engine seam. This mirrors a visible panel pinning the
  // instance awake; it does not bypass any authorization or origin policy.
  const warmTarget = {
    hostId: "host-browser-test",
    profileId: DEFAULT_PROFILE_ID,
    locale: "en-GB",
    timezone: "Europe/London",
  };
  await engine.runtime.pinPanel(warmTarget, "evidence-warm-panel");
  return {
    harness,
    runtime: engine.runtime,
    launchLog: engine.launchLog,
    cleanup: async () => {
      await engine.runtime.unpinPanel(warmTarget, "evidence-warm-panel");
      await harness.dispose();
      await engine.cleanup();
    },
  };
}
