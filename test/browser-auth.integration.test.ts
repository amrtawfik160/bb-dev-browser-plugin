import { createServer, type Server } from "node:http";
import { access, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createProductionBrowserProcessBoundary } from "../browser-process.js";
import { projectLoopbackAddress } from "../browser-navigation.js";
import { createBrowserInstanceRuntime } from "../browser-runtime.js";

const runRealBrowser = process.env.BB_BROWSER_REAL_INTEGRATION === "1";

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The local authentication fixture did not bind TCP."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function authenticationFixture() {
  return createServer((request, response) => {
    const signedIn = request.headers.cookie?.includes("fixture-session=valid");
    if (request.method === "POST" && request.url === "/sign-in") {
      response.writeHead(303, {
        location: "/account",
        "set-cookie": "fixture-session=valid; Path=/; SameSite=Lax",
      });
      response.end();
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/account" && signedIn) {
      response.end(
        "<h1>Signed in</h1><button id=\"popup\" onclick=\"open('/popup', 'fixture-popup')\">Popup</button>",
      );
      return;
    }
    if (request.url === "/popup" && signedIn) {
      response.end("<h1>Authenticated popup</h1>");
      return;
    }
    response.end(
      '<form method="post" action="/sign-in"><input name="user"><button>Sign in</button></form>',
    );
  });
}

function parseBrowserOutput(output: unknown) {
  if (typeof output !== "string") throw new Error("Invalid browser output.");
  return JSON.parse(output) as Record<string, unknown>;
}

it.runIf(runRealBrowser)(
  "preserves deterministic authentication, storage, popup tabs, and locale across restart",
  async () => {
    const chromeStable =
      process.env.BB_BROWSER_CHROME_PATH ?? "/usr/bin/google-chrome-stable";
    await access(chromeStable);
    const rootDirectory = await mkdtemp(join(tmpdir(), "browser-auth-"));
    await chmod(rootDirectory, 0o755);
    const server = authenticationFixture();
    const port = await listen(server);
    const require = createRequire(import.meta.url);
    const devBrowserDirectory = dirname(
      require.resolve("dev-browser/package.json"),
    );
    const boundary = createProductionBrowserProcessBoundary({
      devBrowserExecutable: join(devBrowserDirectory, "bin", "dev-browser.js"),
      devBrowserPackageDirectory: devBrowserDirectory,
    });
    const runtimeOptions = {
      rootDirectory,
      installationId: "installation-auth",
      chromeStablePaths: [chromeStable],
      playwrightChromiumPath: chromium.executablePath(),
      launchBoundary: boundary,
    };
    const target = {
      hostId: "host-auth",
      profileId: "profile-auth",
      locale: "en-GB",
      timezone: "Europe/London",
    };
    const projectAddress = projectLoopbackAddress(
      "project-auth",
      `http://localhost:${port}/account`,
    );
    let runtime = createBrowserInstanceRuntime(runtimeOptions);
    try {
      const first = await runtime.start(target);
      const uid = boundary.effectiveUserId;
      expect(await readFile(`/proc/${first.pid}/status`, "utf8")).toMatch(
        new RegExp(`^Uid:\\s+${uid}\\s`, "mu"),
      );
      expect(first.automationEndpoint).toMatch(/^ws:\/\/127\.0\.0\.1:/u);

      const signedIn = parseBrowserOutput(
        await runtime.execute(
          target,
          `const page = await browser.getPage("auth");
await page.goto(${JSON.stringify(projectAddress)});
await page.fill("input[name=user]", "fixture-user");
await Promise.all([page.waitForURL("**/account"), page.click("button")]);
await page.evaluate(() => {
  localStorage.setItem("local-token", "persistent");
  sessionStorage.setItem("session-token", "restorable");
});
const popupReady = page.waitForEvent("popup");
await page.click("#popup");
await (await popupReady).waitForLoadState("domcontentloaded");
console.log(JSON.stringify({ pages: await browser.listPages() }));`,
          15_000,
        ),
      );
      expect(JSON.stringify(signedIn.pages)).toContain("/popup");

      const competing = createBrowserInstanceRuntime(runtimeOptions);
      await expect(competing.start(target)).rejects.toMatchObject({
        code: "profile-in-use",
      });
      await competing.dispose();
      await runtime.stop(target);
      await runtime.dispose();

      runtime = createBrowserInstanceRuntime(runtimeOptions);
      const restored = parseBrowserOutput(
        await runtime.execute(
          target,
          `const pages = await browser.listPages();
const account = pages.find((page) => page.url.includes("/account"));
if (!account) throw new Error("account tab was not restored");
const page = await browser.getPage(account.id);
console.log(JSON.stringify({
  pages,
  heading: await page.locator("h1").textContent(),
  local: await page.evaluate(() => localStorage.getItem("local-token")),
  session: await page.evaluate(() => sessionStorage.getItem("session-token")),
  locale: await page.evaluate(() => navigator.language),
  timezone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
}));`,
          15_000,
        ),
      );
      expect(restored).toMatchObject({
        heading: "Signed in",
        local: "persistent",
        session: "restorable",
        locale: "en-GB",
        timezone: "Europe/London",
      });
      expect(JSON.stringify(restored.pages)).toContain("/popup");
    } finally {
      await runtime.dispose();
      await close(server);
      await rm(rootDirectory, { recursive: true, force: true });
    }
  },
  60_000,
);
