import { describe, expect, it } from "vitest";
import { ownerSessionIdFromContext } from "../src/shared/panel-owner-session.js";

describe("Panel owner session derivation", () => {
  it("derives the owner session from the BB thread context, not a hardcoded literal", () => {
    expect(ownerSessionIdFromContext({ projectId: "p1", threadId: "t1" })).toBe(
      "bb-owner-session:thread:t1",
    );
  });

  it("derives the owner session from the BB project context for a New thread panel", () => {
    expect(ownerSessionIdFromContext({ projectId: "p1", threadId: null })).toBe(
      "bb-owner-session:project:p1",
    );
  });

  it("falls back to the compose session for a projectless New thread", () => {
    expect(ownerSessionIdFromContext({ projectId: null, threadId: null })).toBe(
      "bb-owner-session:compose",
    );
  });

  it("never returns the legacy hardcoded literal", () => {
    expect(
      ownerSessionIdFromContext({ projectId: "p1", threadId: "t1" }),
    ).not.toBe("owner-session-panel");
  });
});
