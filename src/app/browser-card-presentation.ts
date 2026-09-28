import {
  DEFAULT_PROFILE_ID,
  browserProfileIdSchema,
  normalizeBrowserOrigin,
  type BrowserProfileInventory,
  type BrowserStatus,
  type BrowserStatusInput,
  type BrowserTabStrip,
} from "../shared/contracts.js";
import { isBlankBrowserPage } from "./panel-browser.js";
import type { StatusDotTone } from "./panel-primitives.js";

/**
 * Browser Card names, attribute validation, and owner-facing wording (ADR
 * 0019). SDK-free like {@link ./panel-presentation.js}: typed browser state
 * enters here and {@link ./browser-cards.js} paints what this returns. Every
 * directive attribute is an untrusted string until it passes through here.
 */

export const BROWSER_LIVE_DIRECTIVE = "browser-live";
export const BROWSER_SIGN_IN_DIRECTIVE = "browser-sign-in";

/** The thread panel action a card opens, and the params of its default tab. */
export const BROWSER_PANEL_ACTION_ID = "browser";
export const browserPanelParams = { profileId: DEFAULT_PROFILE_ID } as const;

/**
 * How often a card re-reads state, and for how long after it mounts or the
 * owner presses Refresh. Reading tabs counts as browser activity on the host,
 * so an unbounded refresh from a card left in chat history would keep that
 * browser from ever sleeping.
 */
export const BROWSER_CARD_REFRESH_INTERVAL_MS = 5_000;
export const BROWSER_CARD_LIVE_WINDOW_MS = 2 * 60_000;

const PROFILE_ID_ATTRIBUTE = "profile-id";
const ORIGIN_ATTRIBUTE = "origin";

type ParsedAttributes<T> =
  ({ outcome: "valid" } & T) | { outcome: "invalid"; reason: string };

function unexpectedAttribute(
  attributes: Readonly<Record<string, string>>,
  allowed: readonly string[],
) {
  return Object.keys(attributes).find((key) => !allowed.includes(key));
}

function parseProfileAttribute(
  attributes: Readonly<Record<string, string>>,
): ParsedAttributes<{ profileId: string | undefined }> {
  const raw = attributes[PROFILE_ID_ATTRIBUTE];
  if (raw === undefined) return { outcome: "valid", profileId: undefined };
  const parsed = browserProfileIdSchema.safeParse(raw.trim());
  return parsed.success
    ? { outcome: "valid", profileId: parsed.data }
    : { outcome: "invalid", reason: "profile-id is not a Browser Profile id." };
}

export function parseBrowserLiveAttributes(
  attributes: Readonly<Record<string, string>>,
): ParsedAttributes<{ profileId: string | undefined }> {
  const unexpected = unexpectedAttribute(attributes, [PROFILE_ID_ATTRIBUTE]);
  if (unexpected !== undefined) {
    return { outcome: "invalid", reason: `Unknown attribute ${unexpected}.` };
  }
  return parseProfileAttribute(attributes);
}

/**
 * The origin must already be an exact HTTP(S) origin: no path, query,
 * credentials, or other scheme. Normalizing a full URL down to its origin
 * would hide where the agent actually asked the owner to go.
 */
export function parseBrowserSignInAttributes(
  attributes: Readonly<Record<string, string>>,
): ParsedAttributes<{ origin: string; profileId: string | undefined }> {
  const unexpected = unexpectedAttribute(attributes, [
    ORIGIN_ATTRIBUTE,
    PROFILE_ID_ATTRIBUTE,
  ]);
  if (unexpected !== undefined) {
    return { outcome: "invalid", reason: `Unknown attribute ${unexpected}.` };
  }
  const raw = attributes[ORIGIN_ATTRIBUTE]?.trim() ?? "";
  if (raw === "" || raw.length > 2048) {
    return { outcome: "invalid", reason: "origin is required." };
  }
  let origin: string;
  try {
    origin = normalizeBrowserOrigin(raw);
  } catch {
    return {
      outcome: "invalid",
      reason:
        "origin must be an exact http(s) origin such as https://example.com.",
    };
  }
  const profile = parseProfileAttribute(attributes);
  return profile.outcome === "invalid"
    ? profile
    : { outcome: "valid", origin, profileId: profile.profileId };
}

