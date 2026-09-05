import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActivityRecordStore,
  BROWSER_DATABASE_MIGRATIONS,
} from "../src/activity/activity-records.js";
import {
  SAFE_LOGIN_EXPIRY_WARNING_MS,
  SAFE_LOGIN_LEASE_MS,
  SAFE_LOGIN_MAX_EXTENSION_MS,
  SAFE_LOGIN_MAX_TOTAL_MS,
  SafeLoginAgentDeniedError,
  SafeLoginModeError,
  createInMemorySafeLoginIntentStore,
  createSafeLoginMode,
  safeLoginActivitySink,
  type SafeLoginActivitySink,
  type SafeLoginPanelBinding,
  type SafeLoginPersistedIntent,
  type SafeLoginProfileTarget,
  type SafeLoginRelaunchEffects,
} from "../src/browser/safe-login.js";
import {
  deterministicLoginFixture,
  type DeterministicLoginRelaunch,
} from "./fixtures/safe-login-fixture.js";

const HOST_ID = "host-safe-login";
const PROFILE_ID = "profile-safe-login";
const TARGET: SafeLoginProfileTarget = {
  hostId: HOST_ID,
  profileId: PROFILE_ID,
};

/**
 * The deterministic login fixture is the policy-level analog of the real
 * authentication fixture. The helpers below delegate to it so every Safe Login
 * test drives enter/exit/reconcile through the fixture instead of bare stubs,
 * and `loginFixture.authenticate()` stands in for the owner signing in.
 */
const loginFixture = deterministicLoginFixture({
  hostId: HOST_ID,
  profileId: PROFILE_ID,
});

function binding(
  panelId: string,
  overrides: Partial<SafeLoginPanelBinding> = {},
): SafeLoginPanelBinding {
  return loginFixture.binding(panelId, overrides);
}

type CapturedRelaunch = DeterministicLoginRelaunch;

function deterministicRelaunch(): CapturedRelaunch {
  return loginFixture.recordingRelaunch();
}

type CapturedInterruption = { active: boolean; interrupted: number };

function interruptionEffect(captured: CapturedInterruption): {
  interruptAgents: (
    target: SafeLoginProfileTarget,
  ) => Promise<CapturedInterruption>;
} {
  return loginFixture.interruption(captured);
}

