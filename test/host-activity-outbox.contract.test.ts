import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserActivityOutboxSchema,
  browserActivityAcknowledgementResponseSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../src/shared/contracts.js";
import { createBrowserHostEntry } from "../src/host/host.js";
import { createFileBrowserProfileStore } from "../src/host/profile-storage.js";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";

const HOST_ID = "host-activity-outbox";
const PROFILE_ID = DEFAULT_PROFILE_ID;

describe("Browser activity host/server outbox boundary", () => {
  it("persists agent metadata, claims it, reconciles reconnects, and acknowledges it", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-host-"));
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-activity-outbox",
    });
    await profileStore.initialize(HOST_ID);
    const setupStatus = setupRequiredStatus({
      hostId: HOST_ID,
      profileId: PROFILE_ID,
    });
    const readyStatus: BrowserStatus = {
      ...setupStatus,
      state: "healthy",
      code: "healthy",
      label: "Ready",
      message: "Workspace Browser is ready on this host.",
      capabilities: setupStatus.capabilities.map((capability) => ({
        ...capability,
        status: "ready",
      })),
    };
    const readiness = {
      inspect: () => readyStatus,
      diagnostics: () => {
        throw new Error("diagnostics not used by this contract");
      },
    };
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(readiness, profileStore),
      {
        experimental_paths: {
          dataDir: rootDirectory,
          tempDir: join(rootDirectory, "tmp"),
        },
      },
    );

    try {
      await expect(
        host.experimental_call("browserScript", {
          purpose:
            "Inspect password at https://app.example.test/login?purpose-secret",
          code: "return 'script-secret';",
          destinationOrigin: "https://app.example.test",
          hostId: HOST_ID,
          projectId: "project-activity-outbox",
          threadId: "thread-activity-outbox",
          activityEventId: "agent-host-event-1",
          activityOccurredAt: "2026-08-27T00:00:00.000Z",
          profileId: PROFILE_ID,
          timeoutMs: 30_000,
        }),
      ).resolves.toMatchObject({ ok: false });

      const claimed = browserActivityOutboxSchema.parse(
        await host.experimental_call("activityOutbox", {
          hostId: HOST_ID,
          limit: 10,
        }),
      );
      expect(claimed).toMatchObject([
        {
          eventId: "agent-host-event-1",
          actor: "agent",
          projectId: "project-activity-outbox",
          hostId: HOST_ID,
          profileId: PROFILE_ID,
          destinationOrigin: "https://app.example.test",
          kind: "agent-operation",
          action: "browser-script",
          outcome: "failed",
          attempts: 1,
        },
      ]);

      const reconciled = browserActivityOutboxSchema.parse(
        await host.experimental_call("reconcileActivity", {
          hostId: HOST_ID,
          acknowledgedEventIds: [],
          limit: 10,
        }),
      );
      expect(reconciled.map((item) => item.eventId)).toEqual([
        "agent-host-event-1",
      ]);

      const acknowledged = browserActivityAcknowledgementResponseSchema.parse(
        await host.experimental_call("acknowledgeActivity", {
          hostId: HOST_ID,
          eventIds: ["agent-host-event-1"],
        }),
      );
      expect(acknowledged.acknowledgedEventIds).toEqual(["agent-host-event-1"]);
      await expect(
        host.experimental_call("activityOutbox", {
          hostId: HOST_ID,
          limit: 10,
        }),
      ).resolves.toEqual([]);

      const serialized = await readFile(
        join(rootDirectory, "browser-activity-outbox.json"),
        "utf8",
      );
      expect(serialized).not.toMatch(
        /purpose-secret|script-secret|password|cookie|clipboard/i,
      );
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
