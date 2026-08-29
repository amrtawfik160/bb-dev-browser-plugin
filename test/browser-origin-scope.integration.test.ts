import { execFile } from "node:child_process";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions,
} from "node:https";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { X509Certificate, generateKeyPairSync, createSign } from "node:crypto";
import { expect, it } from "vitest";
import { projectLoopbackAlias } from "../authorization.js";
import { profileStoragePaths } from "../profile-storage.js";
import {
  createDefaultHostSnapshotReader,
  hostInstallationId,
  provisionedBrowserStorageRoot,
} from "../readiness.js";

/**
 * Real-browser Origin Scope enforcement against a local malicious fixture.
 *
 * These tests drive a provisioned Workspace Browser through the same worker
 * fixture used by the authentication gate, but with an "origin-scope" action
 * that exercises chained redirects, window opening, nested frames, DNS-style
 * hostname tricks, port changes, mixed schemes, invalid certificates, and a
 * revocation race. They are gated behind BB_BROWSER_REAL_INTEGRATION and
 * require a provisioned host data directory; without BB_BROWSER_HOST_DATA_DIR
 * the real-host command fails closed and never mutates the host.
 */

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

type HttpishServer = HttpServer | HttpsServer;

function listen(server: HttpishServer) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The local malicious fixture did not bind TCP."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: HttpishServer) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function selfSignedCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const subject = "/CN=origin-scope-fixture.localhost";
  const derSubject = Buffer.from(subject, "latin1");
  const tbs = Buffer.concat([
    Buffer.from([0x30, derSubject.length]),
    derSubject,
  ]);
  const sign = createSign("SHA256");
  sign.update(tbs);
  const signature = sign.sign(privateKey);
  const certDer = Buffer.concat([
    Buffer.from([0x30, 0x82]),
    Buffer.from([0x01, 0x21]),
    tbs,
    publicKey.export({ type: "spki", format: "der" }),
    Buffer.from([0x02, 0x01, 0x00]),
    Buffer.from([0x30, 0x0d]),
    Buffer.from([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05,
      0x00,
    ]),
    Buffer.from([0x03, 0x82, 0x01, 0x0f, 0x00]),
    signature,
  ]);
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: new X509Certificate(certDer).toString(),
  };
}

