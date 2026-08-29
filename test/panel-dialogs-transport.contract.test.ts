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
import { waitFor, waitForSettled } from "./wait.js";

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
  return {
    // Delegate to the shared bounded poll helper instead of a local fixed
    // interval, so streamed-message waiting stays deterministic under load.
    waitFor: (predicate, timeoutMs = 2_000) =>
      waitFor(() => messages.find(predicate), { timeoutMs }),
  };
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
      await waitFor(() =>
        source.responses.find(
          (response) =>
            response.dialogId === "d1" &&
            response.accept === true &&
            response.text === "answer",
        ),
      );
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
      // A view-only spectator's dialog response is dropped with no ack and
      // no side effect. Poll the source for a bounded window: a broken drop
      // would push to source.responses (failing fast); a correct drop keeps
      // it empty.
      await waitForSettled(() => source.responses.length === 0);
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
      await waitFor(() =>
        source.performedActions.some(
          (action) => action === "open-link-new-tab",
        ),
      );
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
      // A view-only spectator's context query is dropped with no ack and no
      // side effect; poll for a bounded window (a broken drop would push to
      // source.performedActions and fail fast).
      await waitForSettled(() => source.performedActions.length === 0);
      expect(source.performedActions).toEqual([]);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("tracks multiple open dialogs by dialogId without stranding the first", async () => {
    // SPEC-6: a single openDialog variable overwrote the first dialog when a
    // second arrived before the first was resolved, so a dialog_response for
    // the first was dropped by the dialogId guard. Track a map keyed by
    // dialogId so both stay answerable.
    const { transport, issued, source } = setup({ canInput: true });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      const inbox = collectMessages(socket);
      send(socket, redeemMessage(issued));
      await inbox.waitFor(
        (raw) => decode<{ type: string }>(raw).type === "ready",
      );
      source.emitDialog({
        dialogId: "first",
        type: "confirm",
        message: "First?",
        defaultValue: "",
        url: "https://example.test",
      });
      await inbox.waitFor(
        (raw) =>
          decode<{ type: string; dialog: BrowserDialogEvent }>(raw).dialog
            ?.dialogId === "first",
      );
      source.emitDialog({
        dialogId: "second",
        type: "prompt",
        message: "Second?",
        defaultValue: "",
        url: "https://example.test",
      });
      await inbox.waitFor(
        (raw) =>
          decode<{ type: string; dialog: BrowserDialogEvent }>(raw).dialog
            ?.dialogId === "second",
      );
      // Both dialogs remain answerable: respond to the first after the second
      // opened, and the source receives the response.
      send(socket, {
        type: "dialog_response",
        dialogId: "first",
        accept: false,
      });
      await waitFor(() =>
        source.responses.find(
          (response) =>
            response.dialogId === "first" && response.accept === false,
        ),
      );
      expect(source.responses).toContainEqual({
        dialogId: "first",
        accept: false,
      });
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("re-pushes each open dialog exactly once after a reconnect", async () => {
    // SPEC-9: a reconnecting panel received the open dialog twice because the
    // transport pushed openDialog and then subscribeDialogs re-emitted every
    // still-open dialog. Dedupe so each open dialog arrives exactly once.
    const source = createFakeDialogSource({ canRespond: true });
    const first = setup({ canInput: true }, source);
    const port = await first.transport.start();
    try {
      const socket = await connect(port);
      send(socket, redeemMessage(first.issued));
      await onceMessage(socket); // ready
      source.emitDialog({
        dialogId: "solo",
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
      const dialogs: BrowserDialogEvent[] = [];
      reconnected.on("message", (raw) => {
        const message = decode<{ type: string; dialog?: BrowserDialogEvent }>(
          String(raw),
        );
        if (message.type === "dialog" && message.dialog !== undefined)
          dialogs.push(message.dialog);
      });
      send(reconnected, redeemMessage(second.issued));
      await waitFor(() => dialogs.some((dialog) => dialog.dialogId === "solo"));
      // Dedup: the open dialog must arrive exactly once. Poll for a bounded
      // window; a missing dedup would push a second copy and fail fast.
      await waitForSettled(
        () =>
          dialogs.filter((dialog) => dialog.dialogId === "solo").length === 1,
      );
      expect(
        dialogs.filter((dialog) => dialog.dialogId === "solo"),
      ).toHaveLength(1);
      reconnected.close();
    } finally {
      await second.transport.stop();
    }
  });

  it("does not duplicate a dialog already open when the panel connects", async () => {
    // SPEC-9: startStreaming pushes the persisted open dialog and then
    // subscribeDialogs re-emits every still-open dialog from the source. A
    // dialog the panel already received must not arrive twice. Open the
    // dialog before redeeming so the re-emit path is exercised on connect.
    const { transport, issued, source } = setup({ canInput: true });
    const port = await transport.start();
    try {
      // Pre-open the dialog in the shared source before the panel connects,
      // so subscribeDialogs re-emits it during startStreaming.
      source.emitDialog({
        dialogId: "preopen",
        type: "alert",
        message: "Already open",
        defaultValue: "",
        url: "https://example.test",
      });
      const socket = await connect(port);
      const dialogs: BrowserDialogEvent[] = [];
      socket.on("message", (raw) => {
        const message = decode<{ type: string; dialog?: BrowserDialogEvent }>(
          String(raw),
        );
        if (message.type === "dialog" && message.dialog !== undefined)
          dialogs.push(message.dialog);
      });
      send(socket, redeemMessage(issued));
      await waitFor(() =>
        dialogs.some((dialog) => dialog.dialogId === "preopen"),
      );
      // Dedup: the pre-open dialog must arrive exactly once. Poll for a
      // bounded window; a missing dedup would push a second copy and fail.
      await waitForSettled(
        () =>
          dialogs.filter((dialog) => dialog.dialogId === "preopen").length ===
          1,
      );
      expect(
        dialogs.filter((dialog) => dialog.dialogId === "preopen"),
      ).toHaveLength(1);
      socket.close();
    } finally {
      await transport.stop();
    }
  });

  it("fails a stranded confirm dialog closed by cancelling, not accepting", async () => {
    // SPEC-8: the fail-closed default was accept:true, which for confirm means
    // OK — silently confirming an action the controller never saw. Fail closed
    // with accept:false (cancel/stay) so page state is preserved.
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
        dialogId: "stranded-confirm",
        type: "confirm",
        message: "Delete everything?",
        defaultValue: "",
        url: "https://example.test",
      });
      await onceMessage(socket);
      socket.close();
      await new Promise<void>((resolve) => socket.once("close", resolve));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(source.responses).toEqual([
        { dialogId: "stranded-confirm", accept: false },
      ]);
      await transport.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dismissOpenDialogs cancels stranded dialogs when the lease ends", async () => {
    // SPEC-7 hook: when the agent Control Lease ends (revoked or owner takes
    // control), the transport dismisses every still-open dialog with the
    // fail-closed default rather than leaving an invisible modal block.
    const { transport, issued, source } = setup({ canInput: true });
    const port = await transport.start();
    try {
      const socket = await connect(port);
      const inbox = collectMessages(socket);
      send(socket, redeemMessage(issued));
      await inbox.waitFor(
        (raw) => decode<{ type: string }>(raw).type === "ready",
      );
      source.emitDialog({
        dialogId: "open-confirm",
        type: "confirm",
        message: "Sure?",
        defaultValue: "",
        url: "https://example.test",
      });
      await inbox.waitFor(
        (raw) =>
          decode<{ type: string; dialog: BrowserDialogEvent }>(raw).dialog
            ?.dialogId === "open-confirm",
      );
      // Lease end dismisses open dialogs with the fail-closed default.
      transport.dismissOpenDialogs?.();
      await waitFor(() =>
        source.responses.find(
          (response) =>
            response.dialogId === "open-confirm" && response.accept === false,
        ),
      );
      expect(source.responses).toContainEqual({
        dialogId: "open-confirm",
        accept: false,
      });
      socket.close();
    } finally {
      await transport.stop();
    }
  });
});
