// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  browserDiagnosticsSchema,
  browserScriptFailureSchema,
  browserStatusSchema,
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";
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
});
