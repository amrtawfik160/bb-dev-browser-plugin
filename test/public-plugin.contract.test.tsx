// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  browserActivityRecordsSchema,
  browserDiagnosticsSchema,
  browserLifecycleResponseSchema,
  browserSetupPlanSchema,
  browserSetupResponseSchema,
  browserPurgePlanSchema,
  browserPurgeResponseSchema,
  browserScriptFailureSchema,
  browserStatusSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";
import { createSimulatedPrivilegedExecutor } from "../host-operations.js";
import type { HostProbeSnapshot } from "../readiness.js";

const preparedSnapshot: HostProbeSnapshot = {
  operatingSystem: {
    id: "ubuntu",
    version: "24.04",
    name: "Ubuntu 24.04 LTS",
  },
  architecture: "x64",
  connect: { enrolled: true },
  browser: {
    name: "Google Chrome",
    version: "140.0.7339.80",
    compatible: true,
  },
  sandbox: { available: true },
  dedicatedUser: { state: "ready" },
  protectedStorage: { state: "ready" },
  disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
  loopback: { available: true },
  processes: [],
  exitLogs: [],
};

const healthyStatus: BrowserStatus = {
  hostId: "host-browser-test",
  profileId: DEFAULT_PROFILE_ID,
  state: "healthy",
  code: "healthy",
  label: "Ready",
  message: "Workspace Browser is ready on this host.",
  capabilities: [
    ["operating-system", "Operating system", "Ubuntu 24.04 is supported."],
    ["architecture", "Architecture", "x86_64 is supported."],
    ["bb-connect", "BB Connect", "The host is enrolled in BB Connect."],
    ["browser", "Browser", "Google Chrome 140 is available."],
    ["sandbox", "Browser sandbox", "The Chrome sandbox is available."],
    ["dedicated-user", "Dedicated browser user", "bb-browser is configured."],
    ["protected-storage", "Protected storage", "Storage is protected."],
    ["disk-headroom", "Disk headroom", "At least 5 GiB is free."],
    ["loopback", "Loopback networking", "Loopback is available."],
  ].map(([id, label, reason]) => ({
    id: id as BrowserStatus["capabilities"][number]["id"],
    label,
    status: "ready" as const,
    reason,
  })),
};

