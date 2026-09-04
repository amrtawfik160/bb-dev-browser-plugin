import { z } from "zod";
import {
  PANEL_GATEWAY_MESSAGE_MAX_BYTES,
  PANEL_PROTOCOL_VERSION,
  browserClipboardCopyMessageSchema,
  browserClipboardOutcomeSchema,
  browserClipboardPasteMessageSchema,
  browserContextActionMessageSchema,
  browserContextActionSchema,
  browserContextQueryMessageSchema,
  browserDialogEventSchema,
  browserDialogResponseMessageSchema,
  browserDownloadCancelMessageSchema,
  browserDownloadListResultSchema,
  browserPanelControlStateSchema,
  browserTabStripSchema,
  browserTransferCancelMessageSchema,
} from "./contracts.js";

/**
 * Shared versioned Panel wire protocol. Client and host both encode and decode
 * through this module so they cannot drift. Core stream messages and the
 * remaining dialog, browser-context, clipboard, transfer, and Host Download
 * families share the same direction, phase, shape, and size checks.
 */

export { PANEL_PROTOCOL_VERSION };

export type PanelProtocolDirection = "client-to-host" | "host-to-client";
export type PanelProtocolPhase = "pre-redemption" | "authenticated";

export type PanelProtocolErrorCategory =
  | "malformed"
  | "unknown-type"
  | "incompatible-version"
  | "too-large"
  | "invalid-direction"
  | "invalid-phase"
  | "invalid-shape";

export type PanelProtocolError = {
  category: PanelProtocolErrorCategory;
  message: string;
};

export type PanelProtocolRedeemMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "redeem";
  capabilityId: string;
  secret: string;
  ownerSessionId: string;
  panelId: string;
};

export type PanelProtocolReadyMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "ready";
  viewport: { width: number; height: number };
  fps: number;
};

export type PanelProtocolFrameMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "frame";
  sequence: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
};

export type PanelProtocolInputMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "input";
  sequence: number;
  payload: unknown;
};

export type PanelProtocolAckMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "ack";
  sequence: number;
};

export type PanelProtocolSessionMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "session";
  control: z.infer<typeof browserPanelControlStateSchema>;
  tabs: z.infer<typeof browserTabStripSchema>;
};

export type PanelProtocolErrorMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "protocol_error";
  category: PanelProtocolErrorCategory;
  message: string;
};

export type PanelProtocolDialogMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "dialog";
  dialog: z.infer<typeof browserDialogEventSchema>;
};

export type PanelProtocolDialogResponseMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "dialog_response";
  dialogId: string;
  accept: boolean;
  text?: string;
};

export type PanelProtocolContextQueryMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "context_query";
  queryId: string;
  x: number;
  y: number;
};

export type PanelProtocolContextActionMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "context_action";
  actionId: string;
};

export type PanelProtocolContextMenuMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "context_menu";
  queryId: string;
  point: { x: number; y: number };
  actions: Array<z.infer<typeof browserContextActionSchema>>;
};

export type PanelProtocolClipboardCopyMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "clipboard_copy";
  copyId: string;
};

export type PanelProtocolClipboardPasteMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "clipboard_paste";
  pasteId: string;
  bytes: number;
};

export type PanelProtocolClipboardOutcomeMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "clipboard_outcome";
  outcome: z.infer<typeof browserClipboardOutcomeSchema>;
};

export type PanelProtocolTransferCancelMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "transfer_cancel";
  transferId: string;
};

export type PanelProtocolTransferCancelAckMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "transfer_cancel_ack";
  transferId: string;
};

export type PanelProtocolDownloadCancelMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "download_cancel";
  downloadId: string;
};

export type PanelProtocolDownloadAckMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "download_ack";
  downloadId: string;
  action: "cancelled";
};

export type PanelProtocolDownloadsUpdateMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "downloads_update";
  update: z.infer<typeof browserDownloadListResultSchema>;
};

export type PanelProtocolPingMessage = {
  protocolVersion: typeof PANEL_PROTOCOL_VERSION;
  type: "ping";
};

