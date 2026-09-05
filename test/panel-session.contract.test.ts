import { describe, expect, it } from "vitest";
import { PANEL_RECLAIM_WINDOW_MS } from "../src/shared/contracts.js";
import { createControlLeaseManager } from "../src/browser/control-lease.js";
import { createPanelSessionRegistry } from "../src/panel/panel-session.js";
import type { ScreencastSource } from "../src/panel/panel-transport.js";
import { waitFor } from "./wait.js";

const HOST_ID = "host-session";
const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";

function setup(options?: {
  reclaimWindowMs?: number;
  controlLeases?: ReturnType<typeof createControlLeaseManager>;
}) {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<
    unknown,
    { id: number; due: number; callback: () => void }
  >();
  const clock = {
    now: () => now,
    setTimeout(callback: () => void, delayMs: number) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { id, due: now + delayMs, callback });
      return id;
    },
    clearTimeout(id: unknown) {
      timers.delete(id);
    },
  };
  const sessions = createPanelSessionRegistry({
    clock,
    reclaimWindowMs: options?.reclaimWindowMs ?? PANEL_RECLAIM_WINDOW_MS,
    ...(options?.controlLeases === undefined
      ? {}
      : { controlLeases: options.controlLeases }),
  });
  return {
    sessions,
    clock,
    advanceTime(milliseconds: number) {
      now += milliseconds;
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.due <= now)
          .sort((left, right) => left.due - right.due || left.id - right.id);
        const timer = due[0];
        if (timer === undefined) break;
        timers.delete(timer.id);
        timer.callback();
      }
    },
  };
}

