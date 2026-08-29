// @vitest-environment jsdom
/**
 * Issue #23 acceptance criterion 6: install, enable, disable, re-enable,
 * upgrade-with-active-work, uninstall-retain, and explicit-purge planning are
 * exercised through the public plugin/package contracts without provisioning
 * the current host.
 *
 * Each transition is driven through the in-memory/loopback public-plugin
 * harness (the same harness the contract suites use), backed by a real
 * file-backed profile store and a real in-memory browser engine (fake loopback
 * launch boundary). No privileged host operation runs against the current host;
 * the simulated privileged executor only records intended operations. This
 * complements (does not duplicate) the focused setup/purge/lifecycle contract
 * tests in `test/public-plugin.contract.test.tsx`, which cover the per-action
 * consent gates; here the transitions are exercised as one release-lifecycle
 * sequence against retained state.
 */
import { rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  browserLifecycleResponseSchema,
  browserPurgePlanSchema,
  browserPurgeResponseSchema,
} from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";
import { createInMemoryBrowserRuntime } from "./fixtures/evidence-helpers.js";
import { createSimulatedPrivilegedExecutor } from "../host-operations.js";
import { createFileBrowserProfileStore } from "../profile-storage.js";
import { createMemoryHostAdministrationStateStore } from "../host-operations.js";
import type { HostProbeSnapshot } from "../readiness.js";
import type { BrowserInstanceRuntime } from "../browser-runtime.js";

const preparedSnapshot: HostProbeSnapshot = {
  operatingSystem: { id: "ubuntu", version: "24.04", name: "Ubuntu 24.04 LTS" },
  architecture: "x64",
  connect: { enrolled: true },
  browser: {
    name: "Google Chrome",
    version: "140.0.7339.80",
    compatible: true,
  },
  sandbox: { available: true },
  dedicatedUser: { state: "ready" },
  protectedStorage: { state: "ready" },
  disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
  loopback: { available: true },
  processes: [],
  exitLogs: [],
};

const SETUP_STEPS = [
  ["dedicated-user", "Create bb-browser"],
  ["system-packages", "Install Browser packages"],
  ["protected-storage", "Configure protected Browser storage"],
] as const;

const HOST_ID = "host-browser-test";

/** Tolerant disposal: a shared runtime disposed by two harnesses is fine. */
async function disposeAll(
  ...cleanups: Array<() => Promise<void> | void>
): Promise<void> {
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch {
      // A shared in-memory runtime may be disposed by a previous harness
      // dispose; the second dispose is a harmless no-op. Lifecycle transitions
      // are already asserted before disposal.
    }
  }
}

