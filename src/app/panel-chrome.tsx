import { useEffect, useRef, useState } from "react";
import type React from "react";
import type {
  BrowserContextAction,
  BrowserDialogEvent,
  BrowserDownloadListingEntry,
  BrowserDownloadLimits,
} from "../shared/contracts.js";
import { Button, inputClassName } from "./panel-primitives.js";

/**
 * Browser panel chrome for dialogs and context actions (issue #17). These are
 * SDK-free presentational components wired into the Automation Mode stream by
 * {@link PanelStreamSurface} in app.tsx. They are extracted so the keyboard,
 * focus, contrast, reduced-motion, and spectator-gating behavior can be unit
 * tested without the plugin app host.
 */

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * Plugin chrome yields BB global shortcuts: keyboard handlers inside the chrome
 * only act when focus is local and never intercept Cmd/Ctrl/Alt combos BB owns.
 */
export function isBbGlobalShortcut(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

export function PanelDialogLayer({
  dialog,
  isController,
  reducedMotion,
  onRespond,
  onClose,
}: {
  dialog: BrowserDialogEvent;
  isController: boolean;
  reducedMotion: boolean;
  onRespond: (accept: boolean, text?: string) => void;
  onClose: () => void;
}) {
  const promptRef = useRef<HTMLInputElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [promptText, setPromptText] = useState(dialog.defaultValue);

  useEffect(() => {
    setPromptText(dialog.defaultValue);
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const target =
      dialog.type === "prompt" ? promptRef.current : primaryRef.current;
    target?.focus();
    if (dialog.type === "prompt" && promptRef.current !== null)
      promptRef.current.select();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [dialog.dialogId, dialog.type, dialog.defaultValue]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isBbGlobalShortcut(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (isController) onRespond(false);
      else onClose();
      return;
    }
    if (event.key === "Enter") {
      event.stopPropagation();
      if (event.target instanceof HTMLElement && event.target.closest("button"))
        return;
      event.preventDefault();
      if (!isController) return;
      if (dialog.type === "prompt") onRespond(true, promptText);
      else onRespond(true);
      return;
    }
    if (event.key === "Tab") {
      // Trap focus inside the dialog so keyboard order stays within the chrome.
      event.preventDefault();
      const container = event.currentTarget;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? focusable[(index - 1 + focusable.length) % focusable.length]
        : focusable[(index + 1) % focusable.length];
      next.focus();
    }
  }

  const acceptLabel =
    dialog.type === "beforeunload"
      ? "Leave"
      : dialog.type === "confirm"
        ? "OK"
        : dialog.type === "prompt"
          ? "Submit"
          : "OK";
  const dismissLabel = dialog.type === "beforeunload" ? "Stay" : "Cancel";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${dialog.type} dialog from ${dialog.url}`}
      aria-describedby={`browser-dialog-${dialog.dialogId}-message`}
      onKeyDown={handleKeyDown}
      className="mt-3 rounded-lg border border-border bg-popover p-4 text-left text-popover-foreground shadow-md"
      style={{ transition: reducedMotion ? "none" : undefined }}
    >
      <p id={`browser-dialog-${dialog.dialogId}-message`} className="text-sm">
        {dialog.message === "" ? `${dialog.type} dialog` : dialog.message}
      </p>
      {dialog.type === "prompt" ? (
        <label className="mt-2 block text-xs">
          Prompt answer
          <input
            ref={promptRef}
            type="text"
            className={`${inputClassName} mt-1`}
            value={promptText}
            disabled={!isController}
            onChange={(event) => setPromptText(event.target.value)}
            aria-label="Prompt answer"
          />
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          ref={primaryRef}
          disabled={!isController}
          onClick={() =>
            isController &&
            onRespond(true, dialog.type === "prompt" ? promptText : undefined)
          }
        >
          {acceptLabel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!isController}
          onClick={() => isController && onRespond(false)}
        >
          {dismissLabel}
        </Button>
        {isController ? null : (
          <span className="self-center text-xs text-muted-foreground">
            Only the controller can answer this dialog.
          </span>
        )}
      </div>
    </div>
  );
}

export function PanelContextMenu({
  actions,
  point,
  isController,
  reducedMotion,
  onChoose,
  onClose,
}: {
  actions: BrowserContextAction[];
  point: { x: number; y: number };
  isController: boolean;
  reducedMotion: boolean;
  onChoose: (action: BrowserContextAction) => void;
  onClose: () => void;
}) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    itemRefs.current[0]?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  function focusItem(index: number) {
    const count = actions.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    setActiveIndex(wrapped);
    itemRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isBbGlobalShortcut(event.nativeEvent)) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(activeIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusItem(actions.length - 1);
      return;
    }
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const action = actions[activeIndex];
      if (action !== undefined && isController) onChoose(action);
    }
  }

  if (actions.length === 0) {
    return (
      <div
        role="menu"
        aria-label="Browser context actions"
        className="mt-3 rounded-lg border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        style={{ transition: reducedMotion ? "none" : undefined }}
      >
        No link or image actions are available at this point.
      </div>
    );
  }
  return (
    <div
      role="menu"
      aria-label="Browser context actions"
      onKeyDown={handleKeyDown}
      className="mt-3 inline-block rounded-lg border border-border bg-popover p-1 text-left text-popover-foreground shadow-md"
      style={{ transition: reducedMotion ? "none" : undefined }}
    >
      <p className="mb-1 px-3 pt-1 text-xs text-muted-foreground">
        Actions at {Math.round(point.x)}, {Math.round(point.y)}
      </p>
      {actions.map((action, index) => (
        <button
          key={action.actionId}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={!isController}
          className="block w-full rounded-md px-3 py-1.5 text-left text-xs hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none disabled:opacity-50"
          onClick={() => isController && onChoose(action)}
          onMouseEnter={() => setActiveIndex(index)}
        >
          {action.label}
        </button>
      ))}
      {isController ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Only the controller can trigger context actions.
        </p>
      )}
    </div>
  );
}

/**
 * Host Downloads quarantine surface (issue #20). A pure, SDK-free
 * presentational component so the export control, cancellation, state, and
 * error display can be unit tested without the plugin app host. Exports go
 * through callbacks wired to the server RPCs in app.tsx; cancellation is
 * low-latency over the panel transport.
 */
export function PanelDownloadsSurface({
  downloads,
  limits,
  isController,
  exportState,
  onCancel,
  onExportClient,
}: {
  downloads: (BrowserDownloadListingEntry & { error?: string | null })[];
  limits: BrowserDownloadLimits | null;
  isController: boolean;
  exportState: {
    /** DownloadId currently being exported, if any. */
    inFlightDownloadId: string | null;
    /** Privacy-safe error message for the last export, if it failed. */
    error: string | null;
  };
  /**
   * Cancel an in-flight download. Cancellation is low-latency over the panel
   * transport, so a surface without one — Browser Settings, which has no live
   * transport — simply does not offer it.
   */
  onCancel?: (downloadId: string) => void;
  onExportClient: (downloadId: string) => void;
}) {
  return (
    <section
      aria-label="Browser Host Downloads quarantine"
      className="mt-4 text-left"
    >
      <h3 className="text-sm font-semibold text-foreground">Host Downloads</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Downloads are quarantined on the workspace host and never opened or
        exported automatically. Export is an explicit owner decision.
      </p>
      {limits === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Limits: {Math.round(limits.maxFileBytes / (1024 * 1024))} MiB/file ·{" "}
          {Math.round(limits.maxProfileBytes / (1024 * 1024 * 1024))}{" "}
          GiB/profile · expires after{" "}
          {Math.round(limits.expiryMs / (24 * 60 * 60_000))} days.
        </p>
      )}
      {exportState.error === null ? null : (
        <p role="alert" className="mt-2 text-xs text-destructive-text">
          {exportState.error}
        </p>
      )}
      {downloads.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No quarantined downloads. Files the browser saves land here first.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {downloads.map((download) => {
            return (
              <li
                key={download.downloadId}
                className="rounded-lg border border-border bg-card p-3 text-xs"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <strong className="break-all text-foreground">
                    {download.safeName}
                  </strong>
                  <span
                    aria-label="Download quarantine state"
                    className="font-mono text-muted-foreground"
                  >
                    {download.phase}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {download.sizeBytes}
                  {download.totalBytes === null
                    ? " bytes"
                    : `/${download.totalBytes} bytes`}{" "}
                  · expires {new Date(download.expiresAt).toLocaleString()}
                  {download.contentType === null
                    ? ""
                    : ` · ${download.contentType}`}
                </div>
                {download.error === null ||
                download.error === undefined ? null : (
                  <p role="alert" className="mt-1 text-destructive-text">
                    {download.error}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {download.phase === "downloading" &&
                  isController &&
                  onCancel !== undefined ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onCancel(download.downloadId)}
                    >
                      Cancel download
                    </Button>
                  ) : null}
                  {download.phase === "quarantined" && isController ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={
                        exportState.inFlightDownloadId === download.downloadId
                      }
                      onClick={() => onExportClient(download.downloadId)}
                    >
                      {exportState.inFlightDownloadId === download.downloadId
                        ? "Exporting…"
                        : "Export to client"}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
