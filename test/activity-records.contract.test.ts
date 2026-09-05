import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_RECORD_LIMIT,
  browserActivityExportSchema,
  DEFAULT_PROFILE_ID,
  type BrowserActivityEvent,
} from "../contracts.js";
import {
  BROWSER_DATABASE_MIGRATIONS,
  createBrowserDatabaseMigrationPlan,
  createActivityRecordProducers,
  createActivityRecordStore,
} from "../activity-records.js";
import { GRANT_REQUEST_MIGRATION } from "../grant-requests.js";

const HOST_ID = "host-activity-test";
const PROFILE_ID = DEFAULT_PROFILE_ID;
const OTHER_PROFILE_ID = "profile-other";
const NOW = new Date("2026-08-27T00:00:00.000Z");
const predecessorActivityGrantMetadataMigration = `
ALTER TABLE browser_activity_records ADD COLUMN grant_id TEXT;
ALTER TABLE browser_activity_records ADD COLUMN grant_scope TEXT;
ALTER TABLE browser_activity_records ADD COLUMN grant_elevations TEXT;
`;

function activityEvent(
  overrides: Partial<BrowserActivityEvent> = {},
): BrowserActivityEvent {
  return {
    eventId: "activity-test-event",
    actor: "agent",
    projectId: "project-activity-test",
    hostId: HOST_ID,
    profileId: PROFILE_ID,
    destinationOrigin: "https://app.example.test",
    occurredAt: NOW.toISOString(),
    kind: "agent-operation",
    action: "browser-script",
    outcome: "succeeded",
    interrupted: false,
    interruptionReason: null,
    durationMs: 12,
    ...overrides,
  };
}

function activityProducerInput(overrides: Partial<BrowserActivityEvent> = {}) {
  const event = activityEvent(overrides);
  return {
    eventId: event.eventId,
    actor: event.actor,
    projectId: event.projectId,
    hostId: event.hostId,
    profileId: event.profileId,
    destinationOrigin: event.destinationOrigin,
    occurredAt: event.occurredAt,
    action: event.action,
    outcome: event.outcome,
    interrupted: event.interrupted,
    interruptionReason: event.interruptionReason,
    durationMs: event.durationMs,
  };
}

function createStore() {
  const backend = createFakePluginHost({ pluginId: "activity-records" });
  const database = backend.bb.storage.database();
  backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
  return {
    backend,
    database,
    store: createActivityRecordStore(database, () => NOW),
  };
}

async function disposeBackend(
  backend: ReturnType<typeof createFakePluginHost>,
) {
  await backend.harness.lifecycle.dispose();
}

