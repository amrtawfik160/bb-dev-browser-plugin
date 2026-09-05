import { WebSocket } from "ws";
import { browserInputCommand } from "./browser-input.js";
import type { BrowserTabStripStore } from "./browser-tabs.js";
import type { ScreencastFrame, ScreencastSource } from "./panel-transport.js";
import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  type BrowserContextAction,
  type BrowserDialogEvent,
} from "./contracts.js";

/**
 * A CDP-backed screencast source. It connects to the Workspace Browser's
 * loopback CDP endpoint, attaches to the active page target, drives
 * `Page.startScreencast` within the Automation Mode viewport and FPS bounds,
 * decodes `Page.screencastFrame` events into frames, and dispatches forwarded
 * input payloads as CDP `Input.*` commands. It only ever reaches the loopback
 * CDP endpoint the browser runtime owns; it never binds externally.
 */

export type CdpScreencastSourceOptions = {
  tabs?: Pick<BrowserTabStripStore, "snapshot" | "subscribe">;
  /**
   * Resolve the browser-level CDP endpoint (ws://127.0.0.1:<port>) when
   * streaming starts. The browser may not be running when the transport binds,
   * so the endpoint is resolved lazily after redemption.
   */
  resolveEndpoint: () => Promise<string>;
  clock?: { now(): number };
  /**
   * The controller's logical viewport that drives the screencast capture size.
   * Spectators scale and letterbox this exact viewport rather than resizing it
   * independently. Defaults to the supported maximum when unset.
   */
  viewport?: { width: number; height: number };
  /**
   * A new top-level target was created (for example an open-link-new-tab
   * context action). The host enrolls it as a BrowserTab in the shared strip
   * so created targets are normalized into the profile's ordered tab set rather
   * than spawning an untracked window.
   */
  onTargetCreated?: (target: {
    targetId: string;
    url: string;
  }) => void | Promise<void>;
  /**
   * Outcome of a context action the controller triggered. Clipboard actions
   * may fail when the page lacks transient activation or the clipboard
   * permission; the host surfaces the outcome honestly (and discloses the
   * limitation) rather than silently no-op.
   */
  onContextActionResult?: (result: { actionId: string; ok: boolean }) => void;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};
type CdpEvent = { method: string; params?: unknown; sessionId?: string };

const SCREENCAST_FORMAT = "jpeg" as const;
const SCREENCAST_QUALITY = 60;
// Frame acknowledgements provide pacing; capture every available update.
const SCREENCAST_EVERY_NTH_FRAME = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function frameIntervalForFps(fps: number) {
  return Math.round(1000 / Math.max(1, fps));
}

