import type {
  JsonValue,
  PluginCliExecutionResult,
  PluginNewThreadPanelProps,
  PluginSettingsSectionProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  browserDiagnosticsSchema,
  browserLifecycleRequestSchema,
  browserLifecycleResponseSchema,
  browserPurgeRequestSchema,
  browserScriptRequestSchema,
  browserSetupRequestSchema,
  browserHostTargetSchema,
  browserPurgePlanSchema,
  browserPurgeResponseSchema,
  browserProfileCreateRequestSchema,
  browserProfileHostTargetSchema,
  browserProfileInventorySchema,
  browserProfileRenameRequestSchema,
  browserProfileSchema,
  browserProfileSelectRequestSchema,
  browserHostChoicesSchema,
  browserSetupPlanSchema,
  browserSetupResponseSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserStatus,
  type BrowserHostChoicesInput,
  type BrowserStatusInput,
  type rpcContract,
} from "../contracts.js";
import { createBrowserHostEntry, type HostSetupBoundary } from "../host.js";
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
  createHostReadinessBoundary,
  type HostProbeSnapshot,
} from "../readiness.js";
import plugin from "../server.js";

const HOST_ID = "host-browser-test";
const PROJECT_ID = "project-browser-test";
const THREAD_ID = "thread-browser-test";
const ENVIRONMENT_ID = "environment-browser-test";

type PublicToolFailure = {
  content: [{ type: "text"; text: string }];
  isError: true;
};

type OpenedPanel = {
  created: boolean;
  layout: "flush" | "padded";
  params: JsonValue | null;
  panel: RenderedSlot;
};

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

export async function createPublicPluginHarness(options?: {
  hostId?: string;
  status?: BrowserStatus;
  hostConnection?: "connected" | "disconnected";
  hostIds?: readonly string[];
  projectHostIds?: readonly string[];
  probeFailure?: boolean;
  snapshot?: HostProbeSnapshot;
  privilegedExecutor?: PrivilegedExecutor;
  administrationStateStore?: HostAdministrationStateStore;
  profileStore?: BrowserProfileStore;
}) {
  const configuredHostId = options?.hostId ?? HOST_ID;
  const configuredProjectHostIds = options?.projectHostIds ?? [
    configuredHostId,
  ];
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
  const setupBoundary: HostSetupBoundary = {
    inspect: (target) => {
      setupInspectionTargets.push(target);
      if (options?.probeFailure === true) {
        throw new Error("retained worker probe failed");
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
  const profileStore =
    options?.profileStore ??
    createFileBrowserProfileStore({
      rootDirectory: profileStorageRoot!,
      installationId: "installation-public-test",
    });
  const host = experimental_createHostEntryHarness(
    createBrowserHostEntry(hostBoundary, profileStore),
  );
  const backend = createFakePluginHost({
    pluginId: "browser",
    agentSkillIds: ["browser"],
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({
            id: THREAD_ID,
            projectId: PROJECT_ID,
            environmentId: ENVIRONMENT_ID,
          }),
      },
      environments: {
        get: async () =>
          environmentFixture(configuredProjectHostIds[0] ?? configuredHostId),
      },
      hosts: {
        list: async () =>
          (options?.hostIds ?? [configuredHostId]).map((hostId) =>
            hostFixture(hostId, options?.hostConnection),
          ),
      },
      projects: {
        get: async () => projectFixture(configuredProjectHostIds),
      },
    },
    experimental_callHostRpc: ({ method, input, signal }) => {
      if (method === "status") {
        return host.experimental_call(
          "status",
          browserHostTargetSchema.parse(input),
          {
            signal,
          },
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
        return host.experimental_call(
          "browserScript",
          browserScriptRequestSchema.parse(input),
          { signal },
        );
      }
      if (method === "listProfiles") {
        return host.experimental_call(
          "listProfiles",
          browserProfileHostTargetSchema.parse(input),
          { signal },
        );
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
        return host.experimental_call(
          "selectProfile",
          browserProfileSelectRequestSchema.parse(input),
          { signal },
        );
      }
      throw new Error(`Unexpected host method: ${method}`);
    },
  });
  await plugin(backend.bb);
  const app = await loadPluginApp(() => import("../app.js"));
  const threadPanels = new Map<string, RenderedSlot>();
  const newThreadPanels = new Map<string, RenderedSlot>();
  const settingsPanels: RenderedSlot[] = [];

  const rpc = {
    browser_status: (input: BrowserStatusInput) =>
      backend.harness.behavior.callRpc(
        "browser_status",
        input,
      ) as Promise<BrowserStatus>,
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
    browser_profiles: (input: { hostId: string }) =>
      backend.harness.behavior.callRpc("browser_profiles", input) as Promise<
        ReturnType<typeof browserProfileInventorySchema.parse>
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
    browser_profile_select: (input: { hostId: string; profileId: string }) =>
      backend.harness.behavior.callRpc(
        "browser_profile_select",
        input,
      ) as Promise<ReturnType<typeof browserProfileInventorySchema.parse>>,
    browser_host_choices: (input: BrowserHostChoicesInput) =>
      backend.harness.behavior.callRpc(
        "browser_host_choices",
        input,
      ) as Promise<ReturnType<typeof browserHostChoicesSchema.parse>>,
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

  function runBrowserCli(argv: string[]): Promise<PluginCliExecutionResult> {
    return backend.harness.behavior.runCli(argv, {
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
    });
  }

  function runBrowserActivityRecords() {
    return rpc.browser_activity_records({
      hostId: configuredHostId,
      profileId: DEFAULT_PROFILE_ID,
    });
  }

  function runBrowserProfiles(hostId = configuredHostId) {
    return rpc.browser_profiles({ hostId });
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

  function selectBrowserProfile(input: { hostId: string; profileId: string }) {
    return rpc.browser_profile_select(input);
  }

  function runBrowserHostChoices(input: BrowserHostChoicesInput) {
    return rpc.browser_host_choices(input);
  }

  function runBrowserStatus(input: BrowserStatusInput) {
    return rpc.browser_status(input);
  }

  function runSettingsStatuses() {
    return rpc.browser_settings_status({ profileId: DEFAULT_PROFILE_ID });
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
    return { content: [reply.content[0]], isError: true };
  }

  async function runBrowserScriptWithProfile(profileId?: string) {
    const reply = await backend.harness.behavior.callAgentTool(
      "browser_script",
      {
        purpose: "Verify profile resolution",
        code: "return page.url();",
        ...(profileId === undefined ? {} : { profileId }),
      },
      { threadId: THREAD_ID, projectId: PROJECT_ID },
    );
    if (typeof reply === "string" || reply.content[0]?.type !== "text") {
      throw new Error("browser_script did not return text output");
    }
    return { content: [reply.content[0]], isError: reply.isError === true };
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
    openExistingThreadPanel,
    openNewThreadPanel,
    renderSettings,
    runBrowserStatus,
    runSettingsStatuses,
    runStatusCli,
    runStatusCliText,
    runDiagnosticsCli,
    runBrowserCli,
    runBrowserActivityRecords,
    runBrowserProfiles,
    createBrowserProfile,
    renameBrowserProfile,
    selectBrowserProfile,
    runBrowserHostChoices,
    runBrowserScript,
    runBrowserScriptWithProfile,
    privilegedExecutor: options?.privilegedExecutor ?? null,
    resolveAgentCapabilities,
    dispose,
  };
}
