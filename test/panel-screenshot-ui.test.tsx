// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPublicPanelLifecycleHarness } from "./public-plugin-lifecycle-harness.js";
import { PANEL_SCREENSHOT_CHUNK_LENGTH } from "../src/shared/panel-screenshot.js";

describe("Browser Panel screenshot downloads", () => {
  it.each([false, true])(
    "downloads a PNG from the selected page (full page: %s)",
    async (fullPage) => {
      const bytes = Buffer.alloc(PANEL_SCREENSHOT_CHUNK_LENGTH, 42);
      let finishCapture!: (data: string) => void;
      const capture = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finishCapture = resolve;
          }),
      );
      let saved: Blob | undefined;
      const names: string[] = [];
      const originalCreate = Object.getOwnPropertyDescriptor(
        URL,
        "createObjectURL",
      );
      const originalRevoke = Object.getOwnPropertyDescriptor(
        URL,
        "revokeObjectURL",
      );
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: (blob: Blob) => {
          saved = blob;
          return "blob:test-screenshot";
        },
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: vi.fn(),
      });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(function (this: HTMLAnchorElement) {
          names.push(this.download);
        });
      const browser = await createPublicPanelLifecycleHarness({
        captureScreenshot: capture,
      });
      try {
        const [owner, spectator] = await browser.openTwoPanels();
        const label = fullPage
          ? "Take full-page screenshot"
          : "Take screenshot";
        const button = await owner.findByRole("button", { name: label });
        expect(
          (
            (await spectator.findByRole("button", {
              name: label,
            })) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        await waitFor(() =>
          expect((button as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(button);
        await waitFor(() => expect(capture).toHaveBeenCalledWith(fullPage));
        expect((button as HTMLButtonElement).disabled).toBe(true);
        expect(
          (
            owner.getByRole("button", {
              name: fullPage ? "Take screenshot" : "Take full-page screenshot",
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(true);
        await act(async () => finishCapture(bytes.toString("base64")));
        await waitFor(() => expect(saved?.size).toBe(bytes.length));
        expect(saved?.type).toBe("image/png");
        expect(names[0]).toMatch(
          fullPage
            ? /^browser-full-page-.*\.png$/
            : /^browser-viewport-.*\.png$/,
        );
        const received = await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = reject;
          reader.readAsArrayBuffer(saved!);
        });
        expect(Buffer.from(received)).toEqual(bytes);
        await waitFor(() =>
          expect((button as HTMLButtonElement).disabled).toBe(false),
        );
      } finally {
        await browser.dispose();
        click.mockRestore();
        if (originalCreate)
          Object.defineProperty(URL, "createObjectURL", originalCreate);
        else Reflect.deleteProperty(URL, "createObjectURL");
        if (originalRevoke)
          Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
        else Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    },
  );

  it("shows a capture failure and lets the owner retry", async () => {
    const capture = vi.fn(async () => {
      throw new Error("CDP private details");
    });
    const browser = await createPublicPanelLifecycleHarness({
      captureScreenshot: capture,
    });
    try {
      const [owner] = await browser.openTwoPanels();
      const button = await owner.findByRole("button", {
        name: "Take screenshot",
      });
      await waitFor(() =>
        expect((button as HTMLButtonElement).disabled).toBe(false),
      );
      fireEvent.click(button);
      await owner.findByRole("alert");
      expect(owner.container.textContent).toContain(
        "Could not capture this page",
      );
      expect(owner.container.textContent).not.toContain("CDP private details");
      await waitFor(() =>
        expect((button as HTMLButtonElement).disabled).toBe(false),
      );
    } finally {
      await browser.dispose();
    }
  });
});
