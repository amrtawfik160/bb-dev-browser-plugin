import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  BROWSER_DATABASE_MIGRATIONS,
  createActivityRecordStore,
  createActivityRecordProducers,
  activityEventFromOutboxItem,
  newActivityEventId,
  type ActivityRecordStore,
} from "./activity-records.js";
import {
  browserProfileIdSchema,
  browserScriptParametersSchema,
  ACTIVITY_OUTBOX_BATCH_LIMIT,
  CLEAR_ACTIVITY_CONFIRMATION,
  browserProfileUnavailableStatus,
  DEFAULT_PROFILE_ID,
  hostOfflineStatus,
  hostProbeFailedStatus,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserActivityRecord,
  type BrowserActivityExport,
  type BrowserActivityClearResponse,
  type BrowserScriptRequest,
  type BrowserHostChoice,
  type BrowserHostChoicesInput,
  type BrowserLifecycleRequest,
  type BrowserProfile,
  type BrowserProfileCreateRequest,
  type BrowserProfileInventory,
  type BrowserProfileQuery,
  type BrowserProfileRenameRequest,
  type BrowserProfileSelectRequest,
  type BrowserProfileSelectionRequest,
  type BrowserPurgePlan,
  type BrowserPurgeRequest,
  type BrowserPurgeResponse,
  type BrowserSetupPlan,
  type BrowserSetupRequest,
  type BrowserSetupResponse,
  type BrowserDiagnostics,
  type BrowserStatus,
  type BrowserStatusInput,
  type BrowserScriptResponse,
} from "./contracts.js";
import { browserHostContract } from "./host-contract.js";
import { dependencyInventory } from "./dependency-inventory.js";
type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;
type AgentActivityInput = {
  eventId: string;
  occurredAt: string;
  projectId: string;
  hostId: string;
  profileId: string;
  destinationOrigin: string | null;
};
type AgentActivityOutcome = "succeeded" | "failed";
type AgentScriptTarget = {
  hostId: string | null;
  profileId: string;
};
type AgentScriptCall = {
  parameters: BrowserScriptParameters;
  context: PluginAgentToolContext;
  hostId: string;
  profileId: string;
  activity: AgentActivityInput;
};

class ActivitySyncTransportError extends Error {
  constructor() {
    super("Browser activity synchronization is pending.");
    this.name = "ActivitySyncTransportError";
  }
}

function agentBrowserScriptRequest(
  call: AgentScriptCall,
): BrowserScriptRequest {
  return {
    purpose: call.parameters.purpose,
    code: call.parameters.code,
    ...(call.parameters.destinationOrigin === undefined
      ? {}
      : { destinationOrigin: call.parameters.destinationOrigin }),
    profileId: call.profileId,
    ...(call.parameters.tabId === undefined
      ? {}
      : { tabId: call.parameters.tabId }),
    timeoutMs: call.parameters.timeoutMs,
    activityEventId: call.activity.eventId,
    activityOccurredAt: call.activity.occurredAt,
    hostId: call.hostId,
    projectId: call.context.projectId,
    threadId: call.context.threadId,
  };
}

function offlineAgentScriptFailure(call: AgentScriptCall) {
  return {
    ok: false as const,
    error: hostOfflineStatus({
      hostId: call.hostId,
      profileId: call.profileId,
    }),
  };
}
const profilePreferenceRowSchema = z
  .object({ profile_id: browserProfileIdSchema })
  .strict();
const SETTINGS_PROJECT_ID = "__browser_settings__";
type BrowserIdentity = {
  projectId?: string;
  threadId?: string;
  hostId?: string;
};
type ProfileContext = Pick<BrowserProfileQuery, "projectId" | "threadId">;

type ProfileHostCall = {
  createProfile: {
    request: BrowserProfileCreateRequest;
    response: BrowserProfile;
  };
  renameProfile: {
    request: BrowserProfileRenameRequest;
    response: BrowserProfile;
  };
  selectProfile: {
    request: BrowserProfileSelectRequest;
    response: BrowserProfileInventory;
  };
};

