import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createCdpScreencastSource } from "../browser-screencast.js";
import { waitFor } from "./wait.js";

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
  /** Recorded method/params for every CDP command the source sends. */
  const commands: Array<{ method: string; params?: unknown }> = [];
  const server = new WebSocketServer({ port: 0 });
  const endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  let rejectNextEvaluate = false;
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        id?: number;
        method?: string;
        params?: unknown;
      };
      if (typeof message.id !== "number") return;
      if (message.method !== undefined)
        commands.push({ method: message.method, params: message.params });
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
      if (message.method === "Target.createTarget") {
        socket.send(
          JSON.stringify({
            id: message.id,
            result: { targetId: "created-target" },
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
      if (message.method === "Runtime.evaluate") {
        if (rejectNextEvaluate) {
          rejectNextEvaluate = false;
          socket.send(
            JSON.stringify({ id: message.id, error: { message: "clipboard" } }),
          );
          return;
        }
        // Return the page inspection object shape the source expects for
        // context actions so link/image actions are reported.
        socket.send(
          JSON.stringify({
            id: message.id,
            result: {
              result: {
                value: {
                  link: "https://example.test/link",
                  image: "https://example.test/image.png",
                },
              },
            },
          }),
        );
        return;
      }
      // ack, stopScreencast, input, setDownloadBehavior, navigate,
      // handleJavaScriptDialog: acknowledge so the source resolves.
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  return {
    endpoint,
    startScreencastCalls,
    commands,
    set rejectNextEvaluate(value: boolean) {
      rejectNextEvaluate = value;
    },
    /** Emit a Page.javascriptDialogOpening event to the attached session. */
    emitDialog(params: unknown) {
      for (const [client] of server.clients.entries()) {
        client.send(
          JSON.stringify({
            method: "Page.javascriptDialogOpening",
            params,
            sessionId: "session-1",
          }),
        );
      }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForStartScreencast(
  stub: Awaited<ReturnType<typeof createCdpEndpointStub>>,
  count = 1,
) {
  await waitFor(
    () => (stub.startScreencastCalls.length >= count ? true : undefined),
    { timeoutMs: 2_000, intervalMs: 5 },
  );
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

  it("enrolls a created target into the shared tab strip on open-link-new-tab", async () => {
    // SPEC-3: Target.createTarget spawns a target not normalized into the
    // shared ordered tab set. The source must report the created target so
    // the host enrolls it as a BrowserTab in the shared strip.
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const opened: { targetId: string; url: string }[] = [];
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
      onTargetCreated: (target) => {
        opened.push(target);
      },
    });
    try {
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      await source.resolveContextActions?.({ x: 0, y: 0 });
      source.performContextAction?.("open-link-new-tab");
      await waitFor(() =>
        opened.find(
          (entry) =>
            entry.targetId === "created-target" &&
            entry.url === "https://example.test/link",
        ),
      );
      // The created target is reported for shared-strip enrollment.
      expect(opened).toEqual([
        { targetId: "created-target", url: "https://example.test/link" },
      ]);
      expect(
        stub.commands.some(
          (command) => command.method === "Target.createTarget",
        ),
      ).toBe(true);
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });

  it("reports created-target enrollment failure instead of claiming success", async () => {
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const results: { actionId: string; ok: boolean }[] = [];
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
      onTargetCreated: async () => {
        throw new Error("retention close failed");
      },
      onContextActionResult: (result) => results.push(result),
    });
    try {
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      await source.resolveContextActions?.({ x: 0, y: 0 });
      source.performContextAction?.("open-link-new-tab");
      await waitFor(() =>
        results.find(
          (result) =>
            result.actionId === "open-link-new-tab" && result.ok === false,
        ),
      );
      expect(results).toContainEqual({
        actionId: "open-link-new-tab",
        ok: false,
      });
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });

  it("does not offer image saving without a Host Download staging path", async () => {
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
    });
    try {
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      const actions = await source.resolveContextActions?.({ x: 0, y: 0 });
      expect(actions?.map((action) => action.kind)).not.toContain("save-image");
      source.performContextAction?.("save-image");
      expect(
        stub.commands.some(
          (command) => command.method === "Page.setDownloadBehavior",
        ),
      ).toBe(false);
      // The broken download-transition navigate must never be sent.
      expect(
        stub.commands.some(
          (command) =>
            command.method === "Page.navigate" &&
            (command.params as { transition?: string } | undefined)
              ?.transition === "download",
        ),
      ).toBe(false);
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });

  it("maps a beforeunload dialog event and dismisses it by staying on the page", async () => {
    // SPEC-5: beforeunload is a real dialog type the source must surface and
    // dismiss with accept:false (stay) so the page is never silently left.
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const dialogs: { dialogId: string; type: string }[] = [];
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
    });
    try {
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      const unsubscribe = source.subscribeDialogs?.((event) => {
        dialogs.push({ dialogId: event.dialogId, type: event.type });
      });
      stub.emitDialog({
        type: "beforeunload",
        message: "Leave?",
        url: "https://example.test/page",
      });
      const beforeunload = await waitFor(() =>
        dialogs.find((dialog) => dialog.type === "beforeunload"),
      );
      expect(beforeunload.type).toBe("beforeunload");
      const dialogId = beforeunload.dialogId;
      expect(dialogId).toBeDefined();
      // Dismiss open dialogs with the fail-closed default (stay).
      source.dismissOpenDialogs?.();
      await waitFor(() =>
        stub.commands.some(
          (command) => command.method === "Page.handleJavaScriptDialog",
        ),
      );
      const handle = stub.commands.find(
        (command) => command.method === "Page.handleJavaScriptDialog",
      );
      expect(handle?.params).toMatchObject({ accept: false });
      unsubscribe?.();
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });

  it("surfaces clipboard copy failure honestly rather than silently no-op", async () => {
    // SPEC-2: clipboard actions may silently no-op when there is no transient
    // activation or clipboard permission. The source must surface the outcome
    // (resolved or rejected) honestly through the clipboard-result callback so
    // the panel can disclose the limitation rather than swallow it.
    const stub = createCdpEndpointStub();
    const controller = new AbortController();
    const results: { actionId: string; ok: boolean }[] = [];
    const source = createCdpScreencastSource({
      resolveEndpoint: async () => stub.endpoint,
      viewport: { width: 1280, height: 720 },
      onContextActionResult: (result) => results.push(result),
    });
    try {
      void source.start(() => undefined, controller.signal);
      await waitForStartScreencast(stub);
      await source.resolveContextActions?.({ x: 0, y: 0 });
      // Make the clipboard evaluate reject so the honest-failure path runs.
      stub.rejectNextEvaluate = true;
      source.performContextAction?.("copy-link");
      await waitFor(() =>
        results.some(
          (result) => result.actionId === "copy-link" && result.ok === false,
        ),
      );
      expect(results).toContainEqual({ actionId: "copy-link", ok: false });
    } finally {
      controller.abort();
      await source.stop();
      await stub.close();
    }
  });
});
