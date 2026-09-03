import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import type { PanelGateway } from "./panel-gateway.js";
import type { PanelStreamAdapter } from "./panel-stream.js";
import type {
  ClipboardExchange,
  TransferClipboardActor,
} from "./clipboard-exchange.js";
import {
  PANEL_GATEWAY_BIND_HOST,
  PANEL_PROTOCOL_VERSION,
  PANEL_RECLAIM_WINDOW_MS,
  type BrowserDialogEvent,
  type BrowserContextAction,
  type BrowserDownloadListResult,
  type BrowserPanelControlState,
  type BrowserTabStrip,
} from "./contracts.js";
import {
  decodePanelProtocolMessage,
  encodePanelProtocolMessage,
  panelProtocolErrorMessage,
  toBrowserPanelRedeemMessage,
  type PanelProtocolError,
  type PanelProtocolMessage,
} from "./panel-protocol.js";

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
  /**
   * Read the active page selection length in bytes for an explicit owner
   * copy (issue #19 clipboard exchange). Optional; sources without a real
   * browser return 0 so the exchange denies the copy.
   */
  copyClipboard?(actor: TransferClipboardActor): Promise<number>;
  /**
   * Write `bytes` of the controller's clipboard into the page for an explicit
   * owner paste (issue #19 clipboard exchange). Optional; sources without a
   * real browser return 0 so the exchange denies the paste.
   */
  pasteClipboard?(
    actor: TransferClipboardActor,
    bytes: number,
  ): Promise<number>;
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
  /**
   * Explicit clipboard exchange (issue #19). When provided, `clipboard_copy`
   * and `clipboard_paste` messages dispatch to it so clipboard text moves only
   * through an explicit owner action. The exchange is the authoritative
   * policy; the source supplies the OS-clipboard effects.
   */
  clipboardExchange?: ClipboardExchange;
  /**
   * Called when the controller cancels a staged transfer through the panel, so
   * the host removes the one-use staged copy. Distinct from input/dialog
   * handling and gated to the controller.
   */
  onTransferCancel?: (transferId: string) => Promise<void>;
  /**
   * Host Downloads (issue #20). Called when the owner cancels a quarantined
   * download through the panel so the host removes it. Exports go through the
   * server RPC (which resolves BB environments), matching how other panel
   * actions reach the host.
   */
  onDownloadCancel?: (downloadId: string) => Promise<void>;
  /**
   * Subscribe the panel to live Host Downloads quarantine state. When set, the
   * transport pushes the current quarantine listing whenever the host updates
   * it so the panel observes progress, state, limits, and expiry.
   */
  subscribeDownloads?: (
    onUpdate: (update: BrowserDownloadListResult) => void,
  ) => () => void;
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
  const clipboardExchange = options.clipboardExchange;
  const onTransferCancel = options.onTransferCancel;
  const onDownloadCancel = options.onDownloadCancel;
  const subscribeDownloads = options.subscribeDownloads;
  let unsubscribeDownloads: (() => void) | undefined;
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

  function sendProtocol(socket: WebSocket, message: PanelProtocolMessage) {
    if (socket.readyState !== socket.OPEN) return;
    const encoded = encodePanelProtocolMessage(message, {
      maxBytes: gateway.messageMaxBytes,
    });
    if (encoded.outcome !== "encoded") return;
    socket.send(encoded.raw);
  }

  function rejectProtocol(error: PanelProtocolError) {
    stream.freezeInput();
    if (connection !== undefined && connection.readyState === connection.OPEN) {
      sendProtocol(connection, panelProtocolErrorMessage(error.category));
      connection.close();
    }
  }

  function gatewayRawForProtocol(
    message: PanelProtocolMessage,
  ): string | undefined {
    if (message.type === "redeem") {
      return JSON.stringify(toBrowserPanelRedeemMessage(message));
    }
    if (message.type === "input") {
      return JSON.stringify({
        type: "input",
        sequence: message.sequence,
        payload: message.payload,
      });
    }
    if (message.type === "ack") {
      return JSON.stringify({ type: "ack", sequence: message.sequence });
    }
    if (message.type === "dialog_response") {
      return JSON.stringify({
        type: "dialog_response",
        dialogId: message.dialogId,
        accept: message.accept,
        ...(message.text === undefined ? {} : { text: message.text }),
      });
    }
    if (message.type === "context_query") {
      return JSON.stringify({
        type: "context_query",
        queryId: message.queryId,
        x: message.x,
        y: message.y,
      });
    }
    if (message.type === "context_action") {
      return JSON.stringify({
        type: "context_action",
        actionId: message.actionId,
      });
    }
    if (message.type === "clipboard_copy") {
      return JSON.stringify({
        type: "clipboard_copy",
        copyId: message.copyId,
      });
    }
    if (message.type === "clipboard_paste") {
      return JSON.stringify({
        type: "clipboard_paste",
        pasteId: message.pasteId,
        bytes: message.bytes,
      });
    }
    if (message.type === "transfer_cancel") {
      return JSON.stringify({
        type: "transfer_cancel",
        transferId: message.transferId,
      });
    }
    if (message.type === "download_cancel") {
      return JSON.stringify({
        type: "download_cancel",
        downloadId: message.downloadId,
      });
    }
    if (message.type === "ping") {
      return JSON.stringify({ type: "ping" });
    }
    return undefined;
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
    sendProtocol(socket, {
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "dialog",
      dialog: event,
    });
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
    unsubscribeDownloads?.();
    unsubscribeDownloads = undefined;
    // Start the fail-closed timer so an open dialog is auto-resolved if the
    // controller does not reclaim within the bounded window.
    startFailClosedTimer();
    onDisconnect?.();
  }

  function startStreaming(socket: WebSocket) {
    authorized = true;
    stream.start();
    sendProtocol(socket, {
      protocolVersion: PANEL_PROTOCOL_VERSION,
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
    if (subscribeDownloads !== undefined) {
      unsubscribeDownloads?.();
      // Push the live Host Downloads quarantine state (progress, state,
      // limits, expiry, errors) to the panel as it changes (issue #20).
      unsubscribeDownloads = subscribeDownloads((update) => {
        if (connection !== undefined && authorized) {
          sendProtocol(connection, {
            protocolVersion: PANEL_PROTOCOL_VERSION,
            type: "downloads_update",
            update,
          });
        }
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
    sendProtocol(socket, {
      protocolVersion: PANEL_PROTOCOL_VERSION,
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
    const decoded = decodePanelProtocolMessage(text, {
      direction: "client-to-host",
      phase: authorized ? "authenticated" : "pre-redemption",
      maxBytes: gateway.messageMaxBytes,
    });
    if (decoded.outcome === "rejected") {
      rejectProtocol(decoded.error);
      return;
    }
    const gatewayRaw = gatewayRawForProtocol(decoded.message);
    if (gatewayRaw === undefined) {
      rejectProtocol(panelProtocolErrorMessage("invalid-direction"));
      return;
    }
    const result = gateway.validate(gatewayRaw);
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
          sendProtocol(socketRef, {
            protocolVersion: PANEL_PROTOCOL_VERSION,
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
    if (message.kind === "clipboard_copy") {
      // Explicit owner copy dispatches to the clipboard exchange policy; only
      // the connected controller may copy.
      if (!canInput() || clipboardExchange === undefined) return;
      void clipboardExchange
        .copy("owner-controller", message.copyId)
        .then((outcome) =>
          sendProtocol(socket, {
            protocolVersion: PANEL_PROTOCOL_VERSION,
            type: "clipboard_outcome",
            outcome,
          }),
        )
        .catch(() => undefined);
      return;
    }
    if (message.kind === "clipboard_paste") {
      if (!canInput() || clipboardExchange === undefined) return;
      void clipboardExchange
        .paste("owner-controller", message.bytes, message.pasteId)
        .then((outcome) =>
          sendProtocol(socket, {
            protocolVersion: PANEL_PROTOCOL_VERSION,
            type: "clipboard_outcome",
            outcome,
          }),
        )
        .catch(() => undefined);
      return;
    }
    if (message.kind === "transfer_cancel") {
      // The controller cancels a staged transfer through the panel; route to
      // the host so the one-use staged copy is removed.
      if (!canInput() || onTransferCancel === undefined) return;
      void onTransferCancel(message.transferId)
        .then(() =>
          sendProtocol(socket, {
            protocolVersion: PANEL_PROTOCOL_VERSION,
            type: "transfer_cancel_ack",
            transferId: message.transferId,
          }),
        )
        .catch(() => undefined);
      return;
    }
    if (message.kind === "download_cancel") {
      // Owner cancels a quarantined download through the panel; route to the
      // host so the quarantine file is removed.
      if (!canInput() || onDownloadCancel === undefined) return;
      void onDownloadCancel(message.downloadId)
        .then(() =>
          sendProtocol(socket, {
            protocolVersion: PANEL_PROTOCOL_VERSION,
            type: "download_ack",
            downloadId: message.downloadId,
            action: "cancelled",
          }),
        )
        .catch(() => undefined);
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
    sendProtocol(connection, {
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "session",
      control,
      tabs,
    });
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
