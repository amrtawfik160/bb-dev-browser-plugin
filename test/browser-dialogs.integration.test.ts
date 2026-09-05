import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { projectLoopbackAddress } from "../src/browser/browser-navigation.js";
import { profileStoragePaths } from "../src/host/profile-storage.js";
import {
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
        reject(new Error("The dialog fixture did not bind TCP."));
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

/**
 * A local fixture page that triggers every dialog type and exposes a link and
 * image so the Automation Mode context actions can be exercised without native
 * Chrome context menus.
 */
function dialogFixture() {
  return createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/") {
      response.end(
        [
          "<h1>Dialog fixture</h1>",
          '<button id="alert">alert</button>',
          '<button id="confirm">confirm</button>',
          '<button id="prompt">prompt</button>',
          '<a id="link" href="/linked">Linked page</a>',
          '<img id="image" src="/image.png" alt="fixture image" />',
          "<script>",
          'document.getElementById("alert").onclick = () => alert("alert-body");',
          'document.getElementById("confirm").onclick = () => confirm("confirm-body");',
          'document.getElementById("prompt").onclick = () => prompt("prompt-body", "default");',
          // A real beforeunload handler so the controller must choose
          // stay/leave through the panel pipeline (issue #17 SPEC-5).
          "window.addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = 'leave-body'; });",
          "</script>",
        ].join("\n"),
      );
      return;
    }
    if (request.url === "/linked") {
      response.end("<h1>Linked</h1>");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
}

type WorkerReport = {
  instance: { pid: number; automationEndpoint: string; browser: string };
  uid: number;
  gid: number;
  dialogs?: {
    alertHandled: boolean;
    confirmAccepted: boolean;
    promptText: string | null;
    beforeunloadStayed: boolean;
    contextActions: string[];
    performedAction: string | null;
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

async function cleanupFixtureProfiles(options: {
  rootDirectory: string;
  installationId: string;
  hostId: string;
  profileId: string;
}) {
  const paths = profileStoragePaths({ ...options });
  await Promise.all([
    rm(paths.profileDirectory, { recursive: true, force: true }),
    rm(paths.runtimeManifestPath, { force: true }),
    rm(`${paths.runtimeManifestPath}.instance.lock`, { force: true }),
    rm(join(paths.runtimeManifestsDirectory, `bb-${options.profileId}`), {
      recursive: true,
      force: true,
    }),
  ]);
}

it.runIf(integrationEnabled)(
  "mandatory provisioned host renders every dialog and context action through Automation Mode controls",
  async () => {
    // The real-host command fails closed without BB_BROWSER_HOST_DATA_DIR,
    // which the integration gate requires before spawning the worker.
    const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
    const rootDirectory = provisionedBrowserStorageRoot(
      process.env.BB_BROWSER_REAL_ROOT,
    );
    const hostId = process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host";
    const profileId =
      process.env.BB_BROWSER_REAL_PROFILE_ID ?? "ci-dialogs-fixture";
    const projectId =
      process.env.BB_BROWSER_REAL_PROJECT_ID ?? "ci-browser-project";
    const installationId = hostInstallationId(dataDirectory);
    const fixtureProfiles = {
      rootDirectory,
      installationId,
      hostId,
      profileId,
    };
    await cleanupFixtureProfiles(fixtureProfiles);
    const server = dialogFixture();
    const port = await listen(server);
    const fixtureAddress = projectLoopbackAddress(
      projectId,
      `http://localhost:${port}/`,
    );
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
      const report = await runWorker({
        ...workerEnvironment,
        BB_BROWSER_WORKER_ACTION: "dialogs",
      });
      expect(report.dialogs?.alertHandled).toBe(true);
      expect(report.dialogs?.confirmAccepted).toBe(false);
      expect(report.dialogs?.promptText).toBe("controller-answer");
      expect(report.dialogs?.beforeunloadStayed).toBe(true);
      expect(report.dialogs?.contextActions).toContain("open-link-new-tab");
      expect(report.dialogs?.contextActions).toContain("copy-link");
      expect(report.dialogs?.performedAction).not.toBe(null);
      cleanupRequired = false;
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
