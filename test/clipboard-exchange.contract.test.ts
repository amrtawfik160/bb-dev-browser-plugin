import { describe, expect, it } from "vitest";
import { createClipboardExchange } from "../clipboard-exchange.js";

function createEffects(
  options: {
    selectionBytes?: number;
    writeResult?: number;
    failWrite?: boolean;
  } = {},
) {
  const calls = {
    readSelection: 0,
    writeClipboard: 0,
  };
  return {
    calls,
    effects: {
      readSelectionBytes: async () => {
        calls.readSelection += 1;
        return options.selectionBytes ?? 0;
      },
      writeClipboardToPage: async (_actor: string, bytes: number) => {
        calls.writeClipboard += 1;
        if (options.failWrite) return 0;
        return options.writeResult ?? bytes;
      },
    },
  };
}

describe("Clipboard exchange", () => {
  it("copies the active page selection through an explicit owner action", async () => {
    const { effects } = createEffects({ selectionBytes: 12 });
    const exchange = createClipboardExchange({ effects });
    const outcome = await exchange.copy("owner-controller", "copy-1");
    expect(outcome).toEqual({ outcome: "copied", copyId: "copy-1", bytes: 12 });
  });

  it("reports not-ok when there is no selection to copy", async () => {
    const { effects } = createEffects({ selectionBytes: 0 });
    const exchange = createClipboardExchange({ effects });
    const outcome = await exchange.copy("owner-controller", "copy-2");
    expect(outcome).toEqual({
      outcome: "not-ok",
      id: "copy-2",
      reason: "no-selection",
    });
  });

  it("pastes the controller's clipboard through an explicit owner action", async () => {
    const { effects } = createEffects();
    const exchange = createClipboardExchange({ effects });
    const outcome = await exchange.paste("owner-controller", 24, "paste-1");
    expect(outcome).toEqual({
      outcome: "pasted",
      pasteId: "paste-1",
      bytes: 24,
    });
  });

  it("reports not-ok when the clipboard is empty", async () => {
    const { effects } = createEffects();
    const exchange = createClipboardExchange({ effects });
    const outcome = await exchange.paste("owner-controller", 0, "paste-2");
    expect(outcome).toEqual({
      outcome: "not-ok",
      id: "paste-2",
      reason: "clipboard-empty",
    });
  });

  it("denies a non-controller actor with controller-mismatch", async () => {
    const { effects } = createEffects({ selectionBytes: 12 });
    const exchange = createClipboardExchange({ effects });
    const copy = await exchange.copy("spectator", "copy-3");
    const paste = await exchange.paste("agent", 10, "paste-3");
    expect(copy).toEqual({
      outcome: "not-ok",
      id: "copy-3",
      reason: "controller-mismatch",
    });
    expect(paste).toEqual({
      outcome: "not-ok",
      id: "paste-3",
      reason: "controller-mismatch",
    });
  });

  it("never reports a continuous synchronization state", () => {
    const { effects } = createEffects();
    const exchange = createClipboardExchange({ effects });
    expect(exchange.isSynchronizing()).toBe(false);
  });

  it("rejects concurrent actions while one is in flight", async () => {
    let resolveRead: (value: number) => void = () => undefined;
    const effects = {
      readSelectionBytes: () =>
        new Promise<number>((resolve) => {
          resolveRead = resolve;
        }),
      writeClipboardToPage: async (_actor: string, bytes: number) => bytes,
    };
    const exchange = createClipboardExchange({ effects });
    const pending = exchange.copy("owner-controller", "copy-4");
    const busy = await exchange.copy("owner-controller", "copy-5");
    expect(busy).toEqual({
      outcome: "not-ok",
      id: "copy-5",
      reason: "busy",
    });
    resolveRead(8);
    await pending;
  });

  it("never retains clipboard contents in the outcome", async () => {
    const { effects } = createEffects({ selectionBytes: 5 });
    const exchange = createClipboardExchange({ effects });
    const outcome = await exchange.copy("owner-controller", "copy-6");
    const json = JSON.stringify(outcome);
    // Outcomes carry only byte counts and ids, never contents.
    expect(json).not.toMatch(/content|secret|password/i);
  });
});
