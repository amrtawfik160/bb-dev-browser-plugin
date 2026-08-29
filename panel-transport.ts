import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { PanelGateway } from "./panel-gateway.js";
import type { PanelStreamAdapter } from "./panel-stream.js";
import { PANEL_GATEWAY_BIND_HOST } from "./contracts.js";

/**
 * Automation Mode stream transport. The host binds a dynamic loopback gateway
 * (net.Server + WebSocket), redeems the single-use Panel Capability in the
 * first WebSocket message, drives a {@link ScreencastSource} to produce frames,
 * delivers frames over the WebSocket, receives input messages, and applies the
 * Panel Stream policy (viewport clamp up to 1920x1080, adaptive 5-15 FPS, input
 * freeze on disconnect, 10-second reclaim, bounded reconnect backoff). Chrome,
 * CDP, and the gateway never bind externally; the gateway binds to 127.0.0.1
 * only.
 */

export type ScreencastFrame = {
  sequence: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: Uint8Array;
};

export type ScreencastInputPayload = unknown;

export interface ScreencastSource {
  /**
   * Produce frames by invoking {@link onFrame}. Resolves when the source stops
   * (the abort signal fires) or the source naturally ends. Must not invoke
   * {@link onFrame} after {@link stop} resolves.
   */
  start(
    onFrame: (frame: ScreencastFrame) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** Consume a validated input payload forwarded from the panel client. */
  input(payload: ScreencastInputPayload): void;
  /** Release the underlying browser resources. Idempotent. */
  stop(): Promise<void>;
}

export type PanelTransportServerOptions = {
  gateway: PanelGateway;
  stream: PanelStreamAdapter;
  source: ScreencastSource;
  clock?: { now(): number };
  bindHost?: string;
  port?: number;
  /** Deadline slack applied to outgoing frames for stale-frame validation. */
  frameDeadlineMs?: number;
};

export type PanelTransportServer = {
  start(): Promise<number>;
  stop(): Promise<void>;
  get port(): number | undefined;
  get state(): "idle" | "listening" | "closed";
};

const DEFAULT_FRAME_DEADLINE_MS = 1_000;

export function createPanelTransportServer(
  options: PanelTransportServerOptions,
): PanelTransportServer {
  const gateway = options.gateway;
  const stream = options.stream;
  const source = options.source;
  const clock = options.clock ?? { now: () => Date.now() };
  const bindHost = options.bindHost ?? PANEL_GATEWAY_BIND_HOST;
  const requestedPort = options.port ?? 0;
  const frameDeadlineMs = options.frameDeadlineMs ?? DEFAULT_FRAME_DEADLINE_MS;
  let server: WebSocketServer | undefined;
  let httpServer: Server | undefined;
  let boundPort: number | undefined;
  let disposed = false;
  let connection: WebSocket | undefined;
  let authorized = false;
  let firstMessageTimeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();

  function sendJson(socket: WebSocket, message: unknown) {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  function closeConnection(reason: string) {
    if (connection !== undefined && connection.readyState === connection.OPEN) {
      sendJson(connection, { type: "error", reason });
      connection.close();
    }
  }

  function handleDisconnect() {
    if (!authorized) return;
    // Input freezes immediately on disconnect; the same panel has a bounded
    // reclaim window before release. The stream stays bound so the panel can
    // reclaim and reconnect with bounded backoff handled by the stream policy.
    stream.freezeInput();
    if (stream.state !== "released") {
      const capabilityId = gateway.redeemedCapabilityId;
      if (capabilityId !== undefined)
        stream.markCapabilityDisconnected(capabilityId);
    }
    controller.abort();
    void source.stop();
    connection = undefined;
    authorized = false;
  }

  function startStreaming(socket: WebSocket) {
    authorized = true;
    stream.start();
    sendJson(socket, {
      type: "ready",
      viewport: stream.viewport,
      fps: stream.fps,
    });
    void source.start(
      (frame) => deliverFrame(socket, frame),
      controller.signal,
    );
  }

  function deliverFrame(socket: WebSocket, frame: ScreencastFrame) {
    if (disposed || socket.readyState !== socket.OPEN || !authorized) return;
    const now = clock.now();
    // Validate the frame metadata through the gateway so the bandwidth cap and
    // stale-frame policy apply before pixels are delivered.
    const envelope = JSON.stringify({
      type: "frame",
      sequence: frame.sequence,
      bytes: frame.data.byteLength,
      deadlineAt: now + frameDeadlineMs,
    });
    const result = gateway.validate(envelope);
    if (result.outcome !== "accepted") return;
    if (result.message.kind !== "frame") return;
    sendJson(socket, {
      type: "frame",
      sequence: frame.sequence,
      mimeType: frame.mimeType,
      data: Buffer.from(frame.data).toString("base64"),
    });
  }

  function handleMessage(raw: unknown) {
    const socket = connection;
    if (socket === undefined) return;
    const text = typeof raw === "string" ? raw : String(raw);
    const result = gateway.validate(text);
    if (result.outcome !== "accepted") {
      closeConnection(result.reason);
      return;
    }
    const message = result.message;
    if (message.kind === "redeem") {
      if (!authorized) startStreaming(socket);
      return;
    }
    if (message.kind === "input") {
      source.input(message.payload);
      return;
    }
    // ack and ping are accepted by the gateway but carry no transport action.
  }

  async function handleConnection(socket: WebSocket) {
    if (connection !== undefined) {
      // A single panel owns one stream connection at a time.
      sendJson(socket, { type: "error", reason: "busy" });
      socket.close();
      return;
    }
    connection = socket;
    // The capability must be redeemed in the first message; close the
    // connection if the panel never authenticates.
    firstMessageTimeout = setTimeout(() => {
      if (!authorized && socket.readyState === socket.OPEN) {
        closeConnection("unauthorized");
      }
    }, 10_000);
    socket.once("close", () => {
      if (firstMessageTimeout !== undefined) {
        clearTimeout(firstMessageTimeout);
        firstMessageTimeout = undefined;
      }
      handleDisconnect();
    });
    socket.on("message", (raw) => {
      if (firstMessageTimeout !== undefined && authorized) {
        clearTimeout(firstMessageTimeout);
        firstMessageTimeout = undefined;
      }
      handleMessage(raw);
    });
  }

  async function start(): Promise<number> {
    if (server !== undefined) return boundPort ?? 0;
    httpServer = createServer();
    server = new WebSocketServer({ server: httpServer });
    server.on("connection", handleConnection);
    await new Promise<void>((resolve) => {
      httpServer!.listen(requestedPort, bindHost, () => resolve());
    });
    const address = httpServer.address();
    boundPort =
      typeof address === "object" && address !== null
        ? address.port
        : requestedPort;
    return boundPort;
  }

  async function stop(): Promise<void> {
    disposed = true;
    if (firstMessageTimeout !== undefined) {
      clearTimeout(firstMessageTimeout);
      firstMessageTimeout = undefined;
    }
    controller.abort();
    await source.stop();
    closeConnection("closed");
    if (connection !== undefined) {
      await new Promise<void>((resolve) => {
        if (connection!.readyState === connection!.CLOSED) return resolve();
        connection!.once("close", resolve);
      });
      connection = undefined;
    }
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer?.close(() => resolve());
    });
    server = undefined;
    httpServer = undefined;
    stream.release();
    gateway.close();
  }

  return {
    start,
    stop,
    get port() {
      return boundPort;
    },
    get state() {
      if (server !== undefined) return "listening";
      if (disposed) return "closed";
      return "idle";
    },
  };
}
