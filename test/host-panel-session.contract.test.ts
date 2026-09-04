import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DEFAULT_PROFILE_ID, setupRequiredStatus } from "../contracts.js";
import { createBrowserHostEntry } from "../host.js";
import {
  PANEL_PROTOCOL_VERSION,
  encodePanelProtocolMessage,
} from "../panel-protocol.js";
import type { ScreencastSource } from "../panel-transport.js";
import { waitFor, waitForSettled } from "./wait.js";

const HOST_ID = "host-panel-session";

function healthyStatus() {
  const unavailable = setupRequiredStatus({
    hostId: HOST_ID,
    profileId: DEFAULT_PROFILE_ID,
  });
  return {
    ...unavailable,
    state: "healthy" as const,
    code: "healthy" as const,
    label: "Ready" as const,
    message: "Workspace Browser is ready on this host.",
    capabilities: unavailable.capabilities.map((capability) => ({
      ...capability,
      status: "ready" as const,
    })),
  };
}

function idleFrameSource(): ScreencastSource {
  return recordingFrameSource([]);
}

function recordingFrameSource(receivedInputs: unknown[]): ScreencastSource {
  return {
    async start(_onFrame, signal) {
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

type OpenedPanelTransport = {
  outcome: "opened";
  gatewayPort: number;
  capabilityId: string;
  secret: string;
};

function collectMessages(socket: WebSocket) {
  const messages: string[] = [];
  socket.on("message", (raw) => {
    messages.push(raw.toString());
  });
  return {
    messages,
    waitFor: (predicate: (raw: string) => boolean, timeoutMs = 2_000) =>
      waitFor(() => messages.find(predicate), { timeoutMs }),
  };
}

function parsedMessage(raw: string) {
  try {
    return JSON.parse(raw) as { type?: string; category?: string };
  } catch {
    return undefined;
  }
}

function latestSessionPanels(messages: readonly string[]) {
  let latest: Array<{
    panelId: string;
    connection: "connected" | "disconnected";
  }> = [];
  for (const raw of messages) {
    try {
      const parsed = JSON.parse(raw) as {
        type?: string;
        control?: {
          panels?: Array<{
            panelId: string;
            connection: "connected" | "disconnected";
          }>;
        };
      };
      if (parsed.type === "session" && parsed.control?.panels !== undefined) {
        latest = parsed.control.panels;
      }
    } catch {
      continue;
    }
  }
  return latest;
}

function sendProtocol(
  socket: WebSocket,
  message: Parameters<typeof encodePanelProtocolMessage>[0],
) {
  const encoded = encodePanelProtocolMessage(message);
  if (encoded.outcome !== "encoded") {
    throw new Error("expected a protocol message to encode");
  }
  socket.send(encoded.raw);
}

async function connectAndRedeem(
  opened: OpenedPanelTransport,
  identities: { panelId: string; ownerSessionId: string },
) {
  const socket = new WebSocket(`ws://127.0.0.1:${opened.gatewayPort}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const inbox = collectMessages(socket);
  sendProtocol(socket, {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "redeem",
    capabilityId: opened.capabilityId,
    secret: opened.secret,
    ownerSessionId: identities.ownerSessionId,
    panelId: identities.panelId,
  });
  await inbox.waitFor((raw) => parsedMessage(raw)?.type === "ready");
  return { socket, inbox };
}

describe("host-owned Panel session", () => {
  it("closes loopback listeners on worker shutdown without moving Browser Profile state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "host-panel-session-"));
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { frameSource: () => idleFrameSource() },
      ),
      {
        experimental_paths: {
          dataDir,
          tempDir: join(dataDir, "tmp"),
        },
      },
    );
    try {
      const opened = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-session-shutdown",
        ownerSessionId: "owner-session-session",
      });
      expect(opened).toMatchObject({ outcome: "opened" });
      if (opened.outcome !== "opened") return;
      expect(opened.bindHost).toBe("127.0.0.1");
      const port = opened.gatewayPort;
      await host.experimental_dispose();
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        socket.once("open", () => {
          socket.close();
          reject(new Error("disposed host still accepted a Panel connection"));
        });
        socket.once("error", () => resolve());
      });
    } finally {
      await host.experimental_dispose().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps the newer redeemed generation connected and authoritative after the superseded transport stops", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "host-panel-handoff-"));
    const receivedInputs: unknown[] = [];
    const identities = {
      panelId: "panel-session-handoff",
      ownerSessionId: "owner-session-handoff",
    };
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { frameSource: () => recordingFrameSource(receivedInputs) },
      ),
      {
        experimental_paths: {
          dataDir,
          tempDir: join(dataDir, "tmp"),
        },
      },
    );
    let firstSocket: WebSocket | undefined;
    let nextSocket: WebSocket | undefined;
    try {
      const firstOpened = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        ...identities,
      });
      expect(firstOpened).toMatchObject({ outcome: "opened" });
      if (firstOpened.outcome !== "opened") return;
      const first = await connectAndRedeem(firstOpened, identities);
      firstSocket = first.socket;
      sendProtocol(first.socket, {
        protocolVersion: PANEL_PROTOCOL_VERSION,
        type: "input",
        sequence: 1,
        payload: { kind: "click", generation: 1 },
      });
      await waitFor(() =>
        receivedInputs.some(
          (input) =>
            input !== null &&
            typeof input === "object" &&
            "generation" in input &&
            input.generation === 1,
        ),
      );

      const replacement = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        ...identities,
      });
      expect(replacement).toMatchObject({ outcome: "opened" });
      if (replacement.outcome !== "opened") return;
      const next = await connectAndRedeem(replacement, identities);
      nextSocket = next.socket;
      try {
        sendProtocol(first.socket, {
          protocolVersion: PANEL_PROTOCOL_VERSION,
          type: "input",
          sequence: 2,
          payload: { kind: "click", generation: "stale" },
        });
      } catch {
        // The superseded generation may already have closed.
      }
      await waitFor(() => first.socket.readyState === WebSocket.CLOSED, {
        timeoutMs: 4_000,
      });
      await waitForSettled(() => {
        const live = latestSessionPanels(next.inbox.messages).find(
          (panel) => panel.panelId === identities.panelId,
        );
        return (
          live?.connection === "connected" &&
          !next.inbox.messages.some(
            (raw) => parsedMessage(raw)?.type === "protocol_error",
          )
        );
      });
      sendProtocol(next.socket, {
        protocolVersion: PANEL_PROTOCOL_VERSION,
        type: "input",
        sequence: 3,
        payload: { kind: "click", generation: 2 },
      });
      await waitFor(() =>
        receivedInputs.some(
          (input) =>
            input !== null &&
            typeof input === "object" &&
            "generation" in input &&
            input.generation === 2,
        ),
      );
      expect(receivedInputs).toEqual([
        { kind: "click", generation: 1 },
        { kind: "click", generation: 2 },
      ]);
      expect(
        latestSessionPanels(next.inbox.messages).find(
          (panel) => panel.panelId === identities.panelId,
        ),
      ).toMatchObject({ connection: "connected" });
      expect(
        next.inbox.messages.some(
          (raw) => parsedMessage(raw)?.category === "stale-generation",
        ),
      ).toBe(false);
    } finally {
      firstSocket?.close();
      nextSocket?.close();
      await host.experimental_dispose().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("fans one profile stream out so stopping one panel does not abort the other", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "host-panel-fanout-"));
    const receivedInputs: unknown[] = [];
    let starts = 0;
    let stops = 0;
    const stopWaiters: Array<() => void> = [];
    const sharedSource: ScreencastSource = {
      async start(onFrame, signal) {
        starts += 1;
        onFrame({
          sequence: starts,
          mimeType: "image/png",
          data: Buffer.from("fanout"),
        });
        await new Promise<void>((resolve) => {
          const finish = () => resolve();
          stopWaiters.push(finish);
          if (signal.aborted) {
            finish();
            return;
          }
          signal.addEventListener("abort", finish, { once: true });
        });
      },
      input(payload) {
        receivedInputs.push(payload);
      },
      async stop() {
        stops += 1;
        for (const finish of stopWaiters.splice(0)) finish();
      },
    };
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { frameSource: () => sharedSource },
      ),
      {
        experimental_paths: {
          dataDir,
          tempDir: join(dataDir, "tmp"),
        },
      },
    );
    let firstSocket: WebSocket | undefined;
    let secondSocket: WebSocket | undefined;
    try {
      const firstOpened = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-fanout-a",
        ownerSessionId: "owner-session-a",
      });
      const secondOpened = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-fanout-b",
        ownerSessionId: "owner-session-b",
      });
      expect(firstOpened).toMatchObject({ outcome: "opened" });
      expect(secondOpened).toMatchObject({ outcome: "opened" });
      if (
        firstOpened.outcome !== "opened" ||
        secondOpened.outcome !== "opened"
      ) {
        return;
      }
      const first = await connectAndRedeem(firstOpened, {
        panelId: "panel-fanout-a",
        ownerSessionId: "owner-session-a",
      });
      firstSocket = first.socket;
      const second = await connectAndRedeem(secondOpened, {
        panelId: "panel-fanout-b",
        ownerSessionId: "owner-session-b",
      });
      secondSocket = second.socket;
      expect(starts).toBe(1);

      await host.experimental_call("takeControl", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-fanout-b",
        ownerSessionId: "owner-session-b",
      });
      await host.experimental_call("panelRelease", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-fanout-a",
      });
      await waitFor(() => first.socket.readyState === WebSocket.CLOSED);
      expect(stops).toBe(0);
      sendProtocol(second.socket, {
        protocolVersion: PANEL_PROTOCOL_VERSION,
        type: "input",
        sequence: 1,
        payload: { kind: "click", generation: "survivor" },
      });
      await waitFor(() =>
        receivedInputs.some(
          (input) =>
            input !== null &&
            typeof input === "object" &&
            "generation" in input &&
            input.generation === "survivor",
        ),
      );
    } finally {
      firstSocket?.close();
      secondSocket?.close();
      await host.experimental_dispose().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("waits for the shared screencast source to stop during worker shutdown", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "host-panel-dispose-"));
    let releaseSourceStop: (() => void) | undefined;
    const heldSource: ScreencastSource = {
      async start(_onFrame, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      input() {},
      async stop() {
        await new Promise<void>((resolve) => {
          releaseSourceStop = resolve;
        });
      },
    };
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { frameSource: () => heldSource },
      ),
      {
        experimental_paths: {
          dataDir,
          tempDir: join(dataDir, "tmp"),
        },
      },
    );
    let socket: WebSocket | undefined;
    let disposing: Promise<void> | undefined;
    try {
      const opened = await host.experimental_call("panelTransport", {
        hostId: HOST_ID,
        profileId: DEFAULT_PROFILE_ID,
        panelId: "panel-dispose-wait",
        ownerSessionId: "owner-session-dispose",
      });
      expect(opened).toMatchObject({ outcome: "opened" });
      if (opened.outcome !== "opened") return;
      const connected = await connectAndRedeem(opened, {
        panelId: "panel-dispose-wait",
        ownerSessionId: "owner-session-dispose",
      });
      socket = connected.socket;

      let disposeSettled = false;
      disposing = host.experimental_dispose().then(() => {
        disposeSettled = true;
      });
      await waitFor(() => releaseSourceStop !== undefined);
      expect(disposeSettled).toBe(false);
      releaseSourceStop?.();
      await disposing;
      expect(disposeSettled).toBe(true);
    } finally {
      releaseSourceStop?.();
      socket?.close();
      await disposing?.catch(() => undefined);
      await host.experimental_dispose().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
