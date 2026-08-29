import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createProductionBrowserProcessBoundary } from "../../browser-process.js";
import {
  BrowserOriginScopeDeniedError,
  createBrowserInstanceRuntime,
} from "../../browser-runtime.js";
import { profileStoragePaths } from "../../profile-storage.js";

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
const runtime = createBrowserInstanceRuntime(runtimeOptions);
const storagePaths = profileStoragePaths({
  rootDirectory,
  installationId: requiredEnvironment("BB_BROWSER_REAL_INSTALLATION_ID"),
  hostId: target.hostId,
  profileId: target.profileId,
});
const helperHome = join(
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
          deniedOrigin: error.origin,
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
if (action === "start") {
  scriptOutput = String(await runtime.execute(target, signInScript, 20_000));
  const before = JSON.parse(
    String(await runtime.execute(target, pageInventoryScript, 20_000)),
  ) as unknown[];
  const navigationResponse = await runtime.navigate(target, fixtureAddress);
  const after = JSON.parse(
    String(await runtime.execute(target, pageInventoryScript, 20_000)),
  ) as unknown[];
  navigation = { before, after, tabId: navigationResponse.tabId };
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
const automationHelperPid =
  action === "cleanup" || action === "lifecycle"
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
  uid: boundary.effectiveUserId,
  gid: boundary.effectiveGroupId,
  ownedProcesses: await ownedProcesses(rootDirectory),
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
          ownedProcesses: await ownedProcesses(rootDirectory),
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
