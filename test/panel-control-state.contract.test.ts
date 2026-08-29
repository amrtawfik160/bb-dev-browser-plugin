import { describe, expect, it } from "vitest";
import {
  createPanelControlState,
  clampPanelViewport,
  DEFAULT_PANEL_VIEWPORT,
  type PanelControlState,
} from "../panel-control-state.js";
import { createControlLeaseManager } from "../control-lease.js";

function setup(options?: { reclaimWindowMs?: number }) {
  const clock = { now: () => 0 };
  const controlLeases = createControlLeaseManager();
  const session = createPanelControlState({
    clock,
    controlLeases,
    reclaimWindowMs: options?.reclaimWindowMs ?? 10_000,
  });
  session.setLeaseKey("host\0profile");
  return { clock, controlLeases, session };
}

describe("Panel Control State", () => {
  it("makes the first panel the controller and a second client view-only", async () => {
    const { session } = setup();
    expect(session.connectPanel("panel-1", "session-1")).toBe("controller");
    expect(session.connectPanel("panel-2", "session-2")).toBe("spectator");

    // A second client cannot send browser input until it takes control.
    expect(session.canInput("panel-1")).toBe(true);
    expect(session.canInput("panel-2")).toBe(false);
    const state = session.state();
    expect(state.controllerPanelId).toBe("panel-1");
    expect(state.panels).toContainEqual(
      expect.objectContaining({ panelId: "panel-2", role: "spectator" }),
    );
    session.dispose();
  });

  it("transfers control atomically and broadcasts to every panel", async () => {
    const { session } = setup();
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    const seen: PanelControlState[] = [];
    const unsubscribe = session.subscribe((next) => seen.push(next));

    await session.takeControl("panel-2");

    // The transfer is atomic: exactly one controller after the call.
    expect(session.state().controllerPanelId).toBe("panel-2");
    expect(session.role("panel-1")).toBe("spectator");
    expect(session.role("panel-2")).toBe("controller");
    expect(session.canInput("panel-1")).toBe(false);
    expect(session.canInput("panel-2")).toBe(true);
    // Broadcast reached every panel through the shared subscription.
    const last = seen[seen.length - 1]!;
    expect(last.controllerPanelId).toBe("panel-2");
    unsubscribe();
    session.dispose();
  });

  it("lets the controller drive the viewport and spectators only letterbox", () => {
    const { session } = setup();
    session.connectPanel("panel-1", "session-1", { width: 1280, height: 720 });
    session.connectPanel("panel-2", "session-2", { width: 800, height: 600 });

    // The controller's viewport drives page layout.
    expect(session.state().controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });

    // A spectator changing its viewport does not resize the shared page.
    session.setViewport("panel-2", { width: 400, height: 300 });
    expect(session.state().controllerViewport).toEqual({
      width: 1280,
      height: 720,
    });

    // The controller changing its viewport updates the shared layout.
    session.setViewport("panel-1", { width: 1600, height: 900 });
    expect(session.state().controllerViewport).toEqual({
      width: 1600,
      height: 900,
    });
    session.dispose();
  });

  it("clamps the viewport to the supported maximum", () => {
    expect(clampPanelViewport({ width: 9999, height: 9999 })).toEqual(
      DEFAULT_PANEL_VIEWPORT,
    );
    expect(clampPanelViewport({ width: 0, height: -1 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it("interrupts an active agent Control Lease when the owner takes control", async () => {
    const { session, controlLeases } = setup();
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    // Start an agent lease that holds control. The real host releases the
    // agent lease from a `finally` once the abort propagates; mirror that so
    // the owner's acquireOwner can complete the atomic transfer.
    const agentLease = await controlLeases.acquireAgent(
      "host\0profile",
      "Inspect the fixture",
    );
    agentLease.signal.addEventListener("abort", () => agentLease.release(), {
      once: true,
    });
    expect(agentLease.signal.aborted).toBe(false);
    expect(session.state().agentPurpose).toBe("Inspect the fixture");

    // Owner interaction takes priority and interrupts the agent lease.
    await session.takeControl("panel-2", { width: 1280, height: 720 });
    expect(agentLease.signal.aborted).toBe(true);
    expect(session.state().agentPurpose).toBeNull();
    expect(session.state().controllerPanelId).toBe("panel-2");
    session.dispose();
  });

  it("freezes input immediately on controller disconnect and lets only the same panel reclaim", async () => {
    const { session, clock } = setup({ reclaimWindowMs: 10_000 });
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");

    // Controller disconnects: input freezes immediately.
    session.disconnectPanel("panel-1");
    expect(session.canInput("panel-1")).toBe(false);
    expect(session.state().controllerPanelId).toBeNull();

    // During the reclaim window, a different panel cannot take control.
    clock.now = () => 5_000;
    await expect(session.takeControl("panel-2")).resolves.toBe(false);
    expect(session.state().controllerPanelId).toBeNull();

    // Reconnect the original controller within the window and reclaim.
    session.connectPanel("panel-1", "session-1");
    expect(session.reclaimControl("panel-1")).toBe(true);
    expect(session.state().controllerPanelId).toBe("panel-1");
    expect(session.canInput("panel-1")).toBe(true);
    session.dispose();
  });

  it("opens control to anyone after the reclaim window expires", async () => {
    const { session, clock } = setup({ reclaimWindowMs: 10_000 });
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    session.disconnectPanel("panel-1");

    clock.now = () => 15_000;
    session.connectPanel("panel-1", "session-1");
    // The window expired: the original controller cannot reclaim.
    expect(session.reclaimControl("panel-1")).toBe(false);
    // Control is now generally available to another panel.
    await session.takeControl("panel-2");
    expect(session.state().controllerPanelId).toBe("panel-2");
    session.dispose();
  });

  it("does not create duplicate panels or controllers on reconnect", async () => {
    const { session } = setup();
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    await session.takeControl("panel-2");

    // Reconnecting the controller panel resumes its role rather than duplicating.
    session.connectPanel("panel-2", "session-2");
    expect(
      session.state().panels.filter((p) => p.panelId === "panel-2"),
    ).toHaveLength(1);
    expect(session.state().controllerPanelId).toBe("panel-2");
    session.dispose();
  });

  it("releases control back to spectator and makes control available", async () => {
    const { session } = setup();
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    await session.takeControl("panel-2");
    expect(session.releaseControl("panel-2")).toBe(true);
    expect(session.state().controllerPanelId).toBeNull();
    expect(session.role("panel-2")).toBe("spectator");
    // Control is available again to another panel.
    await session.takeControl("panel-1");
    expect(session.state().controllerPanelId).toBe("panel-1");
    session.dispose();
  });

  it("revokes all control on profile switch so no panel retains input", async () => {
    const { session } = setup();
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    await session.takeControl("panel-2");
    session.revoke();
    expect(session.state().controllerPanelId).toBeNull();
    expect(session.state().panels.every((p) => p.role === "spectator")).toBe(
      true,
    );
    session.dispose();
  });

  it("updates the live agent-purpose indicator while an agent holds the lease", async () => {
    const { session, controlLeases } = setup();
    session.connectPanel("panel-1", "session-1");
    const lease = await controlLeases.acquireAgent(
      "host\0profile",
      "Summarize the open page",
    );
    expect(session.state().agentPurpose).toBe("Summarize the open page");
    lease.release();
    expect(session.state().agentPurpose).toBeNull();
    session.dispose();
  });

  it("broadcasts the initial controller to subscribers without duplication", () => {
    const { session } = setup();
    const seen: PanelControlState[] = [];
    session.subscribe((next) => seen.push(next));
    session.connectPanel("panel-1", "session-1");
    session.connectPanel("panel-2", "session-2");
    // Exactly one controller throughout; never two.
    for (const state of seen) {
      const controllers = state.panels.filter((p) => p.role === "controller");
      expect(controllers.length).toBeLessThanOrEqual(1);
    }
    session.dispose();
  });
});
