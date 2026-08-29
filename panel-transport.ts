import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { PanelGateway } from "./panel-gateway.js";
import type { PanelStreamAdapter } from "./panel-stream.js";
import {
  PANEL_GATEWAY_BIND_HOST,
  PANEL_RECLAIM_WINDOW_MS,
  type BrowserDialogEvent,
  type BrowserContextAction,
  type BrowserPanelControlState,
  type BrowserTabStrip,
} from "./contracts.js";

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
  /**
   * Apply the controller's logical viewport to the capture so the screencast
   * tracks the controller viewport rather than an independent size. Optional;
   * sources without a dynamic viewport ignore it.
   */
  setViewport?(viewport: { width: number; height: number }): void;
  /**
   * Subscribe to page dialogs (alert/confirm/prompt/beforeunload). The source
   * invokes {@link onDialog} for each `Page.javascriptDialogOpening` event so
   * the transport can render actionable BB panel chrome. Returns an
   * unsubscribe function. Optional for sources without a real browser.
   */
  subscribeDialogs?(onDialog: (event: BrowserDialogEvent) => void): () => void;
  /** Resolve an open dialog. Maps directly to `Page.handleJavaScriptDialog`. */
  respondToDialog?(dialogId: string, accept: boolean, text?: string): void;
  /**
   * Auto-resolve any still-open dialog with the browser default when the
   * controller does not reclaim within the bounded window, so a stranded
   * prompt never leaves an invisible modal block. Idempotent.
   */
  dismissOpenDialogs?(): void;
  /**
   * Inspect the element under a viewport point and report the common link and
   * image actions available there, without native Chrome context menus.
   */
  resolveContextActions?(point: {
    x: number;
    y: number;
  }): Promise<BrowserContextAction[]>;
  /** Perform a chosen context action reported by {@link resolveContextActions}. */
  performContextAction?(actionId: string): void;
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
  /**
   * Predicate that must return true for an input message to be forwarded to
   * the screencast source. The multi-client control session supplies this so
   * view-only spectators cannot send browser input; only the connected
   * controller can.
   */
  canInput?: () => boolean;
  /**
   * Called when the authenticated panel disconnects, so the control session
   * can freeze input and start the same-panel reclaim window.
   */
  onDisconnect?: () => void;
};

