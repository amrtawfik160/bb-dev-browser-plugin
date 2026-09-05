import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createActivityOutbox,
  type ActivityOutbox,
} from "../activity/activity-outbox.js";
import { browserHostContract } from "../shared/host-contract.js";
import {
  createBrowserUserProfileOwnershipBoundary,
  createFileBrowserProfileStore,
  type BrowserProfileLifecycleBoundary,
  type BrowserProfileStore,
} from "./profile-storage.js";
import {
  createFileBrowserProfileRecovery,
  type BrowserProfileRecovery,
} from "./profile-recovery.js";
import {
  createFileHostAdministrationStateStore,
  createHostAdministrationBoundary,
  createProductionPrivilegedExecutor,
  createReadOnlyHostAdministrationBoundary,
  type HostAdministrationBoundary,
} from "./host-operations.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  type HostReadinessBoundary,
} from "./readiness.js";
import {
  BROWSER_STORAGE_ROOT,
  DEFAULT_PROFILE_ID,
  STOP_BROWSER_CONFIRMATION,
  browserProfileUnavailableStatus,
  hostCanDispatchAutomation,
  hostOfflineStatus,
  hostProbeFailedStatus,
  sleepingBrowserStatus,
  wakingBrowserStatus,
  type BrowserActivityEvent,
  type BrowserScriptRequest,
  type BrowserScriptResponse,
  type BrowserScriptRuntimeError,
  type BrowserNavigationRequest,
  type BrowserHistoryRequest,
  type BrowserTabActionRequest,
  type BrowserHostPanelVisibilityRequest,
  type BrowserPanelReleaseHostRequest,
  type BrowserPanelTransportRequest,
  type BrowserPanelTransportResponse,
  type BrowserPanelControlResponse,
  type BrowserPanelControlState,
  type BrowserStatus,
  type BrowserTabStrip,
  BROWSER_DOWNLOAD_MAX_FILE_BYTES,
  BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
  BROWSER_DOWNLOAD_TTL_MS,
  type BrowserDownloadExportActor,
  type BrowserDownloadStartInput,
  type BrowserDownloadStartResponse,
  type BrowserDownloadAppendInput,
  type BrowserDownloadAppendOutcome,
  type BrowserDownloadCompleteInput,
  type BrowserDownloadCompleteOutcome,
  type BrowserDownloadFailInput,
  type BrowserDownloadFailOutcome,
  type BrowserDownloadCancelInput,
  type BrowserDownloadCancelOutcome,
  type BrowserDownloadListInput,
  type BrowserDownloadListResult,
  type BrowserDownloadLimits,
  type BrowserDownloadLimitsInput,
  type BrowserDownloadTargetInput,
  type BrowserDownloadProgressResult,
  type BrowserDownloadExportClientInput,
  type BrowserDownloadExportWorkspaceInput,
  type BrowserDownloadExportOutcome,
  type BrowserDownloadPurgeInput,
  type BrowserDownloadPurgeOutcome,
} from "../shared/contracts.js";
import { createPanelCapabilityStore } from "../panel/panel-capability.js";
import { createPanelGatewayPool } from "../panel/panel-gateway-pool.js";
import {
  createPanelTransportServer,
  type ScreencastSource,
} from "../panel/panel-transport.js";
import { createCdpScreencastSource } from "../browser/browser-screencast.js";
import { createAutomationStreamAdapter } from "../panel/panel-stream.js";
import {
  ControlLeaseError,
  createControlLeaseManager,
  type ControlLease,
  type ControlLeaseManager,
} from "../browser/control-lease.js";
import { createPanelSessionRegistry } from "../panel/panel-session.js";
import {
  assertBrowserScriptResultWithinBounds,
  BrowserInstanceError,
  BrowserOriginScopeDeniedError,
  BrowserScriptExecutionError,
  createBrowserInstanceRuntime,
  type BrowserInstanceRuntime,
  type BrowserRuntimeTarget,
} from "../browser/browser-runtime.js";
import { createProductionBrowserProcessBoundary } from "../browser/browser-process.js";
import {
  daemonRootFromHostDataDir,
  readDaemonPluginSourcePath,
} from "./daemon-data.js";
import { requireDevBrowserRuntime } from "../browser/dev-browser-runtime.js";
import { PINNED_BROWSER_RUNTIME } from "../shared/dependency-inventory.js";
import {
  SafeLoginAgentDeniedError,
  createSafeLoginMode,
  type SafeLoginModeManager,
} from "../browser/safe-login.js";
import {
  createTransferStagingManager,
  resolveTransferStagingRoot,
  type TransferStagingManager,
  type TransferStagingFilesystem,
} from "./transfer-staging.js";
import { createNodeTransferStagingFilesystem } from "./transfer-staging-filesystem.js";
import { createClipboardExchange } from "../panel/clipboard-exchange.js";
import {
  createHostDownloadsManager,
  resolveHostDownloadsRoot,
  type HostDownloadsManager,
  type HostDownloadFilesystem,
} from "./host-downloads.js";
import { createNodeHostDownloadsFilesystem } from "./host-downloads-filesystem.js";

export type HostSetupBoundary = HostReadinessBoundary;
type HostBoundary = HostReadinessBoundary | HostAdministrationBoundary;
type HostBoundarySource = HostBoundary | ((dataDir: string) => HostBoundary);
type ProfileStoreSource =
  | BrowserProfileStore
  | ((
      dataDir: string,
      lifecycle: BrowserProfileLifecycleBoundary,
    ) => BrowserProfileStore);
type ProfileRecoverySource =
  BrowserProfileRecovery | ((dataDir: string) => BrowserProfileRecovery);
type BrowserRuntimeHost = Omit<
  BrowserInstanceRuntime,
  "activeTabId" | "checkRendererProcessLimit"
> & {
  /** Optional for small injected host test doubles. */
  activeTabId?: (
    target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">,
  ) => Promise<string | undefined>;
  /** Optional for small injected host test doubles. */
  checkRendererProcessLimit?: (
    target: Pick<BrowserRuntimeTarget, "hostId" | "profileId">,
  ) => Promise<void>;
};
type BrowserRuntimeSource =
  BrowserRuntimeHost | ((dataDir: string) => BrowserRuntimeHost);
type SafeLoginModeSource =
  SafeLoginModeManager | ((dataDir: string) => SafeLoginModeManager);
type TransferStagingSource =
  TransferStagingManager | ((dataDir: string) => TransferStagingManager);
type HostDownloadsSource =
  HostDownloadsManager | ((dataDir: string) => HostDownloadsManager);

export type BrowserHostPanelStreamOptions = {
  clock?: { now(): number };
  frameSource?: (binding: {
    hostId: string;
    profileId: string;
    panelId: string;
  }) => ScreencastSource;
};

type ScriptSignalContext = { signal: AbortSignal };
type ScriptActivityOutcome = "succeeded" | "failed" | "interrupted";
type ScriptActivityRecording = { leaseRevokedAfterCompletion?: boolean };

function controlLeaseKey(target: { hostId: string; profileId: string }) {
  return `${target.hostId}\0${target.profileId}`;
}

/**
 * Host-side export authorization (issue #20 findings, S2). The host owns the
 * Control Lease manager, so it computes the REAL lease state for the
 * actor/profile and never fabricates it. The file-transfer elevated grant is
 * NOT computed here: the host worker has no access to the grant store (it
 * lives in the server-side browser service, the only layer with grant-store
 * access), so the host cannot verify grants without fabricating them. The
 * grant remains the single authoritative gate in browser-service's
 * `authorizeAgentDownloadExport`, which checks grant + lease before the host
 * is ever called. By enforcing the real lease here, a direct host-RPC caller
 * claiming `actor: "agent"` without a real active Control Lease is denied —
 * it never gets unconditional authorization.
 */
function downloadAuthorization(
  request: {
    hostId: string;
    profileId?: string;
    actor?: BrowserDownloadExportActor;
  },
  controlLeases: ControlLeaseManager,
): {
  actor: BrowserDownloadExportActor;
  leaseActive: boolean;
} {
  const actor = request.actor ?? "owner";
  if (actor === "owner") {
    return { actor: "owner", leaseActive: false };
  }
  const key = controlLeaseKey({
    hostId: request.hostId,
    profileId: request.profileId ?? DEFAULT_PROFILE_ID,
  });
  const lease = controlLeases.state(key);
  return { actor: "agent", leaseActive: lease !== undefined };
}

/**
 * Non-provisioned-host fallback (issue #20 findings, S6). Every `download*`
 * host handler fails closed when Host Downloads is not provisioned (the host
 * data directory is absent and the quarantine manager cannot be constructed).
 * Rather than repeat the fallback literal in ~11 handlers, they route through
 * this single helper, which returns the privacy-safe, schema-valid default for
 * the operation: a `rejected`/`missing` outcome for mutating RPCs, an empty
 * listing with the documented default limits for `downloadList`, the default
 * limits for `downloadLimits`, `null` for `downloadProgress`, a `missing`
 * fail outcome with `removed: 0`, and a no-op `purged` outcome for
 * `downloadPurge`. The host is never mutated in any of these paths.
 */