export type PanelProtocolMessage =
  | PanelProtocolRedeemMessage
  | PanelProtocolReadyMessage
  | PanelProtocolFrameMessage
  | PanelProtocolInputMessage
  | PanelProtocolAckMessage
  | PanelProtocolSessionMessage
  | PanelProtocolErrorMessage
  | PanelProtocolDialogMessage
  | PanelProtocolDialogResponseMessage
  | PanelProtocolContextQueryMessage
  | PanelProtocolContextActionMessage
  | PanelProtocolContextMenuMessage
  | PanelProtocolClipboardCopyMessage
  | PanelProtocolClipboardPasteMessage
  | PanelProtocolClipboardOutcomeMessage
  | PanelProtocolTransferCancelMessage
  | PanelProtocolTransferCancelAckMessage
  | PanelProtocolDownloadCancelMessage
  | PanelProtocolDownloadAckMessage
  | PanelProtocolDownloadsUpdateMessage
  | PanelProtocolPingMessage;

export type PanelProtocolEncodeResult =
  | { outcome: "encoded"; raw: string }
  | { outcome: "rejected"; error: PanelProtocolError };

export type PanelProtocolDecodeContext = {
  direction: PanelProtocolDirection;
  phase: PanelProtocolPhase;
  maxBytes?: number;
};

export type PanelProtocolDecodeResult =
  | { outcome: "accepted"; message: PanelProtocolMessage }
  | { outcome: "rejected"; error: PanelProtocolError };

const utf8 = new TextEncoder();

const PROTOCOL_TYPES = [
  "redeem",
  "ready",
  "frame",
  "input",
  "ack",
  "session",
  "protocol_error",
  "dialog",
  "dialog_response",
  "context_query",
  "context_action",
  "context_menu",
  "clipboard_copy",
  "clipboard_paste",
  "clipboard_outcome",
  "transfer_cancel",
  "transfer_cancel_ack",
  "download_cancel",
  "download_ack",
  "downloads_update",
  "ping",
] as const;

type PanelProtocolType = (typeof PROTOCOL_TYPES)[number];

const MESSAGE_DIRECTION: Record<PanelProtocolType, PanelProtocolDirection> = {
  redeem: "client-to-host",
  input: "client-to-host",
  ack: "client-to-host",
  dialog_response: "client-to-host",
  context_query: "client-to-host",
  context_action: "client-to-host",
  clipboard_copy: "client-to-host",
  clipboard_paste: "client-to-host",
  transfer_cancel: "client-to-host",
  download_cancel: "client-to-host",
  ping: "client-to-host",
  ready: "host-to-client",
  frame: "host-to-client",
  session: "host-to-client",
  protocol_error: "host-to-client",
  dialog: "host-to-client",
  context_menu: "host-to-client",
  clipboard_outcome: "host-to-client",
  transfer_cancel_ack: "host-to-client",
  download_ack: "host-to-client",
  downloads_update: "host-to-client",
};

const MESSAGE_PHASES: Record<PanelProtocolType, readonly PanelProtocolPhase[]> =
  {
    redeem: ["pre-redemption"],
    protocol_error: ["pre-redemption", "authenticated"],
    ready: ["authenticated"],
    frame: ["authenticated"],
    input: ["authenticated"],
    ack: ["authenticated"],
    session: ["authenticated"],
    dialog: ["authenticated"],
    dialog_response: ["authenticated"],
    context_query: ["authenticated"],
    context_action: ["authenticated"],
    context_menu: ["authenticated"],
    clipboard_copy: ["authenticated"],
    clipboard_paste: ["authenticated"],
    clipboard_outcome: ["authenticated"],
    transfer_cancel: ["authenticated"],
    transfer_cancel_ack: ["authenticated"],
    download_cancel: ["authenticated"],
    download_ack: ["authenticated"],
    downloads_update: ["authenticated"],
    ping: ["authenticated"],
  };

const PROTOCOL_ERROR_MESSAGES: Record<PanelProtocolErrorCategory, string> = {
  malformed: "The Browser Panel message is not valid JSON.",
  "unknown-type": "The Browser Panel message type is not recognized.",
  "incompatible-version":
    "The Browser Panel protocol version is not supported.",
  "too-large": "The Browser Panel message exceeds the size cap.",
  "invalid-direction":
    "The Browser Panel message was sent in the wrong direction.",
  "invalid-phase":
    "The Browser Panel message is not allowed in this lifecycle phase.",
  "invalid-shape": "The Browser Panel message failed shape validation.",
};

