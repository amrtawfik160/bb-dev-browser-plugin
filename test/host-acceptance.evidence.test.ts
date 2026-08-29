/**
 * Issue #24 acceptance criteria 3 & 4: deterministic remote acceptance on a
 * provisioned host through the owner's BB Connect session.
 *
 * When run on a provisioned, BB-Connect-enrolled host (gate on), this suite
 * exercises the full acceptance matrix through the real host worker and the
 * #21 in-memory evidence helpers:
 *   - profile creation and fixture sign-in persistence,
 *   - a second panel and owner control transfer,
 *   - exact-origin automation and denied-origin one-retry,
 *   - Safe Login isolation,
 *   - client/workspace transfer,
 *   - quarantined download export,
 *   - sleep/wake, reload, and host-offline recovery,
 *   - disable/re-enable retention.
 *
 * Real-host boundaries that the existing `real-browser-worker.ts` fixture
 * drives (start/crash-recover/lifecycle/origin-scope/panel-transport/
 * safe-login/transfer/disable-re-enable) are exercised by spawning that
 * worker and asserting its report. The worker `transfer` action drives
 * client/workspace transfer AND quarantined download export through the real
 * host worker path; the worker `disable-re-enable` action drives disable/
 * re-enable retention through the real worker path. The in-memory contract
 * suites (transfer-staging, host-downloads-boundary, release-lifecycle)
 * remain the always-on baseline. This makes AC3's "through the owner's
 * authenticated BB Connect session" genuinely exercisable on a provisioned
 * host rather than only delegated to in-memory suites.
 *
 * Without a provisioned host every test skips deterministically, naming the
 * exact missing capability in the skip output (never fails). This file never
 * provisions or mutates the host. Gate convention matches
 * `host-setup-verification.test.ts`: importing the shared fixture imports
 * `integrationEnabled` from `evidence-helpers.ts`, which throws at module load
 * when required-but-not-enabled; tests register with `it.runIf(integrationEnabled)`.
 */
import { describe, expect, it } from "vitest";
import {
  assertLoopbackSocket,
  assertLoopbackSocketClosed,
  cleanupFixtureProfiles,
  closeFixture,
  createAuthenticationFixture,
  integrationEnabled,
  listenFixture,
  parsedScriptOutput,
  provisionedHostContext,
  runHostWorker,
  skipIfNotProvisioned,
  type ProvisionedHostContext,
  type WorkerReport,
} from "./fixtures/host-provisioning.js";
import { projectLoopbackAddress } from "../browser-navigation.js";