function selectedProfilePreference(
  database: Database.Database,
  projectId: string,
  hostId: string,
) {
  const row = database
    .prepare(
      `SELECT profile_id
       FROM browser_preferences
       WHERE project_id = ? AND host_id = ?`,
    )
    .get(projectId, hostId);
  if (row === undefined) return null;
  return profilePreferenceRowSchema.parse(row).profile_id;
}

function saveSelectedProfilePreference(
  database: Database.Database,
  projectId: string,
  hostId: string,
  profileId: string,
) {
  database
    .prepare(
      `INSERT INTO browser_preferences (project_id, host_id, profile_id)
       VALUES (?, ?, ?)
       ON CONFLICT (project_id, host_id)
       DO UPDATE SET profile_id = excluded.profile_id`,
    )
    .run(projectId, hostId, profileId);
}

function inventoryWithSelectedProfile(
  inventory: BrowserProfileInventory,
  preferredProfileId: string | null,
): BrowserProfileInventory {
  const selectedProfileId =
    preferredProfileId !== null &&
    inventory.profiles.some(
      (profile) => profile.profileId === preferredProfileId,
    )
      ? preferredProfileId
      : DEFAULT_PROFILE_ID;
  return {
    ...inventory,
    selectedProfileId,
    profiles: inventory.profiles.map((profile) => ({
      ...profile,
      selected: profile.profileId === selectedProfileId,
    })),
  };
}

async function profileContextProjectId(
  bb: BbPluginApi,
  context: ProfileContext,
): Promise<string> {
  if (context.projectId !== undefined && context.projectId !== null) {
    return context.projectId;
  }
  if (context.threadId !== undefined) {
    const thread = await bb.sdk.threads.get({ threadId: context.threadId });
    return thread.projectId;
  }
  return SETTINGS_PROJECT_ID;
}

type HostResolution = {
  candidates: string[];
  preferredHostId: string | null;
  projectId: string | null;
};

function uniqueHostIds(hostIds: readonly (string | undefined)[]) {
  return [
    ...new Set(
      hostIds.filter((hostId): hostId is string => hostId !== undefined),
    ),
  ];
}

async function projectHostResolution(
  bb: BbPluginApi,
  projectId: string,
): Promise<HostResolution> {
  const project = await bb.sdk.projects.get({ projectId });
  const candidates = uniqueHostIds(
    project.sources.map((source) => source.hostId),
  );
  const defaultHostIds = uniqueHostIds(
    project.sources
      .filter((source) => source.isDefault)
      .map((source) => source.hostId),
  );
  return {
    candidates,
    preferredHostId:
      defaultHostIds.length === 1
        ? defaultHostIds[0]!
        : candidates.length === 1
          ? candidates[0]!
          : null,
    projectId,
  };
}

async function threadHostResolution(
  bb: BbPluginApi,
  threadId: string,
): Promise<HostResolution> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null) {
    return projectHostResolution(bb, thread.projectId);
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return {
    candidates: [environment.hostId],
    preferredHostId: environment.hostId,
    projectId: thread.projectId,
  };
}

async function identityHostResolution(
  bb: BbPluginApi,
  identity: BrowserIdentity,
): Promise<HostResolution> {
  if (identity.threadId !== undefined) {
    return threadHostResolution(bb, identity.threadId);
  }
  if (identity.projectId !== undefined) {
    return projectHostResolution(bb, identity.projectId);
  }
  return { candidates: [], preferredHostId: null, projectId: null };
}

async function resolvedHostId(bb: BbPluginApi, identity: BrowserIdentity) {
  const resolution = await identityHostResolution(bb, identity);
  if (identity.hostId !== undefined) {
    if (resolution.candidates.includes(identity.hostId)) return identity.hostId;
    if (resolution.candidates.length === 0) {
      const hosts = await bb.sdk.hosts.list();
      return hosts.some((host) => host.id === identity.hostId)
        ? identity.hostId
        : null;
    }
    return null;
  }
  return resolution.preferredHostId;
}

function unavailableDiagnostics(status: BrowserStatus): BrowserDiagnostics {
  return {
    hostId: status.hostId!,
    profileId: status.profileId,
    generatedAt: new Date().toISOString(),
    readiness: status,
    dependencies: dependencyInventory(),
    processes: [
      { name: "host-worker", state: "stopped" },
      { name: "browser", state: "stopped" },
    ],
    resourceUse: {
      diskFreeBytes: 0,
      diskTotalBytes: 0,
      workerRssBytes: 0,
    },
    exitLogs: [],
  };
}

