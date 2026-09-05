/**
 * Issue #21 acceptance criterion 5: Sensitive-data scans cover logs, Activity
 * Records, diagnostics, database state, transport errors, and retained
 * manifests.
 *
 * A single end-to-end flow runs browser_script with sensitive-looking code and
 * a sensitive-looking purpose, signs in through the deterministic login
 * fixture (which mints a session token), and then scans every retained surface
 * for the sensitive categories the spec excludes from plugin persistence
 * (passwords, credentials, cookies, tokens, secrets, scripts, purposes, page
 * contents, screenshots, clipboard, full URLs, form input). The host is never
 * mutated and Chrome is never provisioned.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../../src/shared/contracts.js";
import { createPanelCapabilityStore as createStore } from "../../src/panel/panel-capability.js";
import { createPanelGateway as createGateway } from "../../src/panel/panel-gateway.js";
import { createFileBrowserProfileStore } from "../../src/host/profile-storage.js";
import { deterministicLoginFixture } from "../fixtures/safe-login-fixture.js";
import {
  createEvidenceHarness,
  findSensitiveData,
} from "../fixtures/evidence-helpers.js";

const HOST_ID = "host-browser-test";
const PROJECT_ID = "project-browser-test";
const ORIGIN = "https://app.example.test";

// Sensitive material injected into the live flow that must never reach
// retained plugin surfaces.
const SENSITIVE_SCRIPT = `const password = "super-secret-password"; await page.fill("input", password); return "ok";`;
const SENSITIVE_PURPOSE = "credential harvest for api-key Bearer abc123";
const SENSITIVE_COOKIE = "fixture-session=valid";

describe("issue #21 AC5 sensitive-data scans across retained surfaces", () => {
  it("retains no sensitive data in Activity Records, database, durable outbox, logs, diagnostics, or manifests", async () => {
    // The manifest scan is wired to the SAME profile store the sensitive flow
    // drives: the store (rooted at `manifestRoot`) is passed into
    // `createEvidenceHarness`, so `createBrowserProfile` + `runBrowserScript`
    // actually write manifests that received the flow's profile. Scanning this
    // root therefore proves the retained manifests exclude the sensitive
    // material, rather than scanning a separate store that was never exposed.
    const manifestRoot = await mkdtemp(join(tmpdir(), "bb-evidence-scan-"));
    const store = createFileBrowserProfileStore({
      rootDirectory: manifestRoot,
      installationId: "installation-public-test",
      lifecycle: { stopProfile: async () => undefined },
    });
    const evidence = await createEvidenceHarness({ profileStore: store });
    try {
      await evidence.harness.createBrowserProfile({
        hostId: HOST_ID,
        name: "Sensitive scan target",
      });
      await evidence.harness.createBrowserGrant({
        projectId: PROJECT_ID,
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        originScope: ORIGIN,
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      });
      // Drive the engine seam with sensitive-looking code/purpose.
      await evidence.harness.runBrowserScriptWithProfile(undefined, {
        purpose: SENSITIVE_PURPOSE,
        code: SENSITIVE_SCRIPT,
        destinationOrigin: ORIGIN,
      });
      // Mint a fixture session token (a real sign-in would set a cookie).
      const login = deterministicLoginFixture();
      login.authenticate();

      // 1. Activity Records (the public, owner-facing audit surface).
      const records = await evidence.harness.runBrowserActivityRecords();
      const recordsJson = JSON.stringify(records);
      const recordsLeaks = findSensitiveData(recordsJson);
      expect(
        recordsLeaks,
        `Activity Records leaked: ${recordsLeaks.join(", ")}`,
      ).toEqual([]);
      // Scripts and purposes are never retained in Activity Records.
      expect(recordsJson).not.toContain("super-secret-password");
      expect(recordsJson).not.toContain(SENSITIVE_PURPOSE);
      // The fixture session cookie never reaches Activity Records.
      expect(recordsJson).not.toContain(SENSITIVE_COOKIE);

      // 2. Database state (the raw transactional rows).
      const rows = evidence.harness.persistedActivityRows();
      const dbJson = JSON.stringify(rows);
      const dbLeaks = findSensitiveData(dbJson);
      expect(dbLeaks, `Database rows leaked: ${dbLeaks.join(", ")}`).toEqual(
        [],
      );
      expect(dbJson).not.toContain("super-secret-password");
      expect(dbJson).not.toContain(SENSITIVE_PURPOSE);

      // 3. Durable host outbox.
      const outbox = await evidence.harness.persistedHostOutbox();
      const outboxLeaks = findSensitiveData(outbox);
      expect(
        outboxLeaks,
        `Durable outbox leaked: ${outboxLeaks.join(", ")}`,
      ).toEqual([]);
      expect(outbox).not.toContain("super-secret-password");
      expect(outbox).not.toContain(SENSITIVE_PURPOSE);

      // 4. Diagnostics (redacted, owner-triggered).
      const diagnosticsCli = await evidence.harness.runDiagnosticsCli();
      const diagnosticsJson = diagnosticsCli.stdout ?? "";
      const diagLeaks = findSensitiveData(diagnosticsJson);
      expect(diagLeaks, `Diagnostics leaked: ${diagLeaks.join(", ")}`).toEqual(
        [],
      );
      expect(diagnosticsJson).not.toContain("super-secret-password");
      expect(diagnosticsJson).not.toContain(SENSITIVE_PURPOSE);

      // 5. Logs (the test harness log surface).
      const logsJson = JSON.stringify(evidence.harness.diagnosticLogEntries());
      const logLeaks = findSensitiveData(logsJson);
      expect(logLeaks, `Logs leaked: ${logLeaks.join(", ")}`).toEqual([]);
      expect(logsJson).not.toContain("super-secret-password");

      // 6. Retained manifests (profile store on-disk manifests). The scan is
      // wired to the same store the sensitive flow drives, so the manifests
      // below actually received the flow's profile; the scan is therefore
      // non-vacuous (it is not an empty never-exposed store).
      const manifestFiles = await collectManifestFiles(manifestRoot);
      expect(
        manifestFiles.length,
        "expected the sensitive flow to have produced retained manifests",
      ).toBeGreaterThan(0);
      const manifestsJson = (
        await Promise.all(
          manifestFiles.map(
            async (file) => `${file}:${await readFile(file, "utf8")}`,
          ),
        )
      ).join("\n");
      const manifestLeaks = findSensitiveData(manifestsJson);
      expect(
        manifestLeaks,
        `Retained manifests leaked: ${manifestLeaks.join(", ")}`,
      ).toEqual([]);
      expect(manifestsJson).not.toContain("super-secret-password");
      expect(manifestsJson).not.toContain(SENSITIVE_COOKIE);
    } finally {
      await evidence.cleanup();
      await rm(manifestRoot, { recursive: true, force: true });
    }
  });

  it("never leaks sensitive data through transport error messages on capability replay or malformed input", () => {
    const capabilities = createStore();
    const gateway = createGateway({
      capabilities,
      hostId: "host-scan",
      profileId: DEFAULT_PROFILE_ID,
    });
    try {
      const issued = capabilities.issue({
        ownerSessionId: "owner-session-scan",
        panelId: "panel-scan",
        hostId: "host-scan",
        profileId: DEFAULT_PROFILE_ID,
      });
      const redeem = JSON.stringify({
        type: "redeem",
        capabilityId: issued.capabilityId,
        secret: issued.secret,
        ownerSessionId: "owner-session-scan",
        panelId: "panel-scan",
      });
      // First redemption succeeds; replay must be rejected.
      const first = gateway.validate(redeem);
      expect(first.outcome).toBe("accepted");
      const replay = gateway.validate(redeem);
      expect(replay.outcome).toBe("rejected");
      // A malformed message carrying a sensitive-looking payload must not echo
      // the payload back in its error/rejection surface.
      const malicious = JSON.stringify({
        type: "redeem",
        capabilityId: "unknown",
        secret: "password=Bearer-api-key",
        ownerSessionId: "owner-session-scan",
        panelId: "panel-scan",
      });
      const malformed = gateway.validate(malicious);
      const surface = JSON.stringify(malformed);
      const leaks = findSensitiveData(surface);
      expect(leaks, `Transport error leaked: ${leaks.join(", ")}`).toEqual([]);
      // The gateway never exposes a loopback URL or ws:// endpoint.
      expect(surface).not.toContain("ws://");
      expect(gateway.declaredBindHost()).toBe("127.0.0.1");
    } finally {
      capabilities.dispose();
    }
  });
});

async function collectManifestFiles(rootDirectory: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (
        entry.name.endsWith(".json") &&
        !entry.name.endsWith(".crashes.json")
      ) {
        files.push(full);
      }
    }
  }
  await walk(rootDirectory);
  return files;
}