export function createCdpScreencastSource(
  options: CdpScreencastSourceOptions,
): ScreencastSource {
  const resolveEndpoint = options.resolveEndpoint;
  let socket: WebSocket | null = null;
  let nextId = 1;
  let frameSequence = 0;
  let sessionId: string | undefined;
  let activeTargetId: string | undefined;
  let unsubscribeTabs: (() => void) | undefined;
  let switching = Promise.resolve();
  let screencastStarted = false;
  let stopped = false;
  let finishStream: (() => void) | undefined;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let viewport: { width: number; height: number } = options.viewport ?? {
    width: PANEL_MAX_VIEWPORT_WIDTH,
    height: PANEL_MAX_VIEWPORT_HEIGHT,
  };
  function clampScreencastViewport(next: { width: number; height: number }) {
    return {
      width: Math.max(1, Math.min(next.width, PANEL_MAX_VIEWPORT_WIDTH)),
      height: Math.max(1, Math.min(next.height, PANEL_MAX_VIEWPORT_HEIGHT)),
    };
  }
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** Open dialogs keyed by id, so reconnects re-push the still-open event. */
  const openDialogs = new Map<string, BrowserDialogEvent>();
  const dialogListeners = new Set<(event: BrowserDialogEvent) => void>();
  /** Registered context actions keyed by id for later execution. */
  const contextActions = new Map<string, BrowserContextAction>();

  function send(method: string, params: unknown, targetSessionId?: string) {
    return new Promise<unknown>((resolve, reject) => {
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        reject(new Error("The CDP screencast socket is not connected."));
        return;
      }
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      const message: Record<string, unknown> = { id, method, params };
      if (targetSessionId !== undefined) message.sessionId = targetSessionId;
      socket.send(JSON.stringify(message));
    });
  }

  function endConnection() {
    for (const request of pending.values()) {
      request.reject(new Error("The browser stream connection closed."));
    }
    pending.clear();
    finishStream?.();
  }

  async function attachToPage(): Promise<string | undefined> {
    const targets = (await send("Target.getTargets", {})) as {
      targetInfos?: Array<{ type: string; targetId: string }>;
    };
    const selected = options.tabs?.snapshot().activeTabId;
    const page = targets?.targetInfos?.find(
      (entry) =>
        entry.type === "page" &&
        (selected == null || entry.targetId === selected),
    );
    if (page === undefined) return undefined;
    activeTargetId = page.targetId;
    const attached = (await send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as { sessionId?: string };
    if (attached?.sessionId !== undefined) {
      await send("Page.enable", {}, attached.sessionId);
      await send("Page.bringToFront", {}, attached.sessionId);
    }
    return attached?.sessionId;
  }

  async function switchPage() {
    const selected = options.tabs?.snapshot().activeTabId;
    if (stopped || selected === activeTargetId) return;
    const previous = sessionId;
    sessionId = undefined;
    activeTargetId = undefined;
    screencastStarted = false;
    if (captureTimer !== undefined) clearTimeout(captureTimer);
    if (previous !== undefined) {
      await send("Target.detachFromTarget", { sessionId: previous }).catch(
        () => undefined,
      );
    }
    if (selected === null) return;
    sessionId = await attachToPage();
    if (sessionId !== undefined && !stopped) {
      await startScreencast(sessionId);
      screencastStarted = true;
    }
  }

  async function startScreencast(session: string) {
    const clamped = clampScreencastViewport(viewport);
    await send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: clamped.width,
        height: clamped.height,
        deviceScaleFactor: 1,
        mobile: false,
      },
      session,
    );
    await send(
      "Page.startScreencast",
      {
        format: SCREENCAST_FORMAT,
        quality: SCREENCAST_QUALITY,
        maxWidth: clamped.width,
        maxHeight: clamped.height,
        everyNthFrame: SCREENCAST_EVERY_NTH_FRAME,
      },
      session,
    );
  }

  async function handleScreencastFrame(
    params: unknown,
    onFrame: (frame: ScreencastFrame) => void,
    session: string,
  ) {
    if (!isObject(params) || typeof params.data !== "string") return;
    if (typeof params.metadata !== "object" || params.metadata === null) return;
    if (typeof params.sessionId !== "number") return;
    const frame: ScreencastFrame = {
      sequence: ++frameSequence,
      mimeType: "image/jpeg",
      data: Buffer.from(params.data, "base64"),
    };
    onFrame(frame);
    // Acknowledge the actual frame ID after pacing; a synthetic ID stalls CDP.
    const frameId = params.sessionId;
    captureTimer = setTimeout(() => {
      if (!stopped && sessionId === session)
        void send(
          "Page.screencastFrameAck",
          { sessionId: frameId },
          session,
        ).catch(() => undefined);
    }, frameIntervalForFps(PANEL_MAX_FRAMES_PER_SECOND));
  }

  async function dispatchInput(payload: unknown, session: string) {
    const command = browserInputCommand(payload);
    if (command !== null) await send(command.method, command.params, session);
  }

  function mapDialogType(cdType: unknown): BrowserDialogEvent["type"] | null {
    if (cdType === "alert") return "alert";
    if (cdType === "confirm") return "confirm";
    if (cdType === "prompt") return "prompt";
    if (cdType === "beforeunload") return "beforeunload";
    return null;
  }

  function handleDialogOpening(params: unknown) {
    if (!isObject(params)) return;
    const cdType = mapDialogType((params as { type?: unknown }).type);
    if (cdType === null) return;
    const messageText =
      typeof (params as { message?: unknown }).message === "string"
        ? (params as { message: string }).message
        : "";
    const dialogUrl =
      typeof (params as { url?: unknown }).url === "string"
        ? (params as { url: string }).url
        : "about:blank";
    const defaultValue =
      typeof (params as { defaultPrompt?: unknown }).defaultPrompt === "string"
        ? (params as { defaultPrompt: string }).defaultPrompt
        : "";
    const dialogId = `dialog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event: BrowserDialogEvent = {
      dialogId,
      type: cdType,
      message: messageText,
      defaultValue,
      url: dialogUrl,
    };
    openDialogs.set(dialogId, event);
    for (const listener of dialogListeners) listener(event);
  }

  async function inspectElementActions(point: {
    x: number;
    y: number;
  }): Promise<BrowserContextAction[]> {
    if (sessionId === undefined || socket === null) return [];
    const session = sessionId;
    // Find the topmost anchor or image under the viewport point using the
    // page's own layout, then report common link/image actions for it. The
    // element is inspected through the page, never through native Chrome UI.
    const expression = `(() => {
      const els = document.elementsFromPoint(${point.x}, ${point.y}) || [];
      const anchor = els.find((e) => e instanceof HTMLAnchorElement && e.href);
      const image = els.find((e) => e instanceof HTMLImageElement && e.src);
      const out = {};
      if (anchor) { out.link = anchor.href; }
      if (image) { out.image = image.src; }
      return out;
    })()`;
    const result = (await send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      session,
    ).catch(() => undefined)) as
      { result?: { value?: { link?: string; image?: string } } } | undefined;
    const value = result?.result?.value ?? {};
    const actions: BrowserContextAction[] = [];
    if (typeof value.link === "string" && value.link.length > 0) {
      actions.push(
        {
          actionId: "open-link-new-tab",
          kind: "open-link-new-tab",
          label: "Open link in new tab",
          targetUrl: value.link,
        },
        {
          actionId: "copy-link",
          kind: "copy-link",
          label: "Copy link address",
          targetUrl: value.link,
        },
      );
    }
    if (typeof value.image === "string" && value.image.length > 0) {
      actions.push(
        {
          actionId: "open-image-new-tab",
          kind: "open-image-new-tab",
          label: "Open image in new tab",
          targetUrl: value.image,
        },
        {
          actionId: "copy-image-address",
          kind: "copy-image-address",
          label: "Copy image address",
          targetUrl: value.image,
        },
      );
    }
    for (const action of actions) contextActions.set(action.actionId, action);
    return actions;
  }

  async function performContextAction(actionId: string) {
    const action = contextActions.get(actionId);
    if (action === undefined || sessionId === undefined || socket === null)
      return;
    contextActions.delete(actionId);
    const report = options.onContextActionResult;
    if (
      action.kind === "open-link-new-tab" ||
      action.kind === "open-image-new-tab"
    ) {
      // Open the target URL in a new top-level tab and report the created
      // target so the host enrolls it as a BrowserTab in the shared strip
      // (ADR 0005). Created targets are normalized into the profile's ordered
      // tab set rather than spawning an untracked window.
      const created = (await send("Target.createTarget", {
        url: action.targetUrl,
      }).catch(() => undefined)) as { targetId?: string } | undefined;
      let ok = false;
      if (created?.targetId !== undefined) {
        ok = true;
        try {
          await options.onTargetCreated?.({
            targetId: created.targetId,
            url: action.targetUrl,
          });
        } catch {
          // The target was created, but the host could not finish enrolling it
          // and reclaiming any retention eviction. Report the incomplete
          // bounded operation instead of silently treating it as success.
          ok = false;
        }
      }
      report?.({ actionId, ok });
      return;
    }
    if (action.kind === "copy-link" || action.kind === "copy-image-address") {
      // Copy through the page so the controller's clipboard carries the URL.
      // Clipboard writes may reject without transient activation or the
      // clipboard permission; surface the outcome honestly rather than swallow
      // it into a silent no-op so the panel can disclose the limitation.
      const ok = await send(
        "Runtime.evaluate",
        {
          expression: `navigator.clipboard.writeText(${JSON.stringify(action.targetUrl)})`,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        },
        sessionId,
      )
        .then(
          (response) =>
            isObject(response) &&
            response.exceptionDetails === undefined &&
            isObject(response.result) &&
            response.result.subtype !== "error",
        )
        .catch(() => false);
      report?.({ actionId, ok });
      return;
    }
  }

  return {
    async start(onFrame, signal) {
      const endpoint = await resolveEndpoint();
      if (stopped || signal.aborted) return;
      socket = new WebSocket(endpoint);
      const connectedSocket = socket;
      const ended = new Promise<void>((resolve) => {
        finishStream = resolve;
      });
      const abortStream = () => {
        connectedSocket.close();
        endConnection();
      };
      connectedSocket.on("close", endConnection);
      connectedSocket.on("error", endConnection);
      signal.addEventListener("abort", abortStream, { once: true });
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            connectedSocket.off("open", open);
            connectedSocket.off("error", error);
            connectedSocket.off("close", close);
          };
          const open = () => {
            cleanup();
            resolve();
          };
          const error = (cause: Error) => {
            cleanup();
            reject(cause);
          };
          const close = () =>
            error(new Error("The browser stream closed before connecting."));
          connectedSocket.once("open", open);
          connectedSocket.once("error", error);
          connectedSocket.once("close", close);
        });
        socket.on("message", (raw) => {
          let message: CdpResponse & CdpEvent;
          try {
            message = JSON.parse(String(raw)) as CdpResponse & CdpEvent;
          } catch {
            return;
          }
          if (typeof message.id === "number") {
            const entry = pending.get(message.id);
            if (entry !== undefined) {
              pending.delete(message.id);
              if (message.error !== undefined) {
                entry.reject(new Error(message.error.message));
              } else {
                entry.resolve(message.result);
              }
            }
            return;
          }
          if (
            message.method === "Page.screencastFrame" &&
            sessionId !== undefined &&
            message.sessionId === sessionId
          ) {
            void handleScreencastFrame(
              message.params,
              onFrame,
              sessionId,
            ).catch(() => undefined);
          }
          if (
            message.method === "Page.javascriptDialogOpening" &&
            sessionId !== undefined &&
            message.sessionId === sessionId
          ) {
            handleDialogOpening(message.params);
          }
        });
        sessionId = await attachToPage();
        if (sessionId !== undefined) {
          await startScreencast(sessionId);
          screencastStarted = true;
        }
        unsubscribeTabs = options.tabs?.subscribe(() => {
          switching = switching.then(switchPage).catch(() => {
            socket?.close();
          });
        });
        if (options.tabs !== undefined) await switchPage();
        await ended;
      } finally {
        signal.removeEventListener("abort", abortStream);
        unsubscribeTabs?.();
        unsubscribeTabs = undefined;
        if (captureTimer !== undefined) clearTimeout(captureTimer);
        connectedSocket.close();
        endConnection();
        socket = null;
        sessionId = undefined;
        stopped = true;
      }
    },
    input(payload) {
      const selected = options.tabs?.snapshot().activeTabId;
      void switching
        .then(async () => {
          if (sessionId === undefined || socket === null || stopped) return;
          if (selected != null && selected !== activeTargetId) return;
          await dispatchInput(payload, sessionId);
        })
        .catch(() => {
          socket?.close();
        });
    },
    /**
     * Apply the controller's logical viewport to the screencast. If the
     * screencast is already running, restart it at the new dimensions so the
     * capture tracks the controller viewport rather than an independent size.
     */
    setViewport(next: { width: number; height: number }) {
      viewport = clampScreencastViewport(next);
      if (screencastStarted && sessionId !== undefined) {
        void startScreencast(sessionId).catch(() => undefined);
      }
    },
    async stop() {
      stopped = true;
      unsubscribeTabs?.();
      unsubscribeTabs = undefined;
      if (captureTimer !== undefined) {
        clearTimeout(captureTimer);
        captureTimer = undefined;
      }
      if (socket !== null && screencastStarted && sessionId !== undefined) {
        await send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
        screencastStarted = false;
      }
      if (socket !== null) {
        socket.close();
        socket = null;
      }
      endConnection();
      openDialogs.clear();
      contextActions.clear();
      dialogListeners.clear();
    },
    subscribeDialogs(onDialog) {
      dialogListeners.add(onDialog);
      // Re-emit any dialog that opened before the transport subscribed so a
      // late subscriber (e.g. a reconnect) still observes the open dialog.
      for (const event of openDialogs.values()) onDialog(event);
      return () => {
        dialogListeners.delete(onDialog);
      };
    },
    respondToDialog(dialogId, accept, text) {
      if (sessionId === undefined || socket === null) return;
      openDialogs.delete(dialogId);
      void send(
        "Page.handleJavaScriptDialog",
        { accept, promptText: text ?? "" },
        sessionId,
      ).catch(() => undefined);
    },
    dismissOpenDialogs() {
      // Fail closed with the safe default per type: cancel/stay (accept:false)
      // for confirm/prompt/beforeunload so an unseen action is never silently
      // confirmed and a beforeunload never silently leaves the page; accept
      // alert (its only button is OK) since it carries no destructive choice.
      if (sessionId === undefined || socket === null) {
        openDialogs.clear();
        return;
      }
      const session = sessionId;
      for (const [dialogId, event] of [...openDialogs.entries()]) {
        openDialogs.delete(dialogId);
        const accept = event.type === "alert";
        void send(
          "Page.handleJavaScriptDialog",
          { accept, promptText: "" },
          session,
        ).catch(() => undefined);
      }
    },
    resolveContextActions(point) {
      return inspectElementActions(point);
    },
    performContextAction(actionId) {
      void performContextAction(actionId).catch(() => undefined);
    },
  };
}
