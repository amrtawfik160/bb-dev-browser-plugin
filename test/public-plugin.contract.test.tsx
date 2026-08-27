// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  browserProfileSchema,
  browserProfileInventorySchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";
import { createSimulatedPrivilegedExecutor } from "../host-operations.js";
import { createFileBrowserProfileStore } from "../profile-storage.js";
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

  it("returns a typed host-offline tool failure before selecting a profile", async () => {
    const browser = await createPublicPluginHarness({
      hostConnection: "disconnected",
    });

    const toolReply = await browser.runBrowserScriptWithProfile();
    const failure = browserScriptFailureSchema.parse(
      JSON.parse(toolReply.content[0]!.text),
    );

    expect(failure.error.state).toBe("host-offline");
    expect(failure.error.profileId).toBe(DEFAULT_PROFILE_ID);
    expect(browser.setupInspectionTargets).toEqual([]);
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

  it("manages a host-local profile through public RPC and the Browser CLI", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    const initial = await browser.runBrowserProfiles();
    const created = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Work",
      locale: "fr-FR",
      timezone: "Europe/Paris",
    });
    await browser.renameBrowserProfile({
      hostId: "host-browser-test",
      profileId: created.profileId,
      name: "Work laptop",
    });
    const selected = await browser.selectBrowserProfile({
      hostId: "host-browser-test",
      profileId: created.profileId,
    });
    const cli = await browser.runBrowserCli(["list", "--json"]);

    expect(initial.selectedProfileId).toBe(DEFAULT_PROFILE_ID);
    expect(selected.selectedProfileId).toBe(created.profileId);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      selectedProfileId: created.profileId,
    });
    expect(cli.stdout).toContain("Work laptop");

    const cliCreated = browserProfileSchema.parse(
      JSON.parse(
        (
          await browser.runBrowserCli([
            "create",
            "--name",
            "CLI profile",
            "--locale",
            "en-GB",
            "--timezone",
            "Europe/London",
            "--json",
          ])
        ).stdout,
      ),
    );
    const cliRenamed = browserProfileSchema.parse(
      JSON.parse(
        (
          await browser.runBrowserCli([
            "rename",
            "--profile",
            cliCreated.profileId,
            "--name",
            "CLI renamed",
            "--locale",
            "en-US",
            "--timezone",
            "UTC",
            "--json",
          ])
        ).stdout,
      ),
    );
    expect(cliRenamed).toMatchObject({
      name: "CLI renamed",
      locale: "en-US",
      timezone: "UTC",
    });
    const cliSelected = browserProfileInventorySchema.parse(
      JSON.parse(
        (
          await browser.runBrowserCli([
            "select",
            "--profile",
            cliRenamed.profileId,
            "--json",
          ])
        ).stdout,
      ),
    );
    expect(cliSelected.selectedProfileId).toBe(cliRenamed.profileId);
    await browser.dispose();
  });

  it("resolves browser_script to the selected profile while honoring an explicit profile", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const created = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Work",
    });
    await browser.selectBrowserProfile({
      hostId: "host-browser-test",
      profileId: created.profileId,
    });

    const selectedScript = browserScriptFailureSchema.parse(
      JSON.parse(
        (await browser.runBrowserScriptWithProfile()).content[0]!.text,
      ),
    );
    const explicitScript = browserScriptFailureSchema.parse(
      JSON.parse(
        (await browser.runBrowserScriptWithProfile(DEFAULT_PROFILE_ID))
          .content[0]!.text,
      ),
    );
    const missing = browserScriptFailureSchema.parse(
      JSON.parse(
        (await browser.runBrowserScriptWithProfile("missing-profile"))
          .content[0]!.text,
      ),
    );

    expect(selectedScript.error.profileId).toBe(created.profileId);
    expect(explicitScript.error.profileId).toBe(DEFAULT_PROFILE_ID);
    expect(missing.error.message).toContain("not available on this host");
    await browser.dispose();
  });

  it("R5-03 keeps selected Browser Profiles separate for each project on one host", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const projectAProfile = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Project A",
    });
    const projectBProfile = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Project B",
    });

    await browser.selectBrowserProfile(
      {
        hostId: "host-browser-test",
        profileId: projectAProfile.profileId,
      },
      { projectId: "project-a" },
    );
    await browser.selectBrowserProfile(
      {
        hostId: "host-browser-test",
        profileId: projectBProfile.profileId,
      },
      { projectId: "project-b" },
    );

    const projectAStatus = await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: "project-a",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      profileSelection: "selected",
    });
    const projectBStatus = await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: "project-b",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      profileSelection: "selected",
    });
    const projectAInventory = await browser.runBrowserProfiles(
      "host-browser-test",
      { projectId: "project-a" },
    );
    const projectBInventory = await browser.runBrowserProfiles(
      "host-browser-test",
      { projectId: "project-b" },
    );

    expect(projectAStatus.profileId).toBe(projectAProfile.profileId);
    expect(projectBStatus.profileId).toBe(projectBProfile.profileId);
    expect(projectAInventory.selectedProfileId).toBe(projectAProfile.profileId);
    expect(projectBInventory.selectedProfileId).toBe(projectBProfile.profileId);
    await browser.dispose();
  });

  it("R5-04 returns a typed unavailable status before probing an explicit missing profile", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    const status = await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: "profile-missing",
    });

    expect(status.state).toBe("repair-required");
    expect(status.message).toContain("not available on this host");
    expect(browser.setupInspectionTargets).toEqual([]);
    await browser.dispose();
  });

  it("R5-05 retains metadata-only activity for successful and failed profile lifecycle", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const created = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Audited profile",
    });
    await browser.renameBrowserProfile({
      hostId: "host-browser-test",
      profileId: created.profileId,
      name: "Audited renamed",
    });
    await browser.selectBrowserProfile({
      hostId: "host-browser-test",
      profileId: created.profileId,
    });
    const failed = await browser.runBrowserCli([
      "rename",
      "--profile",
      "profile-missing",
      "--name",
      "Should not exist",
      "--json",
    ]);

    const profileActivity = browserActivityRecordsSchema.parse(
      JSON.parse(
        (
          await browser.runBrowserCli([
            "activity",
            "--profile",
            created.profileId,
            "--json",
          ])
        ).stdout,
      ),
    );
    const failedActivity = browserActivityRecordsSchema.parse(
      JSON.parse(
        (
          await browser.runBrowserCli([
            "activity",
            "--profile",
            "profile-missing",
            "--json",
          ])
        ).stdout,
      ),
    );

    expect(failed.exitCode).toBe(1);
    expect(
      profileActivity.map(({ kind, action, outcome }) => ({
        kind,
        action,
        outcome,
      })),
    ).toEqual([
      { kind: "lifecycle", action: "create", outcome: "succeeded" },
      { kind: "lifecycle", action: "rename", outcome: "succeeded" },
      { kind: "lifecycle", action: "select", outcome: "succeeded" },
    ]);
    expect(
      failedActivity.map(({ kind, action, outcome }) => ({
        kind,
        action,
        outcome,
      })),
    ).toEqual([{ kind: "lifecycle", action: "rename", outcome: "failed" }]);
    expect(JSON.stringify(profileActivity)).not.toMatch(
      /Audited profile|Audited renamed|Should not exist/,
    );
    await browser.dispose();
  });

  it("offers deterministic host choices when a new-thread project has multiple repository hosts", async () => {
    const browser = await createPublicPluginHarness({
      hostIds: ["host-a", "host-b"],
      projectHostIds: ["host-a", "host-b"],
    });

    const choices = await browser.runBrowserHostChoices({
      surface: "new-thread",
      projectId: "project-browser-test",
    });
    const ambiguous = await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: "project-browser-test",
      profileId: DEFAULT_PROFILE_ID,
    });
    const selected = await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: "project-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      hostId: "host-b",
      profileSelection: "selected",
    });

    expect(choices.map((choice) => choice.hostId)).toEqual([
      "host-a",
      "host-b",
    ]);
    expect(ambiguous.hostId).toBeNull();
    expect(selected.hostId).toBe("host-b");
    await browser.dispose();
  });

  it("exposes profile creation, rename, and selection controls in Settings", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const settings = browser.renderSettings();

    await settings.findByText("Browser Profiles");
    await settings.findByText(DEFAULT_PROFILE_ID);
    const name = await settings.findByRole("textbox", {
      name: "New Browser Profile name",
    });
    fireEvent.change(name, { target: { value: "Settings profile" } });
    fireEvent.click(
      settings.getByRole("button", { name: "Create Browser Profile" }),
    );
    await settings.findByText("Settings profile");

    const rename = settings.getByRole("textbox", {
      name: "Rename Browser Profile Settings profile",
    });
    fireEvent.change(rename, { target: { value: "Settings renamed" } });
    fireEvent.click(
      settings.getByRole("button", { name: "Rename Settings profile" }),
    );
    await settings.findByText("Settings renamed");

    fireEvent.change(
      settings.getByRole("textbox", {
        name: "Locale for Browser Profile Settings renamed",
      }),
      { target: { value: "de-DE" } },
    );
    fireEvent.change(
      settings.getByRole("textbox", {
        name: "Timezone for Browser Profile Settings renamed",
      }),
      { target: { value: "Europe/Berlin" } },
    );
    fireEvent.click(
      settings.getByRole("button", { name: "Save settings Settings renamed" }),
    );
    await settings.findByText(/Locale: de-DE/);

    fireEvent.click(
      settings.getByRole("button", { name: "Select Settings renamed" }),
    );
    await settings.findByText(/Selected: profile-/);
    await browser.dispose();
  });

  it("lets a panel choose a host-local Browser Profile", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const created = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Panel profile",
    });
    const panel = await browser.openExistingThreadPanel();
    const picker = await panel.panel.findByRole("combobox", {
      name: "Browser Profile",
    });

    fireEvent.change(picker, { target: { value: created.profileId } });
    await panel.panel.findByText(created.profileId, { selector: "p" });
    expect(browser.setupInspectionTargets.at(-1)).toEqual({
      hostId: "host-browser-test",
      profileId: created.profileId,
    });
    await browser.dispose();
  });

  it("shows the host picker in an ambiguous New thread panel", async () => {
    const browser = await createPublicPluginHarness({
      hostIds: ["host-a", "host-b"],
      projectHostIds: ["host-a", "host-b"],
    });
    const panel = await browser.openNewThreadPanel();
    const hostPicker = await panel.panel.findByRole("combobox", {
      name: "Workspace host",
    });

    fireEvent.change(hostPicker, { target: { value: "host-b" } });
    await panel.panel.findByRole("combobox", { name: "Browser Profile" });
    await browser.dispose();
  });

  it("keeps public UI and CLI profile operations isolated across simulated hosts", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-public-"));
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-public-test",
    });
    const hostA = await createPublicPluginHarness({
      hostId: "host-a",
      profileStore,
      snapshot: preparedSnapshot,
    });
    const hostB = await createPublicPluginHarness({
      hostId: "host-b",
      profileStore,
      snapshot: preparedSnapshot,
    });

    try {
      const settings = hostA.renderSettings();
      const name = await settings.findByRole("textbox", {
        name: "New Browser Profile name",
      });
      fireEvent.change(name, { target: { value: "Only host A" } });
      fireEvent.click(
        settings.getByRole("button", { name: "Create Browser Profile" }),
      );
      await settings.findByText("Only host A");

      const profilesA = await hostA.runBrowserProfiles();
      const hostAProfile = profilesA.profiles.find(
        (profile) => profile.name === "Only host A",
      );
      expect(hostAProfile).toBeDefined();

      const profilesB = browserProfileInventorySchema.parse(
        JSON.parse((await hostB.runBrowserCli(["list", "--json"])).stdout),
      );
      expect(profilesB.profiles.map((profile) => profile.name)).toEqual([]);

      const selectedA = browserProfileInventorySchema.parse(
        JSON.parse(
          (
            await hostA.runBrowserCli([
              "select",
              "--profile",
              hostAProfile!.profileId,
              "--json",
            ])
          ).stdout,
        ),
      );
      expect(selectedA.selectedProfileId).toBe(hostAProfile!.profileId);
      expect((await hostB.runBrowserProfiles()).selectedProfileId).toBe(
        DEFAULT_PROFILE_ID,
      );
    } finally {
      await hostA.dispose();
      await hostB.dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
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

  it("R5-01 initializes the default profile only after confirmed setup completes", async () => {
    const executor = createSimulatedPrivilegedExecutor();
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      privilegedExecutor: executor,
    });

    expect((await browser.runBrowserProfiles()).profiles).toEqual([]);
    const setupSteps = [
      ["dedicated-user", "Create bb-browser"],
      ["system-packages", "Install Browser packages"],
      ["protected-storage", "Configure protected Browser storage"],
    ] as const;
    for (const [stepId, confirmation] of setupSteps) {
      const reply = await browser.runBrowserCli([
        "setup",
        "--step",
        stepId,
        "--confirm",
        confirmation,
        "--json",
      ]);
      expect(reply.exitCode).toBe(0);
    }

    const inventory = await browser.runBrowserProfiles();
    expect(inventory.profiles.map((profile) => profile.profileId)).toEqual([
      DEFAULT_PROFILE_ID,
    ]);
    expect(executor.successfulOperations).toHaveLength(3);
    await browser.dispose();
  });

  it("R5-01 keeps pre-setup selected status reads free of profile storage writes", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-public-"));
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-public-test",
    });
    const browser = await createPublicPluginHarness({ profileStore });

    try {
      const status = browserStatusSchema.parse(
        JSON.parse((await browser.runStatusCli()).stdout),
      );

      expect(status.state).toBe("setup-required");
      expect(await readdir(rootDirectory)).toEqual([]);
    } finally {
      await browser.dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
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
