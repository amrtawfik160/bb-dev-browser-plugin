import { describe, expect, it } from "vitest";
import {
  PANEL_GATEWAY_MESSAGE_MAX_BYTES,
  PANEL_MAX_FRAMES_PER_SECOND,
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
} from "../contracts.js";
import {
  PANEL_PROTOCOL_VERSION,
  decodePanelProtocolMessage,
  encodePanelProtocolMessage,
  type PanelProtocolMessage,
} from "../panel-protocol.js";

const secret = "capability-secret-must-never-leak";
const pixelData = Buffer.from("frame-pixels").toString("base64");
const typedInput = { kind: "click", text: "typed-owner-input" };

const redeemMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "redeem" as const,
  capabilityId: "panel-capability-1",
  secret,
  ownerSessionId: "owner-session-1",
  panelId: "panel-1",
};

const readyMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "ready" as const,
  viewport: {
    width: PANEL_MAX_VIEWPORT_WIDTH,
    height: PANEL_MAX_VIEWPORT_HEIGHT,
  },
  fps: PANEL_MAX_FRAMES_PER_SECOND,
};

const frameMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "frame" as const,
  sequence: 1,
  mimeType: "image/png" as const,
  data: pixelData,
};

const inputMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "input" as const,
  sequence: 1,
  payload: typedInput,
};

const ackMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "ack" as const,
  sequence: 1,
};

const sessionMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "session" as const,
  control: {
    controllerPanelId: "panel-1",
    controllerViewport: { width: 1280, height: 720 },
    agentPurpose: null,
    panels: [
      {
        panelId: "panel-1",
        ownerSessionId: "owner-session-1",
        role: "controller" as const,
        connection: "connected" as const,
        viewport: { width: 1280, height: 720 },
        reclaimUntil: null,
      },
    ],
  },
  tabs: { tabs: [], activeTabId: null },
};

const protocolErrorMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "protocol_error" as const,
  category: "incompatible-version" as const,
  message: "The Browser Panel protocol version is not supported.",
};

const coreCases: ReadonlyArray<{
  name: string;
  message: PanelProtocolMessage;
  direction: "client-to-host" | "host-to-client";
  phase: "pre-redemption" | "authenticated";
}> = [
  {
    name: "capability redemption",
    message: redeemMessage,
    direction: "client-to-host",
    phase: "pre-redemption",
  },
  {
    name: "ready",
    message: readyMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "frame",
    message: frameMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "input",
    message: inputMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "acknowledgement",
    message: ackMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "shared-session update",
    message: sessionMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "protocol-error",
    message: protocolErrorMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
];

function expectPrivacySafe(detail: string) {
  expect(detail).not.toContain(secret);
  expect(detail).not.toContain(pixelData);
  expect(detail).not.toContain("typed-owner-input");
  expect(detail).not.toContain("https://example.test");
}

describe("versioned Panel wire protocol", () => {
  it.each(coreCases)(
    "round-trips $name through shared encoders and decoders",
    ({ message, direction, phase }) => {
      const encoded = encodePanelProtocolMessage(message);
      expect(encoded.outcome).toBe("encoded");
      if (encoded.outcome !== "encoded") return;
      const decoded = decodePanelProtocolMessage(encoded.raw, {
        direction,
        phase,
      });
      expect(decoded.outcome).toBe("accepted");
      if (decoded.outcome === "accepted") {
        expect(decoded.message).toEqual(message);
      }
    },
  );

  it("rejects malformed JSON without leaking payload bytes", () => {
    const decoded = decodePanelProtocolMessage(
      `{"type":"redeem","secret":"${secret}","data":"${pixelData}"`,
      { direction: "client-to-host", phase: "pre-redemption" },
    );
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("malformed");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects unknown discriminators with a stable privacy-safe outcome", () => {
    const decoded = decodePanelProtocolMessage(
      JSON.stringify({
        protocolVersion: PANEL_PROTOCOL_VERSION,
        type: "frobnicate",
        secret,
        data: pixelData,
        payload: typedInput,
      }),
      { direction: "client-to-host", phase: "authenticated" },
    );
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("unknown-type");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects incompatible protocol versions before they look like a healthy browser", () => {
    const decoded = decodePanelProtocolMessage(
      JSON.stringify({ ...inputMessage, protocolVersion: 2 }),
      { direction: "client-to-host", phase: "authenticated" },
    );
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("incompatible-version");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects a syntactically valid input message before redemption", () => {
    const encoded = encodePanelProtocolMessage(inputMessage);
    expect(encoded.outcome).toBe("encoded");
    if (encoded.outcome !== "encoded") return;
    const decoded = decodePanelProtocolMessage(encoded.raw, {
      direction: "client-to-host",
      phase: "pre-redemption",
    });
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("invalid-phase");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects a ready message sent by a client as the wrong direction", () => {
    const encoded = encodePanelProtocolMessage(readyMessage);
    expect(encoded.outcome).toBe("encoded");
    if (encoded.outcome !== "encoded") return;
    const decoded = decodePanelProtocolMessage(encoded.raw, {
      direction: "client-to-host",
      phase: "authenticated",
    });
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("invalid-direction");
  });

  it("rejects a second redemption after the stream is authenticated", () => {
    const encoded = encodePanelProtocolMessage(redeemMessage);
    expect(encoded.outcome).toBe("encoded");
    if (encoded.outcome !== "encoded") return;
    const decoded = decodePanelProtocolMessage(encoded.raw, {
      direction: "client-to-host",
      phase: "authenticated",
    });
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("invalid-phase");
  });

  it("rejects oversized messages before they reach Browser Profile state", () => {
    const oversized = `${"x".repeat(PANEL_GATEWAY_MESSAGE_MAX_BYTES + 1)}`;
    const decoded = decodePanelProtocolMessage(oversized, {
      direction: "client-to-host",
      phase: "authenticated",
    });
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("too-large");
    expectPrivacySafe(decoded.error.message);
  });

  it("leaves auxiliary Panel messages on the legacy path until their migration", () => {
    const auxiliary = [
      { type: "dialog_response", dialogId: "dialog-1", accept: false },
      { type: "context_query", queryId: "query-1", x: 8, y: 12 },
      { type: "clipboard_copy", copyId: "copy-1" },
      { type: "transfer_cancel", transferId: "transfer-1" },
      { type: "download_cancel", downloadId: "download-1" },
    ];
    for (const message of auxiliary) {
      const decoded = decodePanelProtocolMessage(JSON.stringify(message), {
        direction: "client-to-host",
        phase: "authenticated",
      });
      expect(decoded.outcome).toBe("legacy");
      if (decoded.outcome === "legacy") {
        expect(decoded.value).toEqual(message);
      }
    }
  });
});
