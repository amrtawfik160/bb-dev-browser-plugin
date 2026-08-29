import type Database from "better-sqlite3";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  browserActivityRecordSchema,
  browserActivityRecordsSchema,
  browserProfileIdSchema,
  browserScriptParametersSchema,
  browserProfileUnavailableStatus,
  DEFAULT_PROFILE_ID,
  hostOfflineStatus,
  hostProbeFailedStatus,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserActivityRecord,
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
} from "./contracts.js";
import { browserHostContract } from "./host-contract.js";
import { dependencyInventory } from "./dependency-inventory.js";

const migrations = [
  `CREATE TABLE browser_preferences (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_profile_id TEXT NOT NULL
  )`,
  `INSERT INTO browser_preferences (singleton, default_profile_id)
   VALUES (1, '${DEFAULT_PROFILE_ID}')`,
  `CREATE TABLE browser_activity_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    actor TEXT NOT NULL CHECK (actor = 'owner'),
    host_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('setup', 'lifecycle', 'purge')),
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1))
  )`,
  `CREATE TABLE browser_activity_outbox (
    record_id INTEGER PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    acknowledged_at TEXT
  )`,
  `ALTER TABLE browser_preferences RENAME TO browser_preferences_legacy`,
  `CREATE TABLE browser_preferences (
    project_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    PRIMARY KEY (project_id, host_id)
  )`,
];

const activityRowSchema = z
  .object({
    id: z.number().int().positive(),
    occurred_at: z.string().datetime(),
    actor: z.literal("owner"),
    host_id: z.string().min(1),
    profile_id: z.string().min(1),
    kind: z.enum(["setup", "lifecycle", "purge"]),
    action: z.string().min(1),
    outcome: z.string().min(1),
    interrupted: z.number().int().min(0).max(1),
  })
  .strict();
type BrowserScriptParameters = z.output<typeof browserScriptParametersSchema>;
const profilePreferenceRowSchema = z
  .object({ profile_id: browserProfileIdSchema })
  .strict();
const SETTINGS_PROJECT_ID = "__browser_settings__";
type BrowserIdentity = {
  projectId?: string;
  threadId?: string;
  hostId?: string;
};
type ActivityRecordInput = Omit<BrowserActivityRecord, "id">;

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

function activityRecordFromRow(row: unknown): BrowserActivityRecord {
  const parsed = activityRowSchema.parse(row);
  return browserActivityRecordSchema.parse({
    id: parsed.id,
    occurredAt: parsed.occurred_at,
    actor: parsed.actor,
    hostId: parsed.host_id,
    profileId: parsed.profile_id,
    kind: parsed.kind,
    action: parsed.action,
    outcome: parsed.outcome,
    interrupted: parsed.interrupted === 1,
  });
}

function appendActivityRecord(
  database: Database.Database,
  input: ActivityRecordInput,
): BrowserActivityRecord {
  const append = database.transaction(() => {
    const inserted = database
      .prepare(
        `INSERT INTO browser_activity_records
          (occurred_at, actor, host_id, profile_id, kind, action, outcome, interrupted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.occurredAt,
        input.actor,
        input.hostId,
        input.profileId,
        input.kind,
        input.action,
        input.outcome,
        input.interrupted ? 1 : 0,
      );
    const record = browserActivityRecordSchema.parse({
      ...input,
      id: Number(inserted.lastInsertRowid),
    });
    database
      .prepare(
        `INSERT INTO browser_activity_outbox
          (record_id, occurred_at, payload)
         VALUES (?, ?, ?)`,
      )
      .run(record.id, record.occurredAt, JSON.stringify(record));
    database
      .prepare(
        `DELETE FROM browser_activity_records
         WHERE profile_id = ?
           AND id NOT IN (
             SELECT id FROM browser_activity_records
             WHERE profile_id = ? ORDER BY id DESC LIMIT 10000
           )`,
      )
      .run(record.profileId, record.profileId);
    database
      .prepare(
        `DELETE FROM browser_activity_records
         WHERE profile_id = ? AND occurred_at < datetime('now', '-30 days')`,
      )
      .run(record.profileId);
    database
      .prepare(
        `DELETE FROM browser_activity_outbox
         WHERE record_id NOT IN (SELECT id FROM browser_activity_records)`,
      )
      .run();
    return record;
  });
  return append();
}

function listActivityRecords(
  database: Database.Database,
  target: BrowserHostTarget,
): BrowserActivityRecord[] {
  const rows = database
    .prepare(
      `SELECT id, occurred_at, actor, host_id, profile_id, kind, action,
              outcome, interrupted
       FROM browser_activity_records
       WHERE host_id = ? AND profile_id = ?
       ORDER BY id ASC`,
    )
    .all(target.hostId, target.profileId);
  return browserActivityRecordsSchema.parse(rows.map(activityRecordFromRow));
}

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
  bb.storage.migrate(database, migrations);
  const host = bb.hosts.experimental_client({ contract: browserHostContract });

  async function hostConnection(hostId: string, signal?: AbortSignal) {
    const hosts = await bb.sdk.hosts.list({ signal });
    return hosts.find((candidate) => candidate.id === hostId)?.status ?? null;
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
    return listActivityRecords(database, target);
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
  }): Promise<T> {
    const occurredAt = new Date().toISOString();
    try {
      const response = await request.operation();
      const target = request.successTarget?.(response) ?? request.target;
      appendActivityRecord(database, {
        occurredAt,
        actor: "owner",
        hostId: target.hostId,
        profileId: target.profileId,
        kind: request.kind,
        action: request.action,
        outcome: request.outcome(response),
        interrupted: false,
      });
      return response;
    } catch (error) {
      appendActivityRecord(database, {
        occurredAt,
        actor: "owner",
        hostId: request.target.hostId,
        profileId: request.target.profileId,
        kind: request.kind,
        action: request.action,
        outcome: "failed",
        interrupted: false,
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
    const hostId = await resolvedHostId(bb, context);
    if (hostId === null) {
      return {
        ok: false as const,
        error: setupRequiredStatus({
          hostId,
          profileId: parameters.profileId ?? DEFAULT_PROFILE_ID,
        }),
      };
    }
    if ((await hostConnection(hostId, context.signal)) !== "connected") {
      return {
        ok: false as const,
        error: hostOfflineStatus({
          hostId,
          profileId: parameters.profileId ?? DEFAULT_PROFILE_ID,
        }),
      };
    }
    const profileId =
      parameters.profileId ?? (await selectedProfileId(context, hostId));
    return host.call(
      "browserScript",
      {
        purpose: parameters.purpose,
        code: parameters.code,
        profileId,
        ...(parameters.tabId === undefined ? {} : { tabId: parameters.tabId }),
        timeoutMs: parameters.timeoutMs,
        hostId,
        projectId: context.projectId,
        threadId: context.threadId,
      },
      { hostId, signal: context.signal },
    );
  }

  return {
    browserScript,
    activityRecords,
    createProfile,
    diagnostics,
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
