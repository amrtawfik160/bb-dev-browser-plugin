import { describe, expect, it } from "vitest";
import { PANEL_RECLAIM_WINDOW_MS } from "../contracts.js";
import { createControlLeaseManager } from "../control-lease.js";
import { createPanelSessionRegistry } from "../panel-session.js";

const HOST_ID = "host-session";
const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";

function setup(options?: {
  reclaimWindowMs?: number;
  controlLeases?: ReturnType<typeof createControlLeaseManager>;
}) {
  let now = 0;
  const clock = { now: () => now };
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
    },
  };
}

describe("shared Panel session per Browser Profile", () => {
  it("joins two panels on one Browser Profile into one session and isolates another profile", () => {
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

    shared.joinPanel("panel-1", "owner-session-1");
    shared.joinPanel("panel-2", "owner-session-2");
    isolated.joinPanel("panel-3", "owner-session-3");

    expect(shared.snapshot().panels.map((panel) => panel.panelId)).toEqual([
      "panel-1",
      "panel-2",
    ]);
    expect(isolated.snapshot().panels.map((panel) => panel.panelId)).toEqual([
      "panel-3",
    ]);
    sessions.dispose();
  });

  it("updates one membership record when the same panel identity reconnects", () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const first = session.joinPanel("panel-1", "owner-session-1");
    session.activateGeneration("panel-1", first.generation);
    const second = session.joinPanel("panel-1", "owner-session-1");

    expect(second.generation).toBeGreaterThan(first.generation);
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
    sessions.dispose();
  });

  it("makes a newer redeemed generation authoritative atomically and rejects the older one", () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const first = session.joinPanel("panel-1", "owner-session-1");
    const firstActivated = session.activateGeneration(
      "panel-1",
      first.generation,
    );
    expect(firstActivated.outcome).toBe("activated");
    expect(session.acceptsGeneration("panel-1", first.generation)).toBe(true);

    const second = session.joinPanel("panel-1", "owner-session-1");
    expect(session.acceptsGeneration("panel-1", first.generation)).toBe(true);
    expect(session.acceptsGeneration("panel-1", second.generation)).toBe(false);

    const secondActivated = session.activateGeneration(
      "panel-1",
      second.generation,
    );
    expect(secondActivated).toEqual({
      outcome: "activated",
      supersededGenerations: [first.generation],
    });
    expect(session.acceptsGeneration("panel-1", second.generation)).toBe(true);
    expect(session.acceptsGeneration("panel-1", first.generation)).toBe(false);

    expect(
      session.activateGeneration("panel-1", first.generation).outcome,
    ).toBe("rejected");
    expect(
      session.snapshot().panels.filter((panel) => panel.panelId === "panel-1"),
    ).toHaveLength(1);
    expect(session.snapshot().panels[0]?.generation).toBe(second.generation);
    sessions.dispose();
  });

  it("keeps bounded reclaim membership after abrupt disconnect and removes a closed panel immediately", () => {
    const { sessions, advanceTime } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const first = session.joinPanel("panel-1", "owner-session-1");
    session.activateGeneration("panel-1", first.generation);
    const second = session.joinPanel("panel-2", "owner-session-2");
    session.activateGeneration("panel-2", second.generation);

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
    expect(session.acceptsGeneration("panel-1", first.generation)).toBe(false);

    expect(session.closePanel("panel-2")).toBe(true);
    expect(session.snapshot().panels.map((panel) => panel.panelId)).toEqual([
      "panel-1",
    ]);

    advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);
    expect(session.snapshot().panels).toEqual([]);
    sessions.dispose();
  });

  it("disposes every session generation on shutdown", () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const joined = session.joinPanel("panel-1", "owner-session-1");
    session.activateGeneration("panel-1", joined.generation);

    sessions.dispose();
    expect(session.snapshot().panels).toEqual([]);
    expect(session.acceptsGeneration("panel-1", joined.generation)).toBe(false);
    expect(
      sessions.sessionFor({ hostId: HOST_ID, profileId: PROFILE_A }),
    ).not.toBe(session);
  });

  it("makes the first joined panel the controller and a later panel view-only", () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    session.joinPanel("panel-1", "owner-session-1");
    session.joinPanel("panel-2", "owner-session-2");

    expect(session.role("panel-1")).toBe("controller");
    expect(session.role("panel-2")).toBe("spectator");
    expect(session.canInput("panel-1")).toBe(true);
    expect(session.canInput("panel-2")).toBe(false);
    expect(session.state().controllerPanelId).toBe("panel-1");
    sessions.dispose();
  });

  it("broadcasts the same ordered Control Lease transition to every panel", async () => {
    const { sessions } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    const seen: Array<string | null> = [];
    session.subscribe((state) => seen.push(state.controllerPanelId));
    session.joinPanel("panel-1", "owner-session-1");
    session.joinPanel("panel-2", "owner-session-2");
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
    sessions.dispose();
  });

  it("freezes input on controller disconnect and lets only the same panel reclaim within ten seconds", async () => {
    const { sessions, advanceTime } = setup();
    const session = sessions.sessionFor({
      hostId: HOST_ID,
      profileId: PROFILE_A,
    });
    session.joinPanel("panel-1", "owner-session-1");
    session.joinPanel("panel-2", "owner-session-2");
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
    sessions.dispose();
  });

  it.each(["joinPanel", "connectPanel"] as const)(
    "keeps an expired former controller as a spectator after %s until it takes control",
    async (rejoin) => {
      const { sessions, advanceTime } = setup();
      const session = sessions.sessionFor({
        hostId: HOST_ID,
        profileId: PROFILE_A,
      });
      session.joinPanel("panel-1", "owner-session-1");
      session.disconnectPanel("panel-1");
      advanceTime(PANEL_RECLAIM_WINDOW_MS + 1);

      if (rejoin === "joinPanel") {
        session.joinPanel("panel-1", "owner-session-1");
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
      sessions.dispose();
    },
  );

  it("lets only the controller resize the shared viewport and clamps it to the streaming ceiling", () => {
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
    sessions.dispose();
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
    sessions.dispose();
  });
});
