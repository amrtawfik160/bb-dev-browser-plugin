import type {
  JsonValue,
  PluginCliExecutionResult,
  PluginCliContext,
  PluginNewThreadPanelProps,
  PluginSettingsSectionProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { act, within } from "@testing-library/react";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import {
  loadPluginApp,
  renderSlot,
  type RenderedSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import {
  browserActivityRecordsSchema,
  browserActivityAcknowledgementRequestSchema,
  browserActivityClearResponseSchema,
  browserActivityExportSchema,
  browserActivityOutboxRequestSchema,
  browserActivityReconciliationRequestSchema,
  browserDiagnosticsSchema,
  browserLifecycleRequestSchema,
  browserLifecycleResponseSchema,
  browserNavigationRequestSchema,
  browserHistoryRequestSchema,
  browserNavigationResponseSchema,
  browserPanelVisibilityRequestSchema,
  browserPanelTransportRequestSchema,
  browserPanelControlRequestSchema,
  browserPanelReleaseControlRequestSchema,
  browserPurgeRequestSchema,
  browserScriptRequestSchema,
  browserSetupRequestSchema,
  browserHostTargetSchema,
  browserTabActionRequestSchema,
  browserTabStripSchema,
  browserHostConnectionRequestSchema,
  browserPurgePlanSchema,
  browserPurgeResponseSchema,
  browserProfileCreateRequestSchema,
  browserProfileDeleteRequestSchema,
  browserProfileBackupRequestSchema,
  browserProfileHostTargetSchema,
  browserProfileImportRequestSchema,
  browserProfileInventorySchema,
  browserProfileLifecycleResponseSchema,
  browserProfileRenameRequestSchema,
  browserProfileResetRequestSchema,
  browserProfileRecoveryResponseSchema,
  browserProfileRestoreRequestSchema,
  browserProfileSchema,
  browserProfileSelectRequestSchema,
  browserProfileTargetSchema,
  browserProfileGrantCreateRequestSchema,
  browserProfileGrantQuerySchema,
  browserProfileGrantRevokeRequestSchema,
  type BrowserPanelNavigationInput,
  type BrowserPanelHistoryInput,
  type BrowserPanelTabActionInput,
  type BrowserPanelCapabilityResponse,
  type BrowserPanelControlResponse,
  type BrowserNavigationRequest,
  type BrowserHistoryRequest,
  browserProfileGrantRevokeResponseSchema,
  browserProfileGrantSchema,
  browserProfileGrantsSchema,
  browserGrantRequestDecisionRequestSchema,
  browserGrantRequestDecisionResponseSchema,
  browserGrantRequestQuerySchema,
  browserGrantRequestSchema,
  browserGrantRequestsSchema,
  browserHostChoicesSchema,
  browserSetupPlanSchema,
  browserSetupResponseSchema,
  browserTransferStagingResponseSchema,
  browserTransferOutcomeSchema,
  browserTransferReleaseOutcomeSchema,
  browserTransferReleaseInputSchema,
  browserTransferCancelOutcomeSchema,
  browserTransferCancelInputSchema,
  browserTransferProgressResultSchema,
  browserTransferProgressInputSchema,
  browserTransferStageInputSchema,
  browserTransferConsumeInputSchema,
  browserControlLeaseStateSchema,
  browserControlLeaseStateInputSchema,
  browserFileTransferDecisionSchema,
  browserDownloadStartResponseSchema,
  browserDownloadAppendOutcomeSchema,
  browserDownloadCompleteOutcomeSchema,
  browserDownloadCancelOutcomeSchema,
  browserDownloadListResultSchema,
  browserDownloadLimitsSchema,
  browserDownloadProgressResultSchema,
  browserDownloadExportOutcomeSchema,
  browserDownloadPurgeOutcomeSchema,
  browserDownloadFailOutcomeSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserStatus,
  type BrowserHostChoicesInput,
  type BrowserGrantRequest,
  type BrowserStatusInput,
  type rpcContract,
  type BrowserScriptResponse,
} from "../contracts.js";
import { createBrowserHostEntry, type HostSetupBoundary } from "../host.js";
import type {
  BrowserInstanceRuntime,
  RuntimeBrowserPage,
} from "../browser-runtime.js";
import {
  createHostAdministrationBoundary,
  type HostAdministrationStateStore,
  type PrivilegedExecutor,
} from "../host-operations.js";
import {
  createFileBrowserProfileStore,
  type BrowserProfileStore,
} from "../profile-storage.js";
import {
  createFileBrowserProfileRecovery,
  type BrowserProfileRecovery,
} from "../profile-recovery.js";
import {
  createHostReadinessBoundary,
  type HostProbeSnapshot,
} from "../readiness.js";
import plugin from "../server.js";

const HOST_ID = "host-browser-test";
const PROJECT_ID = "project-browser-test";
const THREAD_ID = "thread-browser-test";
const ENVIRONMENT_ID = "environment-browser-test";
const persistedGrantRequestEventSchema = z.object({
  request_id: z.string(),
  event_type: z.string(),
  event_at: z.string(),
});

type PublicToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
type PublicToolReply = {
  content: [{ type: "text"; text: string }, ...PublicToolContent[]];
  isError?: boolean;
};
type PublicToolFailure = {
  content: PublicToolReply["content"];
  isError: true;
};

type OpenedPanel = {
  created: boolean;
  layout: "flush" | "padded";
  params: JsonValue | null;
  panel: RenderedSlot;
};

type HostConnectionStatus = "connected" | "disconnected";
type HostConnectionChange = "host-connected" | "host-disconnected";
type HostConnectionEvent = {
  type: "changed";
  entity: "host";
  id: string;
  changes: readonly HostConnectionChange[];
};
type HostConnectionListener = (
  event: HostConnectionEvent,
) => void | Promise<void>;
type ProjectChange = "project-created" | "project-deleted";
type ProjectChangeEvent = {
  type: "changed";
  entity: "project";
  id?: string;
  changes: readonly ProjectChange[];
};
type ProjectChangeListener = (
  event: ProjectChangeEvent,
) => void | Promise<void>;

function projectFixture(hostIds: readonly string[] = [HOST_ID]) {
  return {
    id: PROJECT_ID,
    name: "Browser contract project",
    kind: "standard" as const,
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: hostIds.map((hostId, index) => ({
      id: `source-browser-test-${hostId}`,
      projectId: PROJECT_ID,
      hostId,
      path: `/workspace/browser-contract-${index}`,
      type: "local_path" as const,
      isDefault: hostIds.length === 1 && index === 0,
      createdAt: 1,
      updatedAt: 1,
    })),
  };
}

function environmentFixture(hostId = HOST_ID) {
  return {
    id: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    hostId,
    name: "Browser contract environment",
    path: "/workspace/browser-contract",
    status: "ready" as const,
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    branchName: "main",
    defaultBranch: "main",
    baseBranch: null,
    mergeBaseBranch: null,
    workspaceProvisionType: "unmanaged" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

function hostFixture(
  hostId = HOST_ID,
  status: "connected" | "disconnected" = "connected",
) {
  return {
    id: hostId,
    name: `Browser contract host ${hostId}`,
    type: "persistent" as const,
    status,
    maxPermissionMode: "full" as const,
    lastSeenAt: 1,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function panelKey(actionId: string, params: unknown) {
  return `${actionId}:${JSON.stringify(params)}`;
}

/**
 * A runtime that keeps a page inventory, so tab actions can be asserted
 * against what the instance actually holds rather than against a canned
 * answer: opening adds a page, closing removes it, listing reports what is
 * left, and pinning records the panels that woke the instance.
 */
export function createTabInventoryRuntime(): BrowserInstanceRuntime & {
  readonly pinnedPanelIds: readonly string[];
} {
  const pages: RuntimeBrowserPage[] = [];
  const pinnedPanelIds: string[] = [];
  let opened = 0;
  const instance = (target: { hostId: string; profileId: string }) => ({
    state: "running" as const,
    hostId: target.hostId,
    profileId: target.profileId,
    pid: 1,
    browser: "chrome-stable" as const,
    automationEndpoint: "http://127.0.0.1:9222",
  });
  return {
    get pinnedPanelIds() {
      return [...pinnedPanelIds];
    },
    start: async (target) => instance(target),
    stop: async () => undefined,
    execute: async () => "",
    navigate: async (target, input) => ({
      address: { kind: "address" as const, url: input },
      location: { url: input },
      tabId: target.tabId ?? pages[0]?.id ?? "inventory-tab",
    }),
    history: async (target, direction) => ({
      address: { kind: "address" as const, url: "about:blank" },
      location: { direction },
      tabId: target.tabId ?? pages[0]?.id ?? "inventory-tab",
    }),
    openPage: async () => {
      opened += 1;
      const page: RuntimeBrowserPage = {
        id: `tab-opened-${opened}`,
        url: "about:blank",
        title: "",
        openerTabId: null,
      };
      pages.push(page);
      return page;
    },
    focusPage: async () => undefined,
    closePages: async (_target, tabIds) => {
      const remaining = pages.filter((page) => !tabIds.includes(page.id));
      const closed = pages.length - remaining.length;
      pages.splice(0, pages.length, ...remaining);
      return closed;
    },
    listPages: async () => [...pages],
    status: async (target) => ({
      state: "running" as const,
      hostId: target.hostId,
      profileId: target.profileId,
    }),
    pinPanel: async (target, panelId) => {
      pinnedPanelIds.push(panelId);
      return instance(target);
    },
    unpinPanel: async () => undefined,
    activeTabId: async () => pages[0]?.id ?? "inventory-tab",
    checkRendererProcessLimit: async () => undefined,
    hostDisconnected: () => undefined,
    hostReconnected: async () => undefined,
    dispose: async () => undefined,
  };
}

/**
 * A host that passes every readiness capability, so the panel renders the
 * browser rather than a setup surface. Shared by every suite that needs a
 * healthy host: the readiness snapshot and this status must agree, and one
 * definition keeps them from drifting apart.
 */
export const healthyBrowserStatus: BrowserStatus = {
  hostId: HOST_ID,
  profileId: DEFAULT_PROFILE_ID,
  state: "healthy",
  code: "healthy",
  label: "Ready",
  message: "Workspace Browser is ready on this host.",
  capabilities: (
    [
      ["operating-system", "Operating system", "Ubuntu 24.04 is supported."],
      ["architecture", "Architecture", "x86_64 is supported."],
      ["bb-connect", "BB Connect", "The host is enrolled in BB Connect."],
      ["browser", "Browser", "Google Chrome 140 is available."],
      ["sandbox", "Browser sandbox", "The Chrome sandbox is available."],
      ["dedicated-user", "Dedicated browser user", "bb-browser is configured."],
      ["protected-storage", "Protected storage", "Storage is protected."],
      ["disk-headroom", "Disk headroom", "At least 5 GiB is free."],
      ["loopback", "Loopback networking", "Loopback is available."],
    ] as const
  ).map(([id, label, reason]) => ({
    id: id as BrowserStatus["capabilities"][number]["id"],
    label,
    status: "ready" as const,
    reason,
  })),
};

export async function createPublicPluginHarness(options?: {
  hostId?: string;
  status?: BrowserStatus;
  hostConnection?: HostConnectionStatus;
  browserScriptResponse?: BrowserScriptResponse;
  browserRuntime?: BrowserInstanceRuntime;
  safeLoginMode?: import("../safe-login.js").SafeLoginModeManager;
  browserScriptDelayMs?: number;
  browserScriptStarted?: () => void;
  navigationResponse?: {
    address: { kind: "address"; url: string };
    location: unknown;
    tabId: string;
  };
  hostIds?: readonly string[];
  projectHostIds?: readonly string[];
  environmentlessThread?: boolean;
  probeFailure?: boolean;
  /** Fail this many readiness probes, then answer normally. */
  probeFailuresBeforeReady?: number;
  snapshot?: HostProbeSnapshot;
  privilegedExecutor?: PrivilegedExecutor;
  administrationStateStore?: HostAdministrationStateStore;
  profileStore?: BrowserProfileStore;
  profileRecovery?: BrowserProfileRecovery;
  deferProjectLookup?: boolean;
  deferProfileInventory?: boolean;
  deferProfileInventoryAfterCalls?: number;
  deferProfileSelection?: boolean;
  deferGrantRequestRpc?: (
    requests: BrowserGrantRequest[],
    callIndex: number,
  ) => Promise<BrowserGrantRequest[]>;
}) {
  const configuredHostId = options?.hostId ?? HOST_ID;
  const configuredProjectHostIds = options?.projectHostIds ?? [
    configuredHostId,
  ];
  let hostConnectionStatus: HostConnectionStatus =
    options?.hostConnection ?? "connected";
  const hostConnectionListeners: HostConnectionListener[] = [];
  const projectChangeListeners: ProjectChangeListener[] = [];
  let resolveProjectLookupStarted: (() => void) | undefined;
  let releaseProjectLookupGate: (() => void) | undefined;
  const projectLookupStarted =
    options?.deferProjectLookup === true
      ? new Promise<void>((resolve) => {
          resolveProjectLookupStarted = resolve;
        })
      : Promise.resolve();
  const projectLookupGate =
    options?.deferProjectLookup === true
      ? new Promise<void>((resolve) => {
          releaseProjectLookupGate = resolve;
        })
      : Promise.resolve();
  let resolveProfileInventoryStarted: (() => void) | undefined;
  let releaseProfileInventoryGate: (() => void) | undefined;
  const profileInventoryStarted =
    options?.deferProfileInventory === true
      ? new Promise<void>((resolve) => {
          resolveProfileInventoryStarted = resolve;
        })
      : Promise.resolve();
  const profileInventoryGate =
    options?.deferProfileInventory === true
      ? new Promise<void>((resolve) => {
          releaseProfileInventoryGate = resolve;
        })
      : Promise.resolve();
  let profileInventoryDeferred = false;
  let profileInventoryCalls = 0;
  let resolveProfileSelectionStarted: (() => void) | undefined;
  let releaseProfileSelectionGate: (() => void) | undefined;
  const profileSelectionStarted =
    options?.deferProfileSelection === true
      ? new Promise<void>((resolve) => {
          resolveProfileSelectionStarted = resolve;
        })
      : Promise.resolve();
  const profileSelectionGate =
    options?.deferProfileSelection === true
      ? new Promise<void>((resolve) => {
          releaseProfileSelectionGate = resolve;
        })
      : Promise.resolve();
  const hostRpcFailures = new Map<string, string>();
  const hostConnectionRequests: z.output<
    typeof browserHostConnectionRequestSchema
  >[] = [];
  const setupInspectionTargets: BrowserHostTarget[] = [];
  const expectedStatus =
    options?.status ??
    setupRequiredStatus({
      hostId: configuredHostId,
      profileId: DEFAULT_PROFILE_ID,
    });
  const fixtureBoundary: HostSetupBoundary =
    options?.snapshot === undefined
      ? {
          inspect: (target) => ({
            ...expectedStatus,
            hostId: target.hostId,
            profileId: target.profileId,
          }),
          diagnostics: (target) => ({
            hostId: target.hostId,
            profileId: target.profileId,
            generatedAt: "2026-08-27T00:00:00.000Z",
            readiness: {
              ...expectedStatus,
              hostId: target.hostId,
              profileId: target.profileId,
            },
            dependencies: [],
            processes: [],
            resourceUse: {
              diskFreeBytes: 0,
              diskTotalBytes: 0,
              workerRssBytes: 0,
            },
            exitLogs: [],
          }),
        }
      : createHostReadinessBoundary({
          snapshot: async () => options.snapshot!,
        });
  let remainingProbeFailures = options?.probeFailuresBeforeReady ?? 0;
  const setupBoundary: HostSetupBoundary = {
    inspect: (target) => {
      setupInspectionTargets.push(target);
      if (options?.probeFailure === true) {
        throw new Error("retained worker probe failed");
      }
      if (remainingProbeFailures > 0) {
        remainingProbeFailures -= 1;
        throw new Error("retained worker is still starting");
      }
      return fixtureBoundary.inspect(target);
    },
    diagnostics: (target) => {
      if (options?.probeFailure === true) {
        throw new Error("retained worker diagnostics failed");
      }
      return fixtureBoundary.diagnostics(target);
    },
  };
  const hostBoundary =
    options?.privilegedExecutor === undefined
      ? setupBoundary
      : createHostAdministrationBoundary({
          readiness: setupBoundary,
          installationId: "installation-public-test",
          executor: options.privilegedExecutor,
          stateStore: options.administrationStateStore,
        });
  const profileStorageRoot =
    options?.profileStore === undefined
      ? await mkdtemp(join(tmpdir(), "bb-browser-plugin-"))
      : null;
  const profileRecoveryRoot =
    options?.profileRecovery === undefined && profileStorageRoot === null
      ? await mkdtemp(join(tmpdir(), "bb-browser-recovery-plugin-"))
      : profileStorageRoot;
  const profileStore =
    options?.profileStore ??
    createFileBrowserProfileStore({
      rootDirectory: profileStorageRoot!,
      installationId: "installation-public-test",
      lifecycle: { stopProfile: async () => undefined },
    });
  const profileRecovery =
    options?.profileRecovery ??
    createFileBrowserProfileRecovery({
      rootDirectory: profileRecoveryRoot!,
      installationId: "installation-public-test",
      state: {
        isProfileStopped: async () => true,
        isDevBrowserProfileStopped: async () => true,
      },
    });
  const hostDataRoot = await mkdtemp(join(tmpdir(), "bb-browser-host-"));
  const host = experimental_createHostEntryHarness(
    createBrowserHostEntry(
      hostBoundary,
      profileStore,
      profileRecovery,
      options?.browserRuntime,
      options?.safeLoginMode,
    ),
    {
      experimental_paths: {
        dataDir: hostDataRoot,
        tempDir: join(hostDataRoot, "tmp"),
      },
    },
  );
  const backend = createFakePluginHost({
    pluginId: "browser",
    agentSkillIds: ["browser"],
    sharedPortTunnelIdentities: {
      [configuredHostId]: { label: "ci-gate", baseDomain: "ci.getbb.app" },
    },
    sdk: {
      subscribe: (args) => {
        if (args.event === "project:changed") {
          const listener = args.callback as ProjectChangeListener;
          projectChangeListeners.push(listener);
          return () => {
            const index = projectChangeListeners.indexOf(listener);
            if (index >= 0) projectChangeListeners.splice(index, 1);
          };
        }
        if (args.event !== "host:changed") {
          throw new Error(
            "public harness only supports host and project changes",
          );
        }
        const listener = args.callback as HostConnectionListener;
        hostConnectionListeners.push(listener);
        return () => {
          const index = hostConnectionListeners.indexOf(listener);
          if (index >= 0) hostConnectionListeners.splice(index, 1);
        };
      },
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId:
              threadId === "thread-foreign-project"
                ? "project-foreign"
                : PROJECT_ID,
            environmentId:
              options?.environmentlessThread === true ? null : ENVIRONMENT_ID,
          }),
      },
      environments: {
        get: async () =>
          environmentFixture(configuredProjectHostIds[0] ?? configuredHostId),
      },
      hosts: {
        list: async () =>
          (options?.hostIds ?? [configuredHostId]).map((hostId) =>
            hostFixture(hostId, hostConnectionStatus),
          ),
      },
      projects: {
        get: async () => {
          resolveProjectLookupStarted?.();
          await projectLookupGate;
          return projectFixture(configuredProjectHostIds);
        },
      },
    },
    experimental_callHostRpc: async ({ method, input, signal }) => {
      const failure = hostRpcFailures.get(method);
      if (failure !== undefined) throw new Error(failure);
      if (method === "browserScript") options?.browserScriptStarted?.();
      if (method === "hostConnection") {
        const request = browserHostConnectionRequestSchema.parse(input);
        hostConnectionRequests.push(request);
        return host.experimental_call("hostConnection", request, { signal });
      }
      if (
        method === "browserScript" &&
        options?.browserScriptResponse !== undefined
      ) {
        return options.browserScriptResponse;
      }
      if (method === "status") {
        return host.experimental_call(
          "status",
          browserHostTargetSchema.parse(input),
          {
            signal,
          },
        );
      }
      if (method === "panelVisibility") {
        return host.experimental_call(
          "panelVisibility",
          browserPanelVisibilityRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "panelTransport") {
        return host.experimental_call(
          "panelTransport",
          browserPanelTransportRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "tabs") {
        return host.experimental_call(
          "tabs",
          browserHostTargetSchema.parse(input),
          { signal },
        );
      }
      if (
        method === "panelControl" ||
        method === "takeControl" ||
        method === "reclaimControl"
      ) {
        return host.experimental_call(
          method,
          browserPanelControlRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "releaseControl") {
        return host.experimental_call(
          "releaseControl",
          browserPanelReleaseControlRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "diagnostics") {
        return host.experimental_call(
          "diagnostics",
          browserHostTargetSchema.parse(input),
          { signal },
        );
      }
      if (method === "setupPlan") {
        return host.experimental_call(
          "setupPlan",
          browserHostTargetSchema.parse(input),
          { signal },
        );
      }
      if (method === "setup") {
        return host.experimental_call(
          "setup",
          browserSetupRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "disable" || method === "uninstall") {
        return host.experimental_call(
          method,
          browserLifecycleRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "purgePlan") {
        return host.experimental_call(
          "purgePlan",
          browserHostTargetSchema.parse(input),
          { signal },
        );
      }
      if (method === "purge") {
        return host.experimental_call(
          "purge",
          browserPurgeRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "browserScript") {
        if (options?.browserScriptDelayMs !== undefined) {
          const scriptSignal = signal ?? new AbortController().signal;
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              clearTimeout(timer);
              scriptSignal.removeEventListener("abort", abort);
              resolve();
            };
            const abort = () => {
              clearTimeout(timer);
              scriptSignal.removeEventListener("abort", abort);
              reject(new Error("browser script aborted"));
            };
            const timer = setTimeout(finish, options.browserScriptDelayMs);
            if (scriptSignal.aborted) {
              abort();
              return;
            }
            scriptSignal.addEventListener("abort", abort, { once: true });
          });
        }
        return host.experimental_call(
          "browserScript",
          browserScriptRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "navigate") {
        const request = browserNavigationRequestSchema.parse(input);
        navigationRequests.push(request);
        if (options?.navigationResponse !== undefined) {
          return options.navigationResponse;
        }
        return host.experimental_call("navigate", request, { signal });
      }
      if (method === "history") {
        const request = browserHistoryRequestSchema.parse(input);
        historyRequests.push(request);
        if (options?.navigationResponse !== undefined) {
          return options.navigationResponse;
        }
        return host.experimental_call("history", request, { signal });
      }
      if (method === "tabAction") {
        const request = browserTabActionRequestSchema.parse(input);
        return host.experimental_call("tabAction", request, { signal });
      }
      if (method === "activityOutbox") {
        return host.experimental_call(
          "activityOutbox",
          browserActivityOutboxRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "acknowledgeActivity") {
        return host.experimental_call(
          "acknowledgeActivity",
          browserActivityAcknowledgementRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "reconcileActivity") {
        return host.experimental_call(
          "reconcileActivity",
          browserActivityReconciliationRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "listProfiles") {
        const inventory = await host.experimental_call(
          "listProfiles",
          browserProfileHostTargetSchema.parse(input),
          { signal },
        );
        profileInventoryCalls += 1;
        const deferAfterCalls = options?.deferProfileInventoryAfterCalls ?? 0;
        if (
          options?.deferProfileInventory === true &&
          !profileInventoryDeferred &&
          profileInventoryCalls > deferAfterCalls
        ) {
          profileInventoryDeferred = true;
          resolveProfileInventoryStarted?.();
          await profileInventoryGate;
        }
        return inventory;
      }
      if (method === "createProfile") {
        return host.experimental_call(
          "createProfile",
          browserProfileCreateRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "renameProfile") {
        return host.experimental_call(
          "renameProfile",
          browserProfileRenameRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "selectProfile") {
        const inventory = await host.experimental_call(
          "selectProfile",
          browserProfileSelectRequestSchema.parse(input),
          { signal },
        );
        if (options?.deferProfileSelection === true) {
          resolveProfileSelectionStarted?.();
          await profileSelectionGate;
        }
        return inventory;
      }
      if (method === "archiveProfile" || method === "restoreArchivedProfile") {
        return host.experimental_call(
          method,
          browserProfileTargetSchema.parse(input),
          { signal },
        );
      }
      if (method === "resetProfile") {
        return host.experimental_call(
          method,
          browserProfileResetRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "deleteProfile") {
        return host.experimental_call(
          method,
          browserProfileDeleteRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "backupProfile") {
        return host.experimental_call(
          "backupProfile",
          browserProfileBackupRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "restoreProfile") {
        return host.experimental_call(
          "restoreProfile",
          browserProfileRestoreRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "importProfile") {
        return host.experimental_call(
          "importProfile",
          browserProfileImportRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "transferStage") {
        return host.experimental_call(
          "transferStage",
          browserTransferStageInputSchema.parse(input),
          { signal },
        );
      }
      if (method === "transferConsume") {
        return host.experimental_call(
          "transferConsume",
          browserTransferConsumeInputSchema.parse(input),
          { signal },
        );
      }
      if (method === "transferRelease") {
        return host.experimental_call(
          "transferRelease",
          browserTransferReleaseInputSchema.parse(input),
          { signal },
        );
      }
      if (method === "transferCancel") {
        return host.experimental_call(
          "transferCancel",
          browserTransferCancelInputSchema.parse(input),
          { signal },
        );
      }
      if (method === "transferProgress") {
        return host.experimental_call(
          "transferProgress",
          browserTransferProgressInputSchema.parse(input),
          { signal },
        );
      }
      if (method === "controlLeaseState") {
        return host.experimental_call(
          "controlLeaseState",
          browserControlLeaseStateInputSchema.parse(input),
          { signal },
        );
      }
      if (
        method === "downloadStart" ||
        method === "downloadAppend" ||
        method === "downloadComplete" ||
        method === "downloadList" ||
        method === "downloadExportClient"
      ) {
        // Host Downloads run against the real host boundary so quarantine,
        // limits, and export behave the way they do on a workspace host.
        return host.experimental_call(method, input as never, {
          signal,
        }) as Promise<unknown>;
      }
      throw new Error(`Unexpected host method: ${method}`);
    },
  });
  await plugin(backend.bb);
  const app = await loadPluginApp(() => import("../app.js"));
  const threadPanels = new Map<string, RenderedSlot>();
  const newThreadPanels = new Map<string, RenderedSlot>();
  const settingsPanels: RenderedSlot[] = [];
  const renderedPanels: RenderedSlot[] = [];
  let grantRequestRpcCallIndex = 0;
  const navigationRequests: BrowserNavigationRequest[] = [];
  const historyRequests: BrowserHistoryRequest[] = [];
  const panelCapabilityRequests: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
  }[] = [];

  const rpc = {
    browser_status: (input: BrowserStatusInput) =>
      backend.harness.behavior.callRpc(
        "browser_status",
        input,
      ) as Promise<BrowserStatus>,
    browser_navigate: (input: BrowserPanelNavigationInput) =>
      backend.harness.behavior.callRpc("browser_navigate", input) as Promise<
        ReturnType<typeof browserNavigationResponseSchema.parse>
      >,
    browser_history: (input: BrowserPanelHistoryInput) =>
      backend.harness.behavior.callRpc("browser_history", input) as Promise<
        ReturnType<typeof browserNavigationResponseSchema.parse>
      >,
    browser_panel_visibility: (input: {
      hostId: string;
      profileId: string;
      panelId: string;
      visibility: "visible" | "hidden";
    }) =>
      backend.harness.behavior.callRpc(
        "browser_panel_visibility",
        input,
      ) as Promise<BrowserStatus>,
    browser_panel_capability: (input: {
      hostId: string;
      profileId: string;
      panelId: string;
      ownerSessionId: string;
    }) => {
      panelCapabilityRequests.push(input);
      return backend.harness.behavior.callRpc(
        "browser_panel_capability",
        input,
      ) as Promise<BrowserPanelCapabilityResponse>;
    },
    browser_tabs: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc("browser_tabs", input) as Promise<
        ReturnType<typeof browserTabStripSchema.parse>
      >,
    browser_tab_action: (input: BrowserPanelTabActionInput) =>
      backend.harness.behavior.callRpc("browser_tab_action", input) as Promise<
        ReturnType<typeof browserTabStripSchema.parse>
      >,
    browser_panel_control: (input: {
      hostId: string;
      profileId: string;
      panelId: string;
      ownerSessionId: string;
      viewport?: { width: number; height: number };
    }) =>
      backend.harness.behavior.callRpc(
        "browser_panel_control",
        input,
      ) as Promise<BrowserPanelControlResponse>,
    browser_panel_take_control: (input: {
      hostId: string;
      profileId: string;
      panelId: string;
      ownerSessionId: string;
      viewport?: { width: number; height: number };
    }) =>
      backend.harness.behavior.callRpc(
        "browser_panel_take_control",
        input,
      ) as Promise<BrowserPanelControlResponse>,
    browser_panel_release_control: (input: {
      hostId: string;
      profileId: string;
      panelId: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_panel_release_control",
        input,
      ) as Promise<BrowserPanelControlResponse>,
    browser_panel_reclaim_control: (input: {
      hostId: string;
      profileId: string;
      panelId: string;
      ownerSessionId: string;
      viewport?: { width: number; height: number };
    }) =>
      backend.harness.behavior.callRpc(
        "browser_panel_reclaim_control",
        input,
      ) as Promise<BrowserPanelControlResponse>,
    browser_settings_status: (input: { profileId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_settings_status",
        input,
      ) as Promise<BrowserStatus[]>,
    browser_diagnostics: (input: {
      hostId: string | null;
      profileId: string;
    }) =>
      backend.harness.behavior.callRpc("browser_diagnostics", input) as Promise<
        ReturnType<typeof browserDiagnosticsSchema.parse>
      >,
    browser_activity_records: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_activity_records",
        input,
      ) as Promise<ReturnType<typeof browserActivityRecordsSchema.parse>>,
    browser_activity_export: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_activity_export",
        input,
      ) as Promise<ReturnType<typeof browserActivityExportSchema.parse>>,
    browser_activity_clear: (input: {
      hostId: string;
      profileId: string;
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_activity_clear",
        input,
      ) as Promise<ReturnType<typeof browserActivityClearResponseSchema.parse>>,
    browser_setup_plan: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc("browser_setup_plan", input) as Promise<
        ReturnType<typeof browserSetupPlanSchema.parse>
      >,
    browser_setup: (input: {
      hostId: string;
      profileId: string;
      stepId: "dedicated-user" | "system-packages" | "protected-storage";
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc("browser_setup", input) as Promise<
        ReturnType<typeof browserSetupResponseSchema.parse>
      >,
    browser_disable: (input: {
      hostId: string;
      profileId: string;
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc("browser_disable", input) as Promise<
        ReturnType<typeof browserLifecycleResponseSchema.parse>
      >,
    browser_uninstall: (input: {
      hostId: string;
      profileId: string;
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc("browser_uninstall", input) as Promise<
        ReturnType<typeof browserLifecycleResponseSchema.parse>
      >,
    browser_purge_plan: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc("browser_purge_plan", input) as Promise<
        ReturnType<typeof browserPurgePlanSchema.parse>
      >,
    browser_purge: (input: {
      hostId: string;
      profileId: string;
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc("browser_purge", input) as Promise<
        ReturnType<typeof browserPurgeResponseSchema.parse>
      >,
    browser_profiles: (input: {
      hostId: string;
      projectId?: string | null;
      threadId?: string;
    }) =>
      backend.harness.behavior.callRpc("browser_profiles", input) as Promise<
        ReturnType<typeof browserProfileInventorySchema.parse>
      >,
    browser_grants: (input: {
      grantId?: string;
      projectId?: string;
      hostId?: string;
      installationId?: string;
      profileId?: string;
      includeRevoked?: boolean;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_grants",
        browserProfileGrantQuerySchema.parse(input),
      ) as Promise<ReturnType<typeof browserProfileGrantsSchema.parse>>,
    browser_grant_create: (input: {
      projectId: string;
      hostId: string;
      profileId: string;
      installationId?: string;
      originScope: string;
      wholeWeb?: boolean;
      fileTransfer?: boolean;
      invalidCertificateOrigins?: string[];
      persistentElevations?: boolean;
      persistenceConfirmation?: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_grant_create",
        browserProfileGrantCreateRequestSchema.parse(input),
      ) as Promise<ReturnType<typeof browserProfileGrantSchema.parse>>,
    browser_grant_inspect: (input: { grantId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_grant_inspect",
        input,
      ) as Promise<ReturnType<typeof browserProfileGrantSchema.parse> | null>,
    browser_grant_revoke: (input: { grantId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_grant_revoke",
        browserProfileGrantRevokeRequestSchema.parse(input),
      ) as Promise<
        ReturnType<typeof browserProfileGrantRevokeResponseSchema.parse>
      >,
    browser_grant_requests: async (input: {
      requestId?: string;
      projectId?: string;
      hostId?: string;
      installationId?: string;
      profileId?: string;
      status?:
        "pending" | "denied" | "approved" | "consumed" | "expired" | "revoked";
    }) => {
      const requests = (await backend.harness.behavior.callRpc(
        "browser_grant_requests",
        browserGrantRequestQuerySchema.parse(input),
      )) as ReturnType<typeof browserGrantRequestsSchema.parse>;
      const callIndex = grantRequestRpcCallIndex++;
      return options?.deferGrantRequestRpc === undefined
        ? requests
        : options.deferGrantRequestRpc(requests, callIndex);
    },
    browser_grant_request_inspect: (input: { requestId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_grant_request_inspect",
        input,
      ) as Promise<ReturnType<typeof browserGrantRequestSchema.parse> | null>,
    browser_grant_request_decide: (input: {
      requestId: string;
      decision?: "deny" | "retry" | "one-hour" | "persist";
      persistenceConfirmation?: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_grant_request_decide",
        browserGrantRequestDecisionRequestSchema.parse(input),
      ) as Promise<
        ReturnType<typeof browserGrantRequestDecisionResponseSchema.parse>
      >,
    browser_grant_request_revoke: (input: { requestId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_grant_request_revoke",
        input,
      ) as Promise<
        ReturnType<typeof browserGrantRequestDecisionResponseSchema.parse>
      >,
    browser_profile_create: (input: {
      hostId: string;
      name: string;
      locale?: string;
      timezone?: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_create",
        input,
      ) as Promise<ReturnType<typeof browserProfileSchema.parse>>,
    browser_profile_rename: (input: {
      hostId: string;
      profileId: string;
      name: string;
      locale?: string;
      timezone?: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_rename",
        input,
      ) as Promise<ReturnType<typeof browserProfileSchema.parse>>,
    browser_profile_select: (input: {
      hostId: string;
      profileId: string;
      projectId?: string | null;
      threadId?: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_select",
        input,
      ) as Promise<ReturnType<typeof browserProfileInventorySchema.parse>>,
    browser_profile_archive: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_archive",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileLifecycleResponseSchema.parse>
      >,
    browser_profile_restore_archived: (input: {
      hostId: string;
      profileId: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_restore_archived",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileLifecycleResponseSchema.parse>
      >,
    browser_profile_reset: (input: {
      hostId: string;
      profileId: string;
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_reset",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileLifecycleResponseSchema.parse>
      >,
    browser_profile_delete: (input: {
      hostId: string;
      profileId: string;
      confirmation: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_delete",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileLifecycleResponseSchema.parse>
      >,
    browser_profile_backup: (input: {
      hostId: string;
      profileId: string;
      archivePath: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_backup",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileRecoveryResponseSchema.parse>
      >,
    browser_profile_restore: (input: {
      hostId: string;
      profileId: string;
      archivePath: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_restore",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileRecoveryResponseSchema.parse>
      >,
    browser_profile_import: (input: {
      hostId: string;
      name: string;
      sourcePath: string;
    }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_import",
        input,
      ) as Promise<
        ReturnType<typeof browserProfileRecoveryResponseSchema.parse>
      >,
    browser_host_choices: (input: BrowserHostChoicesInput) =>
      backend.harness.behavior.callRpc(
        "browser_host_choices",
        input,
      ) as Promise<ReturnType<typeof browserHostChoicesSchema.parse>>,
    browser_transfer_stage: (
      input: Parameters<
        typeof rpcContract.browser_transfer_stage.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_transfer_stage",
        input,
      ) as Promise<
        ReturnType<typeof browserTransferStagingResponseSchema.parse>
      >,
    browser_transfer_consume: (
      input: Parameters<
        typeof rpcContract.browser_transfer_consume.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_transfer_consume",
        input,
      ) as Promise<ReturnType<typeof browserTransferOutcomeSchema.parse>>,
    browser_transfer_release: (
      input: Parameters<
        typeof rpcContract.browser_transfer_release.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_transfer_release",
        input,
      ) as Promise<
        ReturnType<typeof browserTransferReleaseOutcomeSchema.parse>
      >,
    browser_transfer_cancel: (
      input: Parameters<
        typeof rpcContract.browser_transfer_cancel.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_transfer_cancel",
        input,
      ) as Promise<ReturnType<typeof browserTransferCancelOutcomeSchema.parse>>,
    browser_transfer_progress: (
      input: Parameters<
        typeof rpcContract.browser_transfer_progress.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_transfer_progress",
        input,
      ) as Promise<
        ReturnType<typeof browserTransferProgressResultSchema.parse>
      >,
    browser_control_lease_state: (
      input: Parameters<
        typeof rpcContract.browser_control_lease_state.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_control_lease_state",
        input,
      ) as Promise<ReturnType<typeof browserControlLeaseStateSchema.parse>>,
    browser_file_transfer_authorize: (
      input: Parameters<
        typeof rpcContract.browser_file_transfer_authorize.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_file_transfer_authorize",
        input,
      ) as Promise<ReturnType<typeof browserFileTransferDecisionSchema.parse>>,
    browser_download_start: (
      input: Parameters<
        typeof rpcContract.browser_download_start.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_start",
        input,
      ) as Promise<ReturnType<typeof browserDownloadStartResponseSchema.parse>>,
    browser_download_append: (
      input: Parameters<
        typeof rpcContract.browser_download_append.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_append",
        input,
      ) as Promise<ReturnType<typeof browserDownloadAppendOutcomeSchema.parse>>,
    browser_download_complete: (
      input: Parameters<
        typeof rpcContract.browser_download_complete.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_complete",
        input,
      ) as Promise<
        ReturnType<typeof browserDownloadCompleteOutcomeSchema.parse>
      >,
    browser_download_fail: (
      input: Parameters<
        typeof rpcContract.browser_download_fail.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_fail",
        input,
      ) as Promise<ReturnType<typeof browserDownloadFailOutcomeSchema.parse>>,
    browser_download_cancel: (
      input: Parameters<
        typeof rpcContract.browser_download_cancel.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_cancel",
        input,
      ) as Promise<ReturnType<typeof browserDownloadCancelOutcomeSchema.parse>>,
    browser_download_list: (
      input: Parameters<
        typeof rpcContract.browser_download_list.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_list",
        input,
      ) as Promise<ReturnType<typeof browserDownloadListResultSchema.parse>>,
    browser_download_limits: (
      input: Parameters<
        typeof rpcContract.browser_download_limits.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_limits",
        input,
      ) as Promise<ReturnType<typeof browserDownloadLimitsSchema.parse>>,
    browser_download_progress: (
      input: Parameters<
        typeof rpcContract.browser_download_progress.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_progress",
        input,
      ) as Promise<
        ReturnType<typeof browserDownloadProgressResultSchema.parse>
      >,
    browser_download_export_client: (
      input: Parameters<
        typeof rpcContract.browser_download_export_client.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_export_client",
        input,
      ) as Promise<ReturnType<typeof browserDownloadExportOutcomeSchema.parse>>,
    browser_download_export_workspace: (
      input: Parameters<
        typeof rpcContract.browser_download_export_workspace.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_export_workspace",
        input,
      ) as Promise<ReturnType<typeof browserDownloadExportOutcomeSchema.parse>>,
    browser_download_purge: (
      input: Parameters<
        typeof rpcContract.browser_download_purge.input.parse
      >[0],
    ) =>
      backend.harness.behavior.callRpc(
        "browser_download_purge",
        input,
      ) as Promise<ReturnType<typeof browserDownloadPurgeOutcomeSchema.parse>>,
  };

  function renderSettings() {
    const panel = renderSlot<PluginSettingsSectionProps, typeof rpcContract>(
      app.settingsSections[0]!,
      {},
      { rpc },
    );
    settingsPanels.push(panel);
    return panel;
  }

  /**
   * Mount the Browser Panel the way the BB app mounts it, once per call. This
   * is the panel counterpart to {@link renderSettings}: `openExistingThreadPanel`
   * reuses one panel per params key the way BB reuses an open tab, while every
   * `renderPanel` call is an independent client — which is what makes a
   * controller and a view-only spectator observable through the assembled
   * interface rather than through re-declared components.
   */
  function renderPanel(options: { surface?: "thread" | "new-thread" } = {}) {
    const panel =
      options.surface === "new-thread"
        ? renderNewThreadPanel({ profileId: DEFAULT_PROFILE_ID })
        : renderExistingPanel({ profileId: DEFAULT_PROFILE_ID });
    renderedPanels.push(panel);
    // Queries from a render are bound to the whole document, so with two
    // panels mounted a query for "the omnibox" would answer with whichever
    // panel rendered one first. Scoping them to this panel's own container is
    // what makes a controller and a view-only spectator separable.
    return { ...panel, ...within(panel.container) };
  }

  function renderExistingPanel(params: JsonValue | null) {
    return renderSlot<PluginThreadPanelProps, typeof rpcContract>(
      app.threadPanelActions[0]!,
      { threadId: THREAD_ID, params },
      { rpc },
    );
  }

  function renderNewThreadPanel(params: JsonValue | null) {
    return renderSlot<PluginNewThreadPanelProps, typeof rpcContract>(
      app.newThreadPanelActions[0]!,
      { projectId: PROJECT_ID, params },
      { rpc },
    );
  }

  async function openExistingThreadPanel(): Promise<OpenedPanel> {
    const action = app.threadPanelActions[0]!;
    let opened: OpenedPanel | undefined;
    await action.run?.({
      threadId: THREAD_ID,
      openPanel(options = {}) {
        const key = panelKey(action.id, options.params);
        const existing = threadPanels.get(key);
        const panel = existing ?? renderExistingPanel(options.params ?? null);
        threadPanels.set(key, panel);
        opened = {
          created: existing === undefined,
          layout: action.layout!,
          params: options.params ?? null,
          panel,
        };
        return true;
      },
    });
    return opened!;
  }

  async function openNewThreadPanel(): Promise<OpenedPanel> {
    const action = app.newThreadPanelActions[0]!;
    let opened: OpenedPanel | undefined;
    await action.run?.({
      projectId: PROJECT_ID,
      openPanel(options = {}) {
        const key = panelKey(action.id, options.params);
        const existing = newThreadPanels.get(key);
        const panel = existing ?? renderNewThreadPanel(options.params ?? null);
        newThreadPanels.set(key, panel);
        opened = {
          created: existing === undefined,
          layout: action.layout!,
          params: options.params ?? null,
          panel,
        };
        return true;
      },
    });
    return opened!;
  }

  function runStatusCli(): Promise<PluginCliExecutionResult> {
    return backend.harness.behavior.runCli(["status", "--json"], {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
    });
  }

  function runStatusCliText(): Promise<PluginCliExecutionResult> {
    return backend.harness.behavior.runCli(["status"], {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
    });
  }

  function runDiagnosticsCli(): Promise<PluginCliExecutionResult> {
    return backend.harness.behavior.runCli(["diagnostics", "--json"], {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
    });
  }

  function runBrowserCli(
    argv: string[],
    context: Partial<PluginCliContext> = {},
  ): Promise<PluginCliExecutionResult> {
    return backend.harness.behavior.runCli(argv, {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      ...context,
    });
  }

  function runBrowserNavigation(
    input: string,
    options?: { tabId?: string; panelId?: string },
  ): Promise<ReturnType<typeof browserNavigationResponseSchema.parse>> {
    return rpc.browser_navigate({
      surface: "thread",
      threadId: THREAD_ID,
      profileId: DEFAULT_PROFILE_ID,
      hostId: configuredHostId,
      input,
      ...(options?.tabId === undefined ? {} : { tabId: options.tabId }),
      ...(options?.panelId === undefined ? {} : { panelId: options.panelId }),
      rawLocalhost: false,
    });
  }

  function registeredBrowserCliCommands() {
    return backend.harness.inspection.registrations.cli?.commands ?? [];
  }

  function runBrowserActivityRecords(profileId = DEFAULT_PROFILE_ID) {
    return rpc.browser_activity_records({
      hostId: configuredHostId,
      profileId,
    });
  }

  function persistedActivityRows() {
    return backend.bb.storage
      .database()
      .prepare("SELECT * FROM browser_activity_records ORDER BY id")
      .all();
  }

  function persistedHostOutbox() {
    return readFile(join(hostDataRoot, "browser-activity-outbox.json"), "utf8");
  }

  function persistedGrantRequestEvents() {
    return backend.bb.storage
      .database()
      .prepare(
        "SELECT * FROM browser_grant_request_events ORDER BY event_sequence",
      )
      .all()
      .map((row) => persistedGrantRequestEventSchema.parse(row));
  }

  function diagnosticLogEntries() {
    return backend.harness.logEntries;
  }

  function runBrowserProfiles(
    hostId = configuredHostId,
    context?: { projectId?: string | null; threadId?: string },
  ) {
    return rpc.browser_profiles({ hostId, ...context });
  }

  function createBrowserProfile(input: {
    hostId: string;
    name: string;
    locale?: string;
    timezone?: string;
  }) {
    return rpc.browser_profile_create(input);
  }

  function renameBrowserProfile(input: {
    hostId: string;
    profileId: string;
    name: string;
    locale?: string;
    timezone?: string;
  }) {
    return rpc.browser_profile_rename(input);
  }

  function selectBrowserProfile(
    input: { hostId: string; profileId: string },
    context?: { projectId?: string | null; threadId?: string },
  ) {
    const selectionContext =
      context === undefined ? { projectId: PROJECT_ID } : context;
    return rpc.browser_profile_select({ ...input, ...selectionContext });
  }

  function archiveBrowserProfile(input: { hostId: string; profileId: string }) {
    return rpc.browser_profile_archive(input);
  }

  function restoreArchivedBrowserProfile(input: {
    hostId: string;
    profileId: string;
  }) {
    return rpc.browser_profile_restore_archived(input);
  }

  function resetBrowserProfile(input: {
    hostId: string;
    profileId: string;
    confirmation: string;
  }) {
    return rpc.browser_profile_reset(input);
  }

  function deleteBrowserProfile(input: {
    hostId: string;
    profileId: string;
    confirmation: string;
  }) {
    return rpc.browser_profile_delete(input);
  }

  function backupBrowserProfile(input: {
    hostId: string;
    profileId: string;
    archivePath: string;
  }) {
    return rpc.browser_profile_backup(input);
  }

  function restoreBrowserProfile(input: {
    hostId: string;
    profileId: string;
    archivePath: string;
  }) {
    return rpc.browser_profile_restore(input);
  }

  function importBrowserProfile(input: {
    hostId: string;
    name: string;
    sourcePath: string;
  }) {
    return rpc.browser_profile_import(input);
  }

  function createBrowserGrant(input: {
    projectId: string;
    hostId: string;
    profileId: string;
    installationId?: string;
    originScope: string;
    wholeWeb?: boolean;
    fileTransfer?: boolean;
    invalidCertificateOrigins?: string[];
    persistentElevations?: boolean;
    persistenceConfirmation?: string;
  }) {
    return rpc.browser_grant_create(input);
  }

  function listBrowserGrants(
    input: {
      projectId?: string;
      hostId?: string;
      installationId?: string;
      profileId?: string;
      includeRevoked?: boolean;
    } = {},
  ) {
    return rpc.browser_grants(input);
  }

  function inspectBrowserGrant(grantId: string) {
    return rpc.browser_grant_inspect({ grantId });
  }

  function revokeBrowserGrant(grantId: string) {
    return rpc.browser_grant_revoke({ grantId });
  }

  function listBrowserGrantRequests(
    input: {
      projectId?: string;
      hostId?: string;
      installationId?: string;
      profileId?: string;
      status?:
        "pending" | "denied" | "approved" | "consumed" | "expired" | "revoked";
    } = {},
  ) {
    return rpc.browser_grant_requests(input);
  }

  function inspectBrowserGrantRequest(requestId: string) {
    return rpc.browser_grant_request_inspect({ requestId });
  }

  function decideBrowserGrantRequest(input: {
    requestId: string;
    decision?: "deny" | "retry" | "one-hour" | "persist";
    persistenceConfirmation?: string;
  }) {
    return rpc.browser_grant_request_decide(input);
  }

  function revokeBrowserGrantRequest(requestId: string) {
    return rpc.browser_grant_request_revoke({ requestId });
  }

  function runBrowserHostChoices(input: BrowserHostChoicesInput) {
    return rpc.browser_host_choices(input);
  }

  function runBrowserTransferStage(
    input: Parameters<typeof rpc.browser_transfer_stage>[0],
  ) {
    return rpc.browser_transfer_stage(input);
  }
  function runBrowserTransferConsume(
    input: Parameters<typeof rpc.browser_transfer_consume>[0],
  ) {
    return rpc.browser_transfer_consume(input);
  }
  function runBrowserTransferRelease(
    input: Parameters<typeof rpc.browser_transfer_release>[0],
  ) {
    return rpc.browser_transfer_release(input);
  }
  function runBrowserTransferCancel(
    input: Parameters<typeof rpc.browser_transfer_cancel>[0],
  ) {
    return rpc.browser_transfer_cancel(input);
  }
  function runBrowserTransferProgress(
    input: Parameters<typeof rpc.browser_transfer_progress>[0],
  ) {
    return rpc.browser_transfer_progress(input);
  }
  function runBrowserControlLeaseState(
    input: Parameters<typeof rpc.browser_control_lease_state>[0],
  ) {
    return rpc.browser_control_lease_state(input);
  }
  function runBrowserFileTransferAuthorize(
    input: Parameters<typeof rpc.browser_file_transfer_authorize>[0],
  ) {
    return rpc.browser_file_transfer_authorize(input);
  }

  function runBrowserPanelCapability(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId?: string;
  }) {
    return rpc.browser_panel_capability({
      hostId: input.hostId,
      profileId: input.profileId,
      panelId: input.panelId,
      ownerSessionId: input.ownerSessionId ?? "owner-session-test",
    });
  }

  function runBrowserPanelControl(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
    viewport?: { width: number; height: number };
  }) {
    return rpc.browser_panel_control(input);
  }

  function runBrowserTakeControl(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
    viewport?: { width: number; height: number };
  }) {
    return rpc.browser_panel_take_control(input);
  }

  function runBrowserReleaseControl(input: {
    hostId: string;
    profileId: string;
    panelId: string;
  }) {
    return rpc.browser_panel_release_control(input);
  }

  function runBrowserReclaimControl(input: {
    hostId: string;
    profileId: string;
    panelId: string;
    ownerSessionId: string;
    viewport?: { width: number; height: number };
  }) {
    return rpc.browser_panel_reclaim_control(input);
  }

  /**
   * Put a completed download in host quarantine through the same boundary the
   * browser uses, so a test can assert what the owner does with a quarantined
   * file rather than what a stubbed listing returns.
   */
  async function quarantineBrowserDownload(input: {
    downloadId: string;
    suggestedName: string;
    contents: string;
    profileId?: string;
    contentType?: string | null;
  }) {
    const data = Buffer.from(input.contents, "utf8");
    await rpc.browser_download_start({
      hostId: configuredHostId,
      downloadId: input.downloadId,
      profileId: input.profileId ?? DEFAULT_PROFILE_ID,
      suggestedName: input.suggestedName,
      contentType: input.contentType ?? "text/plain",
      totalBytes: data.byteLength,
    });
    await rpc.browser_download_append({
      hostId: configuredHostId,
      downloadId: input.downloadId,
      data: data.toString("base64"),
      chunkBytes: data.byteLength,
    });
    return rpc.browser_download_complete({
      hostId: configuredHostId,
      downloadId: input.downloadId,
    });
  }

  function runBrowserTabs(hostId: string, profileId = DEFAULT_PROFILE_ID) {
    return rpc.browser_tabs({ hostId, profileId });
  }

  function runBrowserTabAction(
    action: BrowserPanelTabActionInput["action"],
    options?: { tabId?: string; panelId?: string; profileId?: string },
  ) {
    return rpc.browser_tab_action({
      surface: "thread",
      threadId: THREAD_ID,
      profileId: options?.profileId ?? DEFAULT_PROFILE_ID,
      hostId: configuredHostId,
      action,
      ...(options?.tabId === undefined ? {} : { tabId: options.tabId }),
      ...(options?.panelId === undefined ? {} : { panelId: options.panelId }),
    });
  }

  function runBrowserStatus(input: BrowserStatusInput) {
    return rpc.browser_status(input);
  }

  function runSettingsStatuses() {
    return rpc.browser_settings_status({ profileId: DEFAULT_PROFILE_ID });
  }

  function setHostConnection(status: HostConnectionStatus) {
    hostConnectionStatus = status;
  }

  function setHostRpcFailure(method: string, message?: string) {
    if (message === undefined) {
      hostRpcFailures.delete(method);
      return;
    }
    hostRpcFailures.set(method, message);
  }

  async function emitHostConnection(
    change: HostConnectionChange,
    hostId = configuredHostId,
  ) {
    hostConnectionStatus =
      change === "host-connected" ? "connected" : "disconnected";
    const event: HostConnectionEvent = {
      type: "changed",
      entity: "host",
      id: hostId,
      changes: [change],
    };
    for (const listener of [...hostConnectionListeners]) {
      await listener(event);
    }
  }

  async function emitProjectChange(
    change: ProjectChange,
    projectId = PROJECT_ID,
  ) {
    const event: ProjectChangeEvent = {
      type: "changed",
      entity: "project",
      id: projectId,
      changes: [change],
    };
    for (const listener of [...projectChangeListeners]) {
      await listener(event);
    }
  }

  async function seedHostActivityEvent(eventId = "seeded-host-activity") {
    await host.experimental_call("browserScript", {
      purpose: "Seed host activity",
      code: "return page.url();",
      destinationOrigin: "https://app.example.test",
      hostId: configuredHostId,
      projectId: PROJECT_ID,
      threadId: THREAD_ID,
      activityEventId: eventId,
      activityOccurredAt: new Date().toISOString(),
      profileId: DEFAULT_PROFILE_ID,
      timeoutMs: 30_000,
    });
  }

  async function runBrowserScript(): Promise<PublicToolFailure> {
    const reply = await backend.harness.behavior.callAgentTool(
      "browser_script",
      { purpose: "Verify setup failure", code: "return page.url();" },
      { threadId: THREAD_ID, projectId: PROJECT_ID },
    );
    if (
      typeof reply === "string" ||
      reply.isError !== true ||
      reply.content[0]?.type !== "text"
    ) {
      throw new Error("browser_script did not return its typed text failure");
    }
    const [first, ...rest] = reply.content;
    if (first?.type !== "text") {
      throw new Error("browser_script did not return its typed text failure");
    }
    return { content: [first, ...rest], isError: true };
  }

  async function runBrowserScriptWithProfile(
    profileId?: string,
    overrides?: {
      purpose?: string;
      code?: string;
      destinationOrigin?: string;
      fileTransfer?: boolean;
      invalidCertificate?: boolean;
      screenshot?: boolean;
      tabId?: string;
      timeoutMs?: number;
      projectId?: string;
      threadId?: string | null;
      signal?: AbortSignal;
    },
  ): Promise<PublicToolReply> {
    const reply = await backend.harness.behavior.callAgentTool(
      "browser_script",
      {
        purpose: overrides?.purpose ?? "Verify profile resolution",
        code: overrides?.code ?? "return page.url();",
        ...(overrides?.destinationOrigin === undefined
          ? {}
          : { destinationOrigin: overrides.destinationOrigin }),
        ...(overrides?.fileTransfer === undefined
          ? {}
          : { fileTransfer: overrides.fileTransfer }),
        ...(overrides?.invalidCertificate === undefined
          ? {}
          : { invalidCertificate: overrides.invalidCertificate }),
        ...(overrides?.screenshot === undefined
          ? {}
          : { screenshot: overrides.screenshot }),
        ...(overrides?.tabId === undefined ? {} : { tabId: overrides.tabId }),
        ...(overrides?.timeoutMs === undefined
          ? {}
          : { timeoutMs: overrides.timeoutMs }),
        ...(profileId === undefined ? {} : { profileId }),
      },
      {
        ...(overrides?.threadId === null
          ? {}
          : { threadId: overrides?.threadId ?? THREAD_ID }),
        projectId: overrides?.projectId ?? PROJECT_ID,
        ...(overrides?.signal === undefined
          ? {}
          : { signal: overrides.signal }),
      },
    );
    if (typeof reply === "string") {
      throw new Error("browser_script did not return text output");
    }
    const [first, ...rest] = reply.content;
    if (first?.type !== "text") {
      throw new Error("browser_script did not return text output");
    }
    return {
      content: [first, ...(rest as PublicToolContent[])],
      isError: reply.isError === true,
    };
  }

  function resolveAgentCapabilities() {
    return backend.harness.behavior.resolveAgentConfiguration({
      thread: {
        id: THREAD_ID,
        title: "Browser contract",
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: PROJECT_ID,
        kind: "standard",
        name: "Browser contract project",
        gitRemoteUrl: null,
      },
      environment: {
        id: ENVIRONMENT_ID,
        name: "Browser contract environment",
        path: "/workspace/browser-contract",
        workspaceProvisionType: "unmanaged",
        branchName: "main",
      },
      host: {
        id: configuredHostId,
        name: `Browser contract host ${configuredHostId}`,
      },
      provider: {
        id: "codex",
        model: "test-model",
        capabilities: { supportsNativeUserQuestion: true },
      },
      origin: { kind: null, pluginId: null },
    });
  }

  async function dispose() {
    try {
      for (const panel of threadPanels.values()) panel.lifecycle.unmount();
      for (const panel of newThreadPanels.values()) panel.lifecycle.unmount();
      for (const panel of settingsPanels) panel.lifecycle.unmount();
      for (const panel of renderedPanels) panel.lifecycle.unmount();
      await act(async () => undefined);
      await backend.harness.lifecycle.dispose();
      await host.experimental_dispose();
    } finally {
      if (profileStorageRoot !== null) {
        await rm(profileStorageRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 20,
        });
      }
      if (
        profileRecoveryRoot !== null &&
        profileRecoveryRoot !== profileStorageRoot
      ) {
        await rm(profileRecoveryRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 20,
        });
      }
      await rm(hostDataRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 20,
      });
    }
  }

  return {
    expectedStatus,
    get setupInspectionTargets() {
      return setupInspectionTargets;
    },
    get sharedPortDeclarations() {
      return backend.harness.inspection.sharedPortDeclarations;
    },
    get navigationRequests() {
      return [...navigationRequests];
    },
    get historyRequests() {
      return [...historyRequests];
    },
    get panelCapabilityRequests() {
      return [...panelCapabilityRequests];
    },
    get hostConnectionRequests() {
      return [...hostConnectionRequests];
    },
    openExistingThreadPanel,
    openNewThreadPanel,
    renderPanel,
    renderSettings,
    runBrowserStatus,
    runSettingsStatuses,
    setHostConnection,
    setHostRpcFailure,
    emitHostConnection,
    emitProjectChange,
    projectLookupStarted,
    releaseProjectLookup() {
      releaseProjectLookupGate?.();
    },
    profileInventoryStarted,
    releaseProfileInventory() {
      releaseProfileInventoryGate?.();
    },
    profileSelectionStarted,
    releaseProfileSelection() {
      releaseProfileSelectionGate?.();
    },
    seedHostActivityEvent,
    runStatusCli,
    runStatusCliText,
    runDiagnosticsCli,
    runBrowserCli,
    runBrowserNavigation,
    registeredBrowserCliCommands,
    runBrowserActivityRecords,
    persistedActivityRows,
    persistedHostOutbox,
    persistedGrantRequestEvents,
    diagnosticLogEntries,
    runBrowserProfiles,
    createBrowserProfile,
    renameBrowserProfile,
    selectBrowserProfile,
    archiveBrowserProfile,
    restoreArchivedBrowserProfile,
    resetBrowserProfile,
    deleteBrowserProfile,
    backupBrowserProfile,
    restoreBrowserProfile,
    importBrowserProfile,
    createBrowserGrant,
    listBrowserGrants,
    inspectBrowserGrant,
    revokeBrowserGrant,
    listBrowserGrantRequests,
    inspectBrowserGrantRequest,
    decideBrowserGrantRequest,
    revokeBrowserGrantRequest,
    runBrowserHostChoices,
    runBrowserTransferStage,
    runBrowserTransferConsume,
    runBrowserTransferRelease,
    runBrowserTransferCancel,
    runBrowserTransferProgress,
    runBrowserControlLeaseState,
    runBrowserFileTransferAuthorize,
    runBrowserPanelCapability,
    runBrowserPanelControl,
    runBrowserTakeControl,
    runBrowserReleaseControl,
    runBrowserReclaimControl,
    runBrowserTabs,
    quarantineBrowserDownload,
    runBrowserTabAction,
    runBrowserScript,
    runBrowserScriptWithProfile,
    privilegedExecutor: options?.privilegedExecutor ?? null,
    resolveAgentCapabilities,
    dispose,
  };
}
