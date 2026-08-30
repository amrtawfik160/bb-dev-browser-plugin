import { describe, expect, it } from "vitest";
import {
  browserOpenDestinationOrigin,
  OPEN_UNLOCK_HINT,
  openBrowserScript,
  openCliText,
  parseOpenPageState,
} from "../browser-open.js";

const navigation = {
  address: { kind: "address" as const, url: "https://example.com/" },
  location: null,
  tabId: "tab-1",
};

describe("browser open", () => {
  it("reads the landed page without navigating again", () => {
    expect(openBrowserScript()).toContain("page.url()");
    expect(openBrowserScript()).not.toContain("page.goto");
  });

  it("navigates an authorized URL inside the agent script", () => {
    expect(openBrowserScript("https://example.com/path")).toContain(
      'page.goto("https://example.com/path")',
    );
  });

  it.each([
    ["https://example.com/path", "https://example.com"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["about:blank", null],
    ["chrome://new-tab-page", null],
    ["not a URL", null],
  ])("derives only an HTTP(S) destination from %s", (address, expected) => {
    expect(browserOpenDestinationOrigin(address)).toBe(expected);
  });

  it("parses the page state a read returns", () => {
    expect(
      parseOpenPageState('{"url":"https://example.com/","title":"Example"}'),
    ).toEqual({ url: "https://example.com/", title: "Example" });
  });

  it("treats unparseable or incomplete output as no page state", () => {
    expect(parseOpenPageState("not json")).toBeNull();
    expect(parseOpenPageState('{"url":"https://example.com/"}')).toBeNull();
    expect(parseOpenPageState("null")).toBeNull();
  });

  it("reports the page the read observed", () => {
    const text = openCliText(
      navigation,
      { url: "https://example.com/deep", title: "Example" },
      false,
    );
    expect(text).toContain("Opened https://example.com/deep");
    expect(text).toContain("Title: Example");
    expect(text).toContain("Tab: tab-1");
    expect(text).not.toContain(OPEN_UNLOCK_HINT);
  });

  it("falls back to the navigation result and explains the unlock", () => {
    const text = openCliText(navigation, null, true);
    expect(text).toContain("Opened https://example.com/");
    expect(text).not.toContain("Title:");
    expect(text).toContain(OPEN_UNLOCK_HINT);
    expect(text).toContain("Browser Settings");
  });
});
