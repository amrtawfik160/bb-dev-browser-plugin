import { useEffect, useRef, useState } from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  BROWSER_WHOLE_WEB_ORIGIN_SCOPE,
  DEFAULT_PROFILE_ID,
  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
  BROWSER_PANEL_STREAM_DISCLOSURE,
  PANEL_AUTH_ROTATION_MS,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  type BrowserContextAction,
  type BrowserDialogEvent,
  type BrowserDownloadListingEntry,
  type BrowserDownloadLimits,
  type BrowserHostChoice,
  type BrowserHostChoicesInput,
  type BrowserGrantRequest,
  type BrowserPanelCapabilityResponse,
  type BrowserPanelControlResponse,
  isPanelIdentityRejection,
  type BrowserProfileInventory,
  type BrowserStatus,
  type BrowserStatusInput,
  type BrowserTabAction,
  type BrowserTabStrip,
  type rpcContract,
} from "../shared/contracts.js";
import {
  PanelDialogLayer,
  PanelContextMenu,
  PanelDownloadsSurface,
  usePrefersReducedMotion,
} from "./panel-chrome.js";
import { Field, inputClassName } from "./panel-primitives.js";
import {
  administrationErrorMessage,
  saveExportedBytes,
} from "./browser-client-utils.js";
import {
  ActivitySection,
  AgentAccessSection,
  BrowserHostsSection,
  DownloadsSection,
  MaintenanceSection,
  ProfilesSection,
} from "./settings-sections.js";
import {
  BrowserAccessRequestNotices,
  BrowserBlockedSurface,
  BrowserNewTabSurface,
  BrowserTabStripView,
  BrowserToolbar,
  ReadinessChecklist,
  browserAccessRequestKey,
  browserStateIsSettling,
  browserStateReplacesPage,
  type BrowserAccessRequest,
  type BrowserPanelOption,
} from "./panel-browser.js";
import {
  browserPanelRecoveryAnnouncement,
  presentBrowserPanel,
  type BrowserPanelConnectionPhase,
  type BrowserPanelOptionDescriptor,
} from "./panel-presentation.js";
import { ownerSessionIdFromContext } from "../shared/panel-owner-session.js";
import { browserPagePoint, useBrowserPageInput } from "./panel-input.js";
import {
  PANEL_PROTOCOL_VERSION,
  decodePanelProtocolMessage,
  encodePanelProtocolMessage,
  type PanelProtocolMessage,
} from "../shared/panel-protocol.js";
import {
  clearPanelTimeout,
  isTestLoopbackPanelTransport,
  isTestPanelTransportEnabled,
  schedulePanelTimeout,
} from "./panel-test-loopback.js";
import { SAFE_LOGIN_LIMITATIONS_NOTICE } from "../shared/safe-login-notice.js";
import {
  createAutomationStreamAdapter,
  type PanelStreamAdapter,
} from "../panel/panel-stream.js";

const panelParams = { profileId: DEFAULT_PROFILE_ID } as const;
const GRANT_REQUEST_REFRESH_INTERVAL_MS = 1_000;
let nextBrowserPanelId = 1;

function shouldOpenAuthenticatedPanelStream() {
  if (!isTestEnvironment()) return true;
  return isTestPanelTransportEnabled();
}

function isTestEnvironment() {
  return (
    typeof import.meta !== "undefined" &&
    typeof (import.meta as { env?: { MODE?: string } }).env === "object" &&
    (import.meta as { env?: { MODE?: string } }).env?.MODE === "test"
  );
}

function SafeLoginLimitationsNotice() {
  return (
    <p
      aria-label="Safe Login limitations"
      className="mt-3 text-left text-xs text-muted-foreground"
    >
      {SAFE_LOGIN_LIMITATIONS_NOTICE}
    </p>
  );
}

function hostChoicesRequest(
  request: BrowserStatusInput,
): BrowserHostChoicesInput {
  return request.surface === "thread"
    ? { surface: "thread", threadId: request.threadId }
    : { surface: "new-thread", projectId: request.projectId };
}

