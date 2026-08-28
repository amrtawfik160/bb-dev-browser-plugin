import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserInstanceError,
  createBrowserInstanceRuntime,
  selectBrowserExecutable,
  validateBrowserLaunchPolicy,
  type BrowserLaunchBoundary,
  type BrowserLaunchRequest,
} from "../browser-runtime.js";
import { fallbackBrowserPaths } from "../browser-fallback.js";
import { PINNED_BROWSER_RUNTIME } from "../dependency-inventory.js";
import { profileStoragePaths } from "../profile-storage.js";

function launchFixture(
  options: {
    endpoint?: string;
    runAsUser?: string;
    groupId?: number;
    recoveredPid?: number;
    recoveredLaunchingPid?: number;
  } = {},
) {
  const launches: BrowserLaunchRequest[] = [];
  const executions: { endpoint: string; code: string; timeoutMs: number }[] =
    [];
  const stopped: number[] = [];
  const exits = new Map<number, (error?: Error) => void>();
  const pages = new Set(["actual-active-tab"]);
  let nextPid = 4100;
  const boundary: BrowserLaunchBoundary = {
    runAsUser: options.runAsUser ?? "bb-browser",
    effectiveUserId: 1001,
    effectiveGroupId: options.groupId ?? 1001,
    async launch(request, onSpawn) {
      launches.push(request);
      const pid = nextPid++;
      let reportExit!: (error?: Error) => void;
      const exited = new Promise<void>((resolve, reject) => {
        reportExit = (error) =>
          error === undefined ? resolve() : reject(error);
      });
      exits.set(pid, reportExit);
      const identity = {
        pid,
        startedAtTicks: `fixture-${pid}`,
        commandHash: `fixture-command-${pid}`,
      };
      await onSpawn?.(identity);
      return {
        pid,
        automationEndpoint:
          options.endpoint ?? `http://127.0.0.1:${12_000 + launches.length}`,
        async stop() {
          stopped.push(pid);
          reportExit();
        },
        exited,
      };
    },
    async recover(_request, identity, endpoint) {
      const recoveredPid = identity?.pid ?? options.recoveredLaunchingPid;
      if (
        recoveredPid === undefined ||
        (identity !== null && recoveredPid !== options.recoveredPid)
      ) {
        return null;
      }
      let reportExit!: (error?: Error) => void;
      const exited = new Promise<void>((resolve, reject) => {
        reportExit = (error) =>
          error === undefined ? resolve() : reject(error);
      });
      exits.set(recoveredPid, reportExit);
      return {
        pid: recoveredPid,
        automationEndpoint:
          endpoint ?? "ws://127.0.0.1:14901/devtools/browser/launching-orphan",
        exited,
        async stop() {
          stopped.push(recoveredPid);
          reportExit();
        },
      };
    },
    async processIdentity(pid) {
      return {
        pid,
        startedAtTicks: `fixture-${pid}`,
        commandHash: `fixture-command-${pid}`,
      };
    },
    async execute(request) {
      executions.push(request);
      if (request.code.includes("document.visibilityState")) {
        return JSON.stringify({
          id: "actual-active-tab",
          url: "about:blank",
          title: "",
          name: null,
        });
      }
      const requestedPage = request.code.match(
        /browser\.getPage\(("(?:[^"\\]|\\.)*")\)/u,
      )?.[1];
      if (requestedPage !== undefined) pages.add(JSON.parse(requestedPage));
      return { output: "attached" };
    },
    async configuredSearchUrl({ text }) {
      return `https://search.fixture.test/?q=${encodeURIComponent(text)}`;
    },
  };
  return {
    boundary,
    executions,
    launches,
    pages,
    stopped,
    crash(pid: number) {
      exits.get(pid)?.();
    },
    fail(pid: number) {
      exits.get(pid)?.(new Error("fixture process observer failed"));
    },
  };
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
      projectId: "project-a",
    },
  };
}