describe("release lifecycle packaging (issue #23 AC6)", () => {
  it("exercises install, enable, disable, re-enable, upgrade-with-active-work, uninstall-retain, and explicit-purge planning through public contracts", async () => {
    const executor = createSimulatedPrivilegedExecutor();
    const administrationStateStore = createMemoryHostAdministrationStateStore();
    const profileRoot = await mkdtemp(
      join(tmpdir(), "bb-release-lifecycle-profile-"),
    );
    const profileStore = createFileBrowserProfileStore({
      rootDirectory: profileRoot,
      installationId: "installation-public-test",
      lifecycle: { stopProfile: async () => undefined },
    });
    const engine = await createInMemoryBrowserRuntime();
    const runtime: BrowserInstanceRuntime = engine.runtime;

    const sharedOptions = {
      snapshot: preparedSnapshot,
      privilegedExecutor: executor,
      administrationStateStore,
      profileStore,
    };

    // 1. Install: the plugin loads, registers its CLI, and answers status
    //    without initializing a profile or mutating the host.
    const installed = await createPublicPluginHarness({
      ...sharedOptions,
      browserRuntime: runtime,
    });
    expect(installed.registeredBrowserCliCommands().length).toBeGreaterThan(0);
    const installStatus = await installed.runBrowserCli(["status", "--json"]);
    expect(installStatus.exitCode).toBe(0);
    expect(await installed.runBrowserProfiles()).toEqual(
      expect.objectContaining({ profiles: [] }),
    );
    expect(executor.attemptedOperations).toEqual([]);

    // 2. Enable: completing the consent-gated setup initializes the default
    //    profile, bringing the plugin to its enabled/ready state.
    for (const [stepId, confirmation] of SETUP_STEPS) {
      const reply = await installed.runBrowserCli([
        "setup",
        "--step",
        stepId,
        "--confirm",
        confirmation,
        "--json",
      ]);
      expect(reply.exitCode).toBe(0);
    }
    const enabledProfiles = await installed.runBrowserProfiles();
    expect(
      enabledProfiles.profiles.map((profile) => profile.profileId),
    ).toEqual([DEFAULT_PROFILE_ID]);
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toEqual([
      "create-dedicated-user",
      "install-system-packages",
      "configure-protected-storage",
    ]);

    // 3. Active work: a visible panel pins the default profile's instance awake
    //    so a real browser process is launched.
    const activeTarget = {
      hostId: HOST_ID,
      profileId: DEFAULT_PROFILE_ID,
      locale: "en-GB",
      timezone: "Europe/London",
    };
    await runtime.pinPanel(activeTarget, "lifecycle-active-panel");
    const launchesBeforeUpgrade = engine.launchLog.launches;
    expect(launchesBeforeUpgrade).toBeGreaterThan(0);

    // 4. Upgrade-with-active-work: a new plugin load (new generation) reuses
    //    the retained host worker (same browser engine) and profile store. The
    //    upgrade must NOT restart the active browser work, and profiles are
    //    retained.
    const upgraded = await createPublicPluginHarness({
      ...sharedOptions,
      browserRuntime: runtime,
    });
    const profilesAfterUpgrade = await upgraded.runBrowserProfiles();
    expect(
      profilesAfterUpgrade.profiles.map((profile) => profile.profileId),
    ).toEqual([DEFAULT_PROFILE_ID]);
    // The upgrade did not launch a new browser process: active work is not
    // restarted, instances wake lazily (spec: "updates never restart active
    // work").
    expect(engine.launchLog.launches).toBe(launchesBeforeUpgrade);
    // The upgraded load sees setup as already complete and does not re-provision.
    const upgradeSetupPlan = await upgraded.runBrowserCli(["setup", "--json"]);
    expect(JSON.parse(upgradeSetupPlan.stdout).state).toBe("ready");
    expect(executor.successfulOperations).toHaveLength(3);

    // 5. Disable: stops Browser-owned processes but retains profiles.
    const disableReply = await upgraded.runBrowserCli([
      "disable",
      "--confirm",
      "Stop Browser processes",
      "--json",
    ]);
    expect(
      browserLifecycleResponseSchema.parse(JSON.parse(disableReply.stdout)),
    ).toMatchObject({
      action: "disable",
      outcome: "stopped",
      profilesRetained: true,
    });
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toContain("stop-owned-processes");
    await disposeAll(
      () => upgraded.dispose(),
      () => installed.dispose(),
    );

    // 6. Re-enable: a fresh plugin load shares the same profile store and
    //    administration state, so the retained profiles remain usable and the
    //    host is still seen as set up (no re-provisioning).
    const reEnabled = await createPublicPluginHarness({
      ...sharedOptions,
      browserRuntime: runtime,
    });
    const profilesAfterReEnable = await reEnabled.runBrowserProfiles();
    expect(
      profilesAfterReEnable.profiles.map((profile) => profile.profileId),
    ).toEqual([DEFAULT_PROFILE_ID]);
    const reEnableSetupPlan = await reEnabled.runBrowserCli([
      "setup",
      "--json",
    ]);
    expect(JSON.parse(reEnableSetupPlan.stdout).state).toBe("ready");

    // 7. Uninstall-retain: stops processes but retains profiles (distinct from
    //    a destructive purge).
    const uninstallReply = await reEnabled.runBrowserCli([
      "uninstall",
      "--confirm",
      "Stop Browser processes",
      "--json",
    ]);
    const uninstallResponse = browserLifecycleResponseSchema.parse(
      JSON.parse(uninstallReply.stdout),
    );
    expect(uninstallResponse).toMatchObject({
      action: "uninstall",
      profilesRetained: true,
    });
    // After a prior disable the processes are already stopped, so uninstall is
    // idempotent; either outcome retains profiles.
    expect(["stopped", "already-stopped"]).toContain(uninstallResponse.outcome);
    const profilesAfterUninstall = await reEnabled.runBrowserProfiles();
    expect(
      profilesAfterUninstall.profiles.map((profile) => profile.profileId),
    ).toEqual([DEFAULT_PROFILE_ID]);

    // 8. Explicit-purge planning: the plan names the four destructive targets
    //    and a confirmation text; a wrong confirmation is rejected, and the
    //    correct confirmation purges.
    const purgePlanReply = await reEnabled.runBrowserCli(["purge", "--json"]);
    const purgePlan = browserPurgePlanSchema.parse(
      JSON.parse(purgePlanReply.stdout),
    );
    expect(purgePlan.targets).toHaveLength(4);
    expect(purgePlan.confirmationText.length).toBeGreaterThan(0);
    expect(purgePlan.targets.map((target) => target.kind)).toEqual([
      "processes",
      "browser-data",
      "configuration",
      "system-user",
    ]);

    const rejectedPurge = await reEnabled.runBrowserCli([
      "purge",
      "--confirm",
      "wrong",
      "--json",
    ]);
    expect(rejectedPurge.exitCode).toBe(1);
    expect(
      browserPurgeResponseSchema.parse(JSON.parse(rejectedPurge.stdout))
        .outcome,
    ).toBe("confirmation-required");

    const purgeReply = await reEnabled.runBrowserCli([
      "purge",
      "--confirm",
      purgePlan.confirmationText,
      "--json",
    ]);
    expect(
      browserPurgeResponseSchema.parse(JSON.parse(purgeReply.stdout)).outcome,
    ).toBe("purged");

    await disposeAll(
      () => reEnabled.dispose(),
      () => engine.cleanup(),
      () => rm(profileRoot, { recursive: true, force: true }),
    );
  });
});
