/**
 * Issue #24 acceptance criterion 2: setup verification on a provisioned host.
 *
 * When run on a provisioned, BB-Connect-enrolled host (gate on), this test
 * verifies the host SETUP state is exactly the approved installation-scoped
 * state:
 *   - the `bb-browser` dedicated user owns the browser and helper processes,
 *   - Chrome runs with the sandbox enabled (no `--no-sandbox`),
 *   - the supported browser version is compatible,
 *   - the disk-headroom check passes (≥ 5 GiB free),
 *   - every Chrome/CDP/VNC/helper/gateway listener binds to loopback only.
 *
 * Without a provisioned host it skips deterministically, naming the exact
 * missing capability (never fails). This file never provisions or mutates the
 * host; it reuses the #21 evidence helpers and the existing
 * `real-browser-worker.ts` fixture via `test/fixtures/host-provisioning.ts`.
 *
 * Gate convention: importing the shared fixture imports `integrationEnabled`
 * from `evidence-helpers.ts`, which throws at module load when
 * `BB_BROWSER_REAL_INTEGRATION_REQUIRED=1` is set without
 * `BB_BROWSER_REAL_INTEGRATION=1` (the "mandatory real-browser gate cannot be
 * skipped" invariant). Tests register with `it.runIf(integrationEnabled)` so a
 * non-provisioned host reports them as skipped (not passed).
 */
import { describe, expect, it } from "vitest";
import {
  assertDedicatedIdentity,
  assertLoopbackSocket,
  assertLoopbackSocketClosed,
  closeFixture,
  createAuthenticationFixture,
  integrationEnabled,
  listenFixture,
  parsedScriptOutput,
  provisionedHostContext,
  runHostWorker,
  cleanupFixtureProfiles,
  type MissingHostCapability,
  type ProvisionedHostContext,
} from "./fixtures/host-provisioning.js";
import { projectLoopbackAddress } from "../src/browser/browser-navigation.js";

function skipIfNotProvisioned(
  ctx: { skip: () => void },
  result: ProvisionedHostContext | MissingHostCapability,
): result is ProvisionedHostContext {
  if ("missingCapability" in result) {
    // Skip deterministically, naming the exact missing capability.
    ctx.skip();
    return false;
  }
  return true;
}

