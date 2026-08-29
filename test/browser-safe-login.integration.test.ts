import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { projectLoopbackAddress } from "../browser-navigation.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  provisionedBrowserStorageRoot,
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
    // The real-host command fails closed without the provisioned host data
    // directory. It never provisions or mutates the host.
    throw new Error(`The provisioned-host gate requires ${name}.`);
  }
  return setting;
}

async function runWorker(environment: NodeJS.ProcessEnv) {
  const { stdout } = await promisify(execFile)(
    join(process.cwd(), "node_modules/.bin/vite-node"),
    ["--script", "test/fixtures/real-browser-worker.ts"],
    { env: { ...process.env, ...environment }, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout.trim()) as {
    safeLogin: {
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
    };
  };
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

describe("real-host Safe Login command fail-closed gate", () => {
  it("fails closed without BB_BROWSER_HOST_DATA_DIR and never mutates the host", () => {
    // The provisioned-host worker requires BB_BROWSER_HOST_DATA_DIR before it
    // relaunches the profile for Safe Login. Without it the gate throws and
    // never provisions or mutates the host.
    const original = process.env.BB_BROWSER_HOST_DATA_DIR;
    try {
      process.env.BB_BROWSER_HOST_DATA_DIR = "";
      expect(() => requiredEnvironment("BB_BROWSER_HOST_DATA_DIR")).toThrow(
        /BB_BROWSER_HOST_DATA_DIR/u,
      );
    } finally {
      if (original === undefined) delete process.env.BB_BROWSER_HOST_DATA_DIR;
      else process.env.BB_BROWSER_HOST_DATA_DIR = original;
    }
  });
});

it.runIf(integrationEnabled)(
  "mandatory provisioned host exercises Safe Login isolation, extension, exit, and reconciliation",
  async () => {
    // The real-host command fails closed without BB_BROWSER_HOST_DATA_DIR.
    const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
    const rootDirectory = provisionedBrowserStorageRoot(
      process.env.BB_BROWSER_REAL_ROOT,
    );
    const hostId = process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host";
    const profileId = process.env.BB_BROWSER_REAL_PROFILE_ID ?? "ci-safe-login";
    const projectId =
      process.env.BB_BROWSER_REAL_PROJECT_ID ?? "ci-browser-project";
    const installationId = hostInstallationId(dataDirectory);
    const target = { hostId, profileId };
    const snapshotReader = createDefaultHostSnapshotReader(dataDirectory);
    const snapshot = await snapshotReader.snapshot(target);
    expect(snapshot.connect.enrolled).toBe(true);
    expect(snapshot.sandbox.available).toBe(true);
    await expect(
      createHostReadinessBoundary(snapshotReader).inspect(target),
    ).resolves.toMatchObject({ state: "healthy" });

    // Safe Login drives the same deterministic login fixture the auth gate
    // uses: spin up the local authentication server and point the worker at it
    // so the owner signs in through the fixture rather than bare stubs.
    const fixtureServer = authenticationFixture();
    const fixturePort = await listen(fixtureServer);
    const fixtureAddress = projectLoopbackAddress(
      projectId,
      `http://localhost:${fixturePort}/account`,
    );
    const workerEnvironment = {
      BB_BROWSER_REAL_ROOT: rootDirectory,
      BB_BROWSER_REAL_INSTALLATION_ID: installationId,
      BB_BROWSER_REAL_HOST_ID: hostId,
      BB_BROWSER_REAL_PROFILE_ID: profileId,
      BB_BROWSER_REAL_PROJECT_ID: projectId,
      BB_BROWSER_HOST_DATA_DIR: dataDirectory,
      BB_BROWSER_FIXTURE_ADDRESS: fixtureAddress,
      BB_BROWSER_WORKER_ACTION: "safe-login",
    };
    let cleanupRequired = false;
    try {
      cleanupRequired = true;
      const report = await runWorker(workerEnvironment);
      const safeLogin = report.safeLogin;
      expect(safeLogin.entered).toBe(true);
      expect(safeLogin.warned).toBe(true);
      expect(safeLogin.agentsInterrupted).toBe(1);
      expect(safeLogin.initiatorOnlyPixels).toBe(true);
      expect(safeLogin.elsewhereOpaque).toBe(true);
      expect(safeLogin.agentDenied).toBe(true);
      expect(safeLogin.authenticatedThroughFixture).toBe(true);
      expect(safeLogin.extended).toBe(true);
      expect(safeLogin.doneReturnedToAutomation).toBe(true);
      expect(safeLogin.reconciledToAutomation).toBe(true);
      expect(safeLogin.activityMetadataOnly).toBe(true);
      // The worker never exposes transport secrets in its report.
      expect(JSON.stringify(report)).not.toContain("ws://");
    } finally {
      if (cleanupRequired) {
        await runWorker({
          ...workerEnvironment,
          BB_BROWSER_WORKER_ACTION: "cleanup",
        });
      }
      await close(fixtureServer);
    }
  },
  240_000,
);
