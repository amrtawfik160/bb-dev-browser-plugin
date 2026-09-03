import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_PROFILE_ID, setupRequiredStatus } from "../contracts.js";
import { createBrowserHostEntry } from "../host.js";
import type { ScreencastSource } from "../panel-transport.js";

const HOST_ID = "host-panel-session";

function healthyStatus() {
  const unavailable = setupRequiredStatus({
    hostId: HOST_ID,
    profileId: DEFAULT_PROFILE_ID,
  });
  return {
    ...unavailable,
    state: "healthy" as const,
    code: "healthy" as const,
    label: "Ready" as const,
    message: "Workspace Browser is ready on this host.",
    capabilities: unavailable.capabilities.map((capability) => ({
      ...capability,
      status: "ready" as const,
    })),
  };
}

function idleFrameSource(): ScreencastSource {
  return {
    async start(_onFrame, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    input() {},
    async stop() {},
  };
}

describe("host-owned Panel session", () => {
  it("closes loopback listeners on worker shutdown without moving Browser Profile state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "host-panel-session-"));
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { frameSource: () => idleFrameSource() },
      ),
      {
        experimental_paths: {
          dataDir,
          tempDir: join(dataDir, "tmp"),
        },
      },
    );
    try {
      const opened = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-session-shutdown",
        ownerSessionId: "owner-session-session",
      });
      expect(opened).toMatchObject({ outcome: "opened" });
      if (opened.outcome !== "opened") return;
      expect(opened.bindHost).toBe("127.0.0.1");
      const port = opened.gatewayPort;
      await host.experimental_dispose();
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.once("open", () => {
          socket.close();
          reject(new Error("disposed host still accepted a Panel connection"));
        });
        socket.once("error", () => resolve());
      });
    } finally {
      await host.experimental_dispose().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
