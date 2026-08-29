import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_MIN_FRAMES_PER_SECOND,
  PANEL_RECLAIM_WINDOW_MS,
  PANEL_RECONNECT_INITIAL_BACKOFF_MS,
} from "../contracts.js";
import { createPanelCapabilityStore } from "../panel-capability.js";
import { createPanelGateway } from "../panel-gateway.js";
import { createClipboardExchange } from "../clipboard-exchange.js";
import {
  createAutomationStreamAdapter,
  frameIntervalMs,
} from "../panel-stream.js";
import {
  createPanelTransportServer,
  type ScreencastFrame,
  type ScreencastSource,
} from "../panel-transport.js";
import { waitFor } from "./wait.js";

const hostId = "host-transport";
const profileId = "profile-transport";
const ownerSessionId = "owner-session-transport";
const panelId = "panel-transport";

function redeemMessage(capability: { capabilityId: string; secret: string }) {
  return {
    type: "redeem" as const,
    capabilityId: capability.capabilityId,
    secret: capability.secret,
    ownerSessionId,
    panelId,
  };
}

function decode<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

/**
 * A deterministic screencast source the transport drives. It emits a bounded
 * burst of frames at the adapter's current frame interval, records every
 * forwarded input payload, and stops when the abort signal fires.
 */
function createFakeScreencastSource(options: {
  frameCount: number;
}): ScreencastSource & {
  inputs: unknown[];
  frames: ScreencastFrame[];
  started: boolean;
} {
  const inputs: unknown[] = [];
  const frames: ScreencastFrame[] = [];
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  return {
    inputs,
    frames,
    started: false,
    async start(onFrame, signal) {
      this.started = true;
      await new Promise<void>((resolve) => {
        let sequence = 1;
        let emitted = 0;
        const tick = () => {
          if (stopped || signal.aborted) {
            if (interval !== undefined) clearInterval(interval);
            resolve();
            return;
          }
          if (emitted >= options.frameCount) {
            if (interval !== undefined) clearInterval(interval);
            // Keep the stream open until stopped so input can still flow.
            return;
          }
          emitted += 1;
          const data = Buffer.from(`frame-${sequence}`);
          const frame: ScreencastFrame = {
            sequence,
            mimeType: "image/png",
            data,
          };
          frames.push(frame);
          onFrame(frame);
          sequence += 1;
        };
        interval = setInterval(tick, 1);
        signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            if (interval !== undefined) clearInterval(interval);
            resolve();
          },
          { once: true },
        );
      });
    },
    input(payload) {
      inputs.push(payload);
    },
    async stop() {
      stopped = true;
      if (interval !== undefined) clearInterval(interval);
    },
  };
}

async function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function send(socket: WebSocket, message: unknown) {
  socket.send(JSON.stringify(message));
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    const handler = (raw: string) => {
      socket.off("message", handler);
      resolve(raw.toString());
    };
    socket.on("message", handler);
  });
}

/**
 * Collect every streamed message so a fast burst (frames at ~1 ms intervals) is
 * not lost between awaits. onceMessage attaches its handler too late if a
 * message already arrived, so it can miss the first frame; collectMessages
 * buffers from the start and polls a predicate via the shared waitFor helper
 * (issue #23 S2).
 */
function collectMessages(socket: WebSocket) {
  const messages: string[] = [];
  socket.on("message", (raw) => {
    messages.push(raw.toString());
  });
  return {
    waitFor: (predicate: (raw: string) => boolean, timeoutMs = 2_000) =>
      waitFor(() => messages.find(predicate), { timeoutMs }),
  };
}

