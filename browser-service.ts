import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginCliContext,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  createBrowserDatabaseMigrationPlan,
  createActivityRecordStore,
  createActivityRecordProducers,
  activityEventFromOutboxItem,
  newActivityEventId,
  type ActivityRecordStore,
} from "./activity-records.js";
import {
  createProfileGrantStore,
  elevationIsActive,
  type BrowserAuthorizationDecision,
  type BrowserAuthorizationSuccess,
} from "./authorization.js";
import type { GrantRequestEvent } from "./grant-requests.js";
import {
  browserGrantRequestDecisionRequestSchema,
  browserGrantRequestDecisionResponseSchema,
  browserGrantRequestQuerySchema,
  browserGrantRequestsSchema,
  browserProfileIdSchema,
  browserProfileGrantSchema,
  browserProfileGrantsSchema,
  browserScriptParametersSchema,
  ACTIVITY_OUTBOX_BATCH_LIMIT,
  CLEAR_ACTIVITY_CONFIRMATION,
  RESET_PROFILE_CONFIRMATION,
  browserProfileUnavailableStatus,
  DEFAULT_PROFILE_ID,
  hostOfflineStatus,
  hostProbeFailedStatus,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserActivityEvent,
  type BrowserActivityRecord,
  type BrowserActivityExport,
  type BrowserActivityClearResponse,
  type BrowserScriptRequest,
  type BrowserHostChoice,
  type BrowserHostChoicesInput,
  type BrowserLifecycleRequest,
  type BrowserProfile,
  type BrowserProfileCreateRequest,
  type BrowserProfileDeleteRequest,
  type BrowserProfileBackupRequest,
  type BrowserProfileImportRequest,
  type BrowserProfileInventory,
  type BrowserProfileLifecycleResponse,
  type BrowserProfileQuery,
  type BrowserProfileRenameRequest,
  type BrowserProfileResetRequest,
  type BrowserProfileRecoveryResponse,
  type BrowserProfileRestoreRequest,
  type BrowserProfileSelectRequest,
  type BrowserProfileTarget,
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
  type BrowserActivityGrantMetadata,
  type BrowserGrantRequest,
  type BrowserGrantRequestDecisionRequest,
  type BrowserGrantRequestDecisionResponse,
  type BrowserGrantRequestQuery,
  type BrowserProfileGrant,
  type BrowserProfileGrantCreateRequest,
  type BrowserProfileGrantQuery,
  type BrowserProfileGrantRevokeRequest,
  type BrowserProfileGrantRevokeResponse,
  type BrowserPanelNavigationInput,
  type BrowserPanelHistoryInput,
  type BrowserPanelVisibilityRequest,
  type BrowserPanelCapabilityRequest,
  type BrowserPanelCapabilityResponse,
  type BrowserNavigationResponse,
  type BrowserTabStrip,
  type BrowserPanelControlRequest,
  type BrowserPanelControlResponse,
  type BrowserPanelTakeControlRequest,
  type BrowserPanelReclaimControlRequest,
  type BrowserPanelReleaseControlRequest,
  type BrowserTransferStageInput,
  type BrowserTransferStagingResponse,
  type BrowserTransferOutcome,
  type BrowserTransferReleaseOutcome,
  type BrowserTransferCancelOutcome,
  type BrowserTransferProgressResult,
  type BrowserControlLeaseState,
  type BrowserFileTransferAuthorization,
  type BrowserFileTransferDecision,
} from "./contracts.js";
import { browserHostContract } from "./host-contract.js";
import { dependencyInventory } from "./dependency-inventory.js";
import { authorizeFileTransfer } from "./transfer-staging.js";

const PROFILE_IMPORT_ACTIVITY_ACTION = ["imp", "ort"].join("");
const OWNER_SETTINGS_AUTHORITY_ERROR =
  "Browser grant administration requires the owner Settings transport.";

type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;
type AgentActivityInput = {
  eventId: string;
  occurredAt: string;
  projectId: string;
  hostId: string;
  profileId: string;
  destinationOrigin: string | null;
};
type AgentActivityOutcome = "succeeded" | "failed" | "interrupted";
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

const GRANT_REQUEST_ACTIVITY_ACTIONS = {
  requested: "grant-request-created",
  approved: "grant-request-approved",
  denied: "grant-request-denied",
  expired: "grant-request-expired",
  consumed: "grant-request-consumed",
  revoked: "grant-request-revoked",
} satisfies Record<GrantRequestEvent["eventType"], string>;

function grantRequestActivityOutcome(event: GrantRequestEvent) {
  if (event.eventType === "requested") return "pending";
  if (event.eventType !== "approved") return event.eventType;
  if (event.request.decision === "retry") return "retry-approved";
  if (event.request.decision === "one-hour") return "one-hour-approved";
  return "persisted";
}

function grantRequestActivityActor(event: GrantRequestEvent) {
  return event.actor;
}

function grantRequestActivityElevations(event: GrantRequestEvent) {
  const { request } = event;
  return {
    wholeWeb: false,
    fileTransfer: request.requestedElevations.fileTransfer,
    invalidCertificateOrigins: request.requestedElevations.invalidCertificate
      ? [request.origin]
      : [],
    persistentElevations: request.decision === "persist",
  };
}

function grantRequestActivityMetadata(event: GrantRequestEvent) {
  const { request } = event;
  return {
    requestId: request.requestId,
    grantId: event.grantId ?? event.temporaryGrant?.grantId ?? null,
    grantScope: request.origin,
    grantElevations: grantRequestActivityElevations(event),
  };
}

type LinkedAbortSignal = {
  signal: AbortSignal;
  dispose: () => void;
};

function linkedAbortSignal(signals: readonly AbortSignal[]): LinkedAbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener("abort", abort);
    },
  };
}

class ActivitySyncTransportError extends Error {
  constructor() {
    super("Browser activity synchronization is pending.");
    this.name = "ActivitySyncTransportError";
  }
}

