import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { definePluginApp, useBbContext, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  BROWSER_PANEL_ACCENT_CONTRAST,
  BROWSER_WHOLE_WEB_ORIGIN_SCOPE,
  CLEAR_ACTIVITY_CONFIRMATION,
  DEFAULT_PROFILE_ID,
  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
  RESET_PROFILE_CONFIRMATION,
  STOP_BROWSER_CONFIRMATION,
  BROWSER_PANEL_STREAM_DISCLOSURE,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  type BrowserContextAction,
  type BrowserDialogEvent,
  type BrowserDownloadListingEntry,
  type BrowserDownloadLimits,
  type BrowserDownloadListResult,
  type BrowserHostChoice,
  type BrowserHostChoicesInput,
  type BrowserDiagnostics,
  type BrowserActivityExport,
  type BrowserActivityRecord,
  type BrowserGrantRequest,
  type BrowserPanelCapabilityResponse,
  type BrowserPanelControlResponse,
  type BrowserProfile,
  type BrowserProfileGrant,
  type BrowserProfileInventory,
  type BrowserProfileLifecycleResponse,
  type BrowserProfileRecoveryResponse,
  type BrowserPurgePlan,
  type BrowserSetupPlan,
  type BrowserStatus,
  type BrowserStatusInput,
  type BrowserTabAction,
  type BrowserTab,
  type BrowserTabStrip,
  type rpcContract,
} from "./contracts.js";
import {
  PanelDialogLayer,
  PanelContextMenu,
  PanelDownloadsSurface,
  usePrefersReducedMotion,
} from "./panel-chrome.js";
import {
  BrowserAccessRequestNotices,
  BrowserBlockedSurface,
  BrowserNewTabSurface,
  BrowserTabStripView,
  BrowserToolbar,
  browserAccessRequestKey,
  browserStateIsSettling,
  browserStateReplacesPage,
  isBlankBrowserPage,
  type BrowserAccessRequest,
  type BrowserPanelOption,
} from "./panel-browser.js";
import { ownerSessionIdFromContext } from "./panel-owner-session.js";
import {
  PANEL_PROTOCOL_VERSION,
  decodePanelProtocolMessage,
  encodePanelProtocolMessage,
  type PanelProtocolMessage,
} from "./panel-protocol.js";
import {
  clearPanelTimeout,
  isTestLoopbackPanelTransport,
  schedulePanelTimeout,
} from "./panel-test-loopback.js";
import { SAFE_LOGIN_LIMITATIONS_NOTICE } from "./safe-login-notice.js";
import {
  createAutomationStreamAdapter,
  type PanelStreamAdapter,
} from "./panel-stream.js";

const panelParams = { profileId: DEFAULT_PROFILE_ID } as const;
const GRANT_REQUEST_REFRESH_INTERVAL_MS = 1_000;
let nextBrowserPanelId = 1;

function shouldOpenAuthenticatedPanelStream() {
  if (!isTestEnvironment()) return true;
  return isTestLoopbackPanelTransport();
}

function isTestEnvironment() {
  return (
    typeof import.meta !== "undefined" &&
    typeof (import.meta as { env?: { MODE?: string } }).env === "object" &&
    (import.meta as { env?: { MODE?: string } }).env?.MODE === "test"
  );
}