function PanelHostPicker({
  choices,
  onChange,
}: {
  choices: readonly BrowserHostChoice[];
  onChange: (hostId: string) => void;
}) {
  const [hostId, setHostId] = useState("");
  return (
    <div className="mt-5 text-left">
      <Field label="Workspace host">
        <select
          aria-label="Workspace host"
          className={inputClassName}
          value={hostId}
          onChange={(event) => {
            setHostId(event.target.value);
            onChange(event.target.value);
          }}
        >
          <option value="" disabled>
            Select a host
          </option>
          {choices.map((choice) => (
            <option key={choice.hostId} value={choice.hostId}>
              {choice.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function PanelProfilePicker({
  inventory,
  onChange,
}: {
  inventory: BrowserProfileInventory;
  onChange: (profileId: string) => void;
}) {
  const selected = inventory.profiles.find((profile) => profile.selected);
  return (
    <div className="mt-5 text-left">
      <Field
        label="Browser Profile"
        help={
          selected === undefined
            ? undefined
            : `Locale ${selected.locale} · Timezone ${selected.timezone}`
        }
      >
        <select
          aria-label="Browser Profile"
          className={inputClassName}
          value={inventory.selectedProfileId}
          onChange={(event) => onChange(event.target.value)}
        >
          {inventory.profiles.map((profile) => (
            <option key={profile.profileId} value={profile.profileId}>
              {profile.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function PanelStreamSurface({
  status,
  panelId,
  isController,
  agentDriven,
  onControlState,
  onLiveChange,
}: {
  status: BrowserStatus;
  panelId: string;
  /**
   * Whether this panel may drive the browser. The shared control session is
   * the single source of that answer (ADR 0012); the stream applies it to
   * dialogs, context actions, and download control.
   */
  isController: boolean;
  /**
   * Whether an agent is holding control right now. The owner's authenticated
   * session being driven by something that is not them is the one piece of
   * internal state that earns permanent screen space, so the page carries a
   * border for exactly as long as that is true (ADR 0014).
   */
  agentDriven: boolean;
  /**
   * Live control-state updates pushed from the host over the stream so every
   * panel observes control transfers and tab changes without re-fetching.
   */
  onControlState?: (response: BrowserPanelControlResponse) => void;
  /**
   * Whether this stream is currently the live channel for those updates. When
   * it is not, the panel has to ask for control state instead of being told.
   */
  onLiveChange?: (live: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const bbContext = useBbContext();
  const [capability, setCapability] = useState<
    BrowserPanelCapabilityResponse | undefined
  >();
  const [streamState, setStreamState] =
    useState<BrowserPanelConnectionPhase>("connecting");
  // Whether the host is actually pushing over this stream. The capability being
  // issued is not the same thing: it authorizes a connection that may not be
  // open, and control transfers only arrive once one is.
  const [livePush, setLivePush] = useState(false);
  const [controllerViewport, setControllerViewport] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const ownerSessionId = ownerSessionIdFromContext(bbContext);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const streamRef = useRef<PanelStreamAdapter | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [dialog, setDialog] = useState<BrowserDialogEvent | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    queryId: string;
    point: { x: number; y: number };
    actions: BrowserContextAction[];
  } | null>(null);
  // Host Downloads quarantine state (issue #20): progress, quarantine state,
  // limits, expiry, export, cancellation, and errors surfaced from the host.
  const [downloads, setDownloads] = useState<
    (BrowserDownloadListingEntry & { error?: string | null })[]
  >([]);
  const [downloadsLimits, setDownloadsLimits] =
    useState<BrowserDownloadLimits | null>(null);
  // Download errors appear in the listing; export errors appear above it.
  // Disable a download's export button while its export is in flight.
  const [exportInFlightDownloadId, setExportInFlightDownloadId] = useState<
    string | null
  >(null);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    if (status.state !== "healthy" || status.hostId === null) {
      // A sleeping or waking instance keeps the frame it last painted: those
      // states resolve themselves within seconds, and blanking the page for
      // them reads as a fault rather than as a browser about to come back
      // (issue #50). The toolbar is what says so. Every other non-healthy
      // state has no page left to keep.
      if (!browserStateIsSettling(status.state)) setCapability(undefined);
      setStreamState("offline");
      return;
    }
    let disposed = false;
    setCapability(undefined);
    setStreamState("connecting");
    void rpc
      .call("browser_panel_capability", {
        hostId: status.hostId,
        profileId: status.profileId,
        panelId,
        ownerSessionId,
      })
      .then((response) => {
        if (disposed) return;
        if (response.outcome !== "issued") {
          setStreamState("offline");
          return;
        }
        setCapability(response);
        // The capability is redeemed in the first WebSocket message rather than
        // placed in a URL. The panel never opens the loopback gateway directly;
        // BB Connect's owner-session gate carries the opaque single-use secret.
        // Keep connecting until the gateway confirms the stream is ready.
      })
      .catch(() => {
        if (disposed) return;
        setStreamState("offline");
      });
    return () => {
      disposed = true;
      if (status.hostId === null) return;
      void rpc
        .call("browser_panel_release", {
          hostId: status.hostId,
          profileId: status.profileId,
          panelId,
          ownerSessionId,
        })
        .catch(() => undefined);
    };
  }, [
    rpc,
    status.state,
    status.hostId,
    status.profileId,
    panelId,
    ownerSessionId,
  ]);

  // Drive the authenticated stream: open a WebSocket through the BB Connect
  // tunnel, redeem the capability in the first message, render frames on the
  // canvas, reconnect with bounded backoff on disconnect, and replace the
  // physical connection at the five-minute authorization boundary. Input
  // freezes immediately on disconnect; the same panel has a 10-second reclaim
  // window.
  useEffect(() => {
    if (
      capability?.outcome !== "issued" ||
      !shouldOpenAuthenticatedPanelStream()
    )
      return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof schedulePanelTimeout> | null = null;
    let rotationTimer: ReturnType<typeof schedulePanelTimeout> | null = null;
    let attemptAbort: AbortController | null = null;
    let replacementAbort: AbortController | null = null;
    let replacementSocket: WebSocket | null = null;
    const streamHostId = status.hostId;
    const streamProfileId = status.profileId;
    const stream = createAutomationStreamAdapter();
    streamRef.current = stream;
    stream.start();

    function clearReconnect() {
      if (reconnectTimer !== null) {
        clearPanelTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function clearRotation() {
      if (rotationTimer !== null) {
        clearPanelTimeout(rotationTimer);
        rotationTimer = null;
      }
    }

    function abortAttempt() {
      attemptAbort?.abort();
      attemptAbort = null;
    }

    function discardReplacement() {
      const pendingAttempt = replacementAbort;
      const pendingSocket = replacementSocket;
      replacementAbort = null;
      replacementSocket = null;
      pendingAttempt?.abort();
      if (pendingSocket !== null) pendingSocket.close();
    }

    function drawFrame(frame: { mimeType: string; data: string }) {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const image = new Image();
      image.addEventListener("load", () => {
        const context = canvas.getContext("2d");
        if (context === null) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      });
      image.src = `data:${frame.mimeType};base64,${frame.data}`;
    }

    function streamUrl(
      issued: Extract<BrowserPanelCapabilityResponse, { outcome: "issued" }>,
    ) {
      // Production reaches the loopback gateway through BB Connect. The public
      // lifecycle seam substitutes that tunnel with the declared loopback port
      // so tests redeem a real Panel Capability without a Connect daemon.
      return isTestLoopbackPanelTransport()
        ? `ws://127.0.0.1:${issued.gatewayPort}`
        : `wss://${issued.tunnel.label}--${issued.gatewayPort}.${issued.tunnel.baseDomain}`;
    }

    function redeemOnOpen(
      nextSocket: WebSocket,
      issued: Extract<BrowserPanelCapabilityResponse, { outcome: "issued" }>,
      attempt: AbortController,
    ) {
      nextSocket.addEventListener("open", () => {
        if (disposed || attempt.signal.aborted) return;
        const encoded = encodePanelProtocolMessage({
          protocolVersion: PANEL_PROTOCOL_VERSION,
          type: "redeem",
          capabilityId: issued.capabilityId,
          secret: issued.secret,
          ownerSessionId,
          panelId,
        });
        if (encoded.outcome === "encoded") nextSocket.send(encoded.raw);
      });
    }

    function listenForHostMessages(
      nextSocket: WebSocket,
      attempt: AbortController,
      onReady: () => void,
    ) {
      nextSocket.addEventListener("message", (event) => {
        if (disposed || attempt.signal.aborted) return;
        if (typeof event.data !== "string") return;
        const decoded = decodePanelProtocolMessage(event.data, {
          direction: "host-to-client",
          phase: "authenticated",
        });
        if (decoded.outcome === "rejected") {
          stream.freezeInput();
          nextSocket.close();
          return;
        }
        const message = decoded.message;
        if (message.type === "ready") {
          onReady();
          return;
        }
        if (message.type === "session") {
          const own = message.control.panels.find(
            (panel) => panel.panelId === panelId,
          );
          onControlState?.({
            role: own?.role ?? "spectator",
            control: message.control,
            tabs: message.tabs,
          });
          const viewport = message.control.controllerViewport;
          if (viewport !== null) setControllerViewport(viewport);
          return;
        }
        if (message.type === "frame") {
          drawFrame({
            mimeType: message.mimeType,
            data: message.data,
          });
          return;
        }
        if (message.type === "protocol_error") {
          stream.freezeInput();
          nextSocket.close();
          return;
        }
        if (message.type === "dialog") {
          setDialog(message.dialog);
          return;
        }
        if (message.type === "context_menu") {
          setContextMenu({
            queryId: message.queryId,
            point: message.point,
            actions: message.actions,
          });
          return;
        }
        if (message.type === "downloads_update") {
          setDownloads(message.update.downloads);
          setDownloadsLimits(message.update.limits);
        }
      });
    }

    function dropLiveAndReconnect() {
      setLivePush(false);
      stream.freezeInput();
      setDialog(null);
      setContextMenu(null);
      clearRotation();
      scheduleReconnect();
    }

    function scheduleReconnect() {
      if (disposed) return;
      const delay =
        stream.state === "reconnecting"
          ? stream.reconnectFailed()
          : stream.beginReconnect();
      if (delay === 0) {
        setStreamState("offline");
        return;
      }
      setStreamState("reconnecting");
      clearReconnect();
      clearRotation();
      reconnectTimer = schedulePanelTimeout(() => {
        reconnectTimer = null;
        if (!disposed) void requestFreshCapability();
      }, delay);
    }

    function scheduleRotation() {
      if (disposed) return;
      clearRotation();
      rotationTimer = schedulePanelTimeout(() => {
        rotationTimer = null;
        if (!disposed) void requestReplacementCapability();
      }, PANEL_AUTH_ROTATION_MS);
    }

    function failRotation() {
      if (disposed) return;
      discardReplacement();
      if (stream.state === "rotating") stream.rotationFailed();
      else stream.freezeInput();
      clearRotation();
      setDialog(null);
      setContextMenu(null);
      setLivePush(false);
      if (socket !== null) {
        const previous = socket;
        attemptAbort?.abort();
        socket = null;
        socketRef.current = null;
        previous.close();
      }
      scheduleReconnect();
    }

    async function requestFreshCapability() {
      if (disposed || streamHostId === null) return;
      abortAttempt();
      const attempt = new AbortController();
      attemptAbort = attempt;
      try {
        const response = await rpc.call("browser_panel_capability", {
          hostId: streamHostId,
          profileId: streamProfileId,
          panelId,
          ownerSessionId,
        });
        if (disposed || attempt.signal.aborted) return;
        if (response.outcome !== "issued") {
          scheduleReconnect();
          return;
        }
        setCapability(response);
        connect(response);
      } catch {
        if (!disposed && !attempt.signal.aborted) scheduleReconnect();
      }
    }

    async function requestReplacementCapability() {
      if (disposed || streamHostId === null) return;
      if (!stream.beginRotation()) return;
      try {
        const response = await rpc.call("browser_panel_capability", {
          hostId: streamHostId,
          profileId: streamProfileId,
          panelId,
          ownerSessionId,
        });
        if (disposed || stream.state !== "rotating") return;
        if (response.outcome !== "issued") {
          failRotation();
          return;
        }
        setCapability(response);
        connectReplacement(response);
      } catch {
        if (!disposed && stream.state === "rotating") failRotation();
      }
    }

    function connect(
      issued: Extract<BrowserPanelCapabilityResponse, { outcome: "issued" }>,
    ) {
      if (disposed) return;
      abortAttempt();
      const attempt = new AbortController();
      attemptAbort = attempt;
      if (socket !== null) {
        const previous = socket;
        socket = null;
        socketRef.current = null;
        previous.close();
      }
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(streamUrl(issued));
      } catch {
        if (!disposed && !attempt.signal.aborted) scheduleReconnect();
        return;
      }
      socket = nextSocket;
      socketRef.current = nextSocket;
      nextSocket.binaryType = "arraybuffer";
      redeemOnOpen(nextSocket, issued, attempt);
      listenForHostMessages(nextSocket, attempt, () => {
        if (stream.state === "reconnecting") stream.reconnectSucceeded();
        if (stream.state === "rotating") stream.rotationSucceeded();
        setStreamState("streaming");
        setLivePush(true);
        scheduleRotation();
      });
      nextSocket.addEventListener("close", () => {
        if (socket === nextSocket) {
          socket = null;
          socketRef.current = null;
        }
        if (disposed || attempt.signal.aborted) return;
        // A superseded generation may close while the replacement is still
        // becoming ready; dropping here would throw that replacement away.
        if (stream.state === "rotating") return;
        dropLiveAndReconnect();
      });
      nextSocket.addEventListener("error", () => {
        if (disposed || attempt.signal.aborted) return;
        nextSocket.close();
      });
    }

    function connectReplacement(
      issued: Extract<BrowserPanelCapabilityResponse, { outcome: "issued" }>,
    ) {
      if (disposed) return;
      discardReplacement();
      const attempt = new AbortController();
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(streamUrl(issued));
      } catch {
        failRotation();
        return;
      }
      replacementAbort = attempt;
      replacementSocket = nextSocket;
      nextSocket.binaryType = "arraybuffer";
      redeemOnOpen(nextSocket, issued, attempt);
      listenForHostMessages(nextSocket, attempt, () => {
        if (stream.state !== "rotating") {
          discardReplacement();
          return;
        }
        replacementAbort = null;
        replacementSocket = null;
        const previousSocket = socket;
        const previousAttempt = attemptAbort;
        socket = nextSocket;
        socketRef.current = nextSocket;
        attemptAbort = attempt;
        stream.rotationSucceeded();
        setStreamState("streaming");
        setLivePush(true);
        scheduleRotation();
        previousAttempt?.abort();
        if (previousSocket !== null && previousSocket !== nextSocket) {
          previousSocket.close();
        }
      });
      nextSocket.addEventListener("close", () => {
        if (disposed || attempt.signal.aborted) return;
        if (socket === nextSocket) {
          socket = null;
          socketRef.current = null;
          dropLiveAndReconnect();
          return;
        }
        failRotation();
      });
      nextSocket.addEventListener("error", () => {
        if (disposed || attempt.signal.aborted) return;
        nextSocket.close();
      });
    }

    connect(capability);

    return () => {
      disposed = true;
      discardReplacement();
      abortAttempt();
      setLivePush(false);
      clearReconnect();
      clearRotation();
      stream.release();
      streamRef.current = null;
      if (socket !== null) {
        socket.close();
        socket = null;
      }
    };
  }, [capability?.outcome, ownerSessionId, panelId, rpc]);

  // Render the stream surface whenever the panel is authorized to stream. The
  // region always carries the Automation Mode policy text so spectators see the
  // viewport bounds and FPS window regardless of the live connection state.
  function sendStream(message: PanelProtocolMessage) {
    const adapter = streamRef.current;
    if (
      adapter !== null &&
      (adapter.state === "input-frozen" ||
        adapter.state === "reconnecting" ||
        adapter.state === "released")
    ) {
      return;
    }
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const encoded = encodePanelProtocolMessage(message);
    if (encoded.outcome === "encoded") socket.send(encoded.raw);
  }

  function handleContext(event: React.MouseEvent<HTMLCanvasElement>) {
    // The controller opens common link/image actions without native Chrome
    // context menus. Translate the canvas point to the shared logical
    // viewport and ask the host which actions apply there.
    event.preventDefault();
    if (!isController) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const point = browserPagePoint(canvas, event.clientX, event.clientY);
    if (point === null) return;
    const { x, y } = point;
    const queryId = `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    sendStream({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "context_query",
      queryId,
      x,
      y,
    });
  }

  function respondToDialog(accept: boolean, text?: string) {
    if (dialog === null) return;
    sendStream({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "dialog_response",
      dialogId: dialog.dialogId,
      accept,
      ...(text === undefined ? {} : { text }),
    });
    setDialog(null);
  }

  async function chooseContextAction(action: BrowserContextAction) {
    if (!isController || !livePush) return;
    setContextMenu(null);
    setContextError(null);
    if (action.kind === "copy-link" || action.kind === "copy-image-address") {
      try {
        await navigator.clipboard.writeText(action.targetUrl);
      } catch {
        setContextError(
          "Could not copy the address. Check this site's clipboard permission in your browser.",
        );
      }
      return;
    }
    sendStream({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "context_action",
      actionId: action.actionId,
    });
  }

  /**
   * Cancel a quarantined download through the low-latency panel transport
   * (issue #20). Exports go through the server RPC because they resolve BB
   * environments; cancellation is controller-gated like transfer cancellation.
   */
  function cancelDownload(downloadId: string) {
    if (!isController) return;
    sendStream({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "download_cancel",
      downloadId,
    });
  }

  /**
   * P2 (issue #20 findings): export a quarantined download to the displaying
   * client through the existing server RPC. The bytes leave quarantine only on
   * this explicit owner decision and are saved in the browser as a download.
   */
  async function exportDownloadToClient(downloadId: string) {
    if (!isController || status.hostId === null) return;
    setExportError(null);
    setExportInFlightDownloadId(downloadId);
    try {
      const outcome = await rpc.call("browser_download_export_client", {
        hostId: status.hostId,
        downloadId,
        ...(status.profileId === undefined
          ? {}
          : { profileId: status.profileId }),
      });
      if (outcome.outcome !== "exported") {
        setExportError(
          outcome.outcome === "rejected"
            ? `Export rejected: ${outcome.reason}.`
            : "Export failed.",
        );
        return;
      }
      saveExportedBytes(outcome.safeName, outcome.contentType, outcome.data);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExportInFlightDownloadId(null);
    }
  }

  useEffect(() => {
    onLiveChange?.(livePush);
  }, [livePush, onLiveChange]);

  const inputSequence = useRef(1);
  const inputEnabled = isController && livePush && streamState === "streaming";
  useBrowserPageInput(canvasRef, textInputRef, inputEnabled, (payload) => {
    if (!isController) return;
    sendStream({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "input",
      sequence: inputSequence.current++,
      payload,
    });
  });

  // The page fills the panel. What used to sit around it — the streaming
  // policy and the version-one screen-reader limitation — is still announced,
  // but only to assistive technology: it is a disclosure the owner needs once,
  // not three paragraphs standing between them and the page (issue #17
  // disclosure, issue #50 layout).
  return (
    <section
      aria-label="Browser page"
      className="relative h-full min-h-0 w-full focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring"
      // The host's attention color, used for nothing else on the panel: the
      // owner's authenticated session is being driven by something that is
      // not them.
      style={
        agentDriven
          ? { boxShadow: "inset 0 0 0 2px var(--attention)" }
          : undefined
      }
    >
      <p className="sr-only">
        This browser streams the page as pixels between 5 and 15 frames per
        second, up to 1920×1080. Input is owner-gated and freezes immediately on
        disconnect. {BROWSER_PANEL_STREAM_DISCLOSURE}
        Click the page to type. Press Shift+Escape to leave page input.
      </p>
      <textarea
        ref={textInputRef}
        aria-label="Browser page keyboard input"
        tabIndex={-1}
        disabled={!inputEnabled}
        className="absolute left-0 top-0 h-px w-px opacity-0"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {capability?.outcome === "issued" ? (
        <canvas
          ref={canvasRef}
          aria-label="Browser page view"
          role="img"
          tabIndex={inputEnabled ? 0 : -1}
          width={controllerViewport?.width ?? PANEL_MAX_VIEWPORT_WIDTH}
          height={controllerViewport?.height ?? PANEL_MAX_VIEWPORT_HEIGHT}
          className="h-full w-full bg-muted object-contain"
          onContextMenu={handleContext}
        />
      ) : null}
      <p
        className={
          streamState === "streaming"
            ? "sr-only"
            : "absolute inset-x-0 top-0 border-b bg-background p-2 text-sm"
        }
        aria-live="polite"
      >
        {browserPanelRecoveryAnnouncement(streamState)}
      </p>
      {dialog === null ? null : (
        <PanelDialogLayer
          key={dialog.dialogId}
          dialog={dialog}
          isController={isController}
          reducedMotion={reducedMotion}
          onRespond={respondToDialog}
          onClose={() => setDialog(null)}
        />
      )}
      {contextMenu === null ? null : (
        <PanelContextMenu
          actions={contextMenu.actions}
          point={contextMenu.point}
          isController={isController}
          reducedMotion={reducedMotion}
          onChoose={chooseContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
      {contextError === null ? null : (
        <p
          role="alert"
          className="absolute inset-x-0 top-0 border-b bg-background p-2 text-sm"
        >
          {contextError}
        </p>
      )}
      {downloads.length === 0 ? null : (
        // Downloads appear only once there is one, the way a browser reveals
        // its download shelf, and never as a permanent empty section under the
        // page. Managing them afterwards lives in Browser Settings.
        <div
          className="absolute inset-x-0 bottom-0 overflow-auto border-t bg-background p-2"
          style={{ maxHeight: "50%" }}
        >
          <PanelDownloadsSurface
            downloads={downloads}
            limits={downloadsLimits}
            isController={isController}
            exportState={{
              inFlightDownloadId: exportInFlightDownloadId,
              error: exportError,
            }}
            onCancel={cancelDownload}
            onExportClient={exportDownloadToClient}
          />
        </div>
      )}
    </section>
  );
}

/**
 * How often a panel with no live stream re-reads the shared control state. An
 * agent taking control, and giving it back, has to show up quickly enough that
 * the owner never mistakes agent-driven navigation for their own.
 */
const CONTROL_REFRESH_INTERVAL_MS = 1_000;

/**
 * A panel edge is dragged continuously, and every intermediate size would
 * otherwise re-lay-out the live page. A quarter second is long enough that a
 * drag reports once when it settles, and short enough that the page has
 * re-flowed by the time the owner lets go.
 */
const VIEWPORT_REPORT_DEBOUNCE_MS = 250;

/**
 * Report the panel's own pixel size as the shared viewport it drives while it
 * holds control. The capture then matches what is displayed, instead of the
 * host encoding a full-HD frame that the panel downscales into a thumbnail.
 * The host clamps the request to the streaming ceiling (ADR 0007) and applies
 * a spectator's size only to its own letterbox (ADR 0005), so this reports
 * from every panel and lets the shared session decide what it means.
 */
function usePanelViewportReport({
  status,
  panelId,
  surface,
  onControlState,
}: {
  status: BrowserStatus | null;
  panelId: string;
  surface: React.RefObject<HTMLElement | null>;
  onControlState: (response: BrowserPanelControlResponse) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const bbContext = useBbContext();
  const ownerSessionId = ownerSessionIdFromContext(bbContext);
  const hostId = status?.hostId ?? null;
  const profileId = status?.profileId;

  useEffect(() => {
    const element = surface.current;
    if (
      element === null ||
      hostId === null ||
      profileId === undefined ||
      // A displaying client without ResizeObserver — or a test environment
      // with no layout at all — keeps the host's default viewport rather than
      // reporting a size nothing measured.
      typeof ResizeObserver !== "function"
    ) {
      return;
    }
    const reportedHostId = hostId;
    const reportedProfileId = profileId;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reported: { width: number; height: number } | null = null;

    function report(width: number, height: number) {
      if (disposed || width < 1 || height < 1) return;
      if (reported?.width === width && reported.height === height) return;
      reported = { width, height };
      void rpc
        .call("browser_panel_control", {
          hostId: reportedHostId,
          profileId: reportedProfileId,
          panelId,
          ownerSessionId,
          viewport: { width, height },
        })
        .then((response) => {
          if (!disposed && !isPanelIdentityRejection(response)) {
            onControlState(response);
          }
        })
        .catch(() => {
          // A viewport report is advisory: the shared session keeps its last
          // size, and the next resize reports again.
          reported = null;
        });
    }

    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box === undefined) return;
      const width = Math.round(box.width);
      const height = Math.round(box.height);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        report(width, height);
      }, VIEWPORT_REPORT_DEBOUNCE_MS);
    });
    observer.observe(element);
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, [rpc, surface, hostId, profileId, panelId, ownerSessionId, status?.state]);
}

/**
 * Join the shared control session for this profile and expose the transfers
 * the owner can make (issue #16, ADR 0012). Every Browser Panel for one
 * profile observes one coordinated state: a controller and view-only
 * spectators, the controller's logical viewport, the live agent-purpose
 * indicator, and one shared ordered tab strip with one active tab. A spectator
 * cannot send browser input until the owner explicitly chooses Take control;
 * transfer is atomic and visible to every panel.
 */
function usePanelControlSession({
  status,
  panelId,
  control,
  setControl,
  streamIsLive,
}: {
  status: BrowserStatus | null;
  panelId: string;
  control: BrowserPanelControlResponse | null;
  setControl: (response: BrowserPanelControlResponse | null) => void;
  /**
   * Whether the stream is pushing control state to this panel. When it is not,
   * the panel asks instead: an agent taking or giving back control has to be
   * visible here, or the border and purpose would describe a session that
   * ended.
   */
  streamIsLive: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const bbContext = useBbContext();
  const ownerSessionId = ownerSessionIdFromContext(bbContext);
  const [transferPending, setTransferPending] = useState(false);

  // The first panel becomes the controller; later panels are view-only
  // spectators. Repeated launches and reconnects never create duplicate
  // controllers because the panel id is stable.
  const hostId = status?.hostId ?? null;
  const profileId = status?.profileId;
  useEffect(() => {
    if (status === null || status.state !== "healthy" || hostId === null) {
      // The shared session outlives a sleep: dropping it here would empty the
      // tab strip and draw the new-tab surface over the frame the panel is
      // deliberately still showing.
      if (status === null || !browserStateIsSettling(status.state)) {
        setControl(null);
      }
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const join = () => {
      void rpc
        .call("browser_panel_control", {
          hostId,
          profileId: status.profileId,
          panelId,
          ownerSessionId,
        })
        .then((response) => {
          if (!disposed && !isPanelIdentityRejection(response)) {
            setControl(response);
          }
        })
        .catch(() => {
          if (!disposed) setControl(null);
        })
        .finally(() => {
          if (disposed || streamIsLive) return;
          timer = setTimeout(join, CONTROL_REFRESH_INTERVAL_MS);
        });
    };
    join();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    rpc,
    status?.state,
    hostId,
    profileId,
    panelId,
    ownerSessionId,
    streamIsLive,
  ]);

  async function transfer(take: boolean) {
    if (hostId === null || profileId === undefined) return null;
    setTransferPending(true);
    try {
      const response = take
        ? await rpc.call("browser_panel_take_control", {
            hostId,
            profileId,
            panelId,
            ownerSessionId,
          })
        : await rpc.call("browser_panel_release_control", {
            hostId,
            profileId,
            panelId,
            ownerSessionId,
          });
      if (isPanelIdentityRejection(response)) return null;
      setControl(response);
      return response;
    } finally {
      setTransferPending(false);
    }
  }

  // A disconnected controller that reconnects stays view-only until it
  // explicitly reclaims within its 10-second window; the reclaim RPC is the
  // explicit action that re-grants input without silently re-granting it on
  // reconnect.
  async function reclaim() {
    if (hostId === null || profileId === undefined) return null;
    setTransferPending(true);
    try {
      const response = await rpc.call("browser_panel_reclaim_control", {
        hostId,
        profileId,
        panelId,
        ownerSessionId,
      });
      if (isPanelIdentityRejection(response)) return null;
      setControl(response);
      return response;
    } finally {
      setTransferPending(false);
    }
  }

  const ownEntry =
    control?.control.panels.find((panel) => panel.panelId === panelId) ?? null;
  // The reclaim window is live while the deadline is in the future. The host
  // clock drives the deadline, so compare against the observed value only to
  // decide which explicit action to surface.
  const canReclaim =
    control?.role !== "controller" &&
    ownEntry?.reclaimUntil !== undefined &&
    ownEntry?.reclaimUntil !== null &&
    ownEntry.reclaimUntil > Date.now();

  return {
    transferPending,
    /**
     * Take the session. The same action interrupts an agent that holds
     * control, so the owner never needs a second, differently named button to
     * take their browser back.
     */
    takeControl: () => (canReclaim ? reclaim() : transfer(true)),
    releaseControl: () => void transfer(false),
  };
}

function BrowserPanel({ request }: { request: BrowserStatusInput }) {
  const rpc = useRpc<typeof rpcContract>();
  const ownerSessionId = ownerSessionIdFromContext(useBbContext());
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [selectedHostId, setSelectedHostId] = useState(request.hostId);
  const [hostChoices, setHostChoices] = useState<BrowserHostChoice[]>([]);
  const [profiles, setProfiles] = useState<BrowserProfileInventory | null>(
    null,
  );
  const [grantRequests, setGrantRequests] = useState<BrowserGrantRequest[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [rawLocalhost, setRawLocalhost] = useState(false);
  /**
   * Where the last navigation this panel drove ended up, remembered against
   * the Browser Tab it happened in. The shared tab strip is the real answer —
   * it is what an agent or another panel moved — but it arrives on the
   * control-state poll, so this covers the gap between the owner pressing
   * Enter and the strip catching up. Tying it to a tab is what stops it
   * outliving the page: switching tabs or opening a new one shows that tab's
   * address, never the last one this panel asked for.
   */
  const [lastNavigation, setLastNavigation] = useState<{
    tabId: string | null;
    url: string;
  } | null>(null);
  const [showStatusDetail, setShowStatusDetail] = useState(false);
  // The question a decision is in flight for, keyed the way the panel groups
  // them, so a second click cannot answer the same question twice.
  const [accessDecision, setAccessDecision] = useState<string | null>(null);
  // Whether the stream is pushing control state to this panel, or the panel has
  // to ask for it.
  const [streamIsLive, setStreamIsLive] = useState(false);
  const [panelId] = useState(() => `browser-panel-${nextBrowserPanelId++}`);
  const reducedMotion = usePrefersReducedMotion();
  // The page surface is measured, not guessed: its size is the viewport this
  // panel asks the host to capture while it holds control.
  const pageSurfaceRef = useRef<HTMLDivElement | null>(null);
  // Shared control state lifted so the stream's live control broadcasts keep
  // the toolbar and tab strip current without re-fetching (ADR 0012).
  const [control, setControl] = useState<BrowserPanelControlResponse | null>(
    null,
  );
  // The shared tab strip is tracked separately from the control state because
  // the owner's own tab actions answer with a newer strip than the last
  // control broadcast carried.
  const [tabStrip, setTabStrip] = useState<BrowserTabStrip | null>(null);

  const statusRequest: BrowserStatusInput =
    selectedHostId === undefined
      ? { ...request, profileSelection: "selected" }
      : {
          ...request,
          hostId: selectedHostId,
          profileSelection: "selected",
        };

  function profileContext() {
    return request.surface === "thread"
      ? { threadId: request.threadId }
      : { projectId: request.projectId };
  }

  /**
   * Shared control (who drives, viewport, agent purpose) without touching the
   * tab strip. Viewport reports and a join that races a tab switch must not
   * put the previous tab back.
   */
  function applyControlSession(response: BrowserPanelControlResponse | null) {
    setControl(response);
  }

  /**
   * Live session snapshot: control and the shared tab strip together. Stream
   * pushes and tab actions are the sources that may change which tab is on
   * screen.
   */
  function applySessionSnapshot(response: BrowserPanelControlResponse | null) {
    setControl(response);
    setTabStrip(response === null ? null : response.tabs);
  }

  const controlSession = usePanelControlSession({
    status,
    panelId,
    control,
    setControl: streamIsLive ? applyControlSession : applySessionSnapshot,
    streamIsLive,
  });
  usePanelViewportReport({
    status,
    panelId,
    surface: pageSurfaceRef,
    onControlState: applyControlSession,
  });

  useEffect(() => {
    const currentStatus = status;
    const hostId = currentStatus?.hostId;
    if (currentStatus === null || hostId === undefined || hostId === null) {
      setGrantRequests([]);
      return;
    }

    let disposed = false;
    let refreshGeneration = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = async () => {
      const generation = ++refreshGeneration;
      try {
        const requests = await rpc.call("browser_grant_requests", {
          hostId,
          profileId: currentStatus.profileId,
        });
        if (disposed || generation !== refreshGeneration) return;
        setGrantRequests(requests);
      } catch (error: unknown) {
        if (disposed || generation !== refreshGeneration) return;
        setProfileError(administrationErrorMessage(error));
      }
      if (disposed || generation !== refreshGeneration) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, GRANT_REQUEST_REFRESH_INTERVAL_MS);
    };

    const refreshOnFocus = () => {
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      void refresh();
    };

    void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      disposed = true;
      refreshGeneration += 1;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [rpc, status?.hostId, status?.profileId]);

  useEffect(() => {
    setStatus(null);
    void rpc.call("browser_status", statusRequest).then(setStatus);
  }, [request, selectedHostId, rpc]);

  useEffect(() => {
    if (status === null) return;
    const hostId = status.hostId;
    // The panel stays pinned for exactly the states that keep a browser on
    // screen: healthy, plus the sleeping and waking ones it is waiting out.
    // Which states those are is the routing table, not a list repeated here.
    if (hostId === null || browserStateReplacesPage(status.state)) {
      return;
    }
    const target = {
      hostId,
      profileId: status.profileId,
      panelId,
      ownerSessionId,
    };
    let mounted = true;
    void rpc
      .call("browser_panel_visibility", { ...target, visibility: "visible" })
      .then((visibilityResponse) => {
        if (!mounted) return;
        if (isPanelIdentityRejection(visibilityResponse)) {
          setProfileError(visibilityResponse.message);
          return;
        }
        setStatus(visibilityResponse);
      })
      .catch((error: unknown) => {
        if (mounted) setProfileError(administrationErrorMessage(error));
      });
    return () => {
      mounted = false;
      void rpc
        .call("browser_panel_visibility", {
          ...target,
          visibility: "hidden",
        })
        .catch((error: unknown) => {
          console.warn("Browser Panel visibility release failed.", error);
        });
    };
  }, [
    panelId,
    rpc,
    ownerSessionId,
    status?.hostId,
    status?.profileId,
    status?.state,
  ]);

  // The panel names the host it is browsing on — on the new-tab surface and in
  // the status detail — so the choices are read for a resolved host too, not
  // only when the owner still has to pick one.
  useEffect(() => {
    if (status === null) {
      setHostChoices([]);
      return;
    }
    void rpc
      .call("browser_host_choices", hostChoicesRequest(request))
      .then(setHostChoices)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }, [request, rpc, status]);

  useEffect(() => {
    const hostId = status?.hostId;
    if (
      hostId === undefined ||
      hostId === null ||
      status?.state === "host-offline"
    ) {
      setProfiles(null);
      return;
    }
    void rpc
      .call("browser_profiles", { hostId, ...profileContext() })
      .then(setProfiles)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }, [rpc, status]);

  function selectProfile(profileId: string) {
    const hostId = status?.hostId;
    if (hostId === null || hostId === undefined) return;
    setProfileError(null);
    void rpc
      .call("browser_profile_select", {
        hostId,
        profileId,
        ...profileContext(),
      })
      .then((inventory) => {
        setProfiles(inventory);
        return rpc.call("browser_status", {
          ...request,
          hostId,
          profileId,
          profileSelection: "selected",
        });
      })
      .then(setStatus)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }

  function navigateTo(input: string) {
    const hostId = status?.hostId;
    const profileId = status?.profileId;
    if (
      hostId === null ||
      hostId === undefined ||
      profileId === undefined ||
      input.trim() === ""
    ) {
      return;
    }
    setProfileError(null);
    void rpc
      .call("browser_navigate", {
        ...request,
        hostId,
        profileId,
        panelId,
        input,
        rawLocalhost,
      })
      .then((response) => {
        if (isPanelIdentityRejection(response)) {
          setProfileError(response.message);
          return;
        }
        setLastNavigation({
          tabId: response.tabId ?? null,
          url: response.address.url,
        });
      })
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }

  function navigateHistory(direction: "back" | "forward" | "reload") {
    const hostId = status?.hostId;
    const profileId = status?.profileId;
    if (hostId === null || hostId === undefined || profileId === undefined) {
      return;
    }
    setProfileError(null);
    void rpc
      .call("browser_history", {
        ...request,
        hostId,
        profileId,
        panelId,
        direction,
      })
      .then((response) => {
        if (isPanelIdentityRejection(response)) {
          setProfileError(response.message);
          return;
        }
        setLastNavigation({
          tabId: response.tabId ?? null,
          url: response.address.url,
        });
      })
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }

  /**
   * An answered question is not a question any more, so it leaves the panel at
   * once rather than at the next refresh.
   */
  function forgetAccessRequests(requestIds: readonly string[]) {
    setGrantRequests((current) =>
      current.filter((request) => !requestIds.includes(request.requestId)),
    );
  }

  /**
   * Answer a site-access question. Allowing a plain origin grants this project
   * that one site for good — the same decision `bb browser approve` makes —
   * while a request that also asks for an extra permission is allowed for an
   * hour, because persisting an elevated permission takes the second, typed
   * confirmation that lives in Browser Settings.
   */
  function decideAccessRequest(
    request: BrowserAccessRequest,
    decision: "deny" | "allow",
  ) {
    const persist = decision === "allow" && request.elevations.length === 0;
    setAccessDecision(browserAccessRequestKey(request));
    setProfileError(null);
    void Promise.all(
      request.requestIds.map((requestId) =>
        rpc.call("browser_grant_request_decide", {
          requestId,
          decision:
            decision === "deny" ? "deny" : persist ? "persist" : "one-hour",
          ...(persist
            ? {
                persistenceConfirmation:
                  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
              }
            : {}),
        }),
      ),
    )
      .then(() => forgetAccessRequests(request.requestIds))
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      )
      .finally(() => setAccessDecision(null));
  }

  function allowAccessRequest(request: BrowserAccessRequest) {
    decideAccessRequest(request, "allow");
  }

  function denyAccessRequest(request: BrowserAccessRequest) {
    decideAccessRequest(request, "deny");
  }

  /**
   * Stop being asked: give this project the whole web on this profile, which
   * is exactly what `bb browser trust` does. The narrow request that prompted
   * it is then withdrawn rather than left pending, because a broader grant has
   * already answered it and the panel would otherwise keep asking.
   */
  function trustProjectForAccessRequest(request: BrowserAccessRequest) {
    const hostId = status?.hostId;
    if (hostId === null || hostId === undefined) return;
    // Every site this project was waiting on is covered by the broader grant,
    // so every one of those questions is withdrawn — "stop asking me" means
    // all of them, not the one that happened to be on top.
    const answered = grantRequests
      .filter(
        (pending) =>
          pending.status === "pending" &&
          pending.projectId === request.projectId,
      )
      .map((pending) => pending.requestId);
    setAccessDecision(browserAccessRequestKey(request));
    setProfileError(null);
    void rpc
      .call("browser_grant_create", {
        projectId: request.projectId,
        hostId,
        profileId: status?.profileId ?? DEFAULT_PROFILE_ID,
        originScope: BROWSER_WHOLE_WEB_ORIGIN_SCOPE,
        wholeWeb: true,
        fileTransfer: false,
        invalidCertificateOrigins: [],
        persistentElevations: true,
        persistenceConfirmation: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
      })
      .then(() =>
        Promise.all(
          answered.map((requestId) =>
            rpc.call("browser_grant_request_revoke", { requestId }),
          ),
        ),
      )
      .then(() => forgetAccessRequests(answered))
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      )
      .finally(() => setAccessDecision(null));
  }

  /**
   * Drive the shared tab strip. The answer is the whole strip because the tabs
   * belong to the browser rather than to this panel, so a tab opened here is a
   * tab every panel on this browser now has.
   */
  function driveTabs(action: BrowserTabAction, tabId?: string) {
    const hostId = status?.hostId;
    const profileId = status?.profileId;
    if (hostId === null || hostId === undefined || profileId === undefined) {
      return;
    }
    setProfileError(null);
    void rpc
      .call("browser_tab_action", {
        ...request,
        hostId,
        profileId,
        panelId,
        action,
        ...(tabId === undefined ? {} : { tabId }),
      })
      .then((response) => {
        if (isPanelIdentityRejection(response)) {
          setProfileError(response.message);
          return;
        }
        setTabStrip(response);
      })
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }

  if (status === null) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Checking Browser setup…
      </div>
    );
  }

  const hostName =
    hostChoices.find((choice) => choice.hostId === status.hostId)?.name ?? null;
  const view = presentBrowserPanel({
    status,
    control,
    panelId,
    grantRequests,
    hostName,
    tabStrip,
    lastNavigation,
    rawLocalhost,
    transferPending: controlSession.transferPending,
    showStatusDetail,
  });
  const sessionOptions = attachPresentedOptions(view.options, {
    takeControl: controlSession.takeControl,
    releaseControl: controlSession.releaseControl,
    setRawLocalhost,
  });

  if (view.replacesPage) {
    // Nothing can be browsed until the host is fixed, so the failure gets the
    // whole panel rather than a line above an empty page.
    return (
      <BrowserBlockedSurface status={status}>
        <ReadinessChecklist status={status} />
        {status.hostId === null && hostChoices.length > 0 ? (
          <PanelHostPicker choices={hostChoices} onChange={setSelectedHostId} />
        ) : null}
        {profiles === null || status.hostId === null ? null : (
          <PanelProfilePicker inventory={profiles} onChange={selectProfile} />
        )}
        {view.showsSafeLoginNotice ? <SafeLoginLimitationsNotice /> : null}
        <BrowserAccessRequestNotices
          requests={view.accessQuestions}
          answering={accessDecision}
          onAllow={allowAccessRequest}
          onDeny={denyAccessRequest}
          onTrustProject={trustProjectForAccessRequest}
        />
        {profileError === null ? null : <p role="alert">{profileError}</p>}
      </BrowserBlockedSurface>
    );
  }
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <BrowserToolbar
        status={status}
        navigation={{
          address: view.address,
          focusAddress: view.showsNewTabSurface,
          onSubmit: navigateTo,
          onHistory: navigateHistory,
        }}
        control={{
          role: view.role,
          spectatorCount: view.spectatorCount,
          agentPurpose: view.agentPurpose,
          onTakeControl: controlSession.takeControl,
        }}
        options={sessionOptions}
        reducedMotion={reducedMotion}
        statusHint={view.statusHint}
        onStatusSelect={() => setShowStatusDetail((shown) => !shown)}
      />
      <BrowserTabStripView
        tabs={tabStrip?.tabs ?? []}
        activeTabId={tabStrip?.activeTabId ?? null}
        canDrive={view.canDrive}
        onSelect={(tabId) => {
          void (async () => {
            if (!view.canDrive) {
              const next = await controlSession.takeControl();
              if (next?.role !== "controller") return;
            }
            driveTabs("activate", tabId);
          })();
        }}
        onClose={(tabId) => driveTabs("close", tabId)}
        onOpen={() => driveTabs("open")}
      />
      <BrowserAccessRequestNotices
        requests={view.accessQuestions}
        answering={accessDecision}
        onAllow={allowAccessRequest}
        onDeny={denyAccessRequest}
        onTrustProject={trustProjectForAccessRequest}
      />
      {profileError === null ? null : (
        <p role="alert" className="px-2 py-1 text-xs">
          {profileError}
        </p>
      )}
      {profiles === null || status.hostId === null ? null : (
        // Issue #50 keeps profile selection out of the visible chrome. The
        // picker stays in the tree so a reconnecting panel can still run the
        // in-panel switch path and stop the abandoned profile's reconnect.
        <div hidden>
          <PanelProfilePicker inventory={profiles} onChange={selectProfile} />
        </div>
      )}
      <div ref={pageSurfaceRef} className="relative min-h-0 flex-1">
        <PanelStreamSurface
          status={status}
          panelId={panelId}
          isController={view.canDrive}
          agentDriven={view.agentDriven}
          onControlState={applySessionSnapshot}
          onLiveChange={setStreamIsLive}
        />
        {view.showsNewTabSurface ? (
          <div className="absolute inset-0">
            <BrowserNewTabSurface hostName={hostName} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function attachPresentedOptions(
  options: readonly BrowserPanelOptionDescriptor[],
  handlers: {
    takeControl: () => void;
    releaseControl: () => void;
    setRawLocalhost: (checked: boolean) => void;
  },
): BrowserPanelOption[] {
  return options.map((option) => {
    if (option.kind === "action") {
      return {
        ...option,
        onSelect:
          option.id === "take-control"
            ? handlers.takeControl
            : handlers.releaseControl,
      };
    }
    if (option.kind === "toggle") {
      return { ...option, onChange: handlers.setRawLocalhost };
    }
    return option;
  });
}

function ThreadBrowserPanel({ threadId }: PluginThreadPanelProps) {
  return (
    <BrowserPanel
      request={{ surface: "thread", threadId, profileId: DEFAULT_PROFILE_ID }}
    />
  );
}

function NewThreadBrowserPanel({ projectId }: PluginNewThreadPanelProps) {
  return (
    <BrowserPanel
      request={{
        surface: "new-thread",
        projectId,
        profileId: DEFAULT_PROFILE_ID,
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "browser",
    title: "Browser",
    description:
      "Where the Workspace Browser runs and whether each host is ready.",
    component: BrowserHostsSection,
  });
  app.slots.settingsSection({
    id: "agent-access",
    title: "Agent access",
    description:
      "Which projects may drive each Browser Profile, and requests waiting on you.",
    component: AgentAccessSection,
  });
  app.slots.settingsSection({
    id: "profiles",
    title: "Profiles",
    description:
      "Browser Profiles keep logins on the host. Choose one per host and manage the rest here.",
    component: ProfilesSection,
  });
  app.slots.settingsSection({
    id: "downloads",
    title: "Downloads",
    description:
      "Files the browser saved, quarantined on the host until you export them.",
    component: DownloadsSection,
  });
  app.slots.settingsSection({
    id: "activity",
    title: "Activity",
    description:
      "What agents did with each profile. Owner browsing is never recorded.",
    component: ActivitySection,
  });
  app.slots.settingsSection({
    id: "maintenance",
    title: "Maintenance",
    description:
      "Host setup, backups, and the actions that stop or remove the browser.",
    component: MaintenanceSection,
  });

  app.slots.threadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    component: ThreadBrowserPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Browser", params: panelParams });
    },
  });

  app.slots.experimental_newThreadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    component: NewThreadBrowserPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Browser", params: panelParams });
    },
  });
});
