import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createCdpScreencastSource } from "../browser-screencast.js";

/**
 * A minimal CDP endpoint stub: it answers the target/attach/startScreencast
 * handshake the source drives and records the startScreencast parameters so the
 * contract can assert the controller viewport drives the capture size.
 */
function createCdpEndpointStub() {
  const startScreencastCalls: Array<{
    maxWidth?: number;
    maxHeight?: number;
  }> = [];
  const server = new WebSocketServer({ port: 0 });
  const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      if (typeof message.id !== "number") return;
      if (message.method === "Target.getTargets") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              targetInfos: [{ type: "page", targetId: "page-target-1" }],
            },
          }),
        );
        return;
      }
      if (message.method === "Target.attachToTarget") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { sessionId: "session-1" },
          }),
        );
        return;
      }
      if (message.method === "Page.startScreencast") {
        const params = message.params as {
          maxWidth?: number;
          maxHeight?: number;
        };
        startScreencastCalls.push({ ...params });
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        return;
      }
      // ack, stopScreencast, input: acknowledge so the source resolves.
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  return {
    endpoint,
    startScreencastCalls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForStartScreencast(
  stub: Awaited<ReturnType<typeof createCdpEndpointStub>>,
  count = 1,
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (stub.startScreencastCalls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Page.startScreencast was not issued in time.");
}

describe("CDP screencast source contract", () => {
  it("applies the controller viewport to the screencast capture rather than the maximum", async () => {
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
    });
    try {
      // Drive the source in the background; it stays open until aborted.
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      expect(stub.startScreencastCalls[0]).toMatchObject({
        maxWidth: 1280,
        maxHeight: 720,
      });
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });

  it("updates the capture size when the controller viewport changes", async () => {
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
    });
    try {
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      expect(stub.startScreencastCalls[0]).toMatchObject({
        maxWidth: 1280,
        maxHeight: 720,
      });
      // The controller drives layout; a viewport change restarts the capture at
      // the new dimensions so spectators letterbox the exact controller viewport.
      source.setViewport?.({ width: 1600, height: 900 });
      await waitForStartScreencast(stub, 2);
      expect(
        stub.startScreencastCalls.some(
          (call) => call.maxWidth === 1600 && call.maxHeight === 900,
        ),
      ).toBe(true);
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });
});
