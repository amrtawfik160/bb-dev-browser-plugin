import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ACTIVITY_OUTBOX_BATCH_LIMIT,
  ACTIVITY_RECORD_LIMIT,
  browserActivityEventIdSchema,
  browserActivityEventFromOutboxItem,
  browserActivityEventSchema,
  browserActivityOutboxItemSchema,
  type BrowserActivityEvent,
  type BrowserActivityOutboxItem,
} from "./contracts.js";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;
const activityOutboxStateSchema = z
  .object({
    version: z.literal(1),
    events: z.array(browserActivityOutboxItemSchema).max(ACTIVITY_RECORD_LIMIT),
  })
  .strict();
const activityEventIdsSchema = z
  .array(browserActivityEventIdSchema)
  .max(ACTIVITY_RECORD_LIMIT);
const activityOutboxLimitSchema = z
  .number()
  .int()
  .positive()
  .max(ACTIVITY_RECORD_LIMIT);

type ActivityOutboxState = z.infer<typeof activityOutboxStateSchema>;
type SerializedRunner = <T>(operation: () => Promise<T>) => Promise<T>;
type ActivityOutboxRuntime = {
  filePath: string;
  clock: () => Date;
  runSerialized: SerializedRunner;
};

export type ActivityOutboxOptions = {
  filePath: string;
  clock?: () => Date;
};

export type ActivityOutboxClaimRequest = {
  now: Date;
  limit?: number;
};

export type ActivityOutboxReconciliationRequest = {
  acknowledgedEventIds: string[];
  limit?: number;
};

export interface ActivityOutbox {
  enqueue(event: BrowserActivityEvent): Promise<void>;
  claim(
    request: ActivityOutboxClaimRequest,
  ): Promise<BrowserActivityOutboxItem[]>;
  acknowledge(eventIds: string[]): Promise<string[]>;
  reconcile(
    request: ActivityOutboxReconciliationRequest,
  ): Promise<BrowserActivityOutboxItem[]>;
  pending(): Promise<BrowserActivityOutboxItem[]>;
}

function emptyOutboxState(): ActivityOutboxState {
  return { version: 1, events: [] };
}

function missingFile(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readState(filePath: string): Promise<ActivityOutboxState> {
  try {
    const serialized = await readFile(filePath, "utf8");
    return activityOutboxStateSchema.parse(JSON.parse(serialized));
  } catch (error) {
    if (missingFile(error)) return emptyOutboxState();
    throw error;
  }
}

async function writeState(filePath: string, state: ActivityOutboxState) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
}

function activityEventKey(event: BrowserActivityEvent) {
  return JSON.stringify([
    event.eventId,
    event.actor,
    event.projectId,
    event.hostId,
    event.profileId,
    event.requestId,
    event.grantId,
    event.grantScope,
    event.grantElevations,
    event.destinationOrigin,
    event.occurredAt,
    event.kind,
    event.action,
    event.outcome,
    event.interrupted,
    event.interruptionReason,
    event.durationMs,
  ]);
}

function sameActivityEvent(
  left: BrowserActivityEvent,
  right: BrowserActivityEvent,
) {
  return activityEventKey(left) === activityEventKey(right);
}

function outboxLimit(limit: number | undefined) {
  return activityOutboxLimitSchema.parse(limit ?? ACTIVITY_OUTBOX_BATCH_LIMIT);
}

function activityRetryDelay(attempts: number) {
  return Math.min(
    RETRY_MAX_MS,
    RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 16),
  );
}

function dueActivityOutboxItems(
  state: ActivityOutboxState,
  now: Date,
  limit: number,
) {
  const nowIso = now.toISOString();
  return state.events
    .filter((outboxItem) => outboxItem.nextAttemptAt <= nowIso)
    .sort(
      (left, right) =>
        left.nextAttemptAt.localeCompare(right.nextAttemptAt) ||
        left.eventId.localeCompare(right.eventId),
    )
    .slice(0, limit);
}

function removeAcknowledged(
  state: ActivityOutboxState,
  acknowledgedEventIds: readonly string[],
) {
  const acknowledged = new Set(acknowledgedEventIds);
  state.events = state.events.filter(
    (outboxItem) => !acknowledged.has(outboxItem.eventId),
  );
}

function createSerializedRunner(): SerializedRunner {
  let chain: Promise<void> = Promise.resolve();
  return function runSerialized<T>(operation: () => Promise<T>) {
    const operationResult = chain.then(operation, operation);
    chain = operationResult.then(
      () => undefined,
      () => undefined,
    );
    return operationResult;
  };
}

function assertMatchingDuplicate(
  existing: BrowserActivityOutboxItem,
  event: BrowserActivityEvent,
) {
  if (!sameActivityEvent(browserActivityEventFromOutboxItem(existing), event)) {
    throw new Error(
      `Activity event ${event.eventId} was received with conflicting metadata.`,
    );
  }
}

