import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_CONFIGURATION_ROOT,
  BROWSER_STORAGE_ROOT,
  DEFAULT_PROFILE_ID,
  STOP_BROWSER_CONFIRMATION,
  setupRequiredStatus,
  type BrowserHostTarget,
  type BrowserStatus,
} from "../contracts.js";
import { createBrowserHostEntry } from "../host.js";
import {
  BROWSER_SYSTEM_PACKAGES,
  BROWSER_USER,
  BROWSER_USER_HOME,
  BROWSER_USER_SHELL,
  browserInstallationPaths,
  browserRuntimePolicy,
  createFileHostAdministrationStateStore,
  createHostAdministrationBoundary,
  createMemoryHostAdministrationStateStore,
  createProductionPrivilegedExecutor,
  createSimulatedPrivilegedExecutor,
  type BrowserRuntimePolicy,
  type HostAdministrationBoundary,
  type HostAdministrationStateStore,
  validateBrowserRuntimePolicy,
} from "../host-operations.js";
import type { HostReadinessBoundary } from "../readiness.js";

const target: BrowserHostTarget = {
  hostId: "host-operations-test",
  profileId: DEFAULT_PROFILE_ID,
};
const installationId = "installation-operations-test";

function readinessBoundary(
  reportedStatus: BrowserStatus = setupRequiredStatus(target),
): HostReadinessBoundary {
  return {
    inspect: () => reportedStatus,
    diagnostics: (diagnosticsTarget) => ({
      hostId: diagnosticsTarget.hostId,
      profileId: diagnosticsTarget.profileId,
      generatedAt: "2026-08-27T00:00:00.000Z",
      readiness: reportedStatus,
      dependencies: [],
      processes: [],
      resourceUse: {
        diskFreeBytes: 0,
        diskTotalBytes: 0,
        workerRssBytes: 0,
      },
      exitLogs: [],
    }),
  };
}

function administrationFixture(
  stateStore?: HostAdministrationStateStore,
  reportedStatus?: BrowserStatus,
) {
  const executor = createSimulatedPrivilegedExecutor();
  const boundary = createHostAdministrationBoundary({
    readiness: readinessBoundary(reportedStatus),
    installationId,
    executor,
    stateStore,
  });
  return { boundary, executor };
}

async function completeSetup(boundary: HostAdministrationBoundary) {
  let plan = await boundary.setupPlan(target);
  for (const step of plan.steps) {
    const response = await boundary.setup({
      ...target,
      stepId: step.id,
      confirmation: step.confirmationText,
    });
    plan = response.plan;
  }
  return plan;
}

