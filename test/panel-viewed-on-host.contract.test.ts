import { describe, expect, it } from "vitest";
import { panelViewedOnHost } from "../src/app/browser-client-utils.js";

describe("where the Browser Panel is viewed", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "bb.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "[::1]",
  ])("treats %s as the host itself", (hostname) => {
    expect(panelViewedOnHost(hostname)).toBe(true);
  });

  it.each([
    "amr.getbb.app",
    "ci-gate--4242.ci.getbb.app",
    "192.168.1.10",
    "localhost.example.com",
    "",
    undefined,
  ])("treats %s as remote", (hostname) => {
    expect(panelViewedOnHost(hostname)).toBe(false);
  });
});