function downloadNotProvisionedFallback(
  operation: "start",
  request: BrowserDownloadStartInput,
): BrowserDownloadStartResponse;
function downloadNotProvisionedFallback(
  operation: "append",
  request: BrowserDownloadAppendInput,
): BrowserDownloadAppendOutcome;
function downloadNotProvisionedFallback(
  operation: "complete",
  request: BrowserDownloadCompleteInput,
): BrowserDownloadCompleteOutcome;
function downloadNotProvisionedFallback(
  operation: "fail",
  request: BrowserDownloadFailInput,
): BrowserDownloadFailOutcome;
function downloadNotProvisionedFallback(
  operation: "cancel",
  request: BrowserDownloadCancelInput,
): BrowserDownloadCancelOutcome;
function downloadNotProvisionedFallback(
  operation: "list",
  request: BrowserDownloadListInput,
): BrowserDownloadListResult;
function downloadNotProvisionedFallback(
  operation: "limits",
  request: BrowserDownloadLimitsInput,
): BrowserDownloadLimits;
function downloadNotProvisionedFallback(
  operation: "progress",
  request: BrowserDownloadTargetInput,
): BrowserDownloadProgressResult;
function downloadNotProvisionedFallback(
  operation: "exportClient" | "exportWorkspace",
  request:
    BrowserDownloadExportClientInput | BrowserDownloadExportWorkspaceInput,
): BrowserDownloadExportOutcome;
function downloadNotProvisionedFallback(
  operation: "purge",
  request: BrowserDownloadPurgeInput,
): BrowserDownloadPurgeOutcome;
function downloadNotProvisionedFallback(
  operation: string,
  request: { downloadId?: string; profileId?: string | null },
): unknown {
  const downloadId = request.downloadId ?? "";
  switch (operation) {
    case "start":
      return {
        outcome: "rejected",
        downloadId,
        reason: "low-disk",
        message:
          "The host data directory is not provisioned for Host Downloads.",
      };
    case "append":
      return {
        outcome: "rejected",
        downloadId,
        reason: "not-found",
        message: "Host Downloads is not provisioned.",
      };
    case "complete":
      return { outcome: "missing", downloadId };
    case "fail":
      return { outcome: "missing", downloadId, profileId: null, removed: 0 };
    case "cancel":
      return { outcome: "missing", downloadId };
    case "list":
      return {
        downloads: [],
        limits: {
          maxFileBytes: BROWSER_DOWNLOAD_MAX_FILE_BYTES,
          maxProfileBytes: BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
          expiryMs: BROWSER_DOWNLOAD_TTL_MS,
        },
        freeSpaceBytes: null,
      };
    case "limits":
      return {
        maxFileBytes: BROWSER_DOWNLOAD_MAX_FILE_BYTES,
        maxProfileBytes: BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
        expiryMs: BROWSER_DOWNLOAD_TTL_MS,
      };
    case "progress":
      return null;
    case "exportClient":
    case "exportWorkspace":
      return {
        outcome: "rejected",
        downloadId,
        reason: "not-found",
        message: "Host Downloads is not provisioned.",
      };
    case "purge":
      return {
        outcome: "purged",
        profileId: request.profileId ?? null,
        removed: 0,
      };
    default:
      throw new Error(`Unknown download fallback operation: ${operation}`);
  }
}

function scriptRuntimeErrorCode(
  error: unknown,
): BrowserScriptRuntimeError["code"] {
  return error instanceof BrowserScriptExecutionError
    ? error.code
    : "script_failed";
}

const scriptRuntimeErrorLabels: Record<
  BrowserScriptRuntimeError["code"],
  string
> = {
  browser_busy: "Browser busy",
  browser_timeout: "Browser script timed out",
  result_too_large: "Browser result too large",
  lease_revoked: "Browser Control Lease revoked",
  tab_invalid: "Browser Tab invalid",
  sandbox_violation: "Browser sandbox violation",
  script_failed: "Browser script failed",
  safe_login_denied: "Safe Login active",
};

export const SCRIPT_FAILURE_MESSAGE_LIMIT = 500;
const SCRIPT_FAILURE_MESSAGE_HEAD = 140;
const SCRIPT_FAILURE_ELISION = "\n  … ";
const STACK_FRAME_LINE = /^\s+at\s/u;

/**
 * Drop the trailing JavaScript stack trace from a script failure.
 *
 * QuickJS appends frames that point into the bundled Playwright shim rather
 * than the agent's own code, so they are never actionable and they crowd out
 * the diagnostic text that is.
 */
function withoutStackFrames(message: string) {
  const lines = message.split("\n");
  let end = lines.length;
  while (end > 1 && STACK_FRAME_LINE.test(lines[end - 1] ?? "")) end -= 1;
  const stripped = lines.slice(0, end).join("\n").trimEnd();
  return stripped.length === 0 ? message.trim() : stripped;
}

/**
 * Keep a bounded failure message readable from both ends.
 *
 * A Playwright timeout puts its summary first and the reason an action never
 * completed — an overlay intercepting pointer events, an element detaching —
 * last, at the end of a call log that is easily longer than the whole budget.
 * Cutting only the head discarded exactly the line that explains the failure,
 * so the bound now spends part of its budget on the tail.
 */
export function boundScriptFailureMessage(message: string) {
  const trimmed = withoutStackFrames(message.trim());
  if (trimmed.length <= SCRIPT_FAILURE_MESSAGE_LIMIT) return trimmed;
  const tailLength =
    SCRIPT_FAILURE_MESSAGE_LIMIT -
    SCRIPT_FAILURE_MESSAGE_HEAD -
    SCRIPT_FAILURE_ELISION.length;
  return [
    trimmed.slice(0, SCRIPT_FAILURE_MESSAGE_HEAD).trimEnd(),
    trimmed.slice(trimmed.length - tailLength).trimStart(),
  ].join(SCRIPT_FAILURE_ELISION);
}

function scriptRuntimeFailure(
  request: BrowserScriptRequest,
  error: unknown,
  lease?: ControlLease,
): BrowserScriptResponse {
  const code =
    lease?.signal.aborted === true
      ? "lease_revoked"
      : error instanceof ControlLeaseError
        ? error.code
        : scriptRuntimeErrorCode(error);
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "The Browser script failed.";
  const boundedMessage =
    boundScriptFailureMessage(message) || "The Browser script failed.";
  return {
    ok: false,
    error: {
      state: "runtime-error",
      code,
      label: scriptRuntimeErrorLabels[code],
      hostId: request.hostId,
      profileId: request.profileId,
      message: boundedMessage,
    },
  };
}

function originScopeDeniedFailure(
  request: BrowserScriptRequest,
  denial: BrowserOriginScopeDeniedError,
): BrowserScriptResponse {
  const cleanupNotice =
    denial.cause === undefined
      ? ""
      : " Origin Scope cleanup failed; the Browser Instance must be restarted before retrying.";
  const message =
    denial.origin === null
      ? `Browser navigation to a non-web URL was denied by the active Profile Grant.${cleanupNotice} The denied script will not resume automatically; after an owner decision, explicitly retry against current page state.`
      : `Browser navigation to ${denial.origin} was denied by the active Profile Grant.${cleanupNotice} The denied script will not resume automatically; after an owner decision, explicitly retry against current page state.`;
  return {
    ok: false,
    error: {
      state: "origin-denied",
      code: "origin_denied",
      label: "Origin denied",
      hostId: request.hostId,
      profileId: request.profileId,
      message,
      origin: denial.origin,
      grantRequest: null,
    },
  };
}

function scriptWasInterrupted(response: BrowserScriptResponse | undefined) {
  return (
    response?.ok === false &&
    response.error.state === "runtime-error" &&
    response.error.code === "lease_revoked"
  );
}

function isAdministrationBoundary(
  boundary: HostBoundary,
): boundary is HostAdministrationBoundary {
  return "setupPlan" in boundary;
}

async function requireReadyForProfileMutation(
  boundary: HostAdministrationBoundary,
  target: { hostId: string; profileId: string },
) {
  const status = await boundary.inspect(target);
  if (status.state !== "healthy") throw new Error(status.message);
}

function unverifiedDevBrowserProfileIsStopped() {
  return false;
}

function scriptActivityEvent(
  request: BrowserScriptRequest,
  context: ScriptSignalContext,
  outcome: ScriptActivityOutcome,
  startedAt: number,
  recording: ScriptActivityRecording = {},
): BrowserActivityEvent {
  const requestAborted = context.signal.aborted;
  const interrupted =
    requestAborted ||
    outcome === "interrupted" ||
    recording.leaseRevokedAfterCompletion === true;
  return {
    eventId: request.activityEventId,
    actor: "agent",
    projectId: request.projectId,
    hostId: request.hostId,
    profileId: request.profileId,
    destinationOrigin: request.destinationOrigin ?? null,
    occurredAt: request.activityOccurredAt,
    kind: "agent-operation",
    action: "browser-script",
    outcome: interrupted && outcome !== "succeeded" ? "interrupted" : outcome,
    interrupted,
    interruptionReason: interrupted
      ? requestAborted
        ? "request-aborted"
        : "control-lease-revoked"
      : null,
    durationMs: Math.min(Math.max(Date.now() - startedAt, 0), 30_000),
  };
}

