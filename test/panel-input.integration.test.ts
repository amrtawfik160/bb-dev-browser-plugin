import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("keeps BB panel shortcuts inside the controlled page until input loses focus", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useRef } from 'react';
        import { createRoot } from 'react-dom/client';
        import { useBrowserPageInput } from './src/app/panel-input';
        function Surface() {
          const canvas = useRef(null);
          const input = useRef(null);
          useBrowserPageInput(canvas, input, true, payload => window.received.push(payload));
          return <><canvas ref={canvas} tabIndex={0} width={300} height={150} /><textarea ref={input} /><button>Outside page</button></>;
        }
        window.received = [];
        window.hostKeys = [];
        for (const type of ['keydown', 'keyup']) {
          window.addEventListener(type, event => window.hostKeys.push(event.key));
        }
        // BB handles panel.toggle on Mod+J at the window bubbling phase,
        // including when an editable element has focus.
        window.addEventListener('keydown', event => {
          if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && ['j', 'w'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            document.getElementById('root').hidden = true;
          }
        });
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
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    await page.locator("canvas").click();
    for (const modifier of ["Control", "Meta"]) {
      for (const key of ["j", "w", "a"]) {
        await page.keyboard.press(`${modifier}+${key}`);
        expect(await page.locator("#root").isVisible()).toBe(true);
        expect(
          await page.evaluate(() => Reflect.get(window, "received")),
        ).toContainEqual(
          expect.objectContaining({
            kind: "key",
            action: "keyDown",
            key,
            modifiers: modifier === "Control" ? 2 : 4,
          }),
        );
      }
    }
    expect(
      await page.evaluate(() =>
        Reflect.get(window, "received").filter(
          (payload: { kind: string; modifiers?: number; text?: string }) =>
            payload.kind === "key" &&
            ((payload.modifiers ?? 0) & 6) !== 0 &&
            payload.text !== undefined,
        ),
      ),
    ).toEqual([]);
    await page.keyboard.press("Alt+ArrowLeft");
    expect(await page.evaluate(() => Reflect.get(window, "hostKeys"))).toEqual(
      [],
    );
    await page.keyboard.press("Shift+Escape");
    await page.getByRole("button", { name: "Outside page" }).focus();
    await page.keyboard.press("Control+j");
    expect(await page.locator("#root").isVisible()).toBe(false);
  } finally {
    await browser.close();
  }
});

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
          return <><canvas ref={canvas} tabIndex={0} width={600} height={300} data-viewport-width={300} data-viewport-height={150} style={{width:300,height:150}} /><textarea ref={textInput} tabIndex={-1} /></>;
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
    expect(
      await page.evaluate(() => Reflect.get(window, "received")),
    ).toContainEqual(
      expect.objectContaining({
        kind: "mouse",
        action: "mousePressed",
        x: 150,
        y: 75,
      }),
    );
    await page.locator("canvas").hover();
    await page.mouse.wheel(0, 120);
    await expect
      .poll(() =>
        page.evaluate(() =>
          Reflect.get(window, "received").some(
            (payload: { kind: string; deltaY?: number }) =>
              payload.kind === "wheel" && payload.deltaY === 120,
          ),
        ),
      )
      .toBe(true);
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
      await page.evaluate(() =>
        Reflect.get(window, "received").filter(
          (payload: { kind: string; text?: string }) =>
            payload.kind === "text" && payload.text === "café",
        ),
      ),
    ).toEqual([{ kind: "text", text: "café" }]);
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
