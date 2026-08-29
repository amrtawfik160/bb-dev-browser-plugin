import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createActivityOutbox,
  type ActivityOutbox,
} from "./activity-outbox.js";
import { browserHostContract } from "./host-contract.js";
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
  type BrowserPanelVisibilityRequest,
  type BrowserPanelTransportRequest,
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
} from "./contracts.js";
import { createPanelCapabilityStore } from "./panel-capability.js";
import { createPanelGatewayPool } from "./panel-gateway-pool.js";
import { createPanelTransportServer } from "./panel-transport.js";
import { createCdpScreencastSource } from "./browser-screencast.js";
import { createAutomationStreamAdapter } from "./panel-stream.js";
import {
  ControlLeaseError,
  createControlLeaseManager,
  type ControlLease,
  type ControlLeaseManager,
} from "./control-lease.js";
import { createPanelControlState } from "./panel-control-state.js";
import { createBrowserTabStrip } from "./browser-tabs.js";
import {
  assertBrowserScriptResultWithinBounds,
  BrowserInstanceError,
  BrowserOriginScopeDeniedError,
  BrowserScriptExecutionError,
  createBrowserInstanceRuntime,
  type BrowserInstanceRuntime,
  type RuntimeBrowserPage,
} from "./browser-runtime.js";
import { createProductionBrowserProcessBoundary } from "./browser-process.js";
import { PINNED_BROWSER_RUNTIME } from "./dependency-inventory.js";
import {
  SafeLoginAgentDeniedError,
  createSafeLoginMode,
  type SafeLoginModeManager,
} from "./safe-login.js";
import {
  createTransferStagingManager,
  resolveTransferStagingRoot,
  type TransferStagingManager,
  type TransferStagingFilesystem,
} from "./transfer-staging.js";
import { createNodeTransferStagingFilesystem } from "./transfer-staging-filesystem.js";
import { createClipboardExchange } from "./clipboard-exchange.js";
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
type BrowserRuntimeSource =
  BrowserInstanceRuntime | ((dataDir: string) => BrowserInstanceRuntime);
type SafeLoginModeSource =
  SafeLoginModeManager | ((dataDir: string) => SafeLoginModeManager);
type TransferStagingSource =
  TransferStagingManager | ((dataDir: string) => TransferStagingManager);
