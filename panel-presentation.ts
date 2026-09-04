import type {
  BrowserGrantRequest,
  BrowserPanelControlResponse,
  BrowserStatus,
  BrowserTab,
  BrowserTabStrip,
} from "./contracts.js";
import {
  browserAccessRequestKey,
  browserStateReplacesPage,
  isBlankBrowserPage,
  type BrowserAccessRequest,
} from "./panel-browser.js";

/**
 * Owner-facing Browser Panel translation (issue #62, ADR 0014). Typed
 * connection and shared-session state enter here; the chrome renders what
 * this module returns. The app route supplies trusted context and wires
 * actions, and does not independently choose wording or availability.
 */

export type BrowserPanelConnectionPhase =
  "connecting" | "streaming" | "reconnecting" | "offline";

export type BrowserPanelOptionDescriptor =
  | {
      kind: "action";
      id: "release-control" | "take-control";
      label: string;
      description?: string;
      disabled: boolean;
    }
  | {
      kind: "toggle";
      id: "raw-localhost";
      label: string;
      description: string;
      checked: boolean;
    }
  | { kind: "note"; id: "settings"; label: string };

export type BrowserPanelView = {
  replacesPage: boolean;
  role: "controller" | "spectator";
  spectatorCount: number;
  agentPurpose: string | null;
  agentDriven: boolean;
  canDrive: boolean;
  address: string;
  showsNewTabSurface: boolean;
  showsSafeLoginNotice: boolean;
  accessQuestions: readonly BrowserAccessRequest[];
  statusHint: string | null;
  options: readonly BrowserPanelOptionDescriptor[];
};

const SETTINGS_LOCATION =
  "Browser profiles, agent access, downloads, and activity are in BB settings under Browser.";

export function browserPanelRecoveryAnnouncement(
  phase: BrowserPanelConnectionPhase,
) {
  if (phase === "connecting") return "Connecting to the browser…";
  if (phase === "reconnecting") return "Reconnecting to the browser…";
  if (phase === "streaming") return "The page is live.";
  return "This browser is not connected.";
}

export function presentBrowserPanel(state: {
  status: BrowserStatus;
  control: BrowserPanelControlResponse | null;
  panelId: string;
  grantRequests: readonly BrowserGrantRequest[];
  hostName: string | null;
  tabStrip: BrowserTabStrip | null;
  lastNavigation: { tabId: string | null; url: string } | null;
  rawLocalhost: boolean;
  transferPending: boolean;
  showStatusDetail: boolean;
}): BrowserPanelView {
  const session = presentControlSession(state.control, state.panelId);
  const tabs = state.tabStrip?.tabs ?? [];
  const activeTab =
    tabs.find((tab) => tab.tabId === state.tabStrip?.activeTabId) ?? null;
  const address = presentOmniboxAddress(activeTab, state.lastNavigation);
  return {
    replacesPage: browserStateReplacesPage(state.status.state),
    ...session,
    address,
    showsNewTabSurface: address === "",
    showsSafeLoginNotice: state.status.state === "safe-login-elsewhere",
    accessQuestions: presentAccessQuestions(state.grantRequests),
    statusHint: state.showStatusDetail
      ? presentStatusHint(state.status, state.hostName)
      : null,
    options: presentSessionOptions({
      isController: session.canDrive,
      transferPending: state.transferPending,
      rawLocalhost: state.rawLocalhost,
    }),
  };
}

function presentControlSession(
  control: BrowserPanelControlResponse | null,
  panelId: string,
) {
  const isController = control === null || control.role === "controller";
  const agentPurpose = control?.control.agentPurpose ?? null;
  return {
    role: isController ? ("controller" as const) : ("spectator" as const),
    spectatorCount:
      control === null
        ? 0
        : control.control.panels.filter(
            (panel) => panel.role === "spectator" && panel.panelId !== panelId,
          ).length,
    agentPurpose,
    agentDriven: agentPurpose !== null,
    canDrive: isController,
  };
}

function presentAccessQuestions(
  requests: readonly BrowserGrantRequest[],
): BrowserAccessRequest[] {
  const questions = new Map<string, BrowserAccessRequest>();
  for (const request of requests) {
    if (request.status !== "pending") continue;
    const elevations = [
      request.requestedElevations.fileTransfer ? "file transfer" : null,
      request.requestedElevations.invalidCertificate
        ? "an invalid certificate"
        : null,
    ].filter((elevation): elevation is string => elevation !== null);
    // An agent denied five times on one site asked one question, so the owner
    // is asked it once, and answering it answers every one of them.
    const key = browserAccessRequestKey(request);
    const asked = questions.get(key);
    questions.set(key, {
      requestIds: [...(asked?.requestIds ?? []), request.requestId],
      projectId: request.projectId,
      origin: request.origin,
      elevations: [...new Set([...(asked?.elevations ?? []), ...elevations])],
    });
  }
  return [...questions.values()];
}

function presentOmniboxAddress(
  activeTab: BrowserTab | null,
  lastNavigation: { tabId: string | null; url: string } | null,
) {
  // The tab the browser is on is the truth. A navigation this panel just
  // drove only stands in until the shared strip reports it, and only for
  // the tab it happened in.
  if (activeTab !== null && !isBlankBrowserPage(activeTab.url)) {
    return activeTab.url;
  }
  if (lastNavigation === null) return "";
  const belongsToAnotherTab =
    activeTab !== null &&
    lastNavigation.tabId !== null &&
    lastNavigation.tabId !== activeTab.tabId;
  return belongsToAnotherTab ? "" : lastNavigation.url;
}

function presentStatusHint(status: BrowserStatus, hostName: string | null) {
  const host = hostName ?? "this workspace host";
  const state =
    status.state === "healthy"
      ? `This browser is ready on ${host}.`
      : `${status.label} on ${host}. ${status.message}`;
  return `${state} ${SETTINGS_LOCATION}`;
}

function presentSessionOptions(input: {
  isController: boolean;
  transferPending: boolean;
  rawLocalhost: boolean;
}): BrowserPanelOptionDescriptor[] {
  const sessionAction: BrowserPanelOptionDescriptor = input.isController
    ? {
        kind: "action",
        id: "release-control",
        label: "Let another panel take over",
        description: "Hands this browser to the next panel that asks for it.",
        disabled: input.transferPending,
      }
    : {
        kind: "action",
        id: "take-control",
        label: "Take control",
        disabled: input.transferPending,
      };
  return [
    sessionAction,
    {
      kind: "toggle",
      id: "raw-localhost",
      label: "Use plain localhost addresses",
      description:
        "Only for sites that reject this project's own localhost name.",
      checked: input.rawLocalhost,
    },
    {
      kind: "note",
      id: "settings",
      label: SETTINGS_LOCATION,
    },
  ];
}
