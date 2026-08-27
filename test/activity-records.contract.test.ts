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
  createActivityRecordStore,
} from "../activity-records.js";

const HOST_ID = "host-activity-test";
const PROFILE_ID = DEFAULT_PROFILE_ID;
const OTHER_PROFILE_ID = "profile-other";
const NOW = new Date("2026-08-27T00:00:00.000Z");

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
  it("upgrades predecessor records and rolls back a failed migration transaction", async () => {
    const backend = createFakePluginHost({ pluginId: "activity-migration" });
    const database = backend.bb.storage.database();

    try {
      backend.bb.storage.migrate(database, [
        ...BROWSER_DATABASE_MIGRATIONS.slice(0, 6),
      ]);
      database
        .prepare(
          `INSERT INTO browser_activity_records
             (occurred_at, actor, host_id, profile_id, kind, action, outcome, interrupted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "2026-08-26T12:00:00.000Z",
          "owner",
          HOST_ID,
          PROFILE_ID,
          "lifecycle",
          "setup",
          "completed",
          0,
        );

      backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
      const migrated = createActivityRecordStore(database, () => NOW).list({
        hostId: HOST_ID,
        profileId: PROFILE_ID,
      });

      expect(migrated).toMatchObject([
        {
          eventId: "legacy-1",
          actor: "owner",
          projectId: null,
          kind: "lifecycle",
          action: "setup",
        },
      ]);

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
