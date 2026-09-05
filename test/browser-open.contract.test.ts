import { describe, expect, it } from "vitest";
import {
  openBrowserScript,
  openCliText,
  parseOpenPageState,
} from "../src/server/browser-open.js";

const navigation = {
  address: { kind: "address" as const, url: "https://example.com/" },
  location: null,
  tabId: "tab-1",
};

describe("browser open", () => {
  it("navigates an authorized URL inside the agent script", () => {
    expect(openBrowserScript("https://example.com/path")).toContain(
      'page.goto("https://example.com/path")',
    );
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
    const text = openCliText(navigation, {
      url: "https://example.com/deep",
      title: "Example",
    });
    expect(text).toContain("Opened https://example.com/deep");
    expect(text).toContain("Title: Example");
    expect(text).toContain("Tab: tab-1");
  });
});
