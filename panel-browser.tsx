import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { ReactNode } from "react";
import {
  BROWSER_PANEL_ACCENT_CONTRAST,
  BROWSER_PANEL_BORDER_CONTRAST,
  type BrowserStatus,
  type BrowserTab,
} from "./contracts.js";
import { isBbGlobalShortcut } from "./panel-chrome.js";

/**
 * The browser the owner sees (issue #50): a toolbar, a tab strip, and the page
 * filling everything below them. These are SDK-free presentational components,
 * like the dialog and download chrome in {@link ./panel-chrome.js}, so app.tsx
 * owns the RPC wiring and this module owns what is on screen.
 *
 * The panel speaks owner-facing language rather than the domain vocabulary
 * this repository is built on (ADR 0014). A held Control Lease is a coloured
 * border and the agent's stated purpose; a solitary owner sees no spectator
 * count; Automation Mode is not announced because it is the normal mode; and
 * nothing here prints an identifier the owner cannot act on. `CONTEXT.md`
 * remains the source of truth for what those concepts mean.
 */

/**
 * Host states that replace the page, because there is no page to show and
 * nothing the owner can do in the browser until the host is fixed. Every other
 * non-healthy state — a sleeping or waking instance — keeps the browser on
 * screen with the last frame and says so in the toolbar, because those states
 * resolve themselves within seconds and blanking the page for them reads as a
 * fault.
 */
export const PAGE_REPLACING_BROWSER_STATES: readonly BrowserStatus["state"][] =
  [
    "setup-required",
    "host-offline",
    "repair-required",
    "unsupported",
    "safe-login-elsewhere",
  ];

export function browserStateReplacesPage(state: BrowserStatus["state"]) {
  return PAGE_REPLACING_BROWSER_STATES.includes(state);
}

/** States where the browser is on screen but is not answering input yet. */
export function browserStateIsSettling(state: BrowserStatus["state"]) {
  return state === "sleeping" || state === "waking";
}

/**
 * What the owner can do with this browser right now. A view-only panel is a
 * second client watching someone else's session: it gets a way to take the
 * session, not a disabled copy of the controls it cannot use.
 */
export type BrowserPanelRole = "controller" | "spectator";

export type BrowserPanelOption =
  | {
      kind: "action";
      id: string;
      label: string;
      description?: string;
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "toggle";
      id: string;
      label: string;
      description?: string;
      checked: boolean;
      onChange: (checked: boolean) => void;
    }
  | { kind: "note"; id: string; label: string };

/**
 * The toolbar's overflow menu: everything the owner does to this session
 * rather than to the page. Hand-rolled rather than pulled from a component
 * kit, like the panel's other chrome, so it keeps working wherever the plugin
 * frontend is mounted: Escape closes it and restores focus, arrows move
 * between items, and BB's own global shortcuts pass straight through.
 */
