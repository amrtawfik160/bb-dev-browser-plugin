import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createPanelCapabilityStore } from "../panel-capability.js";
import { createPanelGateway } from "../panel-gateway.js";
import { createAutomationStreamAdapter } from "../panel-stream.js";
import {
  createPanelTransportServer,
  type ScreencastSource,
} from "../panel-transport.js";
import type { BrowserContextAction, BrowserDialogEvent } from "../contracts.js";

const hostId = "host-dialog-transport";
const profileId = "profile-dialog-transport";
const ownerSessionId = "owner-session-dialog-transport";
const panelId = "panel-dialog-transport";

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
 * A deterministic screencast source that supports dialog and context-action
 * handling so the transport contract can exercise issue #17 without a real
 * browser. It records dialog responses and context actions, emits a dialog on
 * demand, and reports context actions for a fake point.
 */
function createFakeDialogSource(options: {
  canRespond: boolean;
}): ScreencastSource & {
  responses: { dialogId: string; accept: boolean; text?: string }[];
  performedActions: string[];
  emitDialog(event: BrowserDialogEvent): void;
  dismissed: boolean;
} {
  const responses: { dialogId: string; accept: boolean; text?: string }[] = [];
  const performedActions: string[] = [];
  const openDialogs = new Map<string, BrowserDialogEvent>();
  const listeners = new Set<(event: BrowserDialogEvent) => void>();
  return {
    responses,
    performedActions,
    dismissed: false,
    emitDialog(event) {
      openDialogs.set(event.dialogId, event);
      for (const listener of listeners) listener(event);
    },
    async start(_onFrame, signal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    input() {},
    async stop() {},
    subscribeDialogs(onDialog) {
      listeners.add(onDialog);
      // Re-emit any dialog still open in the browser so a reconnecting
      // transport observes it without a fresh page event.
      for (const event of openDialogs.values()) onDialog(event);
      return () => listeners.delete(onDialog);
    },
    respondToDialog(dialogId, accept, text) {
      openDialogs.delete(dialogId);
      if (options.canRespond) responses.push({ dialogId, accept, text });
    },
    dismissOpenDialogs() {
      this.dismissed = true;
      for (const id of [...openDialogs.keys()]) openDialogs.delete(id);
      listeners.clear();
    },
    async resolveContextActions() {
      const actions: BrowserContextAction[] = [
        {
          actionId: "open-link-new-tab",
          kind: "open-link-new-tab",
          label: "Open link in new tab",
          targetUrl: "https://example.test/link",
        },
      ];
      return actions;
    },
    performContextAction(actionId) {
      performedActions.push(actionId);
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

/** Collect every message so back-to-back pushes are not lost between awaits. */
function collectMessages(socket: WebSocket): {
  waitFor: (
    predicate: (raw: string) => boolean,
    timeoutMs?: number,
  ) => Promise<string>;
} {
  const messages: string[] = [];
  socket.on("message", (raw) => {
    messages.push(raw.toString());
  });
  async function waitFor(
    predicate: (raw: string) => boolean,
    timeoutMs = 2_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = messages.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() >= deadline)
        throw new Error("Timed out waiting for a streamed message.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return { waitFor };
}

function setup(
  options: { canInput: boolean },
  source = createFakeDialogSource({ canRespond: true }),
) {
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
  const transport = createPanelTransportServer({
    gateway,
    stream,
    source,
    clock,
    canInput: () => options.canInput,
  });
  const issued = capabilities.issue({
    ownerSessionId,
    panelId,
    hostId,
    profileId,
  });
  return { capabilities, gateway, stream, source, transport, issued, clock };
}

describe("Panel transport dialog and context-action contract", () => {
  it("pushes a dialog event to the connected panel", async () => {
    const { transport, issued, source } = setup({ canInput: true });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      source.emitDialog({
        dialogId: "d1",
        type: "alert",
        message: "Hello",
        defaultValue: "",
        url: "https://example.test",
      });
      const raw = await onceMessage(socket);
      const message = decode<{ type: string; dialog: BrowserDialogEvent }>(raw);
      expect(message.type).toBe("dialog");
      expect(message.dialog.dialogId).toBe("d1");
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("forwards a controller dialog response to the source", async () => {
    const { transport, issued, source } = setup({ canInput: true });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      source.emitDialog({
        dialogId: "d1",
        type: "prompt",
        message: "Name?",
        defaultValue: "",
        url: "https://example.test",
      });
      await onceMessage(socket);
      send(socket, {
        type: "dialog_response",
        dialogId: "d1",
        accept: true,
        text: "answer",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(source.responses).toEqual([
        { dialogId: "d1", accept: true, text: "answer" },
      ]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("drops a dialog response from a view-only spectator", async () => {
    const { transport, issued, source } = setup({ canInput: false });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      source.emitDialog({
        dialogId: "d1",
        type: "confirm",
        message: "Sure?",
        defaultValue: "",
        url: "https://example.test",
      });
      await onceMessage(socket);
      send(socket, {
        type: "dialog_response",
        dialogId: "d1",
        accept: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(source.responses).toEqual([]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("re-pushes the open dialog after a bounded reconnect", async () => {
    // A reconnect re-issues a fresh capability and gateway while the browser
    // (the shared source) keeps the dialog open; the new transport re-pushes
    // it so the streamed session is not stranded behind an invisible modal.
    const source = createFakeDialogSource({ canRespond: true });
    const first = setup({ canInput: true }, source);
    const port = await first.transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(first.issued));
      await onceMessage(socket); // ready
      source.emitDialog({
        dialogId: "d1",
        type: "alert",
        message: "Open",
        defaultValue: "",
        url: "https://example.test",
      });
      await onceMessage(socket);
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", resolve));
    } finally {
      await first.transport.stop().catch(() => undefined);
    }
    const second = setup({ canInput: true }, source);
    const port2 = await second.transport.start();
    try {
      const reconnected = await connect(port2);
      const inbox = collectMessages(reconnected);
      send(reconnected, redeemMessage(second.issued));
      const ready = await inbox.waitFor(
        (raw) => decode<{ type: string }>(raw).type === "ready",
      );
      expect(decode<{ type: string }>(ready).type).toBe("ready");
      const repush = await inbox.waitFor(
        (raw) => decode<{ type: string }>(raw).type === "dialog",
      );
      expect(
        decode<{ type: string; dialog: BrowserDialogEvent }>(repush).dialog,
      ).toMatchObject({ dialogId: "d1" });
      reconnected.close();
    } finally {
      await second.transport.stop();
    }
  });

  it("fails an open dialog closed when the reclaim window expires", async () => {
    vi.useFakeTimers();
    try {
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
      const source = createFakeDialogSource({ canRespond: true });
      const transport = createPanelTransportServer({
        gateway,
        stream,
        source,
        clock,
        canInput: () => true,
      });
      const issued = capabilities.issue({
        ownerSessionId,
        panelId,
        hostId,
        profileId,
      });
      const port = await transport.start();
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      source.emitDialog({
        dialogId: "d1",
        type: "alert",
        message: "Open",
        defaultValue: "",
        url: "https://example.test",
      });
      await onceMessage(socket);
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", resolve));
      // Advance past the reclaim window; the stranded dialog fails closed.
      await vi.advanceTimersByTimeAsync(11_000);
      expect(source.responses).toEqual([{ dialogId: "d1", accept: true }]);
      await transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves and performs controller context actions over the stream", async () => {
    const { transport, issued, source } = setup({ canInput: true });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      send(socket, { type: "context_query", queryId: "q1", x: 5, y: 9 });
      const raw = await onceMessage(socket);
      const message = decode<{
        type: string;
        queryId: string;
        actions: BrowserContextAction[];
      }>(raw);
      expect(message.type).toBe("context_menu");
      expect(message.queryId).toBe("q1");
      expect(message.actions[0]?.kind).toBe("open-link-new-tab");
      send(socket, { type: "context_action", actionId: "open-link-new-tab" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(source.performedActions).toEqual(["open-link-new-tab"]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("drops context queries from a view-only spectator", async () => {
    const { transport, issued, source } = setup({ canInput: false });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(issued));
      await onceMessage(socket); // ready
      send(socket, { type: "context_query", queryId: "q1", x: 5, y: 9 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(source.performedActions).toEqual([]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });
});
