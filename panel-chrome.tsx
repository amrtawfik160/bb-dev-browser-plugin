import { useEffect, useRef, useState } from "react";
import type React from "react";
import {
  BROWSER_PANEL_ACCENT_CONTRAST,
  BROWSER_PANEL_BORDER_CONTRAST,
  BROWSER_PANEL_TEXT_CONTRAST,
  type BrowserContextAction,
  type BrowserDialogEvent,
} from "./contracts.js";

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
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Focus the prompt input for prompts, else the primary action.
    const target =
      dialog.type === "prompt" ? promptRef.current : primaryRef.current;
    target?.focus();
    if (dialog.type === "prompt" && promptRef.current !== null)
      promptRef.current.select();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, [dialog.dialogId, dialog.type]);

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
      className="mt-3 rounded border p-4 text-left"
      style={{
        borderColor: BROWSER_PANEL_BORDER_CONTRAST,
        color: BROWSER_PANEL_TEXT_CONTRAST,
        transition: reducedMotion ? "none" : undefined,
      }}
    >
      <p
        id={`browser-dialog-${dialog.dialogId}-message`}
        className="text-sm"
        style={{ color: BROWSER_PANEL_TEXT_CONTRAST }}
      >
        {dialog.message === "" ? `${dialog.type} dialog` : dialog.message}
      </p>
      {dialog.type === "prompt" ? (
        <label className="mt-2 block text-xs">
          Prompt answer
          <input
            ref={promptRef}
            type="text"
            className="mt-1 block w-full rounded border px-2 py-1 text-sm"
            style={{ borderColor: BROWSER_PANEL_BORDER_CONTRAST }}
            value={promptText}
            disabled={!isController}
            onChange={(event) => setPromptText(event.target.value)}
            aria-label="Prompt answer"
          />
        </label>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          ref={primaryRef}
          className="rounded border px-3 py-1 text-xs"
          disabled={!isController}
          style={{
            backgroundColor: isController
              ? BROWSER_PANEL_ACCENT_CONTRAST
              : undefined,
            color: isController ? "white" : undefined,
          }}
          onClick={() =>
            isController &&
            onRespond(true, dialog.type === "prompt" ? promptText : undefined)
          }
        >
          {acceptLabel}
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1 text-xs"
          disabled={!isController}
          onClick={() => isController && onRespond(false)}
        >
          {dismissLabel}
        </button>
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
        className="mt-3 rounded border p-2 text-xs"
        style={{
          borderColor: BROWSER_PANEL_BORDER_CONTRAST,
          color: BROWSER_PANEL_TEXT_CONTRAST,
          transition: reducedMotion ? "none" : undefined,
        }}
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
      className="mt-3 inline-block rounded border p-1 text-left"
      style={{
        borderColor: BROWSER_PANEL_BORDER_CONTRAST,
        color: BROWSER_PANEL_TEXT_CONTRAST,
        transition: reducedMotion ? "none" : undefined,
      }}
    >
      <p className="mb-1 text-xs text-muted-foreground">
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
          className="block w-full rounded px-3 py-1 text-left text-xs"
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
