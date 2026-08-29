import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserActivityEvent } from "../contracts.js";
import { createActivityOutbox } from "../activity-outbox.js";

const NOW = new Date("2026-08-27T00:00:00.000Z");
const GRANT_METADATA = {
  grantId: "grant-outbox-test",
  grantScope: "https://app.example.test",
  grantElevations: {
    wholeWeb: false,
    fileTransfer: false,
    invalidCertificateOrigins: [],
    persistentElevations: false,
  },
} satisfies Pick<
  BrowserActivityEvent,
  "grantId" | "grantScope" | "grantElevations"
>;

function activityEvent(
  eventId: string,
  overrides: Partial<BrowserActivityEvent> = {},
): BrowserActivityEvent {
  return {
    eventId,
    actor: "agent",
    projectId: "project-outbox-test",
    hostId: "host-outbox-test",
    profileId: "profile-outbox-test",
    destinationOrigin: "https://app.example.test",
    occurredAt: NOW.toISOString(),
    kind: "agent-operation",
    action: "browser-script",
    outcome: "failed",
    interrupted: false,
    interruptionReason: null,
    durationMs: null,
    ...overrides,
  };
}

describe("Browser activity host outbox", () => {
  it("survives reconnect, retries due events, acknowledges them, and deduplicates", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-outbox-"));
    const filePath = join(rootDirectory, "activity-outbox.json");
    const event = activityEvent("outbox-event-1");
    const later = new Date(NOW.getTime() + 60 * 60 * 1_000);

    try {
      const initial = createActivityOutbox({
        filePath,
        clock: () => NOW,
      });
      await initial.enqueue(event);
      await initial.enqueue(event);

      const reconnected = createActivityOutbox({
        filePath,
        clock: () => later,
      });
      expect(await reconnected.pending()).toHaveLength(1);

      const firstAttempt = await reconnected.claim({ now: NOW, limit: 10 });
      expect(firstAttempt).toMatchObject([
        { eventId: event.eventId, attempts: 1 },
      ]);
      expect(await reconnected.claim({ now: NOW, limit: 10 })).toEqual([]);

      const retry = await reconnected.claim({ now: later, limit: 10 });
      expect(retry).toMatchObject([{ eventId: event.eventId, attempts: 2 }]);
      expect(await reconnected.acknowledge([event.eventId])).toEqual([
        event.eventId,
      ]);
      expect(await reconnected.pending()).toEqual([]);
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles acknowledged events and rejects conflicting duplicate metadata", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-outbox-"));
    const filePath = join(rootDirectory, "activity-outbox.json");
    const acknowledged = activityEvent("outbox-event-ack");
    const pending = activityEvent("outbox-event-pending");

    try {
      const outbox = createActivityOutbox({
        filePath,
        clock: () => NOW,
      });
      await outbox.enqueue(acknowledged);
      await outbox.enqueue(pending);

      await expect(
        outbox.enqueue(
          activityEvent(acknowledged.eventId, { outcome: "succeeded" }),
        ),
      ).rejects.toThrow("conflicting metadata");

      const recovered = await outbox.reconcile({
        acknowledgedEventIds: [acknowledged.eventId],
        limit: 10,
      });
      expect(recovered.map((item) => item.eventId)).toEqual([pending.eventId]);
      const serialized = await readFile(filePath, "utf8");
      expect(serialized).not.toMatch(
        /purpose-secret|script-secret|clipboard-secret|password|cookie/i,
      );
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["grantId", { grantId: "grant-outbox-other" }],
    ["grantScope", { grantScope: "https://other.example.test" }],
    [
      "grantElevations",
      {
        grantElevations: {
          ...GRANT_METADATA.grantElevations,
          fileTransfer: true,
        },
      },
    ],
    ["requestId", { requestId: "grant-request-outbox-other" }],
  ])(
    "R8-04 rejects a duplicate with conflicting %s while deduplicating identical grant metadata",
    async (_field, conflictingGrantMetadata) => {
      const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-outbox-"));
      const filePath = join(rootDirectory, "activity-outbox.json");
      const event = activityEvent("outbox-event-grant-metadata", {
        ...GRANT_METADATA,
        requestId: "grant-request-outbox",
      });

      try {
        const outbox = createActivityOutbox({
          filePath,
          clock: () => NOW,
        });
        await outbox.enqueue(event);
        await outbox.enqueue(
          activityEvent(event.eventId, {
            ...GRANT_METADATA,
            requestId: event.requestId,
          }),
        );
        expect(await outbox.pending()).toHaveLength(1);

        await expect(
          outbox.enqueue(
            activityEvent(event.eventId, {
              ...GRANT_METADATA,
              ...conflictingGrantMetadata,
            }),
          ),
        ).rejects.toThrow("conflicting metadata");
      } finally {
        await rm(rootDirectory, { recursive: true, force: true });
      }
    },
  );
});
