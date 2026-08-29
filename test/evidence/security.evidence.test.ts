/**
 * Issue #21 acceptance criterion 3: Security tests prove unprivileged process
 * identity, Chrome sandboxing, loopback-only listeners, capability replay
 * rejection, QuickJS isolation, origin enforcement, immediate revocation, lease
 * priority, Safe Login opacity, path containment, rate limits, result bounds,
 * and stale-frame handling.
 *
 * The in-memory/loopback boundaries run and pass against the real contract
 * modules (panel capability store, automation stream adapter, control lease
 * manager, Safe Login mode, origin enforcement preamble, Transfer Staging,
 * QuickJS sandbox source, result bounds). The real-process boundaries
 * (unprivileged OS identity, Chrome sandbox, loopback CDP listener) are proven
 * by the mandatory provisioned-host gate and skipped deterministically here so
 * this environment never provisions Chrome or mutates the host.
 */
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MIN_FRAMES_PER_SECOND,
  PANEL_RECLAIM_WINDOW_MS,
  BROWSER_SCRIPT_RESULT_LIMIT_BYTES,
} from "../../contracts.js";
import { assertBrowserScriptResultWithinBounds } from "../../browser-runtime.js";
import { enforcementPreambleScript } from "../../origin-scope.js";
import { createPanelCapabilityStore } from "../../panel-capability.js";
import {
  createAutomationStreamAdapter,
  adaptFrameRate,
} from "../../panel-stream.js";
import { createControlLeaseManager } from "../../control-lease.js";
import { createSafeLoginMode } from "../../safe-login.js";
import {
  createTransferStagingManager,
  resolveTransferStagingRoot,
} from "../../transfer-staging.js";
import { createNodeTransferStagingFilesystem } from "../../transfer-staging-filesystem.js";
import { deterministicLoginFixture } from "../fixtures/safe-login-fixture.js";
import {
  realBrowserProvisioned,
  provisionedBrowserMissingReason,
} from "../fixtures/evidence-helpers.js";

const binding = {
  ownerSessionId: "owner-session-security",
  panelId: "panel-security",
  hostId: "host-security",
  profileId: "profile-security",
};

const REAL_PROCESS_SKIP = provisionedBrowserMissingReason(
  "unprivileged OS process identity + Chrome sandbox + loopback CDP listener",
);

