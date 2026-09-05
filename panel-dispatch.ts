import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import { createPanelPortSharing } from "./panel-sharing.js";
import {
  browserHistoryRequestSchema,
  browserHostPanelVisibilityRequestSchema,
  browserHostReleaseControlRequestSchema,
  browserHostTargetSchema,
  browserNavigationRequestSchema,
  browserNavigationResponseSchema,
  browserPanelCapabilityResponseSchema,
  browserPanelControlRequestSchema,
  browserPanelControlResponseSchema,
  browserPanelHistoryRequestSchema,
  browserPanelNavigationRequestSchema,
  browserPanelReleaseControlRequestSchema,
  browserPanelReleaseHostRequestSchema,
  browserPanelReleaseResponseSchema,
  browserPanelTabActionRequestSchema,
  browserPanelTransportRequestSchema,
  browserPanelTransportResponseSchema,
  browserPanelVisibilityResponseSchema,
  browserTabActionRequestSchema,
  browserTabStripSchema,
  type BrowserHostTarget,
  type BrowserPanelCapabilityRequest,
  type BrowserPanelCapabilityResponse,
  type BrowserPanelControlRequest,
  type BrowserPanelControlResponse,
  type BrowserPanelHistoryInput,
  type BrowserPanelNavigationInput,
  type BrowserPanelReclaimControlRequest,
  type BrowserPanelReleaseControlRequest,
  type BrowserPanelReleaseRequest,
  type BrowserPanelReleaseResponse,
  type BrowserPanelTabActionInput,
  type BrowserPanelTakeControlRequest,
  type BrowserPanelTransportResponse,
  type BrowserPanelVisibilityRequest,
  type BrowserPanelVisibilityResponse,
  type BrowserNavigationResponse,
  type BrowserTabStrip,
  type PanelIdentityRejection,
} from "./contracts.js";
import {
  BROWSER_SETTINGS_PROJECT_ID,
  ownerSessionIdFromContext,
  parseOwnerSessionId,
  type TrustedOwnerSession,
} from "./panel-owner-session.js";

type PanelDispatchMethod =
  | "panelTransport"
  | "panelVisibility"
  | "panelRelease"
  | "navigate"
  | "history"
  | "tabAction"
  | "tabs"
  | "panelControl"
  | "takeControl"
  | "reclaimControl"
  | "releaseControl";

type PanelDispatchHost = {
  call(
    method: PanelDispatchMethod,
    request: unknown,
    options: { hostId: string; signal?: AbortSignal },
  ): Promise<unknown>;
};

type ResolvedHost = {
  outcome: "resolved";
  hostId: string;
  projectId: string;
};

type TrustedHostResolution =
  | ResolvedHost
  | PanelIdentityRejection
  | {
      outcome: "unavailable";
      reason: "host-offline";
      message: string;
    };

type SessionHosts =
  { hostIds: string[]; projectId: string } | PanelIdentityRejection;

const HOST_UNAVAILABLE = {
  outcome: "unavailable" as const,
  reason: "host-offline" as const,
  message: "The selected workspace host is unavailable.",
};

function isMissingBbIdentity(error: unknown) {
  return error instanceof Error && /404|not found/i.test(error.message);
}

async function lookupThread(bb: BbPluginApi, threadId: string) {
  try {
    return await bb.sdk.threads.get({ threadId });
  } catch (error) {
    if (isMissingBbIdentity(error)) return null;
    throw error;
  }
}

async function lookupProject(bb: BbPluginApi, projectId: string) {
  try {
    const project = await bb.sdk.projects.get({ projectId });
    return {
      hostIds: [
        ...new Set(
          project.sources
            .map((source) => source.hostId)
            .filter((hostId): hostId is string => hostId !== undefined),
        ),
      ],
    };
  } catch (error) {
    if (isMissingBbIdentity(error)) return null;
    throw error;
  }
}

async function threadHostCandidates(
  bb: BbPluginApi,
  thread: { projectId: string; environmentId: string | null },
) {
  if (thread.environmentId === null) {
    const project = await lookupProject(bb, thread.projectId);
    return project?.hostIds ?? [];
  }
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return [environment.hostId];
}

