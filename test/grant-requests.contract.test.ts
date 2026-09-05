import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BROWSER_DATABASE_MIGRATIONS } from "../activity-records.js";
import { createProfileGrantStore } from "../authorization.js";
import {
  createGrantRequestStore,
  GRANT_REQUEST_MIGRATION,
} from "../grant-requests.js";
import {
  browserGrantRequestDecisionResponseSchema,
  browserGrantRequestSchema,
  browserTemporaryGrantSchema,
  type BrowserAuthorizationRequest,
} from "../contracts.js";

const NOW = new Date("2026-08-28T00:00:00.000Z");

type DecisionProcessMessage =
  | { type: "ready" }
  | { type: "entered" }
  | { type: "result"; outcome: string }
  | { type: "error"; message: string };

function spawnDecisionProcess(databasePath: string, requestId: string) {
  const child = fork(
    join(process.cwd(), "node_modules/vite-node/vite-node.mjs"),
    ["--script", "test/fixtures/grant-decision-process.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        R9_DECISION_DATABASE_PATH: databasePath,
        R9_DECISION_REQUEST_ID: requestId,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let ready!: () => void;
  let entered!: () => void;
  let complete!: (message: DecisionProcessMessage) => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resultPromise = new Promise<DecisionProcessMessage>((resolve) => {
    complete = resolve;
  });
  child.on("message", (message: DecisionProcessMessage) => {
    if (message.type === "ready") ready();
    if (message.type === "entered") entered();
    if (message.type === "result" || message.type === "error") {
      complete(message);
    }
  });
  return { child, readyPromise, enteredPromise, resultPromise };
}

function stopProcess(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

function createStore() {
  const backend = createFakePluginHost({ pluginId: "grant-request-contract" });
  const database = backend.bb.storage.database();
  backend.bb.storage.migrate(database, [...BROWSER_DATABASE_MIGRATIONS]);
  let now = NOW;
  let nextId = 0;
  const store = createProfileGrantStore(database, {
    clock: () => now,
    idFactory: () => `contract-${nextId++}`,
  });
  // These contracts exercise the Grant Request flow, which Default Access
  // bypasses until the owner revokes a project's whole-web grant. Withdraw it
  // for the bindings under test, with explicit ids so the counter above still
  // numbers requests and temporary grants the way the assertions expect.
  for (const projectId of ["project-a", "project-copy"]) {
    const wholeWeb = store.create({
      grantId: `grant-default-access-${projectId}`,
      projectId,
      hostId: "host-a",
      installationId: "installation-a",
      profileId: "profile-a",
      originScope: "*",
      wholeWeb: true,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    store.revoke(wholeWeb.grantId);
  }
  return {
    backend,
    store,
    advanceTo(next: Date) {
      now = next;
    },
  };
}

function authorization(
  overrides: Partial<BrowserAuthorizationRequest> = {},
): BrowserAuthorizationRequest {
  return {
    projectId: "project-a",
    hostId: "host-a",
    installationId: "installation-a",
    profileId: "profile-a",
    origin: "https://app.example.test",
    ...overrides,
  };
}

describe("Browser Grant Request store contract", () => {
  it("returns an exact pending request with a typed origin denial", async () => {
    const { backend, store } = createStore();

    try {
      const decision = store.authorize(
        authorization({
          fileTransfer: true,
          invalidCertificate: true,
        }),
      );

      expect(decision).toMatchObject({
        allowed: false,
        code: "origin_denied",
        grantRequest: {
          projectId: "project-a",
          hostId: "host-a",
          installationId: "installation-a",
          profileId: "profile-a",
          origin: "https://app.example.test",
          requestedElevations: {
            fileTransfer: true,
            invalidCertificate: true,
          },
          status: "pending",
          decision: null,
          expiresAt: "2026-08-28T00:15:00.000Z",
        },
      });
      expect(browserGrantRequestSchema.parse(decision.grantRequest)).toEqual(
        decision.grantRequest,
      );
      expect(store.listRequests()).toHaveLength(1);
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it.each([
    ["deny", "denied", null],
    ["retry", "approved", "retry"],
    ["one-hour", "approved", "one-hour"],
  ] as const)(
    "applies the owner %s decision without changing the requested authority",
    async (decision, status, mode) => {
      const { backend, store } = createStore();

      try {
        const denied = store.authorize(authorization({ fileTransfer: true }));
        const requestId = denied.grantRequest!.requestId;
        const response = store.decideRequest({
          requestId,
          decision,
        });

        expect(
          browserGrantRequestDecisionResponseSchema.parse(response),
        ).toEqual(response);
        expect(response.request).toMatchObject({
          requestId,
          status,
          decision,
          origin: "https://app.example.test",
          requestedElevations: {
            fileTransfer: true,
            invalidCertificate: false,
          },
        });
        if (mode === null) {
          expect(response.temporaryGrant).toBeNull();
          expect(response.grant).toBeNull();
        } else {
          expect(response.temporaryGrant).toMatchObject({
            requestId,
            mode,
            originScope: "https://app.example.test",
            fileTransfer: true,
            invalidCertificateOrigins: [],
          });
        }
      } finally {
        await backend.harness.lifecycle.dispose();
      }
    },
  );

  it("consumes one retry atomically and never resumes the denied operation", async () => {
    const { backend, store } = createStore();
    const secondStore = createProfileGrantStore(backend.bb.storage.database(), {
      clock: () => NOW,
      idFactory: () => "second-store",
    });

    try {
      const denied = store.authorize(authorization());
      const requestId = denied.grantRequest!.requestId;
      store.decideRequest({ requestId, decision: "retry" });

      const first = store.authorize(authorization());
      const second = secondStore.authorize(authorization());
      expect(first).toMatchObject({
        allowed: true,
        temporaryGrant: { mode: "retry" },
      });
      expect(second).toMatchObject({
        allowed: false,
        code: "origin_denied",
        grantRequest: { requestId: expect.not.stringMatching(requestId) },
      });
      expect(store.inspectRequest(requestId)).toMatchObject({
        status: "consumed",
        consumedAt: NOW.toISOString(),
      });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("does not consume a retry for a mismatched binding, origin, or elevation", async () => {
    const { backend, store } = createStore();

    try {
      const denied = store.authorize(authorization({ fileTransfer: true }));
      const requestId = denied.grantRequest!.requestId;
      store.decideRequest({ requestId, decision: "retry" });

      for (const mismatch of [
        { projectId: "project-copy" },
        { origin: "https://other.example.test" },
        { fileTransfer: false },
      ]) {
        expect(store.authorize(authorization(mismatch))).toMatchObject({
          allowed: false,
          code: "origin_denied",
        });
      }
      expect(store.inspectRequest(requestId)).toMatchObject({
        status: "approved",
        consumedAt: null,
      });
      expect(
        store.authorize(authorization({ fileTransfer: true })),
      ).toMatchObject({ allowed: true });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("expires pending requests and temporary grants at their exact clock boundaries", async () => {
    const { backend, store, advanceTo } = createStore();

    try {
      const pending = store.authorize(authorization());
      const pendingId = pending.grantRequest!.requestId;
      advanceTo(new Date("2026-08-28T00:15:00.000Z"));
      expect(store.inspectRequest(pendingId)).toMatchObject({
        status: "expired",
      });
      expect(
        store.decideRequest({ requestId: pendingId, decision: "retry" }),
      ).toMatchObject({
        outcome: "expired",
      });

      const next = store.authorize(authorization());
      const nextId = next.grantRequest!.requestId;
      store.decideRequest({ requestId: nextId, decision: "one-hour" });
      advanceTo(new Date("2026-08-28T01:15:00.000Z"));
      expect(store.authorize(authorization())).toMatchObject({
        allowed: false,
        code: "origin_denied",
      });
      expect(store.inspectRequest(nextId)).toMatchObject({ status: "expired" });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("expires a consumed retry grant and preserves that state after store restart", async () => {
    const { backend, store, advanceTo } = createStore();

    try {
      const denied = store.authorize(authorization());
      const requestId = denied.grantRequest!.requestId;
      store.decideRequest({ requestId, decision: "retry" });
      const consumed = store.authorize(authorization());
      if (!consumed.allowed || consumed.temporaryGrant === undefined) {
        throw new Error("expected retry authorization");
      }
      const temporaryGrantId = consumed.temporaryGrant.grantId;

      advanceTo(new Date("2026-08-28T00:05:00.000Z"));
      expect(store.inspectRequest(requestId)).toMatchObject({
        status: "expired",
        consumedAt: NOW.toISOString(),
        expiredAt: "2026-08-28T00:05:00.000Z",
      });
      expect(store.inspectTemporaryGrant(temporaryGrantId)).toBeNull();

      const restarted = createProfileGrantStore(backend.bb.storage.database(), {
        clock: () => new Date("2026-08-28T00:05:00.000Z"),
        idFactory: () => "restarted",
      });
      expect(restarted.inspectRequest(requestId)).toMatchObject({
        status: "expired",
        expiredAt: "2026-08-28T00:05:00.000Z",
      });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("revokes an active consumed retry grant during project lifecycle cleanup", async () => {
    const { backend, store } = createStore();

    try {
      const denied = store.authorize(authorization());
      const requestId = denied.grantRequest!.requestId;
      store.decideRequest({ requestId, decision: "retry" });
      const consumed = store.authorize(authorization());
      if (!consumed.allowed || consumed.temporaryGrant === undefined) {
        throw new Error("expected retry authorization");
      }
      const temporaryGrantId = consumed.temporaryGrant.grantId;

      expect(store.revokeProject("project-a")).toEqual([]);
      expect(store.inspectTemporaryGrant(temporaryGrantId)).toBeNull();
      expect(store.inspectRequest(requestId)).toMatchObject({
        status: "revoked",
        consumedAt: NOW.toISOString(),
        revokedAt: NOW.toISOString(),
      });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("rejects duplicate decisions, broadening, and replay after consumption", async () => {
    const { backend, store } = createStore();

    try {
      const denied = store.authorize(authorization());
      const requestId = denied.grantRequest!.requestId;
      const approved = store.decideRequest({ requestId, decision: "retry" });
      expect(
        store.decideRequest({ requestId, decision: "persist" }),
      ).toMatchObject({
        outcome: "already-decided",
      });
      expect(approved.temporaryGrant).not.toBeNull();
      expect(
        browserTemporaryGrantSchema.parse(approved.temporaryGrant),
      ).toEqual(approved.temporaryGrant);

      const broadeningAttempt = store.decideRequest({
        requestId,
        decision: "persist",
        origin: "https://other.example.test",
      } as never);
      expect(broadeningAttempt.outcome).toBe("already-decided");

      store.authorize(authorization());
      expect(store.authorize(authorization())).toMatchObject({
        allowed: false,
        code: "origin_denied",
      });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("allows one winner across overlapping independent decision processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "grant-decision-"));
    const databasePath = join(directory, "browser.sqlite");
    const database = new Database(databasePath);
    database.exec(GRANT_REQUEST_MIGRATION);
    const store = createGrantRequestStore(database, {
      clock: () => NOW,
      idFactory: () => "concurrent-request",
    });
    const denied = store.authorize(authorization(), "Explicit retry required.");
    if (denied.allowed || denied.grantRequest === null) {
      throw new Error("expected a pending Grant Request");
    }
    const requestId = denied.grantRequest.requestId;
    database.exec("BEGIN EXCLUSIVE");
    const first = spawnDecisionProcess(databasePath, requestId);
    const second = spawnDecisionProcess(databasePath, requestId);

    try {
      await Promise.all([first.readyPromise, second.readyPromise]);
      first.child.send("decide");
      second.child.send("decide");
      await Promise.all([first.enteredPromise, second.enteredPromise]);
      database.exec("COMMIT");

      const results = await Promise.all([
        first.resultPromise,
        second.resultPromise,
      ]);
      const errors = results.filter((result) => result.type === "error");
      expect(errors).toEqual([]);
      expect(
        results
          .filter((result) => result.type === "result")
          .map((result) => result.outcome)
          .sort(),
      ).toEqual(["already-decided", "retry-approved"]);
      expect(
        database
          .prepare(
            "SELECT event_type, COUNT(*) AS count FROM browser_grant_request_events WHERE request_id = ? GROUP BY event_type ORDER BY event_type",
          )
          .all(requestId),
      ).toEqual([
        { event_type: "approved", count: 1 },
        { event_type: "requested", count: 1 },
      ]);
    } finally {
      if (database.inTransaction) database.exec("ROLLBACK");
      stopProcess(first.child);
      stopProcess(second.child);
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires second confirmation for persistent elevated access and persists exact scope", async () => {
    const { backend, store } = createStore();

    try {
      const denied = store.authorize(
        authorization({ fileTransfer: true, invalidCertificate: true }),
      );
      const requestId = denied.grantRequest!.requestId;
      expect(() =>
        store.decideRequest({ requestId, decision: "persist" }),
      ).toThrow("second confirmation");

      const response = store.decideRequest({
        requestId,
        decision: "persist",
        persistenceConfirmation: "Persist Browser elevated access",
      });
      expect(response).toMatchObject({
        outcome: "persisted",
        request: { status: "approved", origin: "https://app.example.test" },
        grant: {
          originScope: "https://app.example.test",
          wholeWeb: false,
          fileTransfer: true,
          invalidCertificateOrigins: ["https://app.example.test"],
          persistentElevations: true,
        },
      });
      expect(
        store.authorize(
          authorization({ fileTransfer: true, invalidCertificate: true }),
        ),
      ).toMatchObject({ allowed: true });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });

  it("revokes approved temporary access and recovers its decision state after store restart", async () => {
    const { backend, store } = createStore();

    try {
      const denied = store.authorize(authorization());
      const requestId = denied.grantRequest!.requestId;
      store.decideRequest({ requestId, decision: "one-hour" });
      expect(store.revokeRequest(requestId)).toMatchObject({
        outcome: "revoked",
      });
      expect(store.authorize(authorization())).toMatchObject({
        allowed: false,
        code: "origin_denied",
      });

      const restarted = createProfileGrantStore(backend.bb.storage.database(), {
        clock: () => NOW,
        idFactory: () => "restarted",
      });
      expect(restarted.inspectRequest(requestId)).toMatchObject({
        status: "revoked",
        revokedAt: NOW.toISOString(),
      });
    } finally {
      await backend.harness.lifecycle.dispose();
    }
  });
});