export function panelIdentity(input: BrowserStatusInput): BrowserIdentity {
  return input.surface === "thread"
    ? { threadId: input.threadId, hostId: input.hostId }
    : { projectId: input.projectId ?? undefined, hostId: input.hostId };
}

export function createBrowserService(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
  const activityStore: ActivityRecordStore =
    createActivityRecordStore(database);
  const activityProducers = createActivityRecordProducers(activityStore);
  const host = bb.hosts.experimental_client({ contract: browserHostContract });

  function recordAgentActivity(
    input: AgentActivityInput,
    signal: AbortSignal,
    outcome: AgentActivityOutcome,
    startedAt: number,
  ) {
    const interrupted = signal.aborted;
    activityProducers.agent({
      ...input,
      actor: "agent",
      action: "browser-script",
      outcome: interrupted ? "interrupted" : outcome,
      interrupted,
      interruptionReason: interrupted ? "request-aborted" : null,
      durationMs: Math.min(Math.max(Date.now() - startedAt, 0), 30_000),
    });
  }

  async function hostConnection(hostId: string, signal?: AbortSignal) {
    const hosts = await bb.sdk.hosts.list({ signal });
    return hosts.find((candidate) => candidate.id === hostId)?.status ?? null;
  }

  async function callActivityTransport<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch {
      throw new ActivitySyncTransportError();
    }
  }

  async function syncHostConnection(hostId: string, signal?: AbortSignal) {
    try {
      return (await hostConnection(hostId, signal)) === "connected";
    } catch {
      throw new ActivitySyncTransportError();
    }
  }

  async function reconcileActivityBatch(
    hostId: string,
    acknowledgedEventIds: readonly string[],
    signal?: AbortSignal,
  ) {
    return callActivityTransport(() =>
      host.call(
        "reconcileActivity",
        {
          hostId,
          acknowledgedEventIds: [...acknowledgedEventIds],
          limit: ACTIVITY_OUTBOX_BATCH_LIMIT,
        },
        { hostId, signal },
      ),
    );
  }

  async function acknowledgeActivityBatch(
    hostId: string,
    eventIds: readonly string[],
    signal?: AbortSignal,
  ) {
    const response = await callActivityTransport(() =>
      host.call(
        "acknowledgeActivity",
        { hostId, eventIds: [...eventIds] },
        { hostId, signal },
      ),
    );
    return response.acknowledgedEventIds;
  }

  function mergeActivityEventIds(
    acknowledgedEventIds: readonly string[],
    acceptedEventIds: readonly string[],
  ) {
    return [...new Set([...acknowledgedEventIds, ...acceptedEventIds])];
  }

  async function syncActivityBatch(
    hostId: string,
    acknowledgedEventIds: readonly string[],
    signal?: AbortSignal,
  ) {
    await reconcileActivityBatch(hostId, acknowledgedEventIds, signal);
    if (acknowledgedEventIds.length > 0) {
      const acknowledged = await acknowledgeActivityBatch(
        hostId,
        acknowledgedEventIds,
        signal,
      );
      activityStore.acknowledgeClearedEvents(hostId, acknowledged);
    }
    const batch = await callActivityTransport(() =>
      host.call(
        "activityOutbox",
        { hostId, limit: ACTIVITY_OUTBOX_BATCH_LIMIT },
        { hostId, signal },
      ),
    );
    if (batch.length === 0) return [];
    const acceptedEventIds = activityStore.ingest(
      batch.map(activityEventFromOutboxItem),
    );
    await acknowledgeActivityBatch(hostId, acceptedEventIds, signal);
    return acceptedEventIds;
  }

  async function syncConnectedActivity(hostId: string, signal?: AbortSignal) {
    let acknowledgedEventIds = activityStore.eventIds(hostId);
    while (true) {
      const acceptedEventIds = await syncActivityBatch(
        hostId,
        acknowledgedEventIds,
        signal,
      );
      if (acceptedEventIds.length === 0) return;
      acknowledgedEventIds = mergeActivityEventIds(
        acknowledgedEventIds,
        acceptedEventIds,
      );
    }
  }

  async function syncActivity(hostId: string, signal?: AbortSignal) {
    try {
      if (!(await syncHostConnection(hostId, signal))) return;
      await syncConnectedActivity(hostId, signal);
    } catch (error) {
      if (!(error instanceof ActivitySyncTransportError)) throw error;
      // Keep local records available while the durable host outbox retries.
    }
  }

  async function syncConnectedHosts(signal?: AbortSignal) {
    const hosts = await bb.sdk.hosts.list({ signal });
    for (const candidate of hosts) {
      if (candidate.status === "connected") {
        await syncActivity(candidate.id, signal);
      }
    }
  }

  function subscribeToHostReconnects() {
    const unsubscribe = bb.sdk.subscribe({
      event: "host:changed",
      callback: (event) => {
        if (!event.changes.includes("host-connected")) return;
        const synchronization =
          event.id === undefined
            ? syncConnectedHosts()
            : syncActivity(event.id);
        return synchronization.catch(() => {
          bb.log.warn(
            "Browser activity synchronization failed; pending events will retry.",
          );
        });
      },
    });
    bb.onDispose(unsubscribe);
  }

  async function resolveAgentScriptTarget(
    parameters: BrowserScriptParameters,
    context: PluginAgentToolContext,
  ): Promise<AgentScriptTarget> {
    const hostId = await resolvedHostId(bb, context);
    if (hostId === null) {
      return {
        hostId: null,
        profileId: parameters.profileId ?? DEFAULT_PROFILE_ID,
      };
    }
    return {
      hostId,
      profileId:
        parameters.profileId ?? (await selectedProfileId(context, hostId)),
    };
  }

  async function runWithAgentActivity(
    activity: AgentActivityInput,
    hostId: string,
    signal: AbortSignal,
    operation: () => Promise<BrowserScriptResponse>,
  ): Promise<BrowserScriptResponse> {
    const startedAt = Date.now();
    try {
      const response = await operation();
      recordAgentActivity(
        activity,
        signal,
        response.ok ? "succeeded" : "failed",
        startedAt,
      );
      return response;
    } catch (error) {
      recordAgentActivity(activity, signal, "failed", startedAt);
      throw error;
    } finally {
      await syncActivity(hostId, signal);
    }
  }

  async function runAgentBrowserScriptCall(call: AgentScriptCall) {
    if (
      (await hostConnection(call.hostId, call.context.signal)) !== "connected"
    ) {
      recordAgentActivity(
        call.activity,
        call.context.signal,
        "failed",
        Date.now(),
      );
      return offlineAgentScriptFailure(call);
    }
    return runWithAgentActivity(
      call.activity,
      call.hostId,
      call.context.signal,
      () =>
        host.call("browserScript", agentBrowserScriptRequest(call), {
          hostId: call.hostId,
          signal: call.context.signal,
        }),
    );
  }

  async function hostStatus(
    hostId: string,
    profileId: string,
    signal?: AbortSignal,
  ) {
    const target = { hostId, profileId };
    if ((await hostConnection(hostId, signal)) !== "connected") {
      return hostOfflineStatus(target);
    }
    try {
      return await host.call("status", target, { hostId, signal });
    } catch {
      return hostProbeFailedStatus(target);
    }
  }

  async function requireConnectedHost(hostId: string, signal?: AbortSignal) {
    if ((await hostConnection(hostId, signal)) !== "connected") {
      throw new Error(`Workspace host ${hostId} is not connected.`);
    }
  }

  async function callConnectedProfile<Method extends keyof ProfileHostCall>(
    method: Method,
    request: ProfileHostCall[Method]["request"],
    signal?: AbortSignal,
  ): Promise<ProfileHostCall[Method]["response"]> {
    await requireConnectedHost(request.hostId, signal);
    return host.call(method, request, {
      hostId: request.hostId,
      signal,
    });
  }

  async function profileInventory(
    target: BrowserProfileQuery,
    signal?: AbortSignal,
  ): Promise<BrowserProfileInventory> {
    await requireConnectedHost(target.hostId, signal);
    const inventory = await host.call(
      "listProfiles",
      { hostId: target.hostId },
      { hostId: target.hostId, signal },
    );
    const projectId = await profileContextProjectId(bb, target);
    return inventoryWithSelectedProfile(
      inventory,
      selectedProfilePreference(database, projectId, target.hostId),
    );
  }

  async function selectedProfileId(identity: BrowserIdentity, hostId: string) {
    const resolution = await identityHostResolution(bb, identity);
    const projectId = resolution.projectId ?? SETTINGS_PROJECT_ID;
    return (
      selectedProfilePreference(database, projectId, hostId) ??
      DEFAULT_PROFILE_ID
    );
  }

  async function resolveTarget(
    identity: BrowserIdentity,
    profileId = DEFAULT_PROFILE_ID,
    requestedHostId?: string,
  ): Promise<BrowserHostTarget> {
    const hostId = await resolvedHostId(bb, {
      ...identity,
      hostId: requestedHostId ?? identity.hostId,
    });
    if (hostId === null) {
      throw new Error("Select a workspace host before changing Browser setup.");
    }
    return { hostId, profileId };
  }

  async function status(
    identity: BrowserIdentity,
    profileId = DEFAULT_PROFILE_ID,
    signal?: AbortSignal,
    requestedHostId?: string,
  ) {
    const hostId = await resolvedHostId(bb, {
      ...identity,
      hostId: requestedHostId ?? identity.hostId,
    });
    if (hostId === null) return setupRequiredStatus({ hostId, profileId });
    if ((await hostConnection(hostId, signal)) !== "connected") {
      return hostStatus(hostId, profileId, signal);
    }
    const inventory = await profileInventory({ hostId }, signal);
    if (
      !inventory.profiles.some((profile) => profile.profileId === profileId)
    ) {
      return browserProfileUnavailableStatus({ hostId, profileId });
    }
    return hostStatus(hostId, profileId, signal);
  }

  async function selectedStatus(
    identity: BrowserIdentity,
    signal?: AbortSignal,
    requestedHostId?: string,
  ) {
    const hostId = await resolvedHostId(bb, {
      ...identity,
      hostId: requestedHostId ?? identity.hostId,
    });
    if (hostId === null) {
      return setupRequiredStatus({
        hostId,
        profileId: DEFAULT_PROFILE_ID,
      });
    }
    if ((await hostConnection(hostId, signal)) !== "connected") {
      return hostStatus(hostId, DEFAULT_PROFILE_ID, signal);
    }
    const projectId = await profileContextProjectId(bb, identity);
    const preferredProfileId = selectedProfilePreference(
      database,
      projectId,
      hostId,
    );
    const profileId = preferredProfileId ?? DEFAULT_PROFILE_ID;
    if (preferredProfileId !== null) {
      const inventory = await profileInventory({ ...identity, hostId }, signal);
      if (
        !inventory.profiles.some((profile) => profile.profileId === profileId)
      ) {
        return browserProfileUnavailableStatus({ hostId, profileId });
      }
    }
    return hostStatus(hostId, profileId, signal);
  }

  async function settingsStatuses(profileId = DEFAULT_PROFILE_ID) {
    const hosts = await bb.sdk.hosts.list();
    return Promise.all(
      hosts.map((candidate) => hostStatus(candidate.id, profileId)),
    );
  }

  async function activityRecords(target: BrowserHostTarget) {
    await syncActivity(target.hostId);
    return activityStore.list(target);
  }

  async function exportActivityRecords(
    target: BrowserHostTarget,
  ): Promise<BrowserActivityExport> {
    await syncActivity(target.hostId);
    return activityStore.export(target);
  }

  async function clearActivityRecords(request: {
    hostId: string;
    profileId: string;
    confirmation: string;
  }): Promise<BrowserActivityClearResponse> {
    if (request.confirmation !== CLEAR_ACTIVITY_CONFIRMATION) {
      throw new Error(`Type exactly: ${CLEAR_ACTIVITY_CONFIRMATION}.`);
    }
    await syncActivity(request.hostId);
    const clearedCount = activityStore.clear(request);
    return {
      hostId: request.hostId,
      profileId: request.profileId,
      clearedCount,
      message: `Cleared ${clearedCount} Browser activity records.`,
    };
  }

  async function profiles(target: BrowserProfileQuery, signal?: AbortSignal) {
    return profileInventory(target, signal);
  }

  async function createProfile(
    request: BrowserProfileCreateRequest,
    signal?: AbortSignal,
  ): Promise<BrowserProfile> {
    return recordProfileActivity(
      { hostId: request.hostId, profileId: DEFAULT_PROFILE_ID },
      "create",
      () => callConnectedProfile("createProfile", request, signal),
      (profile) => ({ hostId: request.hostId, profileId: profile.profileId }),
    );
  }

  async function renameProfile(
    request: BrowserProfileRenameRequest,
    signal?: AbortSignal,
  ): Promise<BrowserProfile> {
    return recordProfileActivity(
      { hostId: request.hostId, profileId: request.profileId },
      "rename",
      () => callConnectedProfile("renameProfile", request, signal),
    );
  }

  async function selectProfile(
    request: BrowserProfileSelectionRequest,
    signal?: AbortSignal,
  ): Promise<BrowserProfileInventory> {
    const hostRequest = {
      hostId: request.hostId,
      profileId: request.profileId,
    } satisfies BrowserProfileSelectRequest;
    return recordProfileActivity(
      { hostId: request.hostId, profileId: request.profileId },
      "select",
      async () => {
        const inventory = await callConnectedProfile(
          "selectProfile",
          hostRequest,
          signal,
        );
        const projectId = await profileContextProjectId(bb, request);
        saveSelectedProfilePreference(
          database,
          projectId,
          request.hostId,
          request.profileId,
        );
        return inventoryWithSelectedProfile(inventory, request.profileId);
      },
    );
  }

  async function hostChoices(
    input: BrowserHostChoicesInput,
  ): Promise<BrowserHostChoice[]> {
    const identity: BrowserIdentity =
      input.surface === "thread"
        ? { threadId: input.threadId }
        : { projectId: input.projectId ?? undefined };
    const resolution = await identityHostResolution(bb, identity);
    const hosts = await bb.sdk.hosts.list();
    const candidates =
      resolution.candidates.length > 0
        ? resolution.candidates
        : hosts.map((candidate) => candidate.id);
    return candidates
      .map((hostId) => {
        const host = hosts.find((candidate) => candidate.id === hostId);
        return host === undefined ? null : { hostId, name: host.name };
      })
      .filter((choice): choice is BrowserHostChoice => choice !== null)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.hostId.localeCompare(right.hostId),
      );
  }

  async function recordActivity<T>(request: {
    target: BrowserHostTarget;
    kind: BrowserActivityRecord["kind"];
    action: string;
    operation: () => Promise<T>;
    outcome: (response: T) => string;
    successTarget?: (response: T) => BrowserHostTarget;
    projectId?: string | null;
  }): Promise<T> {
    const occurredAt = new Date().toISOString();
    try {
      const response = await request.operation();
      const target = request.successTarget?.(response) ?? request.target;
      activityProducers.record({
        eventId: newActivityEventId("server"),
        occurredAt,
        actor: "owner",
        projectId: request.projectId ?? null,
        hostId: target.hostId,
        profileId: target.profileId,
        destinationOrigin: null,
        kind: request.kind,
        action: request.action,
        outcome: request.outcome(response),
        interrupted: false,
        interruptionReason: null,
        durationMs: null,
      });
      return response;
    } catch (error) {
      activityProducers.record({
        eventId: newActivityEventId("server"),
        occurredAt,
        actor: "owner",
        projectId: request.projectId ?? null,
        hostId: request.target.hostId,
        profileId: request.target.profileId,
        destinationOrigin: null,
        kind: request.kind,
        action: request.action,
        outcome: "failed",
        interrupted: false,
        interruptionReason: null,
        durationMs: null,
      });
      throw error;
    }
  }

  function recordAdministrativeActivity<T extends { outcome: string }>(
    target: BrowserHostTarget,
    kind: BrowserActivityRecord["kind"],
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return recordActivity({
      target,
      kind,
      action,
      operation,
      outcome: (response) => response.outcome,
    });
  }

  function recordProfileActivity<T>(
    target: BrowserHostTarget,
    action: string,
    operation: () => Promise<T>,
    successTarget?: (response: T) => BrowserHostTarget,
  ): Promise<T> {
    return recordActivity({
      target,
      kind: "lifecycle",
      action,
      operation,
      outcome: () => "succeeded",
      successTarget,
    });
  }

  async function diagnostics(
    target: { hostId: string | null; profileId: string },
    signal?: AbortSignal,
  ) {
    if (target.hostId === null) {
      throw new Error("Select a workspace host before requesting diagnostics.");
    }
    const readiness = await hostStatus(target.hostId, target.profileId, signal);
    if (readiness.state === "host-offline") {
      return unavailableDiagnostics(readiness);
    }
    try {
      return await host.call(
        "diagnostics",
        { hostId: target.hostId, profileId: target.profileId },
        { hostId: target.hostId, signal },
      );
    } catch {
      return unavailableDiagnostics(hostProbeFailedStatus(target));
    }
  }

  async function setupPlan(
    target: BrowserHostTarget,
    signal?: AbortSignal,
  ): Promise<BrowserSetupPlan> {
    await requireConnectedHost(target.hostId, signal);
    return host.call("setupPlan", target, { hostId: target.hostId, signal });
  }

  async function setup(
    request: BrowserSetupRequest,
    signal?: AbortSignal,
  ): Promise<BrowserSetupResponse> {
    const target = {
      hostId: request.hostId,
      profileId: request.profileId,
    };
    return recordAdministrativeActivity(
      target,
      "setup",
      request.stepId,
      async () => {
        await requireConnectedHost(request.hostId, signal);
        return host.call("setup", request, {
          hostId: request.hostId,
          signal,
        });
      },
    );
  }

  async function lifecycle(
    method: "disable" | "uninstall",
    request: BrowserLifecycleRequest,
    signal?: AbortSignal,
  ) {
    const target = {
      hostId: request.hostId,
      profileId: request.profileId,
    };
    return recordAdministrativeActivity(
      target,
      "lifecycle",
      method,
      async () => {
        await requireConnectedHost(request.hostId, signal);
        return host.call(method, request, {
          hostId: request.hostId,
          signal,
        });
      },
    );
  }

  async function purgePlan(
    target: BrowserHostTarget,
    signal?: AbortSignal,
  ): Promise<BrowserPurgePlan> {
    await requireConnectedHost(target.hostId, signal);
    return host.call("purgePlan", target, { hostId: target.hostId, signal });
  }

  async function purge(
    request: BrowserPurgeRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPurgeResponse> {
    const target = {
      hostId: request.hostId,
      profileId: request.profileId,
    };
    return recordAdministrativeActivity(target, "purge", "purge", async () => {
      await requireConnectedHost(request.hostId, signal);
      return host.call("purge", request, {
        hostId: request.hostId,
        signal,
      });
    });
  }

  async function browserScript(
    parameters: BrowserScriptParameters,
    context: PluginAgentToolContext,
  ) {
    const activityEventId = newActivityEventId("agent");
    const occurredAt = new Date().toISOString();
    const target = await resolveAgentScriptTarget(parameters, context);
    if (target.hostId === null) {
      return {
        ok: false as const,
        error: setupRequiredStatus({
          hostId: target.hostId,
          profileId: target.profileId,
        }),
      };
    }
    const activity: AgentActivityInput = {
      eventId: activityEventId,
      occurredAt,
      projectId: context.projectId,
      hostId: target.hostId,
      profileId: target.profileId,
      destinationOrigin: parameters.destinationOrigin ?? null,
    };
    return runAgentBrowserScriptCall({
      parameters,
      context,
      hostId: target.hostId,
      profileId: target.profileId,
      activity,
    });
  }

  subscribeToHostReconnects();

  return {
    browserScript,
    activityRecords,
    clearActivityRecords,
    createProfile,
    diagnostics,
    exportActivityRecords,
    lifecycle,
    purge,
    purgePlan,
    profiles,
    hostChoices,
    renameProfile,
    resolveTarget,
    settingsStatuses,
    setup,
    setupPlan,
    selectedStatus,
    status,
    selectProfile,
  };
}

export type BrowserService = ReturnType<typeof createBrowserService>;