async function sessionHostCandidates(
  bb: BbPluginApi,
  session: TrustedOwnerSession,
): Promise<SessionHosts> {
  if (session.kind === "compose") {
    return { hostIds: [], projectId: BROWSER_SETTINGS_PROJECT_ID };
  }
  if (session.kind === "thread") {
    const thread = await lookupThread(bb, session.threadId);
    if (thread === null) {
      return {
        outcome: "rejected",
        reason: "thread-mismatch",
        message: "The owner session thread was not found.",
      };
    }
    return {
      hostIds: await threadHostCandidates(bb, thread),
      projectId: thread.projectId,
    };
  }
  const project = await lookupProject(bb, session.projectId);
  if (project === null) {
    return {
      outcome: "rejected",
      reason: "project-mismatch",
      message: "The owner session project was not found.",
    };
  }
  return { hostIds: project.hostIds, projectId: session.projectId };
}

type HostCandidate =
  | { outcome: "resolved"; hostId: string }
  | PanelIdentityRejection
  | typeof HOST_UNAVAILABLE;

function hostFromCandidates(
  hostId: string,
  candidates: readonly string[],
  knownHostIds: readonly string[],
): HostCandidate {
  if (candidates.length === 0) {
    return knownHostIds.includes(hostId)
      ? { outcome: "resolved", hostId }
      : HOST_UNAVAILABLE;
  }
  if (!candidates.includes(hostId)) {
    return {
      outcome: "rejected",
      reason: "host-mismatch",
      message: "The selected workspace host does not match the owner session.",
    };
  }
  return { outcome: "resolved", hostId };
}

async function resolveTrustedHost(
  bb: BbPluginApi,
  request: { hostId: string; ownerSessionId: string },
): Promise<TrustedHostResolution> {
  const session = parseOwnerSessionId(request.ownerSessionId);
  if (session === null) {
    return {
      outcome: "rejected",
      reason: "owner-session-mismatch",
      message: "Owner session identity is not one production can issue.",
    };
  }
  const candidates = await sessionHostCandidates(bb, session);
  if ("outcome" in candidates) return candidates;
  const knownHostIds =
    candidates.hostIds.length === 0
      ? (await bb.sdk.hosts.list()).map((host) => host.id)
      : candidates.hostIds;
  const host = hostFromCandidates(
    request.hostId,
    candidates.hostIds,
    knownHostIds,
  );
  if (host.outcome !== "resolved") return host;
  return { ...host, projectId: candidates.projectId };
}

function ownerSessionIdFromPanelSurface(request: {
  surface: "thread" | "new-thread";
  threadId?: string;
  projectId?: string | null;
}) {
  if (request.surface === "thread") {
    return ownerSessionIdFromContext({
      projectId: null,
      threadId: request.threadId ?? null,
    });
  }
  return ownerSessionIdFromContext({
    projectId: request.projectId ?? null,
    threadId: null,
  });
}

function requireHostId(hostId: string | undefined) {
  if (hostId === undefined) throw new Error(HOST_UNAVAILABLE.message);
  return hostId;
}

function surfaceDispatchIdentity(request: {
  surface: "thread" | "new-thread";
  hostId?: string;
  threadId?: string;
  projectId?: string | null;
}) {
  return {
    hostId: requireHostId(request.hostId),
    ownerSessionId: ownerSessionIdFromPanelSurface(request),
  };
}

async function issuedCapability(
  tunnel: { label: string; baseDomain: string },
  transport: Extract<BrowserPanelTransportResponse, { outcome: "opened" }>,
): Promise<BrowserPanelCapabilityResponse> {
  return browserPanelCapabilityResponseSchema.parse({
    outcome: "issued",
    capabilityId: transport.capabilityId,
    secret: transport.secret,
    gatewayPort: transport.gatewayPort,
    tunnel: { label: tunnel.label, baseDomain: tunnel.baseDomain },
    expiresAt: transport.expiresAt,
    rotatesAt: transport.rotatesAt,
  });
}

/**
 * One typed server dispatch path for Browser Panel operations. It validates
 * public input, resolves trusted BB identity and the target workspace host
 * once, invokes one host command, and validates the response.
 */