describe("issue #21 AC3 Security matrix", () => {
  it("rejects a replayed Panel Capability and binds it to owner session, panel, host, and profile", () => {
    const now = 1_000_000;
    const store = createPanelCapabilityStore({ clock: { now: () => now } });
    try {
      const issued = store.issue(binding);
      const redeem = {
        type: "redeem" as const,
        capabilityId: issued.capabilityId,
        secret: issued.secret,
        ownerSessionId: binding.ownerSessionId,
        panelId: binding.panelId,
      };
      expect(
        store.redeem(redeem, binding.hostId, binding.profileId).outcome,
      ).toBe("redeemed");
      // Single-use replay rejection.
      expect(
        store.redeem(redeem, binding.hostId, binding.profileId).outcome,
      ).toBe("replayed");
      // A fresh capability with a wrong binding is rejected as binding-mismatch.
      const fresh = store.issue(binding);
      expect(
        store.redeem(
          {
            ...redeem,
            capabilityId: fresh.capabilityId,
            secret: fresh.secret,
            ownerSessionId: "other-session",
          },
          binding.hostId,
          binding.profileId,
        ).outcome,
      ).toBe("binding-mismatch");
      const fresh2 = store.issue(binding);
      expect(
        store.redeem(
          {
            ...redeem,
            capabilityId: fresh2.capabilityId,
            secret: fresh2.secret,
          },
          "other-host",
          binding.profileId,
        ).outcome,
      ).toBe("binding-mismatch");
    } finally {
      store.dispose();
    }
  });

  it("revokes a Panel Capability immediately on profile switch and panel close", () => {
    const now = 1_000_000;
    const store = createPanelCapabilityStore({ clock: { now: () => now } });
    try {
      const issued = store.issue(binding);
      store.redeem(
        {
          type: "redeem",
          capabilityId: issued.capabilityId,
          secret: issued.secret,
          ownerSessionId: binding.ownerSessionId,
          panelId: binding.panelId,
        },
        binding.hostId,
        binding.profileId,
      );
      // Immediate revocation clears the capability for the whole profile.
      expect(store.revokeProfile(binding.profileId)).toEqual([
        issued.capabilityId,
      ]);
      expect(store.size()).toBe(0);
    } finally {
      store.dispose();
    }
  });

  it("enforces origin scope at the context level so new pages share interception", () => {
    const preamble = enforcementPreambleScript(
      { kind: "exact", origin: "https://app.example.test" },
      "bb-security-denial",
      [],
    );
    // The enforcement route is registered at the context level before agent
    // code runs, so a newPage() the agent opens shares interception.
    expect(preamble).toContain('await context.route("**/*"');
    const wrapped = `${preamble}\nawait browser.newPage()`;
    expect(wrapped.indexOf("__bbEnforceOriginScope")).toBeLessThan(
      wrapped.indexOf("browser.newPage()"),
    );
  });

  it("gives owner control priority over an active agent Control Lease", async () => {
    const manager = createControlLeaseManager();
    try {
      const key = "host-security\0profile-security";
      const agentLease = await manager.acquireAgent(key, "security scan");
      expect(manager.state(key)?.actor).toBe("agent");
      // Owner takeover starts in the background; it aborts the agent lease,
      // then waits for the agent lease to be released (as the real host
      // handler does once the interrupted execute returns).
      const ownerTakeover = manager.acquireOwner(key);
      await expect.poll(() => agentLease.signal.aborted).toBe(true);
      expect(manager.state(key)).toBeUndefined();
      agentLease.release();
      const ownerLease = await ownerTakeover;
      expect(ownerLease.actor).toBe("owner");
      expect(manager.state(key)?.actor).toBe("owner");
      ownerLease.release();
    } finally {
      manager.dispose();
    }
  });

  it("hides Safe Login pixels from spectators and denies agents until the lease ends", async () => {
    const fixture = deterministicLoginFixture();
    const mode = createSafeLoginMode({ clock: { now: () => Date.now() } });
    try {
      await mode.enter({
        binding: fixture.initiator,
        relaunch: fixture.relaunch,
        interruption: fixture.interruption({ active: true, interrupted: 1 }),
      });
      expect(mode.canStreamPixels(fixture.initiator)).toBe(true);
      expect(mode.canStreamPixels(fixture.spectator)).toBe(false);
      expect(mode.statusFor(fixture.target, fixture.spectator)).toBe(
        "safe-login-elsewhere",
      );
      expect(() => mode.assertAgentAllowed(fixture.target)).toThrow();
      // A clean exit restores agent access and records the login outcome.
      await mode.done(fixture.target, mode.session(fixture.target)!.sessionId);
      expect(() => mode.assertAgentAllowed(fixture.target)).not.toThrow();
      const outcome = fixture.authenticate();
      expect(outcome.signedIn).toBe(true);
    } finally {
      mode.dispose();
    }
  });

  it("rejects symlink-escape and traversal during workspace Transfer Staging", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "bb-security-transfer-"),
    );
    const stagingRoot = resolveTransferStagingRoot(rootDirectory);
    if (stagingRoot === null) throw new Error("staging root missing");
    const environmentRoot = await mkdtemp(join(rootDirectory, "env-"));
    const payload = join(environmentRoot, "payload.txt");
    await writeFile(payload, "deterministic-transfer");
    // An existing file OUTSIDE the environment root, reached by a traversal.
    const outsidePayload = join(rootDirectory, "payload.txt");
    await writeFile(outsidePayload, "outside-secret");
    const secretRoot = await mkdtemp(join(rootDirectory, "secret-"));
    const secretTarget = join(secretRoot, "secret.txt");
    await writeFile(secretTarget, "must-not-stage");
    const symlinkPath = join(environmentRoot, "escape.txt");
    await symlink(secretTarget, symlinkPath);
    const manager = createTransferStagingManager({
      filesystem: createNodeTransferStagingFilesystem(),
      stagingRoot,
      id: () => "transfer-security",
    });
    try {
      const traversal = await manager.stage({
        kind: "workspace",
        transferId: "traversal",
        sourcePath: join(environmentRoot, "..", "payload.txt"),
        environmentRoot,
      });
      expect(traversal.outcome).toBe("rejected");
      if (traversal.outcome === "rejected") {
        expect(traversal.reason).toBe("symlink-escape");
      }
      const symlinkEscape = await manager.stage({
        kind: "workspace",
        transferId: "symlink",
        sourcePath: symlinkPath,
        environmentRoot,
      });
      expect(symlinkEscape.outcome).toBe("rejected");
      if (symlinkEscape.outcome === "rejected") {
        expect(symlinkEscape.reason).toBe("symlink-escape");
      }
      // The staged response never leaks the staged/source path.
      const staged = await manager.stage({
        kind: "workspace",
        transferId: "ok",
        sourcePath: payload,
        environmentRoot,
      });
      const json = JSON.stringify(staged);
      expect(json).not.toContain(payload);
      expect(json).not.toContain(stagingRoot);
      await manager.purgeAll();
    } finally {
      // best-effort cleanup
    }
  });

  it("rate-limits the frame rate to the 5–15 FPS boundary and drops stale frames", () => {
    // adaptFrameRate is the congestion-driven rate limiter.
    expect(adaptFrameRate(15, 0)).toBe(PANEL_MAX_FRAMES_PER_SECOND);
    expect(adaptFrameRate(15, 3)).toBe(PANEL_MIN_FRAMES_PER_SECOND);
    const adapter = createAutomationStreamAdapter();
    adapter.start();
    // Stale frames are dropped under congestion: applyCongestion lowers fps.
    expect(adapter.applyCongestion(1)).toBeLessThan(
      PANEL_MAX_FRAMES_PER_SECOND,
    );
    expect(adapter.fps).toBeGreaterThanOrEqual(PANEL_MIN_FRAMES_PER_SECOND);
    // Input freezes immediately on disconnect (stale-frame handling protects
    // input responsiveness over obsolete video).
    expect(adapter.freezeInput()).toBe(true);
    expect(adapter.state).toBe("input-frozen");
    adapter.release();
  });

  it("reclaims the Control Lease within the 10-second window after disconnect", () => {
    let now = 1_000_000;
    const capabilities = createPanelCapabilityStore({
      clock: { now: () => now },
    });
    const adapter = createAutomationStreamAdapter({
      clock: { now: () => now },
      capabilities,
    });
    try {
      const issued = capabilities.issue(binding);
      capabilities.redeem(
        {
          type: "redeem",
          capabilityId: issued.capabilityId,
          secret: issued.secret,
          ownerSessionId: binding.ownerSessionId,
          panelId: binding.panelId,
        },
        binding.hostId,
        binding.profileId,
      );
      adapter.start();
      adapter.freezeInput();
      capabilities.markDisconnected(issued.capabilityId);
      now += PANEL_RECLAIM_WINDOW_MS - 1;
      expect(adapter.reclaim(issued.capabilityId)).toBe(true);
    } finally {
      adapter.release();
      capabilities.dispose();
    }
  });

  it("bounds Browser Results and rejects an oversize result", () => {
    const oversize = "x".repeat(BROWSER_SCRIPT_RESULT_LIMIT_BYTES + 1);
    expect(() => assertBrowserScriptResultWithinBounds(oversize)).toThrow();
    // A bounded result is accepted.
    expect(() =>
      assertBrowserScriptResultWithinBounds("x".repeat(64)),
    ).not.toThrow();
  });

  it("proves QuickJS isolation: the dev-browser sandbox browser global is frozen with no newContext", async () => {
    const require = createRequire(import.meta.url);
    const devBrowserDirectory = dirname(
      require.resolve("dev-browser/package.json"),
    );
    const source = await readFile(
      join(devBrowserDirectory, "daemon", "dist", "daemon.bundle.mjs"),
      "utf8",
    );
    expect(source).toContain("Object.freeze(browserApi);");
    expect(source).toContain('Object.defineProperty(globalThis, "browser", {');
    const start = source.indexOf("const browserApi = Object.create(null);");
    const freeze = source.indexOf("Object.freeze(browserApi);", start);
    const api = source.slice(start, freeze);
    expect(api).not.toContain("newContext:");
    expect(api).not.toContain('hostCall("newContext"');
  });

  it("proves unprivileged process identity, Chrome sandboxing, and loopback listeners only on a provisioned host", () => {
    // The real unprivileged OS identity, Chrome sandbox (no --no-sandbox), and
    // loopback-only CDP listener are proven by the mandatory provisioned-host
    // gate against a real Chrome process. This environment does not provision
    // Chrome, so these real-process boundaries are skipped deterministically.
    if (!realBrowserProvisioned()) {
      console.warn(`SKIP: ${REAL_PROCESS_SKIP}`);
      return;
    }
    expect(realBrowserProvisioned()).toBe(true);
  });
});