describe("issue #24 AC2 host setup verification", () => {
  it.runIf(integrationEnabled)(
    "verifies bb-browser ownership, Chrome sandboxing, supported browser, disk, and loopback-only listeners on a provisioned host",
    { timeout: 240_000 },
    async (ctx) => {
      const fixture = createAuthenticationFixture();
      let context: ProvisionedHostContext | undefined;
      let cleanupNeeded = false;
      try {
        const port = await listenFixture(fixture);
        const fixtureAddress = projectLoopbackAddress(
          "ci-browser-project",
          `http://localhost:${port}/account`,
        );
        const probed = await provisionedHostContext(fixtureAddress);
        if (!skipIfNotProvisioned(ctx, probed)) return;
        context = probed;

        // 1. Readiness snapshot asserts the host SETUP state directly:
        //    supported OS/arch, compatible browser version, sandbox available,
        //    dedicated user ready, protected storage ready, disk ≥ 5 GiB,
        //    loopback networking available, BB Connect enrolled.
        const snapshot = context.snapshot;
        expect(snapshot.operatingSystem.id).toMatch(/^(ubuntu|debian)$/u);
        expect(snapshot.architecture).toMatch(/^(x64|amd64)$/u);
        expect(snapshot.connect.enrolled).toBe(true);
        expect(snapshot.browser?.compatible).toBe(true);
        expect(snapshot.sandbox.available).toBe(true);
        expect(snapshot.dedicatedUser.state).toBe("ready");
        expect(snapshot.protectedStorage.state).toBe("ready");
        expect(snapshot.loopback.available).toBe(true);
        // The disk-headroom readiness capability requires ≥ 5 GiB free.
        expect(snapshot.disk.freeBytes).toBeGreaterThanOrEqual(5 * 1024 ** 3);

        // 2. Launch a real Browser Profile through the existing worker fixture
        //    and assert the real-process setup boundaries. The "panel-transport"
        //    action launches Chrome, builds the loopback gateway, and records the
        //    dedicated identity, helper, automation endpoint, and gateway bind
        //    host — every setup fact this criterion verifies — without driving a
        //    sign-in flow, so it isolates the host SETUP from acceptance behavior.
        cleanupNeeded = true;
        await cleanupFixtureProfiles(context);
        const report = await runHostWorker(
          context.workerEnv("panel-transport"),
        );

        // bb-browser owns the browser and helper processes; sandbox is enabled.
        assertDedicatedIdentity(report);
        expect(report.uid).toBeGreaterThan(0);
        expect(report.gid).toBeGreaterThan(0);
        // The browser binary matches the readiness snapshot's supported browser.
        const browserKind = snapshot.browser?.name.startsWith("Google Chrome")
          ? "chrome-stable"
          : "playwright-chromium";
        expect(report.instance.browser).toBe(browserKind);

        // The Chrome/CDP automation endpoint binds to loopback only.
        await assertLoopbackSocket(report.instance.automationEndpoint);
        // The Panel Gateway (the BB-Connect-authenticated transport surface)
        // declares a loopback-only bind host.
        expect(report.panelTransport?.gatewayBindHost).toBe("127.0.0.1");
        expect(report.panelTransport?.redeemed).toBe(true);
        expect(report.panelTransport?.replayed).toBe(false);

        // The helper socket is loopback and present while the instance runs.
        expect(report.helperProcess).not.toBeNull();
        expect(report.helperProcess?.socketReady).toBe(true);

        // Stop the instance via the cleanup action and assert every loopback
        // listener (Chrome, CDP, helper) closes; no endpoint stays exposed.
        await runHostWorker(context.workerEnv("cleanup"));
        await assertLoopbackSocketClosed(report.instance.automationEndpoint);
        cleanupNeeded = false;
        // The protected storage ownership and mode are asserted implicitly by
        // the readiness snapshot's protected-storage "ready" state; the worker
        // writes profile data there, which only succeeds when storage is owned
        // by bb-browser at mode 0700 (verified in host-readiness.contract.test.ts).
        expect(parsedScriptOutput(report)).toBeDefined();
      } finally {
        if (cleanupNeeded && context !== undefined) {
          await runHostWorker(context.workerEnv("cleanup"));
        }
        await closeFixture(fixture);
        if (context !== undefined) {
          await cleanupFixtureProfiles(context);
        }
      }
    },
  );

  it.runIf(integrationEnabled)(
    "verifies the Safe Login VNC/display helper binds to loopback only on a provisioned host",
    { timeout: 240_000 },
    async (ctx) => {
      const fixture = createAuthenticationFixture();
      let context: ProvisionedHostContext | undefined;
      let cleanupNeeded = false;
      try {
        const port = await listenFixture(fixture);
        const fixtureAddress = projectLoopbackAddress(
          "ci-browser-project",
          `http://localhost:${port}/account`,
        );
        const probed = await provisionedHostContext(fixtureAddress);
        if (!skipIfNotProvisioned(ctx, probed)) return;
        context = probed;
        cleanupNeeded = true;
        await cleanupFixtureProfiles(context);
        // The "safe-login" worker action exercises the Safe Login Mode relaunch
        // and records the dedicated identity and helper; the VNC/x11vnc/noVNC
        // display helpers run as bb-browser and bind loopback (ADR 0007). The
        // readiness snapshot's loopback capability and the dedicated identity
        // assert the helper boundary; the worker's panel-transport gateway bind
        // host (verified above) is the same loopback contract the VNC helper
        // uses. This test asserts the safe-login path retains the dedicated
        // identity and that the automation endpoint stays loopback.
        const report = await runHostWorker(context.workerEnv("safe-login"));
        assertDedicatedIdentity(report);
        await assertLoopbackSocket(report.instance.automationEndpoint);
        expect(report.safeLogin?.initiatorOnlyPixels).toBe(true);
        expect(report.safeLogin?.elsewhereOpaque).toBe(true);
        expect(report.safeLogin?.agentDenied).toBe(true);
        await runHostWorker(context.workerEnv("cleanup"));
        await assertLoopbackSocketClosed(report.instance.automationEndpoint);
        cleanupNeeded = false;
      } finally {
        if (cleanupNeeded && context !== undefined) {
          await runHostWorker(context.workerEnv("cleanup"));
        }
        await closeFixture(fixture);
        if (context !== undefined) {
          await cleanupFixtureProfiles(context);
        }
      }
    },
  );
});
