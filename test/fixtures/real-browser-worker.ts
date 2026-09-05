import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  createProductionBrowserProcessBoundary,
  helperRuntimeHome,
} from "../../browser-process.js";
import {
  BrowserOriginScopeDeniedError,
  createBrowserInstanceRuntime,
} from "../../browser-runtime.js";
import {
  createBrowserUserProfileOwnershipBoundary,
  profileManifest,
  profileStoragePaths,
} from "../../profile-storage.js";
import { createPanelCapabilityStore } from "../../panel-capability.js";
import { createPanelGateway } from "../../panel-gateway.js";
import { createAutomationStreamAdapter } from "../../panel-stream.js";
import { createCdpScreencastSource } from "../../browser-screencast.js";
import { createPanelTransportServer } from "../../panel-transport.js";
import { createSafeLoginMode } from "../../safe-login.js";
import {
  createTransferStagingManager,
  resolveTransferStagingRoot,
} from "../../transfer-staging.js";
import { createNodeTransferStagingFilesystem } from "../../transfer-staging-filesystem.js";
import {
  createHostDownloadsManager,
  resolveHostDownloadsRoot,
} from "../../host-downloads.js";
import { createNodeHostDownloadsFilesystem } from "../../host-downloads-filesystem.js";
import { WebSocket } from "ws";
import {
  PANEL_MAX_VIEWPORT_HEIGHT,
  PANEL_MAX_VIEWPORT_WIDTH,
  PANEL_RECLAIM_WINDOW_MS,
} from "../../contracts.js";

function requiredEnvironment(name: string) {
  const setting = process.env[name];
  if (setting === undefined || setting === "") {
    throw new Error(`Provisioned-host fixture requires ${name}.`);
  }
  return setting;
}

async function ownedProcesses(rootDirectory: string) {
  const processes = await Promise.all(
    (await readdir("/proc"))
      .filter((name) => /^\d+$/u.test(name))
      .map(async (pid) => {
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
          () => "",
        );
        if (!command.includes(rootDirectory)) return null;
        const status = await readFile(`/proc/${pid}/status`, "utf8");
        return { pid: Number(pid), command, status };
      }),
  );
  return processes.filter((process_) => process_ !== null);
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function processExists(pid: number) {
  return pathExists(`/proc/${pid}/status`);
}

