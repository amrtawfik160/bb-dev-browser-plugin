import { randomUUID } from "node:crypto";
import {
  BROWSER_TRACE_MAX_PER_PROFILE,
  BROWSER_TRACE_MAX_STAGES,
  BROWSER_TRACE_RETENTION_MS,
  type BrowserOperationTrace,
  type BrowserOperationTraceRecord,
  type BrowserOperationTracesSnapshot,
} from "../shared/browser-operation-trace.js";

const MAX_WORKER_TRACES = 1_000;

/** Bounded, metadata-only traces. No page data or arbitrary error strings. */
export function createBrowserOperationTraces(
  clock = { now: () => Date.now(), monotonic: () => performance.now() },
) {
  const workerId = randomUUID();
  type StoredTrace = {
    hostId: string;
    profileId: string;
    createdAt: number;
    started: number;
    record: BrowserOperationTraceRecord;
  };
  let records: StoredTrace[] = [];
  const elapsed = (started: number) => Math.max(0, clock.monotonic() - started);

  function prune() {
    const cutoff = clock.now() - BROWSER_TRACE_RETENTION_MS;
    records = records.filter((entry) => entry.createdAt > cutoff);
    if (records.length > MAX_WORKER_TRACES)
      records = records.slice(-MAX_WORKER_TRACES);
  }

  function start(
    target: { hostId: string; profileId: string },
    operation: BrowserOperationTraceRecord["operation"],
    targetedTab = false,
  ): BrowserOperationTrace {
    prune();
    const started = clock.monotonic();
    const record: BrowserOperationTraceRecord = {
      traceId: randomUUID(),
      operation,
      startedAt: new Date(clock.now()).toISOString(),
      durationMs: 0,
      state: "running",
      connectionRetries: 0,
      targetedTab,
      stages: [],
    };
    records.push({ ...target, createdAt: clock.now(), started, record });
    const profileRecords = records.filter(
      (entry) =>
        entry.hostId === target.hostId && entry.profileId === target.profileId,
    );
    const evicted = new Set(
      profileRecords.slice(0, -BROWSER_TRACE_MAX_PER_PROFILE),
    );
    records = records.filter((entry) => !evicted.has(entry));
    prune();
    return {
      traceId: record.traceId,
      async measure(stage, run) {
        const stageStarted = clock.monotonic();
        const span: BrowserOperationTraceRecord["stages"][number] = {
          stage,
          offsetMs: elapsed(started),
          durationMs: 0,
          state: "running",
        };
        if (record.stages.length < BROWSER_TRACE_MAX_STAGES)
          record.stages.push(span);
        try {
          const result = await run();
          span.state = "succeeded";
          return result;
        } catch (error) {
          span.state = "failed";
          throw error;
        } finally {
          span.durationMs = elapsed(stageStarted);
        }
      },
      connectionRetried() {
        record.connectionRetries += 1;
      },
      tabInventory(count, generation) {
        record.tabCount = count;
        record.tabGeneration = generation;
      },
      finish(errorCode) {
        if (record.state !== "running") return;
        record.state = errorCode === undefined ? "succeeded" : "failed";
        record.durationMs = elapsed(started);
        if (errorCode !== undefined) record.errorCode = errorCode;
      },
    };
  }

  function snapshot(target: {
    hostId: string;
    profileId: string;
  }): BrowserOperationTracesSnapshot {
    prune();
    return {
      workerId,
      retentionMs: BROWSER_TRACE_RETENTION_MS,
      maxTracesPerProfile: BROWSER_TRACE_MAX_PER_PROFILE,
      traces: records
        .filter(
          (entry) =>
            entry.hostId === target.hostId &&
            entry.profileId === target.profileId,
        )
        .map(({ record, started }) => ({
          ...record,
          durationMs:
            record.state === "running" ? elapsed(started) : record.durationMs,
          stages: record.stages.map((span) => ({
            ...span,
            durationMs:
              span.state === "running"
                ? Math.max(0, elapsed(started) - span.offsetMs)
                : span.durationMs,
          })),
        })),
    };
  }

  return { start, snapshot };
}
