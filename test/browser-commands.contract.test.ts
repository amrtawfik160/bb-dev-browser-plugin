import { describe, expect, it } from "vitest";
import {
  BrowserCommandError,
  browserCommandScript,
  commandOrigin,
  commandPurpose,
  compactSnapshot,
  formatBrowserCommandResult,
  parseBrowserCommand,
  parseBrowserCommandOutput,
  tokenizeCommand,
} from "../src/server/browser-commands.js";

describe("Browser Commands", () => {
  it("reads every command an agent can send", () => {
    expect(parseBrowserCommand("open https://example.com/a")).toEqual({ name: "open", url: "https://example.com/a" });
    expect(parseBrowserCommand("snapshot")).toEqual({ name: "snapshot" });
    expect(parseBrowserCommand("click @g2:e5")).toEqual({ name: "click", target: { generation: 2, ref: "e5" } });
    expect(parseBrowserCommand('fill @g1:e3 "hello world"')).toEqual({
      name: "fill",
      target: { generation: 1, ref: "e3" },
      text: "hello world",
    });
    expect(parseBrowserCommand("type quick note")).toEqual({ name: "type", text: "quick note" });
    expect(parseBrowserCommand("press Enter")).toEqual({ name: "press", key: "Enter" });
    expect(parseBrowserCommand("scroll Down")).toEqual({ name: "scroll", direction: "down" });
    expect(parseBrowserCommand("wait 500")).toEqual({ name: "wait", ms: 500 });
    expect(parseBrowserCommand("wait Signed in")).toEqual({ name: "wait", text: "Signed in" });
    expect(parseBrowserCommand("eval document.title")).toEqual({ name: "eval", expression: "document.title" });
    expect(parseBrowserCommand("eval () => { return [...document.links].length }")).toEqual({
      name: "eval",
      expression: "() => { return [...document.links].length }",
    });
  });

  it("refuses commands that are missing what they need", () => {
    for (const bad of ["dance", "open example.com", "click e5", "click @e5", "scroll sideways", "type", "eval", 'fill @g1:e1 "open']) {
      expect(() => parseBrowserCommand(bad), bad).toThrow(BrowserCommandError);
    }
  });

  it("keeps quoted words together and unescapes quotes", () => {
    expect(tokenizeCommand(`fill @g1:e2 'it\\'s fine' now`)).toEqual(["fill", "@g1:e2", "it's fine", "now"]);
  });

  it("names the site an open command needs and a plain purpose for the owner", () => {
    expect(commandOrigin(parseBrowserCommand("open https://example.com/path?q=1"))).toBe("https://example.com");
    expect(commandOrigin(parseBrowserCommand("snapshot"))).toBeUndefined();
    expect(commandPurpose(parseBrowserCommand("press Enter"))).toBe("Press Enter");
  });

  it("acts through the agent's page and the snapshot's refs only", () => {
    const script = browserCommandScript(parseBrowserCommand("click @g4:e9"));
    expect(script).toContain('page.locator("aria-ref=e9").click(');
    expect(script).toContain("page.snapshotForAI(");
    expect(script).not.toContain("browser.");
    const evaluated = browserCommandScript(parseBrowserCommand("eval document.title"));
    expect(evaluated).toContain("page.evaluate(() => (document.title))");
    expect(evaluated).not.toContain("snapshotForAI");
  });

  it("compacts a snapshot and stamps refs on interactive elements", () => {
    const { text, elements } = compactSnapshot(
      [
        '- generic [ref=e1]:',
        '  - heading "Example Domain" [level=1] [ref=e2]',
        '  - paragraph [ref=e3]: This domain is for examples.',
        '  - link "More information..." [ref=e4] [cursor=pointer]:',
        '    - /url: https://iana.org/domains/example',
        '  - textbox "Search" [ref=e5]',
      ].join("\n"),
      3,
    );
    expect(text).toBe(
      [
        "generic",
        '  heading "Example Domain" [level=1]',
        "  paragraph: This domain is for examples.",
        '  uid=g3:e4 link "More information..."',
        '  uid=g3:e5 textbox "Search"',
      ].join("\n"),
    );
    expect(elements.map((element) => element.uid)).toEqual(["g3:e4", "g3:e5"]);
  });

  it("formats the page, snapshot, and next steps like chrome-devtools-axi", () => {
    const output = formatBrowserCommandResult(
      parseBrowserCommand("open https://example.com"),
      {
        title: "Example Domain",
        url: "https://example.com/",
        snapshot: '- link "More information..." [ref=e4]\n- textbox "Search" [ref=e5]',
      },
      1,
    );
    expect(output).toBe(
      [
        'page: {title: "Example Domain", url: "https://example.com/", refs: 2}',
        "snapshot:",
        'uid=g1:e4 link "More information..."',
        'uid=g1:e5 textbox "Search"',
        "help[3]:",
        '  Run `click @g1:e4` to click the "More information..." link',
        '  Run `fill @g1:e5 <text>` to fill the "Search" textbox',
        "  Refs change after every command; pass them back exactly as printed",
      ].join("\n"),
    );
  });

  it("reports an eval value without a snapshot", () => {
    const output = formatBrowserCommandResult(
      parseBrowserCommand("eval document.title"),
      { title: "T", url: "https://example.com/", value: '"T"' },
      2,
    );
    expect(output).toContain('result: "T"');
    expect(output).not.toContain("snapshot:");
  });

  it("finds the command result after other console output", () => {
    expect(parseBrowserCommandOutput('noise\n__bbBrowserCommand:{"title":"A","url":"https://a.test/"}')).toEqual({
      title: "A",
      url: "https://a.test/",
    });
    expect(parseBrowserCommandOutput("no marker")).toBeUndefined();
  });
});

describe("Browser Command sessions", () => {
  it("stamps refs per session, refuses stale refs, and checks follow-ups against the page's site", async () => {
    const { runBrowserCommand } = await import("../src/server/server.js");
    const calls: Array<{ purpose: string; destinationOrigin?: string; screenshot: boolean }> = [];
    const browser = {
      browserScript: async (parameters: { purpose: string; destinationOrigin?: string; screenshot: boolean }) => {
        calls.push(parameters);
        return {
          ok: true as const,
          result: {
            output: '__bbBrowserCommand:{"title":"Shop","url":"https://shop.test/cart","snapshot":"- button \\"Pay\\" [ref=e2]"}',
            screenshots: [],
          },
        };
      },
    } as unknown as Parameters<typeof runBrowserCommand>[0];
    const context = { projectId: "p", threadId: "t-session", signal: new AbortController().signal };

    const opened = await runBrowserCommand(browser, { command: "open https://shop.test/cart" }, context);
    expect(opened.content[0]).toMatchObject({ text: expect.stringContaining("uid=g1:e2 button") });
    expect(calls[0]).toMatchObject({ purpose: "Open https://shop.test/cart", destinationOrigin: "https://shop.test" });

    const stale = await runBrowserCommand(browser, { command: "click @g0:e2" }, context);
    expect(stale).toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);

    const clicked = await runBrowserCommand(browser, { command: "click @g1:e2" }, context);
    expect(clicked.content[0]).toMatchObject({ text: expect.stringContaining("uid=g2:e2") });
    expect(calls[1]).toMatchObject({ purpose: "Click an element", destinationOrigin: "https://shop.test" });

    const otherThread = await runBrowserCommand(browser, { command: "click @g2:e2" }, { ...context, threadId: "t-other" });
    expect(otherThread).toMatchObject({ isError: true });
  });
});