async function recordScriptActivity(
  outbox: ActivityOutbox,
  request: BrowserScriptRequest,
  context: ScriptSignalContext,
  outcome: ScriptActivityOutcome,
  startedAt: number,
  recording: ScriptActivityRecording = {},
) {
  await outbox.enqueue(
    scriptActivityEvent(request, context, outcome, startedAt, recording),
  );
}

async function recordExpiredProfiles(
  outbox: ActivityOutbox,
  hostId: string,
  profileIds: readonly string[],
) {
  for (const profileId of profileIds) {
    await outbox.enqueue({
      eventId: `host-lifecycle-${randomUUID()}`,
      actor: "system",
      projectId: null,
      hostId,
      profileId,
      destinationOrigin: null,
      occurredAt: new Date().toISOString(),
      kind: "lifecycle",
      action: "archive-expired",
      outcome: "deleted",
      interrupted: false,
      interruptionReason: null,
      durationMs: null,
    });
  }
}

/**
 * Activity Record for a Host Download export (issue #20). Metadata-only: it
 * captures the actor, authorization context, host/profile, destination, and
 * outcome, never file contents, full URLs, page data, or clipboard data. The
 * destination is `client` or `workspace`; no web destination origin applies.
 *
 * P4 (issue #20 findings): exports are the only in-scope security outcome
 * recorded for Host Downloads, so this remains the single download Activity
 * Record. Quarantine rejections (a download blocked from entering quarantine,
 * so no data ever crossed the trust boundary), cancellations (the owner
 * removing their own quarantined data before export), and purges (profile
 * lifecycle cleanup that destroys quarantined data in place) are intentionally
 * NOT recorded: none of these events move quarantined data across the trust
 * boundary — data either never enters quarantine, or is destroyed on the host
 * without leaving it. Recording them would require a new `download` Activity
 * kind and a database schema migration (a table rebuild of
 * `browser_activity_records`), which is out of scope for this findings fix;
 * the export record is sufficient to audit the security-relevant moment when
 * quarantined bytes leave the host. Revisit if rejection/cancellation/purge
 * auditing becomes a compliance requirement.
 */
async function recordDownloadExport(
  outbox: ActivityOutbox,
  input: {
    hostId: string;
    profileId?: string;
    actor?: "owner" | "agent";
    destination: "client" | "workspace";
    outcome: "exported" | "denied";
  },
) {
  await outbox.enqueue({
    eventId: `host-download-${randomUUID()}`,
    actor: input.actor === "agent" ? "agent" : "owner",
    projectId: null,
    hostId: input.hostId,
    profileId: input.profileId ?? DEFAULT_PROFILE_ID,
    destinationOrigin: null,
    occurredAt: new Date().toISOString(),
    kind: "export",
    action: `host-download-export-${input.destination}`,
    outcome: input.outcome,
    interrupted: false,
    interruptionReason: null,
    durationMs: null,
  });
}

async function runtimeBrowserStatus(
  readiness: BrowserStatus,
  browserRuntime: BrowserRuntimeHost | undefined,
  controlLeases?: ControlLeaseManager,
) {
  const visibleReadiness = statusWithControlLease(readiness, controlLeases);
  if (readiness.state !== "healthy" || browserRuntime === undefined) {
    return visibleReadiness;
  }
  if (readiness.hostId === null) return visibleReadiness;
  const lifecycle = await browserRuntime.status({
    hostId: readiness.hostId,
    profileId: readiness.profileId,
  });
  if (lifecycle.state === "sleeping") {
    return statusWithControlLease(
      sleepingBrowserStatus(readiness),
      controlLeases,
    );
  }
  if (lifecycle.state === "waking") {
    return statusWithControlLease(
      wakingBrowserStatus(readiness),
      controlLeases,
    );
  }
  if (lifecycle.state === "host-offline") {
    return statusWithControlLease(hostOfflineStatus(readiness), controlLeases);
  }
  if (lifecycle.state === "repair-required") {
    return statusWithControlLease(
      crashRepairStatus(readiness, lifecycle.diagnostics.crashCount),
      controlLeases,
    );
  }
  return visibleReadiness;
}

function statusWithControlLease(
  readiness: BrowserStatus,
  controlLeases: ControlLeaseManager | undefined,
) {
  if (controlLeases === undefined || readiness.hostId === null)
    return readiness;
  const controlLease = controlLeases.state(
    controlLeaseKey({
      hostId: readiness.hostId,
      profileId: readiness.profileId,
    }),
  );
  return controlLease === undefined
    ? readiness
    : { ...readiness, controlLease };
}

function crashRepairStatus(readiness: BrowserStatus, crashCount: number) {
  return {
    ...hostProbeFailedStatus(readiness),
    message: `Browser crash recovery stopped after ${crashCount} crashes within five minutes. Generate redacted diagnostics and repair this profile.`,
  };
}

