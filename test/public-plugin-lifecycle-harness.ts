import { act, waitFor, within } from "@testing-library/react";
import type { RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import type { ScreencastFrame, ScreencastSource } from "../panel-transport.js";
import {
  PANEL_PROTOCOL_VERSION,
  encodePanelProtocolMessage,
} from "../panel-protocol.js";
import {
  setTestLoopbackPanelTransport,
  setTestPanelLifecycleClock,
} from "../panel-test-loopback.js";
import { DEFAULT_PROFILE_ID } from "../contracts.js";
import { ownerSessionIdFromContext } from "../panel-owner-session.js";
import type { HostProbeSnapshot } from "../readiness.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";

const HOST_ID = "host-browser-test";
const PROJECT_ID = "project-browser-test";
const THREAD_ID = "thread-browser-test";

const HEALTHY_SNAPSHOT: HostProbeSnapshot = {
  operatingSystem: {
    id: "ubuntu",
    version: "24.04",
    name: "Ubuntu 24.04 LTS",
  },
  architecture: "x64",
  connect: { enrolled: true },
  browser: {
    name: "Google Chrome",
    version: "140.0.7339.80",
    compatible: true,
  },
  sandbox: { available: true },
  dedicatedUser: { state: "ready" },
  protectedStorage: { state: "ready" },
  disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
  loopback: { available: true },
  processes: [],
  exitLogs: [],
};

/**
 * A 1×1 PNG the lifecycle seam uses as a deterministic first frame. The
 * bytes are a known-good fixture, not a screenshot from a Workspace Browser.
 */
const FIRST_FRAME_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

type TrackedSocket = NodeWebSocket & { url: string };

function createDeterministicPanelFrameSource(
  receivedInputs: unknown[],
): ScreencastSource {
  return {
    async start(onFrame, signal) {
      // An already-aborted stream subscription cannot recover a live frame.
      // Reusing cancellation state from a prior physical connection therefore
      // fails closed instead of painting a stale generation.
      if (signal.aborted) return;
      const frame: ScreencastFrame = {
        sequence: 1,
        mimeType: "image/png",
        data: FIRST_FRAME_PNG,
      };
      onFrame(frame);
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    input(payload) {
      receivedInputs.push(payload);
    },
    async stop() {},
  };
}

function socketPort(socket: TrackedSocket) {
  try {
    return new URL(socket.url).port;
  } catch {
    return "";
  }
}

function messageText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "utf8",
    );
  }
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data);
}

export type LifecyclePanel = ReturnType<typeof within> &
  RenderedSlot & {
    panelId: string;
    ownerSessionId: string;
    hostId: string;
    profileId: string;
    capabilityId: string;
    gatewayPort: number;
    get redeemed(): boolean;
    get framesReceived(): number;
    get connectionAttempts(): number;
  };

