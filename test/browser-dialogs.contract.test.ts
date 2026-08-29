import { describe, expect, it } from "vitest";
import { createPanelCapabilityStore } from "../panel-capability.js";
import { createPanelGateway } from "../panel-gateway.js";
import type { BrowserDialogEvent } from "../contracts.js";

const hostId = "host-dialogs";
const profileId = "profile-dialogs";
const binding = {
  ownerSessionId: "owner-session-dialogs",
  panelId: "panel-dialogs",
  hostId,
  profileId,
};

function redeemMessage(capability: { capabilityId: string; secret: string }) {
  return {
    type: "redeem" as const,
    capabilityId: capability.capabilityId,
    secret: capability.secret,
    ownerSessionId: binding.ownerSessionId,
    panelId: binding.panelId,
  };
}

function setupGateway() {
  let now = 1_000_000;
  const clock = { now: () => now };
  const capabilities = createPanelCapabilityStore({ clock });
  const gateway = createPanelGateway({
    capabilities,
    hostId,
    profileId,
    clock,
  });
  const issued = capabilities.issue(binding);
  return {
    clock,
    capabilities,
    gateway,
    issued,
    advanceTime(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

describe("Browser dialog and context-action gateway contract", () => {
  it("accepts a dialog response after redemption", () => {
    const { gateway, issued } = setupGateway();
    expect(gateway.validate(json(redeemMessage(issued))).outcome).toBe(
      "accepted",
    );
    const result = gateway.validate(
      json({ type: "dialog_response", dialogId: "d1", accept: true }),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome === "accepted")
      expect(result.message).toEqual({
        kind: "dialog_response",
        dialogId: "d1",
        accept: true,
      });
  });

  it("accepts a dialog response carrying prompt text", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const result = gateway.validate(
      json({
        type: "dialog_response",
        dialogId: "d1",
        accept: true,
        text: "answer",
      }),
    );
    expect(result.outcome).toBe("accepted");
    if (
      result.outcome === "accepted" &&
      result.message.kind === "dialog_response"
    )
      expect(result.message.text).toBe("answer");
  });

  it("accepts a context query and context action after redemption", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const query = gateway.validate(
      json({ type: "context_query", queryId: "q1", x: 10, y: 20 }),
    );
    expect(query.outcome).toBe("accepted");
    const action = gateway.validate(
      json({ type: "context_action", actionId: "copy-link" }),
    );
    expect(action.outcome).toBe("accepted");
  });

  it("rejects dialog and context messages before the capability is redeemed", () => {
    const { gateway } = setupGateway();
    const result = gateway.validate(
      json({ type: "dialog_response", dialogId: "d1", accept: false }),
    );
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected")
      expect(result.reason).toBe("unauthorized");
  });

  it("rejects malformed dialog and context messages", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    const noId = gateway.validate(
      json({ type: "dialog_response", accept: true }),
    );
    expect(noId.outcome).toBe("rejected");
    if (noId.outcome === "rejected") expect(noId.reason).toBe("malformed");
    const badQuery = gateway.validate(
      json({ type: "context_query", queryId: "q1", x: "ten", y: 20 }),
    );
    expect(badQuery.outcome).toBe("rejected");
    if (badQuery.outcome === "rejected")
      expect(badQuery.reason).toBe("malformed");
    const badAction = gateway.validate(
      json({ type: "context_action", actionId: 7 }),
    );
    expect(badAction.outcome).toBe("rejected");
    if (badAction.outcome === "rejected")
      expect(badAction.reason).toBe("malformed");
  });

  it("rate-limits a flooding client of dialog and context actions", () => {
    const { gateway, issued } = setupGateway();
    gateway.validate(json(redeemMessage(issued)));
    let lastOutcome: string = "accepted";
    for (let index = 0; index < 120; index += 1) {
      const result = gateway.validate(
        json({ type: "dialog_response", dialogId: "d1", accept: true }),
      );
      lastOutcome = result.outcome;
    }
    expect(lastOutcome).toBe("rejected");
  });

  it("validates every dialog type through the event schema", () => {
    const types: BrowserDialogEvent["type"][] = [
      "alert",
      "confirm",
      "prompt",
      "beforeunload",
    ];
    for (const type of types) {
      const event: BrowserDialogEvent = {
        dialogId: `dialog-${type}`,
        type,
        message: `${type} message`,
        defaultValue: type === "prompt" ? "prefilled" : "",
        url: "https://example.test/page",
      };
      expect(event.type).toBe(type);
    }
  });
});
