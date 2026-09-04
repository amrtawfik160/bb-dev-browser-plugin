import { z } from "zod";
import {
  PANEL_GATEWAY_MESSAGE_MAX_BYTES,
  PANEL_PROTOCOL_VERSION,
  browserPanelControlStateSchema,
  browserTabStripSchema,
} from "./contracts.js";

/**
 * Shared versioned Panel wire protocol for the core authenticated stream.
 * Client and host both encode and decode through this module so they cannot
 * drift. Auxiliary dialog, context, clipboard, transfer, and Host Download
 * messages stay on the legacy path until their migration ticket.
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

export type PanelProtocolMessage =
  | PanelProtocolRedeemMessage
  | PanelProtocolReadyMessage
  | PanelProtocolFrameMessage
  | PanelProtocolInputMessage
  | PanelProtocolAckMessage
  | PanelProtocolSessionMessage
  | PanelProtocolErrorMessage;

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
  | { outcome: "legacy"; value: unknown }
  | { outcome: "rejected"; error: PanelProtocolError };

const utf8 = new TextEncoder();

const CORE_TYPES = [
  "redeem",
  "ready",
  "frame",
  "input",
  "ack",
  "session",
  "protocol_error",
] as const;

type PanelProtocolCoreType = (typeof CORE_TYPES)[number];

const AUXILIARY_TYPES = new Set([
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
]);

const MESSAGE_DIRECTION: Record<PanelProtocolCoreType, PanelProtocolDirection> =
  {
    redeem: "client-to-host",
    input: "client-to-host",
    ack: "client-to-host",
    ready: "host-to-client",
    frame: "host-to-client",
    session: "host-to-client",
    protocol_error: "host-to-client",
  };

const MESSAGE_PHASES: Record<
  PanelProtocolCoreType,
  readonly PanelProtocolPhase[]
> = {
  redeem: ["pre-redemption"],
  ready: ["authenticated"],
  frame: ["authenticated"],
  input: ["authenticated"],
  ack: ["authenticated"],
  session: ["authenticated"],
  protocol_error: ["pre-redemption", "authenticated"],
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

function isCoreType(value: string): value is PanelProtocolCoreType {
  return (CORE_TYPES as readonly string[]).includes(value);
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

function parseCoreMessage(
  type: PanelProtocolCoreType,
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
  const parsed = protocolErrorSchema.safeParse(value);
  if (!parsed.success) return rejected("invalid-shape");
  return {
    outcome: "accepted",
    message: normalizeProtocolError(parsed.data.category),
  };
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
  if (AUXILIARY_TYPES.has(type)) {
    return { outcome: "legacy", value };
  }
  const aliased = decodeLegacyAliases(type, value, context);
  if (aliased !== undefined) return aliased;
  if (!isCoreType(type)) return rejected("unknown-type");
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
