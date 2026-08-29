import { randomInt } from "node:crypto";
import {
  PANEL_GATEWAY_BIND_HOST,
  PANEL_GATEWAY_BANDWIDTH_BYTES_PER_SECOND,
  PANEL_GATEWAY_INPUT_MAX_PER_SECOND,
  PANEL_GATEWAY_MESSAGE_MAX_BYTES,
  browserDialogResponseMessageSchema,
  browserContextQueryMessageSchema,
  browserContextActionMessageSchema,
  browserClipboardCopyMessageSchema,
  browserClipboardPasteMessageSchema,
  browserTransferCancelMessageSchema,
  browserPanelRedeemMessageSchema,
  type BrowserPanelRedeemMessage,
} from "./contracts.js";
import type { PanelCapabilityStore } from "./panel-capability.js";

/**
 * The dynamic loopback gateway validates message shape and size, rate-limits
 * input, caps panel bandwidth, and drops stale video frames before delaying
 * input. Each retained worker generation chooses a dynamic loopback port and
 * declares it only while active. Chrome, CDP, and the gateway never bind
 * externally; the gateway binds to 127.0.0.1 only.
 */

export type PanelGatewayMessage =
  | { kind: "redeem"; message: BrowserPanelRedeemMessage }
  | { kind: "input"; sequence: number; payload: unknown }
  | { kind: "frame"; sequence: number; bytes: number; deadlineAt: number }
  | { kind: "ack"; sequence: number }
  | { kind: "ping" }
  | {
      kind: "dialog_response";
      dialogId: string;
      accept: boolean;
      text?: string;
    }
  | { kind: "context_query"; queryId: string; x: number; y: number }
  | { kind: "context_action"; actionId: string }
  | { kind: "clipboard_copy"; copyId: string }
  | { kind: "clipboard_paste"; pasteId: string; bytes: number }
  | { kind: "transfer_cancel"; transferId: string };

export type PanelGatewayValidationResult =
  | { outcome: "accepted"; message: PanelGatewayMessage }
  | { outcome: "rejected"; reason: PanelGatewayRejectReason; message: string };

export type PanelGatewayRejectReason =
  | "malformed"
  | "too-large"
  | "rate-limited"
  | "bandwidth-exceeded"
  | "stale-frame"
  | "unauthorized"
  | "binding-mismatch";

export type PanelGatewayClock = { now(): number };

export type PanelGatewayOptions = {
  capabilities: PanelCapabilityStore;
  clock?: PanelGatewayClock;
  bindHost?: string;
  messageMaxBytes?: number;
  inputMaxPerSecond?: number;
  bandwidthBytesPerSecond?: number;
  hostId: string;
  profileId: string;
};

export type PanelGateway = ReturnType<typeof createPanelGateway>;

type RateBucket = {
  windowStart: number;
  count: number;
};

type FrameState = {
  lastEmittedSequence: number;
  pendingBytesInWindow: number;
  windowStart: number;
  lastInputSequence: number;
};

type ParsedMessage = { malformed: false; value: unknown } | { malformed: true };

