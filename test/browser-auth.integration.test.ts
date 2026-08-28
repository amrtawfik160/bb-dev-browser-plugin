import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { projectLoopbackAddress } from "../browser-navigation.js";
import { profileStoragePaths } from "../profile-storage.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  provisionedBrowserStorageRoot,
} from "../readiness.js";

const integrationEnabled = process.env.BB_BROWSER_REAL_INTEGRATION === "1";
const integrationRequired =
  process.env.BB_BROWSER_REAL_INTEGRATION_REQUIRED === "1";
const lifecycleProfileSuffixes = [
  "lru-b",
  "lru-c",
  "lru-d",
  "pinned-refused",
  "crash-loop",
  "corrupt",
  "reload",
] as const;
if (integrationRequired && !integrationEnabled) {
  throw new Error("The mandatory real-browser gate cannot be skipped.");
}

function requiredEnvironment(name: string) {
  const setting = process.env[name];
  if (setting === undefined || setting === "") {
    throw new Error(`The provisioned-host gate requires ${name}.`);
  }
  return setting;
}

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

type WorkerReport = {
  instance: { pid: number; automationEndpoint: string; browser: string };
  scriptOutput: string;
  uid: number;
  gid: number;
  ownedProcesses: { pid: number; command: string; status: string }[];
  helperProcess: { pid: number; status: string; socketReady: boolean } | null;
  navigation?: { before: { id?: unknown }[]; after: unknown[]; tabId: string };
  recovery?: { crashedPid: number; recoveredPid: number } | null;
  lifecycle?: {
    initialPid: number;
    lruState: string;
    pinnedLimitCode: string | null;
    disconnectedCode: string | null;
    reconciledPid: number;
    idleStates: string[];
    crashPids: number[];
    crashLoopState: {
      state: string;
      diagnostics?: { crashCount: number; windowMs: number };
    };
    corruptCode: string | null;
    lazyState: string;
    reloadPids: number[];
  };
  postStop?: {
    ownedProcesses: { pid: number; command: string; status: string }[];
    browserPresent: boolean;
    helperPresent: boolean;
    helperSocketPresent: boolean;
  };
};