export type PanelTransportServer = {
  start(): Promise<number>;
  stop(): Promise<void>;
  /**
   * Push the live shared control state and tab strip to the connected panel so
   * every panel observes control transfers and tab changes without re-fetching.
   * No-op when the panel is not currently authorized.
   */
  broadcastControl(
    control: BrowserPanelControlState,
    tabs: BrowserTabStrip,
  ): void;
  /**
   * Dismiss every still-open dialog with the fail-closed default. Wired to
   * Control Lease end (revoked or owner takeover) so an unresolved agent
   * dialog never leaves an invisible modal block.
   */
  dismissOpenDialogs(): void;
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
  const canInput = options.canInput ?? (() => true);
  const onDisconnect = options.onDisconnect;
  let server: WebSocketServer | undefined;
  let httpServer: Server | undefined;
  let boundPort: number | undefined;
  let disposed = false;
  let connection: WebSocket | undefined;
  let authorized = false;
  let firstMessageTimeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  /**
   * Open dialogs keyed by id, so multiple dialogs stay answerable and a
   * reconnect re-pushes each still-open event exactly once. Cleared when the
   * panel responds, when the page closes a dialog, or when the reclaim window
   * expires (fail closed).
   */
  const openDialogs = new Map<string, BrowserDialogEvent>();
  /** A pending context-menu query awaiting the source's element inspection. */
  let pendingContextQueryId: string | null = null;
  /**
   * Timer that fails an open dialog closed if the controller does not reclaim
   * within the bounded reconnect window, so a stranded prompt leaves no
   * invisible modal block.
   */
  let failClosedTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribeDialogs: (() => void) | undefined;

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

  function clearFailClosedTimer() {
    if (failClosedTimer !== undefined) {
      clearTimeout(failClosedTimer);
      failClosedTimer = undefined;
    }
  }

  /**
   * The fail-closed default for a stranded dialog. confirm/prompt/beforeunload
   * cancel (accept:false) so an unseen action is never silently confirmed and
   * a beforeunload never silently leaves the page; alert accepts (its only
   * button is OK) since it carries no destructive choice. Preserving page
   * state is the safe default when the controller never reclaimed.
   */
  function failClosedAccept(event: BrowserDialogEvent): boolean {
    return event.type === "alert";
  }

  function pushDialog(socket: WebSocket, event: BrowserDialogEvent) {
    if (socket.readyState !== socket.OPEN) return;
    sendJson(socket, { type: "dialog", dialog: event });
  }

  function startFailClosedTimer() {
    clearFailClosedTimer();
    if (openDialogs.size === 0) return;
    const pending = [...openDialogs.values()];
    failClosedTimer = setTimeout(() => {
      failClosedTimer = undefined;
      // No reclaim within the bounded window: resolve each stranded dialog
      // with the fail-closed default (cancel/stay for confirm/prompt/
      // beforeunload; OK for alert) and drop the panel's invisible modal.
      for (const event of pending) {
        openDialogs.delete(event.dialogId);
        source.respondToDialog?.(
          event.dialogId,
          failClosedAccept(event),
          undefined,
        );
      }
    }, PANEL_RECLAIM_WINDOW_MS);
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
    pendingContextQueryId = null;
    // Start the fail-closed timer so an open dialog is auto-resolved if the
    // controller does not reclaim within the bounded window.
    startFailClosedTimer();
    onDisconnect?.();
  }

  function startStreaming(socket: WebSocket) {
    authorized = true;
    stream.start();
    sendJson(socket, {
      type: "ready",
      viewport: stream.viewport,
      fps: stream.fps,
    });
    clearFailClosedTimer();
    void source.start(
      (frame) => deliverFrame(socket, frame),
      controller.signal,
    );
    if (source.subscribeDialogs !== undefined) {
      unsubscribeDialogs?.();
      // subscribeDialogs re-emits every still-open dialog exactly once, so it
      // is the single source of truth for both fresh opens and reconnect
      // re-pushes; an explicit re-push here would duplicate them.
      unsubscribeDialogs = source.subscribeDialogs((event) => {
        openDialogs.set(event.dialogId, event);
        if (connection !== undefined && authorized)
          pushDialog(connection, event);
      });
    }
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
      // View-only spectators cannot send browser input; only the connected
      // controller may forward input to the browser.
      if (!canInput()) return;
      source.input(message.payload);
      return;
    }
    if (message.kind === "dialog_response") {
      // Only the controller can resolve a dialog; spectators observe it only.
      if (!canInput()) return;
      const open = openDialogs.get(message.dialogId);
      if (open !== undefined) {
        openDialogs.delete(message.dialogId);
        source.respondToDialog?.(
          message.dialogId,
          message.accept,
          message.text,
        );
        if (openDialogs.size === 0) clearFailClosedTimer();
      }
      return;
    }
    if (message.kind === "context_query") {
      if (!canInput()) return;
      pendingContextQueryId = message.queryId;
      const queryId = message.queryId;
      void Promise.resolve(
        source.resolveContextActions?.({ x: message.x, y: message.y }),
      )
        .then((actions) => {
          if (pendingContextQueryId !== queryId) return;
          pendingContextQueryId = null;
          const socketRef = connection;
          if (socketRef === undefined || !authorized) return;
          sendJson(socketRef, {
            type: "context_menu",
            queryId,
            point: { x: message.x, y: message.y },
            actions: actions ?? [],
          });
        })
        .catch(() => undefined);
      return;
    }
    if (message.kind === "context_action") {
      if (!canInput()) return;
      source.performContextAction?.(message.actionId);
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
    clearFailClosedTimer();
    unsubscribeDialogs?.();
    unsubscribeDialogs = undefined;
    openDialogs.clear();
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

  function broadcastControl(
    control: BrowserPanelControlState,
    tabs: BrowserTabStrip,
  ) {
    if (disposed || connection === undefined || !authorized) return;
    sendJson(connection, { type: "control", control, tabs });
  }

  function dismissOpenDialogs() {
    clearFailClosedTimer();
    const pending = [...openDialogs.values()];
    openDialogs.clear();
    for (const event of pending) {
      source.respondToDialog?.(
        event.dialogId,
        failClosedAccept(event),
        undefined,
      );
    }
  }

  return {
    start,
    stop,
    broadcastControl,
    dismissOpenDialogs,
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
