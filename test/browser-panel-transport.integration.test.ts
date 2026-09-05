import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { projectLoopbackAddress } from "../src/browser/browser-navigation.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  provisionedBrowserStorageRoot,
} from "../src/host/readiness.js";

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
    panelTransport: {
      gatewayBindHost: string;
      redeemed: boolean;
      replayed: boolean;
      viewport: { width: number; height: number };
      fps: number;
      reconnectBackoffMs: number[];
      reclaimWindowMs: number;
      revoked: boolean;
    };
  };
}

describe("real-host command fail-closed gate", () => {
  it("fails closed without BB_BROWSER_HOST_DATA_DIR and never mutates the host", () => {
    // The real-host command (the provisioned-host worker) is only spawned by
    // the mandatory integration gate, which requires BB_BROWSER_HOST_DATA_DIR
    // before doing anything. Without it the gate throws and never provisions
    // or mutates the host.
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
  "mandatory provisioned host streams Automation Mode through an authenticated loopback gateway",
  async () => {
    // The real-host command fails closed without BB_BROWSER_HOST_DATA_DIR.
    const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
    const rootDirectory = provisionedBrowserStorageRoot(
      process.env.BB_BROWSER_REAL_ROOT,
    );
    const hostId = process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host";
    const profileId =
      process.env.BB_BROWSER_REAL_PROFILE_ID ?? "ci-panel-transport";
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

    const fixtureAddress = projectLoopbackAddress(
      projectId,
      "http://localhost:0/account",
    );
    const workerEnvironment = {
      BB_BROWSER_REAL_ROOT: rootDirectory,
      BB_BROWSER_REAL_INSTALLATION_ID: installationId,
      BB_BROWSER_REAL_HOST_ID: hostId,
      BB_BROWSER_REAL_PROFILE_ID: profileId,
      BB_BROWSER_REAL_PROJECT_ID: projectId,
      BB_BROWSER_FIXTURE_ADDRESS: fixtureAddress,
      BB_BROWSER_WORKER_ACTION: "panel-transport",
    };
    let cleanupRequired = false;
    try {
      cleanupRequired = true;
      const report = await runWorker(workerEnvironment);
      const transport = report.panelTransport;
      expect(transport.gatewayBindHost).toBe("127.0.0.1");
      expect(transport.redeemed).toBe(true);
      expect(transport.replayed).toBe(true);
      expect(transport.viewport).toEqual({
        width: 1920,
        height: 1080,
      });
      expect(transport.fps).toBeGreaterThanOrEqual(5);
      expect(transport.fps).toBeLessThanOrEqual(15);
      expect(transport.reconnectBackoffMs[0]).toBeLessThanOrEqual(
        transport.reconnectBackoffMs[1]!,
      );
      expect(transport.reconnectBackoffMs[2]!).toBeLessThanOrEqual(8000);
      expect(transport.reclaimWindowMs).toBe(10_000);
      expect(transport.revoked).toBe(true);
      // The transport never exposes the loopback gateway to the report.
      expect(JSON.stringify(report)).not.toContain("ws://");
    } finally {
      if (cleanupRequired) {
        await runWorker({
          ...workerEnvironment,
          BB_BROWSER_WORKER_ACTION: "cleanup",
        });
      }
    }
  },
  240_000,
);