const protocolVersionField = z.literal(PANEL_PROTOCOL_VERSION).optional();

const redeemSchema = z
  .object({
    type: z.literal("redeem"),
    protocolVersion: protocolVersionField,
    capabilityId: z.string().min(1),
    secret: z.string().min(1),
    ownerSessionId: z.string().min(1),
    panelId: z.string().min(1),
  })
  .strict();

const readySchema = z
  .object({
    type: z.literal("ready"),
    protocolVersion: protocolVersionField,
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    fps: z.number().int().positive(),
  })
  .strict();

const frameSchema = z
  .object({
    type: z.literal("frame"),
    protocolVersion: protocolVersionField,
    sequence: z.number().int().nonnegative(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    data: z.string().min(1),
  })
  .strict();

const inputSchema = z
  .object({
    type: z.literal("input"),
    protocolVersion: protocolVersionField,
    sequence: z.number().int().nonnegative(),
    payload: z.unknown(),
  })
  .strict();

const ackSchema = z
  .object({
    type: z.literal("ack"),
    protocolVersion: protocolVersionField,
    sequence: z.number().int().nonnegative(),
  })
  .strict();

const sessionSchema = z
  .object({
    type: z.literal("session"),
    protocolVersion: protocolVersionField,
    control: browserPanelControlStateSchema,
    tabs: browserTabStripSchema,
  })
  .strict();

const protocolErrorSchema = z
  .object({
    type: z.literal("protocol_error"),
    protocolVersion: protocolVersionField,
    category: z.enum([
      "malformed",
      "unknown-type",
      "incompatible-version",
      "too-large",
      "invalid-direction",
      "invalid-phase",
      "invalid-shape",
    ]),
    message: z.string().min(1),
  })
  .strict();

const dialogSchema = z
  .object({
    type: z.literal("dialog"),
    protocolVersion: protocolVersionField,
    dialog: browserDialogEventSchema,
  })
  .strict();

const dialogResponseSchema = browserDialogResponseMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const contextQuerySchema = browserContextQueryMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const contextActionSchema = browserContextActionMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const contextMenuSchema = z
  .object({
    type: z.literal("context_menu"),
    protocolVersion: protocolVersionField,
    queryId: z.string().min(1),
    point: z.object({ x: z.number(), y: z.number() }).strict(),
    actions: z.array(browserContextActionSchema),
  })
  .strict();

const clipboardCopySchema = browserClipboardCopyMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const clipboardPasteSchema = browserClipboardPasteMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const clipboardOutcomeSchema = z
  .object({
    type: z.literal("clipboard_outcome"),
    protocolVersion: protocolVersionField,
    outcome: browserClipboardOutcomeSchema,
  })
  .strict();

const transferCancelSchema = browserTransferCancelMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const transferCancelAckSchema = z
  .object({
    type: z.literal("transfer_cancel_ack"),
    protocolVersion: protocolVersionField,
    transferId: z.string().min(1).max(120),
  })
  .strict();

const downloadCancelSchema = browserDownloadCancelMessageSchema.extend({
  protocolVersion: protocolVersionField,
});

const downloadAckSchema = z
  .object({
    type: z.literal("download_ack"),
    protocolVersion: protocolVersionField,
    downloadId: z.string().min(1).max(120),
    action: z.literal("cancelled"),
  })
  .strict();

const downloadsUpdateSchema = z
  .object({
    type: z.literal("downloads_update"),
    protocolVersion: protocolVersionField,
    update: browserDownloadListResultSchema,
  })
  .strict();

const pingSchema = z
  .object({
    type: z.literal("ping"),
    protocolVersion: protocolVersionField,
  })
  .strict();

const legacyControlSchema = z
  .object({
    type: z.literal("control"),
    control: browserPanelControlStateSchema,
    tabs: browserTabStripSchema,
  })
  .strict();

const legacyErrorSchema = z
  .object({
    type: z.literal("error"),
    reason: z.string().min(1),
  })
  .strict();

function utf8ByteLength(value: string) {
  return utf8.encode(value).byteLength;
}

function protocolError(
  category: PanelProtocolErrorCategory,
): PanelProtocolError {
  return { category, message: PROTOCOL_ERROR_MESSAGES[category] };
}

function rejected(
  category: PanelProtocolErrorCategory,
): Extract<PanelProtocolDecodeResult, { outcome: "rejected" }> {
  return { outcome: "rejected", error: protocolError(category) };
}

function isProtocolType(value: string): value is PanelProtocolType {
  return (PROTOCOL_TYPES as readonly string[]).includes(value);
}

function parseJsonObject(
  raw: string,
):
  | { outcome: "accepted"; value: Record<string, unknown> }
  | { outcome: "rejected"; error: PanelProtocolError } {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return rejected("malformed");
    }
    return { outcome: "accepted", value: value as Record<string, unknown> };
  } catch {
    return rejected("malformed");
  }
}

