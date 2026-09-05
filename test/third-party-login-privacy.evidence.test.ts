/**
 * Issue #25: privacy/isolation verification suite for the optional,
 * owner-performed third-party login smoke test.
 *
 * This ticket is `ready-for-human`: the owner explicitly opts in, selects the
 * site, and personally enters every credential and second-factor challenge in
 * Safe Login Mode. The agent never enters credentials, never performs a real
 * third-party login, and never mutates the host. This file is the agent-doable
 * PREPARATION deliverable the owner uses to verify the privacy/isolation
 * guarantees hold around that optional smoke test.
 *
 * The suite is gated behind the real-browser integration flag exactly like
 * the issue #24 host suites: importing the shared fixture imports
 * `integrationEnabled` from `evidence-helpers.ts`, which throws at module load
 * when `BB_BROWSER_REAL_INTEGRATION_REQUIRED=1` is set without integration
 * enabled (the "mandatory real-browser gate cannot be skipped" invariant).
 * Tests register with `it.runIf(integrationEnabled)` and skip deterministically
 * (never fail) without a provisioned host, naming the exact missing capability
 * via the #24 `skipIfNotProvisioned` helper that surfaces the reason.
 *
 * When run on a provisioned host with the owner opted in, it verifies:
 *   - AC2/AC3/AC5: no credential, full URL, DOM content, screenshot, input,
 *     cookie, or page content is captured in logs, diagnostics, Activity
 *     Records, or test artifacts (reuses the #21 `findSensitiveData` /
 *     `SENSITIVE_DATA_PATTERNS` scan helpers); other panels remain opaque and
 *     agents remain denied throughout Safe Login (reuses the #18 Safe Login
 *     policy/fixture and the #24 host-provisioning helpers); only a
 *     compatibility pass/fail/skipped outcome is recorded, with a high-level
 *     failure category that reveals no account or site-sensitive details.
 *   - AC4: Done returns the profile to Automation Mode and the owner decides
 *     whether a minimal non-sensitive authenticated-state check is appropriate
 *     (the test asserts the mode transition and that no sensitive data leaked,
 *     NOT that any particular authenticated-state check was performed).
 *   - AC7: the boundaries (sandbox, origin policy, transport authentication,
 *     privacy) remain intact after the run.
 *
 * It reuses the existing `safe-login` worker action (which drives the
 * deterministic loopback authentication fixture, NOT a real third-party site)
 * so the privacy/isolation machinery is proven without entering real
 * credentials. It does not duplicate any helper.
 */
import { describe, expect, it } from "vitest";
import {
  assertDedicatedIdentity,
  assertLoopbackSocket,
  assertLoopbackSocketClosed,
  cleanupFixtureProfiles,
  closeFixture,
  createAuthenticationFixture,
  findSensitiveData,
  integrationEnabled,
  listenFixture,
  provisionedHostContext,
  runHostWorker,
  skipIfNotProvisioned,
  type ProvisionedHostContext,
  type WorkerReport,
} from "./fixtures/host-provisioning.js";
import { projectLoopbackAddress } from "../src/browser/browser-navigation.js";

/**
 * The high-level compatibility outcome the owner records for the smoke test
 * (AC5). Only `result` and `category` are recorded; neither reveals an
 * account identifier, site origin, URL, credential, or page content. The
 * labels mirror the runbook (docs/browser/third-party-login-smoke-test.md).
 */
export interface ThirdPartyLoginCompatibilityOutcome {
  result: "pass" | "fail" | "skipped";
  category:
    | "safe-login-compatible"
    | "safe-login-isolation"
    | "safe-login-not-exercised";
}

/**
 * Derive the minimal compatibility outcome from a Safe Login worker report
 * without emitting any account/site-sensitive detail. Used by both the test
 * assertions and (by analogy) the runbook's recording guidance. Never includes
 * the site origin, account, URL, or error text.
 */
export function deriveCompatibilityOutcome(
  report: WorkerReport,
): ThirdPartyLoginCompatibilityOutcome {
  const safe = report.safeLogin;
  if (safe === undefined) {
    return { result: "skipped", category: "safe-login-not-exercised" };
  }
  // A pass requires the owner (here the fixture) to have entered Safe Login,
  // stayed isolated throughout, and returned cleanly to Automation Mode. A
  // failure is reported only at the high-level "isolation" category — never
  // with the site or account detail.
  if (!safe.entered || !safe.doneReturnedToAutomation || !safe.agentDenied) {
    return { result: "fail", category: "safe-login-isolation" };
  }
  return { result: "pass", category: "safe-login-compatible" };
}

