import { describe, expect, it } from "vitest";
import {
  prepareAgentExecution,
  wrapAgentScriptResult,
} from "../agent-script.js";
import { browserScriptParametersSchema } from "../contracts.js";

async function capturedLogs(code: string) {
  const logs: string[] = [];
  const wrapped = wrapAgentScriptResult(code);
  const run = new Function(
    "console",
    `return (async () => {\n${wrapped}\n})();`,
  ) as (console: { log: (value: unknown) => void }) => Promise<void>;
  await run({ log: (value) => logs.push(String(value)) });
  return logs;
}

describe("agent script convenience wrapping", () => {
  it("prints a returned string as the script result", async () => {
    expect(await capturedLogs('return "https://example.com/";')).toEqual([
      "https://example.com/",
    ]);
  });

  it("prints a returned object as JSON", async () => {
    expect(await capturedLogs('return { title: "Example Domain" };')).toEqual([
      '{"title":"Example Domain"}',
    ]);
  });

  it("leaves console.log-only scripts unchanged", async () => {
    expect(await capturedLogs('console.log("hello");')).toEqual(["hello"]);
  });

  it("keeps both console.log and a later return", async () => {
    expect(await capturedLogs('console.log("hello"); return "world";')).toEqual(
      ["hello", "world"],
    );
  });

  it("binds page to an explicit tab before the agent code", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      tabId: "tab-checkout",
    });
    expect(prepared.indexOf('browser.getPage("tab-checkout")')).toBeLessThan(
      prepared.indexOf("return page.url()"),
    );
    expect(prepared).toContain("await page.bringToFront()");
    expect(prepared).toContain("__bbResult");
  });

  it("binds page to the visible tab when tabId is omitted", () => {
    const prepared = prepareAgentExecution({ code: "return page.url()" });
    expect(prepared).toContain("browser.listPages()");
    expect(prepared).toContain('? "main"');
    expect(prepared.indexOf("visibilityState")).toBeLessThan(
      prepared.indexOf("return page.url()"),
    );
    expect(prepared).toContain("await page.bringToFront()");
  });

  it("prefers a tab already on the granted origin", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      preferredOrigin: "https://example.com",
    });
    expect(prepared).toContain("https://example.com");
    expect(prepared).toContain("new URL(__bbEntry.url).origin");
  });

  it("keeps Playwright navigation inside the host deadline", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      timeoutMs: 30_000,
    });
    expect(prepared).toContain("page.setDefaultNavigationTimeout(25000)");
  });

  it("keeps locator actions inside the host deadline", () => {
    const prepared = prepareAgentExecution({
      code: "return page.locator('button').click()",
      timeoutMs: 30_000,
    });
    expect(prepared).toContain("page.setDefaultTimeout(25000)");
  });

  it("leaves helper headroom at the minimum accepted host timeout", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      timeoutMs: 1_000,
    });
    expect(prepared).toContain("page.setDefaultTimeout(750)");
    expect(prepared).toContain("page.setDefaultNavigationTimeout(750)");
  });

  it("rejects subsecond host timeouts at the public schema boundary", () => {
    const input = {
      purpose: "Exercise the deadline boundary",
      code: "return page.url()",
    };

    expect(
      browserScriptParametersSchema.safeParse({ ...input, timeoutMs: 999 })
        .success,
    ).toBe(false);
    expect(
      browserScriptParametersSchema.safeParse({ ...input, timeoutMs: 1_000 })
        .success,
    ).toBe(true);
  });

  it("declares page before the native screenshot finally block", () => {
    const prepared = prepareAgentExecution({
      code: "return page.url()",
      tabId: "tab-screenshot",
      screenshot: { fileName: "shot.png", marker: "bb-screenshot-test" },
    });
    expect(prepared.indexOf("const page")).toBeLessThan(
      prepared.indexOf("try {"),
    );
    expect(prepared.indexOf("try {")).toBeLessThan(
      prepared.indexOf("page.screenshot"),
    );
  });
});
