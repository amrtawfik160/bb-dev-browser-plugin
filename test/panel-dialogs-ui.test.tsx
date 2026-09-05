// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserContextAction,
  BrowserDialogEvent,
} from "../src/shared/contracts.js";

/**
 * The panel dialog and context-action chrome (issue #17) are pure presentational
 * components wired into the Automation Mode stream. They are exercised directly
 * here for keyboard operation, focus order and restoration, spectator gating,
 * reduced-motion behavior, contrast, and the screen-reader disclosure. The
 * stream wiring and transport re-push / fail-closed are covered by the panel
 * transport contract suite.
 */
let observedMatches = false;
const listeners = new Set<(event: { matches: boolean }) => void>();

beforeEach(() => {
  observedMatches = false;
  listeners.clear();
  // jsdom lacks matchMedia; provide a controllable implementation so the
  // reduced-motion hook can be exercised.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" && observedMatches,
    media: query,
    addEventListener: (
      _event: string,
      listener: (event: { matches: boolean }) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _event: string,
      listener: (event: { matches: boolean }) => void,
    ) => listeners.delete(listener),
    dispatchEvent: () => true,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Import the SDK-free chrome module directly so the presentational components
// can be exercised without the plugin app host.
const { PanelDialogLayer, PanelContextMenu } =
  await import("../src/app/panel-chrome.js");

function alertDialog(): BrowserDialogEvent {
  return {
    dialogId: "d-alert",
    type: "alert",
    message: "Are you sure?",
    defaultValue: "",
    url: "https://example.test/alert",
  };
}

function promptDialog(): BrowserDialogEvent {
  return {
    dialogId: "d-prompt",
    type: "prompt",
    message: "Enter your name",
    defaultValue: "Alice",
    url: "https://example.test/prompt",
  };
}

function beforeunloadDialog(): BrowserDialogEvent {
  return {
    dialogId: "d-bu",
    type: "beforeunload",
    message: "Leave page?",
    defaultValue: "",
    url: "https://example.test/leave",
  };
}

function linkActions(): BrowserContextAction[] {
  return [
    {
      actionId: "open-link-new-tab",
      kind: "open-link-new-tab",
      label: "Open link in new tab",
      targetUrl: "https://example.test/link",
    },
    {
      actionId: "copy-link",
      kind: "copy-link",
      label: "Copy link address",
      targetUrl: "https://example.test/link",
    },
  ];
}

describe("Browser panel reduced-motion hook (issue #17)", () => {
  it("reads the prefers-reduced-motion media query at mount", async () => {
    observedMatches = true;
    const { usePrefersReducedMotion } =
      await import("../src/app/panel-chrome.js");
    function Probe() {
      const reduced = usePrefersReducedMotion();
      return <span data-testid="reduced">{reduced ? "on" : "off"}</span>;
    }
    const { getByTestId } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByTestId("reduced").textContent).toBe("on");
  });
});

describe("Browser panel dialog chrome (issue #17)", () => {
  it("leaves Enter on Cancel to the button instead of accepting the dialog", () => {
    const onRespond = vi.fn();
    render(
      <PanelDialogLayer
        dialog={promptDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={onRespond}
        onClose={vi.fn()}
      />,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("uses the new default answer when another prompt replaces the current dialog", () => {
    const props = {
      isController: true,
      reducedMotion: true,
      onRespond: vi.fn(),
      onClose: vi.fn(),
    };
    const panel = render(
      <PanelDialogLayer {...props} dialog={promptDialog()} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Edited" },
    });
    panel.rerender(
      <PanelDialogLayer
        {...props}
        dialog={{
          ...promptDialog(),
          dialogId: "next-prompt",
          defaultValue: "Next answer",
        }}
      />,
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "Next answer",
    );
  });

  it("renders an alert dialog as an accessible modal with OK and Cancel", () => {
    const onRespond = vi.fn();
    render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={onRespond}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label") ?? "").toContain("alert");
    expect(screen.getByText("Are you sure?")).toBeDefined();
    expect(screen.getByRole("button", { name: "OK" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("focuses the primary action on open and restores focus on close", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    const { unmount } = render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // The primary action receives focus on open.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "OK" }),
    );
    unmount();
    // Focus restores to the element that had it before the dialog opened.
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it("answers an alert with OK via the keyboard and forwards accept=true", () => {
    const onRespond = vi.fn();
    render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={onRespond}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onRespond).toHaveBeenCalledWith(true);
  });

  it("dismisses a dialog with Escape and forwards accept=false", () => {
    const onRespond = vi.fn();
    render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={onRespond}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onRespond).toHaveBeenCalledWith(false);
  });

  it("submits a prompt answer from the focused input", () => {
    const onRespond = vi.fn();
    render(
      <PanelDialogLayer
        dialog={promptDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={onRespond}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Prompt answer" });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Alice");
    fireEvent.change(input, { target: { value: "Bob" } });
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onRespond).toHaveBeenCalledWith(true, "Bob");
  });

  it("labels beforeunload actions as Leave and Stay", () => {
    render(
      <PanelDialogLayer
        dialog={beforeunloadDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Leave" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Stay" })).toBeDefined();
  });

  it("disables every action for a view-only spectator and shows a notice", () => {
    render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={false}
        reducedMotion={true}
        onRespond={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const ok = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
    const cancel = screen.getByRole("button", {
      name: "Cancel",
    }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(
      screen.getByText("Only the controller can answer this dialog."),
    ).toBeDefined();
  });

  it("traps Tab focus inside the dialog so keyboard order stays in chrome", () => {
    render(
      <PanelDialogLayer
        dialog={promptDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Prompt answer" });
    input.focus();
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Tab" });
    // After Tab from the input, focus moves forward to the next focusable
    // element inside the dialog (the submit button), not out of the modal.
    expect(document.activeElement).not.toBe(input);
    expect(
      (document.activeElement as HTMLElement).closest("[role=dialog]"),
    ).toBe(dialog);
  });

  it("yields BB global shortcuts by not handling Cmd/Ctrl key combos", () => {
    const onRespond = vi.fn();
    render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={onRespond}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    // A Cmd/Ctrl combo must pass through; the chrome never claims it.
    fireEvent.keyDown(dialog, { key: "k", metaKey: true });
    fireEvent.keyDown(dialog, { key: "p", ctrlKey: true });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("takes dialog text and border colors from the host theme, not fixed hex values", () => {
    render(
      <PanelDialogLayer
        dialog={alertDialog()}
        isController={true}
        reducedMotion={true}
        onRespond={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog") as HTMLElement;
    // The host guarantees AA contrast for its popover tokens in both themes;
    // a hardcoded color would hold in one theme and fail in the other.
    expect(dialog.className).toContain("bg-popover");
    expect(dialog.className).toContain("text-popover-foreground");
    expect(dialog.className).toContain("border-border");
    expect(dialog.style.color).toBe("");
    expect(dialog.style.borderColor).toBe("");
  });
});

describe("Browser panel context menu chrome (issue #17)", () => {
  it("renders menu items with a roving tabindex and focuses the first", () => {
    render(
      <PanelContextMenu
        actions={linkActions()}
        point={{ x: 100, y: 50 }}
        isController={true}
        reducedMotion={true}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("tabindex")).toBe("0");
    expect(items[1].getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(items[0]);
    expect(menu.getAttribute("aria-label") ?? "").toContain("context");
  });

  it("navigates items with ArrowDown / ArrowUp and activates with Enter", () => {
    const onChoose = vi.fn();
    render(
      <PanelContextMenu
        actions={linkActions()}
        point={{ x: 100, y: 50 }}
        isController={true}
        reducedMotion={true}
        onChoose={onChoose}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    expect(items[1].getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(linkActions()[0]);
  });

  it("closes with Escape and restores the previously focused element", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Canvas";
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <PanelContextMenu
        actions={linkActions()}
        point={{ x: 100, y: 50 }}
        isController={true}
        reducedMotion={true}
        onChoose={vi.fn()}
        onClose={onClose}
      />,
    );
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });

  it("disables context actions for a view-only spectator", () => {
    render(
      <PanelContextMenu
        actions={linkActions()}
        point={{ x: 100, y: 50 }}
        isController={false}
        reducedMotion={true}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const items = screen.getAllByRole("menuitem") as HTMLButtonElement[];
    expect(items.every((item) => item.disabled)).toBe(true);
    expect(
      screen.getByText("Only the controller can trigger context actions."),
    ).toBeDefined();
  });

  it("shows an empty-state when no link or image actions are available", () => {
    render(
      <PanelContextMenu
        actions={[]}
        point={{ x: 100, y: 50 }}
        isController={true}
        reducedMotion={true}
        onChoose={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText("No link or image actions are available at this point."),
    ).toBeDefined();
  });

  it("yields BB global shortcuts by not handling Alt/ Cmd combos", () => {
    const onChoose = vi.fn();
    render(
      <PanelContextMenu
        actions={linkActions()}
        point={{ x: 100, y: 50 }}
        isController={true}
        reducedMotion={true}
        onChoose={onChoose}
        onClose={vi.fn()}
      />,
    );
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter", altKey: true });
    expect(onChoose).not.toHaveBeenCalled();
  });
});