function normalizeRedeem(
  value: z.infer<typeof redeemSchema>,
): PanelProtocolRedeemMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "redeem",
    capabilityId: value.capabilityId,
    secret: value.secret,
    ownerSessionId: value.ownerSessionId,
    panelId: value.panelId,
  };
}

function normalizeReady(
  value: z.infer<typeof readySchema>,
): PanelProtocolReadyMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "ready",
    viewport: value.viewport,
    fps: value.fps,
  };
}

function normalizeFrame(
  value: z.infer<typeof frameSchema>,
): PanelProtocolFrameMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "frame",
    sequence: value.sequence,
    mimeType: value.mimeType,
    data: value.data,
  };
}

function normalizeInput(
  value: z.infer<typeof inputSchema>,
): PanelProtocolInputMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "input",
    sequence: value.sequence,
    payload: value.payload,
  };
}

function normalizeAck(
  value: z.infer<typeof ackSchema>,
): PanelProtocolAckMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "ack",
    sequence: value.sequence,
  };
}

function normalizeSession(
  control: z.infer<typeof browserPanelControlStateSchema>,
  tabs: z.infer<typeof browserTabStripSchema>,
): PanelProtocolSessionMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "session",
    control,
    tabs,
  };
}

function normalizeProtocolError(
  category: PanelProtocolErrorCategory,
): PanelProtocolErrorMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "protocol_error",
    category,
    message: PROTOCOL_ERROR_MESSAGES[category],
  };
}

function normalizeDialog(
  value: z.infer<typeof dialogSchema>,
): PanelProtocolDialogMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "dialog",
    dialog: value.dialog,
  };
}

function normalizeDialogResponse(
  value: z.infer<typeof dialogResponseSchema>,
): PanelProtocolDialogResponseMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "dialog_response",
    dialogId: value.dialogId,
    accept: value.accept,
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

function normalizeContextQuery(
  value: z.infer<typeof contextQuerySchema>,
): PanelProtocolContextQueryMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "context_query",
    queryId: value.queryId,
    x: value.x,
    y: value.y,
  };
}

function normalizeContextAction(
  value: z.infer<typeof contextActionSchema>,
): PanelProtocolContextActionMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "context_action",
    actionId: value.actionId,
  };
}

function normalizeContextMenu(
  value: z.infer<typeof contextMenuSchema>,
): PanelProtocolContextMenuMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "context_menu",
    queryId: value.queryId,
    point: value.point,
    actions: value.actions,
  };
}

function normalizeClipboardCopy(
  value: z.infer<typeof clipboardCopySchema>,
): PanelProtocolClipboardCopyMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "clipboard_copy",
    copyId: value.copyId,
  };
}

function normalizeClipboardPaste(
  value: z.infer<typeof clipboardPasteSchema>,
): PanelProtocolClipboardPasteMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "clipboard_paste",
    pasteId: value.pasteId,
    bytes: value.bytes,
  };
}

function normalizeClipboardOutcome(
  value: z.infer<typeof clipboardOutcomeSchema>,
): PanelProtocolClipboardOutcomeMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "clipboard_outcome",
    outcome: value.outcome,
  };
}

function normalizeTransferCancel(
  value: z.infer<typeof transferCancelSchema>,
): PanelProtocolTransferCancelMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "transfer_cancel",
    transferId: value.transferId,
  };
}

