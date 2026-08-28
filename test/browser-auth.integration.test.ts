import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { projectLoopbackAddress } from "../browser-navigation.js";
import { profileStoragePaths } from "../profile-storage.js";
import {
  createDefaultHostSnapshotReader,
  hostInstallationId,
} from "../readiness.js";

const integrationEnabled = process.env.BB_BROWSER_REAL_INTEGRATION === "1";
const integrationRequired =
  process.env.BB_BROWSER_REAL_INTEGRATION_REQUIRED === "1";
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

async function assertLoopbackSocket(endpoint: string) {
  const url = new URL(endpoint);
  expect(url.hostname).toBe("127.0.0.1");
  const port = Number(url.port).toString(16).toUpperCase().padStart(4, "0");
  const sockets = `${await readFile("/proc/net/tcp", "utf8")}\n${await readFile("/proc/net/tcp6", "utf8")}`;
  expect(sockets).toContain(`0100007F:${port}`);
}

it.runIf(integrationEnabled)(
  "mandatory provisioned host preserves authentication across a real worker restart",
  async () => {
    const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
    const rootDirectory =
      process.env.BB_BROWSER_REAL_ROOT ?? "/var/lib/bb-browser";
    const hostId = process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host";
    const profileId =
      process.env.BB_BROWSER_REAL_PROFILE_ID ?? "ci-auth-fixture";
    const projectId =
      process.env.BB_BROWSER_REAL_PROJECT_ID ?? "ci-browser-project";
    const installationId = hostInstallationId(dataDirectory);
    const target = { hostId, profileId };
    const snapshot =
      await createDefaultHostSnapshotReader(dataDirectory).snapshot(target);
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
      await assertLoopbackSocket(first.instance.automationEndpoint);
      await expect(
        access(`${paths.runtimeManifestPath}.instance.lock`),
      ).resolves.toBeUndefined();

      const restored = await runWorker({
        ...workerEnvironment,
        BB_BROWSER_WORKER_ACTION: "restore",
      });
      expect(restored.instance.pid).toBe(first.instance.pid);
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
      await rm(paths.profileDirectory, { recursive: true, force: true });
    }
  },
  120_000,
);