function capturingSink(): SafeLoginActivitySink & {
  events: unknown[];
} {
  const events: unknown[] = [];
  return {
    events,
    mode: (input) => {
      events.push(input);
      return input as never;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Safe Login Mode policy", () => {
  it("enters Safe Login with a transient-state warning, interrupts agents, and relaunches without an automation attachment", async () => {
    const sink = capturingSink();
    const mode = createSafeLoginMode({
      activity: sink,
      clock: { now: () => Date.now() },
    });
    const relaunch = deterministicRelaunch();
    const interruption = interruptionEffect({ active: true, interrupted: 2 });
    try {
      const result = await mode.enter({
        binding: binding("initiator"),
        relaunch: relaunch.effects,
        interruption,
      });
      expect(result.warning.transientStateLoss).toContain("restart");
      expect(result.warning.transientStateLoss).toContain("lost");
      expect(result.warning.limitations).toMatch(/passkey|DRM|corporate/i);
      expect(result.agentsWereActive).toBe(true);
      expect(result.interruptedAgents).toBe(2);
      expect(relaunch.calls.relaunchWithoutAutomation).toEqual([PROFILE_ID]);
      expect(relaunch.calls.returnToAutomation).toEqual([]);
      expect(mode.mode(TARGET)).toBe("safe-login");
      expect(mode.transition(TARGET)).toBe("idle");
      expect(mode.initiatingBinding(TARGET)).toMatchObject({
        panelId: "initiator",
      });
    } finally {
      mode.dispose();
    }
  });

  it("drives Safe Login through the deterministic login fixture: the owner authenticates, enters, signs in, and returns to Automation Mode", async () => {
    const fixture = deterministicLoginFixture({
      hostId: HOST_ID,
      profileId: PROFILE_ID,
    });
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      expect(fixture.authenticated).toBe(false);
      const entered = await mode.enter({
        binding: fixture.initiator,
        relaunch: fixture.relaunch,
        interruption: fixture.interruption({ active: true, interrupted: 1 }),
      });
      expect(entered.agentsWereActive).toBe(true);
      // While in Safe Login the owner signs in through the fixture; the policy
      // denies agents for the duration of the login.
      const login = fixture.authenticate();
      expect(login.signedIn).toBe(true);
      expect(fixture.authenticated).toBe(true);
      expect(mode.isAgentDenied(TARGET)).toBe(true);
      expect(fixture.relaunchCalls.relaunchWithoutAutomation).toEqual([
        PROFILE_ID,
      ]);
      // Done returns the profile to Automation Mode without copying credentials.
      await mode.done(TARGET, entered.sessionId);
      expect(mode.mode(TARGET)).toBe("automation");
      expect(fixture.relaunchCalls.returnToAutomation).toEqual([PROFILE_ID]);
    } finally {
      mode.dispose();
    }
  });

  it("exposes Safe Login pixels and control only to the initiating panel through the capability binding", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    const initiator = binding("initiator");
    try {
      await mode.enter({
        binding: initiator,
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      const spectator = binding("spectator");
      expect(mode.canStreamPixels(initiator)).toBe(true);
      expect(mode.canControl(initiator)).toBe(true);
      expect(mode.canStreamPixels(spectator)).toBe(false);
      expect(mode.canControl(spectator)).toBe(false);
      expect(mode.statusFor(TARGET, initiator)).toBe("safe-login-initiator");
      expect(mode.statusFor(TARGET, spectator)).toBe("safe-login-elsewhere");
      // A rejoined identical binding still counts as the initiating panel.
      expect(mode.joinPanel(initiator).accepted).toBe(true);
    } finally {
      mode.dispose();
    }
  });

  it("denies agents and the CLI DOM, screenshot, and control access while Safe Login is active", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      expect(mode.isAgentDenied(TARGET)).toBe(true);
      expect(() => mode.assertAgentAllowed(TARGET)).toThrow(
        SafeLoginAgentDeniedError,
      );
      // After a clean exit, agents are allowed again.
      await mode.done(TARGET, mode.session(TARGET)!.sessionId);
      expect(mode.isAgentDenied(TARGET)).toBe(false);
      expect(() => mode.assertAgentAllowed(TARGET)).not.toThrow();
    } finally {
      mode.dispose();
    }
  });

  it("returns the same profile to Automation Mode through Done without copying credentials or browser state through BB storage", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    const relaunch = deterministicRelaunch();
    try {
      const result = await mode.enter({
        binding: binding("initiator"),
        relaunch: relaunch.effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      await mode.done(TARGET, result.sessionId);
      expect(mode.mode(TARGET)).toBe("automation");
      expect(mode.initiatingBinding(TARGET)).toBeNull();
      expect(relaunch.calls.returnToAutomation).toEqual([PROFILE_ID]);
      // Done never copies browser state: it only reattaches automation to the
      // already-running profile, so no second relaunchWithoutAutomation call.
      expect(relaunch.calls.relaunchWithoutAutomation).toEqual([PROFILE_ID]);
    } finally {
      mode.dispose();
    }
  });

  it("expires automatically, warns before expiry, supports a bounded extension, and ends when its final initiating panel closes", async () => {
    const warnings: { sessionId: string; expiresAt: number }[] = [];
    const mode = createSafeLoginMode({
      clock: { now: () => Date.now() },
      leaseMs: 10_000,
      expiryWarningMs: 3_000,
      maxExtensionMs: 5_000,
      maxTotalMs: 15_000,
    });
    mode.onExpiryWarning((warning) => warnings.push(warning));
    const relaunch = deterministicRelaunch();
    try {
      const result = await mode.enter({
        binding: binding("initiator"),
        relaunch: relaunch.effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      // Extend within the bounded ceiling before expiry.
      const extended = mode.extend(TARGET, result.sessionId, 5_000);
      expect(extended.extendedByMs).toBe(5_000);
      expect(extended.expiresAt).toBeGreaterThan(result.expiresAt);
      // An extension beyond the bounded maximum is rejected.
      expect(() =>
        mode.extend(TARGET, result.sessionId, SAFE_LOGIN_MAX_EXTENSION_MS + 1),
      ).toThrow(SafeLoginModeError);
      // An extension that would exceed the total ceiling is rejected.
      expect(() => mode.extend(TARGET, result.sessionId, 5_000)).toThrow(
        SafeLoginModeError,
      );
      // Advance to the warning window and confirm a pre-expiry warning fires.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.sessionId).toBe(result.sessionId);
      // Advance past expiry: the lease ends automatically and the profile is
      // returned to Automation Mode.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mode.mode(TARGET)).toBe("automation");
      expect(relaunch.calls.returnToAutomation.length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      mode.dispose();
    }
  });

  it("ends when its final initiating panel closes", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    const relaunch = deterministicRelaunch();
    try {
      const result = await mode.enter({
        binding: binding("initiator"),
        relaunch: relaunch.effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      // The same panel closing and rejoining keeps the session alive.
      await mode.panelClosed(binding("initiator"));
      expect(mode.mode(TARGET)).toBe("automation");
      // Re-enter with two initiating panels.
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      mode.joinPanel(binding("initiator"));
      // A spectator panel closing has no effect.
      await mode.panelClosed(binding("spectator"));
      expect(mode.mode(TARGET)).toBe("safe-login");
      expect(result.sessionId).toBeDefined();
    } finally {
      mode.dispose();
    }
  });

  it("expires without leaking relaunch effects, matching Done and panel-close exits", async () => {
    const mode = createSafeLoginMode({
      clock: { now: () => Date.now() },
      leaseMs: 10_000,
      expiryWarningMs: 3_000,
    });
    const relaunch = deterministicRelaunch();
    try {
      const result = await mode.enter({
        binding: binding("initiator"),
        relaunch: relaunch.effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      // Before expiry the relaunch effects are retained for the live session.
      expect(mode.relaunchEffectsHeld()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      // Expiry runs the exit transition and, like Done and panel-close, must
      // release the session's relaunch effects so they do not leak until
      // dispose().
      expect(mode.mode(TARGET)).toBe("automation");
      expect(mode.relaunchEffectsHeld()).toBe(0);
      expect(relaunch.calls.returnToAutomation).toEqual([PROFILE_ID]);
      // The expired session is fully gone: re-entering is independent.
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      expect(mode.relaunchEffectsHeld()).toBe(1);
      await mode.done(TARGET, mode.session(TARGET)!.sessionId);
      expect(mode.relaunchEffectsHeld()).toBe(0);
      expect(result.sessionId).toBeDefined();
    } finally {
      mode.dispose();
    }
  });

  it("reconciles interrupted enter/exit transitions to a safe explicit Automation Mode state after reconnect or worker restart", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      // Simulate an interrupted enter: the persisted intent is "entering".
      const enterIntent: SafeLoginPersistedIntent = {
        target: TARGET,
        transition: "entering",
        startedAt: Date.now(),
      };
      const reconciledEnter = await mode.reconcile(enterIntent);
      expect(reconciledEnter.resolved).toBe("automation");
      expect(mode.mode(TARGET)).toBe("automation");
      expect(mode.transition(TARGET)).toBe("idle");
      // Simulate an interrupted exit with a live session still recorded.
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      const exitIntent: SafeLoginPersistedIntent = {
        target: TARGET,
        transition: "exiting",
        startedAt: Date.now(),
      };
      const relaunch = deterministicRelaunch();
      const reconciledExit = await mode.reconcile(exitIntent, relaunch.effects);
      expect(reconciledExit.resolved).toBe("automation");
      expect(mode.mode(TARGET)).toBe("automation");
      expect(mode.initiatingBinding(TARGET)).toBeNull();
      expect(relaunch.calls.returnToAutomation).toEqual([PROFILE_ID]);
    } finally {
      mode.dispose();
    }
  });

  it("records persisted intent during a live transition so a restart can reconcile", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      // No intent while idle.
      expect(mode.persistedIntent(TARGET)).toBeNull();
      // Enter completes and clears the intent.
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      expect(mode.persistedIntent(TARGET)).toBeNull();
    } finally {
      mode.dispose();
    }
  });

  it("persists intent durably so a fresh Safe Login policy reconciles after a worker restart", async () => {
    const clock = { now: () => Date.now() };
    const completedStore = createInMemorySafeLoginIntentStore();
    const completed = createSafeLoginMode({
      clock,
      intentStore: completedStore,
    });
    try {
      // A completed enter clears the durable intent: nothing to reconcile.
      await completed.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      expect(completed.persistedIntent(TARGET)).toBeNull();
      expect(completedStore.load(TARGET)).toBeNull();
    } finally {
      completed.dispose();
    }

    // Simulate an interrupted exit: the worker persisted the "exiting"
    // intent through the in-flight Done below, then crashed before
    // returnToAutomation completed. The hanging relaunch stands in for a
    // process that died mid-transition; the durable store retains the intent
    // across the restart.
    const restartingStore = createInMemorySafeLoginIntentStore();
    const crashing = createSafeLoginMode({
      clock,
      intentStore: restartingStore,
    });
    let exitReachedReturn = false;
    const hanging: SafeLoginRelaunchEffects = {
      relaunchWithoutAutomation: async () => {},
      returnToAutomation: async () => {
        exitReachedReturn = true;
        await new Promise<void>(() => {});
      },
    };
    const entered = await crashing.enter({
      binding: binding("initiator"),
      relaunch: hanging,
      interruption: interruptionEffect({ active: false, interrupted: 0 }),
    });
    // Fire Done; it persists the "exiting" intent then awaits the hanging
    // returnToAutomation. Do not await: the transition never completes.
    void crashing.done(TARGET, entered.sessionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(exitReachedReturn).toBe(true);
    expect(restartingStore.load(TARGET)?.transition).toBe("exiting");
    crashing.dispose();

    // A fresh policy with the same durable store reloads the persisted intent
    // and reconciles it to a safe explicit Automation Mode state.
    const restarted = createSafeLoginMode({
      clock,
      intentStore: restartingStore,
    });
    try {
      const reloaded = restarted.persistedIntent(TARGET);
      expect(reloaded?.transition).toBe("exiting");
      const relaunch = deterministicRelaunch();
      const reconciled = await restarted.reconcile(reloaded!, relaunch.effects);
      expect(reconciled.resolved).toBe("automation");
      expect(restarted.mode(TARGET)).toBe("automation");
      expect(relaunch.calls.returnToAutomation).toEqual([PROFILE_ID]);
      // Reconciliation clears the durable intent: a second restart reconciles
      // to idle rather than replaying the same transition forever.
      expect(restarted.persistedIntent(TARGET)).toBeNull();
      expect(restartingStore.load(TARGET)).toBeNull();
    } finally {
      restarted.dispose();
    }
  });

  it("Activity Records capture only mode-transition metadata and never pixels, URLs, credentials, input, screenshots, or page content", async () => {
    const sink = capturingSink();
    const mode = createSafeLoginMode({
      activity: sink,
      clock: { now: () => Date.now() },
    });
    const relaunch = deterministicRelaunch();
    try {
      const result = await mode.enter({
        binding: binding("initiator"),
        relaunch: relaunch.effects,
        interruption: interruptionEffect({ active: true, interrupted: 1 }),
      });
      await mode.extend(TARGET, result.sessionId, SAFE_LOGIN_MAX_EXTENSION_MS);
      await mode.done(TARGET, result.sessionId);
      const sensitive = [
        "pixel",
        "screenshot",
        "password",
        "credential",
        "http://",
        "https://",
        "cookie",
        "keystroke",
        "input",
        "dom",
      ];
      for (const event of sink.events) {
        const serialized = JSON.stringify(event);
        for (const needle of sensitive) {
          expect(serialized.toLowerCase()).not.toContain(needle);
        }
        expect(event).toMatchObject({
          actor: "owner",
          hostId: HOST_ID,
          profileId: PROFILE_ID,
          destinationOrigin: null,
          projectId: null,
        });
      }
      const actions = sink.events.map(
        (event) => (event as { action: string }).action,
      );
      expect(actions).toEqual(
        expect.arrayContaining([
          "safe-login-entered",
          "safe-login-extended",
          "safe-login-exited",
        ]),
      );
    } finally {
      mode.dispose();
    }
  });

  it("persists mode-transition metadata through the real Activity Record store with no sensitive content", async () => {
    const backend = createFakePluginHost({ pluginId: "safe-login-activity" });
    const database = backend.bb.storage.database();
    backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
    const store = createActivityRecordStore(
      database,
      () => new Date("2026-08-29T00:00:00.000Z"),
    );
    const mode = createSafeLoginMode({
      activity: safeLoginActivitySink(store),
      clock: { now: () => Date.now() },
    });
    try {
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: true, interrupted: 1 }),
      });
      const records = store.list({ hostId: HOST_ID, profileId: PROFILE_ID });
      expect(records).toHaveLength(1);
      expect(records[0]?.kind).toBe("mode");
      expect(records[0]?.action).toBe("safe-login-entered");
      expect(records[0]?.destinationOrigin).toBeNull();
      const serialized = JSON.stringify(records[0]);
      for (const needle of [
        "pixel",
        "screenshot",
        "password",
        "credential",
        "cookie",
      ]) {
        expect(serialized.toLowerCase()).not.toContain(needle);
      }
    } finally {
      mode.dispose();
      await backend.harness.lifecycle.dispose();
    }
  });

  it("rejects a second enter while Safe Login is active and a non-initiator Done", async () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      await mode.enter({
        binding: binding("initiator"),
        relaunch: deterministicRelaunch().effects,
        interruption: interruptionEffect({ active: false, interrupted: 0 }),
      });
      await expect(
        mode.enter({
          binding: binding("second"),
          relaunch: deterministicRelaunch().effects,
          interruption: interruptionEffect({ active: false, interrupted: 0 }),
        }),
      ).rejects.toThrow(SafeLoginModeError);
      const session = mode.session(TARGET)!;
      // A spectator binding cannot end Safe Login.
      await expect(
        mode.done({ hostId: "other", profileId: "other" }, session.sessionId),
      ).rejects.toThrow(SafeLoginModeError);
    } finally {
      mode.dispose();
    }
  });

  it("fails the enter transition closed back to Automation Mode when the relaunch rejects", async () => {
    const sink = capturingSink();
    const mode = createSafeLoginMode({
      activity: sink,
      clock: { now: () => Date.now() },
    });
    const failing: SafeLoginRelaunchEffects = {
      relaunchWithoutAutomation: async () => {
        throw new Error("xvfb unavailable");
      },
      returnToAutomation: async () => {},
    };
    try {
      await expect(
        mode.enter({
          binding: binding("initiator"),
          relaunch: failing,
          interruption: interruptionEffect({ active: false, interrupted: 0 }),
        }),
      ).rejects.toThrow(SafeLoginModeError);
      expect(mode.mode(TARGET)).toBe("automation");
      expect(mode.isAgentDenied(TARGET)).toBe(false);
      const entered = sink.events.find(
        (event) =>
          (event as { action: string }).action === "safe-login-entered",
      ) as { outcome: string; interrupted: number } | undefined;
      expect(entered?.outcome).toBe("failed");
      expect(entered?.interrupted).toBe(true);
    } finally {
      mode.dispose();
    }
  });

  it("honors the default 15-minute lease and bounded extension constants", () => {
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      expect(mode.leaseMs).toBe(SAFE_LOGIN_LEASE_MS);
      expect(mode.maxExtensionMs).toBe(SAFE_LOGIN_MAX_EXTENSION_MS);
      expect(mode.maxTotalMs).toBe(SAFE_LOGIN_MAX_TOTAL_MS);
      expect(mode.expiryWarningMs).toBe(SAFE_LOGIN_EXPIRY_WARNING_MS);
    } finally {
      mode.dispose();
    }
  });
});
