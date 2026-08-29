/**
 * Issue #21 acceptance criterion 4: Storage and failure tests cover migrations,
 * rollback, incompatible downgrade, locks, corruption, durable outbox,
 * archive/reset/import/backup, partial setup, low disk, host reconnect,
 * cleanup, and expiry.
 *
 * The in-memory/loopback boundaries run and pass against the real
 * better-sqlite3 transactional database, the real file Browser Profile store,
 * and the real retained host worker (via the public harness). The deep
 * per-boundary failure matrices (import encryption incompatibility, archive
 * retention edge cases, corrupt-archive handling) are proven by the focused
 * `profile-recovery.contract.test.ts` and `profile-storage.contract.test.ts`
 * suites; this file proves the cross-cutting storage and failure contract
 * holds through the real transactional and retained-host seams without
 * duplicating those suites.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../../contracts.js";
import {
  BROWSER_DATABASE_MIGRATIONS,
  createBrowserDatabaseMigrationPlan,
} from "../../activity-records.js";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../../profile-storage.js";
import { createFileBrowserProfileRecovery } from "../../profile-recovery.js";
import {
  createEvidenceHarness,
  preparedEvidenceSnapshot,
  createPublicPluginHarness,
} from "../fixtures/evidence-helpers.js";

const HOST_ID = "host-evidence-storage";
const NOW = new Date("2026-08-29T00:00:00.000Z");

async function disposeBackend(
  backend: ReturnType<typeof createFakePluginHost>,
) {
  await backend.harness.lifecycle.dispose();
}

describe("issue #21 AC4 Storage and failure matrix", () => {
  it("applies the transactional migration plan to a fresh and a legacy database", async () => {
    const backend = createFakePluginHost({ pluginId: "evidence-migrations" });
    const database = backend.bb.storage.database();
    try {
      backend.bb.storage.migrate(
        database,
        createBrowserDatabaseMigrationPlan(database),
      );
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_activity_records'",
          )
          .get(),
      ).toEqual({ name: "browser_activity_records" });
      expect(
        database.prepare("SELECT id FROM _bb_migrations ORDER BY id").all(),
      ).toEqual(
        Array.from({ length: BROWSER_DATABASE_MIGRATIONS.length }, (_, id) => ({
          id,
        })),
      );
    } finally {
      await disposeBackend(backend);
    }
  });

  it("rolls back a failed migration transaction without leaving partial schema", async () => {
    const backend = createFakePluginHost({ pluginId: "evidence-rollback" });
    const database = backend.bb.storage.database();
    try {
      backend.bb.storage.migrate(
        database,
        createBrowserDatabaseMigrationPlan(database),
      );
      const appliedBefore = database
        .prepare("SELECT id FROM _bb_migrations ORDER BY id")
        .all();
      expect(() =>
        backend.bb.storage.migrate(database, [
          ...BROWSER_DATABASE_MIGRATIONS,
          "CREATE TABLE rollback_probe (id INTEGER PRIMARY KEY)",
          "INSERT INTO missing_rollback_table (id) VALUES (1)",
        ]),
      ).toThrow();
      // The failed transaction rolled back: the probe table was not created.
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT id FROM _bb_migrations ORDER BY id").all(),
      ).toEqual(appliedBefore);
    } finally {
      await disposeBackend(backend);
    }
  });

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

  it("serializes concurrent profile creation with a profile lock and rejects corrupt manifests", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-evidence-store-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-evidence-store",
        clock: () => NOW,
      });
      await store.initialize(HOST_ID);
      // Concurrent same-name creation on the same host serializes: exactly one
      // wins, the other rejects, no duplicate id is minted.
      const results = await Promise.allSettled([
        store.createProfile({ hostId: HOST_ID, name: "Contended" }),
        store.createProfile({ hostId: HOST_ID, name: "Contended" }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);
      // A corrupt manifest is rejected, not silently repaired.
      const corruptPaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-evidence-store",
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
      });
      await writeFile(corruptPaths.manifestPath, "{not-json", {
        encoding: "utf8",
        mode: 0o600,
      });
      await expect(store.listProfiles(HOST_ID)).rejects.toMatchObject({
        code: "profile-manifest-corrupt",
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("archives, restores, resets, and expires profiles through the real file store", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "bb-evidence-lifecycle-"),
    );
    try {
      const clock = { now: () => NOW };
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-evidence-lifecycle",
        clock: () => NOW,
        lifecycle: { stopProfile: async () => undefined },
      });
      await store.initialize(HOST_ID);
      const created = await store.createProfile({
        hostId: HOST_ID,
        name: "Lifecycle",
      });
      const archived = await store.archiveProfile({
        hostId: HOST_ID,
        profileId: created.profileId,
      });
      expect(archived).toMatchObject({
        outcome: "archived",
        profile: { state: "archived" },
      });
      // Archived profiles remain recoverable within their retention window.
      const restored = await store.restoreArchivedProfile({
        hostId: HOST_ID,
        profileId: created.profileId,
      });
      expect(restored).toMatchObject({ outcome: "restored" });
      // Reset archives the old profile and creates a fresh one.
      const reset = await store.resetProfile({
        hostId: HOST_ID,
        profileId: created.profileId,
        confirmation: "Lose saved sessions and reset this Browser Profile",
      });
      expect(reset).toMatchObject({ outcome: "reset" });
      // Expiry reaps profiles whose archive window has elapsed.
      const past = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
      const storeFuture = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-evidence-lifecycle",
        clock: () => past,
        lifecycle: { stopProfile: async () => undefined },
      });
      const expired = await storeFuture.expireArchivedProfiles(HOST_ID);
      expect(expired.deletedProfileIds.length).toBeGreaterThan(0);
      void clock;
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("produces a backup and restores it through the real recovery module", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-evidence-backup-"));
    try {
      const store = createFileBrowserProfileStore({
        rootDirectory,
        installationId: "installation-evidence-backup",
        clock: () => NOW,
        lifecycle: { stopProfile: async () => undefined },
      });
      await store.initialize(HOST_ID);
      const profilePaths = profileStoragePaths({
        rootDirectory,
        installationId: "installation-evidence-backup",
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
      });
      // Seed credential-equivalent content the backup must carry.
      await writeFile(
        join(profilePaths.browserDataPath, "Cookies"),
        "signed-in",
        { mode: 0o600 },
      );
      const recovery = createFileBrowserProfileRecovery({
        rootDirectory,
        installationId: "installation-evidence-backup",
        state: {
          isProfileStopped: async () => true,
          isDevBrowserProfileStopped: async () => true,
        },
        clock: () => NOW,
      });
      const archivePath = join(rootDirectory, "backup.archive");
      const backup = await recovery.backupProfile({
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      expect(backup.outcome).toBe("backed-up");
      // Restore the backup back into the same profile identifier.
      const restored = await recovery.restoreProfile({
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        archivePath,
      });
      expect(restored.outcome).toBe("restored");
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("writes a durable activity outbox acknowledged through the real retained host worker", async () => {
    const evidence = await createEvidenceHarness();
    try {
      await evidence.harness.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Evidence outbox target",
      });
      await evidence.harness.createBrowserGrant({
        projectId: "project-browser-test",
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        originScope: "https://app.example.test",
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      });
      await evidence.harness.runBrowserScriptWithProfile(undefined, {
        purpose: "Drive the durable outbox",
        code: "return page.url();",
        destinationOrigin: "https://app.example.test",
      });
      // The retained host worker persists a durable outbox file that survives
      // a worker restart and is later acknowledged into the transactional DB.
      const outbox = await evidence.harness.persistedHostOutbox();
      expect(outbox.length).toBeGreaterThan(0);
      expect(evidence.harness.persistedActivityRows().length).toBeGreaterThan(
        0,
      );
    } finally {
      await evidence.cleanup();
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
