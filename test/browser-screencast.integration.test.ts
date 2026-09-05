import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createCdpScreencastSource } from "../browser-screencast.js";
import { waitFor } from "./wait.js";
import {
  encodePanelProtocolMessage,
  PANEL_PROTOCOL_VERSION,
} from "../panel-protocol.js";
import { createBrowserTabStrip } from "../browser-tabs.js";

it("delivers page input, viewport changes, and frames from real Chromium", async () => {
  const profile = await mkdtemp(join(tmpdir(), "browser-screencast-audit-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const page = context.pages()[0]!;
  const tabs = createBrowserTabStrip();
  const pageProbe = await context.newCDPSession(page);
  const firstTarget = (await pageProbe.send("Target.getTargetInfo")).targetInfo
    .targetId;
  tabs.openTab("about:blank", "First", firstTarget);
  await page.setContent(
    '<textarea aria-label="Name"></textarea><button onclick="document.body.dataset.clicked = \'yes\'">Save</button><div style="height:4000px"></div>',
  );
  const [port, path] = (
    await readFile(join(profile, "DevToolsActivePort"), "utf8")
  )
    .trim()
    .split("\n");
  const source = createCdpScreencastSource({
    resolveEndpoint: async () => `ws://127.0.0.1:${port}${path}`,
    viewport: { width: 800, height: 600 },
    tabs,
  });
  const abort = new AbortController();
  let frames = 0;
  const encodedFrames: string[] = [];
  const streaming = source.start((frame) => {
    frames += 1;
    encodedFrames.push(
      encodePanelProtocolMessage({
        ...frame,
        data: Buffer.from(frame.data).toString("base64"),
        protocolVersion: PANEL_PROTOCOL_VERSION,
        type: "frame",
      }).outcome,
    );
  }, abort.signal);
  try {
    await waitFor(() => (frames > 0 ? true : undefined));
    expect(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    ).toEqual({ width: 800, height: 600 });
    await page.getByRole("textbox").focus();
    source.input({
      kind: "key",
      action: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      text: "a",
      modifiers: 0,
    });
    source.input({
      kind: "key",
      action: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
    });
    await expect.poll(() => page.getByRole("textbox").inputValue()).toBe("a");
    source.input({ kind: "text", text: " café" });
    await expect
      .poll(() => page.getByRole("textbox").inputValue())
      .toBe("a café");
    source.input({
      kind: "key",
      action: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    source.input({
      kind: "key",
      action: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await expect
      .poll(() => page.getByRole("textbox").inputValue())
      .toBe("a café\n");
    const button = await page.getByRole("button").boundingBox();
    expect(button).not.toBeNull();
    const point = {
      x: button!.x + button!.width / 2,
      y: button!.y + button!.height / 2,
    };
    source.input({
      kind: "mouse",
      action: "mousePressed",
      ...point,
      button: "left",
      count: 1,
    });
    source.input({
      kind: "mouse",
      action: "mouseReleased",
      ...point,
      button: "left",
      count: 1,
    });
    await expect
      .poll(() => page.evaluate(() => document.body.dataset.clicked))
      .toBe("yes");
    source.input({ kind: "wheel", x: 400, y: 300, deltaX: 0, deltaY: 240 });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    source.setViewport?.({ width: 640, height: 480 });
    await expect
      .poll(() =>
        page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      )
      .toEqual({ width: 640, height: 480 });
    await expect.poll(() => frames).toBeGreaterThan(2);
    expect(encodedFrames.every((outcome) => outcome === "encoded")).toBe(true);
    const second = await context.newPage();
    await second.setContent('<input aria-label="Second name" autofocus>');
    const secondProbe = await context.newCDPSession(second);
    const secondTarget = (await secondProbe.send("Target.getTargetInfo"))
      .targetInfo.targetId;
    tabs.openTab("about:blank", "Second", secondTarget);
    await expect.poll(() => second.evaluate(() => innerWidth)).toBe(640);
    source.input({ kind: "text", text: "second tab" });
    await expect
      .poll(() => second.getByRole("textbox").inputValue())
      .toBe("second tab");
    await expect
      .poll(() => page.getByRole("textbox").inputValue())
      .toBe("a café\n");
    tabs.activateTab(firstTarget);
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe("visible");
    await page.getByRole("textbox").focus();
    source.input({ kind: "text", text: " first tab" });
    await expect
      .poll(() => page.getByRole("textbox").inputValue())
      .toBe("a café\n first tab");
    await context.close();
    await streaming;
  } finally {
    abort.abort();
    await source.stop();
    await streaming;
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 15000);