function normalizeTransferCancelAck(
  value: z.infer<typeof transferCancelAckSchema>,
): PanelProtocolTransferCancelAckMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "transfer_cancel_ack",
    transferId: value.transferId,
  };
}

function normalizeDownloadCancel(
  value: z.infer<typeof downloadCancelSchema>,
): PanelProtocolDownloadCancelMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "download_cancel",
    downloadId: value.downloadId,
  };
}

function normalizeDownloadAck(
  value: z.infer<typeof downloadAckSchema>,
): PanelProtocolDownloadAckMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "download_ack",
    downloadId: value.downloadId,
    action: value.action,
  };
}

function normalizeDownloadsUpdate(
  value: z.infer<typeof downloadsUpdateSchema>,
): PanelProtocolDownloadsUpdateMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "downloads_update",
    update: value.update,
  };
}

function normalizePing(): PanelProtocolPingMessage {
  return {
    protocolVersion: PANEL_PROTOCOL_VERSION,
    type: "ping",
  };
}

function parseAccepted<T>(
  parsed: { success: false } | { success: true; data: T },
  message: (value: T) => PanelProtocolMessage,
): PanelProtocolDecodeResult {
  if (!parsed.success) return rejected("invalid-shape");
  return { outcome: "accepted", message: message(parsed.data) };
}

function parseCoreMessage(
  type: PanelProtocolType,
  value: Record<string, unknown>,
): PanelProtocolDecodeResult {
  if (type === "redeem") {
    const parsed = redeemSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return { outcome: "accepted", message: normalizeRedeem(parsed.data) };
  }
  if (type === "ready") {
    const parsed = readySchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return { outcome: "accepted", message: normalizeReady(parsed.data) };
  }
  if (type === "frame") {
    const parsed = frameSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return { outcome: "accepted", message: normalizeFrame(parsed.data) };
  }
  if (type === "input") {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return { outcome: "accepted", message: normalizeInput(parsed.data) };
  }
  if (type === "ack") {
    const parsed = ackSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return { outcome: "accepted", message: normalizeAck(parsed.data) };
  }
  if (type === "session") {
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return {
      outcome: "accepted",
      message: normalizeSession(parsed.data.control, parsed.data.tabs),
    };
  }
  if (type === "protocol_error") {
    const parsed = protocolErrorSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return {
      outcome: "accepted",
      message: normalizeProtocolError(parsed.data.category),
    };
  }
  return parseAuxiliaryMessage(type, value);
}

function parseAuxiliaryMessage(
  type: PanelProtocolType,
  value: Record<string, unknown>,
): PanelProtocolDecodeResult {
  if (type === "dialog") {
    return parseAccepted(dialogSchema.safeParse(value), normalizeDialog);
  }
  if (type === "dialog_response") {
    return parseAccepted(
      dialogResponseSchema.safeParse(value),
      normalizeDialogResponse,
    );
  }
  if (type === "context_query") {
    return parseAccepted(
      contextQuerySchema.safeParse(value),
      normalizeContextQuery,
    );
  }
  if (type === "context_action") {
    return parseAccepted(
      contextActionSchema.safeParse(value),
      normalizeContextAction,
    );
  }
  if (type === "context_menu") {
    return parseAccepted(
      contextMenuSchema.safeParse(value),
      normalizeContextMenu,
    );
  }
  if (type === "clipboard_copy") {
    return parseAccepted(
      clipboardCopySchema.safeParse(value),
      normalizeClipboardCopy,
    );
  }
  if (type === "clipboard_paste") {
    return parseAccepted(
      clipboardPasteSchema.safeParse(value),
      normalizeClipboardPaste,
    );
  }
  if (type === "clipboard_outcome") {
    return parseAccepted(
      clipboardOutcomeSchema.safeParse(value),
      normalizeClipboardOutcome,
    );
  }
  if (type === "transfer_cancel") {
    return parseAccepted(
      transferCancelSchema.safeParse(value),
      normalizeTransferCancel,
    );
  }
  if (type === "transfer_cancel_ack") {
    return parseAccepted(
      transferCancelAckSchema.safeParse(value),
      normalizeTransferCancelAck,
    );
  }
  if (type === "download_cancel") {
    return parseAccepted(
      downloadCancelSchema.safeParse(value),
      normalizeDownloadCancel,
    );
  }
  if (type === "download_ack") {
    return parseAccepted(
      downloadAckSchema.safeParse(value),
      normalizeDownloadAck,
    );
  }
  if (type === "downloads_update") {
    return parseAccepted(
      downloadsUpdateSchema.safeParse(value),
      normalizeDownloadsUpdate,
    );
  }
  return parseAccepted(pingSchema.safeParse(value), () => normalizePing());
}