describe("Browser activity record persistence", () => {
  it.each([
    { history: "fresh", migrationAt11: null },
    {
      history: "093 metadata without request",
      migrationAt11: predecessorActivityGrantMetadataMigration,
    },
    {
      history: "663 request without metadata",
      migrationAt11: GRANT_REQUEST_MIGRATION,
    },
    {
      history: "both schemas present",
      migrationAt11: `${GRANT_REQUEST_MIGRATION}\n${predecessorActivityGrantMetadataMigration}`,
    },
  ])("migrates the $history history by schema", async ({ migrationAt11 }) => {
    const backend = createFakePluginHost({
      pluginId: `activity-migration-${migrationAt11 === null ? "fresh" : "used"}`,
    });
    const database = backend.bb.storage.database();

    try {
      if (migrationAt11 !== null) {
        backend.bb.storage.migrate(database, [
          ...BROWSER_DATABASE_MIGRATIONS.slice(0, 11),
          migrationAt11,
        ]);
      }

      backend.bb.storage.migrate(
        database,
        createBrowserDatabaseMigrationPlan(database),
      );

      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_grant_request_events'",
          )
          .get(),
      ).toEqual({ name: "browser_grant_request_events" });
      expect(
        database
          .prepare("PRAGMA table_info(browser_activity_records)")
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(
        expect.arrayContaining([
          "grant_id",
          "grant_scope",
          "grant_elevations",
          "request_id",
        ]),
      );
      expect(
        database.prepare("SELECT id FROM _bb_migrations ORDER BY id").all(),
      ).toEqual(Array.from({ length: 15 }, (_, id) => ({ id })));
    } finally {
      await disposeBackend(backend);
    }
  });

  it("preserves predecessor activity records during migration", async () => {
    const backend = createFakePluginHost({ pluginId: "activity-predecessor" });
    const database = backend.bb.storage.database();

    try {
      backend.bb.storage.migrate(database, [
        ...BROWSER_DATABASE_MIGRATIONS.slice(0, 11),
        predecessorActivityGrantMetadataMigration,
      ]);
      database
        .prepare(
          `INSERT INTO browser_activity_records
             (event_id, actor, project_id, host_id, profile_id,
              destination_origin, occurred_at, kind, action, outcome,
              interrupted, interruption_reason, duration_ms,
              grant_id, grant_scope, grant_elevations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "predecessor-1",
          "owner",
          null,
          HOST_ID,
          PROFILE_ID,
          null,
          "2026-08-26T12:00:00.000Z",
          "lifecycle",
          "setup",
          "completed",
          0,
          null,
          null,
          null,
          null,
          null,
        );

      backend.bb.storage.migrate(
        database,
        createBrowserDatabaseMigrationPlan(database),
      );

      expect(
        createActivityRecordStore(database, () => NOW).list({
          hostId: HOST_ID,
          profileId: PROFILE_ID,
        }),
      ).toMatchObject([
        {
          eventId: "predecessor-1",
          actor: "owner",
          projectId: null,
          kind: "lifecycle",
          action: "setup",
        },
      ]);
    } finally {
      await disposeBackend(backend);
    }
  });

  it("rolls back a failed migration transaction", async () => {
    const backend = createFakePluginHost({ pluginId: "activity-rollback" });
    const database = backend.bb.storage.database();

    try {
      backend.bb.storage.migrate(
        database,
        createBrowserDatabaseMigrationPlan(database),
      );
      const appliedBefore = database
        .prepare("SELECT id FROM _bb_migrations ORDER BY id")
        .all();

      expect(() =>
        backend.bb.storage.migrate(database, [
          ...BROWSER_DATABASE_MIGRATIONS,
          "CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY)",
          "INSERT INTO missing_rollback_table (id) VALUES (1)",
        ]),
      ).toThrow();
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT id FROM _bb_migrations ORDER BY id").all(),
      ).toEqual(appliedBefore);
    } finally {
      await disposeBackend(backend);
    }
  });

  it("expires old records and caps each host/profile stream independently", async () => {
    const { backend, store } = createStore();

    try {
      store.append(
        activityEvent({
          eventId: "expired-event",
          occurredAt: "2026-07-26T23:59:59.999Z",
        }),
      );
      expect(store.list({ hostId: HOST_ID, profileId: PROFILE_ID })).toEqual(
        [],
      );

      const retainedEvents = Array.from(
        { length: ACTIVITY_RECORD_LIMIT + 1 },
        (_, index) =>
          activityEvent({
            eventId: `retained-event-${index}`,
            occurredAt: new Date(NOW.getTime() - index * 1_000).toISOString(),
          }),
      );
      store.ingest([
        activityEvent({
          eventId: "other-profile-event",
          profileId: OTHER_PROFILE_ID,
        }),
        ...retainedEvents,
      ]);

      const retained = store.list({ hostId: HOST_ID, profileId: PROFILE_ID });
      const otherProfile = store.list({
        hostId: HOST_ID,
        profileId: OTHER_PROFILE_ID,
      });

      expect(retained).toHaveLength(ACTIVITY_RECORD_LIMIT);
      expect(retained[0]?.eventId).toBe("retained-event-9999");
      expect(retained.at(-1)?.eventId).toBe("retained-event-0");
      expect(otherProfile).toHaveLength(1);
      expect(otherProfile[0]?.eventId).toBe("other-profile-event");
    } finally {
      await disposeBackend(backend);
    }
  });

  it.each([
    {
      action: "grant-created",
      eventId: "grant-event",
      kind: "grant",
      producer: "grant",
    },
    {
      action: "control-transferred",
      eventId: "control-event",
      kind: "control",
      producer: "control",
    },
    {
      action: "safe-login-entered",
      eventId: "mode-event",
      kind: "mode",
      producer: "mode",
    },
    {
      action: "file-export",
      eventId: "file-export-event",
      kind: "export",
      producer: "fileExport",
    },
  ] as const)(
    "provides the $producer producer for $kind activity records",
    async ({ action, eventId, kind, producer }) => {
      const { backend, store } = createStore();

      try {
        const activityProducer = createActivityRecordProducers(store)[producer];
        const event = activityProducer(
          activityProducerInput({ eventId, action }),
        );

        expect(event).toMatchObject({ kind, action });
        expect(
          store
            .list({ hostId: HOST_ID, profileId: PROFILE_ID })
            .map((record) => record.kind),
        ).toEqual([kind]);
      } finally {
        await disposeBackend(backend);
      }
    },
  );

  it("exports and clears only the authenticated target stream", async () => {
    const { backend, store } = createStore();

    try {
      store.append(activityEvent({ eventId: "before-export" }));
      store.append(
        activityEvent({
          eventId: "other-profile-record",
          profileId: OTHER_PROFILE_ID,
        }),
      );

      const exported = browserActivityExportSchema.parse(
        store.export({ hostId: HOST_ID, profileId: PROFILE_ID }),
      );
      expect(exported.records).toHaveLength(2);
      expect(exported.records.map((record) => record.action)).toEqual([
        "browser-script",
        "activity-export",
      ]);

      expect(store.clear({ hostId: HOST_ID, profileId: PROFILE_ID })).toBe(2);
      expect(store.list({ hostId: HOST_ID, profileId: PROFILE_ID })).toEqual(
        [],
      );
      expect(
        store.list({ hostId: HOST_ID, profileId: OTHER_PROFILE_ID }),
      ).toHaveLength(1);
    } finally {
      await disposeBackend(backend);
    }
  });
});
