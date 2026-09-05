import { useEffect, useRef, useState } from "react";
import type React from "react";
import type { ReactNode } from "react";
import type { BrowserStatus, BrowserTab } from "../shared/contracts.js";
import { isBbGlobalShortcut } from "./panel-chrome.js";
import {
  Button,
  Glyph,
  IconButton,
  StatusDot,
  inputClassName,
} from "./panel-primitives.js";

/**
 * The browser the owner sees (issue #50): a toolbar, a tab strip, and the page
 * filling everything below them. These are SDK-free presentational components,
 * like the dialog and download chrome in {@link ./panel-chrome.js}.
 * {@link ./panel-presentation.js} owns owner-facing wording and action
 * availability from typed connection and session state; this module paints
 * that view. The app route supplies trusted context and wires actions.
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
const PAGE_REPLACING_BROWSER_STATES: readonly BrowserStatus["state"][] = [
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
type BrowserPanelRole = "controller" | "spectator";

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
function BrowserOptionsMenu({
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
      <IconButton
        ref={triggerRef}
        label="Browser options"
        glyph="more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      />
      {!open ? null : (
        <div
          role="menu"
          aria-label="Browser options"
          onKeyDown={handleKeyDown}
          className="absolute right-0 z-20 mt-1 w-64 rounded-lg border border-border bg-popover p-1 text-left text-popover-foreground shadow-md"
          style={{ transition: reducedMotion ? "none" : undefined }}
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
                "block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none disabled:opacity-50",
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
                  <span className="flex items-center gap-2">
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input">
                      {option.checked ? (
                        <Glyph name="check" className="h-3 w-3" />
                      ) : null}
                    </span>
                    {option.label}
                  </span>
                  {option.description === undefined ? null : (
                    <span className="block pl-6 text-xs text-muted-foreground">
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
        className={`${inputClassName} h-7 py-0`}
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

type BrowserToolbarNavigation = {
  address: string;
  focusAddress: boolean;
  onSubmit: (input: string) => void;
  onHistory: (direction: "back" | "forward" | "reload") => void;
};

type BrowserToolbarControl = {
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
    <div className="border-b border-border bg-background">
      <div className="flex h-9 items-center gap-1 px-2">
        {isController ? (
          <>
            <IconButton
              label="Go back"
              glyph="back"
              onClick={() => navigation.onHistory("back")}
            />
            <IconButton
              label="Go forward"
              glyph="forward"
              onClick={() => navigation.onHistory("forward")}
            />
            <IconButton
              label="Reload page"
              glyph="reload"
              onClick={() => navigation.onHistory("reload")}
            />
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
          <Button
            variant="primary"
            size="sm"
            className="grow"
            onClick={control.onTakeControl}
          >
            Take control
          </Button>
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
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Browser status: ${status.label}`}
          title={status.label}
          className="w-7 px-0"
          onClick={onStatusSelect}
        >
          <StatusDot
            tone={
              status.state === "healthy"
                ? "ready"
                : settling
                  ? "settling"
                  : "blocked"
            }
            label={status.label}
          />
        </Button>
        <BrowserOptionsMenu options={options} reducedMotion={reducedMotion} />
      </div>
      {control.agentPurpose === null ? null : (
        // The one place the panel uses the attention color: the owner's
        // authenticated session is being driven by something that is not them.
        <div className="flex flex-wrap items-center gap-2 border-t border-attention/40 bg-surface-attention px-2 py-1 text-xs text-foreground">
          <span className="min-w-0 grow truncate">
            Agent: {control.agentPurpose}
          </span>
          {isController ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={control.onTakeControl}
            >
              Interrupt the agent
            </Button>
          ) : null}
        </div>
      )}
      {statusHint === null ? null : (
        <p className="px-2 pb-1 text-xs text-muted-foreground">{statusHint}</p>
      )}
    </div>
  );
}

/**
 * One site an agent was denied and is waiting on. The identifier the request
 * is stored under is carried so a decision can name it, and is never rendered:
 * the owner decides about a site, not about a UUID (ADR 0014).
 */
export type BrowserAccessRequest = {
  /**
   * Every pending request this question stands for. One site denied five times
   * is one question to the owner, and answering it answers all five.
   */
  requestIds: readonly string[];
  /** The BB project whose agents were denied; named in a decision, not shown. */
  projectId: string;
  origin: string;
  /** Extra permissions asked for alongside ordinary browsing, if any. */
  elevations: readonly string[];
};

/**
 * What identifies one question to the owner: the project whose agents were
 * denied, and the site they were denied on. One profile serves every project
 * on the host, so two projects can be waiting on the same site at once — those
 * are two questions, and answering one leaves the other standing.
 */
export function browserAccessRequestKey(request: {
  projectId: string;
  origin: string;
}) {
  return `${request.projectId} ${request.origin}`;
}

/**
 * A denied site, presented as the question the owner can answer. Approving
 * this one site is the primary action because it is the narrow one; trusting
 * the whole project is available for an owner tired of being asked, and is the
 * same unlock `bb browser trust` performs.
 */
