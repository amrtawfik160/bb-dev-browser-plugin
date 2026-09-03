import { describe, expect, it } from "vitest";
import {
  BROWSER_DOWNLOAD_MAX_FILE_BYTES,
  BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
  BROWSER_DOWNLOAD_TTL_MS,
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

const dialogEvent = {
  dialogId: "dialog-1",
  type: "prompt" as const,
  message: "typed-owner-input",
  defaultValue: "",
  url: "https://example.test",
};

const dialogMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "dialog" as const,
  dialog: dialogEvent,
};

const dialogResponseMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "dialog_response" as const,
  dialogId: "dialog-1",
  accept: true,
  text: "typed-owner-input",
};

const contextQueryMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "context_query" as const,
  queryId: "query-1",
  x: 8,
  y: 12,
};

const contextActionMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "context_action" as const,
  actionId: "open-link-new-tab",
};

const contextMenuMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "context_menu" as const,
  queryId: "query-1",
  point: { x: 8, y: 12 },
  actions: [
    {
      actionId: "open-link-new-tab",
      kind: "open-link-new-tab" as const,
      label: "Open link in new tab",
      targetUrl: "https://example.test",
    },
  ],
};

const clipboardCopyMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "clipboard_copy" as const,
  copyId: "copy-1",
};

const clipboardPasteMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "clipboard_paste" as const,
  pasteId: "paste-1",
  bytes: 32,
};

const clipboardOutcomeMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "clipboard_outcome" as const,
  outcome: {
    outcome: "copied" as const,
    copyId: "copy-1",
    bytes: 48,
  },
};

const transferCancelMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "transfer_cancel" as const,
  transferId: "transfer-1",
};

const transferCancelAckMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "transfer_cancel_ack" as const,
  transferId: "transfer-1",
};

const downloadCancelMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "download_cancel" as const,
  downloadId: "download-1",
};

const downloadAckMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "download_ack" as const,
  downloadId: "download-1",
  action: "cancelled" as const,
};

const downloadsUpdateMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "downloads_update" as const,
  update: {
    downloads: [],
    limits: {
      maxFileBytes: BROWSER_DOWNLOAD_MAX_FILE_BYTES,
      maxProfileBytes: BROWSER_DOWNLOAD_MAX_PROFILE_BYTES,
      expiryMs: BROWSER_DOWNLOAD_TTL_MS,
    },
    freeSpaceBytes: null,
  },
};

const pingMessage = {
  protocolVersion: PANEL_PROTOCOL_VERSION,
  type: "ping" as const,
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

const auxiliaryCases: ReadonlyArray<{
  name: string;
  message: PanelProtocolMessage;
  direction: "client-to-host" | "host-to-client";
  phase: "pre-redemption" | "authenticated";
}> = [
  {
    name: "dialog event",
    message: dialogMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "dialog response",
    message: dialogResponseMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "browser-context query",
    message: contextQueryMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "browser-context action",
    message: contextActionMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "browser-context menu",
    message: contextMenuMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "clipboard copy",
    message: clipboardCopyMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "clipboard paste",
    message: clipboardPasteMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "clipboard outcome",
    message: clipboardOutcomeMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "transfer cancellation",
    message: transferCancelMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "transfer cancellation acknowledgement",
    message: transferCancelAckMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "Host Download cancellation",
    message: downloadCancelMessage,
    direction: "client-to-host",
    phase: "authenticated",
  },
  {
    name: "Host Download acknowledgement",
    message: downloadAckMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "Host Download update",
    message: downloadsUpdateMessage,
    direction: "host-to-client",
    phase: "authenticated",
  },
  {
    name: "ping",
    message: pingMessage,
    direction: "client-to-host",
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

  it("encodes a stale-generation protocol error without leaking secrets", () => {
    const encoded = encodePanelProtocolMessage({
      protocolVersion: PANEL_PROTOCOL_VERSION,
      type: "protocol_error",
      category: "stale-generation",
      message:
        "The Browser Panel message belongs to a superseded connection generation.",
    });
    expect(encoded.outcome).toBe("encoded");
    if (encoded.outcome !== "encoded") return;
    const decoded = decodePanelProtocolMessage(encoded.raw, {
      direction: "host-to-client",
      phase: "authenticated",
    });
    expect(decoded.outcome).toBe("accepted");
    if (decoded.outcome !== "accepted") return;
    expect(decoded.message).toMatchObject({
      type: "protocol_error",
      category: "stale-generation",
    });
    expectPrivacySafe(
      decoded.message.type === "protocol_error" ? decoded.message.message : "",
    );
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

  it.each(auxiliaryCases)(
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

  it.each(auxiliaryCases)(
    "rejects $name before redemption",
    ({ message, direction }) => {
      const encoded = encodePanelProtocolMessage(message);
      expect(encoded.outcome).toBe("encoded");
      if (encoded.outcome !== "encoded") return;
      const decoded = decodePanelProtocolMessage(encoded.raw, {
        direction,
        phase: "pre-redemption",
      });
      expect(decoded.outcome).toBe("rejected");
      if (decoded.outcome !== "rejected") return;
      expect(decoded.error.category).toBe("invalid-phase");
      expectPrivacySafe(decoded.error.message);
    },
  );

  it("rejects a dialog event sent by a client as the wrong direction", () => {
    const encoded = encodePanelProtocolMessage(dialogMessage);
    expect(encoded.outcome).toBe("encoded");
    if (encoded.outcome !== "encoded") return;
    const decoded = decodePanelProtocolMessage(encoded.raw, {
      direction: "client-to-host",
      phase: "authenticated",
    });
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("invalid-direction");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects a dialog response sent by the host as the wrong direction", () => {
    const encoded = encodePanelProtocolMessage(dialogResponseMessage);
    expect(encoded.outcome).toBe("encoded");
    if (encoded.outcome !== "encoded") return;
    const decoded = decodePanelProtocolMessage(encoded.raw, {
      direction: "host-to-client",
      phase: "authenticated",
    });
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("invalid-direction");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects a malformed auxiliary message without leaking page or clipboard bytes", () => {
    const decoded = decodePanelProtocolMessage(
      JSON.stringify({
        protocolVersion: PANEL_PROTOCOL_VERSION,
        type: "dialog_response",
        dialogId: "dialog-1",
        accept: "yes",
        text: "typed-owner-input",
        url: "https://example.test",
      }),
      { direction: "client-to-host", phase: "authenticated" },
    );
    expect(decoded.outcome).toBe("rejected");
    if (decoded.outcome !== "rejected") return;
    expect(decoded.error.category).toBe("invalid-shape");
    expectPrivacySafe(decoded.error.message);
  });

  it("rejects an oversized auxiliary message before it reaches Browser Profile state", () => {
    const encoded = encodePanelProtocolMessage(dialogResponseMessage, {
      maxBytes: 8,
    });
    expect(encoded.outcome).toBe("rejected");
    if (encoded.outcome !== "rejected") return;
    expect(encoded.error.category).toBe("too-large");
    expectPrivacySafe(encoded.error.message);
  });
});
