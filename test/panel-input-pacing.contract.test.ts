import { describe, expect, it } from "vitest";
import { createInputPacer } from "../src/app/panel-input.js";
import {
  PANEL_CLIENT_INPUT_MAX_PER_SECOND,
  PANEL_GATEWAY_INPUT_MAX_PER_SECOND,
} from "../src/shared/contracts.js";

/** A manual clock and timer queue so pacing is deterministic. */
function createManualTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, delayMs: number) {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return id;
    },
    clearTimer(id: unknown) {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

type Sent = {
  kind: string;
  action?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
};

function wheel(deltaY: number, modifiers = 0) {
  return { kind: "wheel" as const, x: 10, y: 20, deltaX: 0, deltaY, modifiers };
}

function move(x: number) {
  return { kind: "mouse", action: "mouseMoved", x, y: 5 };
}

function createHarness() {
  const time = createManualTime();
  const sent: Array<{ at: number; payload: Sent }> = [];
  const pacer = createInputPacer({
    send: (payload) => sent.push({ at: time.now(), payload: payload as Sent }),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { time, sent, pacer };
}

function maxInAnySecond(times: number[]) {
  let max = 0;
  for (const start of times) {
    max = Math.max(
      max,
      times.filter((at) => at >= start && at < start + 1_000).length,
    );
  }
  return max;
}

describe("Browser Panel input pacing", () => {
  it("keeps the client cap below the host limit", () => {
    expect(PANEL_CLIENT_INPUT_MAX_PER_SECOND).toBeLessThan(
      PANEL_GATEWAY_INPUT_MAX_PER_SECOND,
    );
  });

  it("coalesces a burst of wheel events without losing scroll distance", () => {
    const { time, sent, pacer } = createHarness();
    // A trackpad flick: one wheel event per millisecond for half a second.
    for (let index = 0; index < 500; index += 1) {
      pacer.wheel(wheel(3));
      time.advance(1);
    }
    time.advance(1_000);
    const wheels = sent.filter((entry) => entry.payload.kind === "wheel");
    expect(wheels.length).toBeLessThan(30);
    expect(
      wheels.reduce((total, entry) => total + (entry.payload.deltaY ?? 0), 0),
    ).toBe(1_500);
  });

  it("sends the first wheel event immediately", () => {
    const { sent, pacer } = createHarness();
    pacer.wheel(wheel(4));
    expect(sent.map((entry) => entry.payload.deltaY)).toEqual([4]);
  });

  it("keeps wheel deltas with different modifiers apart", () => {
    const { time, sent, pacer } = createHarness();
    pacer.wheel(wheel(1));
    pacer.wheel(wheel(2));
    pacer.wheel(wheel(5, 2));
    time.advance(100);
    expect(
      sent.map((entry) => [entry.payload.deltaY, entry.payload.modifiers]),
    ).toEqual([
      [1, 0],
      [2, 0],
      [5, 2],
    ]);
  });

  it("sends only the latest pointer position while moves arrive faster than the pace", () => {
    const { time, sent, pacer } = createHarness();
    for (let x = 0; x < 100; x += 1) {
      pacer.move(move(x));
      time.advance(1);
    }
    time.advance(100);
    const moves = sent.map((entry) => entry.payload.x);
    expect(moves.length).toBeLessThan(10);
    expect(moves.at(-1)).toBe(99);
  });

  it("flushes a pending move before a click so the click lands in order", () => {
    const { sent, pacer } = createHarness();
    pacer.move(move(1));
    pacer.move(move(2));
    pacer.button({ kind: "mouse", action: "mousePressed", x: 2, y: 5 });
    expect(sent.map((entry) => entry.payload.action ?? "")).toEqual([
      "mouseMoved",
      "mouseMoved",
      "mousePressed",
    ]);
    expect(sent[1]?.payload.x).toBe(2);
  });

  it("never delays or drops keys", () => {
    const { sent, pacer } = createHarness();
    for (let index = 0; index < 80; index += 1)
      pacer.key({ kind: "key", action: "keyDown" });
    expect(sent).toHaveLength(80);
  });

  it("stays under the client cap in every one-second span while scrolling and moving", () => {
    const { time, sent, pacer } = createHarness();
    for (let tick = 0; tick < 3_000; tick += 1) {
      pacer.wheel(wheel(1));
      pacer.move(move(tick));
      time.advance(1);
    }
    time.advance(1_000);
    expect(maxInAnySecond(sent.map((entry) => entry.at))).toBeLessThanOrEqual(
      PANEL_CLIENT_INPUT_MAX_PER_SECOND,
    );
    expect(
      sent
        .filter((entry) => entry.payload.kind === "wheel")
        .reduce((total, entry) => total + (entry.payload.deltaY ?? 0), 0),
    ).toBe(3_000);
  });

  it("stays under the host limit when typing while scrolling", () => {
    const { time, sent, pacer } = createHarness();
    for (let tick = 0; tick < 3_000; tick += 1) {
      pacer.wheel(wheel(1));
      pacer.move(move(tick));
      // Twenty keys a second, faster than sustained typing.
      if (tick % 50 === 0) pacer.key({ kind: "key", action: "keyDown" });
      time.advance(1);
    }
    time.advance(1_000);
    expect(maxInAnySecond(sent.map((entry) => entry.at))).toBeLessThan(
      PANEL_GATEWAY_INPUT_MAX_PER_SECOND,
    );
    expect(sent.filter((entry) => entry.payload.kind === "key")).toHaveLength(
      60,
    );
  });

  it("flushes pending input when disposed", () => {
    const { sent, pacer } = createHarness();
    pacer.wheel(wheel(1));
    pacer.wheel(wheel(2));
    pacer.wheel(wheel(3));
    pacer.dispose();
    expect(
      sent.reduce((total, entry) => total + (entry.payload.deltaY ?? 0), 0),
    ).toBe(6);
  });
});
