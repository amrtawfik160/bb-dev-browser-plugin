import type {
  SafeLoginInterruptionEffect,
  SafeLoginPanelBinding,
  SafeLoginProfileTarget,
  SafeLoginRelaunchEffects,
} from "../../safe-login.js";

/**
 * A deterministic Safe Login fixture: the policy-level analog of the real
 * authentication fixture in `browser-auth.integration.test.ts`. It stands in for
 * the owner signing in through a site that rejects automation, without a real
 * browser, so the Safe Login contract tests drive the same enter/exit/reconcile
 * flow the real-browser worker drives against the live fixture.
 *
 * `authenticate()` is the deterministic login: it records that the owner signed
 * in and mints a fixture session token, so tests assert against a real login
 * outcome rather than bare relaunch stubs. `recordingRelaunch()` returns a
 * fresh recording each call so relaunch counts never bleed across tests.
 */
export type DeterministicLoginRelaunch = {
  calls: {
    relaunchWithoutAutomation: string[];
    returnToAutomation: string[];
  };
  effects: SafeLoginRelaunchEffects;
};

export type DeterministicLoginFixture = {
  target: SafeLoginProfileTarget;
  initiator: SafeLoginPanelBinding;
  spectator: SafeLoginPanelBinding;
  binding(
    panelId: string,
    overrides?: Partial<SafeLoginPanelBinding>,
  ): SafeLoginPanelBinding;
  /** A fresh recording relaunch so call counts never bleed across tests. */
  recordingRelaunch(): DeterministicLoginRelaunch;
  /** A shared default recording relaunch for the single-relaunch common case. */
  relaunch: SafeLoginRelaunchEffects;
  relaunchCalls: DeterministicLoginRelaunch["calls"];
  interruption(captured: {
    active: boolean;
    interrupted: number;
  }): SafeLoginInterruptionEffect;
  /** The owner signs in through the fixture; records the login outcome. */
  authenticate(): { signedIn: boolean; sessionToken: string };
  authenticated: boolean;
  sessionToken: string | null;
};

export function deterministicLoginFixture(options?: {
  hostId?: string;
  profileId?: string;
}): DeterministicLoginFixture {
  const hostId = options?.hostId ?? "host-safe-login";
  const profileId = options?.profileId ?? "profile-safe-login";
  const target: SafeLoginProfileTarget = { hostId, profileId };
  let authenticated = false;
  let sessionToken: string | null = null;

  function recordingRelaunch(): DeterministicLoginRelaunch {
    const calls = {
      relaunchWithoutAutomation: [] as string[],
      returnToAutomation: [] as string[],
    };
    return {
      calls,
      effects: {
        relaunchWithoutAutomation: async (relaunchTarget) => {
          calls.relaunchWithoutAutomation.push(relaunchTarget.profileId);
        },
        returnToAutomation: async (relaunchTarget) => {
          calls.returnToAutomation.push(relaunchTarget.profileId);
        },
      },
    };
  }

  const initial = recordingRelaunch();

  return {
    target,
    initiator: {
      ownerSessionId: "owner-session-initiator",
      panelId: "initiator",
      hostId,
      profileId,
    },
    spectator: {
      ownerSessionId: "owner-session-spectator",
      panelId: "spectator",
      hostId,
      profileId,
    },
    binding(panelId, overrides) {
      return {
        ownerSessionId: `owner-session-${panelId}`,
        panelId,
        hostId,
        profileId,
        ...overrides,
      };
    },
    recordingRelaunch,
    relaunch: initial.effects,
    relaunchCalls: initial.calls,
    interruption(captured) {
      return {
        interruptAgents: async () => ({
          active: captured.active,
          interrupted: captured.interrupted,
        }),
      };
    },
    authenticate() {
      authenticated = true;
      sessionToken = "fixture-session";
      return { signedIn: true, sessionToken };
    },
    get authenticated() {
      return authenticated;
    },
    get sessionToken() {
      return sessionToken;
    },
  };
}
