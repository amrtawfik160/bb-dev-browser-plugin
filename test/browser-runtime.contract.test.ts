import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrowserInstanceError,
  createBrowserInstanceRuntime,
  selectBrowserExecutable,
  validateBrowserLaunchPolicy,
  type BrowserLaunchBoundary,
  type BrowserLaunchRequest,
} from "../browser-runtime.js";
import { profileStoragePaths } from "../profile-storage.js";

function launchFixture(
  options: { endpoint?: string; runAsUser?: string } = {},
) {
  const launches: BrowserLaunchRequest[] = [];
  const executions: { endpoint: string; code: string; timeoutMs: number }[] =
    [];
  const stopped: number[] = [];
  let nextPid = 4100;
  const boundary: BrowserLaunchBoundary = {
    runAsUser: options.runAsUser ?? "bb-browser",
    effectiveUserId: 1001,
    async launch(request) {
      launches.push(request);
      const pid = nextPid++;
      return {
        pid,
        automationEndpoint:
          options.endpoint ?? `http://127.0.0.1:${12_000 + launches.length}`,
        async stop() {
          stopped.push(pid);
        },
      };
    },
    async execute(request) {
      executions.push(request);
      return { output: "attached" };
    },
  };
  return { boundary, executions, launches, stopped };
}

async function runtimeFixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "browser-runtime-"));
  const browserExecutable = join(rootDirectory, "chrome");
  await writeFile(browserExecutable, "fixture");
  await chmod(browserExecutable, 0o755);
  const processFixture = launchFixture();
  const runtime = createBrowserInstanceRuntime({
    rootDirectory,
    installationId: "installation-a",
    chromeStablePaths: [browserExecutable],
    playwrightChromiumPath: join(rootDirectory, "fallback-chromium"),
    launchBoundary: processFixture.boundary,
  });
  return {
    rootDirectory,
    browserExecutable,
    processFixture,
    runtime,
    target: {
      hostId: "host-a",
      profileId: "profile-a",
      locale: "en-GB",
      timezone: "Europe/London",
    },
  };
}

