// @vitest-environment jsdom
import { act, fireEvent, waitFor } from "@testing-library/react";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  browserActivityRecordsSchema,
  browserActivityOutboxSchema,
  browserActivityExportSchema,
  browserActivityClearResponseSchema,
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
  browserProfileRecoveryResponseSchema,
  DEFAULT_PROFILE_ID,
  PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
  RESET_PROFILE_CONFIRMATION,
  setupRequiredStatus,
  type BrowserGrantRequest,
  type BrowserStatus,
} from "../contracts.js";
import { createPublicPluginHarness } from "./public-plugin-harness.js";
import { projectLoopbackAlias } from "../authorization.js";
import { createSimulatedPrivilegedExecutor } from "../host-operations.js";
import {
  createFileBrowserProfileStore,
  profileStoragePaths,
} from "../profile-storage.js";
import type { HostProbeSnapshot } from "../readiness.js";
import type {
  BrowserProfileBackupResult,
  BrowserProfileRecovery,
} from "../profile-recovery.js";

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

const profileImportCommand = ["imp", "ort"].join("");

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

async function grantDefaultProfileOrigin(
  browser: Awaited<ReturnType<typeof createPublicPluginHarness>>,
  origin: string,
) {
  await browser.createBrowserProfile({
    hostId: "host-browser-test",
    name: `Grant ${origin}`,
  });
  return browser.createBrowserGrant({
    projectId: "project-browser-test",
    hostId: "host-browser-test",
    profileId: DEFAULT_PROFILE_ID,
    originScope: origin,
    wholeWeb: false,
    fileTransfer: false,
    invalidCertificateOrigins: [],
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

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

  it("keeps grant administration off the agent-facing CLI and on Settings RPC", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Owner authority target",
    });

    const cli = await browser.runBrowserCli(["grant", "list"]);
    expect(cli.exitCode).not.toBe(0);
    expect(cli.stderr).toContain("Usage: bb browser");
    expect(cli.stderr).not.toContain("|grant|");

    const created = await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://owner-settings.example.test",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    expect(await browser.inspectBrowserGrant(created.grantId)).toMatchObject(
      created,
    );
    expect(await browser.revokeBrowserGrant(created.grantId)).toMatchObject({
      grantId: created.grantId,
      outcome: "revoked",
    });
    await browser.dispose();
  });

  it("keeps safe request reads registered while removing unsupported agent mutations", async () => {
    const browser = await createPublicPluginHarness();

    try {
      const help = await browser.runBrowserCli([]);
      const registeredNames = browser
        .registeredBrowserCliCommands()
        .map((command) => command.name);

      expect(help.stderr).toContain("requests [--json]");
      expect(help.stderr).toContain("request-status --request <id>");
      expect(help.stderr).not.toContain("request-decide");
      expect(help.stderr).not.toContain("request-revoke");
      expect(registeredNames).toContain("requests");
      expect(registeredNames).toContain("request-status");
      expect(registeredNames).not.toContain("request-decide");
      expect(registeredNames).not.toContain("request-revoke");

      const decisionCommand = await browser.runBrowserCli([
        "request-decide",
        "--request",
        "grant-request-foreign",
      ]);
      expect(decisionCommand.stderr).toContain("Usage: bb browser");
      expect(decisionCommand.stderr).not.toContain("owner Settings");

      const decisionOption = await browser.runBrowserCli([
        "requests",
        "--decision",
        "retry",
      ]);
      expect(decisionOption.stderr).toContain("Unknown option: --decision");
    } finally {
      await browser.dispose();
    }
  });

  it("keeps requests help, parser, and registration metadata in parity", async () => {
    const browser = await createPublicPluginHarness();

    try {
      expect(
        browser
          .registeredBrowserCliCommands()
          .find((command) => command.name === "requests"),
      ).toEqual({
        name: "requests",
        summary: "List Browser Grant Requests",
        usage: "bb browser requests [--json]",
      });
      const parsed = await browser.runBrowserCli(["requests", "--json"]);
      expect(parsed).toMatchObject({ exitCode: 0, stdout: "[]" });
    } finally {
      await browser.dispose();
    }
  });

  it("gates browser_script through the owner grant create, inspect, and revoke contract", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "done" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Grant target",
    });

    const beforeGrant = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://app.example.test/",
    });
    const denied = browserScriptFailureSchema.parse(
      JSON.parse(beforeGrant.content[0]!.text),
    );
    expect(beforeGrant.isError).toBe(true);
    expect(denied.error.code).toBe("origin_denied");

    const created = await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "HTTPS://APP.Example.test:443/",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    expect(created).toMatchObject({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://app.example.test",
      wholeWeb: false,
    });

    const allowed = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://app.example.test/",
    });
    expect(allowed.isError).toBe(false);

    expect(await browser.inspectBrowserGrant(created.grantId)).toMatchObject(
      created,
    );

    expect(await browser.revokeBrowserGrant(created.grantId)).toEqual({
      grantId: created.grantId,
      outcome: "revoked",
    });

    const afterRevoke = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://app.example.test",
    });
    expect(afterRevoke.isError).toBe(true);
    expect(
      browserScriptFailureSchema.parse(JSON.parse(afterRevoke.content[0]!.text))
        .error.code,
    ).toBe("origin_denied");
    await browser.dispose();
  });

  it("returns one exact non-blocking request across browser_script, Settings RPC, and safe CLI status", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "retried" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Grant request target",
    });

    const denied = await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Do not retain this purpose",
      code: "return 'do not resume';",
      destinationOrigin: "HTTPS://APP.Example.test:443/",
      fileTransfer: true,
    });
    const failure = browserScriptFailureSchema.parse(
      JSON.parse(denied.content[0]!.text),
    );
    if (failure.error.state !== "origin-denied") {
      throw new Error("expected an origin denial");
    }
    const request = failure.error.grantRequest;
    expect(request).toMatchObject({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      origin: "https://app.example.test",
      requestedElevations: { fileTransfer: true, invalidCertificate: false },
      status: "pending",
    });
    expect(JSON.stringify(request)).not.toContain("Do not retain");
    expect(JSON.stringify(request)).not.toContain("do not resume");
    expect(await browser.listBrowserGrantRequests()).toContainEqual(request);

    const cli = await browser.runBrowserCli(["requests", "--json"]);
    expect(cli.exitCode).toBe(0);
    expect(JSON.parse(cli.stdout!)).toContainEqual(request);

    const settings = browser.renderSettings();
    await settings.findByText("Browser Grant Requests");
    fireEvent.click(
      await settings.findByRole("button", {
        name: "Inspect Browser Grant Requests",
      }),
    );
    await settings.findByRole("list", { name: "Browser Grant Request list" });
    await browser.dispose();
  });

  it("scopes agent-facing request list and status to the invoking project, host, profile, and installation", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Scoped request target",
      });
      const ownDenied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://scoped-own.example.test",
      });
      const foreignProjectDenied = await browser.runBrowserScriptWithProfile(
        undefined,
        {
          destinationOrigin: "https://scoped-foreign-project.example.test",
          projectId: "project-foreign",
          threadId: "thread-foreign-project",
        },
      );
      const otherProfile = (
        await browser.runBrowserProfiles("host-browser-test")
      ).profiles.find((profile) => profile.name === "Scoped request target");
      if (otherProfile === undefined) {
        throw new Error("expected the additional Browser Profile");
      }
      const foreignProfileDenied = await browser.runBrowserScriptWithProfile(
        otherProfile.profileId,
        { destinationOrigin: "https://scoped-foreign-profile.example.test" },
      );
      const ownRequestId = browserScriptFailureSchema.parse(
        JSON.parse(ownDenied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const foreignProjectRequestId = browserScriptFailureSchema.parse(
        JSON.parse(foreignProjectDenied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const foreignProfileRequestId = browserScriptFailureSchema.parse(
        JSON.parse(foreignProfileDenied.content[0]!.text),
      ).error.grantRequest!.requestId;

      const list = await browser.runBrowserCli(["requests", "--json"]);
      expect(list.exitCode).toBe(0);
      expect(JSON.parse(list.stdout!)).toEqual([
        expect.objectContaining({ requestId: ownRequestId }),
      ]);

      for (const foreignRequestId of [
        foreignProjectRequestId,
        foreignProfileRequestId,
      ]) {
        const status = await browser.runBrowserCli([
          "request-status",
          "--request",
          foreignRequestId,
          "--json",
        ]);
        expect(status.exitCode).toBe(1);
        expect(status.stderr).toContain("was not found");
      }
    } finally {
      await browser.dispose();
    }
  });

  it("keeps approval non-resuming and requires an explicit current-state retry", async () => {
    let hostCalls = 0;
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "retried" } },
      browserScriptStarted: () => {
        hostCalls += 1;
      },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Retry target",
    });
    const denied = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://retry.example.test",
    });
    const requestId = browserScriptFailureSchema.parse(
      JSON.parse(denied.content[0]!.text),
    ).error.grantRequest!.requestId;

    expect(hostCalls).toBe(0);
    const approval = await browser.decideBrowserGrantRequest({
      requestId,
      decision: "retry",
    });
    expect(approval.outcome).toBe("retry-approved");
    expect(hostCalls).toBe(0);

    const retry = await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Fresh state retry",
      code: "return page.url();",
      destinationOrigin: "https://retry.example.test",
    });
    expect(retry.isError).toBe(false);
    expect(hostCalls).toBe(1);
    expect((await browser.inspectBrowserGrantRequest(requestId))?.status).toBe(
      "consumed",
    );
    await browser.dispose();
  });

  it("shows owner request decisions and revocation in Settings and CLI without exposing grant administration", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "done" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Request lifecycle target",
    });
    const denied = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://lifecycle-request.example.test",
    });
    const requestId = browserScriptFailureSchema.parse(
      JSON.parse(denied.content[0]!.text),
    ).error.grantRequest!.requestId;
    const deniedDecision = await browser.decideBrowserGrantRequest({
      requestId,
      decision: "deny",
    });
    expect(deniedDecision.request.status).toBe("denied");
    expect(await browser.runBrowserCli(["grant", "list"])).toMatchObject({
      exitCode: 1,
    });
    expect(
      JSON.parse(
        (
          await browser.runBrowserCli([
            "request-status",
            "--request",
            requestId,
            "--json",
          ])
        ).stdout!,
      ),
    ).toMatchObject({ requestId, status: "denied" });
    await browser.dispose();
  });

  it("gives Settings an owner-only request inspector with deny and every decision control", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Settings request controls",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://settings-request.example.test",
        fileTransfer: true,
      });
      const request = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!;
      const settings = browser.renderSettings();

      fireEvent.click(
        await settings.findByRole("button", {
          name: "Inspect Browser Grant Requests",
        }),
      );
      const list = await settings.findByRole("list", {
        name: "Browser Grant Request list",
      });
      expect(list.textContent).toContain(request.requestId);
      expect(list.textContent).toContain("pending");
      expect(list.textContent).toContain(request.origin);
      expect(
        settings.getByRole("button", {
          name: `Deny Browser Grant Request ${request.requestId}`,
        }),
      ).toBeDefined();
      expect(
        settings.getByRole("button", {
          name: `Approve Browser Grant Request ${request.requestId} for one retry`,
        }),
      ).toBeDefined();
      expect(
        settings.getByRole("button", {
          name: `Approve Browser Grant Request ${request.requestId} for one hour`,
        }),
      ).toBeDefined();
      expect(
        settings.getByRole("button", {
          name: `Persist Browser Grant Request ${request.requestId}`,
        }),
      ).toBeDefined();
      expect(
        settings.getByRole("button", {
          name: `Revoke Browser Grant Request ${request.requestId}`,
        }),
      ).toBeDefined();

      fireEvent.click(
        settings.getByRole("button", {
          name: `Deny Browser Grant Request ${request.requestId}`,
        }),
      );
      await settings.findByText(
        new RegExp(`${request.requestId}.*denied`, "i"),
      );
      expect(
        (await browser.inspectBrowserGrantRequest(request.requestId))?.status,
      ).toBe("denied");
    } finally {
      await browser.dispose();
    }
  });

  it("approves one retry from Settings without resuming the denied script and shows consumed state after an explicit retry", async () => {
    let hostCalls = 0;
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "retried" } },
      browserScriptStarted: () => {
        hostCalls += 1;
      },
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Settings retry target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://settings-retry.example.test",
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const settings = browser.renderSettings();
      fireEvent.click(
        await settings.findByRole("button", {
          name: "Inspect Browser Grant Requests",
        }),
      );
      fireEvent.click(
        await settings.findByRole("button", {
          name: `Approve Browser Grant Request ${requestId} for one retry`,
        }),
      );
      await settings.findByText(
        new RegExp(`${requestId}.*retry-approved`, "i"),
      );
      expect(hostCalls).toBe(0);

      const retry = await browser.runBrowserScriptWithProfile(undefined, {
        purpose: "Fresh current-state retry",
        code: "return page.url();",
        destinationOrigin: "https://settings-retry.example.test",
      });
      expect(retry.isError).toBe(false);
      expect(hostCalls).toBe(1);
      fireEvent.click(
        settings.getByRole("button", {
          name: "Inspect Browser Grant Requests",
        }),
      );
      const list = await settings.findByRole("list", {
        name: "Browser Grant Request list",
      });
      expect(list.textContent).toMatch(
        new RegExp(`${requestId}.*consumed`, "i"),
      );
    } finally {
      await browser.dispose();
    }
  });

  it("approves one hour, requires a second confirmation for persistence, and revokes from Settings", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Settings duration target",
      });

      const oneHourDenied = await browser.runBrowserScriptWithProfile(
        undefined,
        {
          destinationOrigin: "https://settings-hour.example.test",
        },
      );
      const oneHourId = browserScriptFailureSchema.parse(
        JSON.parse(oneHourDenied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const hourSettings = browser.renderSettings();
      fireEvent.click(
        await hourSettings.findByRole("button", {
          name: "Inspect Browser Grant Requests",
        }),
      );
      fireEvent.click(
        await hourSettings.findByRole("button", {
          name: `Approve Browser Grant Request ${oneHourId} for one hour`,
        }),
      );
      await hourSettings.findByText(
        new RegExp(`${oneHourId}.*one-hour-approved`, "i"),
      );
      fireEvent.click(
        hourSettings.getByRole("button", {
          name: `Revoke Browser Grant Request ${oneHourId}`,
        }),
      );
      await hourSettings.findByText(new RegExp(`${oneHourId}.*revoked`, "i"));

      const persistentDenied = await browser.runBrowserScriptWithProfile(
        undefined,
        {
          destinationOrigin: "https://settings-persist.example.test",
          fileTransfer: true,
        },
      );
      const persistentId = browserScriptFailureSchema.parse(
        JSON.parse(persistentDenied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const persistentSettings = browser.renderSettings();
      fireEvent.click(
        await persistentSettings.findByRole("button", {
          name: "Inspect Browser Grant Requests",
        }),
      );
      fireEvent.click(
        await persistentSettings.findByRole("button", {
          name: `Persist Browser Grant Request ${persistentId}`,
        }),
      );
      await persistentSettings.findByText(/second confirmation/i);
      fireEvent.change(
        persistentSettings.getByRole("textbox", {
          name: `Persistent Browser Grant confirmation ${persistentId}`,
        }),
        { target: { value: "Persist Browser elevated access" } },
      );
      fireEvent.click(
        persistentSettings.getByRole("button", {
          name: `Persist Browser Grant Request ${persistentId}`,
        }),
      );
      await persistentSettings.findByText(
        new RegExp(`${persistentId}.*persisted`, "i"),
      );
      expect(
        (await browser.inspectBrowserGrantRequest(persistentId))?.status,
      ).toBe("approved");
    } finally {
      await browser.dispose();
    }
  });

  it("links direct persistent grant revocation back to its request atomically", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Persistent revocation target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://persistent-revocation.example.test",
        fileTransfer: true,
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const persisted = await browser.decideBrowserGrantRequest({
        requestId,
        decision: "persist",
        persistenceConfirmation: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION,
      });
      const grantId = persisted.grant?.grantId;
      if (grantId === undefined) throw new Error("expected a persistent grant");

      expect(await browser.revokeBrowserGrant(grantId)).toMatchObject({
        grantId,
        outcome: "revoked",
      });
      expect(await browser.inspectBrowserGrantRequest(requestId)).toMatchObject(
        { status: "revoked", revokedAt: expect.any(String) },
      );
      expect(await browser.runBrowserActivityRecords()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actor: "owner",
            requestId,
            action: "grant-request-revoked",
            outcome: "revoked",
          }),
        ]),
      );

      const reRequested = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://persistent-revocation.example.test",
        fileTransfer: true,
      });
      expect(
        browserScriptFailureSchema.parse(
          JSON.parse(reRequested.content[0]!.text),
        ).error.grantRequest?.requestId,
      ).not.toBe(requestId);
    } finally {
      await browser.dispose();
    }
  });

  it("renders expired requests and keeps request identity plus explicit retry guidance on the panel and browser_script", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Expired request target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        purpose: "Secret denied purpose",
        code: "return 'secret denied script';",
        destinationOrigin: "https://expired-request.example.test",
      });
      const failure = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      );
      const requestId = failure.error.grantRequest!.requestId;
      expect(failure.error.message).toContain(requestId);
      expect(failure.error.message).toMatch(/explicitly retry/i);
      expect(failure.error.message).toMatch(/current page state/i);
      expect(failure.error.message).not.toContain("Secret denied purpose");
      expect(failure.error.message).not.toContain("secret denied script");

      const panel = await browser.openExistingThreadPanel();
      await panel.panel.findByText(requestId);
      await panel.panel.findByText(/explicitly retry.*current page state/i);

      vi.setSystemTime(new Date("2026-08-28T00:16:00.000Z"));
      const settings = browser.renderSettings();
      fireEvent.click(
        await settings.findByRole("button", {
          name: "Inspect Browser Grant Requests",
        }),
      );
      const list = await settings.findByRole("list", {
        name: "Browser Grant Request list",
      });
      expect(list.textContent).toMatch(
        new RegExp(`${requestId}.*expired`, "i"),
      );
    } finally {
      await browser.dispose();
      vi.useRealTimers();
    }
  });

  it("refreshes panel request notices after an external request transition", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Live request target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://live-request.example.test",
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const panel = await browser.openExistingThreadPanel();
      await panel.panel.findByText(requestId);

      await browser.decideBrowserGrantRequest({
        requestId,
        decision: "one-hour",
      });
      window.dispatchEvent(new Event("focus"));

      const notices = await panel.panel.findByRole("region", {
        name: "Browser Grant Request notices",
      });
      await waitFor(() =>
        expect(notices.textContent).toMatch(
          new RegExp(`${requestId}.*approved`, "i"),
        ),
      );
    } finally {
      await browser.dispose();
    }
  });

  it("ignores an older panel refresh that resolves after a newer refresh", async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstResponse = deferred<BrowserGrantRequest[]>();
    const secondResponse = deferred<BrowserGrantRequest[]>();
    const snapshots: BrowserGrantRequest[][] = [];
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      deferGrantRequestRpc: (requests, callIndex) => {
        snapshots[callIndex] = requests;
        if (callIndex === 0) {
          firstStarted.resolve();
          return firstResponse.promise;
        }
        secondStarted.resolve();
        return secondResponse.promise;
      },
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Overlapping refresh target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://overlapping-refresh.example.test",
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const panel = await browser.openExistingThreadPanel();
      await firstStarted.promise;

      await browser.decideBrowserGrantRequest({
        requestId,
        decision: "one-hour",
      });
      window.dispatchEvent(new Event("focus"));
      await secondStarted.promise;

      await act(async () => {
        secondResponse.resolve(snapshots[1]!);
        await secondResponse.promise;
      });
      const notices = await panel.panel.findByRole("region", {
        name: "Browser Grant Request notices",
      });
      expect(notices.textContent).toMatch(
        new RegExp(`${requestId}.*approved`, "i"),
      );

      await act(async () => {
        firstResponse.resolve(snapshots[0]!);
        await firstResponse.promise;
      });
      expect(notices.textContent).toMatch(
        new RegExp(`${requestId}.*approved`, "i"),
      );
      expect(notices.textContent).not.toMatch(
        new RegExp(`${requestId}.*pending`, "i"),
      );
    } finally {
      await browser.dispose();
    }
  });

  it("does not refresh after unmount while a panel request is in flight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const requestStarted = deferred<void>();
    const response = deferred<BrowserGrantRequest[]>();
    let refreshCalls = 0;
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      deferGrantRequestRpc: (requests) => {
        refreshCalls += 1;
        requestStarted.resolve();
        return response.promise.then(() => requests);
      },
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Unmounted refresh target",
      });
      await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://unmounted-refresh.example.test",
      });
      const panel = await browser.openExistingThreadPanel();
      await requestStarted.promise;

      panel.panel.lifecycle.unmount();
      await act(async () => {
        response.resolve([]);
        await response.promise;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      window.dispatchEvent(new Event("focus"));
      await vi.runAllTimersAsync();

      expect(refreshCalls).toBe(1);
      expect(panel.panel.container.innerHTML).toBe("");
    } finally {
      await browser.dispose();
      vi.useRealTimers();
    }
  });

  it("persists one in-flight temporary expiry before aborting the browser call", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    let signalHostCallStarted!: () => void;
    const hostCallStarted = new Promise<void>((resolve) => {
      signalHostCallStarted = resolve;
    });
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptDelayMs: 2 * 60 * 60 * 1000,
      browserScriptStarted: signalHostCallStarted,
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Temporary expiry target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://temporary-expiry.example.test",
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      expect(
        (
          await browser.decideBrowserGrantRequest({
            requestId,
            decision: "one-hour",
          })
        ).outcome,
      ).toBe("one-hour-approved");

      const operation = browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://temporary-expiry.example.test",
      });
      await hostCallStarted;
      const operationOutcome = operation.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await Promise.resolve();

      const events = browser
        .persistedGrantRequestEvents()
        .filter((event) => event.request_id === requestId);
      expect(events.at(-1)).toMatchObject({
        event_type: "expired",
        event_at: "2026-08-28T01:00:00.000Z",
      });
      expect(
        events.filter((event) => event.event_type === "expired"),
      ).toHaveLength(1);
      expect(await operationOutcome).toMatchObject({
        message: "browser script aborted",
      });
      expect(
        (await browser.runBrowserActivityRecords()).filter(
          (record) =>
            record.requestId === requestId &&
            record.action === "grant-request-expired",
        ),
      ).toHaveLength(1);
    } finally {
      await browser.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps CLI request inspection safe and fails closed for agent-facing decisions while recording metadata-only request lifecycle", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "CLI request target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        purpose: "Do not store this purpose",
        code: "return 'do not store this script';",
        destinationOrigin: "https://cli-request.example.test",
        fileTransfer: true,
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      const statusText = await browser.runBrowserCli([
        "request-status",
        "--request",
        requestId,
      ]);
      expect(statusText.exitCode).toBe(0);
      expect(statusText.stdout).toContain(requestId);
      expect(statusText.stdout).toContain("pending");

      const cliDecision = await browser.runBrowserCli([
        "request-decide",
        "--request",
        requestId,
        "--decision",
        "one-hour",
        "--json",
      ]);
      expect(cliDecision.exitCode).toBe(1);
      expect(cliDecision.stderr).toContain("Usage: bb browser");
      expect(
        (await browser.inspectBrowserGrantRequest(requestId))?.status,
      ).toBe("pending");
      const cliRevoke = await browser.runBrowserCli([
        "request-revoke",
        "--request",
        requestId,
        "--json",
      ]);
      expect(cliRevoke.exitCode).toBe(1);
      expect(cliRevoke.stderr).toContain("Usage: bb browser");

      const approved = await browser.decideBrowserGrantRequest({
        requestId,
        decision: "retry",
      });
      expect(approved.outcome).toBe("retry-approved");
      const activity = await browser.runBrowserActivityRecords();
      const requestActivity = activity.filter(
        (record) => "requestId" in record,
      );
      expect(requestActivity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId,
            action: "grant-request-created",
            grantScope: "https://cli-request.example.test",
            outcome: "pending",
          }),
          expect.objectContaining({
            requestId,
            action: "grant-request-approved",
            outcome: "retry-approved",
          }),
        ]),
      );
      const serialized = JSON.stringify({
        statusText,
        cliDecision,
        cliRevoke,
        activity,
      });
      expect(serialized).not.toContain("Do not store this purpose");
      expect(serialized).not.toContain("do not store this script");
    } finally {
      await browser.dispose();
    }
  });

  it("keeps whole-web, file-transfer, and invalid-certificate elevations independent", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "done" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Elevation target",
    });
    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://app.example.test",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "*",
      wholeWeb: true,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    const wholeWebAllowed = await browser.runBrowserScriptWithProfile(
      undefined,
      { destinationOrigin: "https://not-listed.other.test" },
    );
    expect(wholeWebAllowed.isError).toBe(false);
    const wholeWebLocalhostDenied = await browser.runBrowserScriptWithProfile(
      undefined,
      { destinationOrigin: "http://localhost:3000" },
    );
    expect(wholeWebLocalhostDenied.isError).toBe(true);

    const fileDenied = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://app.example.test",
      fileTransfer: true,
    });
    expect(fileDenied.isError).toBe(true);
    expect(
      browserScriptFailureSchema.parse(JSON.parse(fileDenied.content[0]!.text))
        .error.code,
    ).toBe("origin_denied");

    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://app.example.test",
      wholeWeb: false,
      fileTransfer: true,
      invalidCertificateOrigins: [],
    });
    const fileAllowed = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://app.example.test",
      fileTransfer: true,
    });
    expect(fileAllowed.isError).toBe(false);

    const certificateDenied = await browser.runBrowserScriptWithProfile(
      undefined,
      {
        destinationOrigin: "https://app.example.test",
        invalidCertificate: true,
      },
    );
    expect(certificateDenied.isError).toBe(true);

    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://app.example.test",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: ["HTTPS://APP.Example.test:443/"],
    });
    const certificateAllowed = await browser.runBrowserScriptWithProfile(
      undefined,
      {
        destinationOrigin: "https://app.example.test/",
        invalidCertificate: true,
      },
    );
    expect(certificateAllowed.isError).toBe(false);

    const combinedDenied = await browser.runBrowserScriptWithProfile(
      undefined,
      {
        destinationOrigin: "https://app.example.test",
        fileTransfer: true,
        invalidCertificate: true,
      },
    );
    expect(combinedDenied.isError).toBe(true);
    await browser.dispose();
  });

  it("revokes project grants on the public project-deleted lifecycle event", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "done" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Lifecycle target",
    });
    const grant = await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://app.example.test",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });

    expect(
      (
        await browser.runBrowserScriptWithProfile(undefined, {
          destinationOrigin: "https://app.example.test",
        })
      ).isError,
    ).toBe(false);
    const pendingDenied = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://cleanup-request.example.test",
    });
    const pendingRequestId = browserScriptFailureSchema.parse(
      JSON.parse(pendingDenied.content[0]!.text),
    ).error.grantRequest!.requestId;

    await browser.emitProjectChange("project-deleted");

    expect(
      (await browser.inspectBrowserGrant(grant.grantId))?.revokedAt,
    ).toEqual(expect.any(String));

    const afterDeletion = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://app.example.test",
    });
    expect(afterDeletion.isError).toBe(true);
    expect(
      browserScriptFailureSchema.parse(
        JSON.parse(afterDeletion.content[0]!.text),
      ).error.code,
    ).toBe("origin_denied");
    const activity = await browser.runBrowserActivityRecords();
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "system",
          kind: "grant",
          action: "project-deleted",
          outcome: "revoked",
        }),
        expect.objectContaining({
          actor: "system",
          requestId: pendingRequestId,
          action: "grant-request-revoked",
          outcome: "revoked",
        }),
      ]),
    );
    await browser.dispose();
  });

  it("blocks a deferred grant create when project deletion wins the generation barrier", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      deferProjectLookup: true,
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Deferred grant target",
    });

    const pendingGrant = browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "https://deferred.example.test",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    await browser.projectLookupStarted;
    await browser.emitProjectChange("project-deleted");
    browser.releaseProjectLookup();

    await expect(pendingGrant).rejects.toThrow();
    expect(
      await browser.listBrowserGrants({ projectId: "project-browser-test" }),
    ).toEqual([]);
    await browser.dispose();
  });

  it("allows explicitly granted private-network origins at the public runtime seam", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "private" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Private network target",
    });

    const denied = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "http://192.168.10.12:3000",
    });
    expect(denied.isError).toBe(true);

    for (const origin of [
      "http://192.168.10.12:3000",
      "http://[fd12:3456:789a::12]:8080",
    ]) {
      await browser.createBrowserGrant({
        projectId: "project-browser-test",
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        originScope: origin,
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      });
      expect(
        (
          await browser.runBrowserScriptWithProfile(undefined, {
            destinationOrigin: origin,
          })
        ).isError,
      ).toBe(false);
    }

    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "*",
      wholeWeb: true,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    expect(
      (
        await browser.runBrowserScriptWithProfile(undefined, {
          destinationOrigin: "http://10.20.30.40:9000",
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await browser.runBrowserScriptWithProfile(undefined, {
          destinationOrigin: "http://[::ffff:127.0.0.1]:3000",
        })
      ).isError,
    ).toBe(true);
    await browser.dispose();
  });

  it("enforces exact subdomains, project aliases, profiles, and installations through public contracts", async () => {
    const browser = await createPublicPluginHarness({
      hostIds: ["host-browser-test", "host-other"],
      projectHostIds: ["host-browser-test"],
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "done" } },
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Binding target",
    });
    const wildcard = await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: "HTTPS://*.Example.test:443",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });

    expect(
      (
        await browser.runBrowserScriptWithProfile(undefined, {
          destinationOrigin: "https://api.example.test",
        })
      ).isError,
    ).toBe(false);
    const baseDenied = await browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://example.test",
    });
    expect(baseDenied.isError).toBe(true);
    const copiedProjectDenied = await browser.runBrowserScriptWithProfile(
      undefined,
      {
        projectId: "project-copy",
        destinationOrigin: "https://api.example.test",
      },
    );
    expect(copiedProjectDenied.isError).toBe(true);

    const alias = projectLoopbackAlias("project-browser-test", 3000);
    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      originScope: alias,
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    expect(
      (
        await browser.runBrowserScriptWithProfile(undefined, {
          destinationOrigin: alias,
        })
      ).isError,
    ).toBe(false);
    const rawLocalhostDenied = await browser.runBrowserScriptWithProfile(
      undefined,
      { destinationOrigin: "http://localhost:3000" },
    );
    expect(rawLocalhostDenied.isError).toBe(true);

    const named = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Dedicated grant profile",
    });
    await browser.createBrowserGrant({
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: named.profileId,
      originScope: "https://profile.other.test",
      wholeWeb: false,
      fileTransfer: false,
      invalidCertificateOrigins: [],
    });
    const wrongProfile = await browser.runBrowserScriptWithProfile(
      DEFAULT_PROFILE_ID,
      { destinationOrigin: "https://profile.other.test" },
    );
    expect(wrongProfile.isError).toBe(true);
    const rightProfile = await browser.runBrowserScriptWithProfile(
      named.profileId,
      { destinationOrigin: "https://profile.other.test" },
    );
    expect(rightProfile.isError).toBe(false);

    await expect(
      browser.createBrowserGrant({
        projectId: "project-browser-test",
        hostId: "host-other",
        profileId: DEFAULT_PROFILE_ID,
        originScope: "https://unattached.example.test",
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      }),
    ).rejects.toThrow("not attached to project");

    await expect(
      browser.createBrowserGrant({
        projectId: "project-browser-test",
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        installationId: "installation-other",
        originScope: "https://wrong-installation.example.test",
        wholeWeb: false,
        fileTransfer: false,
        invalidCertificateOrigins: [],
      }),
    ).rejects.toThrow("installation is no longer current");
    expect(wildcard.originScope).toBe("https://*.example.test");
    await browser.dispose();
  });

  it("interrupts an in-flight host call when its grant is revoked", async () => {
    let signalHostCallStarted!: () => void;
    const hostCallStarted = new Promise<void>((resolve) => {
      signalHostCallStarted = resolve;
    });
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptDelayMs: 100,
      browserScriptStarted: signalHostCallStarted,
    });
    const grant = await grantDefaultProfileOrigin(
      browser,
      "https://in-flight.example.test",
    );
    const operation = browser.runBrowserScriptWithProfile(undefined, {
      destinationOrigin: "https://in-flight.example.test",
    });
    await hostCallStarted;
    const revoked = await browser.revokeBrowserGrant(grant.grantId);
    expect(revoked.outcome).toBe("revoked");
    await expect(operation).rejects.toThrow("browser script aborted");
    const activity = await browser.runBrowserActivityRecords();
    expect(activity.find((record) => record.actor === "agent")).toMatchObject({
      action: "browser-script",
      outcome: "interrupted",
      interrupted: true,
      interruptionReason: "request-aborted",
    });
    await browser.dispose();
  });

  it("interrupts an in-flight temporary request call when its project is deleted", async () => {
    let signalHostCallStarted!: () => void;
    const hostCallStarted = new Promise<void>((resolve) => {
      signalHostCallStarted = resolve;
    });
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptDelayMs: 100,
      browserScriptStarted: signalHostCallStarted,
    });

    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Temporary lifecycle target",
      });
      const denied = await browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://temporary-lifecycle.example.test",
      });
      const requestId = browserScriptFailureSchema.parse(
        JSON.parse(denied.content[0]!.text),
      ).error.grantRequest!.requestId;
      expect(
        (
          await browser.decideBrowserGrantRequest({
            requestId,
            decision: "one-hour",
          })
        ).outcome,
      ).toBe("one-hour-approved");

      const operation = browser.runBrowserScriptWithProfile(undefined, {
        destinationOrigin: "https://temporary-lifecycle.example.test",
      });
      await hostCallStarted;
      await browser.emitProjectChange("project-deleted");

      await expect(operation).rejects.toThrow("browser script aborted");
      expect(await browser.runBrowserActivityRecords()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId,
            action: "grant-request-revoked",
            outcome: "revoked",
          }),
          expect.objectContaining({
            action: "browser-script",
            outcome: "interrupted",
            interrupted: true,
          }),
        ]),
      );
    } finally {
      await browser.dispose();
    }
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

  it("R7-06 backs up and restores a stopped profile through RPC and CLI", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const recoveryRoot = await mkdtemp(
      join(tmpdir(), "bb-browser-public-recovery-"),
    );
    const archivePath = join(recoveryRoot, "profile.bb-backup");
    try {
      const profile = await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Recovery profile",
      });
      const backup = browserProfileRecoveryResponseSchema.parse(
        await browser.backupBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
          archivePath,
        }),
      );
      expect(backup).toMatchObject({
        outcome: "backed-up",
        credentialEquivalent: true,
        progress: { phase: "completed" },
      });
      expect(backup.message).toContain("credential-equivalent");

      const cliRestore = await browser.runBrowserCli([
        "restore",
        "--profile",
        profile.profileId,
        "--archive",
        archivePath,
        "--json",
      ]);
      expect(cliRestore.exitCode).toBe(0);
      expect(
        browserProfileRecoveryResponseSchema.parse(
          JSON.parse(cliRestore.stdout),
        ),
      ).toMatchObject({ outcome: "restored", credentialEquivalent: true });
      expect(cliRestore.stdout).toContain("credential-equivalent");
      const cliRestoreText = await browser.runBrowserCli([
        "restore",
        "--profile",
        profile.profileId,
        "--archive",
        archivePath,
      ]);
      expect(cliRestoreText.stdout).toContain(
        "Progress: validating → copying → promoting → completed",
      );
    } finally {
      await rm(recoveryRoot, { recursive: true, force: true });
      await browser.dispose();
    }
  });

  it("removes persistent and temporary authority before archive stop and never restores it", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "bb-browser-public-lifecycle-"),
    );
    const stopStarted = deferred<void>();
    const releaseStop = deferred<void>();
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-public-test",
      lifecycle: {
        stopProfile: async () => {
          stopStarted.resolve();
          await releaseStop.promise;
        },
      },
    });
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      profileStore,
    });
    try {
      const profile = await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Authority target",
      });
      const persistent = await browser.createBrowserGrant({
        projectId: "project-browser-test",
        hostId: "host-browser-test",
        profileId: profile.profileId,
        originScope: "https://persistent.example.test",
      });
      const denied = browserScriptFailureSchema.parse(
        JSON.parse(
          (
            await browser.runBrowserScriptWithProfile(profile.profileId, {
              destinationOrigin: "https://temporary.example.test",
            })
          ).content[0]!.text,
        ),
      );
      const requestId = denied.error.grantRequest!.requestId;
      const approved = await browser.decideBrowserGrantRequest({
        requestId,
        decision: "retry",
      });
      expect(approved.temporaryGrant).not.toBeNull();

      const archiving = browser.archiveBrowserProfile({
        hostId: "host-browser-test",
        profileId: profile.profileId,
      });
      await stopStarted.promise;
      const concurrentArchive = browser.archiveBrowserProfile({
        hostId: "host-browser-test",
        profileId: profile.profileId,
      });

      expect(
        await browser.inspectBrowserGrant(persistent.grantId),
      ).toMatchObject({
        revokedAt: expect.any(String),
      });
      expect(await browser.inspectBrowserGrantRequest(requestId)).toMatchObject(
        {
          status: "revoked",
        },
      );
      releaseStop.resolve();
      await expect(archiving).resolves.toMatchObject({ outcome: "archived" });
      await expect(concurrentArchive).resolves.toMatchObject({
        outcome: "already-archived",
      });
      await expect(
        browser.restoreArchivedBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
        }),
      ).resolves.toMatchObject({ outcome: "restored" });
      expect(
        await browser.inspectBrowserGrant(persistent.grantId),
      ).toMatchObject({
        revokedAt: expect.any(String),
      });
      expect(await browser.inspectBrowserGrantRequest(requestId)).toMatchObject(
        {
          status: "revoked",
        },
      );
    } finally {
      releaseStop.resolve();
      await browser.dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("protects the Settings default, confirms credential loss, and fails closed for CLI mutations", async () => {
    const rootDirectory = await mkdtemp(
      join(tmpdir(), "bb-browser-public-lifecycle-"),
    );
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-public-test",
      lifecycle: { stopProfile: async () => undefined },
    });
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      profileStore,
    });
    try {
      const profile = await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Delete target",
      });
      await browser.selectBrowserProfile(
        { hostId: "host-browser-test", profileId: profile.profileId },
        {},
      );
      await expect(
        browser.deleteBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
          confirmation: profile.name,
        }),
      ).rejects.toThrow("Select another default");
      await expect(
        browser.resetBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
          confirmation: "reset",
        }),
      ).rejects.toThrow("credential loss");
      await expect(
        browser.resetBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
          confirmation: RESET_PROFILE_CONFIRMATION,
        }),
      ).resolves.toMatchObject({ outcome: "reset" });

      const cli = await browser.runBrowserCli([
        "archive",
        "--profile",
        profile.profileId,
      ]);
      expect(cli).toMatchObject({ exitCode: 1 });
      expect(cli.stderr).toContain("authenticated owner Settings");
      expect(cli.stdout).toContain("Progress: not started");
      expect(cli.stdout).toContain("State: active");

      await browser.selectBrowserProfile(
        { hostId: "host-browser-test", profileId: DEFAULT_PROFILE_ID },
        {},
      );
      await expect(
        browser.deleteBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
          confirmation: profile.name,
        }),
      ).resolves.toMatchObject({ outcome: "deleted" });
      await expect(
        browser.deleteBrowserProfile({
          hostId: "host-browser-test",
          profileId: profile.profileId,
          confirmation: profile.name,
        }),
      ).resolves.toMatchObject({ outcome: "already-deleted" });
      const lifecycleRecords = (
        await browser.runBrowserActivityRecords(profile.profileId)
      ).filter(({ kind }) => kind === "lifecycle");
      expect(
        lifecycleRecords.map(({ action, outcome }) => ({ action, outcome })),
      ).toEqual(
        expect.arrayContaining([
          { action: "reset", outcome: "reset" },
          { action: "delete", outcome: "deleted" },
        ]),
      );
      expect(JSON.stringify(lifecycleRecords)).not.toMatch(
        /Delete target|Lose saved sessions|confirmation/i,
      );
    } finally {
      await browser.dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it("R7-06 shows an operation-specific recovery status while Settings waits for completion", async () => {
    let releaseBackup!: (result: BrowserProfileBackupResult) => void;
    const backupResult = new Promise<BrowserProfileBackupResult>((resolve) => {
      releaseBackup = resolve;
    });
    let backupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      backupStarted = resolve;
    });
    const profileRecovery: BrowserProfileRecovery = {
      backupProfile: async () => {
        backupStarted();
        return backupResult;
      },
      restoreProfile: async () => {
        throw new Error("restore is not used in this test");
      },
      importDevBrowserProfile: async () => {
        throw new Error("import is not used in this test");
      },
    };
    const browser = await createPublicPluginHarness({
      profileRecovery,
      snapshot: preparedSnapshot,
    });
    const recoveryRoot = await mkdtemp(
      join(tmpdir(), "bb-browser-public-pending-recovery-"),
    );
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Pending recovery profile",
      });
      const settings = browser.renderSettings();
      const archivePath = join(recoveryRoot, "pending.bb-backup");
      await settings.findByText("Browser Profile recovery");
      fireEvent.change(
        settings.getByLabelText("Browser Profile archive path"),
        { target: { value: archivePath } },
      );
      fireEvent.click(
        settings.getByRole("button", { name: "Backup Browser Profile" }),
      );
      await started;
      await settings.findByText(/Browser Profile backup in progress/);
      releaseBackup({
        outcome: "backed-up",
        message: "Backup completed.",
        archivePath,
        credentialEquivalent: true,
        progress: {
          phase: "completed",
          completedBytes: 10,
          totalBytes: 10,
        },
      });
      await settings.findByText(/Progress: .*completed \(/);
    } finally {
      await rm(recoveryRoot, { recursive: true, force: true });
      await browser.dispose();
    }
  });

  it("shows credential warnings and recovery progress in Settings", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const recoveryRoot = await mkdtemp(
      join(tmpdir(), "bb-browser-public-settings-recovery-"),
    );
    try {
      await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Settings recovery profile",
      });
      const settings = browser.renderSettings();
      const archivePath = join(recoveryRoot, "settings.bb-backup");

      await settings.findByText("Browser Profile recovery");
      await settings.findByText(
        "Backups are credential-equivalent and require a stopped profile.",
      );
      expect(
        settings.getByRole("button", { name: "Backup Browser Profile" }),
      ).toBeDefined();
      expect(
        settings.getByRole("button", { name: "Restore Browser Profile" }),
      ).toBeDefined();
      expect(
        settings.getByRole("button", { name: "Import dev-browser Profile" }),
      ).toBeDefined();

      fireEvent.change(
        settings.getByLabelText("Browser Profile archive path"),
        {
          target: { value: archivePath },
        },
      );
      fireEvent.click(
        settings.getByRole("button", { name: "Backup Browser Profile" }),
      );
      await settings.findByText(/Progress: .*completed \(/);
    } finally {
      await rm(recoveryRoot, { recursive: true, force: true });
      await browser.dispose();
    }
  });

  it("imports a stopped dev-browser profile through RPC and CLI without recording contents", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "bb-browser-public-import-source-"),
    );
    const sourcePath = join(sourceRoot, "default");
    try {
      await mkdir(sourcePath, { mode: 0o700 });
      await writeFile(join(sourcePath, "Cookies"), "source-session", {
        mode: 0o600,
      });
      const rpcImport = browserProfileRecoveryResponseSchema.parse(
        await browser.importBrowserProfile({
          hostId: "host-browser-test",
          name: "RPC imported profile",
          sourcePath,
        }),
      );
      expect(rpcImport).toMatchObject({ outcome: "imported" });

      const cliImport = await browser.runBrowserCli([
        profileImportCommand,
        "--name",
        "CLI imported profile",
        "--source",
        sourcePath,
        "--json",
      ]);
      expect(cliImport.exitCode).toBe(0);
      const cliImportResponse = browserProfileRecoveryResponseSchema.parse(
        JSON.parse(cliImport.stdout),
      );
      expect(cliImportResponse).toMatchObject({ outcome: "imported" });
      if (
        rpcImport.outcome !== "imported" ||
        cliImportResponse.outcome !== "imported"
      ) {
        throw new Error("Expected both import operations to succeed.");
      }

      const inventory = await browser.runBrowserProfiles();
      expect(inventory.profiles.map(({ name }) => name)).toEqual(
        expect.arrayContaining([
          "RPC imported profile",
          "CLI imported profile",
        ]),
      );
      expect(await readFile(join(sourcePath, "Cookies"), "utf8")).toBe(
        "source-session",
      );
      const activity = [
        ...(await browser.runBrowserActivityRecords(rpcImport.profileId)),
        ...(await browser.runBrowserActivityRecords(
          cliImportResponse.profileId,
        )),
      ];
      expect(activity.map(({ action }) => action)).toEqual(
        expect.arrayContaining([profileImportCommand, profileImportCommand]),
      );
      expect(JSON.stringify(activity)).not.toContain("source-session");
      expect(JSON.stringify(activity)).not.toContain(sourcePath);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
      await browser.dispose();
    }
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

  it("R5-03 reports a stale selected Browser Profile like browser_script", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "bb-browser-public-"));
    const profileStore = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-public-test",
    });
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      profileStore,
    });

    try {
      const selectedProfile = await browser.createBrowserProfile({
        hostId: "host-browser-test",
        name: "Stale selection",
      });
      await browser.selectBrowserProfile({
        hostId: "host-browser-test",
        profileId: selectedProfile.profileId,
      });
      await rm(
        profileStoragePaths({
          rootDirectory,
          installationId: "installation-public-test",
          hostId: "host-browser-test",
          profileId: selectedProfile.profileId,
        }).profileDirectory,
        { recursive: true, force: true },
      );

      const status = await browser.runBrowserStatus({
        surface: "new-thread",
        projectId: "project-browser-test",
        hostId: "host-browser-test",
        profileId: DEFAULT_PROFILE_ID,
        profileSelection: "selected",
      });
      const scriptFailure = browserScriptFailureSchema.parse(
        JSON.parse(
          (await browser.runBrowserScriptWithProfile()).content[0]!.text,
        ),
      );

      expect(status).toMatchObject({
        state: "repair-required",
        code: "repair_required",
        profileId: selectedProfile.profileId,
      });
      expect(scriptFailure.error).toEqual(status);
    } finally {
      await browser.dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
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

  it("records agent operations without recording owner reads or sensitive inputs", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    await grantDefaultProfileOrigin(browser, "https://app.example.test");

    await browser.runBrowserStatus({
      surface: "new-thread",
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
    });
    await browser.runBrowserScriptWithProfile(undefined, {
      purpose:
        "Inspect credentials at https://app.example.test/login?token=purpose-secret",
      code: "await page.goto('https://app.example.test/login?token=script-secret'); return 'clipboard-secret';",
      destinationOrigin: "https://app.example.test",
    });

    const records = await browser.runBrowserActivityRecords();
    const agentRecord = records.find((record) => record.actor === "agent");
    expect(agentRecord).toBeDefined();
    expect(agentRecord).toMatchObject({
      actor: "agent",
      projectId: "project-browser-test",
      hostId: "host-browser-test",
      profileId: DEFAULT_PROFILE_ID,
      kind: "agent-operation",
      action: "browser-script",
      destinationOrigin: "https://app.example.test",
      outcome: "failed",
      interrupted: false,
      interruptionReason: null,
    });
    const serialized = JSON.stringify(records);
    const diagnostics = await browser.runDiagnosticsCli();
    const persistedRows = JSON.stringify(browser.persistedActivityRows());
    const persistedOutbox = await browser.persistedHostOutbox();
    const diagnosticLogs = JSON.stringify(browser.diagnosticLogEntries());
    const persistedSurfaces = [
      serialized,
      diagnostics.stdout,
      persistedRows,
      persistedOutbox,
      diagnosticLogs,
    ].join("\n");
    for (const forbidden of [
      "purpose-secret",
      "script-secret",
      "clipboard-secret",
      "Inspect credentials",
      "/login",
      "password",
      "keyboard",
      "pointer",
      "screenshot",
      "cookie",
      "form data",
    ]) {
      expect(persistedSurfaces).not.toContain(forbidden);
    }
    await browser.dispose();
  });

  it("uses the production outbox claim path and persists retry backoff", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    browser.setHostRpcFailure(
      "acknowledgeActivity",
      "activity acknowledgement unavailable",
    );
    await browser.seedHostActivityEvent();
    await browser.runBrowserActivityRecords();

    const outbox = browserActivityOutboxSchema.parse(
      JSON.parse(await browser.persistedHostOutbox()).events,
    );
    expect(outbox).toMatchObject([{ attempts: 1 }]);
    expect(outbox[0]?.nextAttemptAt).not.toBe(outbox[0]?.occurredAt);
    await browser.dispose();
  });

  it("records the final agent outcome when a browser script succeeds", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptResponse: { ok: true, result: { title: "done" } },
    });
    await grantDefaultProfileOrigin(browser, "https://example.com");

    await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Successful browser operation",
      code: "return document.title;",
      destinationOrigin: "https://example.com",
    });

    const records = await browser.runBrowserActivityRecords();
    expect(records.find((record) => record.actor === "agent")).toMatchObject({
      outcome: "succeeded",
      interrupted: false,
    });
    expect(
      records.find((record) => record.actor === "agent")?.durationMs,
    ).toEqual(expect.any(Number));

    await browser.dispose();
  });

  it("records failed agent operations with completed timing metadata", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    const reply = await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Failed browser operation",
      code: "return document.title;",
      destinationOrigin: "https://example.com",
    });

    expect(reply.isError).toBe(true);
    const records = await browser.runBrowserActivityRecords();
    expect(records[0]).toMatchObject({
      outcome: "failed",
      interrupted: false,
      interruptionReason: null,
    });
    expect(records[0]?.durationMs).toEqual(expect.any(Number));

    await browser.dispose();
  });

  it("records an agent operation as interrupted when its final signal is aborted", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
      browserScriptDelayMs: 25,
    });
    await grantDefaultProfileOrigin(browser, "https://example.com");
    const controller = new AbortController();
    const operation = browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Interrupted browser operation",
      code: "return document.title;",
      destinationOrigin: "https://example.com",
      signal: controller.signal,
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 1);
    });
    await operation.catch(() => undefined);

    const records = await browser.runBrowserActivityRecords();
    expect(records.find((record) => record.actor === "agent")).toMatchObject({
      outcome: "interrupted",
      interrupted: true,
      interruptionReason: "request-aborted",
    });
    expect(
      records.find((record) => record.actor === "agent")?.durationMs,
    ).toEqual(expect.any(Number));

    await browser.dispose();
  });

  it("does not restore activity cleared while offline after host reconnect", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    await grantDefaultProfileOrigin(browser, "https://app.example.test");
    browser.setHostRpcFailure(
      "reconcileActivity",
      "activity reconciliation unavailable",
    );

    await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Create pending activity",
      code: "return page.url();",
      destinationOrigin: "https://app.example.test",
    });
    expect(
      browserActivityOutboxSchema.parse(
        JSON.parse(await browser.persistedHostOutbox()).events,
      ),
    ).toHaveLength(1);

    browser.setHostRpcFailure("reconcileActivity");
    browser.setHostConnection("disconnected");
    const clearReply = await browser.runBrowserCli([
      "activity-clear",
      "--confirm",
      "Clear Browser activity records",
      "--json",
    ]);
    expect(clearReply.exitCode).toBe(0);
    expect(JSON.parse(clearReply.stdout ?? "{}").clearedCount).toBeGreaterThan(
      0,
    );

    await browser.emitHostConnection("host-connected");

    expect(
      browserActivityOutboxSchema.parse(
        JSON.parse(await browser.persistedHostOutbox()).events,
      ),
    ).toEqual([]);
    expect(await browser.runBrowserActivityRecords()).toEqual([]);
    await browser.dispose();
  });

  it("reviews, exports, and clears activity through authenticated CLI surfaces", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });

    await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Review private page",
      code: "return 'private-content';",
      destinationOrigin: "https://app.example.test",
    });

    const review = await browser.runBrowserCli(["activity", "--json"]);
    const reviewedRecords = browserActivityRecordsSchema.parse(
      JSON.parse(review.stdout),
    );
    expect(review.exitCode).toBe(0);
    expect(reviewedRecords).toHaveLength(1);

    const textReview = await browser.runBrowserCli(["activity"]);
    expect(textReview.stdout).toContain("agent-operation:browser-script");

    const exported = await browser.runBrowserCli(["activity-export", "--json"]);
    const exportPayload = browserActivityExportSchema.parse(
      JSON.parse(exported.stdout),
    );
    expect(exportPayload.records).toHaveLength(2);
    expect(exportPayload.records.at(-1)?.action).toBe("activity-export");

    const rejectedClear = await browser.runBrowserCli([
      "activity-clear",
      "--confirm",
      "wrong confirmation",
      "--json",
    ]);
    expect(rejectedClear.exitCode).toBe(1);
    expect(rejectedClear.stderr).toContain("Clear Browser activity records");

    const cleared = await browser.runBrowserCli([
      "activity-clear",
      "--confirm",
      "Clear Browser activity records",
      "--json",
    ]);
    const clearPayload = browserActivityClearResponseSchema.parse(
      JSON.parse(cleared.stdout),
    );
    expect(clearPayload.clearedCount).toBe(2);
    expect(
      browserActivityRecordsSchema.parse(
        JSON.parse(
          (await browser.runBrowserCli(["activity", "--json"])).stdout,
        ),
      ),
    ).toEqual([]);
    await browser.dispose();
  });

  it("reviews, exports, and clears activity from authenticated Settings controls", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    await browser.runBrowserScriptWithProfile(undefined, {
      purpose: "Review private page",
      code: "return 'private-content';",
      destinationOrigin: "https://app.example.test",
    });

    const settings = browser.renderSettings();
    const reviewButton = await settings.findByRole("button", {
      name: "Review Browser activity",
    });
    fireEvent.click(reviewButton);
    const records = await settings.findByLabelText("Browser activity records");
    expect(records.textContent).toContain("browser-script");

    fireEvent.click(
      settings.getByRole("button", { name: "Export Browser activity" }),
    );
    const exportView = await settings.findByLabelText(
      "Browser activity export",
    );
    expect(exportView.textContent).toContain("activity-export");

    const confirmation = settings.getByRole("textbox", {
      name: "Activity clear confirmation",
    });
    fireEvent.change(confirmation, {
      target: { value: "Clear Browser activity records" },
    });
    fireEvent.click(
      settings.getByRole("button", { name: "Clear Browser activity" }),
    );
    await settings.findByText("Cleared 2 Browser activity records.");
    expect(records.textContent).toBe("[]");
    await browser.dispose();
  });

  it("creates, inspects, and revokes a Browser Profile Grant from Settings", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Settings grant target",
    });
    const settings = browser.renderSettings();

    await settings.findByText("Browser Profile Grants");
    fireEvent.change(
      settings.getByRole("textbox", { name: "Grant project ID" }),
      { target: { value: "project-browser-test" } },
    );
    fireEvent.change(
      settings.getByRole("textbox", { name: "Grant origin scope" }),
      { target: { value: "HTTPS://APP.Example.test:443/" } },
    );
    fireEvent.click(
      settings.getByRole("button", { name: "Create Browser Profile Grant" }),
    );
    await settings.findByText(/Created Browser Grant grant-/);
    expect(settings.getByText("https://app.example.test")).toBeDefined();

    fireEvent.click(
      settings.getByRole("button", { name: "Inspect Browser Grants" }),
    );
    await settings.findByRole("list", { name: "Browser Profile Grant list" });
    const revokeButton = settings.getByRole("button", {
      name: /Revoke Browser Grant grant-/,
    });
    fireEvent.click(revokeButton);
    await settings.findByText(/Browser Grant grant-.*: revoked\./);
    const grantActivity = (await browser.runBrowserActivityRecords()).filter(
      (record) => record.kind === "grant",
    );
    expect(grantActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "owner",
          destinationOrigin: null,
          grantId: expect.any(String),
          grantScope: "https://app.example.test",
          grantElevations: {
            wholeWeb: false,
            fileTransfer: false,
            invalidCertificateOrigins: [],
            persistentElevations: false,
          },
        }),
      ]),
    );
    await browser.dispose();
  });

  it("requires a second Settings confirmation before persistent grant elevations", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Persistent grant target",
    });
    const settings = browser.renderSettings();

    await settings.findByText("Browser Profile Grants");
    fireEvent.change(
      settings.getByRole("textbox", { name: "Grant project ID" }),
      { target: { value: "project-browser-test" } },
    );
    fireEvent.click(
      settings.getByRole("checkbox", {
        name: "Whole-web Browser access",
      }),
    );
    fireEvent.click(
      settings.getByRole("checkbox", {
        name: "Persistent elevated Browser access",
      }),
    );
    fireEvent.click(
      settings.getByRole("button", { name: "Create Browser Profile Grant" }),
    );
    await settings.findByText(/second confirmation/);

    fireEvent.change(
      settings.getByRole("textbox", {
        name: "Persistent elevation confirmation",
      }),
      { target: { value: PERSIST_BROWSER_ELEVATED_ACCESS_CONFIRMATION } },
    );
    fireEvent.click(
      settings.getByRole("button", { name: "Create Browser Profile Grant" }),
    );
    await settings.findByText(/Created Browser Grant grant-/);

    await expect(browser.listBrowserGrants()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          persistentElevations: true,
          wholeWebExpiresAt: null,
        }),
      ]),
    );
    await browser.dispose();
  });

  it("uses the selected non-default profile for Settings activity controls", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const settings = browser.renderSettings();

    await settings.findByText("Browser Profiles");
    const name = await settings.findByRole("textbox", {
      name: "New Browser Profile name",
    });
    fireEvent.change(name, { target: { value: "Activity profile" } });
    fireEvent.click(
      settings.getByRole("button", { name: "Create Browser Profile" }),
    );
    await settings.findByText("Activity profile");

    fireEvent.click(
      settings.getByRole("button", { name: "Select Activity profile" }),
    );
    await settings.findByText(/Selected: profile-/);
    const inventory = await browser.runBrowserProfiles();
    const selectedProfileId = inventory.selectedProfileId;
    expect(selectedProfileId).not.toBe(DEFAULT_PROFILE_ID);

    await browser.runBrowserScriptWithProfile(selectedProfileId, {
      purpose: "Review selected profile activity",
      code: "return document.title;",
      destinationOrigin: "https://example.com",
    });
    fireEvent.click(
      settings.getByRole("button", { name: "Review Browser activity" }),
    );
    const records = await settings.findByLabelText("Browser activity records");
    expect(records.textContent).toContain(selectedProfileId);

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

  it("shows destructive consequences, progress, recovery deadline, and final state in Settings", async () => {
    const browser = await createPublicPluginHarness({
      snapshot: preparedSnapshot,
    });
    const profile = await browser.createBrowserProfile({
      hostId: "host-browser-test",
      name: "Lifecycle UI target",
    });
    const settings = browser.renderSettings();
    try {
      expect(
        await settings.findAllByText(/removes all agent authority immediately/),
      ).toHaveLength(2);
      fireEvent.click(
        await settings.findByRole("button", {
          name: "Archive Lifecycle UI target",
        }),
      );
      await settings.findByText(/Archive in progress/);
      await settings.findByText(/Recoverable until \d{4}-/);
      fireEvent.click(
        await settings.findByRole("button", {
          name: "Restore Lifecycle UI target",
        }),
      );
      await settings.findByText(/Restore in progress/);
      await settings.findByRole("button", {
        name: "Reset Lifecycle UI target",
      });

      const confirmation = settings.getByLabelText(
        "Lifecycle confirmation Lifecycle UI target",
      );
      fireEvent.change(confirmation, {
        target: { value: RESET_PROFILE_CONFIRMATION },
      });
      fireEvent.click(
        settings.getByRole("button", { name: "Reset Lifecycle UI target" }),
      );
      await settings.findByText(/Browser Profile Lifecycle UI target is reset/);

      fireEvent.change(confirmation, { target: { value: profile.name } });
      fireEvent.click(
        settings.getByRole("button", {
          name: "Permanently delete Lifecycle UI target",
        }),
      );
      await waitFor(() =>
        expect(
          settings.queryByRole("button", {
            name: "Permanently delete Lifecycle UI target",
          }),
        ).toBeNull(),
      );
    } finally {
      await browser.dispose();
    }
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
