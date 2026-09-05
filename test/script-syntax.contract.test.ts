import { describe, expect, it } from "vitest";
import {
  describeScriptSyntaxError,
  withScriptSyntaxHint,
} from "../script-syntax.js";

describe("browser script syntax hints", () => {
  it("accepts a script that uses top-level await and return", () => {
    expect(
      describeScriptSyntaxError(
        'await page.goto("https://example.com");\nreturn page.url();',
      ),
    ).toBeNull();
  });

  it("names the script line of an unbalanced call", () => {
    const hint = describeScriptSyntaxError(
      [
        "const first = 1;",
        'return { rows: await page.locator("tr").evaluateAll(rows => rows.map(row => row.id)};',
      ].join("\n"),
    );
    expect(hint).toMatch(/^Syntax check: .+ at script line 2\.$/u);
  });

  it("appends the diagnosis to a QuickJS syntax failure", () => {
    const failure = new Error(
      "SyntaxError: QuickJS evaluation failed: expecting ','",
    );
    const hinted = withScriptSyntaxHint(failure, "return {a: 1, b: 2)};");
    expect(hinted).toBeInstanceOf(Error);
    expect((hinted as Error).message).toContain(
      "QuickJS evaluation failed: expecting ','",
    );
    expect((hinted as Error).message).toContain("Syntax check:");
    expect((hinted as Error).cause).toBe(failure);
  });

  it("keeps the original failure when Node parses the script", () => {
    const failure = new Error(
      "SyntaxError: QuickJS evaluation failed: unsupported syntax",
    );
    expect(withScriptSyntaxHint(failure, "return 1;")).toBe(failure);
  });

  it("leaves runtime failures untouched", () => {
    const failure = new Error(
      "Error: QuickJS promise rejected: page.locator is not a function",
    );
    expect(withScriptSyntaxHint(failure, "return page.locator(x);")).toBe(
      failure,
    );
  });
});