type HostDownloadsSource =
  HostDownloadsManager | ((dataDir: string) => HostDownloadsManager);

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
    message.trim().slice(0, 500) || "The Browser script failed.";
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
  origin: string,
): BrowserScriptResponse {
  return {
    ok: false,
    error: {
      state: "origin-denied",
      code: "origin_denied",
      label: "Origin denied",
      hostId: request.hostId,
      profileId: request.profileId,
      message: `Browser navigation to ${origin} was denied by the active Profile Grant. The denied script will not resume automatically; after an owner decision, explicitly retry against current page state.`,
      origin,
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
  browserRuntime: BrowserInstanceRuntime | undefined,
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
  let retainedRuntime: BrowserInstanceRuntime | undefined =
    typeof runtimeSource === "object" ? runtimeSource : undefined;
  const controlLeases = createControlLeaseManager();
  const panelCapabilities = createPanelCapabilityStore();
  const panelGateways = createPanelGatewayPool({
    capabilities: panelCapabilities,
  });
  const panelTransports = new Map<
    string,
    ReturnType<typeof createPanelTransportServer>
  >();
  /**
   * Per-profile shared Control Lease coordination (ADR 0005/0007/0012) and
   * shared ordered Browser Tab strip. Every Browser Panel for one profile
   * joins one control session and observes one ordered tab set and one active
   * tab regardless of which BB thread or client opened it.
   */
  const panelControlSessions = new Map<
    string,
    ReturnType<typeof createPanelControlState>
  >();
  const browserTabStrips = new Map<
    string,
    ReturnType<typeof createBrowserTabStrip>
  >();

  function panelControlSession(target: { hostId: string; profileId: string }) {
    const key = controlLeaseKey(target);
    let session = panelControlSessions.get(key);
    if (session === undefined) {
      session = createPanelControlState({ controlLeases });
      session.setLeaseKey(key);
      panelControlSessions.set(key, session);
    }
    return session;
  }

  function browserTabStrip(target: { hostId: string; profileId: string }) {
    const key = controlLeaseKey(target);
    let strip = browserTabStrips.get(key);
    if (strip === undefined) {
      strip = createBrowserTabStrip();
      browserTabStrips.set(key, strip);
    }
    return strip;
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
    const profilePrefix = `${target.hostId}\u0000${target.profileId}\u0000`;
    for (const [key, transport] of panelTransports) {
      if (key.startsWith(profilePrefix)) transport.dismissOpenDialogs();
    }
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
   * Feed the shared tab strip from real browser state. New pages the runtime
   * reports are added through openTab (top-level) or normalizePopup (popup),
   * then syncPages reconciles url/title changes, removals, and the active tab.
   * Runtime tab ids stay authoritative so the strip and runtime stay consistent
   * for the life of the instance.
   */
  async function reconcileRuntimeTabs(
    dataDir: string,
    target: { hostId: string; profileId: string },
    activeTabId?: string,
  ) {
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) return;
    const strip = browserTabStrip(target);
    let pages: RuntimeBrowserPage[];
    try {
      pages = await browserRuntime.listPages(target);
    } catch {
      // Feeding the strip is best-effort: if the runtime inventory cannot be
      // read (for example a host blip), leave the prior strip intact until the
      // next operation reconciles, rather than dropping tabs the user sees.
      return;
    }
    for (const page of pages) {
      if (strip.tab(page.id) !== undefined) continue;
      if (page.openerTabId !== null) {
        strip.normalizePopup(page.url, page.title, page.openerTabId, page.id);
      } else {
        strip.openTab(page.url, page.title, page.id);
      }
    }
    strip.syncPages(pages);
    if (activeTabId !== undefined) strip.activateTab(activeTabId);
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
        panelControlSessions.get(key)?.revoke();
        browserTabStrips.get(key)?.resetInstance();
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
    for (const transport of panelTransports.values())
      transport.dismissOpenDialogs();
    const current = retainedRuntime;
    retainedRuntime = undefined;
    await current?.dispose();
  }
  function hostConnectionGenerationIsNewer(hostId: string, generation: number) {
    const previousGeneration = hostConnectionGenerations.get(hostId);
    return previousGeneration === undefined || generation > previousGeneration;
  }
  async function applyRuntimeHostConnection(
    browserRuntime: BrowserInstanceRuntime,
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
      for (const [key, session] of panelControlSessions) {
        if (key.startsWith(`${request.hostId}\u0000`)) {
          session.revoke();
          const [, profileId] = key.split("\u0000");
          if (profileId !== undefined)
            dismissOpenDialogsForProfile({
              hostId: request.hostId,
              profileId,
            });
        }
      }
      for (const [key, strip] of browserTabStrips) {
        if (key.startsWith(`${request.hostId}\u0000`)) strip.resetInstance();
      }
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
  async function setPanelVisibility(
    request: BrowserPanelVisibilityRequest,
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
    if (target === null) return browserProfileUnavailableStatus(request);
    if (request.visibility === "visible")
      return pinVisiblePanel(request, target, readiness, browserRuntime);
    await browserRuntime.unpinPanel(target, request.panelId);
    return runtimeBrowserStatus(readiness, browserRuntime, controlLeases);
  }
  async function panelRuntimeTarget(
    request: BrowserPanelVisibilityRequest,
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
    request: BrowserPanelVisibilityRequest,
    target: Parameters<BrowserInstanceRuntime["pinPanel"]>[0],
    readiness: BrowserStatus,
    browserRuntime: BrowserInstanceRuntime,
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
  async function openPanelTransport(
    request: BrowserPanelTransportRequest,
    dataDir: string,
  ) {
    const readiness = await administration(dataDir).inspect({
      hostId: request.hostId,
      profileId: request.profileId,
    });
    if (readiness.state !== "healthy" || readiness.hostId === null) {
      throw new Error(readiness.message);
    }
    // A remount issues a fresh single-use Panel Capability. The pool retires
    // any prior gateway for this panel (revoking its redeemed capability) so
    // the fresh redeem is never blocked by a stale redeemed capability.
    const { gateway, issued } = panelGateways.openPanel({
      ownerSessionId: request.ownerSessionId,
      panelId: request.panelId,
      hostId: request.hostId,
      profileId: request.profileId,
    });
    const browserRuntime = runtime(dataDir);
    if (browserRuntime !== undefined) {
      // Bind the gateway port (net.Server + WebSocket) and drive CDP screencast
      // through the browser runtime so Automation Mode frames stream over the
      // authenticated transport. The real-browser integration suite exercises
      // this path against a provisioned host; the deterministic suite has no
      // real browser and keeps the declared-port fallback below.
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
      const stream = createAutomationStreamAdapter({
        capabilities: panelCapabilities,
      });
      const controlTarget = {
        hostId: request.hostId,
        profileId: request.profileId,
      };
      const control = panelControlSession(controlTarget);
      const strip = browserTabStrip(controlTarget);
      const source = createCdpScreencastSource({
        resolveEndpoint: async () =>
          (await browserRuntime.start(target)).automationEndpoint,
        // The controller's logical viewport drives the screencast capture size;
        // spectators scale and letterbox it rather than resizing it.
        viewport: control.controllerViewport ?? undefined,
        // Enroll a created target (open-link/open-image-new-tab) as a
        // BrowserTab in the shared strip so it is normalized into the
        // profile's ordered tab set rather than spawning an untracked window.
        onTargetCreated: (created) => strip.openTab(created.url, ""),
      });
      // Apply the controller's viewport to the stream policy so the ready frame
      // carries the controller viewport, and keep it in sync when control moves.
      const applyControllerViewport = () => {
        const controllerViewport = control.controllerViewport;
        if (controllerViewport === null) return;
        stream.setViewport(controllerViewport);
        source.setViewport?.(controllerViewport);
      };
      applyControllerViewport();
      // The panel joins the shared control session for its profile: the first
      // panel becomes the controller and owns the viewport; later panels are
      // view-only spectators. Input through the transport is gated so only the
      // connected controller can send browser input.
      control.connectPanel(request.panelId, request.ownerSessionId);
      applyControllerViewport();
      // Build the explicit clipboard exchange (issue #19) and route its effects
      // to the CDP source's clipboard capabilities. The exchange is the policy
      // (controller-only, no ambient sync); the source supplies the OS-clipboard
      // read/write so clipboard text moves only through an explicit owner action.
      const clipboardExchange = createClipboardExchange({
        effects: {
          readSelectionBytes: async (actor) =>
            source.copyClipboard?.(actor) ?? 0,
          writeClipboardToPage: async (actor, bytes) =>
            source.pasteClipboard?.(actor, bytes) ?? 0,
        },
      });
      const transferTarget = {
        hostId: request.hostId,
        profileId: request.profileId,
      };
      const transport = createPanelTransportServer({
        gateway,
        stream,
        source,
        canInput: () => control.canInput(request.panelId),
        onDisconnect: () => control.disconnectPanel(request.panelId),
        clipboardExchange,
        onTransferCancel: async (transferId) => {
          // Route panel transfer cancellation to the host staging manager so
          // the one-use staged copy is removed at the controller's request.
          const manager = transferStaging(dataDir);
          await manager?.cancel(transferId).catch(() => undefined);
          void transferTarget;
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
          // Push the live quarantine listing to the panel so it observes
          // progress, state, limits, expiry, and errors (issue #20).
          //
          // S7 (issue #20 findings): the listing is refreshed by polling on a
          // one-second interval rather than by event-driven emission on every
          // manager state change. The manager has no internal pub/sub and is
          // shared across panels; wiring per-change emissions (start/append/
          // complete/fail/cancel/expire/purge/export) would add cross-cutting
          // state-change hooks for a bounded, low-frequency listing, so the
          // cheaper polling approach is kept here. P1 (issue #20 findings):
          // each emit first reaps time-expired downloads so time-based expiry
          // of a live quarantined download actually fires while a panel is
          // observing — without waiting for a profile lifecycle event.
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
      // Push live control transfers and tab changes to this panel so every
      // panel observes the shared state without re-fetching (ADR 0012).
      const pushControlState = () => {
        applyControllerViewport();
        transport.broadcastControl(
          control.state() as BrowserPanelControlState,
          strip.snapshot() as BrowserTabStrip,
        );
      };
      const unsubscribeControl = control.subscribe(pushControlState);
      const unsubscribeTabs = strip.subscribe(pushControlState);
      const port = await transport.start();
      const transportKey = `${request.hostId}\u0000${request.profileId}\u0000${request.panelId}`;
      const previous = panelTransports.get(transportKey);
      if (previous !== undefined) {
        await previous.stop().catch(() => undefined);
        panelTransports.delete(transportKey);
      }
      panelTransports.set(transportKey, {
        ...transport,
        async stop() {
          unsubscribeControl();
          unsubscribeTabs();
          await transport.stop();
        },
      });
      return {
        gatewayPort: port,
        bindHost: gateway.declaredBindHost(),
        capabilityId: issued.capabilityId,
        secret: issued.secret,
        expiresAt: new Date(issued.expiresAt).toISOString(),
        rotatesAt: new Date(
          issued.issuedAt + panelCapabilities.rotationMs,
        ).toISOString(),
      };
    }
    return {
      gatewayPort: gateway.choosePort(),
      bindHost: gateway.declaredBindHost(),
      capabilityId: issued.capabilityId,
      secret: issued.secret,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      rotatesAt: new Date(
        issued.issuedAt + panelCapabilities.rotationMs,
      ).toISOString(),
    };
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
                response = originScopeDeniedFailure(request, error.origin);
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
        return navigateBrowser(
          request,
          context.experimental_paths.dataDir,
          context.signal,
        );
      },
      history: async (request, context) => {
        retainWorker(context);
        return historyBrowser(
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
      tabs: (target, context) => {
        retainWorker(context);
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
        for (const session of panelControlSessions.values()) session.dispose();
        panelControlSessions.clear();
        for (const strip of browserTabStrips.values()) strip.dispose();
        browserTabStrips.clear();
        for (const transport of panelTransports.values()) {
          await transport.stop().catch(() => undefined);
        }
        panelTransports.clear();
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

const require = createRequire(import.meta.url);
const devBrowserPackageDirectory = dirname(
  require.resolve("dev-browser/package.json"),
);
const devBrowserExecutable = join(
  devBrowserPackageDirectory,
  "bin",
  "dev-browser.js",
);
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
  (dataDir) =>
    createBrowserInstanceRuntime({
      rootDirectory: BROWSER_STORAGE_ROOT,
      installationId: hostInstallationId(dataDir),
      chromeStablePaths: [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
      ],
      launchBoundary: createProductionBrowserProcessBoundary({
        devBrowserExecutable,
        devBrowserPackageDirectory,
      }),
    }),
);