describe("Browser public plugin contract", () => {
  it("reports a healthy supported host through the panel and CLI", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    const opened = await browser.openExistingThreadPanel();
    const cli = await browser.runStatusCli();

    await opened.panel.findByText("Ready");
    const status = browserStatusSchema.parse(JSON.parse(cli.stdout));
    expect(status.state).toBe("healthy");
    expect(status.capabilities).toHaveLength(9);
    expect(browser.sharedPortDeclarations).toEqual([]);
    await browser.dispose();
  });

  it.each([
    {
      name: "unsupported",
      state: "unsupported",
      snapshot: {
        ...preparedSnapshot,
        operatingSystem: { id: "fedora", version: "42", name: "Fedora 42" },
        architecture: "arm64",
      },
    },
    {
      name: "partially configured",
      state: "setup-required",
      snapshot: {
        ...preparedSnapshot,
        browser: null,
        dedicatedUser: { state: "missing" as const },
        protectedStorage: { state: "partial" as const },
      },
    },
    {
      name: "low disk",
      state: "repair-required",
      snapshot: {
        ...preparedSnapshot,
        disk: { freeBytes: 4 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
      },
    },
    {
      name: "corrupt host state",
      state: "repair-required",
      snapshot: {
        ...preparedSnapshot,
        protectedStorage: { state: "corrupt" as const },
      },
    },
  ])(
    "shows the $name probe through the public panel and CLI",
    async ({ state, snapshot }) => {
      const browser = await createPublicPluginHarness({ snapshot });

      const panel = await browser.openExistingThreadPanel();
      const cli = await browser.runStatusCli();
      const status = browserStatusSchema.parse(JSON.parse(cli.stdout));

      await panel.panel.findByText(status.label);
      expect(status.state).toBe(state);
      expect(status.capabilities).toHaveLength(9);
      expect(browser.sharedPortDeclarations).toEqual([]);
      await browser.dispose();
    },
  );

  it("shows the same readiness checklist in Settings and bb browser status", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });

    const settings = browser.renderSettings();
    const settingsStatuses = await browser.runSettingsStatuses();
    const cli = await browser.runStatusCli();
    const cliText = await browser.runStatusCliText();

    await settings.findByText("Ready");
    expect(settings.getAllByRole("listitem")).toHaveLength(9);
    expect(settingsStatuses).toEqual([healthyStatus]);
    expect(browserStatusSchema.parse(JSON.parse(cli.stdout))).toEqual(
      settingsStatuses[0],
    );
    for (const capability of healthyStatus.capabilities) {
      expect(cliText.stdout).toContain(capability.label);
      expect(cliText.stdout).toContain(capability.reason);
    }
    await browser.dispose();
  });

  it("reports a disconnected workspace host as Host offline without probing it", async () => {
    const browser = await createPublicPluginHarness({
      hostConnection: "disconnected",
    });

    const settings = browser.renderSettings();
    const cli = await browser.runStatusCli();
    const status = browserStatusSchema.parse(JSON.parse(cli.stdout));

    await settings.findByText("Host offline");
    expect(status.state).toBe("host-offline");
    expect(status.capabilities).toHaveLength(9);
    expect(browser.setupInspectionTargets).toEqual([]);
    expect(browser.sharedPortDeclarations).toEqual([]);
    await browser.dispose();
  });

  it("issue #3 reports a connected readiness probe failure as Repair required", async () => {
    const browser = await createPublicPluginHarness({ probeFailure: true });

    const cli = await browser.runStatusCli();
    const status = browserStatusSchema.parse(JSON.parse(cli.stdout));

    expect(status.state).toBe("repair-required");
    expect(status.message).toContain("readiness checks failed");
    expect(browser.setupInspectionTargets).toEqual([
      { hostId: "host-browser-test", profileId: DEFAULT_PROFILE_ID },
    ]);
    await browser.dispose();
  });

  it("issue #3 keeps connected worker failures distinct in redacted diagnostics", async () => {
    const browser = await createPublicPluginHarness({ probeFailure: true });

    const cli = await browser.runDiagnosticsCli();
    const diagnostics = browserDiagnosticsSchema.parse(JSON.parse(cli.stdout));

    expect(diagnostics.readiness.state).toBe("repair-required");
    expect(diagnostics.readiness.message).toContain("readiness checks failed");
    await browser.dispose();
  });

  it("generates the same redacted diagnostics from Settings and the CLI", async () => {
    const browser = await createPublicPluginHarness({ status: healthyStatus });

    const settings = browser.renderSettings();
    const button = await settings.findByRole("button", {
      name: "Generate redacted diagnostics",
    });
    button.click();
    const settingsDiagnostics = await settings.findByLabelText(
      "Redacted diagnostics",
    );
    const cli = await browser.runDiagnosticsCli();

    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(
      JSON.parse(settingsDiagnostics.textContent ?? ""),
    );
    await browser.dispose();
  });

  it("opens one full-bleed Setup required panel per profile on an existing thread", async () => {
    const browser = await createPublicPluginHarness();

    const firstOpen = await browser.openExistingThreadPanel();
    const secondOpen = await browser.openExistingThreadPanel();

    expect(firstOpen.layout).toBe("flush");
    expect(firstOpen.params).toEqual({ profileId: DEFAULT_PROFILE_ID });
    expect(firstOpen.created).toBe(true);
    expect(secondOpen.created).toBe(false);
    expect(secondOpen.panel).toBe(firstOpen.panel);
    await firstOpen.panel.findByText("Setup required");
    await browser.dispose();
  });

  it("opens one full-bleed Setup required panel per profile on New thread", async () => {
    const browser = await createPublicPluginHarness();

    const firstOpen = await browser.openNewThreadPanel();
    const secondOpen = await browser.openNewThreadPanel();

    expect(firstOpen.layout).toBe("flush");
    expect(firstOpen.params).toEqual({ profileId: DEFAULT_PROFILE_ID });
    expect(firstOpen.created).toBe(true);
    expect(secondOpen.created).toBe(false);
    expect(secondOpen.panel).toBe(firstOpen.panel);
    await firstOpen.panel.findByText("Setup required");
    await browser.dispose();
  });

  it("reports the typed Setup required state from bb browser status", async () => {
    const browser = await createPublicPluginHarness();

    const cli = await browser.runStatusCli();

    expect(cli.exitCode).toBe(0);
    expect(browserStatusSchema.parse(JSON.parse(cli.stdout))).toEqual(
      browser.expectedStatus,
    );
    await browser.dispose();
  });

  it("keeps a projectless New thread status request unassigned to a host", async () => {
    const browser = await createPublicPluginHarness();

    const status = await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: null,
      profileId: DEFAULT_PROFILE_ID,
    });

    expect(status).toEqual(
      setupRequiredStatus({ hostId: null, profileId: DEFAULT_PROFILE_ID }),
    );
    await browser.dispose();
  });

  it("returns a typed setup-required tool failure without host mutation", async () => {
    const browser = await createPublicPluginHarness();

    const toolReply = await browser.runBrowserScript();
    const failure = browserScriptFailureSchema.parse(
      JSON.parse(toolReply.content[0]!.text),
    );

    expect(toolReply.isError).toBe(true);
    expect(failure.error).toEqual(browser.expectedStatus);
    expect(browser.setupInspectionTargets).toEqual([
      {
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
      },
    ]);
    expect(browser.sharedPortDeclarations).toEqual([]);
    await browser.dispose();
  });

  it("selects the static browser_script tool and bundled Browser skill", async () => {
    const browser = await createPublicPluginHarness();

    const capabilities = await browser.resolveAgentCapabilities();

    expect(capabilities.tools.map((tool) => tool.name)).toEqual([
      "browser_script",
    ]);
    expect(capabilities.skills).toEqual(["browser"]);
    await browser.dispose();
  });

  it("prints setup and purge plans before CLI consent and gates each mutation", async () => {
    const executor = createSimulatedPrivilegedExecutor();
    const browser = await createPublicPluginHarness({
      privilegedExecutor: executor,
    });

    const setupPlanReply = await browser.runBrowserCli(["setup", "--json"]);
    const setupPlan = browserSetupPlanSchema.parse(
      JSON.parse(setupPlanReply.stdout),
    );
    expect(setupPlan.state).toBe("pending");
    expect(setupPlan.nextStepId).toBe("dedicated-user");
    expect(executor.attemptedOperations).toEqual([]);

    const rejectedReply = await browser.runBrowserCli([
      "setup",
      "--step",
      "dedicated-user",
      "--confirm",
      "wrong",
      "--json",
    ]);
    const rejected = browserSetupResponseSchema.parse(
      JSON.parse(rejectedReply.stdout),
    );
    expect(rejected.outcome).toBe("confirmation-required");
    expect(executor.attemptedOperations).toEqual([]);

    const appliedReply = await browser.runBrowserCli([
      "setup",
      "--step",
      "dedicated-user",
      "--confirm",
      "Create bb-browser",
      "--json",
    ]);
    expect(
      browserSetupResponseSchema.parse(JSON.parse(appliedReply.stdout)),
    ).toMatchObject({
      outcome: "progressed",
      plan: { nextStepId: "system-packages" },
    });
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toEqual(["create-dedicated-user"]);

    const purgePlanReply = await browser.runBrowserCli(["purge", "--json"]);
    const purgePlan = browserPurgePlanSchema.parse(
      JSON.parse(purgePlanReply.stdout),
    );
    expect(purgePlan.targets).toHaveLength(4);
    expect(executor.successfulOperations).toHaveLength(1);

    const rejectedDisable = await browser.runBrowserCli([
      "disable",
      "--confirm",
      "wrong",
      "--json",
    ]);
    expect(
      browserLifecycleResponseSchema.parse(JSON.parse(rejectedDisable.stdout)),
    ).toMatchObject({ outcome: "confirmation-required" });
    expect(executor.successfulOperations).toHaveLength(1);

    const stopped = await browser.runBrowserCli([
      "disable",
      "--confirm",
      "Stop Browser processes",
      "--json",
    ]);
    expect(
      browserLifecycleResponseSchema.parse(JSON.parse(stopped.stdout)),
    ).toMatchObject({ outcome: "stopped", profilesRetained: true });
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toContain("stop-owned-processes");
    await browser.dispose();
  });

  it("R4-SETUP-PLAN-DETAILS exposes storage owner and permissions everywhere", async () => {
    const browser = await createPublicPluginHarness();
    const settings = browser.renderSettings();

    const jsonReply = await browser.runBrowserCli(["setup", "--json"]);
    const plan = browserSetupPlanSchema.parse(JSON.parse(jsonReply.stdout));
    const textReply = await browser.runBrowserCli(["setup"]);

    expect(plan.storageOwner).toBe("bb-browser");
    expect(plan.storageMode).toBe("0700");
    expect(textReply.stdout).toContain("Storage owner: bb-browser");
    expect(textReply.stdout).toContain("Storage permissions: 0700");
    await settings.findByText("bb-browser", { selector: "code" });
    await settings.findByText("0700", { selector: "code" });
    await browser.dispose();
  });

  it("R4-AUDIT-RECORDS records metadata-only setup, lifecycle, and purge activity", async () => {
    const executor = createSimulatedPrivilegedExecutor();
    const browser = await createPublicPluginHarness({
      privilegedExecutor: executor,
    });

    const setup = await browser.runBrowserCli([
      "setup",
      "--step",
      "dedicated-user",
      "--confirm",
      "Create bb-browser",
      "--json",
    ]);
    expect(setup.exitCode).toBe(0);

    const lifecycle = await browser.runBrowserCli([
      "disable",
      "--confirm",
      "Stop Browser processes",
      "--json",
    ]);
    expect(lifecycle.exitCode).toBe(0);

    const purgePlanReply = await browser.runBrowserCli(["purge", "--json"]);
    const purgePlan = browserPurgePlanSchema.parse(
      JSON.parse(purgePlanReply.stdout),
    );
    const purge = await browser.runBrowserCli([
      "purge",
      "--confirm",
      purgePlan.confirmationText,
      "--json",
    ]);
    expect(purge.exitCode).toBe(0);

    const activity = await browser.runBrowserCli(["activity", "--json"]);
    const records = browserActivityRecordsSchema.parse(
      JSON.parse(activity.stdout),
    );
    expect(await browser.runBrowserActivityRecords()).toEqual(records);

    expect(
      records.map(({ kind, action, outcome }) => ({
        kind,
        action,
        outcome,
      })),
    ).toEqual([
      { kind: "setup", action: "dedicated-user", outcome: "progressed" },
      { kind: "lifecycle", action: "disable", outcome: "stopped" },
      { kind: "purge", action: "purge", outcome: "purged" },
    ]);
    expect(records).toEqual(
      records.map((record) => ({
        ...record,
        actor: "owner",
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        interrupted: false,
      })),
    );
    expect(records.every((record) => record.occurredAt.length > 0)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("Create bb-browser");
    expect(JSON.stringify(records)).not.toContain("PURGE Browser installation");
    expect(executor.successfulOperations.length).toBeGreaterThan(0);
    await browser.dispose();
  });

  it("R4-CLI-REJECTION-STATUS returns nonzero for rejected and blocked actions", async () => {
    const executor = createSimulatedPrivilegedExecutor();
    const browser = await createPublicPluginHarness({
      privilegedExecutor: executor,
    });

    const rejectedSetup = await browser.runBrowserCli([
      "setup",
      "--step",
      "dedicated-user",
      "--confirm",
      "wrong",
      "--json",
    ]);
    expect(rejectedSetup.exitCode).toBe(1);
    expect(
      browserSetupResponseSchema.parse(JSON.parse(rejectedSetup.stdout))
        .outcome,
    ).toBe("confirmation-required");

    const blockedSetup = await browser.runBrowserCli([
      "setup",
      "--step",
      "protected-storage",
      "--confirm",
      "Configure protected Browser storage",
      "--json",
    ]);
    expect(blockedSetup.exitCode).toBe(1);
    expect(
      browserSetupResponseSchema.parse(JSON.parse(blockedSetup.stdout)).outcome,
    ).toBe("blocked");

    const rejectedPurge = await browser.runBrowserCli([
      "purge",
      "--confirm",
      "wrong",
      "--json",
    ]);
    expect(rejectedPurge.exitCode).toBe(1);
    expect(
      browserPurgeResponseSchema.parse(JSON.parse(rejectedPurge.stdout))
        .outcome,
    ).toBe("confirmation-required");

    const rejectedLifecycle = await browser.runBrowserCli([
      "disable",
      "--confirm",
      "wrong",
      "--json",
    ]);
    expect(rejectedLifecycle.exitCode).toBe(1);
    expect(
      browserLifecycleResponseSchema.parse(JSON.parse(rejectedLifecycle.stdout))
        .outcome,
    ).toBe("confirmation-required");
    expect(executor.attemptedOperations).toEqual([]);
    await browser.dispose();
  });

  it("shows Settings setup, lifecycle, and purge controls with consent gates", async () => {
    const executor = createSimulatedPrivilegedExecutor();
    const browser = await createPublicPluginHarness({
      privilegedExecutor: executor,
    });
    const settings = browser.renderSettings();

    await settings.findByText("Browser setup plan");
    const setupConfirmation = await settings.findByRole("textbox", {
      name: "Setup confirmation for dedicated-user",
    });
    const setupButton = await settings.findByRole("button", {
      name: "Confirm Create bb-browser",
    });
    fireEvent.change(setupConfirmation, { target: { value: "wrong" } });
    fireEvent.click(setupButton);
    await settings.findByText("Type exactly: Create bb-browser");
    expect(executor.attemptedOperations).toEqual([]);

    fireEvent.change(setupConfirmation, {
      target: { value: "Create bb-browser" },
    });
    fireEvent.click(setupButton);
    await settings.findByText("Create the dedicated browser user is complete.");
    expect(
      executor.successfulOperations.map((operation) => operation.kind),
    ).toEqual(["create-dedicated-user"]);

    expect(
      settings.getByRole("button", { name: "Disable Browser" }),
    ).toBeTruthy();
    expect(
      settings.getByRole("button", { name: "Uninstall Browser" }),
    ).toBeTruthy();
    fireEvent.click(
      settings.getByRole("button", { name: "Show destructive purge plan" }),
    );
    await settings.findByText("stop-owned-processes");
    await settings.findByText(/PURGE Browser installation/);
    await browser.dispose();
  });
});
