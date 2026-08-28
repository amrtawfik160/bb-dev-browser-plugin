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
  type BrowserPanelVisibilityRequest,
  type BrowserStatus,
} from "./contracts.js";
import {
  ControlLeaseError,
  createControlLeaseManager,
  type ControlLease,
  type ControlLeaseManager,
} from "./control-lease.js";
import {
  assertBrowserScriptResultWithinBounds,
  BrowserInstanceError,
  createBrowserInstanceRuntime,
  type BrowserInstanceRuntime,
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

function controlLeaseKey(target: { hostId: string; profileId: string }) {
  return `${target.hostId}\0${target.profileId}`;
}

function scriptRuntimeErrorCode(
  request: BrowserScriptRequest,
  error: unknown,
): BrowserScriptRuntimeError["code"] {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout/iu.test(message)) return "browser_timeout";
  if (/(?:result|screenshot).*(?:exceed|large|limit)/iu.test(message)) {
    return "result_too_large";
  }
  if (
    request.tabId !== undefined &&
    /(?:tab|page|target|browser\.getPage|open tabs).*(?:invalid|not found|closed|no )/iu.test(
      message,
    )
  ) {
    return "tab_invalid";
  }
  if (
    /(?:process|require|module|deno|bun|node:|filesystem|file system|path traversal|outside.*(?:home|temporary|sandbox)|not defined)/iu.test(
      message,
    )
  ) {
    return "sandbox_violation";
  }
  return "script_failed";
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
        : scriptRuntimeErrorCode(request, error);
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
): BrowserActivityEvent {
  const interrupted = context.signal.aborted || outcome === "interrupted";
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
    outcome: interrupted ? "interrupted" : outcome,
    interrupted,
    interruptionReason: interrupted
      ? context.signal.aborted
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
) {
  await outbox.enqueue(
    scriptActivityEvent(request, context, outcome, startedAt),
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
        controlLeases.revoke(controlLeaseKey({ hostId, profileId }));
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
  async function navigateBrowser(
    request: BrowserNavigationRequest,
    dataDir: string,
    signal?: AbortSignal,
  ) {
    const target = { hostId: request.hostId, profileId: request.profileId };
    const readiness = await administration(dataDir).inspect(target);
    if (readiness.state !== "healthy") throw new Error(readiness.message);
    const inventory = await profiles(dataDir).listProfiles(request.hostId);
    const profile = inventory.profiles.find(
      (candidate) =>
        candidate.profileId === request.profileId &&
        candidate.state === "active",
    );
    if (profile === undefined) {
      throw new Error("The requested Browser Profile is unavailable.");
    }
    const browserRuntime = runtime(dataDir);
    if (browserRuntime === undefined) {
      throw new Error("The Workspace Browser runtime is unavailable.");
    }
    const lease = await controlLeases.acquireOwner(
      controlLeaseKey(target),
      signal,
    );
    try {
      return await browserRuntime.navigate(
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
                  },
                ),
              );
              if (lease.signal.aborted) {
                throw new ControlLeaseError(
                  "lease_revoked",
                  "The Browser Control Lease was revoked before the script completed.",
                );
              }
              response = {
                ok: true as const,
                result: browserResult,
              };
              return response;
            } catch (error) {
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
      panelVisibility: async (request, context) => {
        retainWorker(context);
        return setPanelVisibility(request, context.experimental_paths.dataDir);
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