export async function createPublicPanelLifecycleHarness() {
  let now = Date.parse("2026-08-31T12:00:00.000Z");
  const clock = { now: () => now };
  const sockets = new Set<TrackedSocket>();
  const connectionAttemptsByPort = new Map<string, number>();
  const messagesByPort = new Map<string, string[]>();
  const previousWebSocket = globalThis.WebSocket;
  const reconnectTimers = new Map<
    number,
    { callback: () => void; due: number }
  >();
  let nextReconnectTimerId = 1;
  const receivedInputs: unknown[] = [];

  function recordSocketMessage(socket: TrackedSocket, data: unknown) {
    const port = socketPort(socket);
    if (!messagesByPort.has(port)) messagesByPort.set(port, []);
    messagesByPort.get(port)?.push(messageText(data));
  }

  class LifecycleWebSocket extends NodeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const href = url.toString();
      super(href, protocols);
      const socket = this as unknown as TrackedSocket;
      Object.defineProperty(socket, "url", { value: href });
      sockets.add(socket);
      const port = new URL(href).port;
      connectionAttemptsByPort.set(
        port,
        (connectionAttemptsByPort.get(port) ?? 0) + 1,
      );
      if (!messagesByPort.has(port)) messagesByPort.set(port, []);
      this.on("message", (data) => {
        recordSocketMessage(socket, data);
      });
      this.on("close", () => {
        sockets.delete(socket);
      });
      const protoSend = NodeWebSocket.prototype.send;
      this.send = function (
        this: NodeWebSocket,
        data: Parameters<NodeWebSocket["send"]>[0],
        ...args: unknown[]
      ) {
        recordSocketMessage(socket, data);
        return protoSend.apply(this, [data, ...args] as Parameters<
          NodeWebSocket["send"]
        >);
      } as NodeWebSocket["send"];
      const protoAdd = NodeWebSocket.prototype.addEventListener as (
        type: string,
        listener: (event: unknown) => void,
        options?: unknown,
      ) => void;
      Object.defineProperty(this, "addEventListener", {
        value: (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: unknown,
        ) => {
          if (type === "message" && typeof listener === "function") {
            protoAdd.call(
              this,
              type,
              (event: unknown) => {
                const data = messageText((event as { data?: unknown }).data);
                recordSocketMessage(socket, data);
                listener.call(this, { data } as unknown as Event);
              },
              options,
            );
            return;
          }
          protoAdd.call(
            this,
            type,
            listener as (event: unknown) => void,
            options,
          );
        },
      });
    }
  }

  const WebSocketCtor = LifecycleWebSocket as unknown as typeof WebSocket;
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = WebSocketCtor;
  if (typeof window !== "undefined") {
    (window as { WebSocket: typeof WebSocket }).WebSocket = WebSocketCtor;
  }
  setTestLoopbackPanelTransport(true);
  setTestPanelLifecycleClock({
    setTimeout(callback, milliseconds) {
      const id = nextReconnectTimerId;
      nextReconnectTimerId += 1;
      reconnectTimers.set(id, { callback, due: now + milliseconds });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") reconnectTimers.delete(handle);
    },
  });

  const browser = await createPublicPluginHarness({
    snapshot: HEALTHY_SNAPSHOT,
    panelContext: { projectId: PROJECT_ID, threadId: THREAD_ID },
    clock,
    panelFrameSource: () => createDeterministicPanelFrameSource(receivedInputs),
  });
  const ownerSessionId = ownerSessionIdFromContext({
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
  });

  function portMessages(port: number) {
    return messagesByPort.get(String(port)) ?? [];
  }

  type ParsedPanelMessage = {
    type?: string;
    category?: string;
    capabilityId?: string;
    secret?: string;
    control?: {
      controllerPanelId?: string | null;
      panels?: Array<{
        panelId: string;
        ownerSessionId: string;
        role?: "controller" | "spectator";
        connection: "connected" | "disconnected";
        reclaimUntil: number | null;
      }>;
    };
  };

  function issuedGatewayPorts(panelId: string) {
    return browser.panelCapabilityExchanges.flatMap((exchange) => {
      if (
        exchange.request.panelId !== panelId ||
        exchange.response.outcome !== "issued"
      ) {
        return [];
      }
      return [exchange.response.gatewayPort];
    });
  }

  function parsedMessages(port: number) {
    return portMessages(port).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as ParsedPanelMessage];
      } catch {
        return [];
      }
    });
  }

  function latestSessionPanels(panel: LifecyclePanel) {
    const ports = issuedGatewayPorts(panel.panelId);
    const latestPort = ports.at(-1);
    if (latestPort === undefined) return [];
    let latest: NonNullable<ParsedPanelMessage["control"]>["panels"] = [];
    for (const message of parsedMessages(latestPort)) {
      if (message.type === "session" && message.control?.panels !== undefined) {
        latest = message.control.panels;
      }
    }
    return latest ?? [];
  }

  function latestIssuedGeneration(panel: LifecyclePanel) {
    return issuedGatewayPorts(panel.panelId).length;
  }

  function portHasOpenSocket(port: number) {
    return [...sockets].some(
      (socket) =>
        socketPort(socket) === String(port) &&
        socket.readyState === NodeWebSocket.OPEN,
    );
  }

  function attachLifecycle(
    panel: ReturnType<typeof browser.renderPanel>,
  ): LifecyclePanel {
    const request = browser.panelCapabilityRequests.find((entry) => {
      return panel.inspection.rpcCalls.some(
        (call) =>
          call.method === "browser_panel_capability" &&
          (call.input as { panelId?: string }).panelId === entry.panelId,
      );
    });
    if (request === undefined) {
      throw new Error("Browser Panel did not request a Panel Capability.");
    }
    const issued = [...browser.panelCapabilityExchanges]
      .reverse()
      .find(
        (exchange) =>
          exchange.request.panelId === request.panelId &&
          exchange.response.outcome === "issued",
      )?.response;
    if (issued === undefined || issued.outcome !== "issued") {
      throw new Error("Browser Panel did not obtain a Panel Capability.");
    }
    const assigned = Object.assign(panel, {
      panelId: request.panelId,
      ownerSessionId: request.ownerSessionId,
      hostId: request.hostId,
      profileId: request.profileId,
      capabilityId: issued.capabilityId,
      gatewayPort: issued.gatewayPort,
    });
    // Object.assign copies getter values; reconnect must be observed live
    // across every gateway generation issued for this panel identity.
    Object.defineProperty(assigned, "redeemed", {
      configurable: true,
      enumerable: true,
      get() {
        return panelHasReady(request.panelId);
      },
    });
    Object.defineProperty(assigned, "framesReceived", {
      configurable: true,
      enumerable: true,
      get() {
        return issuedGatewayPorts(request.panelId).reduce(
          (count, port) =>
            count +
            parsedMessages(port).filter((message) => message.type === "frame")
              .length,
          0,
        );
      },
    });
    Object.defineProperty(assigned, "connectionAttempts", {
      configurable: true,
      enumerable: true,
      get() {
        return issuedGatewayPorts(request.panelId).reduce(
          (count, port) =>
            count + (connectionAttemptsByPort.get(String(port)) ?? 0),
          0,
        );
      },
    });
    return assigned as LifecyclePanel;
  }

  function issuedExchanges(panelId: string) {
    return browser.panelCapabilityExchanges.filter(
      (exchange) =>
        exchange.request.panelId === panelId &&
        exchange.response.outcome === "issued",
    );
  }

  function issuedSecrets(panelId: string) {
    return issuedExchanges(panelId).flatMap((exchange) =>
      exchange.response.outcome === "issued" ? [exchange.response.secret] : [],
    );
  }

  function redeemedSecrets(panelId: string) {
    return issuedGatewayPorts(panelId).flatMap((port) =>
      parsedMessages(port).flatMap((message) =>
        message.type === "redeem" && typeof message.secret === "string"
          ? [message.secret]
          : [],
      ),
    );
  }

  function socketUrls() {
    return [...sockets].map((socket) => socket.url);
  }

  function jsonContainsSecret(value: unknown, secret: string) {
    return JSON.stringify(value).includes(secret);
  }

  function panelHasReady(panelId: string) {
    return browser.panelCapabilityExchanges.some((exchange) => {
      if (
        exchange.request.panelId !== panelId ||
        exchange.response.outcome !== "issued"
      ) {
        return false;
      }
      return parsedMessages(exchange.response.gatewayPort).some(
        (message) => message.type === "ready",
      );
    });
  }

  async function openTwoPanels(): Promise<[LifecyclePanel, LifecyclePanel]> {
    const firstSlot = browser.renderPanel();
    await waitFor(() =>
      expect(browser.panelCapabilityRequests.length).toBeGreaterThanOrEqual(1),
    );
    let first = attachLifecycle(firstSlot);
    await waitFor(() => expect(panelHasReady(first.panelId)).toBe(true), {
      timeout: 4_000,
    });
    first = attachLifecycle(firstSlot);

    const secondSlot = browser.renderPanel();
    await waitFor(() =>
      expect(
        browser.panelCapabilityRequests.some(
          (request) => request.panelId !== first.panelId,
        ),
      ).toBe(true),
    );
    let second = attachLifecycle(secondSlot);
    await waitFor(() => expect(panelHasReady(second.panelId)).toBe(true), {
      timeout: 4_000,
    });
    second = attachLifecycle(secondSlot);
    expect(first.container).not.toBe(second.container);
    await within(first.container).findByText("The page is live.");
    await within(second.container).findByText("The page is live.");
    return [first, second];
  }

  async function forcePhysicalSocketLoss(panel: LifecyclePanel) {
    const ports = new Set(
      browser.panelCapabilityExchanges
        .filter(
          (exchange) =>
            exchange.request.panelId === panel.panelId &&
            exchange.response.outcome === "issued",
        )
        .map((exchange) =>
          exchange.response.outcome === "issued"
            ? String(exchange.response.gatewayPort)
            : "",
        ),
    );
    const targets = [...sockets].filter((socket) =>
      ports.has(socketPort(socket)),
    );
    await act(async () => {
      for (const socket of targets) socket.close();
    });
  }

  async function advanceTime(milliseconds: number) {
    now += milliseconds;
    const due = [...reconnectTimers.entries()]
      .filter(([, timer]) => timer.due <= now)
      .sort((left, right) => left[1].due - right[1].due || left[0] - right[0]);
    for (const [id] of due) reconnectTimers.delete(id);
    await act(async () => {
      for (const [, timer] of due) timer.callback();
    });
  }

  async function closePanel(panel: LifecyclePanel) {
    await act(async () => {
      panel.lifecycle.unmount();
    });
  }

  async function switchBrowserProfile(profileId: string) {
    return browser.selectBrowserProfile({
      hostId: HOST_ID,
      profileId,
    });
  }

  async function issuePanelCapability(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
  }) {
    return browser.rpc.browser_panel_capability(input);
  }

  async function releasePanel(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
  }) {
    return browser.rpc.browser_panel_release(input);
  }

  async function setPanelVisibility(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
    visibility: "visible" | "hidden";
  }) {
    return browser.rpc.browser_panel_visibility(input);
  }

  function liveSocketFor(panel: LifecyclePanel) {
    return [...sockets].find(
      (socket) =>
        socketPort(socket) === String(panel.gatewayPort) &&
        socket.readyState === NodeWebSocket.OPEN,
    );
  }

  function sendAuthorizedInput(panel: LifecyclePanel, payload: unknown) {
    const socket = liveSocketFor(panel);
    if (socket === undefined) {
      throw new Error("Browser Panel has no live stream connection.");
    }
    sendSocketInput(socket, payload);
  }

  function sendSocketInput(socket: TrackedSocket, payload: unknown) {
    const encoded = encodePanelProtocolMessage({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "input",
      sequence: receivedInputs.length + 1,
      payload,
    });
    if (encoded.outcome !== "encoded") {
      throw new Error("Browser Panel input failed protocol encoding.");
    }
    socket.send(encoded.raw);
  }

  async function redeemIssuedCapability(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
    capabilityId: string;
    secret: string;
    gatewayPort: number;
  }) {
    const href = `ws://127.0.0.1:${input.gatewayPort}`;
    const socket = new LifecycleWebSocket(href) as unknown as TrackedSocket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const encoded = encodePanelProtocolMessage({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "redeem",
      capabilityId: input.capabilityId,
      secret: input.secret,
      ownerSessionId: input.ownerSessionId,
      panelId: input.panelId,
    });
    if (encoded.outcome !== "encoded") {
      throw new Error("Browser Panel redeem failed protocol encoding.");
    }
    socket.send(encoded.raw);
    await waitFor(() =>
      parsedMessages(input.gatewayPort).some(
        (message) => message.type === "ready",
      ),
    );
    return socket;
  }

  async function dispose() {
    setTestLoopbackPanelTransport(false);
    setTestPanelLifecycleClock(undefined);
    reconnectTimers.clear();
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      previousWebSocket;
    if (typeof window !== "undefined") {
      (window as { WebSocket: typeof WebSocket }).WebSocket = previousWebSocket;
    }
    for (const socket of [...sockets]) {
      socket.close();
    }
    sockets.clear();
    await browser.dispose();
  }

  return {
    hostId: HOST_ID,
    projectId: PROJECT_ID,
    threadId: THREAD_ID,
    ownerSessionId,
    get threadLookups() {
      return browser.threadLookups;
    },
    get projectLookups() {
      return browser.projectLookups;
    },
    get hostRpcCalls() {
      return browser.hostRpcCalls;
    },
    get panelCapabilityRequests() {
      return browser.panelCapabilityRequests;
    },
    get panelCapabilityExchanges() {
      return browser.panelCapabilityExchanges;
    },
    get receivedInputs() {
      return receivedInputs;
    },
    openTwoPanels,
    sendAuthorizedInput,
    sendSocketInput,
    latestSessionPanels,
    latestIssuedGeneration,
    issuedSecrets,
    redeemedSecrets,
    socketUrls,
    jsonContainsSecret,
    diagnosticLogEntries: () => browser.diagnosticLogEntries(),
    activityRecords: (profileId?: string) =>
      browser.runBrowserActivityRecords(profileId),
    persistedActivityRows: () => browser.persistedActivityRows(),
    runDiagnostics: () =>
      browser.rpc.browser_diagnostics({
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
      }),
    portHasOpenSocket,
    redeemIssuedCapability,
    forcePhysicalSocketLoss,
    advanceTime,
    closePanel,
    switchBrowserProfile,
    issuePanelCapability,
    setPanelVisibility,
    releasePanel,
    createBrowserProfile: (input: { hostId: string; name: string }) =>
      browser.createBrowserProfile(input),
    runBrowserProfiles: () =>
      browser.runBrowserProfiles(HOST_ID, {
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
      }),
    runBrowserStatus: (input: Parameters<typeof browser.runBrowserStatus>[0]) =>
      browser.runBrowserStatus(input),
    dispose,
  };
}