/** Everything a card knows about its browser, read through owner RPCs. */
export type BrowserCardSnapshot = {
  status: BrowserStatus;
  profiles: BrowserProfileInventory | null;
  tabs: BrowserTabStrip | null;
};

export type BrowserCardView = {
  tone: StatusDotTone;
  stateLabel: string;
  profileName: string | null;
  /** Why the browser cannot be used right now; null when it can. */
  message: string | null;
  activeTab: { title: string; url: string } | null;
  agentPurpose: string | null;
  /** Whether an owner navigation from the card can reach this browser. */
  canNavigate: boolean;
  /**
   * The card names a profile other than the one this thread's panel shows,
   * so "Open in panel" opens a tab for that profile instead.
   */
  pinsProfile: boolean;
};

/**
 * Owner-facing wording for a card (ADR 0014): the state of the browser, not
 * the host, lease, or instance vocabulary behind it.
 */
export function presentBrowserCard(
  snapshot: BrowserCardSnapshot,
  requestedProfileId: string | undefined,
): BrowserCardView {
  const { status, profiles, tabs } = snapshot;
  const profile =
    profiles?.profiles.find((entry) => entry.profileId === status.profileId) ??
    null;
  const pinsProfile =
    requestedProfileId !== undefined &&
    profiles !== null &&
    profiles.selectedProfileId !== requestedProfileId;
  const lease = status.controlLease;
  const agentPurpose =
    lease?.actor === "agent"
      ? (lease.purpose ?? "An agent is using this browser.")
      : null;
  const base = {
    profileName: profile?.name ?? null,
    activeTab: null,
    agentPurpose: null,
    pinsProfile,
  };
  if (
    requestedProfileId !== undefined &&
    profiles !== null &&
    (profile === null || profile.state !== "active")
  ) {
    return {
      ...base,
      tone: "blocked",
      stateLabel: "Profile not found",
      message: `This host has no Browser Profile ${requestedProfileId}.`,
      canNavigate: false,
    };
  }
  switch (status.state) {
    case "healthy": {
      const active =
        tabs?.tabs.find((tab) => tab.tabId === tabs.activeTabId) ?? null;
      return {
        ...base,
        tone: "ready",
        stateLabel: "Ready",
        message: null,
        activeTab:
          active === null || isBlankBrowserPage(active.url)
            ? null
            : { title: active.title, url: active.url },
        agentPurpose,
        canNavigate: true,
      };
    }
    case "sleeping":
      return {
        ...base,
        tone: "settling",
        stateLabel: "Sleeping",
        message: "Opening it wakes the browser where it left off.",
        canNavigate: true,
      };
    case "waking":
      return {
        ...base,
        tone: "settling",
        stateLabel: "Waking",
        message: null,
        agentPurpose,
        canNavigate: true,
      };
    case "safe-login-elsewhere":
      return {
        ...base,
        tone: "settling",
        stateLabel: "Safe Login",
        message:
          "You are signing in with Safe Login in another panel. Agents cannot see this browser until you finish.",
        canNavigate: false,
      };
    case "host-offline":
      return {
        ...base,
        tone: "blocked",
        stateLabel: "Host offline",
        message: "Reconnect this thread's workspace host to use its browser.",
        canNavigate: false,
      };
    default:
      return {
        ...base,
        tone: "blocked",
        stateLabel: status.label,
        message:
          status.hostId === null
            ? "Open the Browser Panel to choose a workspace host."
            : status.message,
        canNavigate: false,
      };
  }
}

export function browserCardStatusRequest(
  threadId: string,
  profileId: string | undefined,
): BrowserStatusInput {
  // Without a profile the card asks exactly what this thread's Browser Panel
  // asks, so both resolve the same selected or thread-default profile.
  return profileId === undefined
    ? {
        surface: "thread",
        threadId,
        profileId: DEFAULT_PROFILE_ID,
        profileSelection: "selected",
      }
    : { surface: "thread", threadId, profileId };
}
