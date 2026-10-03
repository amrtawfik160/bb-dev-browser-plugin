import { expect, it } from "vitest";
import { createBrowserOperationTraces } from "../src/host/browser-operation-traces.js";
import {
  BROWSER_TRACE_RETENTION_MS,
  browserOperationTracesSchema,
} from "../src/shared/browser-operation-trace.js";

const target = { hostId: "host-a", profileId: "profile-a" };

function fixture() {
  let now = Date.parse("2026-10-03T12:00:00Z");
  let elapsed = 0;
  return {
    store: createBrowserOperationTraces({
      now: () => now,
      monotonic: () => elapsed,
    }),
    advance(ms: number) {
      now += ms;
      elapsed += ms;
    },
  };
}

it("records error stages and durations without retaining arbitrary error content", async () => {
  const { store, advance } = fixture();
  const trace = store.start(target, "navigate");
  await trace.measure("readiness", async () => advance(10));
  await expect(
    trace.measure("browser-execute", async () => {
      advance(35);
      throw new Error("https://private.example/password?token=secret");
    }),
  ).rejects.toThrow("token=secret");
  trace.connectionRetried();
  trace.tabInventory(2, 4);
  trace.finish("tab_invalid");
  const snapshot = browserOperationTracesSchema.parse(store.snapshot(target));
  expect(snapshot.traces).toEqual([
    expect.objectContaining({
      traceId: trace.traceId,
      state: "failed",
      errorCode: "tab_invalid",
      durationMs: 45,
      connectionRetries: 1,
      tabCount: 2,
      tabGeneration: 4,
      stages: [
        { stage: "readiness", state: "succeeded", offsetMs: 0, durationMs: 10 },
        {
          stage: "browser-execute",
          state: "failed",
          offsetMs: 10,
          durationMs: 35,
        },
      ],
    }),
  ]);
  expect(JSON.stringify(snapshot)).not.toMatch(
    /private|password|token|secret/u,
  );
});

it("shows in-flight work and keeps overlapping operations separate", async () => {
  const { store, advance } = fixture();
  const first = store.start(target, "browser-script");
  let release!: () => void;
  const stage = first.measure(
    "browser-execute",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  advance(50);
  const second = store.start(target, "history");
  await second.measure("lease-wait", async () => advance(20));
  second.finish();
  const inFlight = store.snapshot(target).traces[0]!;
  expect(inFlight.state).toBe("running");
  expect(inFlight.durationMs).toBe(70);
  expect(inFlight.stages[0]).toMatchObject({
    state: "running",
    durationMs: 70,
  });
  release();
  await stage;
  first.finish();
  const completed = store.snapshot(target).traces;
  expect(completed[0]!.traceId).not.toBe(completed[1]!.traceId);
  expect(completed.map((trace) => trace.durationMs)).toEqual([70, 20]);
});

it("bounds retention by profile, worker, time, and stage count", async () => {
  const { store, advance } = fixture();
  for (let index = 0; index < 201; index++)
    store.start(target, "navigate").finish();
  const other = { ...target, profileId: "other-profile" };
  const otherTrace = store.start(other, "history", true);
  for (let index = 0; index < 30; index++)
    await otherTrace.measure("renderer-check", async () => {});
  otherTrace.finish();
  expect(store.snapshot(target).traces).toHaveLength(200);
  expect(store.snapshot(other).traces).toHaveLength(1);
  expect(store.snapshot(other).traces[0]!.stages).toHaveLength(24);
  expect(store.snapshot({ ...target, hostId: "another-host" }).traces).toEqual(
    [],
  );
  for (let index = 0; index < 1_000; index++)
    store
      .start({ ...target, profileId: `profile-${index}` }, "navigate")
      .finish();
  expect(store.snapshot(target).traces).toEqual([]);
  advance(BROWSER_TRACE_RETENTION_MS);
  expect(
    store.snapshot({ ...target, profileId: "profile-999" }).traces,
  ).toEqual([]);
});

it("isolates snapshots from callers and distinguishes worker restarts", () => {
  const { store } = fixture();
  store.start(target, "navigate").finish();
  store.snapshot(target).traces[0]!.stages.push({
    stage: "readiness",
    offsetMs: 0,
    durationMs: 999,
    state: "failed",
  });
  expect(store.snapshot(target).traces[0]!.stages).toEqual([]);
  expect(store.snapshot(target).workerId).not.toBe(
    fixture().store.snapshot(target).workerId,
  );
});