describe("shared Panel session per Browser Profile", () => {
  it("joins two panels on one Browser Profile into one session and isolates another profile", async () => {
    const { sessions } = setup();
    const shared = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const isolated = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_B,
    });

    expect(shared).toBe(
      sessions.sessionFor({ hostId: HOST_ID, profileId: PROFILE_A }),
    );
    expect(isolated).not.toBe(shared);

    await shared.joinPanel("panel-1", "owner-session-1");
    await shared.joinPanel("panel-2", "owner-session-2");
    await isolated.joinPanel("panel-3", "owner-session-3");

    expect(shared.snapshot().panels.map((panel) => panel.panelId)).toEqual([
      "panel-1",
      "panel-2",
    ]);
    expect(isolated.snapshot().panels.map((panel) => panel.panelId)).toEqual([
      "panel-3",
    ]);
    await sessions.dispose();
  });

  it("updates one membership record when the same panel identity reconnects", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const first = await session.joinPanel("panel-1", "owner-session-1");
    await first.activate();
    const second = await session.joinPanel("panel-1", "owner-session-1");

    expect(second.isActive()).toBe(false);
    expect(first.isActive()).toBe(true);
    expect(session.snapshot().panels).toEqual([
      expect.objectContaining({
        panelId: "panel-1",
        ownerSessionId: "owner-session-1",
        connection: "connected",
      }),
    ]);
    expect(
      session.snapshot().panels.filter((panel) => panel.panelId === "panel-1"),
    ).toHaveLength(1);
    await sessions.dispose();
  });

  it("makes a newer redeemed generation authoritative atomically and rejects the older one", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const first = await session.joinPanel("panel-1", "owner-session-1");
    const firstActivated = await first.activate();
    expect(firstActivated).toBe(true);
    expect(first.isActive()).toBe(true);

    const second = await session.joinPanel("panel-1", "owner-session-1");
    expect(first.isActive()).toBe(true);
    expect(second.isActive()).toBe(false);

    const secondActivated = await second.activate();
    expect(secondActivated).toBe(true);
    expect(second.isActive()).toBe(true);
    expect(first.isActive()).toBe(false);

    expect(await first.activate()).toBe(false);
    expect(
      session.snapshot().panels.filter((panel) => panel.panelId === "panel-1"),
    ).toHaveLength(1);
    await sessions.dispose();
  });

  it("keeps bounded reclaim membership after abrupt disconnect and removes a closed panel immediately", async () => {
    const { sessions, advanceTime } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const first = await session.joinPanel("panel-1", "owner-session-1");
    await first.activate();
    const second = await session.joinPanel("panel-2", "owner-session-2");
    await second.activate();

    expect(session.disconnectPanel("panel-1")).toBe(true);
    expect(session.snapshot().panels).toEqual([
      expect.objectContaining({
        panelId: "panel-1",
        connection: "disconnected",
        reclaimUntil: PANEL_RECLAIM_WINDOW_MS,
      }),
      expect.objectContaining({
        panelId: "panel-2",
        connection: "connected",
        reclaimUntil: null,
      }),
    ]);
    expect(first.isActive()).toBe(false);

    expect(session.closePanel("panel-2")).toBe(true);
    expect(session.snapshot().panels.map((panel) => panel.panelId)).toEqual([
      "panel-1",
    ]);

    advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);
    expect(session.snapshot().panels).toEqual([]);
    await sessions.dispose();
  });

  it("disposes every session generation on shutdown", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const joined = await session.joinPanel("panel-1", "owner-session-1");
    await joined.activate();

    await sessions.dispose();
    expect(session.snapshot().panels).toEqual([]);
    expect(joined.isActive()).toBe(false);
    expect(
      sessions.sessionFor({ hostId: HOST_ID, profileId: PROFILE_A }),
    ).not.toBe(session);
  });

  it("makes the first joined panel the controller and a later panel view-only", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    await session.joinPanel("panel-1", "owner-session-1");
    await session.joinPanel("panel-2", "owner-session-2");

    expect(session.role("panel-1")).toBe("controller");
    expect(session.role("panel-2")).toBe("spectator");
    expect(session.canInput("panel-1")).toBe(true);
    expect(session.canInput("panel-2")).toBe(false);
    expect(session.state().controllerPanelId).toBe("panel-1");
    await sessions.dispose();
  });

  it("broadcasts the same ordered Control Lease transition to every panel", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const seen: Array<string | null> = [];
    session.subscribe((state) => seen.push(state.controllerPanelId));
    await session.joinPanel("panel-1", "owner-session-1");
    await session.joinPanel("panel-2", "owner-session-2");
    await session.takeControl("panel-2");
    session.releaseControl("panel-2");
    await session.takeControl("panel-1");
    session.disconnectPanel("panel-1");
    session.connectPanel("panel-1", "owner-session-1");
    session.reclaimControl("panel-1");

    expect(seen).toEqual([
      "panel-1",
      "panel-1",
      "panel-2",
      null,
      "panel-1",
      null,
      null,
      "panel-1",
    ]);
    expect(session.state().controllerPanelId).toBe("panel-1");
    expect(session.canInput("panel-1")).toBe(true);
    expect(session.canInput("panel-2")).toBe(false);
    await sessions.dispose();
  });

  it("freezes input on controller disconnect and lets only the same panel reclaim within ten seconds", async () => {
    const { sessions, advanceTime } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    await session.joinPanel("panel-1", "owner-session-1");
    await session.joinPanel("panel-2", "owner-session-2");
    session.disconnectPanel("panel-1");

    expect(session.canInput("panel-1")).toBe(false);
    expect(session.state().controllerPanelId).toBeNull();
    await expect(session.takeControl("panel-2")).resolves.toBe(false);

    session.connectPanel("panel-1", "owner-session-1");
    expect(session.role("panel-1")).toBe("spectator");
    expect(session.reclaimControl("panel-1")).toBe(true);
    expect(session.canInput("panel-1")).toBe(true);

    session.disconnectPanel("panel-1");
    session.connectPanel("panel-1", "owner-session-1");
    advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);
    expect(session.reclaimControl("panel-1")).toBe(false);
    await session.takeControl("panel-2");
    expect(session.state().controllerPanelId).toBe("panel-2");
    await sessions.dispose();
  });

  it.each(["joinPanel", "connectPanel"] as const)(
    "keeps an expired former controller as a spectator after %s until it takes control",
    async (rejoin) => {
      const { sessions, advanceTime } = setup();
      const session = sessions.sessionFor({
        hostId: HOST_ID,
        profileId: PROFILE_A,
      });
      await session.joinPanel("panel-1", "owner-session-1");
      session.disconnectPanel("panel-1");
      advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);

      if (rejoin === "joinPanel") {
        await session.joinPanel("panel-1", "owner-session-1");
      } else {
        session.connectPanel("panel-1", "owner-session-1");
      }

      expect(session.role("panel-1")).toBe("spectator");
      expect(session.canInput("panel-1")).toBe(false);
      expect(session.state().controllerPanelId).toBeNull();
      expect(session.reclaimControl("panel-1")).toBe(false);
      expect(session.canInput("panel-1")).toBe(false);
      expect(session.state().controllerPanelId).toBeNull();

      await expect(session.takeControl("panel-1")).resolves.toBe(true);
      expect(session.role("panel-1")).toBe("controller");
      expect(session.canInput("panel-1")).toBe(true);
      expect(session.state().controllerPanelId).toBe("panel-1");
      await sessions.dispose();
    },
  );

  it("lets only the controller resize the shared viewport and clamps it to the streaming ceiling", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    session.connectPanel("panel-1", "owner-session-1", {
      width: 1280,
      height: 720,
    });
    session.connectPanel("panel-2", "owner-session-2", {
      width: 800,
      height: 600,
    });

    expect(session.state().controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });
    session.setViewport("panel-2", { width: 400, height: 300 });
    expect(session.state().controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });
    session.setViewport("panel-1", { width: 5000, height: 4000 });
    expect(session.state().controllerViewport).toEqual({
      width: 1920,
      height: 1080,
    });
    await sessions.dispose();
  });

  it("shows agent-held control and owner interruption on the shared session state", async () => {
    const controlLeases = createControlLeaseManager();
    const { sessions } = setup({ controlLeases });
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    session.connectPanel("panel-1", "owner-session-1");
    const lease = await controlLeases.acquireAgent(
      `${HOST_ID}\0${PROFILE_A}`,
      "Inspect the fixture",
    );
    lease.signal.addEventListener("abort", () => lease.release(), {
      once: true,
    });

    expect(session.state().agentPurpose).toBe("Inspect the fixture");
    await session.takeControl("panel-1");
    expect(lease.signal.aborted).toBe(true);
    expect(session.state().agentPurpose).toBeNull();
    controlLeases.dispose();
    await sessions.dispose();
  });

  it("broadcasts one ordered Browser Tab strip and active tab to every panel", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const isolated = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_B,
    });
    const seen: Array<{ tabs: string[]; activeTabId: string | null }> = [];
    session.subscribe(() => {
      const strip = session.snapshot().tabs;
      seen.push({
        tabs: strip.tabs.map((tab) => tab.tabId),
        activeTabId: strip.activeTabId,
      });
    });
    await session.joinPanel("panel-1", "owner-session-1");
    await session.joinPanel("panel-2", "owner-session-2");
    const first = session.tabStrip().openTab("https://example.test/a", "A");
    const second = session.tabStrip().openTab("https://example.test/b", "B");
    session.tabStrip().activateTab(first);

    expect(session.snapshot().tabs).toEqual(session.tabStrip().snapshot());
    expect(session.snapshot().tabs.tabs.map((tab) => tab.tabId)).toEqual([
      first,
      second,
    ]);
    expect(session.snapshot().tabs.activeTabId).toBe(first);
    expect(isolated.snapshot().tabs).toEqual({ tabs: [], activeTabId: null });
    expect(seen.at(-1)).toEqual({
      tabs: [first, second],
      activeTabId: first,
    });
    await sessions.dispose();
  });

  it("keeps a shared stream live when one panel connection is replaced or disconnected", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const frames: number[] = [];
    let starts = 0;
    let stops = 0;
    const stopWaiters: Array<() => void> = [];
    const source: ScreencastSource = {
      async start(onFrame, signal) {
        starts += 1;
        onFrame({
          sequence: starts,
          mimeType: "image/png",
          data: new Uint8Array([1]),
        });
        await new Promise<void>((resolve) => {
          const finish = () => resolve();
          stopWaiters.push(finish);
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener("abort", finish, { once: true });
        });
      },
      input() {},
      async stop() {
        stops += 1;
        for (const finish of stopWaiters.splice(0)) finish();
      },
    };
    await session.joinPanel("panel-1", "owner-session-1");
    await session.joinPanel("panel-2", "owner-session-2");
    const first = session.attachStreamSource(() => source);
    const second = session.attachStreamSource(() => source);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    void first.start((frame) => frames.push(frame.sequence), firstAbort.signal);
    void second.start(
      (frame) => frames.push(frame.sequence + 10),
      secondAbort.signal,
    );
    await Promise.resolve();
    expect(starts).toBe(1);
    expect(frames).toEqual([1, 11]);

    firstAbort.abort();
    await first.stop();
    session.closePanel("panel-1");
    await session.releaseIfIdle();
    expect(stops).toBe(0);
    expect(session.hasLiveStream()).toBe(true);

    source.input({});
    expect(stops).toBe(0);
    secondAbort.abort();
    await second.stop();
    session.closePanel("panel-2");
    await session.releaseIfIdle();
    expect(stops).toBe(1);
    expect(session.hasLiveStream()).toBe(false);
    await sessions.dispose();
  });

  it("releases stream resources when the final panel closes or reclaim expires", async () => {
    const { sessions, advanceTime } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    let stops = 0;
    const source: ScreencastSource = {
      async start(_onFrame, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      input() {},
      async stop() {
        stops += 1;
      },
    };
    await session.joinPanel("panel-1", "owner-session-1");
    await session.joinPanel("panel-2", "owner-session-2");
    const first = session.attachStreamSource(() => source);
    void first.start(() => undefined, new AbortController().signal);
    await Promise.resolve();
    session.closePanel("panel-1");
    await session.releaseIfIdle();
    expect(stops).toBe(0);
    expect(session.hasLiveStream()).toBe(true);

    session.closePanel("panel-2");
    await session.releaseIfIdle();
    expect(session.snapshot().panels).toEqual([]);
    expect(session.isIdle()).toBe(true);
    expect(stops).toBe(1);
    expect(session.hasLiveStream()).toBe(false);

    const reconnecting = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    await reconnecting.joinPanel("panel-3", "owner-session-3");
    const reconnectSource: ScreencastSource = {
      async start(_onFrame, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      input() {},
      async stop() {
        stops += 1;
      },
    };
    const reconnect = reconnecting.attachStreamSource(() => reconnectSource);
    void reconnect.start(() => undefined, new AbortController().signal);
    await Promise.resolve();
    reconnecting.disconnectPanel("panel-3");
    await reconnecting.releaseIfIdle();
    expect(reconnecting.hasLiveStream()).toBe(true);
    advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);
    expect(reconnecting.snapshot().panels).toEqual([]);
    await reconnecting.releaseIfIdle();
    expect(reconnecting.isIdle()).toBe(true);
    expect(reconnecting.hasLiveStream()).toBe(false);
    await sessions.dispose();
  });

  it("releases the shared stream when last-panel reclaim expires without a later session call", async () => {
    const { sessions, advanceTime } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    let stops = 0;
    const source: ScreencastSource = {
      async start(_onFrame, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      input() {},
      async stop() {
        stops += 1;
      },
    };
    await session.joinPanel("panel-1", "owner-session-1");
    session.setVisibility("panel-1", "visible");
    const attached = session.attachStreamSource(() => source);
    void attached.start(() => undefined, new AbortController().signal);
    await Promise.resolve();
    session.disconnectPanel("panel-1");
    expect(session.hasLiveStream()).toBe(true);
    expect(stops).toBe(0);

    advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);

    expect(stops).toBe(1);
    expect(session.hasLiveStream()).toBe(false);
    expect(session.visiblePanelIds()).toEqual([]);
    await sessions.dispose();
  });

  it("waits for the shared screencast source to stop during session dispose", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    let releaseSourceStop: (() => void) | undefined;
    let transportStops = 0;
    const source: ScreencastSource = {
      async start(_onFrame, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      input() {},
      async stop() {
        await new Promise<void>((resolve) => {
          releaseSourceStop = resolve;
        });
      },
    };
    const connection = await session.joinPanel("panel-1", "owner-session-1");
    const attached = session.attachStreamSource(() => source);
    void attached.start(() => undefined, new AbortController().signal);
    await Promise.resolve();
    connection.bindTransport({
      async stop() {
        transportStops += 1;
      },
      dismissOpenDialogs() {},
    });

    let disposeSettled = false;
    const disposing = Promise.resolve(session.dispose()).then(() => {
      disposeSettled = true;
    });
    await waitFor(() => releaseSourceStop !== undefined);
    expect(transportStops).toBe(1);
    expect(disposeSettled).toBe(false);

    releaseSourceStop?.();
    await disposing;
    expect(disposeSettled).toBe(true);
    await sessions.dispose();
  });

  it("tracks panel visibility on the shared session instead of a parallel registry", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    await session.joinPanel("panel-1", "owner-session-1");
    expect(session.setVisibility("panel-1", "visible")).toBe(true);
    expect(session.visiblePanelIds()).toEqual(["panel-1"]);
    expect(session.isIdle()).toBe(false);
    session.closePanel("panel-1");
    expect(session.isIdle()).toBe(false);
    expect(session.setVisibility("panel-1", "hidden")).toBe(true);
    expect(session.visiblePanelIds()).toEqual([]);
    expect(session.isIdle()).toBe(true);
    await sessions.dispose();
  });

  it("stops superseded transports and ignores their late disconnects", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const stopped: string[] = [];
    const first = await session.joinPanel("panel-1", "owner-session-1");
    first.bindTransport({
      async stop() {
        stopped.push("first");
        first.disconnect();
      },
      dismissOpenDialogs() {},
    });
    await first.activate();
    const second = await session.joinPanel("panel-1", "owner-session-1");
    second.bindTransport({
      async stop() {
        stopped.push("second");
      },
      dismissOpenDialogs() {},
    });
    expect(stopped).toEqual([]);
    expect(first.isActive()).toBe(true);
    await second.activate();
    await waitFor(() => stopped.includes("first"));
    expect(second.isActive()).toBe(true);
    expect(first.disconnect()).toBe(false);
    expect(session.state().panels[0]?.connection).toBe("connected");
    await session.stopPanelTransports("panel-1");
    expect(stopped).toEqual(["first", "second"]);
    await sessions.dispose();
  });

  it("replaces pending connections without interrupting the active transport", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const stopped: string[] = [];
    const active = await session.joinPanel("panel-1", "owner-session-1");
    active.bindTransport({
      async stop() {
        stopped.push("active");
      },
      dismissOpenDialogs() {},
    });
    await active.activate();
    const pending = await session.joinPanel("panel-1", "owner-session-1");
    pending.bindTransport({
      async stop() {
        stopped.push("pending");
        pending.disconnect();
      },
      dismissOpenDialogs() {},
    });
    const replacement = await session.joinPanel("panel-1", "owner-session-1");
    expect(stopped).toEqual(["pending"]);
    expect(active.isActive()).toBe(true);
    expect(await pending.activate()).toBe(false);
    expect(replacement.isActive()).toBe(false);
    await replacement.activate();
    expect(active.isActive()).toBe(false);
    expect(replacement.isActive()).toBe(true);
    await sessions.dispose();
  });
});