describe("Browser host administration contract", () => {
  it("produces an exact owner-visible setup plan without invoking the executor", async () => {
    const { boundary, executor } = administrationFixture();

    const plan = await boundary.setupPlan(target);

    expect(plan).toMatchObject({
      hostId: target.hostId,
      profileId: target.profileId,
      installationId,
      state: "pending",
      nextStepId: "dedicated-user",
      storageRoot: BROWSER_STORAGE_ROOT,
      hostStoragePath: `${BROWSER_STORAGE_ROOT}/installations/${installationId}/hosts/${encodeURIComponent(target.hostId)}`,
      configurationPath: `${BROWSER_CONFIGURATION_ROOT}/installations/${installationId}`,
      runtime: {
        runAsUser: BROWSER_USER,
        homeDirectory: BROWSER_USER_HOME,
        shell: BROWSER_USER_SHELL,
        sandbox: "required",
        noSandbox: false,
      },
      packages: BROWSER_SYSTEM_PACKAGES,
    });
    expect(plan.steps.map((step) => [step.id, step.confirmationText])).toEqual([
      ["dedicated-user", "Create bb-browser"],
      ["system-packages", "Install Browser packages"],
      ["protected-storage", "Configure protected Browser storage"],
    ]);
    expect(executor.attemptedOperations).toEqual([]);
  });

  it("requires each setup confirmation, enforces order, and is idempotent", async () => {
    const { boundary, executor } = administrationFixture();
    const initialPlan = await boundary.setupPlan(target);

    const rejected = await boundary.setup({
      ...target,
      stepId: "dedicated-user",
      confirmation: "no",
    });
    expect(rejected.outcome).toBe("confirmation-required");
    expect(executor.attemptedOperations).toEqual([]);

    const outOfOrder = await boundary.setup({
      ...target,
      stepId: "protected-storage",
      confirmation: initialPlan.steps[2]!.confirmationText,
    });
    expect(outOfOrder.outcome).toBe("blocked");
    expect(executor.attemptedOperations).toEqual([]);

    const readyPlan = await completeSetup(boundary);
    expect(readyPlan.state).toBe("ready");
    expect(readyPlan.nextStepId).toBeNull();
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toEqual([
      "create-dedicated-user",
      "install-system-packages",
      "configure-protected-storage",
    ]);
    expect(executor.successfulOperations.at(-1)).toMatchObject({
      kind: "configure-protected-storage",
      fallback: {
        sourcePath: "/playwright/chromium-1208/chrome",
        executablePath: expect.stringContaining("/browsers/chromium/chrome"),
        manifestPath: expect.stringContaining(
          "/browsers/chromium/version.json",
        ),
      },
    });

    const repeated = await boundary.setup({
      ...target,
      stepId: "dedicated-user",
      confirmation: "Create bb-browser",
    });
    expect(repeated.outcome).toBe("already-complete");
    expect(executor.successfulOperations).toHaveLength(3);
  });

  it("records a failed setup step and resumes that step before later work", async () => {
    const { boundary, executor } = administrationFixture();
    executor.failNext("install-system-packages", "package manager unavailable");

    const firstPlan = await boundary.setupPlan(target);
    const firstStep = await boundary.setup({
      ...target,
      stepId: firstPlan.steps[0]!.id,
      confirmation: firstPlan.steps[0]!.confirmationText,
    });
    const failedStep = await boundary.setup({
      ...target,
      stepId: "system-packages",
      confirmation: "Install Browser packages",
    });

    expect(firstStep.outcome).toBe("progressed");
    expect(failedStep.outcome).toBe("partial-failure");
    expect(failedStep.plan.state).toBe("partial-failure");
    expect(failedStep.plan.nextStepId).toBe("system-packages");
    expect(
      executor.attemptedOperations.map((operation) => operation.kind),
    ).toEqual(["create-dedicated-user", "install-system-packages"]);

    const resumedPlan = await completeSetup(boundary);
    expect(resumedPlan.state).toBe("ready");
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toEqual([
      "create-dedicated-user",
      "install-system-packages",
      "configure-protected-storage",
    ]);
  });

  it("blocks setup on an unsupported host before privileged execution", async () => {
    const unsupported: BrowserStatus = {
      ...setupRequiredStatus(target),
      state: "unsupported",
      code: "unsupported",
      label: "Unsupported",
      message: "Workspace Browser supports Ubuntu and Debian on x86_64 only.",
    };
    const { boundary, executor } = administrationFixture(
      undefined,
      unsupported,
    );
    const plan = await boundary.setupPlan(target);

    const blocked = await boundary.setup({
      ...target,
      stepId: plan.steps[0]!.id,
      confirmation: plan.steps[0]!.confirmationText,
    });

    expect(blocked.outcome).toBe("blocked");
    expect(blocked.message).toContain("supports Ubuntu and Debian");
    expect(executor.attemptedOperations).toEqual([]);
  });

  it("R4-CONNECT-ENROLLMENT blocks setup when BB Connect is missing", async () => {
    const notEnrolled: BrowserStatus = {
      ...setupRequiredStatus(target),
      capabilities: setupRequiredStatus(target).capabilities.map(
        (capability) =>
          capability.id === "bb-connect"
            ? {
                ...capability,
                status: "missing" as const,
                reason: "Enroll this host in BB Connect before Browser setup.",
              }
            : capability,
      ),
    };
    const { boundary, executor } = administrationFixture(
      undefined,
      notEnrolled,
    );
    const plan = await boundary.setupPlan(target);

    const blocked = await boundary.setup({
      ...target,
      stepId: plan.steps[0]!.id,
      confirmation: plan.steps[0]!.confirmationText,
    });

    expect(blocked.outcome).toBe("blocked");
    expect(blocked.message).toContain("Enroll this host in BB Connect");
    expect(executor.attemptedOperations).toEqual([]);
  });

  it("persists setup progress across host-boundary recreation", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "browser-admin-state-"));
    try {
      const stateStore = createFileHostAdministrationStateStore(dataDirectory);
      const first = administrationFixture(stateStore);
      const plan = await first.boundary.setupPlan(target);
      await first.boundary.setup({
        ...target,
        stepId: plan.steps[0]!.id,
        confirmation: plan.steps[0]!.confirmationText,
      });

      const second = administrationFixture(stateStore);
      const resumed = await second.boundary.setupPlan(target);
      expect(resumed.state).toBe("in-progress");
      expect(resumed.nextStepId).toBe("system-packages");
      await completeSetup(second.boundary);
      expect(
        second.executor.successfulOperations.map((operation) => operation.kind),
      ).toEqual(["install-system-packages", "configure-protected-storage"]);
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "root execution",
      policy: { ...browserRuntimePolicy(), runAsUser: "root" },
    },
    {
      name: "disabled sandbox",
      policy: { ...browserRuntimePolicy(), sandbox: "disabled" },
    },
    {
      name: "no-sandbox flag",
      policy: { ...browserRuntimePolicy(), noSandbox: true },
    },
  ] satisfies { name: string; policy: BrowserRuntimePolicy }[])(
    "rejects $name",
    ({ policy }) => {
      expect(() => validateBrowserRuntimePolicy(policy)).toThrow(
        "bb-browser with Chrome sandboxing enabled",
      );
    },
  );

  it("stops owned processes while retaining profiles for disable and uninstall", async () => {
    const disabled = administrationFixture();
    const rejected = await disabled.boundary.disable({
      ...target,
      confirmation: "no",
    });
    expect(rejected.outcome).toBe("confirmation-required");
    const stopped = await disabled.boundary.disable({
      ...target,
      confirmation: STOP_BROWSER_CONFIRMATION,
    });
    const repeated = await disabled.boundary.disable({
      ...target,
      confirmation: STOP_BROWSER_CONFIRMATION,
    });
    expect(stopped).toMatchObject({
      action: "disable",
      outcome: "stopped",
      profilesRetained: true,
    });
    expect(repeated.outcome).toBe("already-stopped");
    expect(disabled.executor.successfulOperations).toHaveLength(1);

    const uninstalled = administrationFixture();
    const uninstallResponse = await uninstalled.boundary.uninstall({
      ...target,
      confirmation: STOP_BROWSER_CONFIRMATION,
    });
    expect(uninstallResponse).toMatchObject({
      action: "uninstall",
      outcome: "stopped",
      profilesRetained: true,
    });
    expect(
      uninstalled.executor.successfulOperations.map(
        (operation) => operation.kind,
      ),
    ).toEqual(["stop-owned-processes"]);
  });

  it("R10-01 stops and recovers Browser Instances independently of installation lifecycle", async () => {
    const { boundary, executor } = administrationFixture();
    const secondProfile = { ...target, profileId: "profile-second" };

    await boundary.stopProfile(target);
    await boundary.stopProfile(secondProfile);

    expect(executor.successfulOperations).toMatchObject([
      { kind: "stop-profile-processes", profileId: target.profileId },
      { kind: "stop-profile-processes", profileId: secondProfile.profileId },
    ]);
    await expect(boundary.isProfileStopped(target)).resolves.toBe(true);
    await expect(boundary.isProfileStopped(secondProfile)).resolves.toBe(true);

    const disabled = await boundary.disable({
      ...target,
      confirmation: STOP_BROWSER_CONFIRMATION,
    });
    expect(disabled.outcome).toBe("stopped");
    expect(executor.successfulOperations.at(-1)).toMatchObject({
      kind: "stop-owned-processes",
    });
  });

  it("R10-02 production lifecycle execution invokes the privileged process boundary and fails closed", async () => {
    const commands: { file: string; arguments: readonly string[] }[] = [];
    const executor = createProductionPrivilegedExecutor({
      executeFile: async (file, arguments_) => {
        commands.push({ file, arguments: arguments_ });
      },
    });

    await executor.execute({
      kind: "stop-profile-processes",
      owner: BROWSER_USER,
      hostId: target.hostId,
      installationId,
      profileId: target.profileId,
      profilePath: `${BROWSER_STORAGE_ROOT}/installations/${installationId}/hosts/${encodeURIComponent(target.hostId)}/profiles/${target.profileId}`,
      confirmation: "Authenticated owner profile lifecycle",
    });

    expect(commands).toEqual([
      {
        file: "/usr/bin/pkill",
        arguments: [
          "--signal",
          "TERM",
          "--uid",
          BROWSER_USER,
          "--full",
          `${BROWSER_STORAGE_ROOT}/installations/${installationId}/hosts/${encodeURIComponent(target.hostId)}/profiles/${target.profileId}`,
        ],
      },
    ]);
    await expect(
      executor.execute({
        kind: "remove-browser-data",
        path: "/var/lib/bb-browser/example",
        installationId,
        hostId: target.hostId,
        confirmation: "confirmed",
      }),
    ).rejects.toThrow("not configured for remove-browser-data");

    const noMatchingProcess = createProductionPrivilegedExecutor({
      executeFile: async () => {
        throw Object.assign(new Error("no process matched"), { code: 1 });
      },
    });
    await expect(
      noMatchingProcess.execute({
        kind: "stop-profile-processes",
        owner: BROWSER_USER,
        hostId: target.hostId,
        installationId,
        profileId: target.profileId,
        profilePath: `${BROWSER_STORAGE_ROOT}/installations/${installationId}/hosts/${encodeURIComponent(target.hostId)}/profiles/${target.profileId}`,
        confirmation: "Authenticated owner profile lifecycle",
      }),
    ).resolves.toBeUndefined();
  });

  it("purges only the installation-scoped targets after typed confirmation", async () => {
    const { boundary, executor } = administrationFixture();
    const plan = await boundary.purgePlan(target);
    const paths = browserInstallationPaths(installationId, target.hostId);

    expect(plan.targets).toMatchObject([
      {
        kind: "processes",
        id: "stop-owned-processes",
        scope: "Browser-owned processes",
      },
      { kind: "browser-data", id: "browser-data", path: paths.hostStoragePath },
      {
        kind: "configuration",
        id: "configuration",
        path: paths.configurationPath,
      },
      { kind: "system-user", id: "dedicated-user", username: BROWSER_USER },
    ]);
    expect(JSON.stringify(plan)).not.toContain("dev-browser");

    const rejected = await boundary.purge({
      ...target,
      confirmation: "PURGE",
    });
    expect(rejected.outcome).toBe("confirmation-required");
    expect(executor.attemptedOperations).toEqual([]);

    const purged = await boundary.purge({
      ...target,
      confirmation: plan.confirmationText,
    });
    expect(purged.outcome).toBe("purged");
    expect(purged.plan.state).toBe("purged");
    expect(executor.successfulOperations).toHaveLength(4);
    expect(
      executor.attemptedOperations.every(
        (operation) => operation.confirmation === plan.confirmationText,
      ),
    ).toBe(true);
    const hostilePaths = browserInstallationPaths(
      installationId,
      "../dev-browser",
    );
    expect(hostilePaths.hostStoragePath).toContain("%2E%2E%2Fdev-browser");
    expect(hostilePaths.hostStoragePath).not.toContain("/../");

    const repeated = await boundary.purge({
      ...target,
      confirmation: plan.confirmationText,
    });
    expect(repeated.outcome).toBe("already-purged");
    expect(executor.successfulOperations).toHaveLength(4);
  });

  it("R4-PURGE-SCOPE carries installation identity through lifecycle and purge operations", async () => {
    const lifecycle = administrationFixture();
    await lifecycle.boundary.disable({
      ...target,
      confirmation: STOP_BROWSER_CONFIRMATION,
    });

    expect(lifecycle.executor.successfulOperations).toMatchObject([
      {
        kind: "stop-owned-processes",
        hostId: target.hostId,
        installationId,
      },
    ]);

    const purge = administrationFixture();
    const plan = await purge.boundary.purgePlan(target);
    await purge.boundary.purge({
      ...target,
      confirmation: plan.confirmationText,
    });

    expect(purge.executor.successfulOperations).toMatchObject([
      {
        kind: "stop-owned-processes",
        hostId: target.hostId,
        installationId,
      },
      {
        kind: "remove-browser-data",
        hostId: target.hostId,
        installationId,
      },
      {
        kind: "remove-installation-configuration",
        installationId,
      },
      {
        kind: "remove-dedicated-user",
        hostId: target.hostId,
        installationId,
        guard: {
          type: "last-installation-only",
          hostId: target.hostId,
          installationId,
        },
      },
    ]);
  });

  it("R4-ADMIN-SERIALIZATION serializes concurrent host mutations per host", async () => {
    const { boundary, executor } = administrationFixture();
    const request = {
      ...target,
      stepId: "dedicated-user" as const,
      confirmation: "Create bb-browser",
    };

    const responses = await Promise.all([
      boundary.setup(request),
      boundary.setup(request),
    ]);

    expect(executor.successfulOperations).toHaveLength(1);
    expect(responses.map((response) => response.outcome).sort()).toEqual([
      "already-complete",
      "progressed",
    ]);
  });

  it("resumes purge after an injected target failure without repeating completed targets", async () => {
    const { boundary, executor } = administrationFixture();
    executor.failNext("remove-browser-data", "profile is busy");
    const plan = await boundary.purgePlan(target);

    const failed = await boundary.purge({
      ...target,
      confirmation: plan.confirmationText,
    });
    expect(failed.outcome).toBe("partial-failure");
    expect(failed.plan.state).toBe("partial-failure");
    expect(
      executor.attemptedOperations.map((operation) => operation.kind),
    ).toEqual(["stop-owned-processes", "remove-browser-data"]);

    const resumed = await boundary.purge({
      ...target,
      confirmation: plan.confirmationText,
    });
    expect(resumed.outcome).toBe("purged");
    expect(
      executor.attemptedOperations.map((operation) => operation.kind),
    ).toEqual([
      "stop-owned-processes",
      "remove-browser-data",
      "remove-browser-data",
      "remove-installation-configuration",
      "remove-dedicated-user",
    ]);
    expect(executor.successfulOperations).toHaveLength(4);
  });

  it("exposes setup and purge methods through the retained host entry", async () => {
    const { boundary, executor } = administrationFixture(
      createMemoryHostAdministrationStateStore(),
    );
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(boundary),
    );

    try {
      const plan = await host.experimental_call("setupPlan", target);
      expect(plan.nextStepId).toBe("dedicated-user");
      const response = await host.experimental_call("setup", {
        ...target,
        stepId: "dedicated-user",
        confirmation: "Create bb-browser",
      });
      expect(response.outcome).toBe("progressed");
      expect(executor.successfulOperations).toHaveLength(1);
      expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);

      const purgePlan = await host.experimental_call("purgePlan", target);
      expect(purgePlan.targets).toHaveLength(4);
    } finally {
      await host.experimental_dispose();
    }
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });
});
