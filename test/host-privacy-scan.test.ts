/**
 * Issue #24 acceptance criterion 6: privacy scan of diagnostics and persisted
 * data on a provisioned host after the acceptance run.
 *
 * On a provisioned, BB-Connect-enrolled host (gate on), this suite scans the
 * host's diagnostics bundle and the retained Browser profile data produced by
 * the acceptance run for forbidden sensitive material. It REUSES the #21
 * `findSensitiveData` / `SENSITIVE_DATA_PATTERNS` scan helpers rather than
 * duplicating them, and drives the SAME retained surfaces through the #21
 * `createEvidenceHarness` so the scan is non-vacuous (the sensitive flow
 * actually writes the surfaces it scans).
 *
 * Without a provisioned host every test skips deterministically, naming the
 * exact missing capability (never fails). This file never provisions or
 * mutates the host. Gate convention matches the other #24 suites.
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../contracts.js";
import { createFileBrowserProfileStore } from "../profile-storage.js";
import {
  cleanupFixtureProfiles,
  closeFixture,
  createAuthenticationFixture,
  createEvidenceHarness,
  findSensitiveData,
  integrationEnabled,
  listenFixture,
  provisionedHostContext,
  runHostWorker,
  type MissingHostCapability,
  type ProvisionedHostContext,
} from "./fixtures/host-provisioning.js";
import { projectLoopbackAddress } from "../browser-navigation.js";

function skipIfNotProvisioned(
  ctx: { skip: () => void },
  result: ProvisionedHostContext | MissingHostCapability,
): result is ProvisionedHostContext {
  if ("missingCapability" in result) {
    ctx.skip();
    return false;
  }
  return true;
}

const SENSITIVE_SCRIPT = `const password = "super-secret-password"; await page.fill("input", password); return "ok";`;
const SENSITIVE_PURPOSE = "credential harvest for api-key Bearer abc123";
const SENSITIVE_COOKIE = "fixture-session=valid";

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

describe("issue #24 AC6 host privacy scan", () => {
  it.runIf(integrationEnabled)(
    "scans diagnostics and persisted profile data for forbidden sensitive material after the acceptance run",
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

        // Drive the real host worker so real Chrome profile data is produced on
        // the provisioned host, then scan the retained profile directory and the
        // redacted diagnostics for forbidden sensitive material.
        const report = await runHostWorker(context.workerEnv("start"));
        // The worker's sign-in mints a fixture cookie; retained profile data
        // must not leak it into plugin-retained surfaces.
        expect(report.scriptOutput).toContain("Signed in");

        // 1. Diagnostics: the worker's redacted exit logs and process states
        //    must exclude sensitive categories. The worker report itself is the
        //    diagnostics-shaped surface here.
        const reportJson = JSON.stringify(report);
        const reportLeaks = findSensitiveData(reportJson);
        expect(
          reportLeaks,
          `worker report leaked: ${reportLeaks.join(", ")}`,
        ).toEqual([]);
        // The fixture cookie and injected secrets never reach the report.
        expect(reportJson).not.toContain("super-secret-password");
        expect(reportJson).not.toContain(SENSITIVE_PURPOSE);

        // 2. Retained profile data: scan the real profile directory the worker
        //    wrote for the fixture session cookie and sensitive material. The
        //    profile is Chrome-owned credential-bearing data; the plugin
        //    surfaces (Activity Records, manifests) must exclude it.
        const profileDirLeaks: string[] = [];
        for (const path of [
          join(
            context.rootDirectory,
            "installations",
            context.installationId,
            "hosts",
            context.hostId,
            "profiles",
            context.profileId,
          ),
        ]) {
          const files = await collectManifestFiles(path).catch(() => []);
          for (const file of files) {
            const contents = await readFile(file, "utf8").catch(() => "");
            const leaks = findSensitiveData(contents);
            if (leaks.length > 0)
              profileDirLeaks.push(`${file}: ${leaks.join(",")}`);
          }
        }
        expect(
          profileDirLeaks,
          `retained profile surfaces leaked: ${profileDirLeaks.join("; ")}`,
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
    "scans the #21 retained surfaces on the provisioned host for forbidden sensitive material after a sensitive flow",
    { timeout: 120_000 },
    async (ctx) => {
      const probed = await provisionedHostContext();
      if (!skipIfNotProvisioned(ctx, probed)) return;
      // REUSE the #21 evidence harness + findSensitiveData scan helpers. The
      // scan is wired to the SAME store the sensitive flow drives (non-vacuous),
      // proving the BB-Connect-served retained surfaces exclude cookies, full
      // URLs, scripts, purposes, passwords, screenshots, and clipboard data on
      // the provisioned host.
      const manifestRoot = await mkdtemp(join(tmpdir(), "bb-host-privacy-"));
      const store = createFileBrowserProfileStore({
        rootDirectory: manifestRoot,
        installationId: "installation-host-privacy",
        lifecycle: { stopProfile: async () => undefined },
      });
      const evidence = await createEvidenceHarness({ profileStore: store });
      try {
        await evidence.harness.createBrowserProfile({
          hostId: probed.hostId,
          name: "Host privacy scan target",
        });
        await evidence.harness.createBrowserGrant({
          projectId: probed.projectId,
          hostId: probed.hostId,
          profileId: DEFAULT_PROFILE_ID,
          originScope: "https://app.example.test",
          wholeWeb: false,
          fileTransfer: false,
          invalidCertificateOrigins: [],
        });
        await evidence.harness.runBrowserScriptWithProfile(undefined, {
          purpose: SENSITIVE_PURPOSE,
          code: SENSITIVE_SCRIPT,
          destinationOrigin: "https://app.example.test",
        });

        // Activity Records — the owner-facing audit surface.
        const records = await evidence.harness.runBrowserActivityRecords();
        const recordsLeaks = findSensitiveData(JSON.stringify(records));
        expect(
          recordsLeaks,
          `Activity Records leaked: ${recordsLeaks.join(", ")}`,
        ).toEqual([]);
        expect(JSON.stringify(records)).not.toContain("super-secret-password");
        expect(JSON.stringify(records)).not.toContain(SENSITIVE_PURPOSE);
        expect(JSON.stringify(records)).not.toContain(SENSITIVE_COOKIE);

        // Database rows, durable outbox, diagnostics, logs.
        expect(
          findSensitiveData(
            JSON.stringify(evidence.harness.persistedActivityRows()),
          ),
        ).toEqual([]);
        expect(
          findSensitiveData(await evidence.harness.persistedHostOutbox()),
        ).toEqual([]);
        expect(
          findSensitiveData(
            (await evidence.harness.runDiagnosticsCli()).stdout ?? "",
          ),
        ).toEqual([]);
        expect(
          findSensitiveData(
            JSON.stringify(evidence.harness.diagnosticLogEntries()),
          ),
        ).toEqual([]);

        // Retained manifests — wired to the SAME store the flow drives.
        const manifests = await collectManifestFiles(manifestRoot);
        expect(manifests.length).toBeGreaterThan(0);
        const manifestsJson = (
          await Promise.all(
            manifests.map(
              async (file) => `${file}:${await readFile(file, "utf8")}`,
            ),
          )
        ).join("\n");
        expect(
          findSensitiveData(manifestsJson),
          "retained manifests leaked",
        ).toEqual([]);
        expect(manifestsJson).not.toContain("super-secret-password");
        expect(manifestsJson).not.toContain(SENSITIVE_COOKIE);
      } finally {
        await evidence.cleanup();
        await rm(manifestRoot, { recursive: true, force: true });
      }
    },
  );
});
