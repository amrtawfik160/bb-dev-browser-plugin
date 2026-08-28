import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  createProfileGrantStore,
  projectLoopbackAlias,
} from "../authorization.js";
import { BROWSER_DATABASE_MIGRATIONS } from "../activity-records.js";
import {
  browserProfileGrantCreateRequestSchema,
  browserOriginScopeSchema,
  normalizeBrowserOrigin,
  type BrowserProfileGrant,
} from "../contracts.js";

const NOW = new Date("2026-08-28T00:00:00.000Z");

function createStore() {
  const backend = createFakePluginHost({ pluginId: "authorization-contract" });
  const database = backend.bb.storage.database();
  backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
  return {
    backend,
    store: createProfileGrantStore(database, () => NOW),
  };
}

function grant(
  overrides: Partial<BrowserProfileGrant> = {},
): BrowserProfileGrant {
  return {
    grantId: "grant-contract",
    projectId: "project-a",
    hostId: "host-a",
    installationId: "installation-a",
    profileId: "profile-a",
    originScope: "https://app.example.test",
    wholeWeb: false,
    fileTransfer: false,
    invalidCertificateOrigins: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe("Browser Profile Grant public authorization contract", () => {
  it.each([
    ["HTTPS://APP.Example.test:443/", "https://app.example.test"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
    ["http://[0:0:0:0:0:0:0:1]:3000", "http://[::1]:3000"],
  ])("normalizes exact origin %s to %s", (candidate, expected) => {
    expect(normalizeBrowserOrigin(candidate)).toBe(expected);
  });

  it.each([
    "http://localhost:3000/",
    "https://APP.Example.test:443/",
    "http://[0:0:0:0:0:0:0:1]:3000/",
  ])("normalizes an origin idempotently: %s", (candidate) => {
    const normalized = normalizeBrowserOrigin(candidate);
    expect(normalizeBrowserOrigin(normalized)).toBe(normalized);
  });

  it.each([
    "https://app.example.test/login",
    "https://app.example.test/./",
    "https://app.example.test/..",
    "https://app.example.test//",
    "https://app.example.test?token=secret",
    "https://user:password@app.example.test",
    "file:///tmp/browser",
  ])("rejects unenforceable or non-web origin %s", (candidate) => {
    expect(() => normalizeBrowserOrigin(candidate)).toThrow();
  });

  it("normalizes an explicit subdomain scope and rejects path restrictions", () => {
    expect(browserOriginScopeSchema.parse("HTTPS://*.Example.test:443")).toBe(
      "https://*.example.test",
    );
    expect(browserOriginScopeSchema.parse("https://*.example.test/")).toBe(
      "https://*.example.test",
    );
    expect(() =>
      browserOriginScopeSchema.parse("https://*.example.test/app"),
    ).toThrow();
    expect(() =>
      browserOriginScopeSchema.parse("https://*.example.test/.."),
    ).toThrow();
    expect(() =>
      browserOriginScopeSchema.parse("https://*.127.0.0.1"),
    ).toThrow();
  });

  it("keeps Project Loopback Aliases separate from raw localhost and other projects", () => {
    const projectAlias = projectLoopbackAlias("project-a", 3000);
    const otherAlias = projectLoopbackAlias("project-b", 3000);

    expect(projectAlias).toBe("http://p-0e3ffbf31db2.localhost:3000");
    expect(projectAlias).not.toBe(otherAlias);
    expect(projectAlias).not.toBe("http://localhost:3000");
    expect(browserOriginScopeSchema.parse(projectAlias)).toBe(projectAlias);
  });

  it("denies an agent by default and only allows the exact project/profile/install binding", async () => {
    const { backend, store } = createStore();

    try {
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://app.example.test",
        }),
      ).toMatchObject({ allowed: false, code: "origin_denied" });

      store.create(grant());

      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://app.example.test/",
        }),
      ).toMatchObject({ allowed: true });
      expect(
        store.authorize({
          projectId: "project-copy",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://app.example.test",
        }),
      ).toMatchObject({ allowed: false, code: "origin_denied" });
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-other",
          profileId: "profile-a",
          origin: "https://app.example.test",
        }),
      ).toMatchObject({ allowed: false, code: "origin_denied" });
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-other",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://app.example.test",
        }),
      ).toMatchObject({ allowed: false, code: "origin_denied" });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("keeps raw localhost outside whole-web grants until explicitly approved", async () => {
    const { backend, store } = createStore();

    try {
      store.create(
        grant({
          grantId: "grant-whole-web",
          originScope: "*",
          wholeWeb: true,
        }),
      );
      for (const origin of [
        "http://localhost:3000",
        "http://localhost.:3000",
        "http://127.0.0.2:3000",
        "http://[::1]:3000",
        "http://0.0.0.0:3000",
        "http://[::]:3000",
      ]) {
        expect(
          store.authorize({
            projectId: "project-a",
            hostId: "host-a",
            installationId: "installation-a",
            profileId: "profile-a",
            origin,
          }),
        ).toMatchObject({ allowed: false, code: "origin_denied" });
      }

      store.create(
        grant({
          grantId: "grant-localhost",
          originScope: "http://localhost:3000",
        }),
      );
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "http://localhost:3000/",
        }),
      ).toMatchObject({ allowed: true });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("requires file transfer and invalid certificates to be explicitly scoped", async () => {
    const { backend, store } = createStore();

    try {
      expect(() =>
        store.create(
          grant({
            grantId: "grant-invalid-scope",
            invalidCertificateOrigins: ["https://outside.example.test"],
          }),
        ),
      ).toThrow("within the grant scope");

      store.create(
        grant({
          grantId: "grant-elevated",
          originScope: "https://*.example.test",
          fileTransfer: true,
          invalidCertificateOrigins: ["https://secure.example.test"],
        }),
      );
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://secure.example.test",
          fileTransfer: true,
          invalidCertificate: true,
        }),
      ).toMatchObject({ allowed: true });
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://other.example.test",
          invalidCertificate: true,
        }),
      ).toMatchObject({ allowed: false, code: "origin_denied" });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("revokes a grant immediately without changing the owner-facing record", async () => {
    const { backend, store } = createStore();

    try {
      const created = store.create(grant());
      expect(store.revoke(created.grantId)).toMatchObject({
        grantId: created.grantId,
        outcome: "revoked",
      });
      expect(store.list({ projectId: "project-a" })).toEqual([]);
      expect(
        store.authorize({
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://app.example.test",
        }),
      ).toMatchObject({ allowed: false, code: "origin_denied" });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("revokes only the host-installation profile binding during profile lifecycle cleanup", async () => {
    const { backend, store } = createStore();

    try {
      store.create(grant({ grantId: "grant-profile-a" }));
      store.create(
        grant({
          grantId: "grant-profile-b",
          profileId: "profile-b",
          originScope: "https://profile-b.example.test",
        }),
      );

      expect(
        store.revokeProfile({
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
        }),
      ).toHaveLength(1);
      expect(store.list({ profileId: "profile-a" })).toEqual([]);
      expect(store.list({ profileId: "profile-b" })).toHaveLength(1);
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("rejects inconsistent whole-web grant contracts at the public schema", () => {
    expect(() =>
      browserProfileGrantCreateRequestSchema.parse({
        projectId: "project-a",
        hostId: "host-a",
        profileId: "profile-a",
        originScope: "*",
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      }),
    ).toThrow();
    expect(() =>
      browserProfileGrantCreateRequestSchema.parse({
        projectId: "project-a",
        hostId: "host-a",
        profileId: "profile-a",
        originScope: "https://app.example.test",
        wholeWeb: true,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      }),
    ).toThrow();
  });

  it("serializes concurrent grant edits and keeps every committed grant inspectable", async () => {
    const { backend, store } = createStore();

    try {
      const grants = await Promise.all(
        [3000, 3001, 3002].map((port) =>
          Promise.resolve(
            store.create(
              grant({
                grantId: `grant-${port}`,
                originScope: `http://127.0.0.1:${port}`,
              }),
            ),
          ),
        ),
      );

      expect(grants).toHaveLength(3);
      expect(store.list({ projectId: "project-a" })).toHaveLength(3);
      const outcomes = await Promise.all(
        grants.map((created) => Promise.resolve(store.revoke(created.grantId))),
      );
      expect(outcomes.map(({ outcome }) => outcome)).toEqual([
        "revoked",
        "revoked",
        "revoked",
      ]);
      const raceGrant = store.create(
        grant({
          grantId: "grant-race",
          originScope: "http://127.0.0.1:3003",
        }),
      );
      const raceOutcomes = await Promise.all(
        [0, 1].map(() =>
          Promise.resolve().then(() => store.revoke(raceGrant.grantId)),
        ),
      );
      expect(raceOutcomes.map(({ outcome }) => outcome)).toEqual([
        "revoked",
        "already-revoked",
      ]);
      expect(store.list({ projectId: "project-a" })).toEqual([]);
      expect(store.inspect(grants[0]!.grantId)).toMatchObject({
        revokedAt: NOW.toISOString(),
      });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("appends the grant migration without rewriting predecessor activity records", async () => {
    const backend = createFakePluginHost({
      pluginId: "authorization-migration",
    });
    const database = backend.bb.storage.database();

    try {
      backend.bb.storage.migrate(database, [
        ...BROWSER_DATABASE_MIGRATIONS.slice(0, 6),
      ]);
      database
        .prepare(
          `INSERT INTO browser_activity_records
             (occurred_at, actor, host_id, profile_id, kind, action, outcome, interrupted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          NOW.toISOString(),
          "owner",
          "host-a",
          "profile-a",
          "lifecycle",
          "setup",
          "completed",
          0,
        );

      backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);

      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_profile_grants'",
          )
          .get(),
      ).toEqual({ name: "browser_profile_grants" });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM browser_activity_records")
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });
});