describe("Browser Instance runtime", () => {
  it("coalesces starts and holds an exclusive installation/host/profile lock", async () => {
    const fixture = await runtimeFixture();
    const competingFixture = launchFixture();
    const competingRuntime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-a",
      chromeStablePaths: [fixture.browserExecutable],
      playwrightChromiumPath: join(fixture.rootDirectory, "fallback-chromium"),
      launchBoundary: competingFixture.boundary,
    });
    try {
      const [first, second] = await Promise.all([
        fixture.runtime.start(fixture.target),
        fixture.runtime.start(fixture.target),
      ]);

      expect(first).toEqual(second);
      expect(fixture.processFixture.launches).toHaveLength(1);
      await expect(
        competingRuntime.start(fixture.target),
      ).rejects.toMatchObject({
        code: "profile-in-use",
      });
      expect(competingFixture.launches).toHaveLength(0);

      await fixture.runtime.stop(fixture.target);
      await expect(
        competingRuntime.start(fixture.target),
      ).resolves.toMatchObject({
        state: "running",
      });
    } finally {
      await fixture.runtime.dispose();
      await competingRuntime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("prefers executable Chrome Stable and otherwise uses pinned Chromium", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "browser-selection-"));
    const stable = join(rootDirectory, "google-chrome-stable");
    const fallback = join(rootDirectory, "chromium-1208");
    await writeFile(stable, "stable");
    await writeFile(fallback, "fallback");
    await chmod(stable, 0o755);
    await chmod(fallback, 0o755);
    try {
      await expect(
        selectBrowserExecutable({
          chromeStablePaths: [stable],
          playwrightChromiumPath: fallback,
        }),
      ).resolves.toEqual({ kind: "chrome-stable", executablePath: stable });
      await chmod(stable, 0o600);
      await expect(
        selectBrowserExecutable({
          chromeStablePaths: [stable],
          playwrightChromiumPath: fallback,
        }),
      ).resolves.toEqual({
        kind: "playwright-chromium",
        executablePath: fallback,
      });
    } finally {
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    [{ runAsUser: "root", effectiveUserId: 0, chromeArguments: [] }, "root"],
    [
      {
        runAsUser: "bb-browser",
        effectiveUserId: 1001,
        chromeArguments: ["--no-sandbox"],
      },
      "sandbox",
    ],
  ])("fails closed for an unsafe browser launch", (launch, reason) => {
    expect(() => validateBrowserLaunchPolicy(launch)).toThrow(reason);
  });

  it("rejects a non-loopback Automation Mode endpoint", async () => {
    const fixture = await runtimeFixture();
    const remoteLaunch = launchFixture({ endpoint: "http://0.0.0.0:9222" });
    const runtime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-remote",
      chromeStablePaths: [fixture.browserExecutable],
      playwrightChromiumPath: join(fixture.rootDirectory, "fallback-chromium"),
      launchBoundary: remoteLaunch.boundary,
    });
    try {
      await expect(runtime.start(fixture.target)).rejects.toBeInstanceOf(
        BrowserInstanceError,
      );
      await expect(runtime.start(fixture.target)).rejects.toMatchObject({
        code: "endpoint-not-loopback",
      });
    } finally {
      await runtime.dispose();
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("lets dev-browser attach without transferring Browser Instance lifecycle", async () => {
    const fixture = await runtimeFixture();
    try {
      await expect(
        fixture.runtime.execute(
          fixture.target,
          "console.log(await browser.listPages())",
          5_000,
        ),
      ).resolves.toEqual({ output: "attached" });

      expect(fixture.processFixture.launches).toHaveLength(1);
      expect(fixture.processFixture.executions).toEqual([
        expect.objectContaining({
          endpoint: "http://127.0.0.1:12001",
          code: "console.log(await browser.listPages())",
          timeoutMs: 5_000,
        }),
      ]);
      expect(fixture.processFixture.stopped).toEqual([]);

      await fixture.runtime.stop(fixture.target);
      expect(fixture.processFixture.stopped).toEqual([4100]);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("preserves profile-owned Restorable Session files on graceful stop", async () => {
    const fixture = await runtimeFixture();
    const paths = profileStoragePaths({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-a",
      hostId: fixture.target.hostId,
      profileId: fixture.target.profileId,
    });
    const retainedFiles = [
      ["Local State", "browser-started"],
      ["Cookies", "signed-in"],
      ["Local Storage", "persistent"],
      ["Session Storage", "restorable"],
      ["Current Tabs", "fixture-tab-locations"],
    ] as const;
    await mkdir(paths.browserDataPath, { recursive: true });
    for (const [name, contents] of retainedFiles) {
      await writeFile(join(paths.browserDataPath, name), contents);
    }
    try {
      await fixture.runtime.start(fixture.target);
      const launch = fixture.processFixture.launches[0]!;
      expect(launch.chromeArguments).toContain("--restore-last-session");
      expect(launch.chromeArguments).toContain("--lang=en-GB");
      expect(launch.chromeArguments).not.toContain("about:blank");

      await fixture.runtime.stop(fixture.target);
      for (const [name, contents] of retainedFiles) {
        await expect(
          readFile(join(paths.browserDataPath, name), "utf8"),
        ).resolves.toBe(contents);
      }
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("recovers an exclusive lock left by a dead worker", async () => {
    const fixture = await runtimeFixture();
    const paths = profileStoragePaths({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-a",
      hostId: fixture.target.hostId,
      profileId: fixture.target.profileId,
    });
    const lockPath = `${paths.runtimeManifestPath}.instance.lock`;
    await mkdir(paths.runtimeManifestsDirectory, { recursive: true });
    await writeFile(lockPath, JSON.stringify({ workerPid: 2_147_000_000 }));
    try {
      await expect(
        fixture.runtime.start(fixture.target),
      ).resolves.toMatchObject({
        state: "running",
      });
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("navigates addresses directly and delegates search text to Chrome", async () => {
    const fixture = await runtimeFixture();
    try {
      await fixture.runtime.navigate(
        fixture.target,
        "https://fixture.example/account",
      );
      await fixture.runtime.navigate(fixture.target, "configured search query");

      expect(fixture.processFixture.executions[0]?.code).toContain(
        'page.goto("https://fixture.example/account")',
      );
      expect(fixture.processFixture.executions[1]?.code).toContain(
        'page.keyboard.press("Control+L")',
      );
      expect(fixture.processFixture.executions[1]?.code).toContain(
        'page.keyboard.type("configured search query")',
      );
      expect(fixture.processFixture.executions[1]?.code).not.toMatch(
        /google|bing|duckduckgo/iu,
      );
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("releases profile ownership when graceful process cleanup reports a failure", async () => {
    const fixture = await runtimeFixture();
    const launch = fixture.processFixture.boundary.launch;
    fixture.processFixture.boundary.launch = async (request) => {
      const running = await launch(request);
      return {
        ...running,
        async stop() {
          await running.stop();
          throw new Error("fixture helper cleanup failed");
        },
      };
    };
    const competitor = launchFixture();
    const competingRuntime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-a",
      chromeStablePaths: [fixture.browserExecutable],
      playwrightChromiumPath: join(fixture.rootDirectory, "fallback-chromium"),
      launchBoundary: competitor.boundary,
    });
    try {
      await fixture.runtime.start(fixture.target);
      await expect(fixture.runtime.stop(fixture.target)).rejects.toThrow(
        "helper cleanup failed",
      );
      await expect(
        competingRuntime.start(fixture.target),
      ).resolves.toMatchObject({
        state: "running",
      });
    } finally {
      await fixture.runtime.dispose();
      await competingRuntime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });
});
