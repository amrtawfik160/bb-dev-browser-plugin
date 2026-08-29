import { execFile } from "node:child_process";
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
import {
  closeLoopbackFixture,
  createLoopbackAuthFixture,
  listenLoopbackFixture,
} from "./fixtures/loopback-auth-fixture.js";

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
    const fixtureServer = createLoopbackAuthFixture();
    const fixturePort = await listenLoopbackFixture(fixtureServer);
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
      await closeLoopbackFixture(fixtureServer);
    }
  },
  240_000,
);