export function BrowserAccessRequestNotices({
  requests,
  answering,
  onAllow,
  onDeny,
  onTrustProject,
}: {
  requests: readonly BrowserAccessRequest[];
  /**
   * The question a decision is currently in flight for, if any. Every answer
   * is held while one is, so a second click cannot race the first.
   */
  answering: string | null;
  onAllow: (request: BrowserAccessRequest) => void;
  onDeny: (request: BrowserAccessRequest) => void;
  onTrustProject: (request: BrowserAccessRequest) => void;
}) {
  if (requests.length === 0) return null;
  return (
    <section
      aria-label="Site access requests"
      className="overflow-auto border-b border-border px-2 py-2 text-left"
      // However many sites are waiting, the page keeps most of the panel.
      style={{ maxHeight: "40%" }}
    >
      <ul className="space-y-2">
        {requests.map((request) => {
          // Persistent access to an extra permission takes a second,
          // deliberate confirmation, which lives in Browser Settings. Here the
          // owner can still unblock the agent, for an hour.
          const elevated = request.elevations.length > 0;
          const allowLabel = elevated
            ? `Allow ${request.origin} for an hour`
            : `Allow ${request.origin}`;
          return (
            <li
              key={browserAccessRequestKey(request)}
              className="rounded-lg border border-border bg-card p-3 text-sm"
            >
              <p>
                Let agents in this project use{" "}
                <strong className="break-all">{request.origin}</strong>?
                {elevated
                  ? ` They also asked for ${request.elevations.join(" and ")}.`
                  : ""}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={answering !== null}
                  onClick={() => onAllow(request)}
                >
                  {allowLabel}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={answering !== null}
                  onClick={() => onDeny(request)}
                >
                  {`Deny ${request.origin}`}
                </Button>
                <Button
                  variant="link"
                  className="text-xs"
                  disabled={answering !== null}
                  onClick={() => onTrustProject(request)}
                >
                  Allow every site for this project
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Whatever you choose, the agent does not carry on by itself: it
                has to try again.
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * A page the owner cannot read anything from. A browser that has just started
 * with nothing to restore sits on one, and showing its blank pixels reads as a
 * failed load rather than as a browser waiting for an address.
 */
export function isBlankBrowserPage(url: string) {
  return url === "" || url.startsWith("about:");
}

function browserTabLabel(tab: BrowserTab) {
  if (tab.title !== "") return tab.title;
  return isBlankBrowserPage(tab.url) ? "New tab" : tab.url;
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
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <ul
        aria-label="Browser tabs"
        className="flex min-w-0 grow items-center gap-1 overflow-x-auto text-xs [scrollbar-width:none]"
        onKeyDown={handleKeyDown}
      >
        {tabs.map((tab, index) => {
          const active = tab.tabId === activeTabId;
          const label = browserTabLabel(tab);
          return (
            <li
              key={tab.tabId}
              className={`flex min-w-24 max-w-56 shrink-0 items-center gap-1 rounded-md border pr-1 pl-2 ${
                active
                  ? "border-surface-selected-border bg-surface-selected"
                  : "border-border bg-card hover:bg-state-hover"
              }`}
            >
              <button
                type="button"
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                tabIndex={index === activeIndex ? 0 : -1}
                aria-current={active ? "page" : undefined}
                className={`flex min-w-0 grow items-center gap-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
                }`}
                title={tab.url}
                onClick={() => onSelect(tab.tabId)}
              >
                {tab.origin === "popup" ? (
                  <Glyph name="external" className="h-3 w-3 shrink-0" />
                ) : null}
                <span className="truncate">{label}</span>
              </button>
              {canDrive ? (
                <IconButton
                  label={`Close ${label}`}
                  glyph="close"
                  className="h-5 w-5"
                  onClick={() => onClose(tab.tabId)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {canDrive ? (
        <IconButton label="Open a new tab" glyph="plus" onClick={onOpen} />
      ) : null}
      <span
        className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
        title="Every BB panel open on this browser shows these tabs."
      >
        Shared tabs
      </span>
    </div>
  );
}

/**
 * The host's readiness checks, one line each. A passed check gets a check
 * mark in the host's success color and a failed one a dash; the label carries
 * the meaning, so the glyphs are decoration for sighted readers only.
 */
export function ReadinessChecklist({ status }: { status: BrowserStatus }) {
  return (
    <ul
      aria-label="Host readiness checklist"
      className="mt-5 space-y-3 text-left"
    >
      {status.capabilities.map((capability) => {
        const ready = capability.status === "ready";
        return (
          <li
            key={capability.id}
            className="flex gap-2 text-sm text-foreground"
          >
            <Glyph
              name={ready ? "check" : "dash"}
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                ready ? "text-success-foreground" : "text-muted-foreground"
              }`}
            />
            <div className="min-w-0">
              <span className="font-medium">{capability.label}</span>
              <p className="text-muted-foreground">{capability.reason}</p>
            </div>
          </li>
        );
      })}
    </ul>
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
        Agents in this project can drive this browser. Review or revoke that in
        Browser Settings.
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
