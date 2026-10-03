import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createPanelCapabilityStore } from "../src/panel/panel-capability.js";
import { createPanelGateway } from "../src/panel/panel-gateway.js";
import { createAutomationStreamAdapter } from "../src/panel/panel-stream.js";
import { createPanelTransportServer } from "../src/panel/panel-transport.js";
import {
  decodePanelProtocolMessage,
  PANEL_PROTOCOL_VERSION,
} from "../src/shared/panel-protocol.js";
import { PANEL_SCREENSHOT_CHUNK_LENGTH } from "../src/shared/panel-screenshot.js";
import { waitFor } from "./wait.js";

describe("owner screenshot boundary", () => {
  it.each(["owner", "spectator", "superseded", "unredeemed"] as const)(
    "admits screenshots only for an authenticated current controller: %s",
    async (role) => {
      const capabilities = createPanelCapabilityStore();
      const target = {
        hostId: "host",
        profileId: "profile",
        ownerSessionId: "owner",
        panelId: "panel",
      };
      const gateway = createPanelGateway({ ...target, capabilities });
      const png = Buffer.alloc(PANEL_SCREENSHOT_CHUNK_LENGTH, 42).toString(
        "base64",
      );
      const capture = vi.fn(async () => png);
      const transport = createPanelTransportServer({
        gateway,
        stream: createAutomationStreamAdapter(),
        canInput: () => role !== "spectator",
        acceptsGeneration: () => role !== "superseded",
        source: {
          start: async (_frame, signal) => {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
          input: () => {},
          stop: async () => {},
          captureScreenshot: capture,
        },
      });
      const socket = new WebSocket(`ws://127.0.0.1:${await transport.start()}`);
      const messages: string[] = [];
      socket.on("message", (raw) => messages.push(String(raw)));
      await new Promise<void>((resolve) => socket.once("open", resolve));
      try {
        if (role !== "unredeemed") {
          const issued = capabilities.issue(target);
          socket.send(
            JSON.stringify({
              protocolVersion: PANEL_PROTOCOL_VERSION,
              type: "redeem",
              ...target,
              capabilityId: issued.capabilityId,
              secret: issued.secret,
              hostId: undefined,
              profileId: undefined,
            }),
          );
          await waitFor(() =>
            messages.find((raw) => JSON.parse(raw).type === "ready"),
          );
        }
        socket.send(
          JSON.stringify({
            protocolVersion: PANEL_PROTOCOL_VERSION,
            type: "screenshot_request",
            requestId: "shot",
            fullPage: true,
          }),
        );
        await waitFor(() =>
          messages.find(
            (raw) =>
              ["screenshot_error", "protocol_error"].includes(
                JSON.parse(raw).type,
              ) || JSON.parse(raw).last,
          ),
        );
        if (role === "owner") {
          const chunks = messages.flatMap((raw) => {
            const parsed = decodePanelProtocolMessage(raw, {
              direction: "host-to-client",
              phase: "authenticated",
            });
            expect(parsed.outcome).toBe("accepted");
            return parsed.outcome === "accepted" &&
              parsed.message.type === "screenshot_chunk"
              ? [parsed.message]
              : [];
          });
          expect(chunks.length).toBe(2);
          expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
          expect(chunks.map((chunk) => chunk.data).join("")).toBe(png);
          expect(capture).toHaveBeenCalledWith(true);
        } else {
          expect(capture).not.toHaveBeenCalled();
        }
      } finally {
        socket.close();
        await transport.stop();
      }
    },
  );

  it("rejects screenshot messages in the wrong direction and before redemption", () => {
    const request = JSON.stringify({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "screenshot_request",
      requestId: "shot",
      fullPage: true,
    });
    expect(
      decodePanelProtocolMessage(request, {
        direction: "host-to-client",
        phase: "authenticated",
      }).outcome,
    ).toBe("rejected");
    expect(
      decodePanelProtocolMessage(request, {
        direction: "client-to-host",
        phase: "pre-redemption",
      }).outcome,
    ).toBe("rejected");
    const chunk = JSON.stringify({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "screenshot_chunk",
      requestId: "shot",
      index: 0,
      last: true,
      data: "x".repeat(PANEL_SCREENSHOT_CHUNK_LENGTH + 1),
    });
    expect(
      decodePanelProtocolMessage(chunk, {
        direction: "host-to-client",
        phase: "authenticated",
      }).outcome,
    ).toBe("rejected");
  });
});