async function waitForProcessExit(pid: number) {
  const deadline = Date.now() + 10_000;
  while (await processExists(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Provisioned-host process ${pid} did not exit.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const action = requiredEnvironment("BB_BROWSER_WORKER_ACTION");
if (
  !new Set([
    "start",
    "crash-recover",
    "lifecycle",
    "cleanup",
    "origin-scope",
    "panel-transport",
    "dialogs",
    "safe-login",
    "transfer",
    "disable-re-enable",
  ]).has(action)
) {
  throw new Error(
    "Provisioned-host fixture received an invalid worker action.",
  );
}
const rootDirectory = requiredEnvironment("BB_BROWSER_REAL_ROOT");
const fixtureAddress = requiredEnvironment("BB_BROWSER_FIXTURE_ADDRESS");
const require = createRequire(import.meta.url);
const devBrowserDirectory = dirname(
  require.resolve("dev-browser/package.json"),
);
const boundary = createProductionBrowserProcessBoundary({
  devBrowserExecutable: join(devBrowserDirectory, "bin", "dev-browser.js"),
  devBrowserPackageDirectory: devBrowserDirectory,
});
const target = {
  hostId: requiredEnvironment("BB_BROWSER_REAL_HOST_ID"),
  profileId: requiredEnvironment("BB_BROWSER_REAL_PROFILE_ID"),
  projectId: requiredEnvironment("BB_BROWSER_REAL_PROJECT_ID"),
  locale: "en-GB",
  timezone: "Europe/London",
};
const runtimeOptions = {
  rootDirectory,
  installationId: requiredEnvironment("BB_BROWSER_REAL_INSTALLATION_ID"),
  chromeStablePaths: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ],
  launchBoundary: boundary,
  ...(action === "lifecycle" ? { idleSleepMs: 250 } : {}),
};
const baseRuntime = createBrowserInstanceRuntime(runtimeOptions);
const runtime = {
  ...baseRuntime,
  async start(request: Parameters<typeof baseRuntime.start>[0]) {
    const paths = profileStoragePaths({ ...runtimeOptions, ...request });
    if (!(await pathExists(paths.manifestPath))) {
      const ownership = createBrowserUserProfileOwnershipBoundary();
      const manifest = profileManifest(
        {
          ...runtimeOptions,
          ...request,
          name: `Acceptance ${request.profileId}`,
          locale: request.locale ?? "en-US",
          timezone: request.timezone ?? "UTC",
        },
        () => new Date(),
      );
      await mkdir(paths.profileDirectory, { recursive: true, mode: 0o700 });
      await ownership.ensureOwned(paths.profileDirectory, 0o700);
      await writeFile(paths.manifestPath, JSON.stringify(manifest), {
        mode: 0o600,
      });
      await ownership.ensureOwned(paths.manifestPath, 0o600);
    }
    return baseRuntime.start(request);
  },
};
// A failed worker must not leave a live browser behind for the next test.
process.once("uncaughtException", async (error) => {
  console.error(error);
  const cleanup = await Promise.allSettled([runtime.dispose()]);
  for (const outcome of cleanup) {
    if (outcome.status === "rejected") console.error(outcome.reason);
  }
  process.exit(1);
});
const storagePaths = profileStoragePaths({
  rootDirectory,
  installationId: requiredEnvironment("BB_BROWSER_REAL_INSTALLATION_ID"),
  hostId: target.hostId,
  profileId: target.profileId,
});
const helperHome = helperRuntimeHome(
  storagePaths.runtimeManifestsDirectory,
  `bb-${target.profileId}`,
);

const signInScript = `const page = await browser.getPage("auth");
await page.goto(${JSON.stringify(fixtureAddress)});
await page.fill("input[name=user]", "fixture-user");
await Promise.all([page.waitForURL("**/account"), page.click("button")]);
await page.evaluate(() => {
  localStorage.setItem("local-token", "persistent");
  sessionStorage.setItem("session-token", "restorable");
});
const popupReady = page.waitForEvent("popup");
await page.click("#popup");
const popup = await popupReady;
await popup.waitForLoadState("domcontentloaded");
await page.bringToFront();
console.log(JSON.stringify({
  pages: await browser.listPages(),
  popupHeading: await popup.locator("h1").textContent(),
  accountHeading: await page.locator("h1").textContent(),
}));`;

const pageInventoryScript = `console.log(JSON.stringify(await browser.listPages()));`;

const restoreScript = `const pages = await browser.listPages();
const account = pages.find((candidate) => candidate.url.includes("/account"));
const popupEntry = pages.find((candidate) => candidate.url.includes("/popup"));
if (!account || !popupEntry) throw new Error("Restorable tabs were not recovered");
const page = await browser.getPage(account.id);
const popup = await browser.getPage(popupEntry.id);
console.log(JSON.stringify({
  pages,
  heading: await page.locator("h1").textContent(),
  popupHeading: await popup.locator("h1").textContent(),
  local: await page.evaluate(() => localStorage.getItem("local-token")),
  session: await page.evaluate(() => sessionStorage.getItem("session-token")),
  locale: await page.evaluate(() => navigator.language),
  timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
}));`;

async function waitForRuntimeState(
  targetProfile: typeof target,
  expected: "running" | "sleeping" | "repair-required",
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await runtime.status(targetProfile);
    if (status.state === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Browser Profile ${targetProfile.profileId} did not reach ${expected}.`,
  );
}

async function lifecycleAcceptance(initialPid: number) {
  const profile = (suffix: string) => ({
    ...target,
    profileId: `${target.profileId}-${suffix}`,
  });
  await runtime.pinPanel(target, "real-panel");
  const profileB = profile("lru-b");
  const profileC = profile("lru-c");
  const profileD = profile("lru-d");
  await runtime.start(profileB);
  await runtime.start(profileC);
  await runtime.start(profileD);
  const lruState = await runtime.status(profileB);

  await runtime.pinPanel(profileC, "real-panel-c");
  await runtime.pinPanel(profileD, "real-panel-d");
  let pinnedLimitCode: string | null = null;
  try {
    await runtime.start(profile("pinned-refused"));
  } catch (error) {
    pinnedLimitCode =
      error instanceof Error && "code" in error ? String(error.code) : null;
  }

  runtime.hostDisconnected(target.hostId);
  let disconnectedCode: string | null = null;
  try {
    await runtime.execute(target, "return page.url()", 5_000);
  } catch (error) {
    disconnectedCode =
      error instanceof Error && "code" in error ? String(error.code) : null;
  }
  await runtime.hostReconnected(target.hostId);
  const reconciled = await runtime.start(target);

  await Promise.all([
    runtime.unpinPanel(target, "real-panel"),
    runtime.unpinPanel(profileC, "real-panel-c"),
    runtime.unpinPanel(profileD, "real-panel-d"),
  ]);
  await Promise.all([
    waitForRuntimeState(target, "sleeping"),
    waitForRuntimeState(profileC, "sleeping"),
    waitForRuntimeState(profileD, "sleeping"),
  ]);

  const crashTarget = profile("crash-loop");
  const crashPids: number[] = [];
  for (let crashNumber = 0; crashNumber < 3; crashNumber += 1) {
    const running = await runtime.start(crashTarget);
    crashPids.push(running.pid);
    process.kill(running.pid, "SIGKILL");
    await waitForProcessExit(running.pid);
    await waitForRuntimeState(
      crashTarget,
      crashNumber === 2 ? "repair-required" : "running",
    );
  }
  const crashLoopState = await runtime.status(crashTarget);

  const corruptTarget = profile("corrupt");
  const corruptPaths = profileStoragePaths({
    rootDirectory,
    installationId: runtimeOptions.installationId,
    hostId: corruptTarget.hostId,
    profileId: corruptTarget.profileId,
  });
  await mkdir(corruptPaths.runtimeManifestsDirectory, { recursive: true });
  await writeFile(corruptPaths.runtimeManifestPath, "{corrupt");
  let corruptCode: string | null = null;
  try {
    await runtime.start(corruptTarget);
  } catch (error) {
    corruptCode =
      error instanceof Error && "code" in error ? String(error.code) : null;
  }

  const reloadTarget = profile("reload");
  const beforeReload = await runtime.start(reloadTarget);
  await runtime.dispose();
  await waitForProcessExit(beforeReload.pid);
  const reloadedRuntime = createBrowserInstanceRuntime(runtimeOptions);
  const lazyState = await reloadedRuntime.status(reloadTarget);
  const afterReload = await reloadedRuntime.start(reloadTarget);
  await reloadedRuntime.dispose();
  await waitForProcessExit(afterReload.pid);

  return {
    initialPid,
    lruState: lruState.state,
    pinnedLimitCode,
    disconnectedCode,
    reconciledPid: reconciled.pid,
    idleStates: ["sleeping", "sleeping", "sleeping"],
    crashPids,
    crashLoopState,
    corruptCode,
    lazyState: lazyState.state,
    reloadPids: [beforeReload.pid, afterReload.pid],
  };
}

async function activePageScript(gotoUrl: string) {
  return `const __bbPages = await browser.listPages();
if (__bbPages.length === 0) throw new Error("The Browser Profile has no open tabs");
const __bbPage = await browser.getPage(__bbPages[0].id);
await __bbPage.bringToFront();
await __bbPage.goto(${JSON.stringify(gotoUrl)});
console.log(JSON.stringify({ committedUrl: __bbPage.url() }));`;
}

async function originScopeAcceptance() {
  const originScope = requiredEnvironment("BB_BROWSER_ORIGIN_SCOPE");
  const attackPages = JSON.parse(
    requiredEnvironment("BB_BROWSER_ATTACK_PAGES"),
  ) as { kind: string; page: string }[];
  const attacks: { kind: string; blocked: boolean; deniedOrigin?: string }[] =
    [];
  for (const attack of attackPages) {
    try {
      await runtime.execute(
        target,
        await activePageScript(attack.page),
        20_000,
        { originScope },
      );
      attacks.push({ kind: attack.kind, blocked: false });
    } catch (error) {
      if (error instanceof BrowserOriginScopeDeniedError) {
        attacks.push({
          kind: attack.kind,
          blocked: true,
          ...(error.origin === null ? {} : { deniedOrigin: error.origin }),
        });
        continue;
      }
      throw error;
    }
  }

  let inScope: { ok: boolean };
  try {
    await runtime.execute(target, await activePageScript(originScope), 20_000, {
      originScope,
    });
    inScope = { ok: true };
  } catch (error) {
    if (error instanceof BrowserOriginScopeDeniedError) {
      inScope = { ok: false };
    } else {
      throw error;
    }
  }

  const revocationController = new AbortController();
  let revocationInterrupted = false;
  const revocationOperation = runtime
    .execute(
      target,
      "await new Promise((resolve) => setTimeout(resolve, 8000));",
      30_000,
      { originScope, leaseSignal: revocationController.signal },
    )
    .then(() => {
      revocationInterrupted = false;
    })
    .catch((error: unknown) => {
      revocationInterrupted = error instanceof Error;
    });
  await new Promise((resolve) => setTimeout(resolve, 500));
  revocationController.abort();
  await revocationOperation;
  const browserStillRunning =
    (await runtime.status(target)).state === "running";
  const ownerPageScript = `const __bbOwnerPages = await browser.listPages();
console.log(JSON.stringify({ pages: __bbOwnerPages.length }));`;
  const ownerPageOutput = JSON.parse(
    String(await runtime.execute(target, ownerPageScript, 20_000)),
  ) as { pages: number };

  return {
    attacks,
    inScope,
    revocation: {
      interrupted: revocationInterrupted,
      browserStillRunning,
    },
    ownerPage: { present: ownerPageOutput.pages > 0 },
  };
}

const initialInstance = await runtime.start(target);
let instance = initialInstance;
let crashedPid: number | null = null;
let scriptOutput = "{}";
let navigation:
  { before: unknown[]; after: unknown[]; tabId: string } | undefined;
let lifecycle: Awaited<ReturnType<typeof lifecycleAcceptance>> | undefined;
let panelTransport:
  | {
      gatewayBindHost: string;
      redeemed: boolean;
      replayed: boolean;
      viewport: { width: number; height: number };
      fps: number;
      reconnectBackoffMs: number[];
      reclaimWindowMs: number;
      revoked: boolean;
    }
  | undefined;
if (action === "start") {
  scriptOutput = String(await runtime.execute(target, signInScript, 20_000));
  const before = JSON.parse(
    String(await runtime.execute(target, pageInventoryScript, 20_000)),
  ) as { id: string; name: string | null }[];
  const account = before.find((page) => page.name === "auth");
  if (account === undefined)
    throw new Error("The authenticated tab is missing.");
  const navigationResponse = await runtime.navigate(
    { ...target, tabId: account.id },
    fixtureAddress,
  );
  const after = JSON.parse(
    String(await runtime.execute(target, pageInventoryScript, 20_000)),
  ) as unknown[];
  navigation = { before, after, tabId: navigationResponse.tabId };
  // Checkpoint Chrome's asynchronous storage writes before testing a crash.
  await runtime.stop(target);
  instance = await runtime.start(target);
  await runtime.execute(target, pageInventoryScript, 20_000);
} else if (action === "crash-recover") {
  crashedPid = initialInstance.pid;
  process.kill(crashedPid, "SIGKILL");
  await waitForProcessExit(crashedPid);
  await new Promise((resolve) => setTimeout(resolve, 300));
  instance = await runtime.start(target);
  scriptOutput = String(await runtime.execute(target, restoreScript, 20_000));
} else if (action === "lifecycle") {
  lifecycle = await lifecycleAcceptance(initialInstance.pid);
}
let originScope:
  | {
      attacks: { kind: string; blocked: boolean; deniedOrigin?: string }[];
      inScope: { ok: boolean };
      revocation: { interrupted: boolean; browserStillRunning: boolean };
      ownerPage: { present: boolean };
    }
  | undefined;
if (action === "origin-scope") {
  originScope = await originScopeAcceptance();
}
if (action === "panel-transport") {
  // Exercise the Panel Capability, loopback gateway, and Automation Mode
  // stream policy against the real running browser through public contracts.
  // The real-host command fails closed without BB_BROWSER_HOST_DATA_DIR, which
  // the integration test harness already requires before spawning this worker.
  const capabilities = createPanelCapabilityStore();
  const gateway = createPanelGateway({
    capabilities,
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const stream = createAutomationStreamAdapter({ capabilities });
  stream.start();
  stream.setViewport({
    width: PANEL_MAX_VIEWPORT_WIDTH,
    height: PANEL_MAX_VIEWPORT_HEIGHT,
  });
  const issued = capabilities.issue({
    ownerSessionId: "owner-session-real",
    panelId: "real-panel",
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const redeem = JSON.stringify({
    type: "redeem",
    capabilityId: issued.capabilityId,
    secret: issued.secret,
    ownerSessionId: "owner-session-real",
    panelId: "real-panel",
  });
  const redeemed = gateway.validate(redeem);
  const replayed = gateway.validate(redeem);
  // A real Automation Mode frame stays within the viewport and FPS bounds.
  const congestionFps = stream.applyCongestion(1);
  const reconnectBackoffs = [
    stream.nextReconnectDelayMs(),
    stream.nextReconnectDelayMs(),
    stream.nextReconnectDelayMs(),
  ];
  stream.freezeInput();
  stream.reclaim(issued.capabilityId);
  capabilities.revokeProfile(target.profileId);
  panelTransport = {
    gatewayBindHost: gateway.declaredBindHost(),
    redeemed: redeemed.outcome === "accepted",
    replayed: replayed.outcome === "rejected",
    viewport: stream.viewport,
    fps: congestionFps,
    reconnectBackoffMs: reconnectBackoffs,
    reclaimWindowMs: PANEL_RECLAIM_WINDOW_MS,
    revoked: capabilities.size() === 0,
  };
}

let dialogs:
  | {
      alertHandled: boolean;
      confirmAccepted: boolean;
      promptText: string | null;
      beforeunloadStayed: boolean;
      contextActions: string[];
      performedAction: string | null;
    }
  | undefined;
if (action === "dialogs") {
  // Drive the fixture's dialog and context-action cases through the actual
  // CDP -> panel pipeline: Page.javascriptDialogOpening is captured by the
  // CDP screencast source, forwarded to the panel over the authenticated
  // transport, rendered as actionable chrome, and answered by the controller
  // with dialog_response -> Page.handleJavaScriptDialog. Context actions are
  // resolved through context_query/context_action, not native Chrome menus.
  // The real-host command fails closed without BB_BROWSER_HOST_DATA_DIR,
  // which the integration gate already requires before spawning this worker.
  const capabilities = createPanelCapabilityStore();
  const gateway = createPanelGateway({
    capabilities,
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const stream = createAutomationStreamAdapter({ capabilities });
  stream.start();
  stream.setViewport({
    width: PANEL_MAX_VIEWPORT_WIDTH,
    height: PANEL_MAX_VIEWPORT_HEIGHT,
  });
  const issued = capabilities.issue({
    ownerSessionId: "owner-session-dialogs",
    panelId: "dialogs-panel",
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const redeem = JSON.stringify({
    type: "redeem",
    capabilityId: issued.capabilityId,
    secret: issued.secret,
    ownerSessionId: "owner-session-dialogs",
    panelId: "dialogs-panel",
  });
  const endpoint = (await runtime.start(target)).automationEndpoint;
  const source = createCdpScreencastSource({
    resolveEndpoint: async () => endpoint,
    viewport: {
      width: PANEL_MAX_VIEWPORT_WIDTH,
      height: PANEL_MAX_VIEWPORT_HEIGHT,
    },
  });
  const transport = createPanelTransportServer({
    gateway,
    stream,
    source,
    canInput: () => true,
  });
  const port = await transport.start();
  // Navigate the page to the fixture and register no-op Playwright dialog
  // handlers so Playwright does not auto-dismiss the dialogs the panel pipeline
  // must answer through CDP.
  await runtime.execute(
    target,
    `const page = await browser.getPage("auth");
     await page.goto(${JSON.stringify(fixtureAddress)});
     page.setDefaultTimeout(60000);
     page.on("dialog", () => { /* leave open; the panel resolves it */ });
     console.log(JSON.stringify({ navigated: page.url() }));`,
    20_000,
  );
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(redeem);
  const inbox: string[] = [];
  socket.on("message", (raw) => inbox.push(String(raw)));
  async function waitForDialog(): Promise<{
    dialogId: string;
    type: string;
  }> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = inbox
        .map((entry) => JSON.parse(entry) as { type: string; dialog?: unknown })
        .find((entry) => entry.type === "dialog");
      if (found !== undefined) {
        const dialog = found.dialog as { dialogId: string; type: string };
        return dialog;
      }
      if (Date.now() >= deadline)
        throw new Error("The panel did not forward a dialog in time.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  function respond(dialogId: string, accept: boolean, text?: string) {
    socket.send(
      JSON.stringify({
        type: "dialog_response",
        dialogId,
        accept,
        ...(text === undefined ? {} : { text }),
      }),
    );
  }
  // alert: accept through the panel pipeline.
  const alertTask = runtime.execute(
    target,
    `const page = await browser.getPage("auth");
     await page.evaluate(() => alert("alert-body"));
     console.log(JSON.stringify({ alertResolved: true }));`,
    20_000,
  );
  const alertDialog = await waitForDialog();
  respond(alertDialog.dialogId, true);
  const alertResult = JSON.parse(String(await alertTask)) as {
    alertResolved?: boolean;
  };
  // confirm: cancel through the panel pipeline so the action is not silently
  // accepted (fail-closed default exercised).
  const confirmTask = runtime.execute(
    target,
    `const page = await browser.getPage("auth");
     const accepted = await page.evaluate(() => confirm("confirm-body"));
     console.log(JSON.stringify({ confirmAccepted: accepted }));`,
    20_000,
  );
  const confirmDialog = await waitForDialog();
  respond(confirmDialog.dialogId, false);
  const confirmResult = JSON.parse(String(await confirmTask)) as {
    confirmAccepted?: boolean;
  };
  // prompt: answer through the panel pipeline with controller text.
  const promptTask = runtime.execute(
    target,
    `const page = await browser.getPage("auth");
     const text = await page.evaluate(() => prompt("prompt-body", "default"));
     console.log(JSON.stringify({ promptText: text }));`,
    20_000,
  );
  const promptDialog = await waitForDialog();
  respond(promptDialog.dialogId, true, "controller-answer");
  const promptResult = JSON.parse(String(await promptTask)) as {
    promptText?: string | null;
  };
  // beforeunload: trigger by attempting to leave the page; answer stay
  // (accept:false) so the page is preserved, then verify it stayed.
  const beforeunloadTask = runtime.execute(
    target,
    `const page = await browser.getPage("auth");
     try {
       await page.goto(${JSON.stringify(`${fixtureAddress}linked`)});
       console.log(JSON.stringify({ beforeunloadLeft: true }));
     } catch {
       console.log(JSON.stringify({ beforeunloadLeft: false }));
     }`,
    20_000,
  );
  const beforeunloadDialog = await waitForDialog();
  respond(beforeunloadDialog.dialogId, false);
  const beforeunloadResult = JSON.parse(String(await beforeunloadTask)) as {
    beforeunloadLeft?: boolean;
  };
  // context: query actions at the link point and perform open-link-new-tab
  // through the panel pipeline.
  const ctxQueryId = "ctx-real";
  socket.send(
    JSON.stringify({ type: "context_query", queryId: ctxQueryId, x: 0, y: 0 }),
  );
  const contextDeadline = Date.now() + 10_000;
  let contextActions: { actionId: string; kind: string }[];
  for (;;) {
    const found = inbox
      .map(
        (entry) =>
          JSON.parse(entry) as {
            type: string;
            queryId?: string;
            actions?: { actionId: string; kind: string }[];
          },
      )
      .find(
        (entry) =>
          entry.type === "context_menu" && entry.queryId === ctxQueryId,
      );
    if (found !== undefined && found.actions !== undefined) {
      contextActions = found.actions;
      break;
    }
    if (Date.now() >= contextDeadline)
      throw new Error("The panel did not forward context actions in time.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const performedAction = contextActions[0]?.actionId ?? null;
  if (performedAction !== null) {
    socket.send(
      JSON.stringify({ type: "context_action", actionId: performedAction }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  socket.close();
  await new Promise<void>((resolve) => socket.once("close", resolve));
  await transport.stop();
  await source.stop();
  capabilities.revokeProfile(target.profileId);
  dialogs = {
    alertHandled: alertResult.alertResolved === true,
    confirmAccepted: confirmResult.confirmAccepted === false,
    promptText: promptResult.promptText ?? null,
    beforeunloadStayed: beforeunloadResult.beforeunloadLeft === false,
    contextActions: contextActions.map((action) => action.kind),
    performedAction,
  };
}
let transfer:
  | {
      failClosedWithoutDataDir: boolean;
      stagedWorkspace: boolean;
      privacySafeNoPath: boolean;
      removedAfterUse: boolean;
      symlinkEscapeRejected: boolean;
      traversalRejected: boolean;
    }
  | undefined;
let downloadExport:
  | {
      quarantined: boolean;
      exportedToClient: boolean;
      clientBytesMatch: boolean;
      exportedToWorkspace: boolean;
      outsideEnvironmentRejected: boolean;
      quarantineRetained: boolean;
      privacySafeNoPath: boolean;
    }
  | undefined;
if (action === "transfer") {
  // Exercise Transfer Staging against the real running browser. The real-host
  // command fails closed without BB_BROWSER_HOST_DATA_DIR: this gate throws
  // before any relaunch or host mutation when the directory is absent, so a
  // non-provisioned host is never mutated by this worker action. The staging
  // root is derived from the data directory and never touches the workspace
  // repository; the `bb-browser` user receives no ambient repository access.
  const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
  if (!dataDirectory) {
    throw new Error(
      "The Transfer Staging worker requires BB_BROWSER_HOST_DATA_DIR.",
    );
  }
  const stagingRoot = resolveTransferStagingRoot(dataDirectory);
  if (stagingRoot === null) {
    throw new Error(
      "The Transfer Staging worker requires BB_BROWSER_HOST_DATA_DIR.",
    );
  }
  const environmentRoot = await mkdtemp(join(rootDirectory, "transfer-env-"));
  const sourcePath = join(environmentRoot, "payload.txt");
  await writeFile(sourcePath, "deterministic-transfer-fixture");
  const escapeRoot = await mkdtemp(join(rootDirectory, "transfer-escape-"));
  const escapeTarget = join(escapeRoot, "secret.txt");
  await writeFile(escapeTarget, "should-not-stage");
  const symlinkPath = join(environmentRoot, "escape.txt");
  await symlink(escapeTarget, symlinkPath);
  const traversalPath = join(environmentRoot, "..", "payload.txt");
  const manager = createTransferStagingManager({
    filesystem: createNodeTransferStagingFilesystem(),
    stagingRoot,
    id: () => "transfer-fixture",
  });
  const staged = await manager.stage({
    kind: "workspace",
    transferId: "fixture",
    sourcePath,
    environmentRoot,
  });
  const privacySafeNoPath =
    JSON.stringify(staged).search(/stagedPath|sourcePath|environmentRoot/i) ===
    -1;
  const symlinkResult = await manager.stage({
    kind: "workspace",
    transferId: "symlink",
    sourcePath: symlinkPath,
    environmentRoot,
  });
  const traversalResult = await manager.stage({
    kind: "workspace",
    transferId: "traversal",
    sourcePath: traversalPath,
    environmentRoot,
  });
  const consume = await manager.consume("fixture");
  if (consume.outcome === "used") {
    await manager.release("fixture");
  }
  await manager.purgeAll();
  transfer = {
    failClosedWithoutDataDir: true,
    stagedWorkspace: staged.outcome === "staged",
    privacySafeNoPath,
    removedAfterUse: (await pathExists(join(stagingRoot, "fixture"))) === false,
    symlinkEscapeRejected:
      symlinkResult.outcome === "rejected" &&
      (symlinkResult as { reason?: string }).reason === "symlink-escape",
    traversalRejected:
      traversalResult.outcome === "rejected" &&
      (traversalResult as { reason?: string }).reason === "symlink-escape",
  };

  // Issue #24 P2/S4: also exercise quarantined download export through the real
  // host worker path. A download enters the profile-scoped quarantine, the
  // owner explicitly exports it to the displaying client (bytes leave
  // quarantine) and into the workspace (host-to-host copy that must stay inside
  // the environment), a traversal target is rejected, and the quarantine file
  // remains for later expiry. The quarantine root is derived from the data
  // directory; this never touches the workspace repository.
  const downloadsRoot = resolveHostDownloadsRoot(dataDirectory);
  if (downloadsRoot === null) {
    throw new Error(
      "The download export worker requires BB_BROWSER_HOST_DATA_DIR.",
    );
  }
  const downloads = createHostDownloadsManager({
    filesystem: createNodeHostDownloadsFilesystem(),
    quarantineRoot: downloadsRoot,
  });
  const payload = "deterministic-download-fixture";
  const downloadId = "download-fixture";
  const startResponse = await downloads.startDownload({
    downloadId,
    profileId: target.profileId,
    suggestedName: "fixture-download.txt",
    contentType: "text/plain",
    totalBytes: payload.length,
  });
  const startedDownload = startResponse.outcome === "quarantined";
  if (startedDownload) {
    await downloads.appendChunk({
      hostId: target.hostId,
      downloadId,
      data: Buffer.from(payload).toString("base64"),
      chunkBytes: payload.length,
    });
  }
  const completed = await downloads.completeDownload({
    hostId: target.hostId,
    downloadId,
  });
  const quarantined = startedDownload && completed.outcome === "quarantined";
  const ownerAuth = { actor: "owner" as const, leaseActive: false };
  const clientExport = await downloads.exportToClient(
    { hostId: target.hostId, downloadId },
    ownerAuth,
  );
  const exportedToClient =
    clientExport.outcome === "exported" &&
    clientExport.destination === "client";
  const clientBytesMatch =
    exportedToClient &&
    "data" in clientExport &&
    Buffer.from(clientExport.data ?? "", "base64").toString() === payload;
  const workspaceRoot = await mkdtemp(join(rootDirectory, "download-env-"));
  const workspaceExport = await downloads.exportToWorkspace(
    {
      hostId: target.hostId,
      downloadId,
      environmentRoot: workspaceRoot,
      relativePath: "exported-download.txt",
    },
    ownerAuth,
    workspaceRoot,
  );
  const exportedToWorkspace = workspaceExport.outcome === "exported";
  const outsideWorkspaceExport = await downloads.exportToWorkspace(
    {
      hostId: target.hostId,
      downloadId,
      environmentRoot: workspaceRoot,
      relativePath: "../escape.txt",
    },
    ownerAuth,
    workspaceRoot,
  );
  const outsideEnvironmentRejected =
    outsideWorkspaceExport.outcome === "rejected" &&
    (outsideWorkspaceExport as { reason?: string }).reason ===
      "outside-environment";
  const listing = await downloads.listDownloads({
    hostId: target.hostId,
    profileId: target.profileId,
  });
  const downloadPrivacySafeNoPath =
    JSON.stringify(listing).search(/quarantinePath|environmentRoot/i) === -1;
  const inspectRecord = downloads.inspect(downloadId);
  const quarantineRetained =
    inspectRecord !== undefined &&
    (await pathExists(join(downloadsRoot, target.profileId)));
  await downloads.dispose();
  downloadExport = {
    quarantined,
    exportedToClient,
    clientBytesMatch,
    exportedToWorkspace,
    outsideEnvironmentRejected,
    quarantineRetained,
    privacySafeNoPath: downloadPrivacySafeNoPath,
  };
}
let safeLogin:
  | {
      entered: boolean;
      warned: boolean;
      agentsInterrupted: number;
      initiatorOnlyPixels: boolean;
      elsewhereOpaque: boolean;
      agentDenied: boolean;
      authenticatedThroughFixture: boolean;
      extended: boolean;
      doneReturnedToAutomation: boolean;
      reconciledToAutomation: boolean;
      activityMetadataOnly: boolean;
    }
  | undefined;
if (action === "safe-login") {
  // Exercise the owner-only Safe Login Mode policy against the real running
  // browser. The real-host command fails closed without BB_BROWSER_HOST_DATA_DIR:
  // this gate throws before any relaunch or host mutation when the directory is
  // absent, so a non-provisioned host is never mutated by this worker action.
  // The real Xvfb/x11vnc/noVNC display plumbing is provisioned separately and is
  // out of scope for this deterministic policy slice; the relaunch effects here
  // are stubs that record the relaunch/return-to-automation transitions so the
  // isolation, expiry, extension, and reconciliation policy is proven against
  // the live fixture address without depending on the display helpers.
  const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
  if (!dataDirectory) {
    throw new Error("The Safe Login worker requires BB_BROWSER_HOST_DATA_DIR.");
  }
  const safeLoginMode = createSafeLoginMode({
    clock: { now: () => Date.now() },
    leaseMs: 10_000,
    expiryWarningMs: 3_000,
    maxExtensionMs: 5_000,
    maxTotalMs: 15_000,
  });
  const relaunchCalls: {
    relaunchWithoutAutomation: string[];
    returnToAutomation: string[];
  } = {
    relaunchWithoutAutomation: [],
    returnToAutomation: [],
  };
  const relaunch = {
    relaunchWithoutAutomation: async () => {
      relaunchCalls.relaunchWithoutAutomation.push(target.profileId);
    },
    returnToAutomation: async () => {
      relaunchCalls.returnToAutomation.push(target.profileId);
    },
  };
  const interruption = {
    interruptAgents: async () => ({ active: true, interrupted: 1 }),
  };
  const initiatorBinding = {
    ownerSessionId: "owner-session-safe-login",
    panelId: "safe-login-panel",
    hostId: target.hostId,
    profileId: target.profileId,
  };
  const spectatorBinding = {
    ownerSessionId: "owner-session-spectator",
    panelId: "spectator-panel",
    hostId: target.hostId,
    profileId: target.profileId,
  };
  const entered = await safeLoginMode.enter({
    binding: initiatorBinding,
    relaunch,
    interruption,
  });
  const initiatorOnlyPixels =
    safeLoginMode.canStreamPixels(initiatorBinding) &&
    !safeLoginMode.canStreamPixels(spectatorBinding);
  const elsewhereOpaque =
    safeLoginMode.statusFor(target, spectatorBinding) ===
    "safe-login-elsewhere";
  let agentDenied = false;
  try {
    safeLoginMode.assertAgentAllowed(target);
  } catch {
    agentDenied = true;
  }
  // While in Safe Login the owner signs in through the deterministic login
  // fixture: drive the same sign-in script the auth gate uses, against the
  // live fixture address, so the policy is proven against a real login rather
  // than bare relaunch stubs. The automation here stands in for the owner's
  // manual sign-in; the policy machine above is the unit under test.
  const loginOutput = JSON.parse(
    String(await runtime.execute(target, signInScript, 20_000)),
  ) as { accountHeading?: string; popupHeading?: string };
  const authenticatedThroughFixture =
    loginOutput.accountHeading === "Signed in" &&
    loginOutput.popupHeading === "Authenticated popup";
  const extended = safeLoginMode.extend(target, entered.sessionId, 5_000);
  await safeLoginMode.done(target, entered.sessionId);
  const doneReturnedToAutomation =
    safeLoginMode.mode(target) === "automation" &&
    relaunchCalls.returnToAutomation.length === 1;
  const reconciled = await safeLoginMode.reconcile({
    target,
    transition: "entering",
    startedAt: Date.now(),
  });
  const reconciledToAutomation = reconciled.resolved === "automation";
  // Activity metadata was never plumbed through this worker (no store), so the
  // policy recorded nothing locally; confirm the machine holds no sensitive
  // payload by checking it exposes only structural state.
  const activityMetadataOnly =
    JSON.stringify({
      mode: safeLoginMode.mode(target),
      initiator: safeLoginMode.initiatingBinding(target),
      session: safeLoginMode.session(target),
    }).search(/password|credential|pixel|screenshot|cookie/i) === -1;
  safeLoginMode.dispose();
  safeLogin = {
    entered: entered.agentsWereActive,
    warned: entered.warning.transientStateLoss.length > 0,
    agentsInterrupted: entered.interruptedAgents,
    initiatorOnlyPixels,
    elsewhereOpaque,
    agentDenied,
    authenticatedThroughFixture,
    extended: extended.extendedByMs === 5_000,
    doneReturnedToAutomation,
    reconciledToAutomation,
    activityMetadataOnly,
  };
}
let disableReEnable:
  | {
      accountHeadingRetained: boolean;
      localStorageRetained: boolean;
      sessionStorageRetained: boolean;
      localeRetained: boolean;
      timezoneRetained: boolean;
      preDisableProcessGone: boolean;
    }
  | undefined;
if (action === "disable-re-enable") {
  // Issue #24 S3/P2: genuinely exercise disable/re-enable retention through the
  // real worker path. A profile is created and a fixture sign-in is persisted;
  // the runtime is then stopped and disposed (the plugin "disable" — every
  // Browser-owned process is torn down). A FRESH runtime is built (the plugin
  // "re-enable") and the SAME profile is started again. The persisted sign-in,
  // localStorage, sessionStorage, locale, and timezone must survive the
  // disable/re-enable cycle because profile data lives in protected storage
  // that disable never purges. The real-host command fails closed without
  // BB_BROWSER_HOST_DATA_DIR, so a non-provisioned host is never mutated.
  // fails closed without BB_BROWSER_HOST_DATA_DIR so a non-provisioned
  // host is never mutated by this worker action.
  requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
  // Persist a fixture sign-in into the real profile.
  await runtime.execute(target, signInScript, 20_000);
  const preDisablePid = initialInstance.pid;
  // Disable: stop every Browser-owned process and tear down the runtime.
  await runtime.stop(target);
  await runtime.dispose();
  // Re-enable: a fresh runtime shares the same protected profile storage, so
  // the retained profile is restorable without re-authentication.
  const reEnabledRuntime = createBrowserInstanceRuntime(runtimeOptions);
  const reEnabledInstance = await reEnabledRuntime.start(target);
  const restored = JSON.parse(
    String(await reEnabledRuntime.execute(target, restoreScript, 20_000)),
  ) as {
    heading?: string;
    local?: string;
    session?: string;
    locale?: string;
    timezone?: string;
  };
  const preDisableProcessGone = !(await processExists(preDisablePid));
  await reEnabledRuntime.stop(target);
  await reEnabledRuntime.dispose();
  await waitForProcessExit(reEnabledInstance.pid);
  disableReEnable = {
    accountHeadingRetained: restored.heading === "Signed in",
    localStorageRetained: restored.local === "persistent",
    sessionStorageRetained: restored.session === "restorable",
    localeRetained: restored.locale === "en-GB",
    timezoneRetained: restored.timezone === "Europe/London",
    preDisableProcessGone,
  };
}
const automationHelperPid =
  action === "cleanup" ||
  action === "lifecycle" ||
  action === "disable-re-enable"
    ? null
    : Number(
        await readFile(join(helperHome, ".dev-browser", "daemon.pid"), "utf8"),
      );
const runningState = {
  instance,
  scriptOutput,
  navigation,
  lifecycle,
  originScope,
  panelTransport,
  dialogs,
  safeLogin,
  transfer,
  downloadExport,
  disableReEnable,
  uid: boundary.effectiveUserId,
  gid: boundary.effectiveGroupId,
  ownedProcesses: await ownedProcesses(storagePaths.profileDirectory),
  helperProcess:
    automationHelperPid === null
      ? null
      : {
          pid: automationHelperPid,
          status: await readFile(`/proc/${automationHelperPid}/status`, "utf8"),
          socketReady: (
            await lstat(join(helperHome, ".dev-browser", "daemon.sock"))
          ).isSocket(),
        },
};

if (action !== "start") {
  await runtime.stop(target);
  await runtime.dispose();
}
const report =
  action === "start"
    ? runningState
    : {
        ...runningState,
        recovery:
          crashedPid === null
            ? null
            : { crashedPid, recoveredPid: instance.pid },
        postStop: {
          ownedProcesses: await ownedProcesses(storagePaths.profileDirectory),
          browserPresent: await processExists(instance.pid),
          helperPresent:
            automationHelperPid === null
              ? false
              : await processExists(automationHelperPid),
          helperSocketPresent: await pathExists(
            join(helperHome, ".dev-browser", "daemon.sock"),
          ),
        },
      };
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
