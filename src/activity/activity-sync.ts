import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import {
  activityEventFromOutboxItem,
  type ActivityRecordStore,
} from "./activity-records.js";
import {
  ACTIVITY_OUTBOX_BATCH_LIMIT,
  type BrowserActivityEvent,
} from "../shared/contracts.js";
import type { browserHostContract } from "../shared/host-contract.js";

type ActivitySyncOptions = {
  host: ExperimentalHostClient<typeof browserHostContract>;
  hosts: Pick<BbPluginApi["sdk"]["hosts"], "list">;
  store: ActivityRecordStore;
  database: Database.Database;
  revokeExpiredProfile(target: {
    hostId: string;
    installationId: string;
    profileId: string;
  }): void;
};

class ActivitySyncTransportError extends Error {
  constructor() {
    super("Browser activity synchronization is pending.");
    this.name = "ActivitySyncTransportError";
  }
}

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

export function createActivitySync(options: ActivitySyncOptions) {
  const { host, hosts, store, database, revokeExpiredProfile } = options;

  // Only host communication failures are retryable; database failures must propagate.
  async function callActivityTransport<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch {
      throw new ActivitySyncTransportError();
    }
  }

  async function hostIsConnected(hostId: string, signal?: AbortSignal) {
    const connected = await callActivityTransport(() => hosts.list({ signal }));
    return connected.some(
      (host) => host.id === hostId && host.status === "connected",
    );
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
    if (expiredProfileIds.length === 0) return store.ingest(events);
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
      revokeExpiredProfile(target);
    }
    return store.ingest(events);
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
      store.acknowledgeClearedEvents(hostId, acknowledged);
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
    let acknowledgedEventIds = store.eventIds(hostId);
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

  async function sync(hostId: string, signal?: AbortSignal) {
    try {
      if (!(await hostIsConnected(hostId, signal))) return;
      await syncConnectedActivity(hostId, signal);
    } catch (error) {
      if (!(error instanceof ActivitySyncTransportError)) throw error;
      // Keep local records available while the durable host outbox retries.
    }
  }

  return { sync };
}