describe("Panel transport server contract", () => {
  it("binds a real loopback gateway port and redeems the capability in the first message", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    const source = createFakeScreencastSource({ frameCount: 1 });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
    });
    const port = await transport.start();
    try {
      expect(port).toBeGreaterThan(0);
      const socket = await connect(port);
      const issued = capabilities.issue({
        ownerSessionId,
        panelId,
        hostId,
        profileId,
      });
      send(socket, {
        type: "redeem",
        capabilityId: issued.capabilityId,
        secret: issued.secret,
        ownerSessionId,
        panelId,
      });
      const ready = decode<{ type: string }>(await onceMessage(socket));
      expect(ready.type).toBe("ready");
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("rejects a connection that does not redeem a valid capability first", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    const source = createFakeScreencastSource({ frameCount: 0 });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
    });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      send(socket, { type: "ping" });
      const message = await onceMessage(socket);
      const error = decode<{ type: string; reason: string }>(message);
      expect(error.type).toBe("error");
      expect(error.reason).toBe("unauthorized");
      await new Promise<void>((resolve) => socket.once("close", resolve));
    } finally {
      await transport.stop();
    }
  });

  it("delivers frames over the WebSocket and forwards input to the screencast source", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    stream.start();
    stream.setViewport({
      width: PANEL_MAX_VIEWPORT_WIDTH,
      height: PANEL_MAX_VIEWPORT_HEIGHT,
    });
    expect(stream.viewport).toEqual({
      width: PANEL_MAX_VIEWPORT_WIDTH,
      height: PANEL_MAX_VIEWPORT_HEIGHT,
    });
    expect(stream.fps).toBeLessThanOrEqual(PANEL_MAX_FRAMES_PER_SECOND);
    expect(stream.fps).toBeGreaterThanOrEqual(PANEL_MIN_FRAMES_PER_SECOND);
    const source = createFakeScreencastSource({ frameCount: 3 });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
    });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      const issued = capabilities.issue({
        ownerSessionId,
        panelId,
        hostId,
        profileId,
      });
      const inbox = collectMessages(socket);
      send(socket, redeemMessage(issued));
      await inbox.waitFor(
        (raw) => decode<{ type: string }>(raw).type === "ready",
      );
      // Frames stream at ~1 ms intervals; collect from the start and poll for
      // the first frame so a burst is never lost between awaits.
      const frameRaw = await inbox.waitFor(
        (raw) =>
          decode<{ type: string; sequence?: number }>(raw).type === "frame",
      );
      const frame = decode<{
        type: string;
        sequence: number;
        mimeType: string;
        data: string;
      }>(frameRaw);
      expect(frame.type).toBe("frame");
      expect(frame.sequence).toBe(1);
      expect(frame.mimeType).toBe("image/png");
      expect(Buffer.from(frame.data, "base64").toString()).toBe("frame-1");
      // Forwarded input reaches the source after gateway validation.
      send(socket, { type: "input", sequence: 1, payload: { kind: "click" } });
      await waitFor(() =>
        source.inputs.some(
          (input) => (input as { kind?: string }).kind === "click",
        ),
      );
      expect(source.inputs).toEqual([{ kind: "click" }]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("freezes input on disconnect and reclaims within the 10-second window", async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    stream.start();
    const source = createFakeScreencastSource({ frameCount: 0 });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
    });
    const port = await transport.start();
    const issued = capabilities.issue({
      ownerSessionId,
      panelId,
      hostId,
      profileId,
    });
    let socket: WebSocket;
    try {
      socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", resolve));
      // Input freezes immediately on disconnect.
      expect(stream.state).toBe("input-frozen");
      expect(stream.markCapabilityDisconnected(issued.capabilityId)).toBe(true);
      // Reclaim within the window restores the stream.
      now += PANEL_RECLAIM_WINDOW_MS - 1;
      expect(stream.reclaim(issued.capabilityId)).toBe(true);
      expect(stream.state).toBe("streaming");
    } finally {
      await transport.stop();
    }
  });

  it("broadcasts live control state to the connected panel without re-fetch", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    stream.start();
    const source = createFakeScreencastSource({ frameCount: 0 });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
    });
    const port = await transport.start();
    const issued = capabilities.issue({
      ownerSessionId,
      panelId,
      hostId,
      profileId,
    });
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      // The host pushes a live control transfer so every panel observes it
      // without re-fetching the control state.
      transport.broadcastControl(
        {
          controllerPanelId: "panel-other",
          controllerViewport: { width: 1280, height: 720 },
          agentPurpose: null,
          panels: [
            {
              panelId,
              ownerSessionId,
              role: "spectator",
              connection: "connected",
              viewport: { width: 1280, height: 720 },
              reclaimUntil: null,
            },
          ],
        },
        { tabs: [], activeTabId: null },
      );
      const raw = await onceMessage(socket);
      const message = decode<{
        type: string;
        control: { controllerPanelId: string };
        tabs: { tabs: unknown[]; activeTabId: null };
      }>(raw);
      expect(message.type).toBe("control");
      expect(message.control.controllerPanelId).toBe("panel-other");
      expect(message.tabs.activeTabId).toBeNull();
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("reports a bounded reconnect delay from the stream adapter", () => {
    const stream = createAutomationStreamAdapter();
    stream.start();
    stream.freezeInput();
    const first = stream.beginReconnect();
    expect(first).toBe(PANEL_RECONNECT_INITIAL_BACKOFF_MS);
    expect(stream.state).toBe("reconnecting");
    const second = stream.reconnectFailed();
    const third = stream.reconnectFailed();
    expect(second).toBeLessThanOrEqual(third);
    expect(third).toBeLessThanOrEqual(8000);
    expect(frameIntervalMs(stream.fps)).toBeGreaterThanOrEqual(
      frameIntervalMs(PANEL_MAX_FRAMES_PER_SECOND),
    );
    // unique id to avoid unused import warning
    expect(randomUUID().length).toBeGreaterThan(0);
  });

  it("dispatches an explicit clipboard copy/paste to the clipboard exchange", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    stream.start();
    const source = createFakeScreencastSource({ frameCount: 0 });
    const exchange = createClipboardExchange({
      effects: {
        readSelectionBytes: async () => 48,
        writeClipboardToPage: async (_actor, bytes) => bytes,
      },
    });
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
      clipboardExchange: exchange,
    });
    const port = await transport.start();
    const issued = capabilities.issue({
      ownerSessionId,
      panelId,
      hostId,
      profileId,
    });
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      // An explicit owner copy dispatches to the exchange and the panel
      // receives the privacy-safe outcome (bytes only, never contents).
      send(socket, { type: "clipboard_copy", copyId: "copy-1" });
      const copyRaw = await onceMessage(socket);
      const copyOutcome = decode<{
        type: string;
        outcome: { outcome: string; copyId: string; bytes: number };
      }>(copyRaw);
      expect(copyOutcome.type).toBe("clipboard_outcome");
      expect(copyOutcome.outcome).toEqual({
        outcome: "copied",
        copyId: "copy-1",
        bytes: 48,
      });
      // An explicit owner paste dispatches to the exchange too.
      send(socket, {
        type: "clipboard_paste",
        pasteId: "paste-1",
        bytes: 32,
      });
      const pasteRaw = await onceMessage(socket);
      const pasteOutcome = decode<{
        type: string;
        outcome: { outcome: string; pasteId: string; bytes: number };
      }>(pasteRaw);
      expect(pasteOutcome.type).toBe("clipboard_outcome");
      expect(pasteOutcome.outcome).toEqual({
        outcome: "pasted",
        pasteId: "paste-1",
        bytes: 32,
      });
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("routes a panel transfer cancellation to the onTransferCancel handler", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    stream.start();
    const source = createFakeScreencastSource({ frameCount: 0 });
    const cancelled: string[] = [];
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
      onTransferCancel: async (transferId) => {
        cancelled.push(transferId);
      },
    });
    const port = await transport.start();
    const issued = capabilities.issue({
      ownerSessionId,
      panelId,
      hostId,
      profileId,
    });
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      send(socket, { type: "transfer_cancel", transferId: "transfer-1" });
      const ackRaw = await onceMessage(socket);
      const ack = decode<{ type: string; transferId: string }>(ackRaw);
      expect(ack).toEqual({
        type: "transfer_cancel_ack",
        transferId: "transfer-1",
      });
      expect(cancelled).toEqual(["transfer-1"]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("routes a panel download cancellation to the host (issue #20)", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    const source = createFakeScreencastSource({ frameCount: 0 });
    const cancelled: string[] = [];
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
      onDownloadCancel: async (downloadId) => {
        cancelled.push(downloadId);
      },
    });
    const port = await transport.start();
    const issued = capabilities.issue({
      ownerSessionId,
      panelId,
      hostId,
      profileId,
    });
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      send(socket, { type: "download_cancel", downloadId: "download-1" });
      const ackRaw = await onceMessage(socket);
      const ack = decode<{
        type: string;
        downloadId: string;
        action: string;
      }>(ackRaw);
      expect(ack).toEqual({
        type: "download_ack",
        downloadId: "download-1",
        action: "cancelled",
      });
      expect(cancelled).toEqual(["download-1"]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("pushes live Host Downloads quarantine state to the panel (issue #20)", async () => {
    const clock = { now: () => 1_000_000 };
    const capabilities = createPanelCapabilityStore({ clock });
    const gateway = createPanelGateway({
      capabilities,
      hostId,
      profileId,
      clock,
    });
    const stream = createAutomationStreamAdapter({ clock, capabilities });
    const source = createFakeScreencastSource({ frameCount: 0 });
    let pushCount = 0;
    const transport = createPanelTransportServer({
      gateway,
      stream,
      source,
      clock,
      subscribeDownloads: (onUpdate) => {
        const interval = setInterval(() => {
          pushCount += 1;
          onUpdate({ downloads: [], limits: { maxFileBytes: 1 } });
        }, 5);
        return () => clearInterval(interval);
      },
    });
    const port = await transport.start();
    const issued = capabilities.issue({
      ownerSessionId,
      panelId,
      hostId,
      profileId,
    });
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      const updateRaw = await onceMessage(socket);
      const update = decode<{ type: string; update: unknown }>(updateRaw);
      expect(update.type).toBe("downloads_update");
      expect(pushCount).toBeGreaterThan(0);
      socket.close();
    } finally {
      await transport.stop();
    }
  });
});
