import type Database from "better-sqlite3";
import type { BbPluginApi, PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  browserActivityRecordSchema,
  browserActivityRecordsSchema,
  browserScriptParametersSchema,
  DEFAULT_PROFILE_ID,
  hostOfflineStatus,
  hostProbeFailedStatus,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserActivityRecord,
  type BrowserLifecycleRequest,
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
];

const profileRowSchema = z.object({ default_profile_id: z.string().min(1) });
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
type BrowserIdentity = { projectId?: string; threadId?: string };
type ActivityRecordInput = Omit<BrowserActivityRecord, "id">;

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

function defaultProfileId(database: Database.Database): string {
  const row = database
    .prepare(
      "SELECT default_profile_id FROM browser_preferences WHERE singleton = 1",
    )
    .get();
  return profileRowSchema.parse(row).default_profile_id;
}

async function projectHostId(bb: BbPluginApi, projectId: string) {
  const project = await bb.sdk.projects.get({ projectId });
  return (
    project.sources.find((source) => source.isDefault)?.hostId ??
    project.sources[0]?.hostId ??
    null
  );
}

async function threadHostId(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null) {
    return projectHostId(bb, thread.projectId);
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return environment.hostId;
}

async function resolvedHostId(bb: BbPluginApi, identity: BrowserIdentity) {
  if (identity.threadId !== undefined) {
    return threadHostId(bb, identity.threadId);
  }
  if (identity.projectId !== undefined) {
    return projectHostId(bb, identity.projectId);
  }
  return null;
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
    ? { threadId: input.threadId }
    : { projectId: input.projectId ?? undefined };
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

  async function resolveTarget(
    identity: BrowserIdentity,
    profileId: string,
  ): Promise<BrowserHostTarget> {
    const hostId = await resolvedHostId(bb, identity);
    if (hostId === null) {
      throw new Error("Select a workspace host before changing Browser setup.");
    }
    return { hostId, profileId };
  }

  async function status(
    identity: BrowserIdentity,
    profileId = defaultProfileId(database),
    signal?: AbortSignal,
  ) {
    const hostId = await resolvedHostId(bb, identity);
    if (hostId === null) return setupRequiredStatus({ hostId, profileId });
    return hostStatus(hostId, profileId, signal);
  }

  async function settingsStatuses(profileId = defaultProfileId(database)) {
    const hosts = await bb.sdk.hosts.list();
    return Promise.all(
      hosts.map((candidate) => hostStatus(candidate.id, profileId)),
    );
  }

  async function activityRecords(target: BrowserHostTarget) {
    return listActivityRecords(database, target);
  }

  async function recordAdministrativeActivity<T extends { outcome: string }>(
    target: BrowserHostTarget,
    kind: BrowserActivityRecord["kind"],
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const occurredAt = new Date().toISOString();
    try {
      const response = await operation();
      appendActivityRecord(database, {
        occurredAt,
        actor: "owner",
        hostId: target.hostId,
        profileId: target.profileId,
        kind,
        action,
        outcome: response.outcome,
        interrupted: false,
      });
      return response;
    } catch (error) {
      appendActivityRecord(database, {
        occurredAt,
        actor: "owner",
        hostId: target.hostId,
        profileId: target.profileId,
        kind,
        action,
        outcome: "failed",
        interrupted: false,
      });
      throw error;
    }
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
    const profileId = parameters.profileId ?? defaultProfileId(database);
    const hostId = await resolvedHostId(bb, context);
    if (hostId === null) {
      return {
        ok: false as const,
        error: setupRequiredStatus({ hostId, profileId }),
      };
    }
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
    diagnostics,
    lifecycle,
    purge,
    purgePlan,
    resolveTarget,
    settingsStatuses,
    setup,
    setupPlan,
    status,
  };
}

export type BrowserService = ReturnType<typeof createBrowserService>;