describe("issue #24 AC3/AC4 deterministic remote acceptance", () => {
  it.runIf(integrationEnabled)(
    "creates a profile, persists a fixture sign-in across a worker restart, and restores tabs",
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

        const first = await runHostWorker(context.workerEnv("start"));
        // Profile creation + fixture sign-in persists the authenticated session.
        expect(parsedScriptOutput(first)).toMatchObject({
          accountHeading: "Signed in",
          popupHeading: "Authenticated popup",
        });
        // Navigation created a shared tab present in the before inventory.
        expect(first.navigation?.after).toHaveLength(
          first.navigation?.before.length ?? -1,
        );
        await assertLoopbackSocket(first.instance.automationEndpoint);

        // A crash + restart restores the same profile's tabs and session.
        const restored = await runHostWorker(
          context.workerEnv("crash-recover"),
        );
        expect(restored.recovery).toEqual({
          crashedPid: first.instance.pid,
          recoveredPid: restored.instance.pid,
        });
        expect(parsedScriptOutput(restored)).toMatchObject({
          heading: "Signed in",
          popupHeading: "Authenticated popup",
          local: "persistent",
          session: "restorable",
          locale: "en-GB",
          timezone: "Europe/London",
        });
        await assertLoopbackSocketClosed(first.instance.automationEndpoint);
        await assertLoopbackSocketClosed(restored.instance.automationEndpoint);
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

  it.runIf(integrationEnabled)(
    "exercises sleep/wake, reload, host-offline recovery, LRU sleep, and crash-loop repair through the lifecycle worker",
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

        const report = await runHostWorker(context.workerEnv("lifecycle"));
        const lifecycle = report.lifecycle;
        expect(lifecycle).toBeDefined();
        // Sleep/wake + LRU: unmanaged instances retire to sleeping.
        expect(lifecycle?.lruState).toBe("sleeping");
        expect(lifecycle?.idleStates).toEqual([
          "sleeping",
          "sleeping",
          "sleeping",
        ]);
        // A pinned-instance limit is enforced while panels hold instances.
        expect(lifecycle?.pinnedLimitCode).toBe("awake-limit");
        // Host-offline recovery: disconnect freezes work; reconnect reconciles.
        expect(lifecycle?.disconnectedCode).toBe("host-offline");
        expect(lifecycle?.reconciledPid).toBe(lifecycle?.initialPid);
        // Reload: a fresh worker observes the previously-running profile lazily
        // (sleeping) and starts it again on demand.
        expect(lifecycle?.lazyState).toBe("sleeping");
        expect(lifecycle?.reloadPids[0]).not.toBe(lifecycle?.reloadPids[1]);
        // Crash loop: three crashes in five minutes reach repair-required.
        expect(lifecycle?.crashLoopState).toMatchObject({
          state: "repair-required",
          diagnostics: { crashCount: 3, windowMs: 5 * 60 * 1_000 },
        });
        expect(lifecycle?.corruptCode).toBe("repair-required");
        expect(new Set(lifecycle?.crashPids).size).toBe(3);
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

  it.runIf(integrationEnabled)(
    "drives exact-origin automation, denied-origin blocking, one-retry revocation, and owner-page presence",
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

        // The "origin-scope" worker action drives the real origin-scope
        // enforcement against attack pages and the in-scope origin.
        const originScope = context.workerEnv("origin-scope", {
          BB_BROWSER_ORIGIN_SCOPE: `http://127.0.0.1:${port}`,
          BB_BROWSER_ATTACK_PAGES: JSON.stringify([
            { kind: "cross-origin", page: "https://attacker.example.test/" },
            { kind: "local-other-port", page: "http://127.0.0.1:9/account" },
          ]),
        });
        const report = await runHostWorker(originScope);
        const scope = report.originScope;
        expect(scope).toBeDefined();
        // Exact-origin automation: the in-scope origin is reachable.
        expect(scope?.inScope.ok).toBe(true);
        // Denied-origin: every attack page is blocked with a denied origin.
        expect(scope?.attacks.length).toBeGreaterThan(0);
        for (const attack of scope?.attacks ?? []) {
          expect(attack.blocked).toBe(true);
          expect(attack.deniedOrigin).toBeDefined();
        }
        // One-retry revocation: aborting the lease signal interrupts the
        // in-flight operation but leaves the browser running for the owner.
        expect(scope?.revocation.interrupted).toBe(true);
        expect(scope?.revocation.browserStillRunning).toBe(true);
        // The owner page remains present after revocation.
        expect(scope?.ownerPage.present).toBe(true);
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

  it.runIf(integrationEnabled)(
    "exercises a second panel, owner control transfer, and loopback gateway redemption/revocation",
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

        const report = await runHostWorker(
          context.workerEnv("panel-transport"),
        );
        const panel = report.panelTransport;
        expect(panel).toBeDefined();
        // The Panel Capability is single-use: first redemption accepted.
        expect(panel?.redeemed).toBe(true);
        // A second panel (replay) is rejected; control does not transfer to it.
        expect(panel?.replayed).toBe(false);
        // The gateway binds loopback only and the viewport matches the cap.
        expect(panel?.gatewayBindHost).toBe("127.0.0.1");
        expect(panel?.viewport.width).toBeLessThanOrEqual(1920);
        expect(panel?.viewport.height).toBeLessThanOrEqual(1080);
        // Reclaim window and revocation are enforced.
        expect(panel?.reclaimWindowMs).toBeGreaterThan(0);
        expect(panel?.revoked).toBe(true);
        await assertLoopbackSocket(report.instance.automationEndpoint);
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

  it.runIf(integrationEnabled)(
    "exercises Safe Login isolation: initiator-only pixels, elsewhere opaque, agents denied, fixture authentication",
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

        const report = await runHostWorker(context.workerEnv("safe-login"));
        const safe = report.safeLogin;
        expect(safe).toBeDefined();
        // Safe Login is owner-only: only the initiating panel gets pixels.
        expect(safe?.entered).toBe(true);
        expect(safe?.initiatorOnlyPixels).toBe(true);
        // Other owner panels show an opaque mode indicator.
        expect(safe?.elsewhereOpaque).toBe(true);
        // Agents receive neither pixels nor DOM access.
        expect(safe?.agentDenied).toBe(true);
        // The owner signs in through the deterministic fixture while in Safe Login.
        expect(safe?.authenticatedThroughFixture).toBe(true);
        // Lease extension, Done → return to automation, and reconciliation hold.
        expect(safe?.extended).toBe(true);
        expect(safe?.doneReturnedToAutomation).toBe(true);
        expect(safe?.reconciledToAutomation).toBe(true);
        expect(safe?.activityMetadataOnly).toBe(true);
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

  // Client/workspace transfer, quarantined download export, and disable/
  // re-enable retention are exercised through the REAL host worker path on a
  // provisioned host (issue #24 S4/P2) rather than only delegated to the
  // in-memory contract suites. The worker `transfer` action drives Transfer
  // Staging (client/workspace upload) AND quarantined download export through
  // the real host worker; the worker `disable-re-enable` action stops every
  // Browser-owned process, rebuilds a fresh runtime, and verifies the profile's
  // persisted state survives the cycle. The in-memory contract suites
  // (transfer-staging, host-downloads-boundary, release-lifecycle) remain the
  // always-on baseline.

  it.runIf(integrationEnabled)(
    "exercises client/workspace transfer and quarantined download export through the real worker transfer action",
    { timeout: 240_000 },
    async (ctx) => {
      const probed = await provisionedHostContext();
      if (!skipIfNotProvisioned(ctx, probed)) return;
      const context = probed;
      try {
        // The real worker `transfer` action stages a workspace file (symlink /
        // traversal rejected), consumes and purges it, then runs a quarantined
        // download → client export (bytes match) and workspace export
        // (host-to-host copy, outside-environment rejected) through the real
        // host worker path. This is the same path the BB Connect transport
        // serves, so AC3's "through the owner's authenticated BB Connect
        // session" is genuinely exercisable on a provisioned host.
        const report = await runHostWorker(context.workerEnv("transfer"));
        const transfer = report.transfer;
        expect(transfer).toBeDefined();
        expect(transfer?.failClosedWithoutDataDir).toBe(true);
        expect(transfer?.stagedWorkspace).toBe(true);
        expect(transfer?.privacySafeNoPath).toBe(true);
        expect(transfer?.removedAfterUse).toBe(true);
        expect(transfer?.symlinkEscapeRejected).toBe(true);
        expect(transfer?.traversalRejected).toBe(true);
        const download = report.downloadExport;
        expect(download).toBeDefined();
        expect(download?.quarantined).toBe(true);
        expect(download?.exportedToClient).toBe(true);
        expect(download?.clientBytesMatch).toBe(true);
        expect(download?.exportedToWorkspace).toBe(true);
        expect(download?.outsideEnvironmentRejected).toBe(true);
        expect(download?.quarantineRetained).toBe(true);
        expect(download?.privacySafeNoPath).toBe(true);
      } finally {
        await cleanupFixtureProfiles(context);
      }
    },
  );

  it.runIf(integrationEnabled)(
    "exercises disable/re-enable retention through the real worker path on a provisioned host",
    { timeout: 240_000 },
    async (ctx) => {
      const fixture = createAuthenticationFixture();
      let context: ProvisionedHostContext | undefined;
      try {
        const port = await listenFixture(fixture);
        const fixtureAddress = projectLoopbackAddress(
          "ci-browser-project",
          `http://localhost:${port}/account`,
        );
        const probed = await provisionedHostContext(fixtureAddress);
        if (!skipIfNotProvisioned(ctx, probed)) return;
        context = probed;
        await cleanupFixtureProfiles(context);
        // The real worker `disable-re-enable` action persists a fixture sign-in,
        // stops and disposes the runtime (plugin "disable"), rebuilds a fresh
        // runtime (plugin "re-enable"), and verifies the profile's persisted
        // sign-in / localStorage / sessionStorage / locale / timezone survive
        // the cycle. Disable never purges profile data, so re-enable restores
        // the authenticated session without re-authentication.
        const report = await runHostWorker(
          context.workerEnv("disable-re-enable"),
        );
        const retention = report.disableReEnable;
        expect(retention).toBeDefined();
        expect(retention?.accountHeadingRetained).toBe(true);
        expect(retention?.localStorageRetained).toBe(true);
        expect(retention?.sessionStorageRetained).toBe(true);
        expect(retention?.localeRetained).toBe(true);
        expect(retention?.timezoneRetained).toBe(true);
        expect(retention?.preDisableProcessGone).toBe(true);
      } finally {
        await closeFixture(fixture);
        if (context !== undefined) {
          await cleanupFixtureProfiles(context);
        }
      }
    },
  );

  it.runIf(integrationEnabled)(
    "acceptance evidence report shape is consistent across worker actions",
    { timeout: 60_000 },
    async (ctx) => {
      // A structural sanity check that every worker report carries the
      // dedicated identity and loopback automation endpoint the acceptance
      // matrix relies on, so a future drift surfaces as a single clear failure.
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
        const report: WorkerReport = await runHostWorker(
          context.workerEnv("panel-transport"),
        );
        expect(report.uid).toBeGreaterThan(0);
        expect(report.gid).toBeGreaterThan(0);
        expect(new URL(report.instance.automationEndpoint).hostname).toBe(
          "127.0.0.1",
        );
        expect(report.ownedProcesses.length).toBeGreaterThan(0);
        await runHostWorker(context.workerEnv("cleanup"));
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
