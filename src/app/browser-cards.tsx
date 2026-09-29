import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import {
  isPanelIdentityRejection,
  type rpcContract,
} from "../shared/contracts.js";
import { administrationErrorMessage } from "./browser-client-utils.js";
import {
  BROWSER_CARD_LIVE_WINDOW_MS,
  BROWSER_CARD_REFRESH_INTERVAL_MS,
  BROWSER_PANEL_ACTION_ID,
  browserCardStatusRequest,
  browserPanelParams,
  parseBrowserLiveAttributes,
  parseBrowserSignInAttributes,
  presentBrowserCard,
  type BrowserCardSnapshot,
  type BrowserCardView,
} from "./browser-card-presentation.js";
import { Button, StatusDot } from "./panel-primitives.js";

/**
 * Browser Cards (ADR 0019): chat directives an agent writes on their own line
 * so the owner sees this thread's browser, or a Sign-in Handoff, inside the
 * reply. A card is the owner's own app reading owner RPCs, so it shows live
 * state rather than anything the agent wrote.
 *
 * A card never streams pixels. The page stream is a Browser Panel connection
 * bound to one panel and owner session (ADR 0007); a card links to that panel
 * instead of becoming a second, weaker one.
 */

/**
 * Read a card's snapshot now and then every few seconds for a bounded window.
 * Tabs are read only from a browser that is already awake: reading them from
 * a sleeping one would wake it just to fill a card.
 */
function useBrowserCardSnapshot(threadId: string, profileId?: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<BrowserCardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveUntil, setLiveUntil] = useState(
    () => Date.now() + BROWSER_CARD_LIVE_WINDOW_MS,
  );
  const [paused, setPaused] = useState(false);

  const load = useCallback(async (): Promise<BrowserCardSnapshot> => {
    const status = await rpc.call(
      "browser_status",
      browserCardStatusRequest(threadId, profileId),
    );
    const hostId = status.hostId;
    if (hostId === null || status.state === "host-offline") {
      return { status, profiles: null, tabs: null };
    }
    const [profiles, tabs] = await Promise.all([
      rpc.call("browser_profiles", { hostId, threadId }).catch(() => null),
      status.state === "healthy"
        ? rpc
            .call("browser_tabs", { hostId, profileId: status.profileId })
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    return { status, profiles, tabs };
  }, [rpc, threadId, profileId]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setPaused(false);
    const tick = () => {
      if (disposed) return;
      if (Date.now() >= liveUntil) {
        setPaused(true);
        return;
      }
      const hidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
      const next = hidden ? Promise.resolve(null) : load();
      void next
        .then((loaded) => {
          if (disposed || loaded === null) return;
          setSnapshot(loaded);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!disposed) setError(administrationErrorMessage(cause));
        })
        .finally(() => {
          if (disposed) return;
          timer = setTimeout(tick, BROWSER_CARD_REFRESH_INTERVAL_MS);
        });
    };
    tick();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [load, liveUntil]);

  return {
    snapshot,
    error,
    paused,
    refresh: () => setLiveUntil(Date.now() + BROWSER_CARD_LIVE_WINDOW_MS),
  };
}

/**
 * Open this thread's Browser Panel on the card's profile. A card naming the
 * profile the thread already shows reuses the thread's Browser tab; any other
 * profile gets its own tab, so a card never changes which profile the thread
 * uses.
 */
function useOpenBrowserPanel() {
  const navigate = useBbNavigate();
  return (view: BrowserCardView, profileId: string | undefined) =>
    navigate.openThreadPanel(
      view.pinsProfile && profileId !== undefined
        ? {
            actionId: BROWSER_PANEL_ACTION_ID,
            title: `Browser · ${view.profileName ?? profileId}`,
            params: { profileId },
          }
        : {
            actionId: BROWSER_PANEL_ACTION_ID,
            title: "Browser",
            params: browserPanelParams,
          },
    );
}

