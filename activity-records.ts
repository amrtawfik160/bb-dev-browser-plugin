import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ACTIVITY_RECORD_LIMIT,
  ACTIVITY_RETENTION_DAYS,
  browserActivityEventSchema,
  browserActivityExportSchema,
  browserActivityRecordSchema,
  browserActivityRecordsSchema,
  type BrowserActivityEvent,
  type BrowserActivityExport,
  type BrowserActivityRecord,
} from "./contracts.js";
import { BROWSER_AUTHORIZATION_MIGRATIONS } from "./authorization.js";

export { browserActivityEventFromOutboxItem as activityEventFromOutboxItem } from "./contracts.js";

const legacyDatabaseMigrations = [
  `CREATE TABLE browser_preferences (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    default_profile_id TEXT NOT NULL
  )`,
  `INSERT INTO browser_preferences (singleton, default_profile_id)
   VALUES (1, 'bb-personal')`,
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

const activityRecordsMigration = `
CREATE TABLE browser_activity_records_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'agent', 'system')),
  project_id TEXT,
  host_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  destination_origin TEXT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'setup', 'lifecycle', 'purge', 'agent-operation',
    'grant', 'control', 'mode', 'export'
  )),
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  interrupted INTEGER NOT NULL CHECK (interrupted IN (0, 1)),
  interruption_reason TEXT,
  duration_ms INTEGER
);
INSERT INTO browser_activity_records_v2 (
  id, event_id, actor, project_id, host_id, profile_id,
  destination_origin, occurred_at, kind, action, outcome,
  interrupted, interruption_reason, duration_ms
)
SELECT
  id, 'legacy-' || id, actor, NULL, host_id, profile_id,
  NULL, occurred_at, kind, action, outcome, interrupted, NULL, NULL
FROM browser_activity_records;
DROP TABLE browser_activity_records;
ALTER TABLE browser_activity_records_v2 RENAME TO browser_activity_records;
DROP TABLE browser_activity_outbox;
CREATE INDEX browser_activity_records_profile_time
  ON browser_activity_records (host_id, profile_id, occurred_at, id);
CREATE INDEX browser_activity_records_occurred_at
  ON browser_activity_records (occurred_at);
`;

const activityTombstonesMigration = `
CREATE TABLE browser_activity_tombstones (
  event_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  cleared_at TEXT NOT NULL
);
CREATE INDEX browser_activity_tombstones_host
  ON browser_activity_tombstones (host_id, cleared_at);
`;

export const BROWSER_DATABASE_MIGRATIONS = [
  ...legacyDatabaseMigrations,
  activityRecordsMigration,
  activityTombstonesMigration,
  ...BROWSER_AUTHORIZATION_MIGRATIONS,
] as const;

const activityRowSchema = z
  .object({
    id: z.number().int().positive(),
    event_id: z.string().min(1),
    actor: z.enum(["owner", "agent", "system"]),
    project_id: z.string().min(1).nullable(),
    host_id: z.string().min(1),
    profile_id: z.string().min(1),
    destination_origin: z.string().min(1).nullable(),
    occurred_at: z.string().datetime(),
    kind: z.enum([
      "setup",
      "lifecycle",
      "purge",
      "agent-operation",
      "grant",
      "control",
      "mode",
      "export",
    ]),
    action: z.string().min(1),
    outcome: z.string().min(1),
    interrupted: z.number().int().min(0).max(1),
    interruption_reason: z.string().min(1).nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type BrowserActivityInput = Omit<BrowserActivityEvent, "eventId"> & {
  eventId?: string;
};

export interface ActivityRecordStore {
  append(input: BrowserActivityInput): BrowserActivityRecord;
  ingest(events: readonly BrowserActivityEvent[]): string[];
  list(target: { hostId: string; profileId: string }): BrowserActivityRecord[];
  export(target: { hostId: string; profileId: string }): BrowserActivityExport;
  clear(target: { hostId: string; profileId: string }): number;
  acknowledgeClearedEvents(hostId: string, eventIds: readonly string[]): void;
  eventIds(hostId: string): string[];
  prune(): void;
}

export type ActivityProducerInput = Omit<BrowserActivityInput, "kind">;

export type ActivityRecordProducers = {
  record(input: BrowserActivityInput): BrowserActivityRecord;
  agent(input: ActivityProducerInput): BrowserActivityRecord;
  grant(input: ActivityProducerInput): BrowserActivityRecord;
  control(input: ActivityProducerInput): BrowserActivityRecord;
  mode(input: ActivityProducerInput): BrowserActivityRecord;
  fileExport(input: ActivityProducerInput): BrowserActivityRecord;
};

export function createActivityRecordProducers(
  store: Pick<ActivityRecordStore, "append">,
): ActivityRecordProducers {
  const forKind =
    (kind: BrowserActivityRecord["kind"]) => (input: ActivityProducerInput) =>
      store.append({ ...input, kind });

  return {
    record: (input) => store.append(input),
    agent: forKind("agent-operation"),
    grant: forKind("grant"),
    control: forKind("control"),
    mode: forKind("mode"),
    fileExport: forKind("export"),
  };
}

export function newActivityEventId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

function activityRecordFromRow(activityRow: unknown): BrowserActivityRecord {
  const parsed = activityRowSchema.parse(activityRow);
  return browserActivityRecordSchema.parse({
    id: parsed.id,
    eventId: parsed.event_id,
    actor: parsed.actor,
    projectId: parsed.project_id,
    hostId: parsed.host_id,
    profileId: parsed.profile_id,
    destinationOrigin: parsed.destination_origin,
    occurredAt: parsed.occurred_at,
    kind: parsed.kind,
    action: parsed.action,
    outcome: parsed.outcome,
    interrupted: parsed.interrupted === 1,
    interruptionReason: parsed.interruption_reason,
    durationMs: parsed.duration_ms,
  });
}

function sameActivityEvent(
  record: BrowserActivityRecord,
  event: BrowserActivityEvent,
) {
  return (
    record.eventId === event.eventId &&
    record.actor === event.actor &&
    record.projectId === event.projectId &&
    record.hostId === event.hostId &&
    record.profileId === event.profileId &&
    record.destinationOrigin === event.destinationOrigin &&
    record.occurredAt === event.occurredAt &&
    record.kind === event.kind &&
    record.action === event.action &&
    record.outcome === event.outcome &&
    record.interrupted === event.interrupted &&
    record.interruptionReason === event.interruptionReason &&
    record.durationMs === event.durationMs
  );
}

function activityEventValues(event: BrowserActivityEvent) {
  return [
    event.eventId,
    event.actor,
    event.projectId,
    event.hostId,
    event.profileId,
    event.destinationOrigin,
    event.occurredAt,
    event.kind,
    event.action,
    event.outcome,
    event.interrupted ? 1 : 0,
    event.interruptionReason,
    event.durationMs,
  ];
}

type ActivityStreamTarget = Pick<BrowserActivityEvent, "hostId" | "profileId">;
type ActivityRecordStoreRuntime = {
  database: Database.Database;
  clock: () => Date;
  recordCounts: Map<string, number>;
};

const activityEventIdRowSchema = z
  .object({ event_id: z.string().min(1) })
  .strict();

function activityStreamKey(target: ActivityStreamTarget) {
  return `${target.hostId}\u0000${target.profileId}`;
}

function activityStreamCount(
  database: Database.Database,
  target: ActivityStreamTarget,
) {
  return z.object({ count: z.number().int().nonnegative() }).parse(
    database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM browser_activity_records
           WHERE host_id = ? AND profile_id = ?`,
      )
      .get(target.hostId, target.profileId),
  ).count;
}

function activityRetentionCutoff(now: Date) {
  return new Date(
    now.getTime() - ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function deleteExpiredActivityRows(
  database: Database.Database,
  cutoff: string,
  target?: ActivityStreamTarget,
) {
  if (target === undefined) {
    database
      .prepare("DELETE FROM browser_activity_records WHERE occurred_at < ?")
      .run(cutoff);
    return;
  }
  database
    .prepare(
      `DELETE FROM browser_activity_records
       WHERE host_id = ? AND profile_id = ? AND occurred_at < ?`,
    )
    .run(target.hostId, target.profileId, cutoff);
}

function deleteOverflowActivityStreams(database: Database.Database) {
  database
    .prepare(
      `DELETE FROM browser_activity_records
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY host_id, profile_id
                    ORDER BY occurred_at DESC, id DESC
                  ) AS record_rank
           FROM browser_activity_records
         )
         WHERE record_rank > ?
       )`,
    )
    .run(ACTIVITY_RECORD_LIMIT);
}

function deleteOverflowActivityStream(
  database: Database.Database,
  target: ActivityStreamTarget,
) {
  database
    .prepare(
      `DELETE FROM browser_activity_records
       WHERE id IN (
         SELECT id
         FROM browser_activity_records
         WHERE host_id = ? AND profile_id = ?
         ORDER BY occurred_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    )
    .run(target.hostId, target.profileId, ACTIVITY_RECORD_LIMIT);
}

function pruneActivityRows(
  database: Database.Database,
  now: Date,
  target?: ActivityStreamTarget,
  knownCount?: number,
) {
  deleteExpiredActivityRows(database, activityRetentionCutoff(now), target);
  if (target === undefined) {
    deleteOverflowActivityStreams(database);
    return;
  }
  const count = knownCount ?? activityStreamCount(database, target);
  if (count > ACTIVITY_RECORD_LIMIT) {
    deleteOverflowActivityStream(database, target);
  }
}

type ActivityAppendOutcome = {
  record: BrowserActivityRecord;
  inserted: boolean;
};

function findActivityRecord(
  database: Database.Database,
  eventId: string,
): BrowserActivityRecord | undefined {
  const activityRow = database
    .prepare(
      `SELECT id, event_id, actor, project_id, host_id, profile_id,
              destination_origin, occurred_at, kind, action, outcome,
              interrupted, interruption_reason, duration_ms
       FROM browser_activity_records
       WHERE event_id = ?`,
    )
    .get(eventId);
  return activityRow === undefined
    ? undefined
    : activityRecordFromRow(activityRow);
}

function assertMatchingActivityEvent(
  existing: BrowserActivityRecord,
  event: BrowserActivityEvent,
) {
  if (!sameActivityEvent(existing, event)) {
    throw new Error(
      `Activity event ${event.eventId} was received with conflicting metadata.`,
    );
  }
}

function insertActivityEvent(
  database: Database.Database,
  event: BrowserActivityEvent,
): BrowserActivityRecord {
  const inserted = database
    .prepare(
      `INSERT INTO browser_activity_records
        (event_id, actor, project_id, host_id, profile_id,
         destination_origin, occurred_at, kind, action, outcome,
         interrupted, interruption_reason, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...activityEventValues(event));
  return browserActivityRecordSchema.parse({
    id: Number(inserted.lastInsertRowid),
    ...event,
  });
}

function appendEvent(
  database: Database.Database,
  event: BrowserActivityEvent,
): ActivityAppendOutcome {
  const existing = findActivityRecord(database, event.eventId);
  if (existing !== undefined) {
    assertMatchingActivityEvent(existing, event);
    return { record: existing, inserted: false };
  }
  return {
    record: insertActivityEvent(database, event),
    inserted: true,
  };
}

function appendActivityEvent(
  runtime: ActivityRecordStoreRuntime,
  event: BrowserActivityEvent,
) {
  const streamKey = activityStreamKey(event);
  const write = runtime.database.transaction(() => {
    const previousCount =
      runtime.recordCounts.get(streamKey) ??
      activityStreamCount(runtime.database, event);
    const appendResult = appendEvent(runtime.database, event);
    const nextCount = previousCount + (appendResult.inserted ? 1 : 0);
    pruneActivityRows(runtime.database, runtime.clock(), event, nextCount);
    runtime.recordCounts.set(
      streamKey,
      Math.min(nextCount, ACTIVITY_RECORD_LIMIT),
    );
    return appendResult.record;
  });
  return write();
}

function appendActivityInput(
  runtime: ActivityRecordStoreRuntime,
  input: BrowserActivityInput,
) {
  const event = browserActivityEventSchema.parse({
    ...input,
    eventId: input.eventId ?? newActivityEventId("server"),
  });
  return appendActivityEvent(runtime, event);
}

function ingestActivityEvents(
  runtime: ActivityRecordStoreRuntime,
  events: readonly BrowserActivityEvent[],
) {
  const parsedEvents = events.map((event) =>
    browserActivityEventSchema.parse(event),
  );
  const write = runtime.database.transaction(() => {
    const appendedEvents = parsedEvents.map((event) =>
      appendEvent(runtime.database, event),
    );
    pruneActivityRows(runtime.database, runtime.clock());
    return appendedEvents.map(({ record }) => record.eventId);
  });
  const eventIds = write();
  runtime.recordCounts.clear();
  return eventIds;
}

function selectActivityRecords(
  database: Database.Database,
  target: { hostId: string; profileId: string },
) {
  const rows = database
    .prepare(
      `SELECT id, event_id, actor, project_id, host_id, profile_id,
              destination_origin, occurred_at, kind, action, outcome,
              interrupted, interruption_reason, duration_ms
       FROM browser_activity_records
       WHERE host_id = ? AND profile_id = ?
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all(target.hostId, target.profileId);
  return browserActivityRecordsSchema.parse(rows.map(activityRecordFromRow));
}

function pruneActivityStore(runtime: ActivityRecordStoreRuntime) {
  const prune = runtime.database.transaction(() =>
    pruneActivityRows(runtime.database, runtime.clock()),
  );
  prune();
  runtime.recordCounts.clear();
}

function listActivityRecords(
  runtime: ActivityRecordStoreRuntime,
  target: { hostId: string; profileId: string },
) {
  pruneActivityStore(runtime);
  return selectActivityRecords(runtime.database, target);
}

function createExportActivityEvent(
  runtime: ActivityRecordStoreRuntime,
  target: { hostId: string; profileId: string },
): BrowserActivityEvent {
  return {
    eventId: newActivityEventId("server"),
    actor: "owner",
    projectId: null,
    hostId: target.hostId,
    profileId: target.profileId,
    destinationOrigin: null,
    occurredAt: runtime.clock().toISOString(),
    kind: "export",
    action: "activity-export",
    outcome: "succeeded",
    interrupted: false,
    interruptionReason: null,
    durationMs: null,
  };
}

function exportActivitySnapshot(
  runtime: ActivityRecordStoreRuntime,
  target: { hostId: string; profileId: string },
  exportEvent: BrowserActivityEvent,
) {
  return runtime.database.transaction(() => {
    appendEvent(runtime.database, exportEvent);
    pruneActivityRows(runtime.database, runtime.clock());
    return selectActivityRecords(runtime.database, target);
  })();
}

function exportActivityRecords(
  runtime: ActivityRecordStoreRuntime,
  target: { hostId: string; profileId: string },
) {
  const exportEvent = createExportActivityEvent(runtime, target);
  const records = exportActivitySnapshot(runtime, target, exportEvent);
  runtime.recordCounts.clear();
  return browserActivityExportSchema.parse({
    hostId: target.hostId,
    profileId: target.profileId,
    exportedAt: runtime.clock().toISOString(),
    records,
  });
}

function clearActivityRecords(
  runtime: ActivityRecordStoreRuntime,
  target: { hostId: string; profileId: string },
) {
  const remove = runtime.database.transaction(() => {
    runtime.database
      .prepare(
        `INSERT OR IGNORE INTO browser_activity_tombstones
           (event_id, host_id, profile_id, cleared_at)
         SELECT event_id, host_id, profile_id, ?
         FROM browser_activity_records
         WHERE host_id = ? AND profile_id = ?`,
      )
      .run(runtime.clock().toISOString(), target.hostId, target.profileId);
    return runtime.database
      .prepare(
        `DELETE FROM browser_activity_records
         WHERE host_id = ? AND profile_id = ?`,
      )
      .run(target.hostId, target.profileId).changes;
  });
  const clearedCount = remove();
  runtime.recordCounts.set(activityStreamKey(target), 0);
  return clearedCount;
}

function acknowledgeClearedEvents(
  database: Database.Database,
  hostId: string,
  eventIds: readonly string[],
) {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => "?").join(", ");
  database
    .prepare(
      `DELETE FROM browser_activity_tombstones
       WHERE host_id = ? AND event_id IN (${placeholders})`,
    )
    .run(hostId, ...eventIds);
}

function activityEventIdsForHost(database: Database.Database, hostId: string) {
  return database
    .prepare(
      `SELECT event_id
       FROM browser_activity_records
       WHERE host_id = ?
       UNION
       SELECT event_id
       FROM browser_activity_tombstones
       WHERE host_id = ?
       ORDER BY event_id ASC`,
    )
    .all(hostId, hostId)
    .map((activityRow) => activityEventIdRowSchema.parse(activityRow).event_id);
}

export function createActivityRecordStore(
  database: Database.Database,
  clock: () => Date = () => new Date(),
): ActivityRecordStore {
  const runtime: ActivityRecordStoreRuntime = {
    database,
    clock,
    recordCounts: new Map(),
  };
  return {
    append: (input) => appendActivityInput(runtime, input),
    ingest: (events) => ingestActivityEvents(runtime, events),
    list: (target) => listActivityRecords(runtime, target),
    export: (target) => exportActivityRecords(runtime, target),
    clear: (target) => clearActivityRecords(runtime, target),
    acknowledgeClearedEvents: (hostId, eventIds) =>
      acknowledgeClearedEvents(database, hostId, eventIds),
    eventIds: (hostId) => activityEventIdsForHost(database, hostId),
    prune: () => pruneActivityStore(runtime),
  };
}
