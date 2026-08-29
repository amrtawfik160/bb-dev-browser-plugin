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

type ScriptSignalContext = { signal: AbortSignal };
type ScriptActivityOutcome = "succeeded" | "failed" | "interrupted";
type ScriptActivityRecording = { leaseRevokedAfterCompletion?: boolean };

function controlLeaseKey(target: { hostId: string; profileId: string }) {
  return `${target.hostId}\0${target.profileId}`;
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
) {
  let workerLease: { dispose(): Promise<void> } | undefined;
  let retainedBoundary: HostAdministrationBoundary | undefined;
  let retainedProfiles: BrowserProfileStore | undefined;
  let retainedRecovery: BrowserProfileRecovery | undefined;
  let retainedOutbox: ActivityOutbox | undefined;
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
  async function disposeRuntime() {
    controlLeases.revokeAll();
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
      // A host disconnect freezes control for every profile on that host and
      // invalidates runtime tab ids so agents never target a stale page.
      for (const [key, session] of panelControlSessions) {
        if (key.startsWith(`${request.hostId}\u0000`)) session.revoke();
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
      const source = createCdpScreencastSource({
        resolveEndpoint: async () =>
          (await browserRuntime.start(target)).automationEndpoint,
        // The controller's logical viewport drives the screencast capture size;
        // spectators scale and letterbox it rather than resizing it.
        viewport: control.controllerViewport ?? undefined,
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
      const transport = createPanelTransportServer({
        gateway,
        stream,
        source,
        canInput: () => control.canInput(request.panelId),
        onDisconnect: () => control.disconnectPanel(request.panelId),
      });
      // Push live control transfers and tab changes to this panel so every
      // panel observes the shared state without re-fetching (ADR 0012).
      const strip = browserTabStrip(controlTarget);
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
        return profiles(dataDir).archiveProfile(request);
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
        return profiles(dataDir).resetProfile(request);
      },
      deleteProfile: async (request, context) => {
        retainWorker(context);
        const dataDir = context.experimental_paths.dataDir;
        await requireReadyForProfileMutation(administration(dataDir), request);
        return profiles(dataDir).deleteProfile(request);
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
