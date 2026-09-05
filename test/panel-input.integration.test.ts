import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("commits native IME text once and releases held input when the window loses focus", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useRef } from 'react';
        import { createRoot } from 'react-dom/client';
        import { useBrowserPageInput } from './src/app/panel-input';
        function Surface() {
          const canvas = useRef(null);
          const textInput = useRef(null);
          useBrowserPageInput(canvas, textInput, true, payload => window.received.push(payload));
          return <><canvas ref={canvas} tabIndex={0} /><textarea ref={textInput} tabIndex={-1} /></>;
        }
        window.received = [];
        createRoot(document.getElementById('root')).render(<Surface />);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: "http://localhost:3077",
      });
    await page.route("http://localhost:3077/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div>',
      }),
    );
    await page.goto("http://localhost:3077/");
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.locator("canvas").click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .toBe("TEXTAREA");
    await page.evaluate(() => {
      Reflect.set(window, "received", []);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "漢字",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await cdp.send("Input.insertText", { text: "漢字" });
    expect(await page.evaluate(() => Reflect.get(window, "received"))).toEqual([
      { kind: "text", text: "漢字" },
    ]);
    expect(await page.locator("textarea").inputValue()).toBe("");
    await page.evaluate(() => navigator.clipboard.writeText("café"));
    await page.keyboard.press("Control+V");
    expect(
      await page.evaluate(() => Reflect.get(window, "received").at(-1)),
    ).toEqual({ kind: "text", text: "café" });
    expect(await page.locator("textarea").inputValue()).toBe("");
    await page.keyboard.down("Shift");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    expect(
      await page.evaluate(() => Reflect.get(window, "received").slice(-2)),
    ).toEqual([
      expect.objectContaining({ kind: "key", action: "keyDown", key: "Shift" }),
      expect.objectContaining({ kind: "key", action: "keyUp", key: "Shift" }),
    ]);
    await page.keyboard.press("Shift+Escape");
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe(
      "TEXTAREA",
    );
  } finally {
    await browser.close();
  }
});