export function BrowserOptionsMenu({
  options,
  reducedMotion,
}: {
  options: readonly BrowserPanelOption[];
  reducedMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const selectable = options.filter((option) => option.kind !== "note");

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  function close(restoreFocus = true) {
    setOpen(false);
    setActiveIndex(0);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function focusItem(index: number) {
    const count = selectable.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    setActiveIndex(wrapped);
    itemRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isBbGlobalShortcut(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
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
      focusItem(selectable.length - 1);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        ref={triggerRef}
        aria-label="Browser options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded border px-2 py-1 text-sm"
        onClick={() => setOpen((current) => !current)}
      >
        ⋯
      </button>
      {!open ? null : (
        <div
          role="menu"
          aria-label="Browser options"
          onKeyDown={handleKeyDown}
          className="absolute right-0 z-20 mt-1 w-64 rounded border bg-background p-1 text-left shadow-md"
          style={{
            borderColor: BROWSER_PANEL_BORDER_CONTRAST,
            transition: reducedMotion ? "none" : undefined,
          }}
        >
          {options.map((option) => {
            if (option.kind === "note") {
              return (
                <p
                  key={option.id}
                  className="px-3 py-2 text-xs text-muted-foreground"
                >
                  {option.label}
                </p>
              );
            }
            const index = selectable.indexOf(option);
            const shared = {
              ref: (element: HTMLButtonElement | null) => {
                itemRefs.current[index] = element;
              },
              tabIndex: index === activeIndex ? 0 : -1,
              className:
                "block w-full rounded px-3 py-2 text-left text-sm disabled:opacity-50",
              onMouseEnter: () => setActiveIndex(index),
            } as const;
            if (option.kind === "toggle") {
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={option.checked}
                  {...shared}
                  onClick={() => option.onChange(!option.checked)}
                >
                  <span aria-hidden="true">{option.checked ? "☑" : "☐"} </span>
                  {option.label}
                  {option.description === undefined ? null : (
                    <span className="block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </button>
              );
            }
            return (
              <button
                key={option.id}
                type="button"
                role="menuitem"
                disabled={option.disabled ?? false}
                {...shared}
                onClick={() => {
                  option.onSelect();
                  close();
                }}
              >
                {option.label}
                {option.description === undefined ? null : (
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The single navigation control. There is no field label and no Go button
 * because every browser the owner already uses has neither: the field shows
 * where they are, and Enter takes them somewhere.
 */
function BrowserOmnibox({
  address,
  autoFocus,
  onSubmit,
}: {
  address: string;
  autoFocus: boolean;
  onSubmit: (input: string) => void;
}) {
  // While the owner is typing, the field is theirs; the rest of the time it
  // follows the page, so a navigation an agent or another panel drove is
  // visible here without overwriting a half-typed address.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  return (
    <form
      className="min-w-0 grow"
      onSubmit={(event) => {
        event.preventDefault();
        const input = (draft ?? address).trim();
        if (input === "") return;
        setDraft(null);
        onSubmit(input);
      }}
    >
      <input
        ref={inputRef}
        aria-label="Address or search"
        className="w-full min-w-0 rounded border px-3 py-1 text-sm"
        value={draft ?? address}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isBbGlobalShortcut(event.nativeEvent)) return;
          // Escape abandons the edit and shows the page's own address again.
          if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
    </form>
  );
}

export type BrowserToolbarNavigation = {
  address: string;
  focusAddress: boolean;
  onSubmit: (input: string) => void;
  onHistory: (direction: "back" | "forward" | "reload") => void;
};

export type BrowserToolbarControl = {
  role: BrowserPanelRole;
  /** Other clients watching this session; the owner alone sees no count. */
  spectatorCount: number;
  /** The purpose an agent stated while it holds control, else null. */
  agentPurpose: string | null;
  onTakeControl: () => void;
};

/**
 * The one row pinned above the page: history, the omnibox, host state, and
 * everything else behind an overflow menu.
 */
export function BrowserToolbar({
  status,
  navigation,
  control,
  options,
  reducedMotion,
  onStatusSelect,
  statusHint,
}: {
  status: BrowserStatus;
  navigation: BrowserToolbarNavigation;
  control: BrowserToolbarControl;
  options: readonly BrowserPanelOption[];
  reducedMotion: boolean;
  onStatusSelect: () => void;
  /** Shown when the owner asks the status indicator for detail. */
  statusHint: string | null;
}) {
  const settling = browserStateIsSettling(status.state);
  const isController = control.role === "controller";
  return (
    <div className="border-b bg-background">
      <div className="flex items-center gap-1 px-2 py-1">
        {isController ? (
          <>
            <button
              type="button"
              aria-label="Go back"
              className="rounded border px-2 py-1 text-sm"
              onClick={() => navigation.onHistory("back")}
            >
              ←
            </button>
            <button
              type="button"
              aria-label="Go forward"
              className="rounded border px-2 py-1 text-sm"
              onClick={() => navigation.onHistory("forward")}
            >
              →
            </button>
            <button
              type="button"
              aria-label="Reload page"
              className="rounded border px-2 py-1 text-sm"
              onClick={() => navigation.onHistory("reload")}
            >
              ⟳
            </button>
            <BrowserOmnibox
              address={navigation.address}
              autoFocus={navigation.focusAddress}
              onSubmit={navigation.onSubmit}
            />
          </>
        ) : (
          // A view-only panel gets the one control that changes its
          // situation, where the address field would otherwise be, so it is
          // obvious both that this panel cannot drive the browser and what to
          // do about it.
          <button
            type="button"
            className="grow rounded border px-3 py-1 text-sm"
            style={{
              backgroundColor: BROWSER_PANEL_ACCENT_CONTRAST,
              color: "white",
            }}
            onClick={control.onTakeControl}
          >
            Take control
          </button>
        )}
        {settling ? (
          <span
            role="status"
            aria-label={status.label}
            className="whitespace-nowrap text-xs text-muted-foreground"
          >
            {status.label}
          </span>
        ) : null}
        {control.spectatorCount === 0 ? null : (
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {control.spectatorCount} watching
          </span>
        )}
        <button
          type="button"
          aria-label={`Browser status: ${status.label}`}
          className="rounded px-1 py-1 text-xs"
          onClick={onStatusSelect}
        >
          <span
            aria-hidden="true"
            className="inline-block h-2 w-2 rounded-full align-middle"
            style={{
              backgroundColor:
                status.state === "healthy"
                  ? "#15803d"
                  : settling
                    ? "#b45309"
                    : "#b91c1c",
            }}
          />
        </button>
        <BrowserOptionsMenu options={options} reducedMotion={reducedMotion} />
      </div>
      {control.agentPurpose === null ? null : (
        <div
          className="flex flex-wrap items-center gap-2 px-2 pb-1 text-xs"
          style={{ color: BROWSER_PANEL_ACCENT_CONTRAST }}
        >
          <span>An agent is using this browser: {control.agentPurpose}</span>
          {isController ? (
            <button
              type="button"
              className="rounded border px-2 py-1"
              onClick={control.onTakeControl}
            >
              Interrupt the agent
            </button>
          ) : null}
        </div>
      )}
      {statusHint === null ? null : (
        <p className="px-2 pb-1 text-xs text-muted-foreground">{statusHint}</p>
      )}
    </div>
  );
}

function browserTabLabel(tab: BrowserTab) {
  if (tab.title !== "") return tab.title;
  return tab.url === "" || tab.url === "about:blank" ? "New tab" : tab.url;
}

/**
 * The shared tab strip. The tabs belong to the browser rather than to this
 * panel, so the strip says so: another BB thread opened on the same browser
 * shows exactly these tabs, and closing one here closes it there.
 */
export function BrowserTabStripView({
  tabs,
  activeTabId,
  canDrive,
  onSelect,
  onClose,
  onOpen,
}: {
  tabs: readonly BrowserTab[];
  activeTabId: string | null;
  /** A view-only panel reads the strip but does not change it. */
  canDrive: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onOpen: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number) {
    const count = tabs.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    setActiveIndex(wrapped);
    itemRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    if (isBbGlobalShortcut(event.nativeEvent)) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusTab(activeIndex + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusTab(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusTab(tabs.length - 1);
    }
  }

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <ul
        aria-label="Browser tabs"
        className="flex min-w-0 grow flex-wrap items-center gap-1 text-xs"
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tab, index) => {
          const active = tab.tabId === activeTabId;
          const label = browserTabLabel(tab);
          return (
            <li
              key={tab.tabId}
              className="flex max-w-[16rem] items-center gap-1 rounded border px-2 py-1"
              style={{
                borderColor: active
                  ? BROWSER_PANEL_ACCENT_CONTRAST
                  : BROWSER_PANEL_BORDER_CONTRAST,
              }}
            >
              <button
                type="button"
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                tabIndex={index === activeIndex ? 0 : -1}
                aria-current={active ? "page" : undefined}
                className="min-w-0 truncate"
                style={{ fontWeight: active ? 600 : 400 }}
                title={tab.url}
                disabled={!canDrive}
                onClick={() => onSelect(tab.tabId)}
              >
                {tab.origin === "popup" ? "↗ " : ""}
                {label}
              </button>
              {canDrive ? (
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  className="rounded px-1"
                  onClick={() => onClose(tab.tabId)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {canDrive ? (
        <button
          type="button"
          aria-label="Open a new tab"
          className="rounded border px-2 py-1 text-xs"
          onClick={onOpen}
        >
          <span aria-hidden="true">+</span>
        </button>
      ) : null}
      <span
        className="whitespace-nowrap text-xs text-muted-foreground"
        title="Every BB panel open on this browser shows these tabs."
      >
        Shared tabs
      </span>
    </div>
  );
}

/**
 * What the owner lands on when the browser has nothing to restore. A blank
 * white canvas reads as a failed load, so this says where the browser is
 * running and how to let agents drive it, and the omnibox is already focused.
 */
export function BrowserNewTabSurface({
  hostName,
}: {
  hostName: string | null;
}) {
  return (
    <section
      aria-label="New tab"
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-background p-6 text-center"
    >
      <h2 className="text-base font-semibold text-foreground">
        This browser runs on {hostName ?? "your workspace host"}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Type an address above to start browsing. Sites you sign in to stay
        signed in on that host, and never leave it.
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        Agents in this project cannot use this browser until you let them. Run{" "}
        <code>bb browser trust</code> to allow it, or approve a single site when
        an agent asks.
      </p>
    </section>
  );
}

/**
 * The surface that replaces the page when the host cannot show one. The
 * failure fills the panel because there is nothing else to look at, and the
 * caller fills it with the readiness detail that explains the failure — the
 * same detail Browser Settings keeps for the healthy case, where on the panel
 * it would sit on screen forever saying nothing.
 */
export function BrowserBlockedSurface({
  status,
  children,
}: {
  status: BrowserStatus;
  children?: ReactNode;
}) {
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
      <section
        role="status"
        aria-label={status.label}
        className="max-w-md text-center"
      >
        <h2 className="text-lg font-semibold text-foreground">
          {status.label}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{status.message}</p>
        {children}
      </section>
    </main>
  );
}