async function runWorker(environment: NodeJS.ProcessEnv) {
  const { stdout } = await promisify(execFile)(
    join(process.cwd(), "node_modules/.bin/vite-node"),
    ["--script", "test/fixtures/real-browser-worker.ts"],
    { env: { ...process.env, ...environment }, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim()) as WorkerReport;
}

function parsedScriptOutput(report: WorkerReport) {
  return JSON.parse(report.scriptOutput) as Record<string, unknown>;
}

function assertDedicatedIdentity(report: WorkerReport) {
  expect(report.uid).toBeGreaterThan(0);
  expect(report.gid).toBeGreaterThan(0);
  expect(report.ownedProcesses.length).toBeGreaterThan(0);
  for (const process_ of report.ownedProcesses) {
    expect(process_.status).toMatch(
      new RegExp(`^Uid:\\s+${report.uid}\\s`, "mu"),
    );
    expect(process_.status).toMatch(
      new RegExp(`^Gid:\\s+${report.gid}\\s`, "mu"),
    );
    expect(process_.command).not.toContain("--no-sandbox");
  }
  expect(report.helperProcess).not.toBeNull();
  expect(report.helperProcess?.socketReady).toBe(true);
  expect(report.helperProcess?.status).toMatch(
    new RegExp(`^Uid:\\s+${report.uid}\\s`, "mu"),
  );
  expect(report.helperProcess?.status).toMatch(
    new RegExp(`^Gid:\\s+${report.gid}\\s`, "mu"),
  );
}

async function assertProtectedProfileOwnership(
  path: string,
  report: WorkerReport,
) {
  const metadata = await stat(path);
  expect(metadata.isDirectory()).toBe(true);
  expect(metadata.uid).toBe(report.uid);
  expect(metadata.gid).toBe(report.gid);
  expect(metadata.mode & 0o7777).toBe(0o700);
}

async function assertLoopbackSocket(endpoint: string) {
  const url = new URL(endpoint);
  expect(url.hostname).toBe("127.0.0.1");
  const port = Number(url.port).toString(16).toUpperCase().padStart(4, "0");
  const sockets = `${await readFile("/proc/net/tcp", "utf8")}\n${await readFile("/proc/net/tcp6", "utf8")}`;
  expect(hasLoopbackListener(sockets, port)).toBe(true);
}

function hasLoopbackListener(sockets: string, port: string) {
  return sockets.split("\n").some((line) => {
    const fields = line.trim().split(/\s+/u);
    return fields[1] === `0100007F:${port}` && fields[3] === "0A";
  });
}

async function assertLoopbackSocketClosed(endpoint: string) {
  const url = new URL(endpoint);
  const port = Number(url.port).toString(16).toUpperCase().padStart(4, "0");
  await expect
    .poll(async () => {
      const sockets = `${await readFile("/proc/net/tcp", "utf8")}\n${await readFile("/proc/net/tcp6", "utf8")}`;
      return hasLoopbackListener(sockets, port);
    })
    .toBe(false);
}

function assertCompleteReadiness(
  readiness: Awaited<
    ReturnType<ReturnType<typeof createHostReadinessBoundary>["inspect"]>
  >,
) {
  expect(readiness.state).toBe("healthy");
  expect(readiness.capabilities).toHaveLength(9);
  expect(readiness.capabilities.every(({ status }) => status === "ready")).toBe(
    true,
  );
}

function assertStopped(report: WorkerReport) {
  expect(report.postStop).toEqual({
    ownedProcesses: [],
    browserPresent: false,
    helperPresent: false,
    helperSocketPresent: false,
  });
}

async function cleanupFixtureProfiles(options: {
  rootDirectory: string;
  installationId: string;
  hostId: string;
  profileId: string;
}) {
  const profileIds = [
    options.profileId,
    ...lifecycleProfileSuffixes.map(
      (suffix) => `${options.profileId}-${suffix}`,
    ),
  ];
  for (const profileId of profileIds) {
    const paths = profileStoragePaths({ ...options, profileId });
    await Promise.all([
      rm(paths.profileDirectory, { recursive: true, force: true }),
      rm(paths.runtimeManifestPath, { force: true }),
      rm(`${paths.runtimeManifestPath}.crashes.json`, { force: true }),
      rm(`${paths.runtimeManifestPath}.instance.lock`, { force: true }),
      rm(join(paths.runtimeManifestsDirectory, `bb-${profileId}`), {
        recursive: true,
        force: true,
      }),
    ]);
  }
}

it.runIf(integrationEnabled)(
  "mandatory provisioned host preserves authentication across a real worker restart",
  async () => {
    const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
    const rootDirectory = provisionedBrowserStorageRoot(
      process.env.BB_BROWSER_REAL_ROOT,
    );
    const hostId = process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host";
    const profileId =
      process.env.BB_BROWSER_REAL_PROFILE_ID ?? "ci-auth-fixture";
    const projectId =
      process.env.BB_BROWSER_REAL_PROJECT_ID ?? "ci-browser-project";
    const installationId = hostInstallationId(dataDirectory);
    const target = { hostId, profileId };
    const snapshotReader = createDefaultHostSnapshotReader(dataDirectory);
    const snapshot = await snapshotReader.snapshot(target);
    const readiness =
      await createHostReadinessBoundary(snapshotReader).inspect(target);
    assertCompleteReadiness(readiness);
    expect(snapshot.dedicatedUser.state).toBe("ready");
    expect(snapshot.protectedStorage.state).toBe("ready");
    expect(snapshot.browser?.compatible).toBe(true);
    expect(snapshot.sandbox.available).toBe(true);

    const server = authenticationFixture();
    const port = await listen(server);
    const fixtureAddress = projectLoopbackAddress(
      projectId,
      `http://localhost:${port}/account`,
    );
    const paths = profileStoragePaths({
      rootDirectory,
      installationId,
      hostId,
      profileId,
    });
    const workerEnvironment = {
      BB_BROWSER_REAL_ROOT: rootDirectory,
      BB_BROWSER_REAL_INSTALLATION_ID: installationId,
      BB_BROWSER_REAL_HOST_ID: hostId,
      BB_BROWSER_REAL_PROFILE_ID: profileId,
      BB_BROWSER_REAL_PROJECT_ID: projectId,
      BB_BROWSER_FIXTURE_ADDRESS: fixtureAddress,
    };
    const fixtureProfiles = {
      rootDirectory,
      installationId,
      hostId,
      profileId,
    };
    await cleanupFixtureProfiles(fixtureProfiles);
    let cleanupRequired = false;
    try {
      cleanupRequired = true;
      const first = await runWorker({
        ...workerEnvironment,
        BB_BROWSER_WORKER_ACTION: "start",
      });
      expect(parsedScriptOutput(first)).toMatchObject({
        accountHeading: "Signed in",
        popupHeading: "Authenticated popup",
      });
      expect(first.instance.browser).toBe(
        snapshot.browser?.name.startsWith("Google Chrome")
          ? "chrome-stable"
          : "playwright-chromium",
      );
      assertDedicatedIdentity(first);
      await assertProtectedProfileOwnership(paths.hostStoragePath, first);
      await assertProtectedProfileOwnership(paths.profileDirectory, first);
      await assertProtectedProfileOwnership(paths.browserDataPath, first);
      await assertLoopbackSocket(first.instance.automationEndpoint);
      expect(first.navigation?.after).toHaveLength(
        first.navigation?.before.length ?? -1,
      );
      expect(first.navigation?.before.map(({ id }) => id)).toContain(
        first.navigation?.tabId,
      );
      await expect(
        access(`${paths.runtimeManifestPath}.instance.lock`),
      ).resolves.toBeUndefined();

      const restored = await runWorker({
        ...workerEnvironment,
        BB_BROWSER_WORKER_ACTION: "crash-recover",
      });
      expect(restored.recovery).toEqual({
        crashedPid: first.instance.pid,
        recoveredPid: restored.instance.pid,
      });
      expect(restored.instance.pid).not.toBe(first.instance.pid);
      expect(restored.instance.browser).toBe(first.instance.browser);
      expect(parsedScriptOutput(restored)).toMatchObject({
        heading: "Signed in",
        popupHeading: "Authenticated popup",
        local: "persistent",
        session: "restorable",
        locale: "en-GB",
        timezone: "Europe/London",
      });
      assertDedicatedIdentity(restored);
      assertStopped(restored);
      await assertLoopbackSocketClosed(first.instance.automationEndpoint);
      await assertLoopbackSocketClosed(restored.instance.automationEndpoint);

      const lifecycle = await runWorker({
        ...workerEnvironment,
        BB_BROWSER_WORKER_ACTION: "lifecycle",
      });
      expect(lifecycle.lifecycle).toMatchObject({
        lruState: "sleeping",
        pinnedLimitCode: "awake-limit",
        disconnectedCode: "host-offline",
        idleStates: ["sleeping", "sleeping", "sleeping"],
        crashLoopState: {
          state: "repair-required",
          diagnostics: { crashCount: 3, windowMs: 5 * 60 * 1_000 },
        },
        corruptCode: "repair-required",
        lazyState: "sleeping",
      });
      expect(lifecycle.lifecycle?.reconciledPid).toBe(
        lifecycle.lifecycle?.initialPid,
      );
      expect(new Set(lifecycle.lifecycle?.crashPids).size).toBe(3);
      expect(lifecycle.lifecycle?.reloadPids[0]).not.toBe(
        lifecycle.lifecycle?.reloadPids[1],
      );
      assertStopped(lifecycle);
      cleanupRequired = false;
      await expect(access(paths.runtimeManifestPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        access(`${paths.runtimeManifestPath}.instance.lock`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (cleanupRequired) {
        await runWorker({
          ...workerEnvironment,
          BB_BROWSER_WORKER_ACTION: "cleanup",
        });
      }
      await close(server);
      await cleanupFixtureProfiles(fixtureProfiles);
    }
  },
  240_000,
);