export function createPanelLifecycleDispatch(
  bb: BbPluginApi,
  host: PanelDispatchHost,
) {
  const portSharing = createPanelPortSharing(bb);
  async function requireResolvedHost(request: {
    hostId: string;
    ownerSessionId: string;
  }): Promise<ResolvedHost | PanelIdentityRejection> {
    const identity = await resolveTrustedHost(bb, request);
    if (identity.outcome === "resolved" || identity.outcome === "rejected") {
      return identity;
    }
    throw new Error(identity.message);
  }

  async function dispatchHostCommand<T>(command: {
    request: { hostId: string; ownerSessionId: string };
    method: PanelDispatchMethod;
    body: (identity: ResolvedHost) => unknown;
    response: z.ZodType<T>;
    signal?: AbortSignal;
  }): Promise<T | PanelIdentityRejection> {
    const identity = await requireResolvedHost(command.request);
    if (identity.outcome !== "resolved") return identity;
    return command.response.parse(
      await host.call(command.method, command.body(identity), {
        hostId: identity.hostId,
        signal: command.signal,
      }),
    );
  }

  async function issueCapability(
    request: BrowserPanelCapabilityRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelCapabilityResponse> {
    const identity = await resolveTrustedHost(bb, request);
    if (identity.outcome !== "resolved") {
      return browserPanelCapabilityResponseSchema.parse(identity);
    }
    const transport = browserPanelTransportResponseSchema.parse(
      await host.call(
        "panelTransport",
        browserPanelTransportRequestSchema.parse({
          hostId: identity.hostId,
          profileId: request.profileId,
          panelId: request.panelId,
          ownerSessionId: request.ownerSessionId,
        }),
        { hostId: identity.hostId, signal },
      ),
    );
    if (transport.outcome !== "opened") {
      return browserPanelCapabilityResponseSchema.parse(transport);
    }
    const tunnel = await portSharing.expose(request, transport.gatewayPort);
    return issuedCapability(tunnel, transport);
  }

  async function setVisibility(
    request: BrowserPanelVisibilityRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelVisibilityResponse> {
    const identity = await resolveTrustedHost(bb, request);
    if (identity.outcome === "rejected") {
      return browserPanelVisibilityResponseSchema.parse(identity);
    }
    if (identity.outcome !== "resolved") {
      throw new Error(identity.message);
    }
    return browserPanelVisibilityResponseSchema.parse(
      await host.call(
        "panelVisibility",
        browserHostPanelVisibilityRequestSchema.parse({
          hostId: identity.hostId,
          profileId: request.profileId,
          panelId: request.panelId,
          visibility: request.visibility,
        }),
        { hostId: identity.hostId, signal },
      ),
    );
  }

  async function release(
    request: BrowserPanelReleaseRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelReleaseResponse> {
    const identity = await resolveTrustedHost(bb, request);
    if (identity.outcome !== "resolved") {
      return browserPanelReleaseResponseSchema.parse(identity);
    }
    const response = browserPanelReleaseResponseSchema.parse(
      await host.call(
        "panelRelease",
        browserPanelReleaseHostRequestSchema.parse({
          hostId: identity.hostId,
          profileId: request.profileId,
          panelId: request.panelId,
        }),
        { hostId: identity.hostId, signal },
      ),
    );
    await portSharing.release(request);
    return response;
  }

  async function navigate(
    request: BrowserPanelNavigationInput,
    signal?: AbortSignal,
  ): Promise<BrowserNavigationResponse | PanelIdentityRejection> {
    const parsed = browserPanelNavigationRequestSchema.parse(request);
    return dispatchHostCommand({
      request: surfaceDispatchIdentity(parsed),
      method: "navigate",
      body: (identity) =>
        browserNavigationRequestSchema.parse({
          hostId: identity.hostId,
          profileId: parsed.profileId,
          projectId: identity.projectId,
          input: parsed.input,
          rawLocalhost: parsed.rawLocalhost,
          ...(parsed.tabId === undefined ? {} : { tabId: parsed.tabId }),
          ...(parsed.panelId === undefined ? {} : { panelId: parsed.panelId }),
        }),
      response: browserNavigationResponseSchema,
      signal,
    });
  }

  async function history(
    request: BrowserPanelHistoryInput,
    signal?: AbortSignal,
  ): Promise<BrowserNavigationResponse | PanelIdentityRejection> {
    const parsed = browserPanelHistoryRequestSchema.parse(request);
    return dispatchHostCommand({
      request: surfaceDispatchIdentity(parsed),
      method: "history",
      body: (identity) =>
        browserHistoryRequestSchema.parse({
          hostId: identity.hostId,
          profileId: parsed.profileId,
          projectId: identity.projectId,
          direction: parsed.direction,
          ...(parsed.tabId === undefined ? {} : { tabId: parsed.tabId }),
          ...(parsed.panelId === undefined ? {} : { panelId: parsed.panelId }),
        }),
      response: browserNavigationResponseSchema,
      signal,
    });
  }

  async function tabAction(
    request: BrowserPanelTabActionInput,
    signal?: AbortSignal,
  ): Promise<BrowserTabStrip | PanelIdentityRejection> {
    const parsed = browserPanelTabActionRequestSchema.parse(request);
    return dispatchHostCommand({
      request: surfaceDispatchIdentity(parsed),
      method: "tabAction",
      body: (identity) =>
        browserTabActionRequestSchema.parse({
          hostId: identity.hostId,
          profileId: parsed.profileId,
          projectId: identity.projectId,
          action: parsed.action,
          ...(parsed.tabId === undefined ? {} : { tabId: parsed.tabId }),
          ...(parsed.panelId === undefined ? {} : { panelId: parsed.panelId }),
        }),
      response: browserTabStripSchema,
      signal,
    });
  }

  async function tabs(
    target: BrowserHostTarget,
    signal?: AbortSignal,
  ): Promise<BrowserTabStrip> {
    const parsed = browserHostTargetSchema.parse(target);
    const knownHostIds = (await bb.sdk.hosts.list()).map((host) => host.id);
    const identity = hostFromCandidates(parsed.hostId, [], knownHostIds);
    if (identity.outcome !== "resolved") {
      throw new Error(identity.message);
    }
    return browserTabStripSchema.parse(
      await host.call("tabs", parsed, { hostId: identity.hostId, signal }),
    );
  }

  async function dispatchControlCommand(
    method: "panelControl" | "takeControl" | "reclaimControl",
    request: BrowserPanelControlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelControlResponse | PanelIdentityRejection> {
    const parsed = browserPanelControlRequestSchema.parse(request);
    return dispatchHostCommand({
      request: parsed,
      method,
      body: (identity) =>
        browserPanelControlRequestSchema.parse({
          ...parsed,
          hostId: identity.hostId,
        }),
      response: browserPanelControlResponseSchema,
      signal,
    });
  }

  async function panelControl(
    request: BrowserPanelControlRequest,
    signal?: AbortSignal,
  ) {
    return dispatchControlCommand("panelControl", request, signal);
  }

  async function takeControl(
    request: BrowserPanelTakeControlRequest,
    signal?: AbortSignal,
  ) {
    return dispatchControlCommand("takeControl", request, signal);
  }

  async function reclaimControl(
    request: BrowserPanelReclaimControlRequest,
    signal?: AbortSignal,
  ) {
    return dispatchControlCommand("reclaimControl", request, signal);
  }

  async function releaseControl(
    request: BrowserPanelReleaseControlRequest,
    signal?: AbortSignal,
  ): Promise<BrowserPanelControlResponse | PanelIdentityRejection> {
    const parsed = browserPanelReleaseControlRequestSchema.parse(request);
    return dispatchHostCommand({
      request: parsed,
      method: "releaseControl",
      body: (identity) =>
        browserHostReleaseControlRequestSchema.parse({
          hostId: identity.hostId,
          profileId: parsed.profileId,
          panelId: parsed.panelId,
        }),
      response: browserPanelControlResponseSchema,
      signal,
    });
  }

  return {
    issueCapability,
    setVisibility,
    release,
    navigate,
    history,
    tabAction,
    tabs,
    panelControl,
    takeControl,
    reclaimControl,
    releaseControl,
  };
}
