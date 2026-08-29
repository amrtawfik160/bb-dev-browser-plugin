import { WebSocket } from "ws";
import type { ScreencastFrame, ScreencastSource } from "./panel-transport.js";
import {
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
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
  /**
   * Resolve the browser-level CDP endpoint (ws://127.0.0.1:<port>) when
   * streaming starts. The browser may not be running when the transport binds,
   * so the endpoint is resolved lazily after redemption.
   */
  resolveEndpoint: () => Promise<string>;
  clock?: { now(): number };
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};
type CdpEvent = { method: string; params?: unknown };

const SCREENCAST_FORMAT = "jpeg" as const;
const SCREENCAST_QUALITY = 60;
// everyNthFrame throttles capture; 1 captures every frame. The runtime adapts
// between 5 and 15 FPS by adjusting this together with the viewport.
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
  let sessionId: string | undefined;
  let screencastStarted = false;
  let stopped = false;
  let captureTimer: ReturnType<typeof setInterval> | undefined;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  function send(method: string, params: unknown, targetSessionId?: string) {
    return new Promise<unknown>((resolve, reject) => {
      if (socket === null) {
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

  async function attachToPage(): Promise<string | undefined> {
    // The browser-level endpoint lists page targets; attach to the first page
    // (the runtime pins the active tab) and return its session id.
    const targets = (await send("Target.getTargets", {})) as {
      targetInfos?: Array<{ type: string; targetId: string }>;
    };
    const page =
      targets?.targetInfos?.find((entry) => entry.type === "page") ??
      targets?.targetInfos?.[0];
    if (page === undefined) return undefined;
    const attached = (await send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as { sessionId?: string };
    return attached?.sessionId;
  }

  async function startScreencast(session: string, fps: number) {
    await send(
      "Page.startScreencast",
      {
        format: SCREENCAST_FORMAT,
        quality: SCREENCAST_QUALITY,
        maxWidth: PANEL_MAX_VIEWPORT_WIDTH,
        maxHeight: PANEL_MAX_VIEWPORT_HEIGHT,
        everyNthFrame: SCREENCAST_EVERY_NTH_FRAME,
      },
      session,
    );
    // CDP does not natively rate-limit by FPS; pace capture acknowledgements
    // to the Automation Mode window so the stream adapts between 5 and 15 FPS.
    const interval = frameIntervalForFps(fps);
    if (captureTimer !== undefined) clearInterval(captureTimer);
    captureTimer = setInterval(() => {
      if (stopped) return;
      void send("Page.screencastFrameAck", { sessionId: 0 }, session).catch(
        () => undefined,
      );
    }, interval);
  }

  async function handleScreencastFrame(
    params: unknown,
    onFrame: (frame: ScreencastFrame) => void,
    session: string,
  ) {
    if (!isObject(params) || typeof params.data !== "string") return;
    if (typeof params.metadata !== "object" || params.metadata === null) return;
    const metadata = params.metadata as { timestamp?: number };
    const frame: ScreencastFrame = {
      sequence: typeof metadata.timestamp === "number" ? metadata.timestamp : 0,
      mimeType: "image/jpeg",
      data: Buffer.from(params.data, "base64"),
    };
    onFrame(frame);
    await send("Page.screencastFrameAck", { sessionId: 0 }, session).catch(
      () => undefined,
    );
  }

  async function dispatchInput(payload: unknown, session: string) {
    if (!isObject(payload) || typeof payload.kind !== "string") return;
    if (payload.kind === "mouse") {
      await send(
        "Input.dispatchMouseEvent",
        {
          type:
            typeof payload.action === "string" ? payload.action : "mouseMoved",
          x: typeof payload.x === "number" ? payload.x : 0,
          y: typeof payload.y === "number" ? payload.y : 0,
          button: typeof payload.button === "string" ? payload.button : "left",
          clickCount: typeof payload.count === "number" ? payload.count : 1,
        },
        session,
      );
      return;
    }
    if (payload.kind === "key") {
      await send(
        "Input.dispatchKeyEvent",
        {
          type: typeof payload.action === "string" ? payload.action : "keyDown",
          key: typeof payload.key === "string" ? payload.key : "",
        },
        session,
      );
      return;
    }
    if (payload.kind === "wheel") {
      await send(
        "Input.dispatchMouseEvent",
        {
          type: "mouseWheel",
          x: typeof payload.x === "number" ? payload.x : 0,
          y: typeof payload.y === "number" ? payload.y : 0,
          deltaX: typeof payload.deltaX === "number" ? payload.deltaX : 0,
          deltaY: typeof payload.deltaY === "number" ? payload.deltaY : 0,
        },
        session,
      );
    }
  }

  return {
    async start(onFrame, signal) {
      const endpoint = await resolveEndpoint();
      if (stopped || signal.aborted) return;
      socket = new WebSocket(endpoint);
      await new Promise<void>((resolve, reject) => {
        const open = () => resolve();
        const error = (error: Error) => reject(error);
        socket!.once("open", open);
        socket!.once("error", error);
        signal.addEventListener(
          "abort",
          () => {
            socket!.off("open", open);
            reject(
              new Error("The CDP screencast was stopped before connecting."),
            );
          },
          { once: true },
        );
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
          sessionId !== undefined
        ) {
          void handleScreencastFrame(message.params, onFrame, sessionId).catch(
            () => undefined,
          );
        }
      });
      sessionId = await attachToPage();
      if (sessionId !== undefined) {
        await startScreencast(sessionId, PANEL_MAX_FRAMES_PER_SECOND);
        screencastStarted = true;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    input(payload) {
      if (sessionId === undefined || socket === null) return;
      const session = sessionId;
      void dispatchInput(payload, session).catch(() => undefined);
    },
    async stop() {
      stopped = true;
      if (captureTimer !== undefined) {
        clearInterval(captureTimer);
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
      pending.clear();
    },
  };
}
