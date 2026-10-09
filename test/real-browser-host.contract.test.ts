import { afterEach, describe, expect, it } from "vitest";
import { realBrowserTestHostId } from "./fixtures/real-browser-host.js";

const original = process.env.BB_BROWSER_REAL_HOST_ID;

afterEach(() => {
  if (original === undefined) delete process.env.BB_BROWSER_REAL_HOST_ID;
  else process.env.BB_BROWSER_REAL_HOST_ID = original;
});

describe("real-browser test host", () => {
  it("defaults to the dedicated ci-browser-host", () => {
    delete process.env.BB_BROWSER_REAL_HOST_ID;
    expect(realBrowserTestHostId()).toBe("ci-browser-host");
  });

  it("refuses a live host id so tests never write into its Browser Profiles", () => {
    process.env.BB_BROWSER_REAL_HOST_ID = "host_m4jkvpkw67";
    expect(() => realBrowserTestHostId()).toThrow(/dedicated test host/u);
  });

  it("accepts another dedicated ci- test host", () => {
    process.env.BB_BROWSER_REAL_HOST_ID = "ci-other-host";
    expect(realBrowserTestHostId()).toBe("ci-other-host");
  });
});
