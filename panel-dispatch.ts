import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  browserHostPanelVisibilityRequestSchema,
  browserPanelCapabilityResponseSchema,
  browserPanelReleaseHostRequestSchema,
  browserPanelReleaseResponseSchema,
  browserPanelTransportRequestSchema,
  browserPanelTransportResponseSchema,
  browserStatusSchema,
  type BrowserPanelCapabilityRequest,
  type BrowserPanelCapabilityResponse,
  type BrowserPanelReleaseRequest,
  type BrowserPanelReleaseResponse,
  type BrowserPanelTransportResponse,
  type BrowserPanelVisibilityRequest,
  type BrowserStatus,
  type PanelIdentityRejection,
} from "./contracts.js";
import {
  parseOwnerSessionId,
  type TrustedOwnerSession,
} from "./panel-owner-session.js";

type PanelDispatchHost = {
  call(
    method: "panelTransport" | "panelVisibility" | "panelRelease",
    request: unknown,
    options: { hostId: string; signal?: AbortSignal },
  ): Promise<unknown>;
};

type TrustedHostResolution =
  | { outcome: "resolved"; hostId: string }
  | PanelIdentityRejection
  | {
      outcome: "unavailable";
      reason: "host-offline";
      message: string;
    };

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
): Promise<TrustedHostResolution | string[]> {
  if (session.kind === "compose") return [];
  if (session.kind === "thread") {
    const thread = await lookupThread(bb, session.threadId);
    if (thread === null) {
      return {
        outcome: "rejected",
        reason: "thread-mismatch",
        message: "The owner session thread was not found.",
      };
    }
    return threadHostCandidates(bb, thread);
  }
  const project = await lookupProject(bb, session.projectId);
  if (project === null) {
    return {
      outcome: "rejected",
      reason: "project-mismatch",
      message: "The owner session project was not found.",
    };
  }
  return project.hostIds;
}

function hostFromCandidates(
  hostId: string,
  candidates: readonly string[],
  knownHostIds: readonly string[],
): TrustedHostResolution {
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
  if (!Array.isArray(candidates)) return candidates;
  const knownHostIds =
    candidates.length === 0
      ? (await bb.sdk.hosts.list()).map((host) => host.id)
      : candidates;
  return hostFromCandidates(request.hostId, candidates, knownHostIds);
}

async function issuedCapability(
  bb: BbPluginApi,
  hostId: string,
  transport: Extract<BrowserPanelTransportResponse, { outcome: "opened" }>,
): Promise<BrowserPanelCapabilityResponse> {
  const tunnel = await bb.hosts.ensureSharedPortTunnel(hostId);
  bb.hosts.declareSharedPorts(hostId, [transport.gatewayPort]);
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
 * One typed server dispatch path for Panel Capability issuance, visibility
 * changes, and explicit release. It resolves trusted BB identity and the
 * target workspace host once, then invokes one host command.
 */
export function createPanelLifecycleDispatch(
  bb: BbPluginApi,
  host: PanelDispatchHost,
) {
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
    return issuedCapability(bb, identity.hostId, transport);
  }

  async function setVisibility(
    request: BrowserPanelVisibilityRequest,
    signal?: AbortSignal,
  ): Promise<BrowserStatus> {
    const identity = await resolveTrustedHost(bb, request);
    if (identity.outcome !== "resolved") {
      throw new Error(identity.message);
    }
    return browserStatusSchema.parse(
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
    return browserPanelReleaseResponseSchema.parse(
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
  }

  return { issueCapability, setVisibility, release };
}