function parseMessage(raw: string): ParsedMessage {
  try {
    return { malformed: false, value: JSON.parse(raw) };
  } catch {
    return { malformed: true };
  }
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

export function createPanelGateway(options: PanelGatewayOptions) {
  const clock = options.clock ?? { now: () => Date.now() };
  const bindHost = options.bindHost ?? PANEL_GATEWAY_BIND_HOST;
  const messageMaxBytes =
    options.messageMaxBytes ?? PANEL_GATEWAY_MESSAGE_MAX_BYTES;
  const inputMaxPerSecond =
    options.inputMaxPerSecond ?? PANEL_GATEWAY_INPUT_MAX_PER_SECOND;
  const bandwidthBytesPerSecond =
    options.bandwidthBytesPerSecond ?? PANEL_GATEWAY_BANDWIDTH_BYTES_PER_SECOND;
  const capabilities = options.capabilities;
  const hostId = options.hostId;
  const profileId = options.profileId;
  let redeemedCapabilityId: string | undefined;
  const inputBucket: RateBucket = { windowStart: clock.now(), count: 0 };
  /**
   * Dialog and context-action requests are controller-only chrome actions, not
   * pixel input, but they share the gateway's input rate bucket so a flooding
   * client cannot starve frames or bypass the per-second cap.
   */
  const chromeBucket: RateBucket = { windowStart: clock.now(), count: 0 };
  const frameState: FrameState = {
    lastEmittedSequence: 0,
    pendingBytesInWindow: 0,
    windowStart: clock.now(),
    lastInputSequence: 0,
  };
  const acceptedFrames: number[] = [];

  /**
   * Bind host is always loopback. The gateway never opens an external listener;
   * the server declares the dynamic port to BB Connect for owner-session-gated
   * tunneling instead.
   */
  function declaredBindHost() {
    return bindHost;
  }

  function choosePort(): number {
    // Dynamic per-worker-generation port in the IANA ephemeral range. Real
    // binding happens on the host; the server declares this port to BB Connect
    // for owner-session-gated tunneling instead of exposing it directly.
    return randomInt(49152, 65536);
  }

  function resetInputWindow(now: number) {
    if (now - inputBucket.windowStart >= 1000) {
      inputBucket.windowStart = now;
      inputBucket.count = 0;
    }
  }

  function admitChromeAction(now: number): boolean {
    if (now - chromeBucket.windowStart >= 1000) {
      chromeBucket.windowStart = now;
      chromeBucket.count = 0;
    }
    if (chromeBucket.count >= inputMaxPerSecond) return false;
    chromeBucket.count += 1;
    return true;
  }

  function resetBandwidthWindow(now: number) {
    if (now - frameState.windowStart >= 1000) {
      frameState.windowStart = now;
      frameState.pendingBytesInWindow = 0;
    }
  }

  function validate(raw: string): PanelGatewayValidationResult {
    const size = byteLength(raw);
    if (size > messageMaxBytes) {
      return {
        outcome: "rejected",
        reason: "too-large",
        message: `Panel gateway message exceeds the ${messageMaxBytes}-byte cap.`,
      };
    }
    const parsedMessage = parseMessage(raw);
    if (parsedMessage.malformed) {
      return {
        outcome: "rejected",
        reason: "malformed",
        message: "Panel gateway message is not valid JSON.",
      };
    }
    const parsed = parsedMessage.value;
    const envelope = parsed as { type?: unknown };
    if (envelope === null || typeof envelope !== "object") {
      return {
        outcome: "rejected",
        reason: "malformed",
        message: "Panel gateway message is not an object.",
      };
    }
    if (envelope.type === "redeem") {
      const redeemResult = browserPanelRedeemMessageSchema.safeParse(parsed);
      if (!redeemResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway redeem message failed shape validation.",
        };
      }
      const message = redeemResult.data;
      if (redeemedCapabilityId !== undefined) {
        return {
          outcome: "rejected",
          reason: "unauthorized",
          message:
            "A Panel Capability has already been redeemed on this gateway.",
        };
      }
      const result = capabilities.redeem(message, hostId, profileId);
      if (result.outcome !== "redeemed") {
        return {
          outcome: "rejected",
          reason:
            result.outcome === "binding-mismatch"
              ? "binding-mismatch"
              : "unauthorized",
          message: `Panel Capability redemption failed: ${result.outcome}.`,
        };
      }
      redeemedCapabilityId = result.connection.capabilityId;
      return { outcome: "accepted", message: { kind: "redeem", message } };
    }
    if (redeemedCapabilityId === undefined) {
      return {
        outcome: "rejected",
        reason: "unauthorized",
        message:
          "The Panel Capability must be redeemed before any other message.",
      };
    }
    if (envelope.type === "input") {
      const input = parsed as { sequence?: unknown; payload?: unknown };
      if (
        typeof input.sequence !== "number" ||
        !Number.isInteger(input.sequence) ||
        input.sequence < 0
      ) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway input message is missing a valid sequence.",
        };
      }
      const sequence = input.sequence;
      if (sequence <= frameState.lastInputSequence) {
        return {
          outcome: "rejected",
          reason: "stale-frame",
          message: "Panel gateway input is stale and was dropped.",
        };
      }
      const now = clock.now();
      resetInputWindow(now);
      if (inputBucket.count >= inputMaxPerSecond) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway input exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      inputBucket.count += 1;
      frameState.lastInputSequence = sequence;
      return {
        outcome: "accepted",
        message: { kind: "input", sequence, payload: input.payload },
      };
    }
    if (envelope.type === "frame") {
      const frame = parsed as {
        sequence?: unknown;
        bytes?: unknown;
        deadlineAt?: unknown;
      };
      if (
        typeof frame.sequence !== "number" ||
        !Number.isInteger(frame.sequence) ||
        typeof frame.bytes !== "number" ||
        typeof frame.deadlineAt !== "number"
      ) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway frame message failed shape validation.",
        };
      }
      const now = clock.now();
      // Drop stale frames before delaying input. A frame whose deadline passed
      // or whose sequence is older than the last emitted frame is dropped so a
      // congested uplink never blocks input behind a backlog of old pixels.
      if (frame.sequence <= frameState.lastEmittedSequence) {
        return {
          outcome: "rejected",
          reason: "stale-frame",
          message: "Panel gateway frame is stale and was dropped.",
        };
      }
      if (frame.deadlineAt < now) {
        return {
          outcome: "rejected",
          reason: "stale-frame",
          message: "Panel gateway frame exceeded its deadline and was dropped.",
        };
      }
      resetBandwidthWindow(now);
      if (
        frameState.pendingBytesInWindow + frame.bytes >
        bandwidthBytesPerSecond
      ) {
        return {
          outcome: "rejected",
          reason: "bandwidth-exceeded",
          message: `Panel gateway frame exceeded the ${bandwidthBytesPerSecond}-bytes-per-second bandwidth cap.`,
        };
      }
      frameState.pendingBytesInWindow += frame.bytes;
      frameState.lastEmittedSequence = frame.sequence;
      acceptedFrames.push(frame.sequence);
      return {
        outcome: "accepted",
        message: {
          kind: "frame",
          sequence: frame.sequence,
          bytes: frame.bytes,
          deadlineAt: frame.deadlineAt,
        },
      };
    }
    if (envelope.type === "ack") {
      const ack = parsed as { sequence?: unknown };
      if (typeof ack.sequence !== "number" || !Number.isInteger(ack.sequence)) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway ack message is missing a valid sequence.",
        };
      }
      return {
        outcome: "accepted",
        message: { kind: "ack", sequence: ack.sequence },
      };
    }
    if (envelope.type === "ping") {
      return { outcome: "accepted", message: { kind: "ping" } };
    }
    if (envelope.type === "dialog_response") {
      const dialogResult = browserDialogResponseMessageSchema.safeParse(parsed);
      if (!dialogResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway dialog response failed shape validation.",
        };
      }
      if (!admitChromeAction(clock.now())) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway dialog response exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      return {
        outcome: "accepted",
        message: {
          kind: "dialog_response",
          dialogId: dialogResult.data.dialogId,
          accept: dialogResult.data.accept,
          text: dialogResult.data.text,
        },
      };
    }
    if (envelope.type === "context_query") {
      const queryResult = browserContextQueryMessageSchema.safeParse(parsed);
      if (!queryResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway context query failed shape validation.",
        };
      }
      if (!admitChromeAction(clock.now())) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway context query exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      return {
        outcome: "accepted",
        message: {
          kind: "context_query",
          queryId: queryResult.data.queryId,
          x: queryResult.data.x,
          y: queryResult.data.y,
        },
      };
    }
    if (envelope.type === "context_action") {
      const actionResult = browserContextActionMessageSchema.safeParse(parsed);
      if (!actionResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway context action failed shape validation.",
        };
      }
      if (!admitChromeAction(clock.now())) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway context action exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      return {
        outcome: "accepted",
        message: {
          kind: "context_action",
          actionId: actionResult.data.actionId,
        },
      };
    }
    if (envelope.type === "clipboard_copy") {
      const copyResult = browserClipboardCopyMessageSchema.safeParse(parsed);
      if (!copyResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway clipboard copy failed shape validation.",
        };
      }
      if (!admitChromeAction(clock.now())) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway clipboard copy exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      return {
        outcome: "accepted",
        message: { kind: "clipboard_copy", copyId: copyResult.data.copyId },
      };
    }
    if (envelope.type === "clipboard_paste") {
      const pasteResult = browserClipboardPasteMessageSchema.safeParse(parsed);
      if (!pasteResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway clipboard paste failed shape validation.",
        };
      }
      if (!admitChromeAction(clock.now())) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway clipboard paste exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      return {
        outcome: "accepted",
        message: {
          kind: "clipboard_paste",
          pasteId: pasteResult.data.pasteId,
          bytes: pasteResult.data.bytes,
        },
      };
    }
    if (envelope.type === "transfer_cancel") {
      const cancelResult = browserTransferCancelMessageSchema.safeParse(parsed);
      if (!cancelResult.success) {
        return {
          outcome: "rejected",
          reason: "malformed",
          message: "Panel gateway transfer cancel failed shape validation.",
        };
      }
      if (!admitChromeAction(clock.now())) {
        return {
          outcome: "rejected",
          reason: "rate-limited",
          message: `Panel gateway transfer cancel exceeded the ${inputMaxPerSecond}-per-second rate limit.`,
        };
      }
      return {
        outcome: "accepted",
        message: {
          kind: "transfer_cancel",
          transferId: cancelResult.data.transferId,
        },
      };
    }
    return {
      outcome: "rejected",
      reason: "malformed",
      message: `Panel gateway message has an unknown type: ${String(envelope.type)}.`,
    };
  }

  function close() {
    if (redeemedCapabilityId !== undefined) {
      capabilities.revoke(redeemedCapabilityId, "panel-closed");
      redeemedCapabilityId = undefined;
    }
    acceptedFrames.length = 0;
  }

  return {
    declaredBindHost,
    choosePort,
    validate,
    close,
    get redeemedCapabilityId() {
      return redeemedCapabilityId;
    },
    get acceptedFrameCount() {
      return acceptedFrames.length;
    },
    get messageMaxBytes() {
      return messageMaxBytes;
    },
    get inputMaxPerSecond() {
      return inputMaxPerSecond;
    },
    get bandwidthBytesPerSecond() {
      return bandwidthBytesPerSecond;
    },
  };
}