function ReadinessChecklist({ status }: { status: BrowserStatus }) {
  return (
    <ul
      aria-label="Host readiness checklist"
      className="mt-5 space-y-3 text-left"
    >
      {status.capabilities.map((capability) => (
        <li key={capability.id} className="text-sm text-foreground">
          <span aria-hidden="true">
            {capability.status === "ready" ? "✓" : "–"}
          </span>{" "}
          <strong>{capability.label}</strong>
          <p className="ml-5 text-muted-foreground">{capability.reason}</p>
        </li>
      ))}
    </ul>
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
      <label className="block text-sm" htmlFor="browser-workspace-host">
        Workspace host
      </label>
      <select
        id="browser-workspace-host"
        aria-label="Workspace host"
        className="mt-2 w-full rounded border px-3 py-2 text-sm"
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
  return (
    <div className="mt-5 text-left">
      <label className="block text-sm" htmlFor="browser-profile-selection">
        Browser Profile
      </label>
      <select
        id="browser-profile-selection"
        aria-label="Browser Profile"
        className="mt-2 w-full rounded border px-3 py-2 text-sm"
        value={inventory.selectedProfileId}
        onChange={(event) => onChange(event.target.value)}
      >
        {inventory.profiles.map((profile) => (
          <option key={profile.profileId} value={profile.profileId}>
            {profile.name}
          </option>
        ))}
      </select>
      <p className="mt-2 text-xs text-muted-foreground">
        Locale: {inventory.profiles.find((profile) => profile.selected)?.locale}
        {" · "}
        Timezone:{" "}
        {inventory.profiles.find((profile) => profile.selected)?.timezone}
      </p>
    </div>
  );
}

/**
 * The pending site-access questions this panel can answer. A request that
 * expired, was decided, or was consumed is not a question any more, so it
 * leaves the panel; the full history stays in Browser Settings.
 */
function pendingAccessRequests(
  requests: readonly BrowserGrantRequest[],
): BrowserAccessRequest[] {
  const questions = new Map<string, BrowserAccessRequest>();
  for (const request of requests) {
    if (request.status !== "pending") continue;
    const elevations = [
      request.requestedElevations.fileTransfer ? "file transfer" : null,
      request.requestedElevations.invalidCertificate
        ? "an invalid certificate"
        : null,
    ].filter((elevation): elevation is string => elevation !== null);
    // An agent denied five times on one site asked one question, so the owner
    // is asked it once, and answering it answers every one of them.
    const key = browserAccessRequestKey(request);
    const asked = questions.get(key);
    questions.set(key, {
      requestIds: [...(asked?.requestIds ?? []), request.requestId],
      projectId: request.projectId,
      origin: request.origin,
      elevations: [...new Set([...(asked?.elevations ?? []), ...elevations])],
    });
  }
  return [...questions.values()];
}

/**
 * Save exported client bytes as a browser download so the owner receives the
 * file. Privacy-safe: the bytes are the owner's own quarantined file, and
 * leaving quarantine took an explicit owner decision to get here.
 */
function saveExportedBytes(
  safeName: string,
  contentType: string | null | undefined,
  data: string | undefined,
) {
  if (data === undefined) return;
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  const blob = new Blob([bytes], {
    type: contentType === null ? undefined : (contentType ?? undefined),
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
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
  const [streamState, setStreamState] = useState<
    "connecting" | "streaming" | "reconnecting" | "offline"
  >("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
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
  const streamRef = useRef<PanelStreamAdapter | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [dialog, setDialog] = useState<BrowserDialogEvent | null>(null);
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
  // The per-download error is surfaced inline in the listing (download.error).
  // There is no separate top-level download-error state (issue #20 findings,
  // S4): the previous downloadError state was dead — set but never displayed.
  // P2 (issue #20 findings): export control state. An in-flight download
  // disables its export button; an export failure is shown briefly above the
  // listing.
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
    setStreamState("connecting");
    setStreamError(null);
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
          setStreamError(response.message);
          return;
        }
        setCapability(response);
        // The capability is redeemed in the first WebSocket message rather than
        // placed in a URL. The panel never opens the loopback gateway directly;
        // BB Connect's owner-session gate carries the opaque single-use secret.
        // The public lifecycle seam keeps connecting until that redeem produces
        // a ready state over the real loopback transport.
        if (!isTestLoopbackPanelTransport()) setStreamState("streaming");
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setStreamState("offline");
        setStreamError(
          error instanceof Error ? error.message : "Browser transport failed.",
        );
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
  // canvas, and reconnect with bounded backoff on disconnect. Input freezes
  // immediately on disconnect; the same panel has a 10-second reclaim window.
  useEffect(() => {
    if (
      capability?.outcome !== "issued" ||
      !shouldOpenAuthenticatedPanelStream()
    )
      return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof schedulePanelTimeout> | null = null;
    const stream = createAutomationStreamAdapter();
    streamRef.current = stream;
    stream.start();

    function clearReconnect() {
      if (reconnectTimer !== null) {
        clearPanelTimeout(reconnectTimer);
        reconnectTimer = null;
      }
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

    function scheduleReconnect() {
      if (disposed) return;
      const delay = stream.beginReconnect();
      if (delay === 0) {
        setStreamState("offline");
        return;
      }
      setStreamState("reconnecting");
      clearReconnect();
      reconnectTimer = schedulePanelTimeout(() => {
        reconnectTimer = null;
        if (!disposed) connect();
      }, delay);
    }

    function connect() {
      if (disposed) return;
      const issued = capability;
      if (issued?.outcome !== "issued") return;
      // Production reaches the loopback gateway through BB Connect. The public
      // lifecycle seam substitutes that tunnel with the declared loopback port
      // so tests redeem a real Panel Capability without a Connect daemon.
      const url = isTestLoopbackPanelTransport()
        ? `ws://127.0.0.1:${issued.gatewayPort}`
        : `wss://${issued.tunnel.label}.${issued.tunnel.baseDomain}`;
      try {
        socket = new WebSocket(url);
      } catch {
        if (!disposed) scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        if (disposed || socket === null) return;
        const encoded = encodePanelProtocolMessage({
          protocolVersion: PANEL_PROTOCOL_VERSION,
          type: "redeem",
          capabilityId: issued.capabilityId,
          secret: issued.secret,
          ownerSessionId,
          panelId,
        });
        if (encoded.outcome === "encoded") socket.send(encoded.raw);
      });
      socket.addEventListener("message", (event) => {
        if (disposed) return;
        if (typeof event.data !== "string") return;
        const decoded = decodePanelProtocolMessage(event.data, {
          direction: "host-to-client",
          phase: "authenticated",
        });
        if (decoded.outcome === "rejected") {
          stream.freezeInput();
          socket?.close();
          return;
        }
        const message = decoded.message;
        if (message.type === "ready") {
          if (stream.state === "reconnecting") stream.reconnectSucceeded();
          setStreamState("streaming");
          setLivePush(true);
          return;
        }
        if (message.type === "session") {
          // The host pushed the live shared control state and tab strip; derive
          // this panel's own role from the panel list so the surface updates
          // without a re-fetch.
          const own = message.control.panels.find(
            (panel) => panel.panelId === panelId,
          );
          onControlState?.({
            role: own?.role ?? "spectator",
            control: message.control,
            tabs: message.tabs,
          });
          // The controller's viewport drives the capture size; spectators
          // letterbox it. Size the canvas to that viewport so frames map 1:1
          // and CSS scales/letterboxes for the panel.
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
          socket?.close();
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
      socket.addEventListener("close", () => {
        socket = null;
        socketRef.current = null;
        setLivePush(false);
        if (disposed) return;
        // Input freezes immediately on disconnect; reconnect uses bounded
        // backoff driven by the stream adapter.
        stream.freezeInput();
        // Fail closed: clear any open dialog and context menu so a stranded
        // prompt never leaves an invisible modal block. The host re-pushes a
        // still-open dialog after a bounded reconnect succeeds.
        setDialog(null);
        setContextMenu(null);
        scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        if (disposed || socket === null) return;
        socket.close();
      });
    }

    connect();

    return () => {
      disposed = true;
      setLivePush(false);
      clearReconnect();
      stream.release();
      streamRef.current = null;
      if (socket !== null) {
        socket.close();
        socket = null;
      }
    };
  }, [capability, ownerSessionId, panelId]);

  // Render the stream surface whenever the panel is authorized to stream. The
  // region always carries the Automation Mode policy text so spectators see the
  // viewport bounds and FPS window regardless of the live connection state.
  function sendStream(message: PanelProtocolMessage) {
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
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
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

  function chooseContextAction(action: BrowserContextAction) {
    sendStream({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "context_action",
      actionId: action.actionId,
    });
    setContextMenu(null);
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

  // The page fills the panel. What used to sit around it — the streaming
  // policy and the version-one screen-reader limitation — is still announced,
  // but only to assistive technology: it is a disclosure the owner needs once,
  // not three paragraphs standing between them and the page (issue #17
  // disclosure, issue #50 layout).
  return (
    <section
      aria-label="Browser page"
      className="relative h-full min-h-0 w-full"
      style={
        agentDriven
          ? { boxShadow: `inset 0 0 0 3px ${BROWSER_PANEL_ACCENT_CONTRAST}` }
          : undefined
      }
    >
      <p className="sr-only">
        This browser streams the page as pixels between 5 and 15 frames per
        second, up to 1920×1080. Input is owner-gated and freezes immediately on
        disconnect. {BROWSER_PANEL_STREAM_DISCLOSURE}
      </p>
      {capability?.outcome === "issued" ? (
        <canvas
          ref={canvasRef}
          aria-label="Browser page view"
          role="img"
          width={controllerViewport?.width ?? PANEL_MAX_VIEWPORT_WIDTH}
          height={controllerViewport?.height ?? PANEL_MAX_VIEWPORT_HEIGHT}
          className="h-full w-full bg-muted object-contain"
          onContextMenu={handleContext}
        />
      ) : null}
      <p className="sr-only" aria-live="polite">
        {capability?.outcome !== "issued"
          ? (streamError ?? streamStateMessage(streamState))
          : streamState === "streaming"
            ? "The page is live."
            : streamStateMessage(streamState)}
      </p>
      {dialog === null ? null : (
        <PanelDialogLayer
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

function streamStateMessage(
  streamState: "connecting" | "streaming" | "reconnecting" | "offline",
) {
  if (streamState === "connecting") return "Connecting to the browser…";
  if (streamState === "reconnecting") return "Reconnecting to the browser…";
  if (streamState === "streaming") return "The page is live.";
  return "This browser is not connected.";
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
          if (!disposed) onControlState(response);
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
          if (!disposed) setControl(response);
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
    if (hostId === null || profileId === undefined) return;
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
          });
      setControl(response);
    } finally {
      setTransferPending(false);
    }
  }

  // A disconnected controller that reconnects stays view-only until it
  // explicitly reclaims within its 10-second window; the reclaim RPC is the
  // explicit action that re-grants input without silently re-granting it on
  // reconnect.
  async function reclaim() {
    if (hostId === null || profileId === undefined) return;
    setTransferPending(true);
    try {
      const response = await rpc.call("browser_panel_reclaim_control", {
        hostId,
        profileId,
        panelId,
        ownerSessionId,
      });
      setControl(response);
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
    /**
     * A panel with no control state yet is treated as the controller it is
     * about to become: the first panel on a profile always is, and the
     * navigation boundary rejects the request if it turns out not to be.
     */
    isController: control === null || control.role === "controller",
    spectatorCount:
      control === null
        ? 0
        : control.control.panels.filter(
            (panel) => panel.role === "spectator" && panel.panelId !== panelId,
          ).length,
    agentPurpose: control?.control.agentPurpose ?? null,
    transferPending,
    /**
     * Take the session. The same action interrupts an agent that holds
     * control, so the owner never needs a second, differently named button to
     * take their browser back.
     */
    takeControl: () => void (canReclaim ? reclaim() : transfer(true)),
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
   * One place the shared control state lands, whether it arrived from the join
   * RPC, an explicit transfer, or a live broadcast over the stream. The tab
   * strip travels with it, so every panel on this browser shows the same tabs.
   */
  function applyControlState(response: BrowserPanelControlResponse | null) {
    setControl(response);
    setTabStrip(response === null ? null : response.tabs);
  }

  const controlSession = usePanelControlSession({
    status,
    panelId,
    control,
    setControl: applyControlState,
    streamIsLive,
  });
  usePanelViewportReport({
    status,
    panelId,
    surface: pageSurfaceRef,
    onControlState: applyControlState,
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
      .then((nextStatus) => {
        if (mounted) setStatus(nextStatus);
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
      .then(setTabStrip)
      .catch((error: unknown) =>
        setProfileError(administrationErrorMessage(error)),
      );
  }

  const tabs = tabStrip?.tabs ?? [];
  const activeTab =
    tabs.find((tab) => tab.tabId === tabStrip?.activeTabId) ?? null;
  const address = omniboxAddress(activeTab, lastNavigation);
  // Nothing to read means nothing to show: the new-tab surface stands in for a
  // page only while the browser has not reached one, so a navigation this
  // panel just drove takes it down without waiting for the strip.
  const showsNewTabSurface = address === "";
  const hostName =
    hostChoices.find((choice) => choice.hostId === status?.hostId)?.name ??
    null;
  const sessionOptions: BrowserPanelOption[] = [
    controlSession.isController
      ? {
          kind: "action",
          id: "release-control",
          label: "Let another panel take over",
          description: "Hands this browser to the next panel that asks for it.",
          onSelect: controlSession.releaseControl,
          disabled: controlSession.transferPending,
        }
      : {
          kind: "action",
          id: "take-control",
          label: "Take control",
          onSelect: controlSession.takeControl,
          disabled: controlSession.transferPending,
        },
    {
      kind: "toggle",
      id: "raw-localhost",
      label: "Use plain localhost addresses",
      description:
        "Only for sites that reject this project's own localhost name.",
      checked: rawLocalhost,
      onChange: setRawLocalhost,
    },
    {
      kind: "note",
      id: "settings",
      label:
        "Browser profiles, agent access, downloads, and activity are in BB settings under Browser.",
    },
  ];

  if (status === null) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Checking Browser setup…
      </div>
    );
  }
  if (browserStateReplacesPage(status.state)) {
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
        {status.state === "safe-login-elsewhere" ? (
          <SafeLoginLimitationsNotice />
        ) : null}
        <BrowserAccessRequestNotices
          requests={pendingAccessRequests(grantRequests)}
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
          address,
          focusAddress: showsNewTabSurface,
          onSubmit: navigateTo,
          onHistory: navigateHistory,
        }}
        control={{
          role: controlSession.isController ? "controller" : "spectator",
          spectatorCount: controlSession.spectatorCount,
          agentPurpose: controlSession.agentPurpose,
          onTakeControl: controlSession.takeControl,
        }}
        options={sessionOptions}
        reducedMotion={reducedMotion}
        statusHint={showStatusDetail ? hostStatusHint(status, hostName) : null}
        onStatusSelect={() => setShowStatusDetail((shown) => !shown)}
      />
      <BrowserTabStripView
        tabs={tabs}
        activeTabId={tabStrip?.activeTabId ?? null}
        canDrive={controlSession.isController}
        onSelect={(tabId) => driveTabs("activate", tabId)}
        onClose={(tabId) => driveTabs("close", tabId)}
        onOpen={() => driveTabs("open")}
      />
      <BrowserAccessRequestNotices
        requests={pendingAccessRequests(grantRequests)}
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
      <div ref={pageSurfaceRef} className="relative min-h-0 flex-1">
        <PanelStreamSurface
          status={status}
          panelId={panelId}
          isController={controlSession.isController}
          agentDriven={controlSession.agentPurpose !== null}
          onControlState={applyControlState}
          onLiveChange={setStreamIsLive}
        />
        {showsNewTabSurface ? (
          <div className="absolute inset-0">
            <BrowserNewTabSurface hostName={hostName} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the host-status indicator says when the owner asks it. The panel has no
 * way to open a settings section from a panel surface, so the indicator names
 * where the detail lives instead of pretending to navigate there.
 */
function hostStatusHint(status: BrowserStatus, hostName: string | null) {
  const host = hostName ?? "this workspace host";
  const state =
    status.state === "healthy"
      ? `This browser is ready on ${host}.`
      : `${status.label} on ${host}. ${status.message}`;
  return `${state} Browser profiles, agent access, downloads, and activity are in BB settings under Browser.`;
}

/**
 * What the omnibox shows. The tab the browser is on is the truth, because it
 * is what an agent or another panel moved; the navigation this panel drove is
 * only a stand-in for the second or so before the shared strip reports it, and
 * it stands in for exactly the tab it happened in. Anything else and the field
 * would keep naming a page the owner has already left.
 */
function omniboxAddress(
  activeTab: BrowserTab | null,
  lastNavigation: { tabId: string | null; url: string } | null,
) {
  if (activeTab !== null && !isBlankBrowserPage(activeTab.url)) {
    return activeTab.url;
  }
  if (lastNavigation === null) return "";
  const belongsToAnotherTab =
    activeTab !== null &&
    lastNavigation.tabId !== null &&
    lastNavigation.tabId !== activeTab.tabId;
  return belongsToAnotherTab ? "" : lastNavigation.url;
}

function administrationErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Browser administration failed.";
}

function setupStepStatus(step: BrowserSetupPlan["steps"][number]) {
  if (step.state === "completed") return "Complete";
  if (step.state === "failed") return `Failed: ${step.failure}`;
  return "Pending";
}

function purgeTargetLocation(target: BrowserPurgePlan["targets"][number]) {
  if ("path" in target) return target.path;
  if ("scope" in target) return target.scope;
  return target.username;
}

function browserClientLocale() {
  return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

function browserClientTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function ProfileRow({
  profile,
  renameName,
  locale,
  timezone,
  pendingAction,
  onRenameNameChange,
  onLocaleChange,
  onTimezoneChange,
  onRename,
  onSelect,
  onLifecycleComplete,
}: {
  profile: BrowserProfile;
  renameName: string;
  locale: string;
  timezone: string;
  pendingAction: string | null;
  onRenameNameChange: (name: string) => void;
  onLocaleChange: (locale: string) => void;
  onTimezoneChange: (timezone: string) => void;
  onRename: () => void;
  onSelect: () => void;
  onLifecycleComplete: () => void;
}) {
  return (
    <div className="rounded border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong>{profile.name}</strong>
        {profile.selected ? <span>Selected</span> : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {profile.profileId} · Locale: {profile.locale} · Timezone:{" "}
        {profile.timezone}
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="min-w-48 grow text-sm">
          Rename {profile.name}
          <input
            aria-label={"Rename Browser Profile " + profile.name}
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={renameName}
            onChange={(event) => onRenameNameChange(event.target.value)}
          />
        </label>
        <label className="min-w-32 text-sm">
          Locale
          <input
            aria-label={"Locale for Browser Profile " + profile.name}
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={locale}
            onChange={(event) => onLocaleChange(event.target.value)}
          />
        </label>
        <label className="min-w-32 text-sm">
          Timezone
          <input
            aria-label={"Timezone for Browser Profile " + profile.name}
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={timezone}
            onChange={(event) => onTimezoneChange(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null || renameName.trim().length === 0}
          onClick={onRename}
        >
          Rename {profile.name}
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={onRename}
        >
          Save settings {profile.name}
        </button>
        {profile.selected || profile.state === "archived" ? null : (
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            disabled={pendingAction !== null}
            onClick={onSelect}
          >
            Select {profile.name}
          </button>
        )}
      </div>
      <ProfileDestructiveControls
        profile={profile}
        onComplete={onLifecycleComplete}
      />
    </div>
  );
}

function ProfileLifecycleConsequences({
  profile,
}: {
  profile: BrowserProfile;
}) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Archive stops this profile, removes all agent authority immediately, and
        keeps browser state recoverable for 30 days. Reset permanently loses
        credentials. Permanent deletion cannot be undone.
      </p>
      {profile.state === "archived" ? (
        <p className="mt-2 text-sm">Recoverable until {profile.expiresAt}</p>
      ) : null}
    </>
  );
}

function ProfileLifecycleConfirmation({
  profile,
  confirmation,
  onChange,
}: {
  profile: BrowserProfile;
  confirmation: string;
  onChange: (confirmation: string) => void;
}) {
  return (
    <>
      <label className="mt-2 block text-sm">
        Lifecycle confirmation
        <input
          aria-label={`Lifecycle confirmation ${profile.name}`}
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={confirmation}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Reset: <code>{RESET_PROFILE_CONFIRMATION}</code>. Delete: type the exact
        profile name shown above.
      </p>
    </>
  );
}

function ProfileLifecycleAction({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="rounded border px-3 py-2 text-sm"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

type ProfileLifecycleActions = {
  archiveOrRestore: () => void;
  reset: () => void;
  delete: () => void;
};

function ProfileLifecycleActions({
  profile,
  confirmation,
  pending,
  actions,
}: {
  profile: BrowserProfile;
  confirmation: string;
  pending: boolean;
  actions: ProfileLifecycleActions;
}) {
  const active = profile.state === "active";
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <ProfileLifecycleAction
        label={`${active ? "Archive" : "Restore"} ${profile.name}`}
        disabled={pending}
        onClick={actions.archiveOrRestore}
      />
      {active ? (
        <ProfileLifecycleAction
          label={`Reset ${profile.name}`}
          disabled={pending || confirmation !== RESET_PROFILE_CONFIRMATION}
          onClick={actions.reset}
        />
      ) : null}
      <ProfileLifecycleAction
        label={`Permanently delete ${profile.name}`}
        disabled={pending || profile.selected || confirmation !== profile.name}
        onClick={actions.delete}
      />
    </div>
  );
}

function ProfileDestructiveControls({
  profile,
  onComplete,
}: {
  profile: BrowserProfile;
  onComplete: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = { hostId: profile.hostId, profileId: profile.profileId };

  function runLifecycle(
    action: string,
    operation: () => Promise<BrowserProfileLifecycleResponse>,
  ) {
    setPending(action);
    setMessage(`${action} in progress…`);
    setError(null);
    void operation()
      .then((response) => {
        setMessage(`${response.message} ${response.progress.message}`);
        setConfirmation("");
        onComplete();
      })
      .catch((requestError: unknown) => {
        setMessage(null);
        setError(administrationErrorMessage(requestError));
      })
      .finally(() => setPending(null));
  }

  const actions = {
    archiveOrRestore: () =>
      runLifecycle(profile.state === "active" ? "Archive" : "Restore", () =>
        profile.state === "active"
          ? rpc.call("browser_profile_archive", target)
          : rpc.call("browser_profile_restore_archived", target),
      ),
    reset: () =>
      runLifecycle("Reset", () =>
        rpc.call("browser_profile_reset", { ...target, confirmation }),
      ),
    delete: () =>
      runLifecycle("Delete", () =>
        rpc.call("browser_profile_delete", { ...target, confirmation }),
      ),
  };
  return (
    <section
      className="mt-4 border-t pt-3"
      aria-label={`Lifecycle ${profile.name}`}
    >
      <ProfileLifecycleConsequences profile={profile} />
      <ProfileLifecycleConfirmation
        profile={profile}
        confirmation={confirmation}
        onChange={setConfirmation}
      />
      <ProfileLifecycleActions
        profile={profile}
        confirmation={confirmation}
        pending={pending !== null}
        actions={actions}
      />
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

type ProfileSettingsDraft = { locale: string; timezone: string };

function ProfileInventoryView({
  inventory,
  renameNames,
  profileSettings,
  pendingAction,
  onRenameNameChange,
  onLocaleChange,
  onTimezoneChange,
  onRename,
  onSelect,
  onLifecycleComplete,
}: {
  inventory: BrowserProfileInventory;
  renameNames: Record<string, string>;
  profileSettings: Record<string, ProfileSettingsDraft>;
  pendingAction: string | null;
  onRenameNameChange: (profileId: string, name: string) => void;
  onLocaleChange: (profile: BrowserProfile, locale: string) => void;
  onTimezoneChange: (profile: BrowserProfile, timezone: string) => void;
  onRename: (profile: BrowserProfile) => void;
  onSelect: (profile: BrowserProfile) => void;
  onLifecycleComplete: () => void;
}) {
  return (
    <>
      <p className="mt-3 text-sm">Selected: {inventory.selectedProfileId}</p>
      {inventory.profiles.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Default Browser Profile: <code>{inventory.selectedProfileId}</code>
        </p>
      ) : null}
      <div className="mt-3 space-y-3">
        {inventory.profiles.map((profile) => (
          <ProfileRow
            key={profile.profileId}
            profile={profile}
            renameName={renameNames[profile.profileId] ?? profile.name}
            locale={
              profileSettings[profile.profileId]?.locale ?? profile.locale
            }
            timezone={
              profileSettings[profile.profileId]?.timezone ?? profile.timezone
            }
            pendingAction={pendingAction}
            onRenameNameChange={(name) =>
              onRenameNameChange(profile.profileId, name)
            }
            onLocaleChange={(locale) => onLocaleChange(profile, locale)}
            onTimezoneChange={(timezone) => onTimezoneChange(profile, timezone)}
            onRename={() => onRename(profile)}
            onSelect={() => onSelect(profile)}
            onLifecycleComplete={onLifecycleComplete}
          />
        ))}
      </div>
    </>
  );
}

function ProfileCreateForm({
  name,
  locale,
  timezone,
  pending,
  onNameChange,
  onLocaleChange,
  onTimezoneChange,
  onSubmit,
}: {
  name: string;
  locale: string;
  timezone: string;
  pending: boolean;
  onNameChange: (name: string) => void;
  onLocaleChange: (locale: string) => void;
  onTimezoneChange: (timezone: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="mt-5 space-y-2" onSubmit={onSubmit}>
      <h5 className="font-medium">Create a Browser Profile</h5>
      <label className="block text-sm">
        New Browser Profile name
        <input
          aria-label="New Browser Profile name"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Locale
        <input
          aria-label="New Browser Profile locale"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={locale}
          onChange={(event) => onLocaleChange(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Timezone
        <input
          aria-label="New Browser Profile timezone"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={timezone}
          onChange={(event) => onTimezoneChange(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="rounded border px-3 py-2 text-sm"
        disabled={pending || name.trim().length === 0}
      >
        Create Browser Profile
      </button>
    </form>
  );
}

function ProfileControls({
  hostId,
  available,
  onProfileSelected,
}: {
  hostId: string;
  available: boolean;
  onProfileSelected: (hostId: string, profileId: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [inventory, setInventory] = useState<BrowserProfileInventory | null>(
    null,
  );
  const [newName, setNewName] = useState("");
  const [newLocale, setNewLocale] = useState(browserClientLocale);
  const [newTimezone, setNewTimezone] = useState(browserClientTimezone);
  const [renameNames, setRenameNames] = useState<Record<string, string>>({});
  const [profileSettings, setProfileSettings] = useState<
    Record<string, ProfileSettingsDraft>
  >({});
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refreshProfiles() {
    return rpc.call("browser_profiles", { hostId }).then((nextInventory) => {
      setInventory(nextInventory);
      onProfileSelected(hostId, nextInventory.selectedProfileId);
      return nextInventory;
    });
  }

  useEffect(() => {
    if (!available) {
      setInventory(null);
      return;
    }
    void rpc
      .call("browser_profiles", { hostId })
      .then((nextInventory) => {
        setInventory(nextInventory);
        onProfileSelected(hostId, nextInventory.selectedProfileId);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }, [available, hostId, onProfileSelected, rpc]);

  function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingAction("create");
    setError(null);
    void rpc
      .call("browser_profile_create", {
        hostId,
        name: newName,
        locale: newLocale,
        timezone: newTimezone,
      })
      .then(() => refreshProfiles())
      .then(() => setNewName(""))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  function saveProfile(profile: BrowserProfile) {
    setPendingAction(profile.profileId);
    setError(null);
    const settings = profileSettings[profile.profileId] ?? {
      locale: profile.locale,
      timezone: profile.timezone,
    };
    void rpc
      .call("browser_profile_rename", {
        hostId,
        profileId: profile.profileId,
        name: renameNames[profile.profileId] ?? profile.name,
        ...settings,
      })
      .then(() => refreshProfiles())
      .then((nextInventory) => {
        const savedProfile = nextInventory.profiles.find(
          (candidate) => candidate.profileId === profile.profileId,
        );
        if (savedProfile === undefined) return;
        setRenameNames((current) => ({
          ...current,
          [profile.profileId]: savedProfile.name,
        }));
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  function selectProfile(profile: BrowserProfile) {
    setPendingAction(profile.profileId);
    setError(null);
    void rpc
      .call("browser_profile_select", {
        hostId,
        profileId: profile.profileId,
      })
      .then((nextInventory) => {
        setInventory(nextInventory);
        onProfileSelected(hostId, nextInventory.selectedProfileId);
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  function changeRenameName(profileId: string, name: string) {
    setRenameNames((current) => ({ ...current, [profileId]: name }));
  }

  function changeLocale(profile: BrowserProfile, locale: string) {
    setProfileSettings((current) => ({
      ...current,
      [profile.profileId]: {
        locale,
        timezone: current[profile.profileId]?.timezone ?? profile.timezone,
      },
    }));
  }

  function changeTimezone(profile: BrowserProfile, timezone: string) {
    setProfileSettings((current) => ({
      ...current,
      [profile.profileId]: {
        locale: current[profile.profileId]?.locale ?? profile.locale,
        timezone,
      },
    }));
  }

  return (
    <section
      aria-label={"Browser Profiles for host " + hostId}
      className="mt-6 border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Profiles</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Profiles stay on this workspace host. Authenticated browser data never
        enters BB server storage.
      </p>
      {!available ? (
        <p className="mt-3 text-sm">
          Profiles are unavailable while this host is offline.
        </p>
      ) : inventory === null ? (
        <p role="status" className="mt-3 text-sm">
          Loading Browser Profiles…
        </p>
      ) : (
        <>
          <ProfileInventoryView
            inventory={inventory}
            renameNames={renameNames}
            profileSettings={profileSettings}
            pendingAction={pendingAction}
            onRenameNameChange={changeRenameName}
            onLocaleChange={changeLocale}
            onTimezoneChange={changeTimezone}
            onRename={saveProfile}
            onSelect={selectProfile}
            onLifecycleComplete={() => void refreshProfiles()}
          />
          <ProfileCreateForm
            name={newName}
            locale={newLocale}
            timezone={newTimezone}
            pending={pendingAction !== null}
            onNameChange={setNewName}
            onLocaleChange={setNewLocale}
            onTimezoneChange={setNewTimezone}
            onSubmit={createProfile}
          />
        </>
      )}
      <AdministrationFeedback message={null} error={error} />
    </section>
  );
}

type BrowserAdministrationTarget = {
  hostId: string;
  profileId: string;
};

function AdministrationFeedback({
  message,
  error,
}: {
  message: string | null;
  error: string | null;
}) {
  return (
    <>
      {message === null ? null : <p role="status">{message}</p>}
      {error === null ? null : <p role="alert">{error}</p>}
    </>
  );
}

function recoveryProgressText(response: BrowserProfileRecoveryResponse) {
  const { phase, completedBytes, totalBytes, phases } = response.progress;
  return `Progress: ${(phases ?? [phase]).join(" → ")} (${completedBytes}/${totalBytes} bytes)`;
}

const PROFILE_IMPORT_ACTION = ["imp", "ort"].join("");

function recoveryPendingText(
  action: "backup" | "restore" | typeof PROFILE_IMPORT_ACTION,
) {
  const operation =
    action === "backup"
      ? "backup"
      : action === "restore"
        ? "restore"
        : PROFILE_IMPORT_ACTION;
  return `Browser Profile ${operation} in progress…`;
}

function ProfileRecoveryControls({
  target,
  available,
}: {
  target: BrowserAdministrationTarget;
  available: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [archivePath, setArchivePath] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [importName, setImportName] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function showResponse(response: BrowserProfileRecoveryResponse) {
    setMessage(`${response.message} ${recoveryProgressText(response)}`);
  }

  function runRecovery(
    action: "backup" | "restore" | typeof PROFILE_IMPORT_ACTION,
    operation: () => Promise<BrowserProfileRecoveryResponse>,
  ) {
    setPendingAction(action);
    setMessage(recoveryPendingText(action));
    setError(null);
    void operation()
      .then(showResponse)
      .catch((requestError: unknown) => {
        setMessage(null);
        setError(administrationErrorMessage(requestError));
      })
      .finally(() => setPendingAction(null));
  }

  return (
    <section
      aria-label={`Browser Profile recovery for ${target.profileId}`}
      className="border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Profile recovery</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Backups are credential-equivalent and require a stopped profile.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Restore and import also stop before copying and preserve the prior data
        if a copy fails.
      </p>
      {!available ? (
        <p className="mt-3 text-sm">
          Recovery is unavailable while this host is offline.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            Backup or restore archive path
            <input
              aria-label="Browser Profile archive path"
              className="mt-1 block w-full rounded border px-3 py-2 text-sm"
              value={archivePath}
              onChange={(event) => setArchivePath(event.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm"
              disabled={
                pendingAction !== null || archivePath.trim().length === 0
              }
              onClick={() =>
                runRecovery("backup", () =>
                  rpc.call("browser_profile_backup", {
                    ...target,
                    archivePath,
                  }),
                )
              }
            >
              Backup Browser Profile
            </button>
            <button
              type="button"
              className="rounded border px-3 py-2 text-sm"
              disabled={
                pendingAction !== null || archivePath.trim().length === 0
              }
              onClick={() =>
                runRecovery("restore", () =>
                  rpc.call("browser_profile_restore", {
                    ...target,
                    archivePath,
                  }),
                )
              }
            >
              Restore Browser Profile
            </button>
          </div>
          <label className="block text-sm">
            Existing dev-browser profile path
            <input
              aria-label="dev-browser profile path"
              className="mt-1 block w-full rounded border px-3 py-2 text-sm"
              value={sourcePath}
              onChange={(event) => setSourcePath(event.target.value)}
            />
          </label>
          <label className="block text-sm">
            Imported Browser Profile name
            <input
              aria-label="Imported Browser Profile name"
              className="mt-1 block w-full rounded border px-3 py-2 text-sm"
              value={importName}
              onChange={(event) => setImportName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded border px-3 py-2 text-sm"
            disabled={
              pendingAction !== null ||
              sourcePath.trim().length === 0 ||
              importName.trim().length === 0
            }
            onClick={() =>
              runRecovery(PROFILE_IMPORT_ACTION, () =>
                rpc.call("browser_profile_import", {
                  hostId: target.hostId,
                  name: importName,
                  sourcePath,
                }),
              )
            }
          >
            Import dev-browser Profile
          </button>
        </div>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function SetupControls({
  target,
  autoLoad,
}: {
  target: BrowserAdministrationTarget;
  autoLoad: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [setupPlan, setSetupPlan] = useState<BrowserSetupPlan | null>(null);
  const [setupConfirmation, setSetupConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    if (!autoLoad) return;
    void rpc
      .call("browser_setup_plan", target)
      .then(setSetupPlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }, [autoLoad, rpc, target]);

  function loadSetupPlan() {
    setError(null);
    void rpc
      .call("browser_setup_plan", target)
      .then(setSetupPlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function applySetupStep() {
    const stepId = setupPlan?.nextStepId;
    if (stepId === null || stepId === undefined) return;
    setPendingAction(stepId);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_setup", {
        ...target,
        stepId,
        confirmation: setupConfirmation,
      })
      .then((response) => {
        setSetupPlan(response.plan);
        setMessage(response.message);
        setSetupConfirmation("");
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  const nextStep =
    setupPlan === null
      ? undefined
      : setupPlan.steps.find((step) => step.id === setupPlan.nextStepId);

  return (
    <section aria-label={`Browser setup controls for host ${target.hostId}`}>
      <h4 className="font-semibold">Browser setup plan</h4>
      {setupPlan === null ? (
        <button
          type="button"
          className="mt-3 rounded border px-3 py-2 text-sm"
          onClick={loadSetupPlan}
        >
          Show Browser setup plan
        </button>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            State: {setupPlan.state}. Runtime runs as{" "}
            {setupPlan.runtime.runAsUser}
            with the Chrome sandbox required.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Protected storage: <code>{setupPlan.hostStoragePath}</code>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Storage owner: <code>{setupPlan.storageOwner}</code>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Storage permissions: <code>{setupPlan.storageMode}</code>
          </p>
          <ol aria-label="Browser setup steps" className="mt-3 space-y-3">
            {setupPlan.steps.map((step) => (
              <li key={step.id} className="rounded border p-3">
                <p className="font-medium">{step.label}</p>
                <p className="text-sm text-muted-foreground">
                  {step.description}
                </p>
                <p className="mt-1 text-sm">Status: {setupStepStatus(step)}</p>
                <p className="text-sm">
                  Confirmation: <code>{step.confirmationText}</code>
                </p>
              </li>
            ))}
          </ol>
          {nextStep === undefined ? null : (
            <div className="mt-4 space-y-2">
              <label
                className="block text-sm"
                htmlFor={`setup-confirmation-${target.hostId}`}
              >
                Type the confirmation for {nextStep.label}
              </label>
              <input
                id={`setup-confirmation-${target.hostId}`}
                aria-label={`Setup confirmation for ${nextStep.id}`}
                className="w-full rounded border px-3 py-2 text-sm"
                value={setupConfirmation}
                onChange={(event) => setSetupConfirmation(event.target.value)}
              />
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm"
                disabled={pendingAction !== null}
                onClick={applySetupStep}
              >
                Confirm {nextStep.confirmationText}
              </button>
            </div>
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function LifecycleControls({
  target,
}: {
  target: BrowserAdministrationTarget;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  function stopBrowser(action: "disable" | "uninstall") {
    setPendingAction(action);
    setMessage(null);
    setError(null);
    void rpc
      .call(action === "disable" ? "browser_disable" : "browser_uninstall", {
        ...target,
        confirmation,
      })
      .then((response) => setMessage(response.message))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  return (
    <section
      aria-label={`Browser lifecycle controls for host ${target.hostId}`}
    >
      <h4 className="font-semibold">Disable or uninstall Browser</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Both actions stop Browser-owned processes and retain profiles and
        authenticated state.
      </p>
      <label
        className="mt-2 block text-sm"
        htmlFor={`lifecycle-confirmation-${target.hostId}`}
      >
        Type <code>{STOP_BROWSER_CONFIRMATION}</code>
      </label>
      <input
        id={`lifecycle-confirmation-${target.hostId}`}
        aria-label="Browser lifecycle confirmation"
        className="w-full rounded border px-3 py-2 text-sm"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={() => stopBrowser("disable")}
        >
          Disable Browser
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={() => stopBrowser("uninstall")}
        >
          Uninstall Browser
        </button>
      </div>
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function PurgeControls({ target }: { target: BrowserAdministrationTarget }) {
  const rpc = useRpc<typeof rpcContract>();
  const [purgePlan, setPurgePlan] = useState<BrowserPurgePlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function loadPurgePlan() {
    setError(null);
    void rpc
      .call("browser_purge_plan", target)
      .then(setPurgePlan)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function purgeBrowser() {
    if (purgePlan?.state === "purged") return;
    setPending(true);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_purge", { ...target, confirmation })
      .then((response) => {
        setPurgePlan(response.plan);
        setMessage(response.message);
        setConfirmation("");
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPending(false));
  }

  return (
    <section aria-label={`Browser purge controls for host ${target.hostId}`}>
      <h4 className="font-semibold">Destructive purge</h4>
      {purgePlan === null ? (
        <button
          type="button"
          className="mt-3 rounded border px-3 py-2 text-sm"
          onClick={loadPurgePlan}
        >
          Show destructive purge plan
        </button>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            State: {purgePlan.state}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Type exactly: <code>{purgePlan.confirmationText}</code>
          </p>
          <div aria-label="Browser purge targets" className="mt-3 space-y-2">
            {purgePlan.targets.map((purgeTarget) => (
              <div key={purgeTarget.id} className="rounded border p-2 text-sm">
                <strong>{purgeTarget.id}</strong>:{" "}
                {purgeTargetLocation(purgeTarget)}({purgeTarget.state})
              </div>
            ))}
          </div>
          {purgePlan.state === "purged" ? null : (
            <div className="mt-4 space-y-2">
              <label
                className="block text-sm"
                htmlFor={`purge-confirmation-${target.hostId}`}
              >
                Type the destructive confirmation
              </label>
              <input
                id={`purge-confirmation-${target.hostId}`}
                aria-label="Purge confirmation"
                className="w-full rounded border px-3 py-2 text-sm"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              <button
                type="button"
                className="rounded border px-3 py-2 text-sm"
                disabled={pending}
                onClick={purgeBrowser}
              >
                Purge Browser installation
              </button>
            </div>
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

/**
 * Host Downloads management (issue #50). The panel shows a download while it
 * is happening, the way a browser reveals its download shelf; what the owner
 * does with a quarantined file afterwards belongs here, in the one place
 * everything about this browser is managed. Quarantine is unchanged: the bytes
 * stay on the workspace host until this explicit owner decision moves them.
 */
function DownloadControls({
  target,
  available,
}: {
  target: BrowserAdministrationTarget;
  available: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<BrowserDownloadListResult | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function inspectDownloads() {
    setPendingAction("inspect");
    setError(null);
    void rpc
      .call("browser_download_list", target)
      .then(setListing)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  async function exportToClient(downloadId: string) {
    setPendingAction(downloadId);
    setExportError(null);
    try {
      const outcome = await rpc.call("browser_download_export_client", {
        hostId: target.hostId,
        downloadId,
        profileId: target.profileId,
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
    } catch (requestError: unknown) {
      setExportError(administrationErrorMessage(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section
      aria-label={`Browser Host Downloads for ${target.profileId}`}
      className="border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Host Downloads</h4>
      {!available ? (
        <p className="mt-3 text-sm">
          Host Downloads are unavailable while this host is offline.
        </p>
      ) : (
        <>
          <button
            type="button"
            className="mt-3 rounded border px-3 py-2 text-sm"
            disabled={pendingAction !== null}
            onClick={inspectDownloads}
          >
            Inspect Host Downloads
          </button>
          {listing === null ? null : (
            <PanelDownloadsSurface
              downloads={listing.downloads}
              limits={listing.limits}
              isController={true}
              exportState={{
                inFlightDownloadId: pendingAction,
                error: exportError,
              }}
              onExportClient={(downloadId) => void exportToClient(downloadId)}
            />
          )}
        </>
      )}
      <AdministrationFeedback message={null} error={error} />
    </section>
  );
}

function ActivityControls({ target }: { target: BrowserAdministrationTarget }) {
  const rpc = useRpc<typeof rpcContract>();
  const [records, setRecords] = useState<BrowserActivityRecord[] | null>(null);
  const [exported, setExported] = useState<BrowserActivityExport | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reviewActivity() {
    setPendingAction("review");
    setError(null);
    void rpc
      .call("browser_activity_records", target)
      .then(setRecords)
      .finally(() => setPendingAction(null))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function exportActivity() {
    setPendingAction("export");
    setError(null);
    void rpc
      .call("browser_activity_export", target)
      .then((payload) => {
        setExported(payload);
        setRecords(payload.records);
      })
      .finally(() => setPendingAction(null))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  function clearActivity() {
    setPendingAction("clear");
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_activity_clear", { ...target, confirmation })
      .then((response) => {
        setRecords([]);
        setExported(null);
        setConfirmation("");
        setMessage(response.message);
      })
      .finally(() => setPendingAction(null))
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      );
  }

  return (
    <section
      aria-label={`Browser activity controls for host ${target.hostId}`}
      className="border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Activity</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Review only allow-listed metadata retained for 30 days and up to 10,000
        records per profile. Owner browsing is not recorded.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={reviewActivity}
        >
          Review Browser activity
        </button>
        <button
          type="button"
          className="rounded border px-3 py-2 text-sm"
          disabled={pendingAction !== null}
          onClick={exportActivity}
        >
          Export Browser activity
        </button>
      </div>
      <label className="mt-3 block text-sm">
        Type <code>{CLEAR_ACTIVITY_CONFIRMATION}</code> to clear
        <input
          aria-label="Activity clear confirmation"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="mt-3 rounded border px-3 py-2 text-sm"
        disabled={pendingAction !== null}
        onClick={clearActivity}
      >
        Clear Browser activity
      </button>
      {records === null ? null : (
        <pre aria-label="Browser activity records" className="mt-3 text-xs">
          {JSON.stringify(records, null, 2)}
        </pre>
      )}
      {exported === null ? null : (
        <pre aria-label="Browser activity export" className="mt-3 text-xs">
          {JSON.stringify(exported, null, 2)}
        </pre>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function GrantRow({
  grant,
  pendingAction,
  onRevoke,
}: {
  grant: BrowserProfileGrant;
  pendingAction: string | null;
  onRevoke: (grantId: string) => void;
}) {
  return (
    <li className="rounded border p-2 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <code>{grant.grantId}</code>
        <span>{grant.revokedAt === null ? "Active" : "Revoked"}</span>
      </div>
      <p className="mt-1">{grant.originScope}</p>
      <p className="text-xs text-muted-foreground">
        Whole web: {String(grant.wholeWeb)} · File transfer:{" "}
        {String(grant.fileTransfer)}
      </p>
      {grant.invalidCertificateOrigins.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          Invalid certificates: {grant.invalidCertificateOrigins.join(", ")}
        </p>
      )}
      <button
        type="button"
        className="mt-2 rounded border px-3 py-2 text-sm"
        disabled={pendingAction !== null || grant.revokedAt !== null}
        onClick={() => onRevoke(grant.grantId)}
      >
        Revoke Browser Grant {grant.grantId}
      </button>
    </li>
  );
}

type GrantDraft = {
  projectId: string;
  originScope: string;
  wholeWeb: boolean;
  fileTransfer: boolean;
  invalidCertificateOrigin: string;
  persistentElevations: boolean;
  persistenceConfirmation: string;
};

function GrantCreationForm({
  pendingAction,
  onCreate,
}: {
  pendingAction: string | null;
  onCreate: (draft: GrantDraft) => Promise<BrowserProfileGrant | null>;
}) {
  const [projectId, setProjectId] = useState("");
  const [originScope, setOriginScope] = useState("");
  const [invalidCertificateOrigin, setInvalidCertificateOrigin] = useState("");
  const [wholeWeb, setWholeWeb] = useState(false);
  const [fileTransfer, setFileTransfer] = useState(false);
  const [persistentElevations, setPersistentElevations] = useState(false);
  const [persistenceConfirmation, setPersistenceConfirmation] = useState("");

  function submitGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onCreate({
      projectId,
      originScope,
      wholeWeb,
      fileTransfer,
      invalidCertificateOrigin,
      persistentElevations,
      persistenceConfirmation,
    }).then((createdGrant) => {
      if (createdGrant === null) return;
      setOriginScope("");
      setInvalidCertificateOrigin("");
    });
  }

  return (
    <form className="mt-3 space-y-2" onSubmit={submitGrant}>
      <label className="block text-sm">
        Grant project ID
        <input
          aria-label="Grant project ID"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        />
      </label>
      <label className="block text-sm">
        Origin scope
        <input
          aria-label="Grant origin scope"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={originScope}
          onChange={(event) => setOriginScope(event.target.value)}
          disabled={wholeWeb}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Whole-web Browser access"
          checked={wholeWeb}
          onChange={(event) => setWholeWeb(event.target.checked)}
        />
        Whole-web Browser access
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="File transfer elevation"
          checked={fileTransfer}
          onChange={(event) => setFileTransfer(event.target.checked)}
        />
        File transfer elevation
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label="Persistent elevated Browser access"
          checked={persistentElevations}
          onChange={(event) => setPersistentElevations(event.target.checked)}
        />
        Persistent elevated Browser access
      </label>
      {persistentElevations ? (
        <label className="block text-sm">
          Type <code>{PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION}</code> to
          persist elevated access
          <input
            aria-label="Persistent elevation confirmation"
            className="mt-1 block w-full rounded border px-3 py-2 text-sm"
            value={persistenceConfirmation}
            onChange={(event) => setPersistenceConfirmation(event.target.value)}
          />
        </label>
      ) : null}
      <label className="block text-sm">
        Invalid-certificate origin approval
        <input
          aria-label="Invalid-certificate origin approval"
          className="mt-1 block w-full rounded border px-3 py-2 text-sm"
          value={invalidCertificateOrigin}
          onChange={(event) => setInvalidCertificateOrigin(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="rounded border px-3 py-2 text-sm"
        disabled={
          pendingAction !== null ||
          projectId.trim().length === 0 ||
          (!wholeWeb && originScope.trim().length === 0)
        }
      >
        Create Browser Profile Grant
      </button>
    </form>
  );
}

function GrantList({
  grants,
  pendingAction,
  onRevoke,
}: {
  grants: readonly BrowserProfileGrant[];
  pendingAction: string | null;
  onRevoke: (grantId: string) => void;
}) {
  return (
    <ul aria-label="Browser Profile Grant list" className="mt-3 space-y-2">
      {grants.length === 0 ? (
        <li className="text-sm">No active Browser Profile Grants.</li>
      ) : (
        grants.map((grant) => (
          <GrantRow
            key={grant.grantId}
            grant={grant}
            pendingAction={pendingAction}
            onRevoke={onRevoke}
          />
        ))
      )}
    </ul>
  );
}

function GrantControls({
  target,
  available,
}: {
  target: BrowserAdministrationTarget;
  available: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [grants, setGrants] = useState<BrowserProfileGrant[] | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function inspectGrants() {
    setPendingAction("inspect");
    setError(null);
    void rpc
      .call("browser_grants", {
        hostId: target.hostId,
        profileId: target.profileId,
        includeRevoked: false,
      })
      .then(setGrants)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  async function createGrant(
    draft: GrantDraft,
  ): Promise<BrowserProfileGrant | null> {
    setPendingAction("create");
    setMessage(null);
    setError(null);
    try {
      const grant = await rpc.call("browser_grant_create", {
        projectId: draft.projectId,
        hostId: target.hostId,
        profileId: target.profileId,
        originScope: draft.wholeWeb ? "*" : draft.originScope,
        wholeWeb: draft.wholeWeb,
        fileTransfer: draft.fileTransfer,
        invalidCertificateOrigins:
          draft.invalidCertificateOrigin.trim().length === 0
            ? []
            : [draft.invalidCertificateOrigin],
        persistentElevations: draft.persistentElevations,
        persistenceConfirmation: draft.persistenceConfirmation,
      });
      setGrants((current) => [...(current ?? []), grant]);
      setMessage(`Created Browser Grant ${grant.grantId}.`);
      return grant;
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
      return null;
    } finally {
      setPendingAction(null);
    }
  }

  function revokeGrant(grantId: string) {
    setPendingAction(grantId);
    setMessage(null);
    setError(null);
    void rpc
      .call("browser_grant_revoke", { grantId })
      .then((response) => {
        setMessage(`Browser Grant ${response.grantId}: ${response.outcome}.`);
        setGrants(
          (current) =>
            current?.filter((grant) => grant.grantId !== response.grantId) ??
            current,
        );
      })
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  return (
    <section
      aria-label={`Browser Profile Grants for ${target.profileId}`}
      className="border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Profile Grants</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Agent access is denied until this project grants a normalized exact
        origin or explicit subdomain scope. Elevations are independent.
      </p>
      {!available ? (
        <p className="mt-3 text-sm">
          Grants are unavailable while this host is offline.
        </p>
      ) : (
        <>
          <GrantCreationForm
            pendingAction={pendingAction}
            onCreate={createGrant}
          />
          <button
            type="button"
            className="mt-3 rounded border px-3 py-2 text-sm"
            disabled={pendingAction !== null}
            onClick={inspectGrants}
          >
            Inspect Browser Grants
          </button>
          {grants === null ? null : (
            <GrantList
              grants={grants}
              pendingAction={pendingAction}
              onRevoke={revokeGrant}
            />
          )}
        </>
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

type GrantRequestDecision = "deny" | "retry" | "one-hour" | "persist";

const GRANT_REQUEST_DECISIONS: readonly GrantRequestDecision[] = [
  "deny",
  "retry",
  "one-hour",
];

function grantRequestDecisionLabel(
  requestId: string,
  decision: GrantRequestDecision,
) {
  if (decision === "deny") {
    return "Deny Browser Grant Request " + requestId;
  }
  const duration = decision === "retry" ? "one retry" : "one hour";
  return "Approve Browser Grant Request " + requestId + " for " + duration;
}

function GrantRequestDecisionButton({
  requestId,
  decision,
  pendingAction,
  onDecision,
}: {
  requestId: string;
  decision: GrantRequestDecision;
  pendingAction: string | null;
  onDecision: (requestId: string, decision: GrantRequestDecision) => void;
}) {
  return (
    <button
      type="button"
      className="rounded border px-2 py-1"
      disabled={pendingAction !== null}
      onClick={() => onDecision(requestId, decision)}
    >
      {grantRequestDecisionLabel(requestId, decision)}
    </button>
  );
}

function GrantRequestDecisionControls({
  requestId,
  pendingAction,
  onDecision,
}: {
  requestId: string;
  pendingAction: string | null;
  onDecision: (requestId: string, decision: GrantRequestDecision) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {GRANT_REQUEST_DECISIONS.map((decision) => (
        <GrantRequestDecisionButton
          key={decision}
          requestId={requestId}
          decision={decision}
          pendingAction={pendingAction}
          onDecision={onDecision}
        />
      ))}
    </div>
  );
}

function GrantRequestPersistenceControl({
  requestId,
  confirmationText,
  pendingAction,
  onConfirmationChange,
  onDecision,
}: {
  requestId: string;
  confirmationText: string;
  pendingAction: string | null;
  onConfirmationChange: (requestId: string, confirmationText: string) => void;
  onDecision: (requestId: string, decision: GrantRequestDecision) => void;
}) {
  return (
    <div className="space-y-2">
      <label
        className="block text-xs"
        htmlFor={"grant-request-confirm-" + requestId}
      >
        Persistent Browser Grant confirmation {requestId}
      </label>
      <input
        id={"grant-request-confirm-" + requestId}
        aria-label={"Persistent Browser Grant confirmation " + requestId}
        className="w-full rounded border px-2 py-1 text-sm"
        value={confirmationText}
        onChange={(event) =>
          onConfirmationChange(requestId, event.target.value)
        }
      />
      <button
        type="button"
        className="rounded border px-2 py-1"
        disabled={pendingAction !== null}
        onClick={() => onDecision(requestId, "persist")}
      >
        Persist Browser Grant Request {requestId}
      </button>
    </div>
  );
}

function GrantRequestRow({
  request,
  pendingAction,
  confirmationText,
  onConfirmationChange,
  onDecision,
  onRevoke,
}: {
  request: BrowserGrantRequest;
  pendingAction: string | null;
  confirmationText: string;
  onConfirmationChange: (requestId: string, confirmationText: string) => void;
  onDecision: (requestId: string, decision: GrantRequestDecision) => void;
  onRevoke: (requestId: string) => void;
}) {
  const isActionable =
    request.status === "pending" || request.status === "approved";
  return (
    <li className="space-y-2 rounded border p-3 text-sm">
      <p>
        <code>{request.requestId}</code> — <strong>{request.status}</strong>
      </p>
      <p className="text-muted-foreground">{request.origin}</p>
      <p className="text-xs text-muted-foreground">
        Elevations:{" "}
        {request.requestedElevations.fileTransfer
          ? "file transfer"
          : "standard"}{" "}
        {request.requestedElevations.invalidCertificate
          ? "· invalid certificate"
          : ""}
      </p>
      {request.status === "pending" ? (
        <>
          <GrantRequestDecisionControls
            requestId={request.requestId}
            pendingAction={pendingAction}
            onDecision={onDecision}
          />
          <GrantRequestPersistenceControl
            requestId={request.requestId}
            confirmationText={confirmationText}
            pendingAction={pendingAction}
            onConfirmationChange={onConfirmationChange}
            onDecision={onDecision}
          />
        </>
      ) : null}
      {isActionable ? (
        <button
          type="button"
          className="rounded border px-2 py-1"
          disabled={pendingAction !== null}
          onClick={() => onRevoke(request.requestId)}
        >
          Revoke Browser Grant Request {request.requestId}
        </button>
      ) : null}
    </li>
  );
}

function GrantRequestList({
  requests,
  pendingAction,
  confirmations,
  onConfirmationChange,
  onDecision,
  onRevoke,
}: {
  requests: readonly BrowserGrantRequest[];
  pendingAction: string | null;
  confirmations: Readonly<Record<string, string>>;
  onConfirmationChange: (requestId: string, confirmationText: string) => void;
  onDecision: (requestId: string, decision: GrantRequestDecision) => void;
  onRevoke: (requestId: string) => void;
}) {
  return (
    <ul aria-label="Browser Grant Request list" className="mt-3 space-y-2">
      {requests.length === 0 ? (
        <li className="text-sm">No Browser Grant Requests.</li>
      ) : (
        requests.map((request) => (
          <GrantRequestRow
            key={request.requestId}
            request={request}
            pendingAction={pendingAction}
            confirmationText={confirmations[request.requestId] ?? ""}
            onConfirmationChange={onConfirmationChange}
            onDecision={onDecision}
            onRevoke={onRevoke}
          />
        ))
      )}
    </ul>
  );
}

function GrantRequestControls() {
  const rpc = useRpc<typeof rpcContract>();
  const [requests, setRequests] = useState<BrowserGrantRequest[] | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmations, setConfirmations] = useState<Record<string, string>>(
    {},
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function inspectRequests() {
    setPendingAction("inspect");
    setError(null);
    void rpc
      .call("browser_grant_requests", {})
      .then(setRequests)
      .catch((requestError: unknown) =>
        setError(administrationErrorMessage(requestError)),
      )
      .finally(() => setPendingAction(null));
  }

  async function decideRequest(
    requestId: string,
    decision: GrantRequestDecision,
  ) {
    setPendingAction(requestId + ":" + decision);
    setMessage(null);
    setError(null);
    try {
      const response = await rpc.call("browser_grant_request_decide", {
        requestId,
        decision,
        ...(decision === "persist"
          ? {
              persistenceConfirmation: confirmations[requestId] ?? "",
            }
          : {}),
      });
      setRequests(
        (current) =>
          current?.map((request) =>
            request.requestId === requestId ? response.request : request,
          ) ?? current,
      );
      setMessage(requestId + ": " + response.outcome);
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeRequest(requestId: string) {
    setPendingAction(requestId + ":revoke");
    setMessage(null);
    setError(null);
    try {
      const response = await rpc.call("browser_grant_request_revoke", {
        requestId,
      });
      setRequests(
        (current) =>
          current?.map((request) =>
            request.requestId === requestId ? response.request : request,
          ) ?? current,
      );
      setMessage(requestId + ": " + response.outcome);
    } catch (requestError: unknown) {
      setError(administrationErrorMessage(requestError));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section
      aria-label="Browser Grant Requests"
      className="border-t pt-5 text-left"
    >
      <h4 className="font-semibold">Browser Grant Requests</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        Review exact, non-blocking requests created when agent access is denied.
      </p>
      <button
        type="button"
        className="mt-3 rounded border px-3 py-2 text-sm"
        disabled={pendingAction !== null}
        onClick={inspectRequests}
      >
        Inspect Browser Grant Requests
      </button>
      {requests === null ? null : (
        <GrantRequestList
          requests={requests}
          pendingAction={pendingAction}
          confirmations={confirmations}
          onConfirmationChange={(requestId, value) =>
            setConfirmations((current) => ({
              ...current,
              [requestId]: value,
            }))
          }
          onDecision={decideRequest}
          onRevoke={revokeRequest}
        />
      )}
      <AdministrationFeedback message={message} error={error} />
    </section>
  );
}

function HostAdministrationControls({ status }: { status: BrowserStatus }) {
  if (
    status.hostId === null ||
    status.state === "host-offline" ||
    status.state === "unsupported"
  ) {
    return null;
  }

  const target: BrowserAdministrationTarget = {
    hostId: status.hostId,
    profileId: status.profileId,
  };
  return (
    <div className="mt-6 space-y-5 border-t pt-5 text-left">
      <SetupControls
        target={target}
        autoLoad={status.state === "setup-required"}
      />
      <LifecycleControls target={target} />
      <PurgeControls target={target} />
    </div>
  );
}

function BrowserSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [statuses, setStatuses] = useState<BrowserStatus[] | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<
    Record<string, string>
  >({});
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnostics | null>(
    null,
  );

  const handleProfileSelected = useCallback(
    (hostId: string, profileId: string) => {
      setSelectedProfileIds((current) => ({ ...current, [hostId]: profileId }));
    },
    [],
  );

  useEffect(() => {
    void rpc
      .call("browser_settings_status", { profileId: DEFAULT_PROFILE_ID })
      .then(setStatuses);
  }, [rpc]);

  if (statuses === null) {
    return (
      <>
        <p role="status">Checking Browser hosts…</p>
      </>
    );
  }
  if (statuses.length === 0) {
    return (
      <>
        <GrantRequestControls />
        <p>No workspace hosts are enrolled.</p>
      </>
    );
  }
  return (
    <div className="space-y-6">
      <GrantRequestControls />
      {statuses.map((status) => (
        <section key={status.hostId} aria-label={`Host ${status.hostId}`}>
          <h3 className="font-semibold">{status.label}</h3>
          <p className="text-sm text-muted-foreground">{status.message}</p>
          <ReadinessChecklist status={status} />
          {status.hostId === null ? null : (
            <ProfileControls
              hostId={status.hostId}
              available={status.state !== "host-offline"}
              onProfileSelected={handleProfileSelected}
            />
          )}
          {status.hostId === null ? null : (
            <DownloadControls
              target={{
                hostId: status.hostId,
                profileId:
                  selectedProfileIds[status.hostId] ?? status.profileId,
              }}
              available={status.state !== "host-offline"}
            />
          )}
          {status.hostId === null ? null : (
            <ActivityControls
              target={{
                hostId: status.hostId,
                profileId:
                  selectedProfileIds[status.hostId] ?? status.profileId,
              }}
            />
          )}
          {status.hostId === null ? null : (
            <GrantControls
              target={{
                hostId: status.hostId,
                profileId:
                  selectedProfileIds[status.hostId] ?? status.profileId,
              }}
              available={status.state !== "host-offline"}
            />
          )}
          <HostAdministrationControls status={status} />
          {status.hostId === null ? null : (
            <ProfileRecoveryControls
              target={{
                hostId: status.hostId,
                profileId:
                  selectedProfileIds[status.hostId] ?? status.profileId,
              }}
              available={status.state !== "host-offline"}
            />
          )}
          <button
            type="button"
            className="mt-4 rounded border px-3 py-2 text-sm"
            onClick={() => {
              void rpc
                .call("browser_diagnostics", {
                  hostId: status.hostId,
                  profileId: status.profileId,
                })
                .then(setDiagnostics);
            }}
          >
            Generate redacted diagnostics
          </button>
        </section>
      ))}
      {diagnostics === null ? null : (
        <pre
          aria-label="Redacted diagnostics"
          className="overflow-auto text-xs"
        >
          {JSON.stringify(diagnostics, null, 2)}
        </pre>
      )}
    </div>
  );
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
    id: "host-readiness",
    title: "Host readiness",
    description:
      "Review Browser readiness and apply explicitly confirmed host actions.",
    component: BrowserSettings,
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