function agentBrowserScriptRequest(
  call: AgentScriptCall,
  originScope: string | undefined,
  invalidCertificateOrigins: readonly string[],
): BrowserScriptRequest {
  return {
    purpose: call.parameters.purpose,
    code: call.parameters.code,
    ...(call.parameters.destinationOrigin === undefined
      ? {}
      : { destinationOrigin: call.parameters.destinationOrigin }),
    fileTransfer: call.parameters.fileTransfer,
    invalidCertificate: call.parameters.invalidCertificate,
    screenshot: call.parameters.screenshot,
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
    ...(originScope === undefined ? {} : { originScope }),
    ...(invalidCertificateOrigins.length === 0
      ? {}
      : { invalidCertificateOrigins: [...invalidCertificateOrigins] }),
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
type ProfileAuthoritySnapshot = {
  key: string;
  epoch: number;
};

function expiredLifecycleProfileIds(events: readonly BrowserActivityEvent[]) {
  return [
    ...new Set(
      events
        .filter(
          (event) =>
            event.kind === "lifecycle" &&
            event.action === "archive-expired" &&
            event.outcome === "deleted",
        )
        .map(({ profileId }) => profileId),
    ),
  ];
}

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
  backupProfile: {
    request: BrowserProfileBackupRequest;
    response: BrowserProfileRecoveryResponse;
  };
  restoreProfile: {
    request: BrowserProfileRestoreRequest;
    response: BrowserProfileRecoveryResponse;
  };
  importProfile: {
    request: BrowserProfileImportRequest;
    response: BrowserProfileRecoveryResponse;
  };
  archiveProfile: {
    request: BrowserProfileTarget;
    response: BrowserProfileLifecycleResponse;
  };
  restoreArchivedProfile: {
    request: BrowserProfileTarget;
    response: BrowserProfileLifecycleResponse;
  };
  resetProfile: {
    request: BrowserProfileResetRequest;
    response: BrowserProfileLifecycleResponse;
  };
  deleteProfile: {
    request: BrowserProfileDeleteRequest;
    response: BrowserProfileLifecycleResponse;
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
  const activeProfiles = inventory.profiles.filter(
    (profile) => profile.state === "active",
  );
  const selectedProfileId =
    preferredProfileId !== null &&
    activeProfiles.some((profile) => profile.profileId === preferredProfileId)
      ? preferredProfileId
      : (activeProfiles.find(
          ({ profileId }) => profileId === DEFAULT_PROFILE_ID,
        )?.profileId ??
        activeProfiles[0]?.profileId ??
        DEFAULT_PROFILE_ID);
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

export function createBrowserService(
  bb: BbPluginApi,
  suppliedOwnerAuthority?: unknown,
) {
  const ownerAuthority = suppliedOwnerAuthority ?? Symbol("browser-owner");
  const database = bb.storage.database();
  bb.storage.migrate(database, createBrowserDatabaseMigrationPlan(database));
  const activityStore: ActivityRecordStore =
    createActivityRecordStore(database);
  const activityProducers = createActivityRecordProducers(activityStore);
  const grantStore = createProfileGrantStore(database, {
    onGrantRequestEvent: (event) => recordGrantRequestActivity(event),
  });
  const activeGrantCalls = new Map<string, Set<AbortController>>();
  const profileLifecycleEpochs = new Map<string, number>();
  const inactiveProfileKeys = new Set<string>();
  const hostConnectionGenerations = new Map<string, number>();
  let grantStateQueue: Promise<void> = Promise.resolve();
  const host = bb.hosts.experimental_client({ contract: browserHostContract });

  function requireOwnerSettingsAuthority(candidate: unknown) {
    if (candidate !== ownerAuthority) {
      throw new Error(OWNER_SETTINGS_AUTHORITY_ERROR);
    }
  }

  function withGrantStateSerialization<T>(operation: () => T | Promise<T>) {
    const next = grantStateQueue.then(operation, operation);
    grantStateQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function profileAuthorityKey(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }) {
    return `${target.hostId}\u0000${target.installationId}\u0000${target.profileId}`;
  }

  function profileAuthoritySnapshot(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }): ProfileAuthoritySnapshot {
    const key = profileAuthorityKey(target);
    return { key, epoch: profileLifecycleEpochs.get(key) ?? 0 };
  }

  function assertProfileAuthorityCurrent(snapshot: ProfileAuthoritySnapshot) {
    if (!profileAuthorityIsCurrent(snapshot)) {
      throw new Error(
        "Browser Profile lifecycle changed before authority could commit.",
      );
    }
  }

  function profileAuthorityIsCurrent(snapshot: ProfileAuthoritySnapshot) {
    return (
      !inactiveProfileKeys.has(snapshot.key) &&
      (profileLifecycleEpochs.get(snapshot.key) ?? 0) === snapshot.epoch
    );
  }

  function markProfileAuthorityInactive(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }) {
    const key = profileAuthorityKey(target);
    profileLifecycleEpochs.set(key, (profileLifecycleEpochs.get(key) ?? 0) + 1);
    inactiveProfileKeys.add(key);
  }

  function markProfileAuthorityActive(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }) {
    const key = profileAuthorityKey(target);
    profileLifecycleEpochs.set(key, (profileLifecycleEpochs.get(key) ?? 0) + 1);
    inactiveProfileKeys.delete(key);
  }

  function trackGrantCall(grantId: string, controller: AbortController) {
    const calls = activeGrantCalls.get(grantId) ?? new Set<AbortController>();
    calls.add(controller);
    activeGrantCalls.set(grantId, calls);
    return () => {
      calls.delete(controller);
      if (calls.size === 0) activeGrantCalls.delete(grantId);
    };
  }

  function abortGrantCalls(grantId: string) {
    for (const controller of activeGrantCalls.get(grantId) ?? []) {
      controller.abort();
    }
  }

  function abortGrantCallsForRequestEvent(event: GrantRequestEvent) {
    if (event.eventType !== "expired" && event.eventType !== "revoked") {
      return;
    }
    const grantId = event.grantId ?? event.temporaryGrant?.grantId;
    if (grantId !== null && grantId !== undefined) abortGrantCalls(grantId);
  }

  function recordAgentActivity(
    input: AgentActivityInput,
    signal: AbortSignal,
    outcome: AgentActivityOutcome,
    startedAt: number,
  ) {
    const interrupted = signal.aborted || outcome === "interrupted";
    activityProducers.agent({
      ...input,
      actor: "agent",
      action: "browser-script",
      outcome: interrupted ? "interrupted" : outcome,
      interrupted,
      interruptionReason: signal.aborted
        ? "request-aborted"
        : interrupted
          ? "control-lease-revoked"
          : null,
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

  async function ingestHostActivityBatch(
    hostId: string,
    batch: Awaited<ReturnType<typeof reconcileActivityBatch>>,
    signal?: AbortSignal,
  ) {
    const events = batch.map(activityEventFromOutboxItem);
    const expiredProfileIds = expiredLifecycleProfileIds(events);
    if (expiredProfileIds.length === 0) return activityStore.ingest(events);
    const inventory = await callActivityTransport(() =>
      host.call("listProfiles", { hostId }, { hostId, signal }),
    );
    return database.transaction(() =>
      reconcileExpiredProfileAuthority(
        hostId,
        inventory.installationId,
        expiredProfileIds,
        events,
      ),
    )();
  }

  function reconcileExpiredProfileAuthority(
    hostId: string,
    installationId: string,
    profileIds: readonly string[],
    events: readonly BrowserActivityEvent[],
  ) {
    for (const profileId of profileIds) {
      const target = { hostId, installationId, profileId };
      markProfileAuthorityInactive(target);
      revokeProfileAuthority(target, "profile-deleted");
    }
    return activityStore.ingest(events);
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
    const acceptedEventIds = await ingestHostActivityBatch(
      hostId,
      batch,
      signal,
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

  function recordSystemGrantRevocation(
    grant: BrowserProfileGrant,
    action:
      | "project-deleted"
      | "profile-archived"
      | "profile-reset"
      | "profile-deleted",
  ) {
    activityProducers.grant({
      eventId: newActivityEventId("system"),
      occurredAt: new Date().toISOString(),
      actor: "system",
      projectId: grant.projectId,
      hostId: grant.hostId,
      profileId: grant.profileId,
      destinationOrigin: null,
      action,
      outcome: "revoked",
      interrupted: false,
      interruptionReason: null,
      durationMs: null,
      ...grantActivityMetadata(grant),
    });
  }

  function grantActivityMetadata(
    grant: BrowserProfileGrant | null | undefined,
  ): BrowserActivityGrantMetadata {
    if (grant === null || grant === undefined) {
      return {
        grantId: null,
        grantScope: null,
        grantElevations: null,
      };
    }
    return {
      grantId: grant.grantId,
      grantScope: grant.originScope,
      grantElevations: {
        wholeWeb: grant.wholeWeb,
        fileTransfer: grant.fileTransfer,
        invalidCertificateOrigins: grant.invalidCertificateOrigins,
        persistentElevations: grant.persistentElevations === true,
      },
    };
  }

  function recordGrantRequestActivity(event: GrantRequestEvent) {
    abortGrantCallsForRequestEvent(event);
    const request = event.request;
    activityProducers.grant({
      eventId: newActivityEventId("grant-request"),
      occurredAt: event.occurredAt,
      actor: grantRequestActivityActor(event),
      projectId: request.projectId,
      hostId: request.hostId,
      profileId: request.profileId,
      destinationOrigin: null,
      ...grantRequestActivityMetadata(event),
      action: GRANT_REQUEST_ACTIVITY_ACTIONS[event.eventType],
      outcome: grantRequestActivityOutcome(event),
      interrupted: false,
      interruptionReason: null,
      durationMs: null,
    });
  }

  function revokeDeletedProfileGrants(
    call: AgentScriptCall,
    installationId: string,
  ) {
    revokeProfileAuthority(
      {
        hostId: call.hostId,
        profileId: call.profileId,
        installationId,
      },
      "profile-deleted",
    );
  }

  function revokeProfileAuthority(
    target: BrowserProfileTarget & { installationId: string },
    action: "profile-archived" | "profile-reset" | "profile-deleted",
  ) {
    const revoked = grantStore.revokeProfile({
      hostId: target.hostId,
      installationId: target.installationId,
      profileId: target.profileId,
    });
    for (const grant of revoked) {
      abortGrantCalls(grant.grantId);
      recordSystemGrantRevocation(grant, action);
    }
  }

  function originDeniedResponse(
    call: AgentScriptCall,
    message: string,
    grantRequest: BrowserGrantRequest | null = null,
    deniedOrigin: string | null = null,
  ): BrowserScriptResponse {
    const surfacedMessage =
      grantRequest === null
        ? message
        : `${message} Browser Grant Request ${grantRequest.requestId} is pending. The denied script will not resume automatically; after an owner decision, explicitly retry against current page state.`;
    return {
      ok: false,
      error: {
        state: "origin-denied",
        code: "origin_denied",
        label: "Origin denied",
        hostId: call.hostId,
        profileId: call.profileId,
        message: surfacedMessage,
        origin: deniedOrigin ?? call.parameters.destinationOrigin ?? null,
        grantRequest,
      },
    };
  }

  function authorizationResult(
    call: AgentScriptCall,
    decision: BrowserAuthorizationDecision,
  ): BrowserScriptResponse | BrowserAuthorizationSuccess {
    if (decision.allowed) return decision;
    return originDeniedResponse(call, decision.message, decision.grantRequest);
  }

  function nextHostConnectionGeneration(hostId: string) {
    const generation = (hostConnectionGenerations.get(hostId) ?? 0) + 1;
    hostConnectionGenerations.set(hostId, generation);
    return generation;
  }

  async function bridgeHostConnection(
    hostId: string,
    state: "connected" | "disconnected",
  ) {
    const generation = nextHostConnectionGeneration(hostId);
    await host
      .call("hostConnection", { hostId, generation, state }, { hostId })
      .catch(() => {
        bb.log.warn(
          `Browser host ${state} transition is pending generation reconciliation.`,
        );
      });
  }

  async function connectedHostChanged(hostId: string) {
    await bridgeHostConnection(hostId, "connected");
    await syncActivity(hostId).catch(() => {
      bb.log.warn(
        "Browser activity synchronization failed; pending events will retry.",
      );
    });
  }

  async function reconcileConnectedHosts() {
    const hosts = await bb.sdk.hosts.list();
    await Promise.all(
      hosts
        .filter(({ status }) => status === "connected")
        .map(({ id }) => connectedHostChanged(id)),
    );
  }

  function subscribeToHostConnections() {
    const unsubscribe = bb.sdk.subscribe({
      event: "host:changed",
      callback: (event) => {
        if (event.changes.includes("host-disconnected")) {
          return event.id === undefined
            ? undefined
            : bridgeHostConnection(event.id, "disconnected");
        }
        if (!event.changes.includes("host-connected")) return;
        return event.id === undefined
          ? reconcileConnectedHosts()
          : connectedHostChanged(event.id);
      },
    });
    bb.onDispose(unsubscribe);
  }

  function subscribeToProjectDeletion() {
    const unsubscribe = bb.sdk.subscribe({
      event: "project:changed",
      callback: (event) => {
        if (event.id === undefined) return;
        if (
          !event.changes.includes("project-deleted") &&
          !event.changes.includes("project-created")
        ) {
          return;
        }
        return withGrantStateSerialization(() => {
          if (event.changes.includes("project-deleted")) {
            grantStore.projectCreated(event.id!);
            const revoked = grantStore.projectDeleted(event.id!);
            for (const grant of revoked) {
              abortGrantCalls(grant.grantId);
              recordSystemGrantRevocation(grant, "project-deleted");
            }
          }
          if (event.changes.includes("project-created")) {
            grantStore.projectCreated(event.id!);
          }
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
        response.ok
          ? "succeeded"
          : response.error.state === "runtime-error" &&
              response.error.code === "lease_revoked"
            ? "interrupted"
            : "failed",
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

  async function authorizeAgentScript(
    call: AgentScriptCall,
  ): Promise<BrowserScriptResponse | BrowserAuthorizationSuccess> {
    const readiness = await hostStatus(
      call.hostId,
      call.profileId,
      call.context.signal,
    );
    if (readiness.state !== "healthy") {
      return { ok: false as const, error: readiness };
    }
    const inventory = await profileInventory(
      { hostId: call.hostId },
      call.context.signal,
    );
    const profile = inventory.profiles.find(
      (candidate) => candidate.profileId === call.profileId,
    );
    if (profile === undefined) {
      revokeDeletedProfileGrants(call, inventory.installationId);
      return {
        ok: false as const,
        error: browserProfileUnavailableStatus({
          hostId: call.hostId,
          profileId: call.profileId,
        }),
      };
    }
    if (profile.state !== "active") {
      revokeProfileAuthority(
        {
          hostId: call.hostId,
          profileId: call.profileId,
          installationId: inventory.installationId,
        },
        "profile-archived",
      );
      return {
        ok: false as const,
        error: browserProfileUnavailableStatus({
          hostId: call.hostId,
          profileId: call.profileId,
        }),
      };
    }
    const target = {
      hostId: call.hostId,
      installationId: inventory.installationId,
      profileId: call.profileId,
    };
    const snapshot = profileAuthoritySnapshot(target);
    const decision: BrowserAuthorizationDecision | null =
      await withGrantStateSerialization(() => {
        if (!profileAuthorityIsCurrent(snapshot)) return null;
        return grantStore.authorize({
          projectId: call.context.projectId,
          ...target,
          origin: call.parameters.destinationOrigin ?? "",
          fileTransfer: call.parameters.fileTransfer,
          invalidCertificate: call.parameters.invalidCertificate,
        });
      });
    if (decision === null) {
      return {
        ok: false as const,
        error: browserProfileUnavailableStatus({
          hostId: call.hostId,
          profileId: call.profileId,
        }),
      };
    }
    return authorizationResult(call, decision);
  }

  async function runAuthorizedAgentScript(
    call: AgentScriptCall,
    grant: BrowserProfileGrant,
    temporaryGrant?: BrowserAuthorizationSuccess["temporaryGrant"],
  ) {
    const revocationController = new AbortController();
    const linked = linkedAbortSignal([
      call.context.signal,
      revocationController.signal,
    ]);
    const untrack = trackGrantCall(grant.grantId, revocationController);
    const originScope = (temporaryGrant ?? grant).originScope;
    const activeInvalidCertificateOrigins =
      temporaryGrant === undefined
        ? elevationIsActive(grant.invalidCertificateExpiresAt, new Date())
          ? grant.invalidCertificateOrigins
          : []
        : temporaryGrant.invalidCertificateOrigins;
    try {
      const currentGrant = grantStore.inspect(grant.grantId);
      const currentTemporary =
        temporaryGrant === undefined
          ? null
          : grantStore.inspectTemporaryGrant(temporaryGrant.grantId);
      if (
        (temporaryGrant === undefined &&
          (currentGrant === null || currentGrant.revokedAt !== null)) ||
        (temporaryGrant !== undefined && currentTemporary === null)
      ) {
        return await runWithAgentActivity(
          call.activity,
          call.hostId,
          call.context.signal,
          async () =>
            originDeniedResponse(
              call,
              "The Browser Profile Grant was revoked before execution.",
            ),
        );
      }
      const expiryTimer =
        temporaryGrant === undefined
          ? null
          : setTimeout(
              () => {
                void withGrantStateSerialization(() => {
                  grantStore.expireTemporaryGrant(
                    temporaryGrant.grantId,
                    new Date(temporaryGrant.expiresAt),
                  );
                  revocationController.abort();
                });
              },
              Math.max(
                0,
                new Date(temporaryGrant.expiresAt).getTime() - Date.now(),
              ),
            );
      try {
        return await runWithAgentActivity(
          call.activity,
          call.hostId,
          linked.signal,
          async () => {
            const response = await host.call(
              "browserScript",
              agentBrowserScriptRequest(
                call,
                originScope,
                activeInvalidCertificateOrigins,
              ),
              { hostId: call.hostId, signal: linked.signal },
            );
            return enrichRealBrowserDenial(
              call,
              grant.installationId,
              response,
            );
          },
        );
      } finally {
        if (expiryTimer !== null) clearTimeout(expiryTimer);
      }
    } finally {
      untrack();
      linked.dispose();
    }
  }

  async function enrichRealBrowserDenial(
    call: AgentScriptCall,
    installationId: string,
    response: BrowserScriptResponse,
  ): Promise<BrowserScriptResponse> {
    if (
      response.ok ||
      response.error.state !== "origin-denied" ||
      response.error.grantRequest !== null
    ) {
      return response;
    }
    const deniedOrigin = response.error.origin;
    if (deniedOrigin === null) return response;
    const decision: BrowserAuthorizationDecision =
      await withGrantStateSerialization(() =>
        grantStore.authorize({
          projectId: call.context.projectId,
          hostId: call.hostId,
          installationId,
          profileId: call.profileId,
          origin: deniedOrigin,
          fileTransfer: call.parameters.fileTransfer,
          invalidCertificate: call.parameters.invalidCertificate,
        }),
      );
    if (decision.allowed) return response;
    return originDeniedResponse(
      call,
      decision.message,
      decision.grantRequest,
      deniedOrigin,
    );
  }

  async function runAgentBrowserScriptCall(call: AgentScriptCall) {
    const authorization = await authorizeAgentScript(call);
    if ("ok" in authorization) {
      return runWithAgentActivity(
        call.activity,
        call.hostId,
        call.context.signal,
        async () => authorization,
      );
    }
    return runAuthorizedAgentScript(
      call,
      authorization.grant,
      authorization.temporaryGrant,
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
      !inventory.profiles.some(
        (profile) =>
          profile.profileId === profileId && profile.state === "active",
      )
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
      const preferred = inventory.profiles.find(
        (profile) => profile.profileId === profileId,
      );
      if (preferred === undefined) {
        return browserProfileUnavailableStatus({ hostId, profileId });
      }
      if (preferred.state === "archived") {
        saveSelectedProfilePreference(
          database,
          projectId,
          hostId,
          inventory.selectedProfileId,
        );
        return hostStatus(hostId, inventory.selectedProfileId, signal);
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

  async function grantTarget(
    request: BrowserProfileGrantCreateRequest,
    signal?: AbortSignal,
  ) {
    const projectGeneration = grantStore.projectGeneration(request.projectId);
    const resolution = await projectHostResolution(bb, request.projectId);
    if (!resolution.candidates.includes(request.hostId)) {
      throw new Error(
        `Workspace host ${request.hostId} is not attached to project ${request.projectId}.`,
      );
    }
    const inventory = await profileInventory(
      { hostId: request.hostId, projectId: request.projectId },
      signal,
    );
    const profile = inventory.profiles.find(
      (candidate) => candidate.profileId === request.profileId,
    );
    if (profile === undefined) {
      throw new Error(
        `Browser Profile ${request.profileId} is not available on host ${request.hostId}.`,
      );
    }
    if (profile.state !== "active") {
      throw new Error(
        `Archived Profile ${request.profileId} must be restored before granting access.`,
      );
    }
    if (
      request.installationId !== undefined &&
      request.installationId !== inventory.installationId
    ) {
      throw new Error(
        "The requested Browser Profile installation is no longer current.",
      );
    }
    return {
      inventory,
      profile,
      projectGeneration,
      authoritySnapshot: profileAuthoritySnapshot({
        hostId: request.hostId,
        installationId: inventory.installationId,
        profileId: request.profileId,
      }),
    };
  }

  async function grants(
    authority: unknown,
    query: Partial<BrowserProfileGrantQuery> = {},
  ) {
    requireOwnerSettingsAuthority(authority);
    return browserProfileGrantsSchema.parse(grantStore.list(query));
  }

  async function agentGrantRequestScope(
    context: PluginCliContext,
  ): Promise<BrowserGrantRequestQuery> {
    const hostId = await resolvedHostId(bb, context);
    if (hostId === null) {
      throw new Error(
        "Select a workspace host before reading Browser Grant Requests.",
      );
    }
    const projectId = await profileContextProjectId(bb, context);
    const inventory = await profileInventory(
      {
        hostId,
        projectId: context.projectId,
        threadId: context.threadId,
      },
      context.signal,
    );
    return {
      projectId,
      hostId,
      installationId: inventory.installationId,
      profileId: inventory.selectedProfileId,
    };
  }

  async function listAgentGrantRequests(context: PluginCliContext) {
    const scope = await agentGrantRequestScope(context);
    return browserGrantRequestsSchema.parse(grantStore.listRequests(scope));
  }

  async function inspectAgentGrantRequest(
    context: PluginCliContext,
    requestId: string,
  ) {
    const scope = await agentGrantRequestScope(context);
    const request = grantStore.inspectRequest(requestId);
    if (
      request === null ||
      request.projectId !== scope.projectId ||
      request.hostId !== scope.hostId ||
      request.installationId !== scope.installationId ||
      request.profileId !== scope.profileId
    ) {
      return null;
    }
    return request;
  }

  async function inspectGrant(authority: unknown, grantId: string) {
    requireOwnerSettingsAuthority(authority);
    const grant = grantStore.inspect(grantId);
    return grant === null ? null : browserProfileGrantSchema.parse(grant);
  }

  async function createGrant(
    authority: unknown,
    request: BrowserProfileGrantCreateRequest,
    signal?: AbortSignal,
  ) {
    requireOwnerSettingsAuthority(authority);
    const { inventory, projectGeneration, authoritySnapshot } =
      await grantTarget(request, signal);
    const target = {
      hostId: request.hostId,
      profileId: request.profileId,
    };
    return recordActivity({
      target,
      kind: "grant",
      action: "create",
      projectId: request.projectId,
      operation: () =>
        withGrantStateSerialization(() => {
          assertProfileAuthorityCurrent(authoritySnapshot);
          if (
            grantStore.projectGeneration(request.projectId) !==
            projectGeneration
          ) {
            throw new Error(
              `Project ${request.projectId} changed while the Browser Profile Grant was being created.`,
            );
          }
          return browserProfileGrantSchema.parse(
            grantStore.create({
              ...request,
              installationId: inventory.installationId,
            }),
          );
        }),
      grantMetadata: (grant) => grantActivityMetadata(grant),
      outcome: () => "succeeded",
    });
  }

  async function revokeGrant(
    authority: unknown,
    request: BrowserProfileGrantRevokeRequest,
  ): Promise<BrowserProfileGrantRevokeResponse> {
    requireOwnerSettingsAuthority(authority);
    const existing = grantStore.inspect(request.grantId);
    const response = await withGrantStateSerialization(() =>
      grantStore.revoke(request.grantId),
    );
    if (response.outcome === "revoked") abortGrantCalls(response.grantId);
    if (existing === null) return response;
    await recordActivity({
      target: { hostId: existing.hostId, profileId: existing.profileId },
      kind: "grant",
      action: "revoke",
      projectId: existing.projectId,
      operation: async () => response,
      outcome: (grantResponse) => grantResponse.outcome,
      grantMetadata: () => grantActivityMetadata(existing),
    });
    return response;
  }

  async function listGrantRequests(
    authority: unknown,
    query: Partial<BrowserGrantRequestQuery> = {},
  ) {
    requireOwnerSettingsAuthority(authority);
    return browserGrantRequestsSchema.parse(
      grantStore.listRequests(browserGrantRequestQuerySchema.parse(query)),
    );
  }

  async function inspectGrantRequest(authority: unknown, requestId: string) {
    requireOwnerSettingsAuthority(authority);
    const request = grantStore.inspectRequest(requestId);
    return request === null ? null : request;
  }

  async function grantRequestAuthoritySnapshot(pending: BrowserGrantRequest) {
    const inventory = await profileInventory({ hostId: pending.hostId });
    const profile = inventory.profiles.find(
      ({ profileId }) => profileId === pending.profileId,
    );
    if (
      profile?.state !== "active" ||
      inventory.installationId !== pending.installationId
    ) {
      throw new Error(
        `Browser Profile ${pending.profileId} lifecycle changed before approval could commit.`,
      );
    }
    return profileAuthoritySnapshot({
      hostId: pending.hostId,
      installationId: pending.installationId,
      profileId: pending.profileId,
    });
  }

  async function decideGrantRequest(
    authority: unknown,
    request: BrowserGrantRequestDecisionRequest,
  ): Promise<BrowserGrantRequestDecisionResponse> {
    requireOwnerSettingsAuthority(authority);
    const parsed = browserGrantRequestDecisionRequestSchema.parse(request);
    const pending = grantStore.inspectRequest(parsed.requestId);
    if (parsed.decision === "deny" || pending?.status !== "pending") {
      return browserGrantRequestDecisionResponseSchema.parse(
        await withGrantStateSerialization(() =>
          grantStore.decideRequest(parsed),
        ),
      );
    }
    const snapshot = await grantRequestAuthoritySnapshot(pending);
    return browserGrantRequestDecisionResponseSchema.parse(
      await withGrantStateSerialization(() => {
        assertProfileAuthorityCurrent(snapshot);
        return grantStore.decideRequest(parsed);
      }),
    );
  }

  async function revokeGrantRequest(
    authority: unknown,
    requestId: string,
  ): Promise<BrowserGrantRequestDecisionResponse> {
    requireOwnerSettingsAuthority(authority);
    const response = browserGrantRequestDecisionResponseSchema.parse(
      await withGrantStateSerialization(() =>
        grantStore.revokeRequest(requestId),
      ),
    );
    if (response.outcome === "revoked") {
      const grantId =
        response.temporaryGrant?.grantId ?? response.grant?.grantId;
      if (grantId !== undefined) abortGrantCalls(grantId);
    }
    return response;
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
        const snapshot = profileAuthoritySnapshot({
          hostId: request.hostId,
          installationId: inventory.installationId,
          profileId: request.profileId,
        });
        await withGrantStateSerialization(() => {
          assertProfileAuthorityCurrent(snapshot);
          saveSelectedProfilePreference(
            database,
            projectId,
            request.hostId,
            request.profileId,
          );
        });
        return inventoryWithSelectedProfile(inventory, request.profileId);
      },
    );
  }

  async function backupProfile(
    request: BrowserProfileBackupRequest,
    signal?: AbortSignal,
  ) {
    return recordProfileActivity(
      { hostId: request.hostId, profileId: request.profileId },
      "backup",
      () => callConnectedProfile("backupProfile", request, signal),
    );
  }

  async function restoreProfile(
    request: BrowserProfileRestoreRequest,
    signal?: AbortSignal,
  ) {
    return recordProfileActivity(
      { hostId: request.hostId, profileId: request.profileId },
      "restore",
      () => callConnectedProfile("restoreProfile", request, signal),
    );
  }

  async function importProfile(
    request: BrowserProfileImportRequest,
    signal?: AbortSignal,
  ) {
    return recordProfileActivity(
      { hostId: request.hostId, profileId: DEFAULT_PROFILE_ID },
      PROFILE_IMPORT_ACTIVITY_ACTION,
      () => callConnectedProfile("importProfile", request, signal),
      (response) =>
        response.outcome === "imported"
          ? { hostId: request.hostId, profileId: response.profileId }
          : { hostId: request.hostId, profileId: DEFAULT_PROFILE_ID },
    );
  }

  async function lifecycleProfile(
    request: BrowserProfileTarget,
    signal?: AbortSignal,
  ) {
    const inventory = await profileInventory(
      { hostId: request.hostId },
      signal,
    );
    const profile = inventory.profiles.find(
      ({ profileId }) => profileId === request.profileId,
    );
    if (profile === undefined) {
      throw new Error(
        `Browser Profile ${request.profileId} is not available on host ${request.hostId}.`,
      );
    }
    return { inventory, profile };
  }

  function replaceProfilePreferences(
    target: BrowserProfileTarget,
    inventory: BrowserProfileInventory,
  ) {
    const fallback = inventory.profiles.find(
      (profile) =>
        profile.profileId !== target.profileId && profile.state === "active",
    );
    if (fallback === undefined) return;
    database
      .prepare(
        "UPDATE browser_preferences SET profile_id = ? WHERE host_id = ? AND profile_id = ?",
      )
      .run(fallback.profileId, target.hostId, target.profileId);
  }

  function settingsDefaultProfileId(hostId: string) {
    return (
      selectedProfilePreference(database, SETTINGS_PROJECT_ID, hostId) ??
      DEFAULT_PROFILE_ID
    );
  }

  async function runDestructiveProfileLifecycle(
    request: BrowserProfileTarget,
    inventory: BrowserProfileInventory,
    action: "profile-archived" | "profile-reset" | "profile-deleted",
    operation: () => Promise<BrowserProfileLifecycleResponse>,
  ) {
    return withGrantStateSerialization(async () => {
      const target = { ...request, installationId: inventory.installationId };
      markProfileAuthorityInactive(target);
      revokeProfileAuthority(target, action);
      return operation();
    });
  }

  async function archiveProfile(
    authority: unknown,
    request: BrowserProfileTarget,
    signal?: AbortSignal,
  ) {
    requireOwnerSettingsAuthority(authority);
    const { inventory } = await lifecycleProfile(request, signal);
    return recordProfileLifecycleActivity(request, "archive", async () => {
      const response = await runDestructiveProfileLifecycle(
        request,
        inventory,
        "profile-archived",
        () => callConnectedProfile("archiveProfile", request, signal),
      );
      replaceProfilePreferences(request, inventory);
      return response;
    });
  }

  async function restoreArchivedProfile(
    authority: unknown,
    request: BrowserProfileTarget,
    signal?: AbortSignal,
  ) {
    requireOwnerSettingsAuthority(authority);
    const { inventory } = await lifecycleProfile(request, signal);
    return recordProfileLifecycleActivity(
      request,
      "restore-archived",
      async () => {
        const response = await callConnectedProfile(
          "restoreArchivedProfile",
          request,
          signal,
        );
        await withGrantStateSerialization(() =>
          markProfileAuthorityActive({
            ...request,
            installationId: inventory.installationId,
          }),
        );
        return response;
      },
    );
  }

  async function resetProfile(
    authority: unknown,
    request: BrowserProfileResetRequest,
    signal?: AbortSignal,
  ) {
    requireOwnerSettingsAuthority(authority);
    if (request.confirmation !== RESET_PROFILE_CONFIRMATION) {
      throw new Error(
        `Type exactly "${RESET_PROFILE_CONFIRMATION}" to confirm credential loss.`,
      );
    }
    const { inventory } = await lifecycleProfile(request, signal);
    return recordProfileLifecycleActivity(request, "reset", async () => {
      const response = await runDestructiveProfileLifecycle(
        request,
        inventory,
        "profile-reset",
        () => callConnectedProfile("resetProfile", request, signal),
      );
      await withGrantStateSerialization(() =>
        preserveResetProfileIntent(request, inventory, response),
      );
      return response;
    });
  }

  function preserveResetProfileIntent(
    request: BrowserProfileTarget,
    inventory: BrowserProfileInventory,
    response: BrowserProfileLifecycleResponse,
  ) {
    if (!("profile" in response)) return;
    database
      .prepare(
        "UPDATE browser_preferences SET profile_id = ? WHERE host_id = ? AND profile_id = ?",
      )
      .run(response.profile.profileId, request.hostId, request.profileId);
    markProfileAuthorityActive({
      hostId: request.hostId,
      installationId: inventory.installationId,
      profileId: response.profile.profileId,
    });
  }

  function profileDeletionTarget(
    request: BrowserProfileTarget,
    inventory: BrowserProfileInventory,
  ) {
    return { ...request, installationId: inventory.installationId };
  }

  async function deleteMissingProfileAuthority(
    request: Omit<BrowserProfileDeleteRequest, "defaultProfileId">,
    inventory: BrowserProfileInventory,
    signal?: AbortSignal,
  ) {
    return withGrantStateSerialization(async () => {
      const target = profileDeletionTarget(request, inventory);
      markProfileAuthorityInactive(target);
      revokeProfileAuthority(target, "profile-deleted");
      const response = await callConnectedProfile(
        "deleteProfile",
        {
          ...request,
          defaultProfileId: settingsDefaultProfileId(request.hostId),
        },
        signal,
      );
      replaceProfilePreferences(request, inventory);
      return response;
    });
  }

  function assertProfileDeleteRequest(
    profile: BrowserProfile,
    request: Omit<BrowserProfileDeleteRequest, "defaultProfileId">,
  ) {
    if (request.confirmation !== profile.name) {
      throw new Error(`Type the exact Browser Profile name "${profile.name}".`);
    }
    if (settingsDefaultProfileId(request.hostId) === request.profileId) {
      throw new Error(
        "Select another default Browser Profile before permanent deletion.",
      );
    }
  }

  function deletionFallbackProfileId(request: BrowserProfileTarget) {
    const profileId = settingsDefaultProfileId(request.hostId);
    if (profileId === request.profileId) {
      throw new Error(
        "Select another default Browser Profile before permanent deletion.",
      );
    }
    return profileId;
  }

  async function deleteExistingProfile(
    request: Omit<BrowserProfileDeleteRequest, "defaultProfileId">,
    inventory: BrowserProfileInventory,
    signal?: AbortSignal,
  ) {
    return withGrantStateSerialization(async () => {
      const defaultProfileId = deletionFallbackProfileId(request);
      const target = profileDeletionTarget(request, inventory);
      markProfileAuthorityInactive(target);
      revokeProfileAuthority(target, "profile-deleted");
      const response = await callConnectedProfile(
        "deleteProfile",
        { ...request, defaultProfileId },
        signal,
      );
      replaceProfilePreferences(request, inventory);
      return response;
    });
  }

  async function deleteProfile(
    authority: unknown,
    request: Omit<BrowserProfileDeleteRequest, "defaultProfileId">,
    signal?: AbortSignal,
  ) {
    requireOwnerSettingsAuthority(authority);
    const inventory = await profileInventory(
      { hostId: request.hostId },
      signal,
    );
    const profile = inventory.profiles.find(
      ({ profileId }) => profileId === request.profileId,
    );
    if (profile === undefined) {
      return recordProfileLifecycleActivity(request, "delete", () =>
        deleteMissingProfileAuthority(request, inventory, signal),
      );
    }
    assertProfileDeleteRequest(profile, request);
    return recordProfileLifecycleActivity(request, "delete", () =>
      deleteExistingProfile(request, inventory, signal),
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
    grantMetadata?: (response?: T) => BrowserActivityGrantMetadata;
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
        ...(request.grantMetadata?.(response) ?? grantActivityMetadata(null)),
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
        ...(request.grantMetadata?.() ?? grantActivityMetadata(null)),
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

  function recordProfileLifecycleActivity(
    target: BrowserHostTarget,
    action: string,
    operation: () => Promise<BrowserProfileLifecycleResponse>,
  ) {
    return recordActivity({
      target,
      kind: "lifecycle",
      action,
      operation,
      outcome: ({ outcome }) => outcome,
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

  async function navigate(
    request: BrowserPanelNavigationInput,
    signal?: AbortSignal,
  ): Promise<BrowserNavigationResponse> {
    const identity = panelIdentity(request);
    const hostId = await resolvedHostId(bb, identity);
    if (hostId === null || hostId !== request.hostId) {
      throw new Error("The selected workspace host is unavailable.");
    }
    const projectId = await profileContextProjectId(bb, identity);
    await requireConnectedHost(hostId, signal);
    return host.call(
      "navigate",
      {
        hostId,
        profileId: request.profileId,
        projectId,
        input: request.input,
        ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
        rawLocalhost: request.rawLocalhost ?? false,
      },
      { hostId, signal },
    );
  }

  async function history(
    request: BrowserPanelHistoryInput,
    signal?: AbortSignal,
  ): Promise<BrowserNavigationResponse> {
    const identity = panelIdentity(request);
    const hostId = await resolvedHostId(bb, identity);
    if (hostId === null || hostId !== request.hostId) {
      throw new Error("The selected workspace host is unavailable.");
    }
    const projectId = await profileContextProjectId(bb, identity);
    await requireConnectedHost(hostId, signal);
    return host.call(
      "history",
      {
        hostId,
        profileId: request.profileId,
        projectId,
        direction: request.direction,
        ...(request.tabId === undefined ? {} : { tabId: request.tabId }),
      },
      { hostId, signal },
    );
  }

  async function panelVisibility(
    request: BrowserPanelVisibilityRequest,
    signal?: AbortSignal,
  ) {
    await requireConnectedHost(request.hostId, signal);
    return host.call("panelVisibility", request, {
      hostId: request.hostId,
      signal,
    });
  }

  /**
   * Mint a single-use Panel Capability that bootstraps an authenticated stream
   * connection. BB Connect enrollment is required even for a locally
   * displayed client; the host never exposes the loopback gateway directly.
   * The capability binds to owner session, panel instance, host, and profile,
   * is redeemed in the first WebSocket message rather than a URL, rotates every
   * five minutes, and is revoked on panel close or profile switch. The
   * response never exposes transport secrets beyond the opaque single-use
   * secret and the dynamic loopback gateway port the server declares to BB
   * Connect for owner-session-gated tunneling.
   */
  async function panelCapability(
    request: BrowserPanelCapabilityRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelCapabilityResponse> {
    const identity = panelIdentity({
      surface: "thread",
      threadId: "panel-capability",
      hostId: request.hostId,
      profileId: request.profileId,
    });
    const hostId = await resolvedHostId(bb, identity);
    if (hostId === null || hostId !== request.hostId) {
      return {
        outcome: "unavailable",
        reason: "host-offline",
        message: "The selected workspace host is unavailable.",
      };
    }
    const status = await host.call(
      "status",
      { hostId, profileId: request.profileId },
      { hostId, signal },
    );
    const connectCapability = status.capabilities.find(
      (capability) => capability.id === "bb-connect",
    );
    if (
      connectCapability === undefined ||
      connectCapability.status !== "ready"
    ) {
      return {
        outcome: "unavailable",
        reason: "bb-connect-required",
        message:
          "Enroll this host in BB Connect before opening the Browser Panel.",
      };
    }
    if (status.state !== "healthy") {
      return {
        outcome: "unavailable",
        reason:
          status.state === "host-offline" ? "host-offline" : "setup-required",
        message: status.message,
      };
    }
    const transport = await host.call(
      "panelTransport",
      {
        hostId,
        profileId: request.profileId,
        panelId: request.panelId,
        ownerSessionId: request.ownerSessionId,
      },
      { hostId, signal },
    );
    const tunnel = await bb.hosts.ensureSharedPortTunnel(hostId);
    bb.hosts.declareSharedPorts(hostId, [transport.gatewayPort]);
    return {
      outcome: "issued",
      capabilityId: transport.capabilityId,
      secret: transport.secret,
      gatewayPort: transport.gatewayPort,
      tunnel: { label: tunnel.label, baseDomain: tunnel.baseDomain },
      expiresAt: transport.expiresAt,
      rotatesAt: transport.rotatesAt,
    };
  }

  /**
   * The shared ordered Browser Tab strip for one profile. Every Browser Panel
   * using that profile observes the same ordered tab set and one active tab;
   * popup windows are normalized into the strip and runtime tab identifiers
   * stay consistent for the life of the instance.
   */
  async function tabs(
    target: BrowserHostTarget,
    signal?: AbortSignal,
  ): Promise<BrowserTabStrip> {
    await requireConnectedHost(target.hostId, signal);
    return host.call("tabs", target, { hostId: target.hostId, signal });
  }

  /**
   * Join the shared Control Lease session for one panel's profile. The first
   * panel becomes the controller and owns the logical viewport; later panels
   * are view-only spectators that scale and letterbox that viewport. Returns
   * the panel's role plus the shared control state and tab strip so every
   * panel renders one coordinated view.
   */
  async function panelControl(
    request: BrowserPanelControlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelControlResponse> {
    await requireConnectedHost(request.hostId, signal);
    return host.call("panelControl", request, {
      hostId: request.hostId,
      signal,
    });
  }

  /**
   * The owner explicitly takes control. The transfer is atomic, visible to
   * every panel, and interrupts any active agent Control Lease while
   * preserving the page for human use.
   */
  async function takeControl(
    request: BrowserPanelTakeControlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelControlResponse> {
    await requireConnectedHost(request.hostId, signal);
    return host.call("takeControl", request, {
      hostId: request.hostId,
      signal,
    });
  }

  /**
   * The controller releases control and returns to spectator, making control
   * available to other panels and agents.
   */
  async function releaseControl(
    request: BrowserPanelReleaseControlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelControlResponse> {
    await requireConnectedHost(request.hostId, signal);
    return host.call("releaseControl", request, {
      hostId: request.hostId,
      signal,
    });
  }

  /**
   * A disconnected controller reclaims control within its 10-second window
   * after a reconnect. Input is not re-granted automatically; the owner must
   * reclaim explicitly so the reclaim path is observable and atomic.
   */
  async function reclaimControl(
    request: BrowserPanelReclaimControlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelControlResponse> {
    await requireConnectedHost(request.hostId, signal);
    return host.call("reclaimControl", request, {
      hostId: request.hostId,
      signal,
    });
  }

  subscribeToHostConnections();
  subscribeToProjectDeletion();

  /**
   * Stage an explicitly selected workspace or displaying-client file through
   * one-use Transfer Staging (issue #19). The host broker copies the file into
   * narrow-permission staging after realpath containment checks; the response
   * carries privacy-safe metadata and never the staged or unrelated paths.
   * Agent-initiated transfers are authorized first: they require the
   * file-transfer elevated grant and an active Control Lease.
   */
  async function transferStage(
    input: BrowserTransferStageInput,
    signal?: AbortSignal,
  ): Promise<BrowserTransferStagingResponse> {
    const hostId = input.hostId;
    await requireConnectedHost(hostId, signal);
    const actor = input.actor ?? "owner";
    if (actor === "agent") {
      const profileId = input.profileId ?? DEFAULT_PROFILE_ID;
      const fileTransferGranted = grantStore
        .list({ hostId, profileId })
        .some(
          (grant) =>
            grant.fileTransfer &&
            grant.revokedAt === null &&
            elevationIsActive(grant.fileTransferExpiresAt, new Date()),
        );
      const leaseState = await host.call(
        "controlLeaseState",
        { hostId, profileId },
        { hostId, signal },
      );
      const decision = authorizeFileTransfer({
        actor,
        fileTransferGranted,
        leaseActive: leaseState.active,
      });
      if (!decision.authorized) {
        return {
          outcome: "rejected",
          transferId: input.transferId,
          reason: "unauthorized",
          message:
            decision.reason === "file-transfer-grant-required"
              ? "Agent file transfers require the file-transfer grant."
              : "Agent file transfers require an active Control Lease.",
        };
      }
    }
    return host.call("transferStage", input, { hostId, signal });
  }

  /**
   * Consume a staged transfer: return the host-local staged path the browser
   * must read. The staged file is NOT released here; the caller invokes
   * `transferRelease` after the browser reads it so the one-use copy is removed.
   */
  async function transferConsume(
    transferId: string,
    hostId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTransferOutcome> {
    await requireConnectedHost(hostId, signal);
    return host.call(
      "transferConsume",
      { hostId, transferId },
      { hostId, signal },
    );
  }

  /**
   * Release a staged transfer after the browser has read it (or after a
   * failure), removing the one-use on-disk copy.
   */
  async function transferRelease(
    transferId: string,
    hostId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTransferReleaseOutcome> {
    await requireConnectedHost(hostId, signal);
    return host.call(
      "transferRelease",
      { hostId, transferId },
      { hostId, signal },
    );
  }

  /**
   * Cancel a staged transfer at the controller's request, removing the staged
   * copy. Distinct from `transferConsume`: consume reads, cancel aborts.
   */
  async function transferCancel(
    transferId: string,
    hostId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTransferCancelOutcome> {
    await requireConnectedHost(hostId, signal);
    return host.call(
      "transferCancel",
      { hostId, transferId },
      { hostId, signal },
    );
  }

  /**
   * Report privacy-safe progress for a staged transfer (never paths).
   */
  async function transferProgress(
    transferId: string,
    hostId: string,
    signal?: AbortSignal,
  ): Promise<BrowserTransferProgressResult> {
    await requireConnectedHost(hostId, signal);
    return host.call(
      "transferProgress",
      { hostId, transferId },
      { hostId, signal },
    );
  }

  /**
   * Report the active Control Lease state for a profile. Used by the transfer
   * path to enforce that agent transfers hold an active lease.
   */
  async function controlLeaseState(
    hostId: string,
    profileId: string,
    signal?: AbortSignal,
  ): Promise<BrowserControlLeaseState> {
    await requireConnectedHost(hostId, signal);
    return host.call(
      "controlLeaseState",
      { hostId, profileId },
      {
        hostId,
        signal,
      },
    );
  }

  /**
   * Decide whether an actor may initiate a file transfer. Owner transfers
   * always pass; agent transfers additionally require the file-transfer
   * elevated grant and an active Control Lease. The decision is privacy-safe.
   */
  function fileTransferAuthorization(
    authorization: BrowserFileTransferAuthorization,
  ): BrowserFileTransferDecision {
    return authorizeFileTransfer(authorization);
  }

  return {
    browserScript,
    navigate,
    history,
    panelVisibility,
    panelCapability,
    tabs,
    panelControl,
    takeControl,
    releaseControl,
    reclaimControl,
    grants,
    createGrant,
    inspectGrant,
    revokeGrant,
    listGrantRequests,
    inspectGrantRequest,
    listAgentGrantRequests,
    inspectAgentGrantRequest,
    decideGrantRequest,
    revokeGrantRequest,
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
    backupProfile,
    restoreProfile,
    importProfile,
    archiveProfile,
    restoreArchivedProfile,
    resetProfile,
    deleteProfile,
    resolveTarget,
    settingsStatuses,
    setup,
    setupPlan,
    selectedStatus,
    status,
    selectProfile,
    transferStage,
    transferConsume,
    transferRelease,
    transferCancel,
    transferProgress,
    controlLeaseState,
    fileTransferAuthorization,
  };
}

export type BrowserService = ReturnType<typeof createBrowserService>;
