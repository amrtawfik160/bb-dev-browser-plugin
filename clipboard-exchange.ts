import { randomUUID } from "node:crypto";
import {
  BROWSER_CLIPBOARD_MAX_BYTES,
  type BrowserClipboardOutcome,
} from "./contracts.js";

/**
 * Explicit clipboard exchange (issue #19). Text clipboard text moves only
 * through an explicit owner copy or paste action; the plugin never
 * continuously synchronizes clipboards. This module is the authoritative
 * policy: it exposes only discrete `copy` and `paste` actions, denies
 * concurrent and ambient synchronization, and reports privacy-safe outcomes
 * that carry byte counts but never clipboard contents.
 *
 * The actual OS-clipboard read/write and page selection extraction are
 * injected effects so the policy is deterministic and testable without a
 * browser. A controller mismatch (e.g. an agent or a non-controller panel
 * attempting the action) is rejected with `controller-mismatch`.
 */

export interface ClipboardExchangeEffects {
  /**
   * Read the active page selection length in bytes. Returns `0` when there is
   * no selection. The implementation must not retain the selection contents.
   */
  readSelectionBytes(actor: TransferClipboardActor): Promise<number>;
  /**
   * Write `bytes` of the controller's clipboard into the page. The
   * implementation must not retain the clipboard contents beyond the write.
   */
  writeClipboardToPage(
    actor: TransferClipboardActor,
    bytes: number,
  ): Promise<number>;
}

export type TransferClipboardActor = "owner-controller" | "agent" | "spectator";

export interface ClipboardExchangeOptions {
  effects: ClipboardExchangeEffects;
  id?: () => string;
}

type ClipboardNotOkReason =
  | "no-selection"
  | "clipboard-empty"
  | "controller-mismatch"
  | "busy"
  | "denied";

function notOk(
  id: string,
  reason: ClipboardNotOkReason,
): BrowserClipboardOutcome {
  return { outcome: "not-ok", id, reason };
}

export function createClipboardExchange(options: ClipboardExchangeOptions) {
  const effects = options.effects;
  const idFactory = options.id ?? (() => randomUUID());
  let inFlight = false;
  let disposed = false;

  function assertOpen() {
    if (disposed) {
      throw new Error("The clipboard exchange has been disposed.");
    }
  }

  /**
   * Explicit owner copy: read the active page selection into the controller's
   * clipboard. There is no continuous synchronization path; this is the only
   * way clipboard text leaves the page.
   */
  async function copy(
    actor: TransferClipboardActor,
    copyId: string = idFactory(),
  ): Promise<BrowserClipboardOutcome> {
    assertOpen();
    if (actor !== "owner-controller") {
      return notOk(copyId, "controller-mismatch");
    }
    if (inFlight) return notOk(copyId, "busy");
    inFlight = true;
    try {
      const bytes = await effects.readSelectionBytes(actor);
      if (bytes <= 0) return notOk(copyId, "no-selection");
      const capped = Math.min(bytes, BROWSER_CLIPBOARD_MAX_BYTES);
      return { outcome: "copied", copyId, bytes: capped };
    } finally {
      inFlight = false;
    }
  }

  /**
   * Explicit owner paste: write the controller's clipboard into the page.
   * There is no continuous synchronization path; this is the only way
   * clipboard text enters the page.
   */
  async function paste(
    actor: TransferClipboardActor,
    bytes: number,
    pasteId: string = idFactory(),
  ): Promise<BrowserClipboardOutcome> {
    assertOpen();
    if (actor !== "owner-controller") {
      return notOk(pasteId, "controller-mismatch");
    }
    if (inFlight) return notOk(pasteId, "busy");
    if (bytes <= 0) return notOk(pasteId, "clipboard-empty");
    const capped = Math.min(bytes, BROWSER_CLIPBOARD_MAX_BYTES);
    inFlight = true;
    try {
      const written = await effects.writeClipboardToPage(actor, capped);
      if (written <= 0) return notOk(pasteId, "denied");
      return { outcome: "pasted", pasteId, bytes: Math.min(written, capped) };
    } finally {
      inFlight = false;
    }
  }

  /** There is never a continuous synchronization state to report. */
  function isSynchronizing() {
    return false;
  }

  function dispose() {
    disposed = true;
    inFlight = false;
  }

  return { copy, paste, isSynchronizing, dispose };
}

export type ClipboardExchange = ReturnType<typeof createClipboardExchange>;
