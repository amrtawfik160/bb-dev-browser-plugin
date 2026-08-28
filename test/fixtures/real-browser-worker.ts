import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createProductionBrowserProcessBoundary } from "../../browser-process.js";
import { createBrowserInstanceRuntime } from "../../browser-runtime.js";
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

const action = requiredEnvironment("BB_BROWSER_WORKER_ACTION");
if (!new Set(["start", "restore", "cleanup"]).has(action)) {
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
const runtime = createBrowserInstanceRuntime({
  rootDirectory,
  installationId: requiredEnvironment("BB_BROWSER_REAL_INSTALLATION_ID"),
  chromeStablePaths: [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ],
  launchBoundary: boundary,
});
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
console.log(JSON.stringify({
  pages: await browser.listPages(),
  popupHeading: await popup.locator("h1").textContent(),
  accountHeading: await page.locator("h1").textContent(),
}));`;

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

const instance = await runtime.start(target);
const scriptOutput =
  action === "cleanup"
    ? "{}"
    : await runtime.execute(
        target,
        action === "start" ? signInScript : restoreScript,
        20_000,
      );
const helperPid =
  action === "cleanup"
    ? null
    : Number(
        await readFile(join(helperHome, ".dev-browser", "daemon.pid"), "utf8"),
      );
const report = {
  instance,
  scriptOutput,
  uid: boundary.effectiveUserId,
  gid: boundary.effectiveGroupId,
  ownedProcesses: await ownedProcesses(rootDirectory),
  helperProcess:
    helperPid === null
      ? null
      : {
          pid: helperPid,
          status: await readFile(`/proc/${helperPid}/status`, "utf8"),
          socketReady: (
            await lstat(join(helperHome, ".dev-browser", "daemon.sock"))
          ).isSocket(),
        },
};

if (action !== "start") {
  await runtime.stop(target);
  await runtime.dispose();
}
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
