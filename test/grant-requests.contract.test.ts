import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { BROWSER_DATABASE_MIGRATIONS } from "../activity-records.js";
import { createProfileGrantStore } from "../authorization.js";
import {
  browserGrantRequestDecisionResponseSchema,
  browserGrantRequestSchema,
  browserTemporaryGrantSchema,
  type BrowserAuthorizationRequest,
} from "../contracts.js";

const NOW = new Date("2026-08-28T00:00:00.000Z");

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

      const [first, second] = await Promise.all([
        Promise.resolve().then(() => store.authorize(authorization())),
        Promise.resolve().then(() => secondStore.authorize(authorization())),
      ]);
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