function decodeLegacyAliases(
  type: string,
  value: Record<string, unknown>,
  context: PanelProtocolDecodeContext,
): PanelProtocolDecodeResult | undefined {
  if (type === "control") {
    if (context.direction !== "host-to-client")
      return rejected("invalid-direction");
    if (context.phase !== "authenticated") return rejected("invalid-phase");
    const parsed = legacyControlSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return {
      outcome: "accepted",
      message: normalizeSession(parsed.data.control, parsed.data.tabs),
    };
  }
  if (type === "error") {
    if (context.direction !== "host-to-client")
      return rejected("invalid-direction");
    const parsed = legacyErrorSchema.safeParse(value);
    if (!parsed.success) return rejected("invalid-shape");
    return {
      outcome: "accepted",
      message: normalizeProtocolError(legacyErrorCategory(parsed.data.reason)),
    };
  }
  return undefined;
}

function legacyErrorCategory(reason: string): PanelProtocolErrorCategory {
  if (reason === "too-large") return "too-large";
  if (reason === "incompatible-version") return "incompatible-version";
  if (reason === "invalid-direction") return "invalid-direction";
  if (reason === "invalid-phase" || reason === "unauthorized") {
    return "invalid-phase";
  }
  if (reason === "unknown-type") return "unknown-type";
  return "malformed";
}

export function encodePanelProtocolMessage(
  message: PanelProtocolMessage,
  options: { maxBytes?: number } = {},
): PanelProtocolEncodeResult {
  const raw = JSON.stringify(message);
  const maxBytes = options.maxBytes ?? PANEL_GATEWAY_MESSAGE_MAX_BYTES;
  if (utf8ByteLength(raw) > maxBytes) {
    return { outcome: "rejected", error: protocolError("too-large") };
  }
  return { outcome: "encoded", raw };
}

export function decodePanelProtocolMessage(
  raw: string,
  context: PanelProtocolDecodeContext,
): PanelProtocolDecodeResult {
  const maxBytes = context.maxBytes ?? PANEL_GATEWAY_MESSAGE_MAX_BYTES;
  if (utf8ByteLength(raw) > maxBytes) return rejected("too-large");
  const parsed = parseJsonObject(raw);
  if (parsed.outcome === "rejected") return parsed;
  const value = parsed.value;
  if (
    value.protocolVersion !== undefined &&
    value.protocolVersion !== PANEL_PROTOCOL_VERSION
  ) {
    return rejected("incompatible-version");
  }
  const type = value.type;
  if (typeof type !== "string" || type.length === 0) {
    return rejected("invalid-shape");
  }
  const aliased = decodeLegacyAliases(type, value, context);
  if (aliased !== undefined) return aliased;
  if (!isProtocolType(type)) return rejected("unknown-type");
  if (MESSAGE_DIRECTION[type] !== context.direction) {
    return rejected("invalid-direction");
  }
  if (!MESSAGE_PHASES[type].includes(context.phase)) {
    return rejected("invalid-phase");
  }
  return parseCoreMessage(type, value);
}

export function panelProtocolErrorMessage(
  category: PanelProtocolErrorCategory,
): PanelProtocolErrorMessage {
  return normalizeProtocolError(category);
}

export function toBrowserPanelRedeemMessage(
  message: PanelProtocolRedeemMessage,
): {
  type: "redeem";
  capabilityId: string;
  secret: string;
  ownerSessionId: string;
  panelId: string;
} {
  return {
    type: "redeem",
    capabilityId: message.capabilityId,
    secret: message.secret,
    ownerSessionId: message.ownerSessionId,
    panelId: message.panelId,
  };
}