describe("Browser Instance runtime", () => {
  it("issue #12 sleeps an idle instance while a visible panel pins its profile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const fixture = await runtimeFixture();
    try {
      await fixture.runtime.start(fixture.target);
      await fixture.runtime.pinPanel(fixture.target, "panel-a");

      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(await fixture.runtime.status(fixture.target)).toMatchObject({
        state: "running",
      });

      await fixture.runtime.unpinPanel(fixture.target, "panel-a");
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(await fixture.runtime.status(fixture.target)).toEqual({
        state: "sleeping",
        hostId: "host-a",
        profileId: "profile-a",
      });
      expect(fixture.processFixture.stopped).toEqual([4100]);
    } finally {
      await fixture.runtime.dispose();
      vi.useRealTimers();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 exposes Waking while a lazy browser launch is in progress", async () => {
    const fixture = await runtimeFixture();
    const launch = fixture.processFixture.boundary.launch;
    let releaseLaunch!: () => void;
    const launchReleased = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launchStarted = vi.fn();
    fixture.processFixture.boundary.launch = async (request, onSpawn) => {
      launchStarted();
      await launchReleased;
      return launch(request, onSpawn);
    };
    try {
      const waking = fixture.runtime.start(fixture.target);
      await vi.waitFor(() => expect(launchStarted).toHaveBeenCalledOnce());
      expect(await fixture.runtime.status(fixture.target)).toMatchObject({
        state: "waking",
      });

      releaseLaunch();
      await expect(waking).resolves.toMatchObject({ state: "running" });
    } finally {
      releaseLaunch();
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 evicts the least-recently-used hidden profile at the default awake limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const fixture = await runtimeFixture();
    const target = (profileId: string) => ({ ...fixture.target, profileId });
    try {
      await fixture.runtime.start(target("profile-a"));
      await vi.advanceTimersByTimeAsync(1);
      await fixture.runtime.start(target("profile-b"));
      await vi.advanceTimersByTimeAsync(1);
      await fixture.runtime.start(target("profile-c"));
      await vi.advanceTimersByTimeAsync(1);
      await fixture.runtime.start(target("profile-d"));

      expect(await fixture.runtime.status(target("profile-a"))).toMatchObject({
        state: "sleeping",
      });
      expect(await fixture.runtime.status(target("profile-d"))).toMatchObject({
        state: "running",
      });
      expect(fixture.processFixture.stopped).toEqual([4100]);
    } finally {
      await fixture.runtime.dispose();
      vi.useRealTimers();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 refuses a fourth wake when panels pin every awake profile", async () => {
    const fixture = await runtimeFixture();
    const target = (profileId: string) => ({ ...fixture.target, profileId });
    try {
      for (const profileId of ["profile-a", "profile-b", "profile-c"]) {
        await fixture.runtime.pinPanel(target(profileId), `panel-${profileId}`);
      }

      await expect(
        fixture.runtime.start(target("profile-d")),
      ).rejects.toMatchObject({ code: "awake-limit" });
      expect(fixture.processFixture.launches).toHaveLength(3);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 keeps an active agent Control Lease awake across the idle deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const fixture = await runtimeFixture();
    let releaseExecution!: () => void;
    const executionReleased = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const executionStarted = vi.fn();
    fixture.processFixture.boundary.execute = async () => {
      executionStarted();
      await executionReleased;
      return "lease-complete";
    };
    try {
      const operation = fixture.runtime.execute(
        fixture.target,
        "return page.url()",
        30_000,
      );
      await vi.waitFor(() => expect(executionStarted).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(await fixture.runtime.status(fixture.target)).toMatchObject({
        state: "running",
      });

      releaseExecution();
      await expect(operation).resolves.toBe("lease-complete");
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
      expect(await fixture.runtime.status(fixture.target)).toMatchObject({
        state: "sleeping",
      });
    } finally {
      releaseExecution();
      await fixture.runtime.dispose();
      vi.useRealTimers();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 serializes simultaneous wakes at the default capacity", async () => {
    const fixture = await runtimeFixture();
    const target = (profileId: string) => ({ ...fixture.target, profileId });
    try {
      await Promise.all([
        fixture.runtime.start(target("profile-a")),
        fixture.runtime.start(target("profile-b")),
        fixture.runtime.start(target("profile-c")),
      ]);
      await Promise.all([
        fixture.runtime.start(target("profile-d")),
        fixture.runtime.start(target("profile-e")),
      ]);

      const states = await Promise.all(
        ["profile-a", "profile-b", "profile-c", "profile-d", "profile-e"].map(
          async (profileId) =>
            (await fixture.runtime.status(target(profileId))).state,
        ),
      );
      expect(states.filter((state) => state === "running")).toHaveLength(3);
      expect(fixture.processFixture.stopped).toHaveLength(2);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 restarts an isolated crash and enters repair after a three-crash loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const fixture = await runtimeFixture();
    try {
      for (let crashNumber = 0; crashNumber < 3; crashNumber += 1) {
        const running = await fixture.runtime.start(fixture.target);
        fixture.processFixture.crash(running.pid);
        await vi.advanceTimersByTimeAsync(25);
      }

      await vi.waitFor(async () => {
        expect(await fixture.runtime.status(fixture.target)).toMatchObject({
          state: "repair-required",
          diagnostics: { crashCount: 3, windowMs: 5 * 60 * 1_000 },
        });
      });
      expect(fixture.processFixture.launches).toHaveLength(3);
    } finally {
      await fixture.runtime.dispose();
      vi.useRealTimers();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 freezes a disconnected host and reconciles the retained generation", async () => {
    const fixture = await runtimeFixture();
    try {
      const running = await fixture.runtime.start(fixture.target);
      fixture.runtime.hostDisconnected(fixture.target.hostId);

      await expect(
        fixture.runtime.execute(fixture.target, "return page.url()", 5_000),
      ).rejects.toMatchObject({ code: "host-offline" });
      expect(fixture.processFixture.stopped).toEqual([]);

      await fixture.runtime.hostReconnected(fixture.target.hostId);
      expect(await fixture.runtime.start(fixture.target)).toMatchObject({
        pid: running.pid,
      });
      expect(fixture.processFixture.launches).toHaveLength(1);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 defers crash recovery while the host is disconnected", async () => {
    const fixture = await runtimeFixture();
    try {
      const running = await fixture.runtime.start(fixture.target);
      fixture.runtime.hostDisconnected(fixture.target.hostId);
      fixture.processFixture.crash(running.pid);
      const paths = profileStoragePaths({
        rootDirectory: fixture.rootDirectory,
        installationId: "installation-a",
        hostId: fixture.target.hostId,
        profileId: fixture.target.profileId,
      });
      await vi.waitFor(async () => {
        await expect(
          readFile(paths.runtimeManifestPath, "utf8"),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
      expect(await fixture.runtime.status(fixture.target)).toMatchObject({
        state: "host-offline",
      });
      expect(fixture.processFixture.launches).toHaveLength(1);

      await fixture.runtime.hostReconnected(fixture.target.hostId);
      await expect(
        fixture.runtime.start(fixture.target),
      ).resolves.toMatchObject({
        state: "running",
      });
      expect(fixture.processFixture.launches).toHaveLength(2);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #12 disposes owned children without restarting the retired worker generation", async () => {
    const fixture = await runtimeFixture();
    const running = await fixture.runtime.start(fixture.target);
    await fixture.runtime.dispose();

    expect(fixture.processFixture.stopped).toEqual([running.pid]);
    await expect(fixture.runtime.start(fixture.target)).rejects.toMatchObject({
      code: "browser-unavailable",
    });
    expect(fixture.processFixture.launches).toHaveLength(1);
    await rm(fixture.rootDirectory, { recursive: true, force: true });
  });

  it("issue #12 stays lazy after worker restart and fails closed on a corrupt manifest", async () => {
    const fixture = await runtimeFixture();
    const installationId = "installation-corrupt";
    const paths = profileStoragePaths({
      rootDirectory: fixture.rootDirectory,
      installationId,
      hostId: fixture.target.hostId,
      profileId: fixture.target.profileId,
    });
    await mkdir(paths.runtimeManifestsDirectory, { recursive: true });
    await writeFile(paths.runtimeManifestPath, "{not-json");
    const runtime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId,
      chromeStablePaths: [fixture.browserExecutable],
      playwrightChromiumPath: join(fixture.rootDirectory, "fallback-chromium"),
      launchBoundary: fixture.processFixture.boundary,
    });
    try {
      expect(fixture.processFixture.launches).toHaveLength(0);
      expect(await runtime.status(fixture.target)).toMatchObject({
        state: "sleeping",
      });
      await expect(runtime.start(fixture.target)).rejects.toMatchObject({
        code: "repair-required",
      });
      expect(fixture.processFixture.launches).toHaveLength(0);
    } finally {
      await runtime.dispose();
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });
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

  it("uses only an ownership- and integrity-verified canonical fallback", async () => {
    const fixture = await runtimeFixture();
    const fallback = fallbackBrowserPaths(
      profileStoragePaths({
        rootDirectory: fixture.rootDirectory,
        installationId: "installation-canonical",
        hostId: fixture.target.hostId,
        profileId: fixture.target.profileId,
      }).hostStoragePath,
    );
    await mkdir(fallback.directory, { recursive: true });
    await writeFile(fallback.executablePath, "fixture executable");
    await chmod(fallback.executablePath, 0o755);
    await chown(fallback.executablePath, 1001, 1001);
    await writeFile(
      fallback.manifestPath,
      JSON.stringify({
        ...PINNED_BROWSER_RUNTIME,
        executableSha256:
          "6f1af2dfc4d7f16dacf404b1f6c9fd4a65cfffb8edde6dcf957463a0e41fb1ed",
      }),
    );
    await chmod(fallback.manifestPath, 0o600);
    await chown(fallback.manifestPath, 1001, 1001);
    const runtime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-canonical",
      chromeStablePaths: [],
      launchBoundary: fixture.processFixture.boundary,
    });
    try {
      await expect(runtime.start(fixture.target)).resolves.toMatchObject({
        browser: "playwright-chromium",
      });
      expect(fixture.processFixture.launches[0]?.executablePath).toBe(
        fallback.executablePath,
      );
    } finally {
      await runtime.dispose();
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    [
      {
        runAsUser: "root",
        effectiveUserId: 0,
        effectiveGroupId: 0,
        chromeArguments: [],
      },
      "root",
    ],
    [
      {
        runAsUser: "bb-browser",
        effectiveUserId: 1001,
        effectiveGroupId: 0,
        chromeArguments: [],
      },
      "root group",
    ],
    [
      {
        runAsUser: "bb-browser",
        effectiveUserId: 1001,
        effectiveGroupId: 1001,
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
      expect(launch.chromeArguments).toContain("--no-first-run");
      expect(launch.chromeArguments).toContain("--no-default-browser-check");
      expect(launch.chromeArguments).toContain("--disable-sync");
      expect(launch.chromeArguments).toContain("--disable-extensions");
      expect(launch.chromeArguments.join(" ")).toContain("PasswordManager");
      expect(launch.chromeArguments.join(" ")).toContain("AutofillAddress");
      expect(launch.chromeArguments.join(" ")).toContain("AutofillCreditCard");
      expect(launch.chromeArguments).not.toContain("--password-store=basic");
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
    await writeFile(
      lockPath,
      JSON.stringify({
        workerIdentity: {
          pid: 2_147_000_000,
          startedAtTicks: "dead-worker",
          commandHash: "dead-worker-command",
        },
      }),
    );
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

  it("attaches to an identity-matched orphan instead of launching a duplicate", async () => {
    const fixture = await runtimeFixture();
    const recoveredPid = 4900;
    const recoveryBoundary = launchFixture({ recoveredPid });
    const runtime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-recovery",
      chromeStablePaths: [fixture.browserExecutable],
      playwrightChromiumPath: join(fixture.rootDirectory, "fallback-chromium"),
      launchBoundary: recoveryBoundary.boundary,
    });
    const recoveryPaths = profileStoragePaths({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-recovery",
      hostId: fixture.target.hostId,
      profileId: fixture.target.profileId,
    });
    await mkdir(recoveryPaths.runtimeManifestsDirectory, { recursive: true });
    await writeFile(
      `${recoveryPaths.runtimeManifestPath}.instance.lock`,
      JSON.stringify({
        workerIdentity: {
          pid: 2_147_000_000,
          startedAtTicks: "dead-worker",
          commandHash: "dead-worker-command",
        },
      }),
    );
    await writeFile(
      recoveryPaths.runtimeManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        phase: "starting",
        identity: {
          pid: recoveredPid,
          startedAtTicks: `fixture-${recoveredPid}`,
          commandHash: `fixture-command-${recoveredPid}`,
        },
        automationEndpoint: "ws://127.0.0.1:14900/devtools/browser/orphan",
        publicState: null,
      }),
    );
    try {
      await expect(runtime.start(fixture.target)).resolves.toMatchObject({
        pid: recoveredPid,
      });
      expect(recoveryBoundary.launches).toHaveLength(0);
      const manifest = JSON.parse(
        await readFile(recoveryPaths.runtimeManifestPath, "utf8"),
      ) as { phase: string };
      expect(manifest.phase).toBe("running");
    } finally {
      await runtime.dispose();
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #11 publishes launch intent before crossing the process-spawn boundary", async () => {
    const fixture = await runtimeFixture();
    const paths = profileStoragePaths({
      rootDirectory: fixture.rootDirectory,
      installationId: "installation-a",
      hostId: fixture.target.hostId,
      profileId: fixture.target.profileId,
    });
    const launch = fixture.processFixture.boundary.launch;
    fixture.processFixture.boundary.launch = async (request, onSpawn) => {
      const manifest = JSON.parse(
        await readFile(paths.runtimeManifestPath, "utf8"),
      ) as { phase: string; identity: unknown };
      expect(manifest).toMatchObject({ phase: "launching", identity: null });
      return launch(request, onSpawn);
    };
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

  it("issue #11 recovers a browser orphaned after spawn but before identity publication", async () => {
    const fixture = await runtimeFixture();
    const recoveredPid = 4901;
    const recoveryBoundary = launchFixture({
      recoveredLaunchingPid: recoveredPid,
    });
    const installationId = "installation-launching-recovery";
    const runtime = createBrowserInstanceRuntime({
      rootDirectory: fixture.rootDirectory,
      installationId,
      chromeStablePaths: [fixture.browserExecutable],
      playwrightChromiumPath: join(fixture.rootDirectory, "fallback-chromium"),
      launchBoundary: recoveryBoundary.boundary,
    });
    const paths = profileStoragePaths({
      rootDirectory: fixture.rootDirectory,
      installationId,
      hostId: fixture.target.hostId,
      profileId: fixture.target.profileId,
    });
    await mkdir(paths.runtimeManifestsDirectory, { recursive: true });
    await writeFile(
      `${paths.runtimeManifestPath}.instance.lock`,
      JSON.stringify({
        workerIdentity: {
          pid: 2_147_000_000,
          startedAtTicks: "dead-worker",
          commandHash: "dead-worker-command",
        },
      }),
    );
    await writeFile(
      paths.runtimeManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        phase: "launching",
        identity: null,
        automationEndpoint: null,
        publicState: null,
      }),
    );
    try {
      await expect(runtime.start(fixture.target)).resolves.toMatchObject({
        pid: recoveredPid,
      });
      expect(recoveryBoundary.launches).toHaveLength(0);
    } finally {
      await runtime.dispose();
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("navigates addresses directly and delegates search text to Chrome", async () => {
    const fixture = await runtimeFixture();
    try {
      await fixture.runtime.navigate(
        { ...fixture.target, projectId: "project-a", tabId: "tab-a" },
        "https://fixture.example/account",
      );
      await fixture.runtime.navigate(
        { ...fixture.target, projectId: "project-a" },
        "configured search query",
      );

      expect(fixture.processFixture.executions[0]?.code).toContain(
        'page.goto("https://fixture.example/account")',
      );
      expect(fixture.processFixture.executions[0]?.code).toContain(
        'browser.getPage("tab-a")',
      );
      expect(fixture.processFixture.executions[1]?.code).not.toContain(
        "keyboard.press",
      );
      expect(fixture.processFixture.executions[1]?.code).toContain(
        'browser.getPage("tab-a")',
      );
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #11 navigates the actual active tab when the panel omits a tab target", async () => {
    const fixture = await runtimeFixture();
    try {
      const response = await fixture.runtime.navigate(
        fixture.target,
        "https://fixture.example/default-navigation",
      );

      expect([...fixture.processFixture.pages]).toEqual(["actual-active-tab"]);
      expect(response.tabId).toBe("actual-active-tab");
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("makes an explicitly targeted agent tab the shared active tab", async () => {
    const fixture = await runtimeFixture();
    try {
      await fixture.runtime.execute(
        { ...fixture.target, projectId: "project-a", tabId: "tab-agent" },
        "console.log(await browser.listPages())",
        5_000,
      );
      await fixture.runtime.navigate(
        { ...fixture.target, projectId: "project-a" },
        "https://fixture.example/after-agent",
      );

      expect(fixture.processFixture.executions[0]?.code).toContain(
        'browser.getPage("tab-agent")',
      );
      expect(fixture.processFixture.executions[0]?.code).toContain(
        "await __bbTargetPage.bringToFront()",
      );
      expect(fixture.processFixture.executions[1]?.code).toContain(
        'browser.getPage("tab-agent")',
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

  it("retires a crashed Browser Instance and automatically starts a clean replacement", async () => {
    const fixture = await runtimeFixture();
    try {
      const first = await fixture.runtime.start(fixture.target);
      fixture.processFixture.crash(first.pid);
      await vi.waitFor(() => {
        expect(fixture.processFixture.launches).toHaveLength(2);
      });

      const repaired = await fixture.runtime.start(fixture.target);

      expect(repaired.pid).not.toBe(first.pid);
      expect(fixture.processFixture.launches).toHaveLength(2);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("recovers ownership when the browser exit observer reports an error", async () => {
    const fixture = await runtimeFixture();
    try {
      const first = await fixture.runtime.start(fixture.target);
      fixture.processFixture.fail(first.pid);
      await vi.waitFor(() => {
        expect(fixture.processFixture.launches).toHaveLength(2);
      });

      await expect(
        fixture.runtime.start(fixture.target),
      ).resolves.toMatchObject({
        state: "running",
      });
      expect(fixture.processFixture.launches).toHaveLength(2);
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
    }
  });

  it("issue #11 requires repair after three crashes within five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
    const fixture = await runtimeFixture();
    try {
      for (let crashNumber = 0; crashNumber < 3; crashNumber += 1) {
        const instance = await fixture.runtime.start(fixture.target);
        fixture.processFixture.crash(instance.pid);
        await vi.advanceTimersByTimeAsync(50);
      }
      await fixture.runtime.dispose();
      const restartedProcess = launchFixture();
      const restartedRuntime = createBrowserInstanceRuntime({
        rootDirectory: fixture.rootDirectory,
        installationId: "installation-a",
        chromeStablePaths: [fixture.browserExecutable],
        playwrightChromiumPath: join(
          fixture.rootDirectory,
          "fallback-chromium",
        ),
        launchBoundary: restartedProcess.boundary,
      });
      await expect(
        restartedRuntime.start(fixture.target),
      ).rejects.toMatchObject({
        code: "repair-required",
        diagnostics: {
          crashCount: 3,
          windowMs: 300_000,
        },
      });
      expect(fixture.processFixture.launches).toHaveLength(3);
      expect(restartedProcess.launches).toHaveLength(0);
      await restartedRuntime.dispose();
    } finally {
      await fixture.runtime.dispose();
      await rm(fixture.rootDirectory, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });
});