describe("issue #25 third-party login smoke-test privacy/isolation", () => {
  it.runIf(integrationEnabled)(
    "AC2/AC3/AC5 — captures no sensitive data and keeps panels opaque and agents denied throughout Safe Login",
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

        // Drive the existing `safe-login` worker action. It exercises the real
        // owner-only Safe Login Mode policy against the live (deterministic
        // loopback) fixture — NOT a real third-party site — so the
        // privacy/isolation machinery is proven without entering real
        // credentials. The agent does not sign in.
        const report = await runHostWorker(context.workerEnv("safe-login"));
        const safe = report.safeLogin;
        expect(safe).toBeDefined();

        // AC3: only the initiating panel gets pixels; other panels stay opaque;
        // agents are denied for the whole Safe Login duration.
        expect(safe?.entered).toBe(true);
        expect(safe?.initiatorOnlyPixels).toBe(true);
        expect(safe?.elsewhereOpaque).toBe(true);
        expect(safe?.agentDenied).toBe(true);
        expect(safe?.activityMetadataOnly).toBe(true);

        // AC2/AC5: the worker report is the diagnostics + test-artifact
        // surface. Scan it with the #21 helpers for every forbidden category
        // (password, credential, cookie, bearer-token, api-key, private-key,
        // local-token, session-token, screenshot-payload, clipboard-content,
        // fixture-session-cookie). No credential, full URL, DOM content,
        // screenshot, input, cookie, or page content may be captured.
        const reportJson = JSON.stringify(report);
        const reportLeaks = findSensitiveData(reportJson);
        expect(
          reportLeaks,
          `worker report leaked sensitive categories: ${reportLeaks.join(", ")}`,
        ).toEqual([]);
        // The fixture sign-in cookie and any injected secret never reach the
        // report or the retained surfaces.
        expect(reportJson).not.toContain("fixture-session=valid");
        expect(reportJson).not.toContain("fixture-user");

        // AC5: only a minimal compatibility outcome is recorded, with a
        // high-level failure category that reveals no account or site detail.
        const outcome = deriveCompatibilityOutcome(report);
        expect(["pass", "fail", "skipped"]).toContain(outcome.result);
        expect([
          "safe-login-compatible",
          "safe-login-isolation",
          "safe-login-not-exercised",
        ]).toContain(outcome.category);
        const outcomeLeaks = findSensitiveData(JSON.stringify(outcome));
        expect(
          outcomeLeaks,
          `compatibility outcome leaked: ${outcomeLeaks.join(", ")}`,
        ).toEqual([]);

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

  it.runIf(integrationEnabled)(
    "AC4 — Done returns the profile to Automation Mode and the owner decides the authenticated-state check",
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

        // AC4: Done returns the same profile to Automation Mode and the
        // runtime reconciles back to automation. The owner decides whether a
        // minimal non-sensitive authenticated-state check is appropriate; the
        // test asserts the mode transition and the no-leak guarantee — NOT that
        // any particular authenticated-state check was performed.
        expect(safe?.doneReturnedToAutomation).toBe(true);
        expect(safe?.reconciledToAutomation).toBe(true);

        // No sensitive data leaked across the real worker report surface.
        // The policy-level mode transition and agent denial are already proven
        // by the real report assertions above and by the AC2/AC3/AC5 suite's
        // non-vacuous scan of this same report; a separate self-built
        // policyJson scan would be vacuous (the #21 manifest-scan anti-pattern),
        // so it is intentionally omitted.
        const reportLeaks = findSensitiveData(JSON.stringify(report));
        expect(
          reportLeaks,
          `report surface leaked: ${reportLeaks.join(", ")}`,
        ).toEqual([]);

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

  it.runIf(integrationEnabled)(
    "AC7 — boundaries remain intact after the run (sandbox, loopback transport, privacy)",
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

        // AC7: the sandbox is never weakened. The bb-browser dedicated user
        // owns the browser/helper processes and Chrome runs with the sandbox
        // enabled (no --no-sandbox) before, during, and after Safe Login.
        assertDedicatedIdentity(report);

        // AC7: transport authentication is never weakened. The automation
        // endpoint binds to loopback while Safe Login runs, and the post-stop
        // report shows every loopback listener closing (no endpoint stays
        // exposed) after Done.
        await assertLoopbackSocket(report.instance.automationEndpoint);
        await runHostWorker(context.workerEnv("cleanup"));
        await assertLoopbackSocketClosed(report.instance.automationEndpoint);

        // AC7: the post-stop surface carries no sensitive data and the
        // privacy boundaries remain intact after the run.
        const postStop = report.postStop;
        expect(postStop).toBeDefined();
        const postStopLeaks = findSensitiveData(JSON.stringify(postStop));
        expect(
          postStopLeaks,
          `post-stop surface leaked: ${postStopLeaks.join(", ")}`,
        ).toEqual([]);
        // No Browser-owned process lingers with --no-sandbox after cleanup.
        for (const process of postStop?.ownedProcesses ?? []) {
          expect(process.command).not.toContain("--no-sandbox");
        }

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