export function createBrowserHostEntry(
  source: HostBoundarySource,
  profileSource?: ProfileStoreSource,
  recoverySource?: ProfileRecoverySource,
  runtimeSource?: BrowserRuntimeSource,
  safeLoginSource?: SafeLoginModeSource,
  transferStagingSource?: TransferStagingSource,
  hostDownloadsSource?: HostDownloadsSource,
  panelStream?: BrowserHostPanelStreamOptions,
) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedBoundary: HostAdministrationBoundary | undefined;
  let retainedProfiles: BrowserProfileStore | undefined;
  let retainedRecovery: BrowserProfileRecovery | undefined;
  let retainedOutbox: ActivityOutbox | undefined;
  let retainedSafeLogin: SafeLoginModeManager | undefined =
    typeof safeLoginSource === "object" ? safeLoginSource : undefined;
  let retainedTransferStaging: TransferStagingManager | undefined =
    typeof transferStagingSource === "object"
      ? transferStagingSource
      : undefined;
  let retainedHostDownloads: HostDownloadsManager | undefined =
    typeof hostDownloadsSource === "object" ? hostDownloadsSource : undefined;
  let retainedRuntime: BrowserRuntimeHost | undefined =
    typeof runtimeSource === "object" ? runtimeSource : undefined;
  const controlLeases = createControlLeaseManager();
  const panelClock = panelStream?.clock ?? { now: () => Date.now() };
  const panelCapabilities = createPanelCapabilityStore({ clock: panelClock });
  const panelGateways = createPanelGatewayPool({
    capabilities: panelCapabilities,
    clock: panelClock,
  });
  const panelSessions = createPanelSessionRegistry({
    clock: panelClock,
    controlLeases,
  });

  function panelControlSession(target: { hostId: string; profileId: string }) {
    return panelSessions.sessionFor(target);
  }

  function browserTabStrip(target: { hostId: string; profileId: string }) {
    return panelControlSession(target).tabStrip();
  }

  async function synchronizeRuntimeTabStrip(
    browserRuntime: BrowserRuntimeHost,
    strip: ReturnType<typeof browserTabStrip>,
    target: { hostId: string; profileId: string },
    requestedActiveTabId?: string,
  ) {
    const pages = await browserRuntime.listPages(target);
    let protectedTabId = requestedActiveTabId;
    if (protectedTabId === undefined && pages.length > 0) {
      // The active-tab read fails when the browser has no front page. The
      // inventory is still authoritative: syncing it drops tabs the browser no
      // longer has, which is what keeps stale ids out of the strip.
      protectedTabId = await browserRuntime
        .activeTabId?.(target)
        .catch(() => undefined);
    }
    strip.syncPages(
      pages.map((page) => ({
        id: page.id,
        url: page.url,
        title: page.title,
        origin: page.openerTabId === null ? "page" : "popup",
        openerTabId: page.openerTabId,
      })),
      protectedTabId,
    );
  }

  /**
   * Dismiss every still-open agent dialog for a profile when the agent's
   * Control Lease ends (revoked or owner takes control), so an unresolved
   * dialog never leaves an invisible modal block. No-op when the profile has
   * no live transport.
   */
  function dismissOpenDialogsForProfile(target: {
    hostId: string;
    profileId: string;
  }) {
    panelSessions.sessionFor(target).dismissOpenDialogs();
  }

  function toControlResponse(
    target: { hostId: string; profileId: string },
    role: "controller" | "spectator",
  ): BrowserPanelControlResponse {
    return {
      role,
      control: panelControlSession(target).state(),
      tabs: browserTabStrip(target).snapshot() as BrowserTabStrip,
    };
  }
  /**
   * Feed the shared tab strip from real browser state. The runtime's page ids
   * stay authoritative, and its active page is protected while the strip
   * applies its retention cap.
   */
  async function reconcileRuntimeTabs(
    dataDir: string,
    target: { hostId: string; profileId: string },
    activeTabId?: string,
  ) {
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) return;
    const strip = browserTabStrip(target);
    try {
      await synchronizeRuntimeTabStrip(
        browserRuntime,
        strip,
        target,
        activeTabId,
      );
    } catch {
      // Without a readable inventory and verified foreground, leave the prior
      // strip intact until the next operation can reconcile it safely.
      return;
    }
    // Tabs past the retention cap are dropped from the strip; close their
    // pages too, or the browser keeps every renderer alive for the life of the
    // profile and the cap bounds nothing.
    const evicted = strip.takeEvictedTabIds();
    if (evicted.length > 0) await browserRuntime.closePages(target, evicted);
  }
  const hostConnectionGenerations = new Map<string, number>();
  function administration(dataDir: string) {
    if (retainedBoundary !== undefined) return retainedBoundary;
    const boundary = typeof source === "function" ? source(dataDir) : source;
    retainedBoundary = isAdministrationBoundary(boundary)
      ? boundary
      : createReadOnlyHostAdministrationBoundary({
          readiness: boundary,
          installationId: hostInstallationId(dataDir),
          stateStore: createFileHostAdministrationStateStore(dataDir),
        });
    return retainedBoundary;
  }
  function profileLifecycle(dataDir: string): BrowserProfileLifecycleBoundary {
    return {
      async stopProfile(hostId, profileId) {
        const key = controlLeaseKey({ hostId, profileId });
        controlLeases.revoke(key);
        // Stopping the profile ends every agent Control Lease: dismiss open
        // dialogs before tearing down so they never strand.
        dismissOpenDialogsForProfile({ hostId, profileId });
        // Stopping the profile releases every panel's control and invalidates
        // the shared tab strip so stale runtime tab ids fail closed.
        const session = panelSessions.sessionFor({ hostId, profileId });
        session.revoke();
        session.tabStrip().resetInstance();
        try {
          await runtime(dataDir)?.stop({ hostId, profileId });
        } finally {
          await administration(dataDir).stopProfile({ hostId, profileId });
        }
      },
    };
  }
  function runtime(dataDir: string) {
    if (retainedRuntime !== undefined) return retainedRuntime;
    if (runtimeSource === undefined) return undefined;
    retainedRuntime =
      typeof runtimeSource === "function"
        ? runtimeSource(dataDir)
        : runtimeSource;
    return retainedRuntime;
  }
  /**
   * The owner-only Safe Login policy owns the per-profile mode. The host is
   * the only place that can relaunch a profile without a dev-browser or
   * automation attachment, so it holds the authoritative machine and denies
   * browser_script (and therefore the CLI, which relays through it) while a
   * profile is in Safe Login Mode. Tests inject a pre-activated machine.
   */
  function safeLogin(dataDir: string) {
    if (retainedSafeLogin !== undefined) return retainedSafeLogin;
    retainedSafeLogin =
      safeLoginSource === undefined
        ? createSafeLoginMode()
        : typeof safeLoginSource === "function"
          ? safeLoginSource(dataDir)
          : safeLoginSource;
    return retainedSafeLogin;
  }
  function safeLoginDeniedResponse(
    request: BrowserScriptRequest,
    denial: SafeLoginAgentDeniedError,
  ): BrowserScriptResponse {
    return {
      ok: false,
      error: {
        state: "runtime-error",
        code: "safe_login_denied",
        label: scriptRuntimeErrorLabels.safe_login_denied,
        hostId: request.hostId,
        profileId: request.profileId,
        message: denial.message,
      },
    };
  }
  async function disposeRuntime() {
    controlLeases.revokeAll();
    // Disposing the runtime ends every agent Control Lease: dismiss open
    // dialogs across every profile so none strand.
    panelSessions.forEach((session) => session.dismissOpenDialogs());
    const current = retainedRuntime;
    retainedRuntime = undefined;
    await current?.dispose();
  }
  function hostConnectionGenerationIsNewer(hostId: string, generation: number) {
    const previousGeneration = hostConnectionGenerations.get(hostId);
    return previousGeneration === undefined || generation > previousGeneration;
  }
  async function applyRuntimeHostConnection(
    browserRuntime: BrowserRuntimeHost,
    request: {
      hostId: string;
      state: "connected" | "disconnected";
    },
  ) {
    browserRuntime.hostDisconnected(request.hostId);
    if (request.state === "connected") {
      await browserRuntime.hostReconnected(request.hostId);
    }
  }
  async function reconcileHostConnection(
    request: {
      hostId: string;
      generation: number;
      state: "connected" | "disconnected";
    },
    dataDir: string,
  ) {
    if (!hostConnectionGenerationIsNewer(request.hostId, request.generation)) {
      return { ...request, applied: false };
    }
    if (request.state === "disconnected") {
      controlLeases.revokeHost(request.hostId);
      // A host disconnect ends every agent Control Lease on that host: dismiss
      // open dialogs so they cannot strand behind an invisible modal.
      panelSessions.forEach((session, target) => {
        if (target.hostId !== request.hostId) return;
        session.revoke();
        session.tabStrip().resetInstance();
        dismissOpenDialogsForProfile(target);
      });
    }
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) return { ...request, applied: false };
    hostConnectionGenerations.set(request.hostId, request.generation);
    await applyRuntimeHostConnection(browserRuntime, request);
    return { ...request, applied: true };
  }
  async function runInstallationLifecycle(
    action: "disable" | "uninstall",
    request: Parameters<HostAdministrationBoundary["disable"]>[0],
    dataDir: string,
  ) {
    if (request.confirmation === STOP_BROWSER_CONFIRMATION) {
      await disposeRuntime();
    }
    return administration(dataDir)[action](request);
  }
  function profiles(dataDir: string) {
    if (retainedProfiles !== undefined) return retainedProfiles;
    retainedProfiles =
      profileSource === undefined
        ? createFileBrowserProfileStore({
            rootDirectory: join(dataDir, "browser-profiles"),
            installationId: hostInstallationId(dataDir),
            lifecycle: profileLifecycle(dataDir),
          })
        : typeof profileSource === "function"
          ? profileSource(dataDir, profileLifecycle(dataDir))
          : profileSource;
    return retainedProfiles;
  }
  function outbox(dataDir: string) {
    if (retainedOutbox !== undefined) return retainedOutbox;
    retainedOutbox = createActivityOutbox({
      filePath: join(dataDir, "browser-activity-outbox.json"),
    });
    return retainedOutbox;
  }
  function recovery(dataDir: string) {
    if (retainedRecovery !== undefined) return retainedRecovery;
    retainedRecovery =
      recoverySource === undefined
        ? createFileBrowserProfileRecovery({
            rootDirectory: join(dataDir, "browser-profiles"),
            installationId: hostInstallationId(dataDir),
            state: {
              isProfileStopped: (hostId, profileId) =>
                administration(dataDir).isProfileStopped({
                  hostId,
                  profileId,
                }),
              isDevBrowserProfileStopped: unverifiedDevBrowserProfileIsStopped,
            },
            ownership: createBrowserUserProfileOwnershipBoundary(),
          })
        : typeof recoverySource === "function"
          ? recoverySource(dataDir)
          : recoverySource;
    return retainedRecovery;
  }
  function transferStaging(dataDir: string): TransferStagingManager | null {
    if (retainedTransferStaging !== undefined) return retainedTransferStaging;
    // Fail closed: the staging root is derived from the provisioned host data
    // directory through `resolveTransferStagingRoot`, which returns `null` when
    // the directory is absent so a non-provisioned host is never mutated.
    const stagingRoot = resolveTransferStagingRoot(dataDir);
    if (stagingRoot === null) return null;
    const filesystem: TransferStagingFilesystem =
      createNodeTransferStagingFilesystem();
    retainedTransferStaging =
      transferStagingSource === undefined
        ? createTransferStagingManager({
            filesystem,
            stagingRoot,
          })
        : typeof transferStagingSource === "function"
          ? transferStagingSource(dataDir)
          : transferStagingSource;
    return retainedTransferStaging;
  }
  function hostDownloads(dataDir: string): HostDownloadsManager | null {
    if (retainedHostDownloads !== undefined) return retainedHostDownloads;
    // Fail closed: the quarantine root is derived from the provisioned host
    // data directory through `resolveHostDownloadsRoot`, which returns `null`
    // when the directory is absent so a non-provisioned host is never mutated.
    const quarantineRoot = resolveHostDownloadsRoot(dataDir);
    if (quarantineRoot === null) return null;
    const filesystem: HostDownloadFilesystem =
      createNodeHostDownloadsFilesystem();
    retainedHostDownloads =
      hostDownloadsSource === undefined
        ? createHostDownloadsManager({ filesystem, quarantineRoot })
        : typeof hostDownloadsSource === "function"
          ? hostDownloadsSource(dataDir)
          : hostDownloadsSource;
    return retainedHostDownloads;
  }
  async function resolveActiveProfile(
    dataDir: string,
    hostId: string,
    profileId: string,
  ) {
    const inventory = await profiles(dataDir).listProfiles(hostId);
    const profile = inventory.profiles.find(
      (candidate) =>
        candidate.profileId === profileId && candidate.state === "active",
    );
    if (profile === undefined) {
      throw new Error("The requested Browser Profile is unavailable.");
    }
    return profile;
  }
  async function navigateBrowser(
    request: BrowserNavigationRequest,
    dataDir: string,
    signal?: AbortSignal,
  ) {
    const target = { hostId: request.hostId, profileId: request.profileId };
    const readiness = await administration(dataDir).inspect(target);
    if (readiness.state !== "healthy") throw new Error(readiness.message);
    const profile = await resolveActiveProfile(
      dataDir,
      request.hostId,
      request.profileId,
    );
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) {
      throw new Error("The Workspace Browser runtime is unavailable.");
    }
    const lease = await controlLeases.acquireOwner(
      controlLeaseKey(target),
      signal,
    );
    // An owner navigation ends the agent's Control Lease: dismiss any open
    // agent dialog so it cannot strand behind an invisible modal block.
    dismissOpenDialogsForProfile(target);
    try {
      const response = await browserRuntime.navigate(
        {
          ...target,
          projectId: request.projectId,
          ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
          loopbackMode: request.rawLocalhost
            ? "raw-localhost"
            : "project-alias",
          locale: profile.locale,
          timezone: profile.timezone,
        },
        request.input,
        { signal, leaseSignal: lease.signal },
      );
      await reconcileRuntimeTabs(dataDir, target, response.tabId);
      return response;
    } finally {
      lease.release();
    }
  }
  async function historyBrowser(
    request: BrowserHistoryRequest,
    dataDir: string,
    signal?: AbortSignal,
  ) {
    const target = { hostId: request.hostId, profileId: request.profileId };
    const readiness = await administration(dataDir).inspect(target);
    if (readiness.state !== "healthy") throw new Error(readiness.message);
    const profile = await resolveActiveProfile(
      dataDir,
      request.hostId,
      request.profileId,
    );
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) {
      throw new Error("The Workspace Browser runtime is unavailable.");
    }
    const lease = await controlLeases.acquireOwner(
      controlLeaseKey(target),
      signal,
    );
    // An owner history action ends the agent's Control Lease: dismiss any open
    // agent dialog so it cannot strand behind an invisible modal block.
    dismissOpenDialogsForProfile(target);
    try {
      const response = await browserRuntime.history(
        {
          ...target,
          projectId: request.projectId,
          ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
          locale: profile.locale,
          timezone: profile.timezone,
        },
        request.direction,
        { signal, leaseSignal: lease.signal },
      );
      await reconcileRuntimeTabs(dataDir, target, response.tabId);
      return response;
    } finally {
      lease.release();
    }
  }
  /**
   * Only the Browser Panel that holds control may drive the shared browser.
   * The interface gives a view-only panel a Take control button where its
   * address bar would be; this is the same answer at the boundary, so a panel
   * that says view-only cannot navigate even if its interface offered the
   * field, and two panels can never silently fight over one address bar.
   *
   * A request that carries no panel identity is not a panel: agent scripts,
   * the CLI, and owner tools reach the browser exactly as before.
   */
  function assertPanelMayDriveBrowser(request: {
    hostId: string;
    profileId: string;
    panelId?: string;
  }) {
    const panelId = request.panelId;
    if (panelId === undefined) return;
    const session = panelControlSession({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    if (session.canNavigate(panelId)) return;
    throw new Error(
      "This Browser Panel is view-only. Take control to drive this browser.",
    );
  }

  /**
   * Open, switch, or close a Browser Tab for the owner. Tab state belongs to
   * the Browser Profile (ADR 0005), so the answer is the whole shared strip
   * every panel for that profile renders rather than the one tab that changed.
   *
   * Each action holds the owner Control Lease while it runs, exactly as owner
   * navigation does, so a tab command never races an agent script driving the
   * same instance. The strip is updated from the action's own result rather
   * than by re-reading the runtime inventory: a tab command must feel
   * immediate, and navigation and script completion already reconcile the
   * strip against real browser state.
   */
  async function applyTabAction(
    request: BrowserTabActionRequest,
    dataDir: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabStrip> {
    const target = { hostId: request.hostId, profileId: request.profileId };
    const readiness = await administration(dataDir).inspect(target);
    if (readiness.state !== "healthy") throw new Error(readiness.message);
    const profile = await resolveActiveProfile(
      dataDir,
      request.hostId,
      request.profileId,
    );
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) {
      throw new Error("The Workspace Browser runtime is unavailable.");
    }
    const strip = browserTabStrip(target);
    const instanceTarget = {
      ...target,
      locale: profile.locale,
      timezone: profile.timezone,
    };
    const lease = await controlLeases.acquireOwner(
      controlLeaseKey(target),
      signal,
    );
    // A tab command is owner interaction: it ends an agent's Control Lease, so
    // dismiss any open agent dialog rather than stranding it behind the tab
    // the owner just moved to.
    dismissOpenDialogsForProfile(target);
    try {
      const operationOptions = { signal, leaseSignal: lease.signal };
      if (request.action === "open") {
        const opened = await browserRuntime.openPage(
          instanceTarget,
          operationOptions,
        );
        strip.openTab(opened.url, opened.title, opened.id);
        const evicted = strip.takeEvictedTabIds();
        if (evicted.length > 0)
          await browserRuntime.closePages(target, evicted);
        return strip.snapshot() as BrowserTabStrip;
      }
      const tabId = request.tabId;
      if (tabId === undefined) {
        throw new Error("Switching or closing a Browser Tab requires a tab.");
      }
      if (request.action === "activate") {
        await browserRuntime.focusPage(instanceTarget, tabId, operationOptions);
        strip.activateTab(tabId);
        return strip.snapshot() as BrowserTabStrip;
      }
      strip.closeTab(tabId);
      await browserRuntime.closePages(target, [tabId]);
      return strip.snapshot() as BrowserTabStrip;
    } finally {
      lease.release();
    }
  }
  async function setPanelVisibility(
    request: BrowserHostPanelVisibilityRequest,
    dataDir: string,
  ) {
    const readiness = await administration(dataDir).inspect({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    const browserRuntime = runtime(dataDir);
    if (readiness.state !== "healthy" || browserRuntime === undefined) {
      return readiness;
    }
    const target = await panelRuntimeTarget(request, dataDir);
    if (target === null)
      return browserProfileUnavailableStatus({
        hostId: request.hostId,
        profileId: request.profileId,
      });
    panelControlSession({
      hostId: request.hostId,
      profileId: request.profileId,
    }).setVisibility(request.panelId, request.visibility);
    if (request.visibility === "visible")
      return pinVisiblePanel(request, target, readiness, browserRuntime);
    await browserRuntime.unpinPanel(target, request.panelId);
    await panelSessions.releaseIfIdle({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    return runtimeBrowserStatus(readiness, browserRuntime, controlLeases);
  }
  async function panelRuntimeTarget(
    request: { hostId: string; profileId: string },
    dataDir: string,
  ) {
    const inventory = await profiles(dataDir).listProfiles(request.hostId);
    const profile = inventory.profiles.find(
      ({ profileId, state }) =>
        profileId === request.profileId && state === "active",
    );
    return profile === undefined
      ? null
      : {
          hostId: request.hostId,
          profileId: request.profileId,
          locale: profile.locale,
          timezone: profile.timezone,
        };
  }
  async function pinVisiblePanel(
    request: BrowserHostPanelVisibilityRequest,
    target: Parameters<BrowserRuntimeHost["pinPanel"]>[0],
    readiness: BrowserStatus,
    browserRuntime: BrowserRuntimeHost,
  ) {
    try {
      await browserRuntime.pinPanel(target, request.panelId);
    } catch (error) {
      if (
        error instanceof BrowserInstanceError &&
        error.code === "repair-required"
      ) {
        return runtimeBrowserStatus(readiness, browserRuntime, controlLeases);
      }
      throw error;
    }
    return runtimeBrowserStatus(readiness, browserRuntime, controlLeases);
  }
  function openedPanelTransport(
    issued: {
      capabilityId: string;
      secret: string;
      expiresAt: number;
      issuedAt: number;
    },
    gatewayPort: number,
    bindHost: string,
  ): Extract<BrowserPanelTransportResponse, { outcome: "opened" }> {
    return {
      outcome: "opened",
      gatewayPort,
      bindHost,
      capabilityId: issued.capabilityId,
      secret: issued.secret,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      rotatesAt: new Date(
        issued.issuedAt + panelCapabilities.rotationMs,
      ).toISOString(),
    };
  }
  function panelTransportRefusal(
    readiness: BrowserStatus,
  ): Extract<
    BrowserPanelTransportResponse,
    { outcome: "unavailable" | "rejected" }
  > | null {
    const connect = readiness.capabilities.find(
      (capability) => capability.id === "bb-connect",
    );
    if (connect === undefined || connect.status !== "ready") {
      return {
        outcome: "unavailable",
        reason: "bb-connect-required",
        message:
          "Enroll this host in BB Connect before opening the Browser Panel.",
      };
    }
    if (!hostCanDispatchAutomation(readiness) || readiness.hostId === null) {
      return {
        outcome: "unavailable",
        reason:
          readiness.state === "host-offline"
            ? "host-offline"
            : "setup-required",
        message: readiness.message,
      };
    }
    if (readiness.state !== "healthy") {
      return {
        outcome: "unavailable",
        reason: "setup-required",
        message: readiness.message,
      };
    }
    return null;
  }
  async function startBoundPanelTransport(
    request: BrowserPanelTransportRequest,
    dataDir: string,
    panel: ReturnType<typeof panelGateways.openPanel>,
    createSource: () => ScreencastSource,
  ) {
    const { gateway, issued } = panel;
    const stream = createAutomationStreamAdapter({
      clock: panelClock,
      capabilities: panelCapabilities,
    });
    const controlTarget = {
      hostId: request.hostId,
      profileId: request.profileId,
    };
    const session = panelSessions.sessionFor(controlTarget);
    const strip = browserTabStrip(controlTarget);
    const source = session.attachStreamSource(createSource);
    const applyControllerViewport = () => {
      const controllerViewport = session.controllerViewport;
      if (controllerViewport === null) return;
      stream.setViewport(controllerViewport);
      source.setViewport?.(controllerViewport);
    };
    applyControllerViewport();
    const connection = await session.joinPanel(
      request.panelId,
      request.ownerSessionId,
    );
    applyControllerViewport();
    const clipboardExchange = createClipboardExchange({
      effects: {
        readSelectionBytes: async (actor) => source.copyClipboard?.(actor) ?? 0,
        writeClipboardToPage: async (actor, bytes) =>
          source.pasteClipboard?.(actor, bytes) ?? 0,
      },
    });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock: panelClock,
      canInput: () => session.canInput(request.panelId),
      acceptsGeneration: connection.isActive,
      onAuthorized: () => {
        void connection.activate();
        applyControllerViewport();
        transport.broadcastControl(
          session.state() as BrowserPanelControlState,
          strip.snapshot() as BrowserTabStrip,
        );
      },
      onDisconnect: () => {
        if (!connection.disconnect()) return;
        void panelSessions.releaseIfIdle(controlTarget);
      },
      clipboardExchange,
      onTransferCancel: async (transferId) => {
        // Route panel transfer cancellation to the host staging manager so
        // the one-use staged copy is removed at the controller's request.
        const manager = transferStaging(dataDir);
        await manager?.cancel(transferId).catch(() => undefined);
      },
      onDownloadCancel: async (downloadId) => {
        // Owner cancels a quarantined download through the panel; route to
        // the Host Downloads manager so the quarantine file is removed.
        const manager = hostDownloads(dataDir);
        await manager
          ?.cancelDownload({ hostId: request.hostId, downloadId })
          .catch(() => undefined);
      },
      subscribeDownloads: (onUpdate) => {
        // Push the live quarantine listing so the panel observes progress,
        // state, limits, expiry, and errors (issue #20). Time-expired
        // downloads are reaped on each emit while a panel is observing.
        const manager = hostDownloads(dataDir);
        if (manager === null) return () => undefined;
        const emit = () => {
          void manager
            .expire()
            .then(() =>
              manager.listDownloads({
                hostId: request.hostId,
                profileId: request.profileId,
              }),
            )
            .then(onUpdate)
            .catch(() => undefined);
        };
        const interval = setInterval(emit, 1000);
        emit();
        return () => clearInterval(interval);
      },
    });
    const pushControlState = () => {
      applyControllerViewport();
      transport.broadcastControl(
        session.state() as BrowserPanelControlState,
        strip.snapshot() as BrowserTabStrip,
      );
    };
    const unsubscribeControl = session.subscribe(pushControlState);
    const port = await transport.start();
    connection.bindTransport({
      ...transport,
      async stop() {
        unsubscribeControl();
        await transport.stop();
      },
    });
    return openedPanelTransport(issued, port, gateway.declaredBindHost());
  }
  async function openPanelTransport(
    request: BrowserPanelTransportRequest,
    dataDir: string,
  ): Promise<BrowserPanelTransportResponse> {
    const readiness = await administration(dataDir).inspect({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    const refusal = panelTransportRefusal(readiness);
    if (refusal !== null) return refusal;
    if (request.profileId !== DEFAULT_PROFILE_ID) {
      const inventory = await profiles(dataDir).listProfiles(request.hostId);
      if (
        !inventory.profiles.some(
          (profile) =>
            profile.profileId === request.profileId &&
            profile.state === "active",
        )
      ) {
        return {
          outcome: "rejected",
          reason: "profile-mismatch",
          message: `Unknown Browser Profile ${request.profileId} on host ${request.hostId}.`,
        };
      }
    }
    // A remount issues a fresh single-use Panel Capability on a new gateway.
    // The shared Panel session keeps the prior generation until the new one
    // is redeemed and becomes authoritative.
    const opened = panelGateways.openPanel({
      ownerSessionId: request.ownerSessionId,
      panelId: request.panelId,
      hostId: request.hostId,
      profileId: request.profileId,
    });
    const injectedSource = panelStream?.frameSource?.({
      hostId: request.hostId,
      profileId: request.profileId,
      panelId: request.panelId,
    });
    if (injectedSource !== undefined) {
      return startBoundPanelTransport(
        request,
        dataDir,
        opened,
        () => injectedSource,
      );
    }
    const { gateway, issued } = opened;
    const browserRuntime = runtime(dataDir);
    if (browserRuntime !== undefined) {
      // Bind the gateway port (net.Server + WebSocket) and drive CDP screencast
      // through the browser runtime so Automation Mode frames stream over the
      // authenticated transport. The real-browser integration suite exercises
      // this path against a provisioned host; the deterministic suite has no
      // real browser and keeps the declared-port fallback below unless a
      // lifecycle seam supplies a frame source.
      const profile = await resolveActiveProfile(
        dataDir,
        request.hostId,
        request.profileId,
      ).catch(() => undefined);
      const target = {
        hostId: request.hostId,
        profileId: request.profileId,
        locale: profile?.locale ?? "en-US",
        timezone: profile?.timezone ?? "UTC",
      };
      const control = panelControlSession({
        hostId: request.hostId,
        profileId: request.profileId,
      });
      const strip = browserTabStrip({
        hostId: request.hostId,
        profileId: request.profileId,
      });
      return startBoundPanelTransport(request, dataDir, opened, () =>
        createCdpScreencastSource({
          tabs: strip,
          resolveEndpoint: async () => {
            const instance = await browserRuntime.start(target);
            await reconcileRuntimeTabs(dataDir, target);
            return instance.automationEndpoint;
          },
          // The controller's logical viewport drives the screencast capture size;
          // spectators scale and letterbox it rather than resizing it.
          viewport: control.controllerViewport ?? undefined,
          // Enroll a created target (open-link/open-image-new-tab) as a
          // Browser Tab in the shared strip so it is normalized into the
          // profile's ordered tab set rather than spawning an untracked window.
          onTargetCreated: async (created) => {
            await browserRuntime.checkRendererProcessLimit?.(target);
            strip.openTab(created.url, "", created.targetId);
            const evicted = strip.takeEvictedTabIds();
            if (evicted.length > 0)
              await browserRuntime.closePages(target, evicted);
          },
        }),
      );
    }
    return openedPanelTransport(
      issued,
      gateway.choosePort(),
      gateway.declaredBindHost(),
    );
  }
  async function releasePanelTransport(
    request: BrowserPanelReleaseHostRequest,
    dataDir: string,
  ) {
    const session = panelSessions.sessionFor({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    session.closePanel(request.panelId);
    session.setVisibility(request.panelId, "hidden");
    await session.stopPanelTransports(request.panelId);
    panelGateways.closePanel(request);
    await panelSessions.releaseIfIdle({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    const browserRuntime = runtime(dataDir);
    if (browserRuntime !== undefined) {
      const target = await panelRuntimeTarget(request, dataDir);
      if (target !== null) {
        await browserRuntime.unpinPanel(target, request.panelId);
      }
    }
    return { outcome: "released" as const };
  }
  function retainWorker(context: {
    experimental_retainWorker(): { dispose(): Promise<void> };
  }) {
    workerLease ??= context.experimental_retainWorker();
  }
  return experimental_defineHostEntry({
    contract: browserHostContract,
    handlers: {
      hostConnection: (request, context) => {
        retainWorker(context);
        return reconcileHostConnection(
          request,
          context.experimental_paths.dataDir,
        );
      },
      status: async (target, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        return runtimeBrowserStatus(
          await administration(dataDir).inspect(target),
          runtime(dataDir),
          controlLeases,
        );
      },
      diagnostics: (target, context) => {
        retainWorker(context);
        return (async () => {
          const diagnostics = await administration(
            context.experimental_paths.dataDir,
          ).diagnostics(target);
          const controlLease = controlLeases.state(controlLeaseKey(target));
          return controlLease === undefined
            ? diagnostics
            : { ...diagnostics, controlLease };
        })();
      },
      setupPlan: (target, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).setupPlan(
          target,
        );
      },
      setup: (request, context) => {
        retainWorker(context);
        return (async () => {
          const dataDir = context.experimental_paths.dataDir;
          const response = await administration(dataDir).setup(request);
          if (response.plan.state === "ready") {
            await profiles(dataDir).initialize(request.hostId);
          }
          return response;
        })();
      },
      disable: async (request, context) => {
        retainWorker(context);
        return runInstallationLifecycle(
          "disable",
          request,
          context.experimental_paths.dataDir,
        );
      },
      uninstall: async (request, context) => {
        retainWorker(context);
        return runInstallationLifecycle(
          "uninstall",
          request,
          context.experimental_paths.dataDir,
        );
      },
      purgePlan: (target, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).purgePlan(
          target,
        );
      },
      purge: (request, context) => {
        retainWorker(context);
        return administration(context.experimental_paths.dataDir).purge(
          request,
        );
      },
      browserScript: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const startedAt = Date.now();
        const target = {
          hostId: request.hostId,
          profileId: request.profileId,
        };
        const leaseKey = controlLeaseKey(target);
        let lease: ControlLease | undefined;
        let response: BrowserScriptResponse | undefined;
        let leaseRevokedAfterCompletion = false;
        try {
          // Deny browser_script while the profile is in owner-only Safe Login
          // Mode before touching the runtime. Both the agent tool and the CLI
          // relay through this handler, so this is the single denial point for
          // DOM, screenshot, and control access during Safe Login.
          try {
            safeLogin(dataDir).assertAgentAllowed(target);
          } catch (error) {
            if (error instanceof SafeLoginAgentDeniedError) {
              response = safeLoginDeniedResponse(request, error);
              return response;
            }
            throw error;
          }
          const readiness = await administration(dataDir).inspect(target);
          if (readiness.state !== "healthy") {
            response = { ok: false as const, error: readiness };
            return response;
          }
          const inventory = await profiles(dataDir).listProfiles(
            request.hostId,
          );
          const profile = inventory.profiles.find(
            (candidate) =>
              candidate.profileId === request.profileId &&
              candidate.state === "active",
          );
          if (profile === undefined) {
            response = {
              ok: false as const,
              error: browserProfileUnavailableStatus(target),
            };
            return response;
          }
          const browserRuntime = runtime(dataDir);
          if (browserRuntime !== undefined) {
            try {
              lease = await controlLeases.acquireAgent(
                leaseKey,
                request.purpose,
                context.signal,
              );
            } catch (error) {
              if (!(error instanceof ControlLeaseError)) throw error;
              response = scriptRuntimeFailure(request, error);
              return response;
            }
            try {
              const browserResult = assertBrowserScriptResultWithinBounds(
                await browserRuntime.execute(
                  {
                    hostId: request.hostId,
                    profileId: request.profileId,
                    projectId: request.projectId,
                    ...(request.tabId === undefined
                      ? {}
                      : { tabId: request.tabId }),
                    locale: profile.locale,
                    timezone: profile.timezone,
                  },
                  request.code,
                  request.timeoutMs,
                  {
                    signal: context.signal,
                    leaseSignal: lease.signal,
                    screenshot: request.screenshot,
                    ...(request.originScope === undefined
                      ? {}
                      : { originScope: request.originScope }),
                    ...(request.invalidCertificateOrigins === undefined
                      ? {}
                      : {
                          invalidCertificateOrigins:
                            request.invalidCertificateOrigins,
                        }),
                  },
                ),
              );
              if (lease.signal.aborted) {
                leaseRevokedAfterCompletion = true;
              }
              await reconcileRuntimeTabs(dataDir, target);
              response = {
                ok: true as const,
                result: browserResult,
              };
              return response;
            } catch (error) {
              if (error instanceof BrowserOriginScopeDeniedError) {
                response = originScopeDeniedFailure(request, error);
                return response;
              }
              if (
                (context.signal.aborted && !lease.signal.aborted) ||
                (error instanceof BrowserInstanceError && !lease.signal.aborted)
              ) {
                throw error;
              }
              response = scriptRuntimeFailure(request, error, lease);
              return response;
            } finally {
              lease.release();
              lease = undefined;
            }
          }
          response = {
            ok: false as const,
            error: await administration(
              context.experimental_paths.dataDir,
            ).inspect(target),
          };
          return response;
        } finally {
          await recordScriptActivity(
            outbox(dataDir),
            request,
            context,
            scriptWasInterrupted(response)
              ? "interrupted"
              : response?.ok === true
                ? "succeeded"
                : "failed",
            startedAt,
            { leaseRevokedAfterCompletion },
          );
        }
      },
      navigate: async (request, context) => {
        retainWorker(context);
        assertPanelMayDriveBrowser(request);
        return navigateBrowser(
          request,
          context.experimental_paths.dataDir,
          context.signal,
        );
      },
      history: async (request, context) => {
        retainWorker(context);
        assertPanelMayDriveBrowser(request);
        return historyBrowser(
          request,
          context.experimental_paths.dataDir,
          context.signal,
        );
      },
      tabAction: async (request, context) => {
        retainWorker(context);
        assertPanelMayDriveBrowser(request);
        return applyTabAction(
          request,
          context.experimental_paths.dataDir,
          context.signal,
        );
      },
      panelVisibility: async (request, context) => {
        retainWorker(context);
        return setPanelVisibility(request, context.experimental_paths.dataDir);
      },
      panelTransport: (request, context) => {
        retainWorker(context);
        return openPanelTransport(request, context.experimental_paths.dataDir);
      },
      panelRelease: (request, context) => {
        retainWorker(context);
        return releasePanelTransport(
          request,
          context.experimental_paths.dataDir,
        );
      },
      tabs: async (target, context) => {
        retainWorker(context);
        await reconcileRuntimeTabs(context.experimental_paths.dataDir, target);
        return browserTabStrip(target).snapshot() as BrowserTabStrip;
      },
      panelControl: (request, context) => {
        retainWorker(context);
        const target = {
          hostId: request.hostId,
          profileId: request.profileId,
        };
        const session = panelControlSession(target);
        const role = session.connectPanel(
          request.panelId,
          request.ownerSessionId,
          request.viewport,
        );
        // A panel reports its size every time it changes, not only when it
        // first joins, so the capture tracks the size the owner is actually
        // looking at. Only the controller's size drives page layout; a
        // spectator's only letterboxes its own view (ADR 0005/0007).
        if (request.viewport !== undefined) {
          session.setViewport(request.panelId, request.viewport);
        }
        return toControlResponse(target, role);
      },
      takeControl: async (request, context) => {
        retainWorker(context);
        const target = {
          hostId: request.hostId,
          profileId: request.profileId,
        };
        const session = panelControlSession(target);
        await session.takeControl(request.panelId, request.viewport);
        // Owner takeover ends the agent's Control Lease: dismiss any open agent
        // dialog so it cannot strand behind an invisible modal block.
        dismissOpenDialogsForProfile(target);
        return toControlResponse(
          target,
          session.role(request.panelId) ?? "spectator",
        );
      },
      releaseControl: (request, context) => {
        retainWorker(context);
        const target = {
          hostId: request.hostId,
          profileId: request.profileId,
        };
        const session = panelControlSession(target);
        session.releaseControl(request.panelId);
        return toControlResponse(
          target,
          session.role(request.panelId) ?? "spectator",
        );
      },
      reclaimControl: async (request, context) => {
        retainWorker(context);
        const target = {
          hostId: request.hostId,
          profileId: request.profileId,
        };
        const session = panelControlSession(target);
        // Reclaim the controller's own lease after a reconnect. If an agent
        // acquired a lease while the controller was disconnected, the owner
        // reclaim interrupts it just like Take control so the page is preserved
        // for human use.
        if (session.reclaimControl(request.panelId)) {
          await session.takeControl(request.panelId, request.viewport);
          // Reclaiming the controller's own lease ends any agent lease that was
          // acquired while the controller was disconnected.
          dismissOpenDialogsForProfile(target);
        }
        return toControlResponse(
          target,
          session.role(request.panelId) ?? "spectator",
        );
      },
      activityOutbox: async ({ limit }, context) => {
        retainWorker(context);
        return outbox(context.experimental_paths.dataDir).claim({
          now: new Date(),
          limit,
        });
      },
      acknowledgeActivity: async ({ eventIds }, context) => {
        retainWorker(context);
        const acknowledgedEventIds = await outbox(
          context.experimental_paths.dataDir,
        ).acknowledge(eventIds);
        return { acknowledgedEventIds };
      },
      reconcileActivity: async ({ acknowledgedEventIds, limit }, context) => {
        retainWorker(context);
        return outbox(context.experimental_paths.dataDir).reconcile({
          acknowledgedEventIds,
          limit,
        });
      },
      listProfiles: async (target, context) => {
        retainWorker(context);
        const store = profiles(context.experimental_paths.dataDir);
        const inventory = await store.listProfiles(target.hostId);
        if (inventory.profiles.length === 0) return inventory;
        await store.reconcileProfileLifecycle(target.hostId);
        const expired = await store.expireArchivedProfiles(target.hostId);
        await recordExpiredProfiles(
          outbox(context.experimental_paths.dataDir),
          target.hostId,
          expired.deletedProfileIds,
        );
        return store.listProfiles(target.hostId);
      },
      createProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), {
          hostId: request.hostId,
          profileId: DEFAULT_PROFILE_ID,
        });
        return profiles(dataDir).createProfile(request);
      },
      renameProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).renameProfile(request);
      },
      selectProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).selectProfile(request);
      },
      archiveProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        const response = await profiles(dataDir).archiveProfile(request);
        // A destructive profile lifecycle operation purges leftover staging so
        // staged transfer data never outlives the profile it served.
        await transferStaging(dataDir)
          ?.purgeAll()
          .catch(() => undefined);
        // Archived downloads are cleaned: an archived profile loses its grants
        // and its quarantine never outlives it (issue #20).
        await hostDownloads(dataDir)
          ?.purge({ hostId: request.hostId, profileId: request.profileId })
          .catch(() => undefined);
        return response;
      },
      restoreArchivedProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).restoreArchivedProfile(request);
      },
      resetProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        const response = await profiles(dataDir).resetProfile(request);
        await transferStaging(dataDir)
          ?.purgeAll()
          .catch(() => undefined);
        // A full reset discards the prior profile's quarantine so a fresh
        // profile never inherits untrusted downloads (issue #20).
        await hostDownloads(dataDir)
          ?.purge({ hostId: request.hostId, profileId: request.profileId })
          .catch(() => undefined);
        return response;
      },
      deleteProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        const response = await profiles(dataDir).deleteProfile(request);
        await transferStaging(dataDir)
          ?.purgeAll()
          .catch(() => undefined);
        // A deleted profile's downloads are cleaned without following symlinks or
        // affecting unrelated files (issue #20).
        await hostDownloads(dataDir)
          ?.purge({ hostId: request.hostId, profileId: request.profileId })
          .catch(() => undefined);
        return response;
      },
      expireArchivedProfiles: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const expired = await profiles(dataDir).expireArchivedProfiles(
          request.hostId,
        );
        await recordExpiredProfiles(
          outbox(dataDir),
          request.hostId,
          expired.deletedProfileIds,
        );
        // Archived-profile expiry permanently deletes expired profiles; their
        // downloads are cleaned for each deleted profile (issue #20).
        for (const profileId of expired.deletedProfileIds) {
          await hostDownloads(dataDir)
            ?.purge({ hostId: request.hostId, profileId })
            .catch(() => undefined);
        }
        return expired;
      },
      backupProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return recovery(dataDir).backupProfile(request);
      },
      restoreProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return recovery(dataDir).restoreProfile(request);
      },
      importProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), {
          hostId: request.hostId,
          profileId: DEFAULT_PROFILE_ID,
        });
        return recovery(dataDir).importDevBrowserProfile(request);
      },
      transferStage: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        // Fail closed when the host has no provisioned data directory: the
        // staging manager refuses to construct, and no host path is mutated.
        const manager = transferStaging(dataDir);
        if (manager === null) {
          return {
            outcome: "rejected" as const,
            transferId: request.transferId,
            reason: "cancelled" as const,
            message:
              "The host data directory is not provisioned for Transfer Staging.",
          };
        }
        if (request.kind === "client") {
          // A displaying-client upload arrives as base64 bytes from the active
          // file chooser; decode and route to `stageClientFile` so the bytes
          // are written into one-use staging rather than rejected.
          const { hostId: _hostId, data, ...stagingRequest } = request;
          void _hostId;
          const clientData = new Uint8Array(Buffer.from(data, "base64"));
          return manager.stage(stagingRequest, clientData);
        }
        const { hostId: _hostId, ...stagingRequest } = request;
        void _hostId;
        return manager.stage(stagingRequest);
      },
      transferConsume: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = transferStaging(dataDir);
        if (manager === null) {
          return {
            outcome: "missing" as const,
            transferId: request.transferId,
          };
        }
        // The staged path must leave the host so the browser can read it; the
        // one-use copy is released only after the browser acknowledges the
        // read through `transfer_release`. Releasing here would delete the
        // file before the browser ever opens it.
        const consume = await manager.consume(request.transferId);
        if (consume.outcome === "used" && consume.stagedPath !== undefined) {
          return {
            outcome: "used" as const,
            transferId: request.transferId,
            stagedPath: consume.stagedPath,
          };
        }
        return {
          outcome: "missing" as const,
          transferId: request.transferId,
        };
      },
      transferRelease: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = transferStaging(dataDir);
        if (manager === null) {
          return {
            outcome: "missing" as const,
            transferId: request.transferId,
          };
        }
        await manager.release(request.transferId);
        return {
          outcome: "released" as const,
          transferId: request.transferId,
        };
      },
      transferCancel: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = transferStaging(dataDir);
        if (manager === null) {
          return {
            outcome: "missing" as const,
            transferId: request.transferId,
          };
        }
        const result = await manager.cancel(request.transferId);
        return {
          outcome: result.outcome,
          transferId: request.transferId,
        };
      },
      transferProgress: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = transferStaging(dataDir);
        if (manager === null) return null;
        return manager.progress(request.transferId) ?? null;
      },
      controlLeaseState: async (request) => {
        const key = controlLeaseKey(request);
        const lease = controlLeases.state(key);
        return {
          active: lease !== undefined,
          actor: lease?.actor ?? null,
          purpose: lease?.purpose ?? null,
        };
      },
      downloadStart: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("start", request);
        }
        const { hostId: _hostId, ...startRequest } = request;
        void _hostId;
        return manager.startDownload(startRequest);
      },
      downloadAppend: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("append", request);
        }
        return manager.appendChunk(request);
      },
      downloadComplete: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("complete", request);
        }
        return manager.completeDownload(request);
      },
      downloadFail: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("fail", request);
        }
        return manager.failDownload(request);
      },
      downloadCancel: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("cancel", request);
        }
        return manager.cancelDownload(request);
      },
      downloadList: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("list", request);
        }
        await manager.expire().catch(() => undefined);
        return manager.listDownloads(request);
      },
      downloadLimits: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("limits", request);
        }
        return manager.configureLimits(request);
      },
      downloadProgress: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("progress", request);
        }
        return manager.progress(request.downloadId) ?? null;
      },
      downloadExportClient: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("exportClient", request);
        }
        const result = await manager.exportToClient(
          request,
          downloadAuthorization(request, controlLeases),
        );
        await recordDownloadExport(outbox(dataDir), {
          hostId: request.hostId,
          profileId: request.profileId,
          actor: request.actor,
          destination: "client",
          outcome: result.outcome === "exported" ? "exported" : "denied",
        }).catch(() => undefined);
        return result;
      },
      downloadExportWorkspace: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("exportWorkspace", request);
        }
        const result = await manager.exportToWorkspace(
          request,
          downloadAuthorization(request, controlLeases),
          request.environmentRoot,
        );
        await recordDownloadExport(outbox(dataDir), {
          hostId: request.hostId,
          profileId: request.profileId,
          actor: request.actor,
          destination: "workspace",
          outcome: result.outcome === "exported" ? "exported" : "denied",
        }).catch(() => undefined);
        return result;
      },
      downloadPurge: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        const manager = hostDownloads(dataDir);
        if (manager === null) {
          return downloadNotProvisionedFallback("purge", request);
        }
        return manager.purge(request);
      },
    },
    dispose: async () => {
      try {
        controlLeases.dispose();
        await panelSessions.dispose();
        panelGateways.dispose();
        panelCapabilities.dispose();
        await disposeRuntime();
        await retainedTransferStaging?.purgeAll().catch(() => undefined);
        retainedTransferStaging = undefined;
        await retainedHostDownloads?.dispose().catch(() => undefined);
        retainedHostDownloads = undefined;
        retainedSafeLogin?.dispose();
        retainedSafeLogin = undefined;
      } finally {
        await workerLease?.dispose();
      }
    },
  });
}

