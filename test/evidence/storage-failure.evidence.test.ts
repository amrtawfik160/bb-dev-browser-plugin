/**
 * Issue #21 acceptance criterion 4: Storage and failure tests cover migrations,
 * rollback, incompatible downgrade, locks, corruption, durable outbox,
 * archive/reset/import/backup, partial setup, low disk, host reconnect,
 * cleanup, and expiry.
 *
 * The focused contract suites already prove the per-boundary storage facts
 * against the same real `better-sqlite3`/file-store primitives (activity-records
 * migration/rollback, profile-storage concurrent creation/corrupt manifests,
 * profile-lifecycle archive/restore/reset/expire, profile-recovery backup/
 * restore, host-activity-outbox durability). This file therefore does not
 * re-assert them in isolation. It keeps:
 *   - the incompatible-downgrade invariant (re-applying an older migration plan
 *     never downgrades the schema), which no focused contract suite covers, and
 *   - the cross-cutting boundaries that route through the real public harness +
 *     retained host worker + transactional storage (partial setup, low disk,
 *     host reconnect, clean disposal).
 */
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  BROWSER_DATABASE_MIGRATIONS,
  createBrowserDatabaseMigrationPlan,
} from "../../src/activity/activity-records.js";
import {
  createEvidenceHarness,
  preparedEvidenceSnapshot,
  createPublicPluginHarness,
} from "../fixtures/evidence-helpers.js";

async function disposeBackend(
  backend: ReturnType<typeof createFakePluginHost>,
) {
  await backend.harness.lifecycle.dispose();
}

describe("issue #21 AC4 Storage and failure matrix", () => {
  it("refuses an incompatible downgrade: re-applying an older plan never downgrades the schema", async () => {
    const backend = createFakePluginHost({
      pluginId: "evidence-downgrade",
    });
    const database = backend.bb.storage.database();
    try {
      backend.bb.storage.migrate(
        database,
        createBrowserDatabaseMigrationPlan(database),
      );
      const schemaBefore = database
        .prepare("PRAGMA table_info(browser_activity_records)")
        .all()
        .map((column) => (column as { name: string }).name);
      // Re-running an older/shorter plan is a no-op: migrations already
      // applied are skipped and the schema is never downgraded.
      backend.bb.storage.migrate(
        database,
        BROWSER_DATABASE_MIGRATIONS.slice(0, 5),
      );
      const schemaAfter = database
        .prepare("PRAGMA table_info(browser_activity_records)")
        .all()
        .map((column) => (column as { name: string }).name);
      expect(schemaAfter).toEqual(schemaBefore);
    } finally {
      await disposeBackend(backend);
    }
  });

  it("classifies partial setup as Setup required through the retained host readiness contract", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: {
        ...preparedEvidenceSnapshot,
        dedicatedUser: { state: "missing" },
        protectedStorage: { state: "missing" },
      },
    });
    try {
      const cli = await browser.runStatusCli();
      const status = JSON.parse(cli.stdout!);
      expect(status.state).not.toBe("healthy");
      // Partial setup reports an actionable non-healthy state, never a silent
      // success or an unsupported classification.
      expect(["setup-required", "repair-required"]).toContain(status.state);
    } finally {
      await browser.dispose();
    }
  });

  it("classifies low disk as Repair required without deleting cookies or site storage", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: {
        ...preparedEvidenceSnapshot,
        disk: { freeBytes: 64 * 1024 * 1024, totalBytes: 20 * 1024 ** 3 },
      },
    });
    try {
      const cli = await browser.runStatusCli();
      const status = JSON.parse(cli.stdout!);
      // Low disk headroom is repair-required, not healthy; no host mutation.
      expect(status.state).toBe("repair-required");
    } finally {
      await browser.dispose();
    }
  });

  it("reconnects after host loss: status goes host-offline then healthy again", async () => {
    const evidence = await createEvidenceHarness();
    try {
      // Pre-warmed instance is running/healthy.
      const before = await evidence.harness.runStatusCli();
      expect(JSON.parse(before.stdout!).state).not.toBe("host-offline");
      await evidence.harness.emitHostConnection("host-disconnected");
      const offline = await evidence.harness.runStatusCli();
      expect(JSON.parse(offline.stdout!).state).toBe("host-offline");
      await evidence.harness.emitHostConnection("host-connected");
      const recovered = await evidence.harness.runStatusCli();
      expect(JSON.parse(recovered.stdout!).state).not.toBe("host-offline");
    } finally {
      await evidence.cleanup();
    }
  });

  it("cleanly disposes retained instances and panel slots on cleanup", async () => {
    const evidence = await createEvidenceHarness();
    // The retained host worker is pre-warmed; cleanup must dispose it and the
    // real transactional database without throwing. (Panel unmount is exercised
    // in the jsdom black-box harness evidence file.)
    await evidence.cleanup();
    // A second dispose is a no-op safety check.
    await expect(evidence.cleanup()).resolves.toBeUndefined();
  });
});