function CardFrame({
  label,
  heading,
  view,
  children,
}: {
  label: string;
  heading: string;
  view: BrowserCardView | null;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="my-2 max-w-xl rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground"
    >
      <div className="flex items-center gap-2">
        {view === null ? null : (
          <StatusDot tone={view.tone} label={view.stateLabel} />
        )}
        <p className="min-w-0 grow truncate font-medium">{heading}</p>
        {view === null ? null : (
          <span className="shrink-0 text-xs text-muted-foreground">
            {view.stateLabel}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * Page title and address as text. The address is deliberately not a link:
 * opening it on the displaying client would load it without this profile's
 * sign-in, and a card must not turn page-controlled text into a click target.
 */
function ActiveTabSummary({ view }: { view: BrowserCardView }) {
  if (view.activeTab === null) {
    return view.tone === "ready" ? (
      <p className="mt-1 text-muted-foreground">No page is open.</p>
    ) : null;
  }
  return (
    <div className="mt-1 min-w-0">
      {view.activeTab.title === "" ? null : (
        <p className="truncate">{view.activeTab.title}</p>
      )}
      <p className="truncate text-xs text-muted-foreground">
        {view.activeTab.url}
      </p>
    </div>
  );
}

function CardNotes({
  view,
  error,
}: {
  view: BrowserCardView | null;
  error: string | null;
}) {
  return (
    <>
      {view?.message == null ? null : (
        <p className="mt-1 text-muted-foreground">{view.message}</p>
      )}
      {view?.agentPurpose == null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          An agent is driving it: {view.agentPurpose}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="mt-1 text-xs text-destructive-text">
          {error}
        </p>
      )}
    </>
  );
}

function InvalidCard({ name, reason }: { name: string; reason: string }) {
  return (
    <p
      role="alert"
      className="my-2 max-w-xl rounded-md border border-border px-3 py-2 text-xs text-muted-foreground"
    >
      This {name} card cannot be shown: {reason}
    </p>
  );
}

function profileHeading(view: BrowserCardView | null) {
  const name = view?.profileName ?? null;
  return name === null ? "Browser" : `Browser · ${name}`;
}

export function BrowserLiveCard({
  attributes,
  message,
}: PluginMessageDirectiveProps) {
  const parsed = parseBrowserLiveAttributes(attributes);
  if (parsed.outcome === "invalid") {
    return <InvalidCard name="browser" reason={parsed.reason} />;
  }
  return (
    <BrowserLiveCardBody
      threadId={message.threadId}
      profileId={parsed.profileId}
    />
  );
}

function BrowserLiveCardBody({
  threadId,
  profileId,
}: {
  threadId: string;
  profileId: string | undefined;
}) {
  const { snapshot, error, paused, refresh } = useBrowserCardSnapshot(
    threadId,
    profileId,
  );
  const openPanel = useOpenBrowserPanel();
  const [declined, setDeclined] = useState(false);
  const view =
    snapshot === null ? null : presentBrowserCard(snapshot, profileId);
  return (
    <CardFrame label="Browser" heading={profileHeading(view)} view={view}>
      {view === null ? (
        error === null ? (
          <p role="status" className="mt-1 text-muted-foreground">
            Checking the browser…
          </p>
        ) : null
      ) : (
        <ActiveTabSummary view={view} />
      )}
      <CardNotes view={view} error={error} />
      {declined ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Open this thread in BB to see its Browser Panel.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={view === null}
          onClick={() => {
            if (view !== null) setDeclined(!openPanel(view, profileId));
          }}
        >
          Open in panel
        </Button>
        {paused ? (
          <Button variant="ghost" size="sm" onClick={refresh}>
            Refresh
          </Button>
        ) : null}
      </div>
    </CardFrame>
  );
}

export function BrowserSignInCard({
  attributes,
  message,
}: PluginMessageDirectiveProps) {
  const parsed = parseBrowserSignInAttributes(attributes);
  if (parsed.outcome === "invalid") {
    return <InvalidCard name="sign-in" reason={parsed.reason} />;
  }
  return (
    <BrowserSignInCardBody
      threadId={message.threadId}
      origin={parsed.origin}
      profileId={parsed.profileId}
    />
  );
}

type HandoffPhase =
  | { phase: "idle" }
  | { phase: "opening" }
  | { phase: "opened" }
  | { phase: "failed"; message: string };

type NotificationPhase =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; delivery: "sent" | "queued" | "deferred" }
  | { phase: "failed"; message: string };

function BrowserSignInCardBody({
  threadId,
  origin,
  profileId,
}: {
  threadId: string;
  origin: string;
  profileId: string | undefined;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { snapshot, error, paused, refresh } = useBrowserCardSnapshot(
    threadId,
    profileId,
  );
  const openPanel = useOpenBrowserPanel();
  const [handoff, setHandoff] = useState<HandoffPhase>({ phase: "idle" });
  const [notification, setNotification] = useState<NotificationPhase>({
    phase: "idle",
  });
  const notificationStarted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const view =
    snapshot === null ? null : presentBrowserCard(snapshot, profileId);
  const site = new URL(origin).host;
  const onSite =
    view?.activeTab !== null &&
    view?.activeTab !== undefined &&
    safeOrigin(view.activeTab.url) === origin;

  /**
   * The owner, not the agent, takes the browser to the site: an owner
   * navigation from the card, the same one the panel's address bar makes,
   * after the panel is on screen to sign in with.
   */
  async function openSignIn() {
    const status = snapshot?.status;
    if (view === null || status === undefined || status.hostId === null) {
      return;
    }
    if (!openPanel(view, profileId)) {
      setHandoff({
        phase: "failed",
        message: "Open this thread in BB to sign in from its Browser Panel.",
      });
      return;
    }
    setHandoff({ phase: "opening" });
    try {
      const response = await rpc.call("browser_navigate", {
        surface: "thread",
        threadId,
        hostId: status.hostId,
        profileId: status.profileId,
        input: origin,
      });
      if (!mounted.current) return;
      setHandoff(
        isPanelIdentityRejection(response)
          ? { phase: "failed", message: response.message }
          : { phase: "opened" },
      );
    } catch (cause) {
      if (mounted.current) {
        setHandoff({
          phase: "failed",
          message: administrationErrorMessage(cause),
        });
      }
    }
  }

  async function notifyDone() {
    if (notificationStarted.current) return;
    notificationStarted.current = true;
    setNotification({ phase: "sending" });
    try {
      const targetProfileId = snapshot?.status.profileId ?? profileId;
      const response = await rpc.call("browser_sign_in_done", {
        threadId,
        origin,
        ...(targetProfileId === undefined
          ? {}
          : { profileId: targetProfileId }),
      });
      if (mounted.current) {
        setNotification({ phase: "sent", delivery: response.delivery });
      }
    } catch (cause) {
      notificationStarted.current = false;
      if (mounted.current) {
        setNotification({
          phase: "failed",
          message: administrationErrorMessage(cause),
        });
      }
    }
  }

  return (
    <CardFrame
      label={`Sign in to ${site}`}
      heading={`Sign in to ${site}`}
      view={view}
    >
      <p className="mt-1">
        An agent needs you to sign in to {origin}
        {view?.profileName == null ? "" : ` in ${view.profileName}`}. Sign in
        yourself in the Browser Panel, then click Done to let the agent
        continue. Never paste a password into chat.
      </p>
      {onSite ? (
        <p className="mt-1 text-xs text-muted-foreground">
          The browser is on {view?.activeTab?.url}.
        </p>
      ) : null}
      <CardNotes view={view} error={error} />
      {handoff.phase === "opened" ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          Opened {site} in the Browser Panel. Click Done once you are signed in.
        </p>
      ) : null}
      {handoff.phase === "failed" ? (
        <p role="alert" className="mt-1 text-xs text-destructive-text">
          {handoff.message}
        </p>
      ) : null}
      {notification.phase === "sent" ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {notification.delivery === "sent"
            ? "Agent notified. Your sign-in reply was sent to this thread."
            : notification.delivery === "queued"
              ? "Your sign-in reply is queued for the agent's next turn."
              : "Your sign-in reply will be delivered when the agent can receive it."}
        </p>
      ) : null}
      {notification.phase === "failed" ? (
        <p role="alert" className="mt-1 text-xs text-destructive-text">
          {notification.message}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={
            view === null || !view.canNavigate || handoff.phase === "opening"
          }
          onClick={() => void openSignIn()}
        >
          {handoff.phase === "opening" ? "Opening…" : `Open ${site}`}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={
            handoff.phase === "opening" ||
            notification.phase === "sending" ||
            notification.phase === "sent"
          }
          onClick={() => void notifyDone()}
        >
          {notification.phase === "sending"
            ? "Notifying…"
            : notification.phase === "sent"
              ? "Agent notified"
              : "Done"}
        </Button>
        {view !== null && !view.canNavigate ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void openPanel(view, profileId)}
          >
            Open in panel
          </Button>
        ) : null}
        {paused ? (
          <Button variant="ghost" size="sm" onClick={refresh}>
            Refresh
          </Button>
        ) : null}
      </div>
    </CardFrame>
  );
}

function safeOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
