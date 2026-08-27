import type {
  JsonValue,
  PluginCliExecutionResult,
  PluginNewThreadPanelProps,
  PluginThreadPanelProps,
} from "@get-bb/plugin-sdk";
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
  browserScriptRequestSchema,
  browserHostTargetSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserStatus,
  type BrowserStatusInput,
  type rpcContract,
} from "../contracts.js";
import { createBrowserHostEntry, type HostSetupBoundary } from "../host.js";
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

function projectFixture() {
  return {
    id: PROJECT_ID,
    name: "Browser contract project",
    kind: "standard" as const,
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source-browser-test",
        projectId: PROJECT_ID,
        hostId: HOST_ID,
        path: "/workspace/browser-contract",
        type: "local_path" as const,
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

function environmentFixture() {
  return {
    id: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
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

function hostFixture() {
  return {
    id: HOST_ID,
    name: "Browser contract host",
    type: "persistent" as const,
    status: "connected" as const,
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

export async function createPublicPluginHarness() {
  let hostMutationCount = 0;
  const setupInspectionTargets: BrowserHostTarget[] = [];
  const expectedStatus = setupRequiredStatus({
    hostId: HOST_ID,
    profileId: DEFAULT_PROFILE_ID,
  });
  const setupBoundary: HostSetupBoundary = {
    inspect: (target) => {
      setupInspectionTargets.push(target);
      return setupRequiredStatus(target);
    },
    provision: () => {
      hostMutationCount += 1;
    },
  };
  const host = experimental_createHostEntryHarness(
    createBrowserHostEntry(setupBoundary),
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
      environments: { get: async () => environmentFixture() },
      projects: { get: async () => projectFixture() },
      hosts: { list: async () => [hostFixture()] },
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
      return host.experimental_call(
        "browserScript",
        browserScriptRequestSchema.parse(input),
        { signal },
      );
    },
  });
  await plugin(backend.bb);
  const app = await loadPluginApp(() => import("../app.js"));
  const threadPanels = new Map<string, RenderedSlot>();
  const newThreadPanels = new Map<string, RenderedSlot>();

  const rpc = {
    browser_status: (input: BrowserStatusInput) =>
      backend.harness.behavior.callRpc(
        "browser_status",
        input,
      ) as Promise<BrowserStatus>,
  };

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

  function runBrowserStatus(input: BrowserStatusInput) {
    return rpc.browser_status(input);
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
      host: { id: HOST_ID, name: "Browser contract host" },
      provider: {
        id: "codex",
        model: "test-model",
        capabilities: { supportsNativeUserQuestion: true },
      },
      origin: { kind: null, pluginId: null },
    });
  }

  async function dispose() {
    for (const panel of threadPanels.values()) panel.lifecycle.unmount();
    for (const panel of newThreadPanels.values()) panel.lifecycle.unmount();
    await backend.harness.lifecycle.dispose();
    await host.experimental_dispose();
  }

  return {
    expectedStatus,
    get hostMutationCount() {
      return hostMutationCount;
    },
    get setupInspectionTargets() {
      return setupInspectionTargets;
    },
    openExistingThreadPanel,
    openNewThreadPanel,
    runBrowserStatus,
    runStatusCli,
    runBrowserScript,
    resolveAgentCapabilities,
    dispose,
  };
}