function appendOutboxEvent(
  state: ActivityOutboxState,
  event: BrowserActivityEvent,
  clock: () => Date,
) {
  if (state.events.length >= ACTIVITY_RECORD_LIMIT) {
    throw new Error(
      "Browser activity outbox is full; acknowledgement required.",
    );
  }
  state.events.push(
    browserActivityOutboxItemSchema.parse({
      ...event,
      attempts: 0,
      nextAttemptAt: clock().toISOString(),
    }),
  );
}

async function enqueueEventNow(
  runtime: ActivityOutboxRuntime,
  event: BrowserActivityEvent,
) {
  const safeEvent = browserActivityEventSchema.parse(event);
  const state = await readState(runtime.filePath);
  const existing = state.events.find(
    (outboxItem) => outboxItem.eventId === safeEvent.eventId,
  );
  if (existing !== undefined) {
    assertMatchingDuplicate(existing, safeEvent);
    return;
  }
  appendOutboxEvent(state, safeEvent, runtime.clock);
  await writeState(runtime.filePath, state);
}

function enqueueEvent(
  runtime: ActivityOutboxRuntime,
  event: BrowserActivityEvent,
) {
  return runtime.runSerialized(() => enqueueEventNow(runtime, event));
}

function claimOutboxItem(
  state: ActivityOutboxState,
  outboxItem: BrowserActivityOutboxItem,
  now: Date,
) {
  const claimedItem = browserActivityOutboxItemSchema.parse({
    ...outboxItem,
    attempts: outboxItem.attempts + 1,
    nextAttemptAt: new Date(
      now.getTime() + activityRetryDelay(outboxItem.attempts + 1),
    ).toISOString(),
  });
  const outboxIndex = state.events.findIndex(
    (candidate) => candidate.eventId === outboxItem.eventId,
  );
  state.events[outboxIndex] = claimedItem;
  return claimedItem;
}

async function claimDueEventsNow(
  runtime: ActivityOutboxRuntime,
  request: ActivityOutboxClaimRequest,
) {
  const limit = outboxLimit(request.limit);
  const state = await readState(runtime.filePath);
  const dueOutboxItems = dueActivityOutboxItems(state, request.now, limit);
  const claimedItems = dueOutboxItems.map((outboxItem) =>
    claimOutboxItem(state, outboxItem, request.now),
  );
  if (claimedItems.length > 0) {
    await writeState(runtime.filePath, state);
  }
  return claimedItems;
}

function claimDueEvents(
  runtime: ActivityOutboxRuntime,
  request: ActivityOutboxClaimRequest,
) {
  return runtime.runSerialized(() => claimDueEventsNow(runtime, request));
}

async function acknowledgeEventsNow(
  runtime: ActivityOutboxRuntime,
  eventIds: string[],
) {
  const acknowledgedEventIds = activityEventIdsSchema.parse(eventIds);
  const state = await readState(runtime.filePath);
  const pendingCount = state.events.length;
  removeAcknowledged(state, acknowledgedEventIds);
  if (state.events.length !== pendingCount) {
    await writeState(runtime.filePath, state);
  }
  return [...new Set(acknowledgedEventIds)];
}

function acknowledgeEvents(runtime: ActivityOutboxRuntime, eventIds: string[]) {
  return runtime.runSerialized(() => acknowledgeEventsNow(runtime, eventIds));
}

async function reconcileEventsNow(
  runtime: ActivityOutboxRuntime,
  request: ActivityOutboxReconciliationRequest,
) {
  const acknowledgedEventIds = activityEventIdsSchema.parse(
    request.acknowledgedEventIds,
  );
  const state = await readState(runtime.filePath);
  const pendingCount = state.events.length;
  removeAcknowledged(state, acknowledgedEventIds);
  const recoveredItems = state.events.slice(0, outboxLimit(request.limit));
  if (state.events.length !== pendingCount) {
    await writeState(runtime.filePath, state);
  }
  return recoveredItems;
}

function reconcileEvents(
  runtime: ActivityOutboxRuntime,
  request: ActivityOutboxReconciliationRequest,
) {
  return runtime.runSerialized(() => reconcileEventsNow(runtime, request));
}

async function pendingEvents(runtime: ActivityOutboxRuntime) {
  const state = await readState(runtime.filePath);
  return [...state.events];
}

export function createActivityOutbox(
  options: ActivityOutboxOptions,
): ActivityOutbox {
  const runtime: ActivityOutboxRuntime = {
    filePath: options.filePath,
    clock: options.clock ?? (() => new Date()),
    runSerialized: createSerializedRunner(),
  };

  return {
    enqueue: (event) => enqueueEvent(runtime, event),
    claim: (request) => claimDueEvents(runtime, request),
    acknowledge: (eventIds) => acknowledgeEvents(runtime, eventIds),
    reconcile: (request) => reconcileEvents(runtime, request),
    pending: () => runtime.runSerialized(() => pendingEvents(runtime)),
  };
}
