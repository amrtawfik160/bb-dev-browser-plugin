import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createActivitySync } from "../src/activity/activity-sync.js";
import { createActivityOutbox } from "../src/activity/activity-outbox.js";
import {
  BROWSER_DATABASE_MIGRATIONS,
  createActivityRecordStore,
} from "../src/activity/activity-records.js";
import {
  ACTIVITY_OUTBOX_BATCH_LIMIT,
  browserActivityAcknowledgementRequestSchema,
  browserActivityOutboxRequestSchema,
  browserActivityReconciliationRequestSchema,
  type BrowserActivityEvent,
} from "../src/shared/contracts.js";
import { browserHostContract } from "../src/shared/host-contract.js";

const NOW = new Date("2026-09-05T00:00:00.000Z");
const TARGET = { hostId: "host-sync", profileId: "profile-sync" };
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function event(
  eventId: string,
  overrides: Partial<BrowserActivityEvent> = {},
): BrowserActivityEvent {
  return {
    ...TARGET,
    eventId,
    projectId: "project-sync",
    actor: "agent",
    destinationOrigin: "https://example.test",
    occurredAt: NOW.toISOString(),
    kind: "agent-operation",
    action: "browser-script",
    outcome: "succeeded",
    interrupted: false,
    interruptionReason: null,
    durationMs: 10,
    ...overrides,
  };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "bb-activity-sync-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let now = NOW;
  const outbox = createActivityOutbox({
    filePath: join(directory, "outbox.json"),
    clock: () => now,
  });
  const faults = { acknowledgement: false, disconnected: false };
  const backend = createFakePluginHost({
    pluginId: "activity-sync",
    sdk: {
      hosts: {
        list: async () => [
          {
            id: TARGET.hostId,
            name: "Activity sync host",
            type: "persistent" as const,
            status: faults.disconnected
              ? ("disconnected" as const)
              : ("connected" as const),
            maxPermissionMode: "full" as const,
            lastSeenAt: 1,
            lastRejectedProtocolVersion: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      switch (method) {
        case "reconcileActivity":
          return outbox.reconcile(
            browserActivityReconciliationRequestSchema.parse(input),
          );
        case "activityOutbox":
          return outbox.claim({
            now,
            limit: browserActivityOutboxRequestSchema.parse(input).limit,
          });
        case "acknowledgeActivity": {
          if (faults.acknowledgement)
            throw new Error("Host disconnected before acknowledgement");
          const { eventIds } =
            browserActivityAcknowledgementRequestSchema.parse(input);
          return { acknowledgedEventIds: await outbox.acknowledge(eventIds) };
        }
        case "listProfiles":
          return {
            hostId: TARGET.hostId,
            installationId: "installation-sync",
            selectedProfileId: TARGET.profileId,
            profiles: [],
          };
        default:
          throw new Error(`Unexpected host method: ${method}`);
      }
    },
  });
  cleanup.push(() => backend.harness.lifecycle.dispose());
  const database = backend.bb.storage.database();
  backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
  database.exec(
    "CREATE TABLE expired_authority (host_id TEXT, installation_id TEXT, profile_id TEXT)",
  );
  const store = createActivityRecordStore(database, () => NOW);
  const sync = createActivitySync({
    database,
    store,
    hosts: backend.bb.sdk.hosts,
    host: backend.bb.hosts.experimental_client({
      contract: browserHostContract,
    }),
    revokeExpiredProfile(target) {
      database
        .prepare("INSERT INTO expired_authority VALUES (?, ?, ?)")
        .run(target.hostId, target.installationId, target.profileId);
    },
  });
  return {
    ...sync,
    outbox,
    store,
    database,
    faults,
    advanceTime() {
      now = new Date(now.getTime() + 60 * 60 * 1000);
    },
  };
}

describe("activity synchronization", () => {
  it("drains multiple batches without duplicating events already stored on the server", async () => {
    const activity = await setup();
    activity.store.append(event("existing"));
    await activity.outbox.enqueue(event("existing"));
    for (let index = 0; index <= ACTIVITY_OUTBOX_BATCH_LIMIT; index += 1) {
      await activity.outbox.enqueue(event(`batch-${index}`));
    }
    await activity.sync(TARGET.hostId);
    expect(activity.store.list(TARGET)).toHaveLength(
      ACTIVITY_OUTBOX_BATCH_LIMIT + 2,
    );
    expect(await activity.outbox.pending()).toEqual([]);
    await activity.sync(TARGET.hostId);
    expect(activity.store.list(TARGET)).toHaveLength(
      ACTIVITY_OUTBOX_BATCH_LIMIT + 2,
    );
  });

  it("keeps committed records readable and reconciles after an interrupted acknowledgement", async () => {
    const activity = await setup();
    await activity.outbox.enqueue(event("retry"));
    activity.faults.acknowledgement = true;
    await activity.sync(TARGET.hostId);
    expect(activity.store.list(TARGET)).toHaveLength(1);
    expect(await activity.outbox.pending()).toHaveLength(1);
    activity.faults.acknowledgement = false;
    await activity.sync(TARGET.hostId);
    expect(activity.store.list(TARGET)).toHaveLength(1);
    expect(await activity.outbox.pending()).toEqual([]);
  });

  it("does not resurrect records cleared while acknowledgement was unavailable", async () => {
    const activity = await setup();
    await activity.outbox.enqueue(event("cleared"));
    activity.faults.acknowledgement = true;
    await activity.sync(TARGET.hostId);
    activity.store.clear(TARGET);
    activity.faults.acknowledgement = false;
    await activity.sync(TARGET.hostId);
    expect(activity.store.list(TARGET)).toEqual([]);
    expect(activity.store.eventIds(TARGET.hostId)).toEqual([]);
    expect(await activity.outbox.pending()).toEqual([]);
  });

  it("leaves the outbox intact while the host is offline", async () => {
    const activity = await setup();
    await activity.outbox.enqueue(event("offline"));
    activity.faults.disconnected = true;
    await activity.sync(TARGET.hostId);
    expect(activity.store.list(TARGET)).toEqual([]);
    expect(await activity.outbox.pending()).toHaveLength(1);
  });

  it("rolls back expired-profile authority changes if event ingestion fails, then retries atomically", async () => {
    const activity = await setup();
    await activity.outbox.enqueue(
      event("expired", {
        kind: "lifecycle",
        action: "archive-expired",
        outcome: "deleted",
      }),
    );
    activity.database
      .exec(`CREATE TRIGGER reject_activity BEFORE INSERT ON browser_activity_records
      BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`);
    await expect(activity.sync(TARGET.hostId)).rejects.toThrow(
      "simulated storage failure",
    );
    expect(
      activity.database.prepare("SELECT * FROM expired_authority").all(),
    ).toEqual([]);
    expect(activity.store.list(TARGET)).toEqual([]);
    expect(await activity.outbox.pending()).toHaveLength(1);
    activity.database.exec("DROP TRIGGER reject_activity");
    activity.advanceTime();
    await activity.sync(TARGET.hostId);
    expect(
      activity.database.prepare("SELECT * FROM expired_authority").all(),
    ).toEqual([
      {
        host_id: TARGET.hostId,
        installation_id: "installation-sync",
        profile_id: TARGET.profileId,
      },
    ]);
    expect(activity.store.list(TARGET)).toHaveLength(1);
    expect(await activity.outbox.pending()).toEqual([]);
  });
});