function productionDevBrowserRuntime(dataDir: string) {
  const daemonRoot = daemonRootFromHostDataDir(dataDir);
  const pluginSource = readDaemonPluginSourcePath(daemonRoot, "browser");
  const extraSearchRoots = [
    dataDir,
    daemonRoot,
    ...(pluginSource === null ? [] : [pluginSource]),
  ];
  return {
    ...requireDevBrowserRuntime({ extraSearchRoots }),
    extraSearchRoots,
  };
}

const playwrightChromiumSetupSource = join(
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
    join(homedir(), ".cache", "ms-playwright"),
  `chromium-${PINNED_BROWSER_RUNTIME.chromiumRevision}`,
  "chrome-linux64",
  "chrome",
);

export default createBrowserHostEntry(
  (dataDir) =>
    createHostAdministrationBoundary({
      readiness: createHostReadinessBoundary(
        createDefaultHostSnapshotReader(dataDir),
      ),
      installationId: hostInstallationId(dataDir),
      executor: createProductionPrivilegedExecutor(),
      stateStore: createFileHostAdministrationStateStore(dataDir),
      fallbackSourcePath: playwrightChromiumSetupSource,
    }),
  (dataDir, lifecycle) =>
    createFileBrowserProfileStore({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      ownership: createBrowserUserProfileOwnershipBoundary(),
      lifecycle,
    }),
  (dataDir) =>
    createFileBrowserProfileRecovery({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      state: {
        isProfileStopped: (hostId, profileId) =>
          createHostAdministrationBoundary({
            readiness: createHostReadinessBoundary(
              createDefaultHostSnapshotReader(dataDir),
            ),
            installationId: hostInstallationId(dataDir),
            executor: createProductionPrivilegedExecutor(),
            stateStore: createFileHostAdministrationStateStore(dataDir),
          }).isProfileStopped({ hostId, profileId }),
        isDevBrowserProfileStopped: unverifiedDevBrowserProfileIsStopped,
      },
      ownership: createBrowserUserProfileOwnershipBoundary(),
    }),
  (dataDir) => {
    const devBrowser = productionDevBrowserRuntime(dataDir);
    return createBrowserInstanceRuntime({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      chromeStablePaths: [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
      ],
      launchBoundary: createProductionBrowserProcessBoundary({
        devBrowserExecutable: devBrowser.executable,
        devBrowserPackageDirectory: devBrowser.packageDirectory,
        playwrightSearchRoots: devBrowser.extraSearchRoots,
      }),
    });
  },
);