type WorkerReport = {
  originScope: {
    attacks: { kind: string; blocked: boolean; deniedOrigin?: string }[];
    inScope: { ok: boolean };
    revocation: { interrupted: boolean; browserStillRunning: boolean };
    ownerPage: { present: boolean };
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

const ATTACK_KINDS = [
  "redirect",
  "redirect-chain",
  "popup",
  "frame",
  "dns-trick",
  "port",
  "scheme",
  "cert",
] as const;

it.runIf(integrationEnabled)(
  "issue #14 blocks every malicious escape before commit and keeps the owner in control",
  async () => {
    const dataDirectory = requiredEnvironment("BB_BROWSER_HOST_DATA_DIR");
    const rootDirectory = provisionedBrowserStorageRoot(
      process.env.BB_BROWSER_REAL_ROOT,
    );
    const hostId = process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host";
    const profileId =
      process.env.BB_BROWSER_REAL_PROFILE_ID ?? "ci-origin-scope-fixture";
    const projectId =
      process.env.BB_BROWSER_REAL_PROJECT_ID ?? "ci-browser-project";
    const installationId = hostInstallationId(dataDirectory);
    const target = { hostId, profileId };

    const snapshotReader = createDefaultHostSnapshotReader(dataDirectory);
    const snapshot = await snapshotReader.snapshot(target);
    expect(snapshot.browser?.compatible).toBe(true);
    expect(snapshot.sandbox.available).toBe(true);

    const grantHost = new URL(projectLoopbackAlias(projectId, 1)).hostname;
    let grantPort = 0;
    let attackerPort = 0;
    let httpsPort = 0;

    const grantServer = createHttpServer((request, response) => {
      const [path] = (request.url ?? "/").split("?");
      const attackerHttp = `http://attacker.localhost:${attackerPort}`;
      const portEscape = `http://${grantHost}:${attackerPort}`;
      const schemeEscape = `https://${grantHost}:${httpsPort}`;
      const certEscape = `https://attacker.localhost:${httpsPort}`;
      const dnsTrickEscape = `http://p-${"0".repeat(12)}.localhost:${grantPort}`;
      if (
        path === "/redirect" ||
        path === "/redirect-chain-1" ||
        path === "/dns-trick" ||
        path === "/port" ||
        path === "/scheme" ||
        path === "/cert"
      ) {
        const location =
          path === "/redirect" || path === "/redirect-chain-1"
            ? attackerHttp
            : path === "/dns-trick"
              ? dnsTrickEscape
              : path === "/port"
                ? portEscape
                : path === "/scheme"
                  ? schemeEscape
                  : certEscape;
        response.writeHead(302, { location });
        response.end();
        return;
      }
      if (path === "/redirect-chain") {
        response.writeHead(302, { location: "/redirect-chain-1" });
        response.end();
        return;
      }
      if (path === "/popup") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<script>window.open(${JSON.stringify(attackerHttp)})</script>`,
        );
        return;
      }
      if (path === "/frame") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<iframe src=${JSON.stringify(attackerHttp)}></iframe>`);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>granted page</h1>");
    });
    const attackerServer = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>attacker content</h1>");
    });
    const certificate = selfSignedCertificate();
    const httpsOptions: ServerOptions = {
      key: certificate.key,
      cert: certificate.cert,
    };
    const httpsServer = createHttpsServer(
      httpsOptions,
      (_request, response) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>https attacker content</h1>");
      },
    );

    const fixtureProfiles = {
      rootDirectory,
      installationId,
      hostId,
      profileId,
    };
    await cleanupFixtureProfiles(fixtureProfiles);
    let cleanupRequired = false;
    try {
      grantPort = await listen(grantServer);
      attackerPort = await listen(attackerServer);
      httpsPort = await listen(httpsServer);
      const realGrantOrigin = `http://${grantHost}:${grantPort}`;
      const attackPages = ATTACK_KINDS.map((kind) => ({
        kind,
        page: `${realGrantOrigin}/${kind === "redirect-chain" ? "redirect-chain" : kind}`,
      }));
      cleanupRequired = true;
      const workerEnvironment = {
        BB_BROWSER_REAL_ROOT: rootDirectory,
        BB_BROWSER_REAL_INSTALLATION_ID: installationId,
        BB_BROWSER_REAL_HOST_ID: hostId,
        BB_BROWSER_REAL_PROFILE_ID: profileId,
        BB_BROWSER_REAL_PROJECT_ID: projectId,
        BB_BROWSER_FIXTURE_ADDRESS: realGrantOrigin,
        BB_BROWSER_ORIGIN_SCOPE: realGrantOrigin,
        BB_BROWSER_ATTACK_PAGES: JSON.stringify(attackPages),
      };
      const report = await runWorker({
        ...workerEnvironment,
        BB_BROWSER_WORKER_ACTION: "origin-scope",
      });

      expect(report.originScope.attacks).toHaveLength(ATTACK_KINDS.length);
      for (const attack of report.originScope.attacks) {
        expect(attack).toMatchObject({ blocked: true });
        expect(attack.deniedOrigin).toBeTruthy();
        expect(attack.deniedOrigin).not.toBe(realGrantOrigin);
      }
      expect(report.originScope.attacks.map(({ kind }) => kind).sort()).toEqual(
        [...ATTACK_KINDS].sort(),
      );
      expect(report.originScope.inScope.ok).toBe(true);
      expect(report.originScope.revocation).toEqual({
        interrupted: true,
        browserStillRunning: true,
      });
      expect(report.originScope.ownerPage.present).toBe(true);
      cleanupRequired = false;
    } finally {
      if (cleanupRequired) {
        await runWorker({
          BB_BROWSER_REAL_ROOT: rootDirectory,
          BB_BROWSER_REAL_INSTALLATION_ID: installationId,
          BB_BROWSER_REAL_HOST_ID: hostId,
          BB_BROWSER_REAL_PROFILE_ID: profileId,
          BB_BROWSER_REAL_PROJECT_ID: projectId,
          BB_BROWSER_FIXTURE_ADDRESS: `http://${grantHost}:${grantPort}`,
          BB_BROWSER_WORKER_ACTION: "cleanup",
        }).catch(() => {});
      }
      await close(grantServer);
      await close(attackerServer);
      await close(httpsServer);
      await cleanupFixtureProfiles(fixtureProfiles);
    }
  },
  300_000,
);

async function cleanupFixtureProfiles(options: {
  rootDirectory: string;
  installationId: string;
  hostId: string;
  profileId: string;
}) {
  const paths = profileStoragePaths({
    rootDirectory: options.rootDirectory,
    installationId: options.installationId,
    hostId: options.hostId,
    profileId: options.profileId,
  });
  await Promise.all([
    rm(paths.profileDirectory, { recursive: true, force: true }),
    rm(paths.runtimeManifestPath, { force: true }),
    rm(`${paths.runtimeManifestPath}.crashes.json`, { force: true }),
    rm(`${paths.runtimeManifestPath}.instance.lock`, { force: true }),
    rm(join(paths.runtimeManifestsDirectory, `bb-${options.profileId}`), {
      recursive: true,
      force: true,
    }),
  ]);
}
