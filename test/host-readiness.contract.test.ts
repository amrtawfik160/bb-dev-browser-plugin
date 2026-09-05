import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  lstat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_STORAGE_ROOT,
  DEFAULT_PROFILE_ID,
} from "../src/shared/contracts.js";
import {
  createDefaultHostSnapshotReader,
  createHostReadinessBoundary,
  hostInstallationId,
  provisionedBrowserStorageRoot,
  type HostProbePaths,
  type HostProbeSnapshot,
} from "../src/host/readiness.js";
import { createBrowserHostEntry } from "../src/host/host.js";

const target = {
  hostId: "host-readiness-test",
  profileId: DEFAULT_PROFILE_ID,
};

const healthySnapshot: HostProbeSnapshot = {
  operatingSystem: {
    id: "ubuntu",
    version: "24.04",
    name: "Ubuntu 24.04 LTS",
  },
  architecture: "x64",
  connect: { enrolled: true },
  browser: {
    name: "Google Chrome",
    version: "140.0.7339.80",
    compatible: true,
  },
  sandbox: { available: true },
  dedicatedUser: { state: "ready" },
  protectedStorage: { state: "ready" },
  disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
  loopback: { available: true },
  processes: [],
  exitLogs: [],
};

async function createRealProbeFixture() {
  const root = await mkdtemp(join(tmpdir(), "browser-readiness-"));
  const daemonRoot = join(root, "daemon");
  const dataDir = join(daemonRoot, "plugins/browser/host-data");
  const systemRoot = join(root, "system");
  const protectedStorageRoot = join(root, "var/lib/bb-browser");
  const daemonConfig = join(daemonRoot, "config.json");
  const installationId = hostInstallationId(dataDir);
  const hostStorage = join(
    protectedStorageRoot,
    "installations",
    installationId,
    "hosts",
    encodeURIComponent(target.hostId),
  );
  const paths: HostProbePaths = {
    osRelease: join(systemRoot, "os-release"),
    passwd: join(systemRoot, "passwd"),
    packageStatus: join(systemRoot, "dpkg-status"),
    userNamespaceSetting: join(systemRoot, "unprivileged_userns_clone"),
    chromeStable: join(systemRoot, "google-chrome-stable"),
    chrome: join(systemRoot, "google-chrome"),
    sandboxHelpers: [join(systemRoot, "chrome-sandbox")],
    protectedStorageRoot,
  };
  await mkdir(dataDir, { recursive: true });
  await mkdir(hostStorage, { recursive: true });
  await mkdir(systemRoot, { recursive: true });
  await writeFile(
    daemonConfig,
    JSON.stringify({
      machineCredential: "credential",
      connectMachineId: "machine",
    }),
  );
  await writeFile(
    paths.osRelease,
    'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n',
  );
  await writeFile(
    paths.passwd,
    "bb-browser:x:1001:1001::/var/lib/bb-browser:/usr/sbin/nologin\n",
  );
  await writeFile(paths.userNamespaceSetting, "1\n");
  await writeFile(paths.chromeStable, "fixture executable");
  await chmod(paths.chromeStable, 0o755);
  await writeFile(
    paths.packageStatus,
    "Package: google-chrome-stable\nStatus: install ok installed\nVersion: 140.0.7339.80\n",
  );
  await writeFile(
    join(hostStorage, "host-state.json"),
    JSON.stringify({ schemaVersion: 1, installationId, hostId: target.hostId }),
  );
  await chmod(hostStorage, 0o700);
  await chown(hostStorage, 1001, 1001);
  return {
    root,
    dataDir,
    daemonConfig,
    hostStorage,
    paths,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function createRealProbeHost(
  fixture: Awaited<ReturnType<typeof createRealProbeFixture>>,
) {
  return experimental_createHostEntryHarness(
    createBrowserHostEntry(
      createHostReadinessBoundary(
        createDefaultHostSnapshotReader(fixture.dataDir, fixture.paths),
      ),
    ),
  );
}

async function hostFingerprint(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const filesystemEntries = await Promise.all(
    entries.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      const metadata = await lstat(path);
      return {
        path: path.slice(root.length),
        kind: entry.isFile()
          ? "file"
          : entry.isDirectory()
            ? "directory"
            : "other",
        mode: metadata.mode,
        uid: metadata.uid,
        contents: entry.isFile() ? await readFile(path, "utf8") : null,
      };
    }),
  );
  const processIds = await Promise.all(
    (await readdir("/proc"))
      .filter((name) => /^\d+$/.test(name))
      .map(async (processId) => {
        const command = await readFile(
          `/proc/${processId}/cmdline`,
          "utf8",
        ).catch(() => "");
        return command.includes(root) ? processId : null;
      }),
  );
  return {
    filesystem: filesystemEntries.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    processIds: processIds.filter((processId) => processId !== null).sort(),
  };
}

describe("Workspace Browser host readiness contract", () => {
  it("issue #12 rejects a mandatory Chromium root that readiness did not protect", () => {
    expect(provisionedBrowserStorageRoot(undefined)).toBe(BROWSER_STORAGE_ROOT);
    expect(provisionedBrowserStorageRoot(BROWSER_STORAGE_ROOT)).toBe(
      BROWSER_STORAGE_ROOT,
    );
    expect(() =>
      provisionedBrowserStorageRoot("/tmp/unverified-browser-root"),
    ).toThrow("must use the protected Browser storage root");
  });
  it("classifies a fully prepared Ubuntu x64 host as healthy without mutation", async () => {
    const fixture = await createRealProbeFixture();
    const host = createRealProbeHost(fixture);
    const before = await hostFingerprint(fixture.root);

    try {
      const status = await host.experimental_call("status", target);

      expect(status.state).toBe("healthy");
      expect(status.capabilities).toHaveLength(9);
      expect(status.capabilities.every((item) => item.status === "ready")).toBe(
        true,
      );
      expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
      expect(await hostFingerprint(fixture.root)).toEqual(before);
    } finally {
      await host.experimental_dispose();
      expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
      await fixture.cleanup();
    }
  });

  it("classifies Debian x86_64 as a supported platform", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({
          snapshot: async () => ({
            ...healthySnapshot,
            operatingSystem: {
              id: "debian",
              version: "13",
              name: "Debian GNU/Linux 13",
            },
            architecture: "amd64",
          }),
        }),
      ),
    );

    const status = await host.experimental_call("status", target);

    expect(status.state).toBe("healthy");
    await host.experimental_dispose();
  });

  it("issue #3 probes BB Connect enrollment from the retained worker", async () => {
    const fixture = await createRealProbeFixture();
    await writeFile(fixture.daemonConfig, JSON.stringify({}));
    const host = createRealProbeHost(fixture);

    try {
      const status = await host.experimental_call("status", target);

      expect(
        status.capabilities.find((item) => item.id === "bb-connect"),
      ).toMatchObject({ status: "missing" });
      expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    } finally {
      await host.experimental_dispose();
      expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
      await fixture.cleanup();
    }
  });

  it("treats a Connect plugin pairing in bb.db as BB Connect enrollment", async () => {
    const fixture = await createRealProbeFixture();
    await writeFile(fixture.daemonConfig, JSON.stringify({}));
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(
      join(dirname(fixture.daemonConfig), "bb.db"),
    );
    try {
      database.exec(
        "CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT, updated_at INTEGER)",
      );
      database
        .prepare("INSERT INTO plugin_kv VALUES (?, ?, ?, ?)")
        .run("connect", "credential", "paired-connect-token", 1);
    } finally {
      database.close();
    }
    const host = createRealProbeHost(fixture);

    try {
      const status = await host.experimental_call("status", target);

      expect(
        status.capabilities.find((item) => item.id === "bb-connect"),
      ).toMatchObject({ status: "ready" });
    } finally {
      await host.experimental_dispose();
      await fixture.cleanup();
    }
  });

  it("treats an absent Chromium fallback as Setup required, not Repair required", async () => {
    const fixture = await createRealProbeFixture();
    await unlink(fixture.paths.chromeStable);
    await writeFile(fixture.paths.packageStatus, "");
    const host = createRealProbeHost(fixture);

    try {
      const status = await host.experimental_call("status", target);
      expect(status.state).toBe("setup-required");
      expect(
        status.capabilities.find((item) => item.id === "browser"),
      ).toMatchObject({ status: "missing" });
    } finally {
      await host.experimental_dispose();
      await fixture.cleanup();
    }
  });

  it("classifies unsupported operating systems and architectures without partial setup", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({
          snapshot: async () => ({
            ...healthySnapshot,
            operatingSystem: {
              id: "fedora",
              version: "42",
              name: "Fedora Linux 42",
            },
            architecture: "arm64",
          }),
        }),
      ),
    );

    const status = await host.experimental_call("status", target);

    expect(status.state).toBe("unsupported");
    expect(
      status.capabilities
        .filter((item) =>
          ["operating-system", "architecture"].includes(item.id),
        )
        .map((item) => item.status),
    ).toEqual(["unsupported", "unsupported"]);
    await host.experimental_dispose();
  });

  it("classifies missing host prerequisites as Setup required", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({
          snapshot: async () => ({
            ...healthySnapshot,
            browser: null,
            dedicatedUser: { state: "missing" },
            protectedStorage: { state: "partial" },
          }),
        }),
      ),
    );

    const status = await host.experimental_call("status", target);

    expect(status.state).toBe("setup-required");
    expect(
      status.capabilities
        .filter((item) => item.status === "missing")
        .map((item) => item.id),
    ).toEqual(["browser", "dedicated-user", "protected-storage"]);
    await host.experimental_dispose();
  });

  it("rejects a dedicated browser identity with root group membership", async () => {
    const fixture = await createRealProbeFixture();
    await writeFile(
      fixture.paths.passwd,
      "bb-browser:x:1001:0::/var/lib/bb-browser:/usr/sbin/nologin\n",
    );
    const host = createRealProbeHost(fixture);
    try {
      const status = await host.experimental_call("status", target);
      expect(
        status.capabilities.find(
          (capability) => capability.id === "dedicated-user",
        ),
      ).toMatchObject({ status: "failed" });
    } finally {
      await host.experimental_dispose();
      await fixture.cleanup();
    }
  });

  it("classifies low disk headroom as Repair required", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({
          snapshot: async () => ({
            ...healthySnapshot,
            disk: { freeBytes: 4 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
          }),
        }),
      ),
    );

    const status = await host.experimental_call("status", target);

    expect(status.state).toBe("repair-required");
    expect(
      status.capabilities.find((item) => item.id === "disk-headroom"),
    ).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("5 GiB"),
    });
    await host.experimental_dispose();
  });

  it("classifies corrupt protected host state as Repair required", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({
          snapshot: async () => ({
            ...healthySnapshot,
            protectedStorage: { state: "corrupt" },
          }),
        }),
      ),
    );

    const status = await host.experimental_call("status", target);

    expect(status.state).toBe("repair-required");
    expect(
      status.capabilities.find((item) => item.id === "protected-storage"),
    ).toMatchObject({
      status: "failed",
      reason: "Repair the corrupt Browser host state before continuing.",
    });
    await host.experimental_dispose();
  });

  it.each([
    {
      name: "another BB installation",
      manifest: {
        schemaVersion: 1,
        installationId: "another-installation",
        hostId: target.hostId,
      },
    },
    {
      name: "another workspace host",
      manifest: {
        schemaVersion: 1,
        installationId: null,
        hostId: "another-host",
      },
    },
  ])("issue #3 rejects protected storage for $name", async ({ manifest }) => {
    const fixture = await createRealProbeFixture();
    await writeFile(
      join(fixture.hostStorage, "host-state.json"),
      JSON.stringify({
        ...manifest,
        installationId:
          manifest.installationId ?? hostInstallationId(fixture.dataDir),
      }),
    );
    const host = createRealProbeHost(fixture);

    try {
      const status = await host.experimental_call("status", target);

      expect(status.state).toBe("repair-required");
      expect(
        status.capabilities.find((item) => item.id === "protected-storage"),
      ).toMatchObject({ status: "failed" });
    } finally {
      await host.experimental_dispose();
      await fixture.cleanup();
    }
  });

  it("issue #3 rejects a symlink masquerading as a Chrome sandbox helper", async () => {
    const fixture = await createRealProbeFixture();
    const helperTarget = `${fixture.paths.sandboxHelpers[0]}.target`;
    await writeFile(fixture.paths.userNamespaceSetting, "0\n");
    await writeFile(helperTarget, "fixture sandbox helper");
    await chmod(helperTarget, 0o4755);
    await symlink(helperTarget, fixture.paths.sandboxHelpers[0]);
    const host = createRealProbeHost(fixture);

    try {
      const status = await host.experimental_call("status", target);

      expect(
        status.capabilities.find((item) => item.id === "sandbox"),
      ).toMatchObject({ status: "missing" });
    } finally {
      await host.experimental_dispose();
      await fixture.cleanup();
    }
  });

  it.each([
    { name: "non-executable", mode: 0o4600, expected: "missing" },
    { name: "valid", mode: 0o4755, expected: "ready" },
  ])(
    "issue #3 classifies a $name Chrome sandbox helper as $expected",
    async ({ mode, expected }) => {
      const fixture = await createRealProbeFixture();
      const helper = fixture.paths.sandboxHelpers[0];
      await writeFile(fixture.paths.userNamespaceSetting, "0\n");
      await writeFile(helper, "fixture sandbox helper");
      await chmod(helper, mode);
      const host = createRealProbeHost(fixture);

      try {
        const status = await host.experimental_call("status", target);

        expect(
          status.capabilities.find((item) => item.id === "sandbox"),
        ).toMatchObject({ status: expected });
      } finally {
        await host.experimental_dispose();
        await fixture.cleanup();
      }
    },
  );

  it.each([
    {
      name: "matching",
      versionEvidence: JSON.stringify({
        playwrightVersion: "1.58.2",
        chromiumRevision: "1208",
        chromiumVersion: "145.0.7632.6",
        executableSha256:
          "6f1af2dfc4d7f16dacf404b1f6c9fd4a65cfffb8edde6dcf957463a0e41fb1ed",
      }),
      expectedState: "healthy",
      expectedCapability: "ready",
    },
    {
      name: "drifted",
      versionEvidence: JSON.stringify({
        playwrightVersion: "1.57.0",
        chromiumRevision: "1194",
        chromiumVersion: "143.0.7499.4",
        executableSha256:
          "6f1af2dfc4d7f16dacf404b1f6c9fd4a65cfffb8edde6dcf957463a0e41fb1ed",
      }),
      expectedState: "repair-required",
      expectedCapability: "failed",
    },
    {
      name: "corrupt",
      versionEvidence: "not json",
      expectedState: "repair-required",
      expectedCapability: "failed",
    },
  ])(
    "issue #3 classifies $name pinned Chromium version evidence",
    async ({ versionEvidence, expectedState, expectedCapability }) => {
      const fixture = await createRealProbeFixture();
      const fallbackDirectory = join(
        fixture.hostStorage,
        "browsers",
        "chromium",
      );
      await unlink(fixture.paths.chromeStable);
      await mkdir(fallbackDirectory, { recursive: true });
      await writeFile(join(fallbackDirectory, "chrome"), "fixture executable");
      await chmod(join(fallbackDirectory, "chrome"), 0o755);
      await chown(join(fallbackDirectory, "chrome"), 1001, 1001);
      await writeFile(join(fallbackDirectory, "icudtl.dat"), "fixture icu");
      await chown(join(fallbackDirectory, "icudtl.dat"), 1001, 1001);
      await writeFile(join(fallbackDirectory, "version.json"), versionEvidence);
      await chmod(join(fallbackDirectory, "version.json"), 0o600);
      await chown(join(fallbackDirectory, "version.json"), 1001, 1001);
      const host = createRealProbeHost(fixture);

      try {
        const status = await host.experimental_call("status", target);

        expect(status.state).toBe(expectedState);
        expect(
          status.capabilities.find((item) => item.id === "browser"),
        ).toMatchObject({ status: expectedCapability });
      } finally {
        await host.experimental_dispose();
        await fixture.cleanup();
      }
    },
  );

  it("issue #3 treats a chrome-only Playwright fallback as Repair required", async () => {
    const fixture = await createRealProbeFixture();
    const fallbackDirectory = join(fixture.hostStorage, "browsers", "chromium");
    await unlink(fixture.paths.chromeStable);
    await mkdir(fallbackDirectory, { recursive: true });
    await writeFile(join(fallbackDirectory, "chrome"), "fixture executable");
    await chmod(join(fallbackDirectory, "chrome"), 0o755);
    await chown(join(fallbackDirectory, "chrome"), 1001, 1001);
    await writeFile(
      join(fallbackDirectory, "version.json"),
      JSON.stringify({
        playwrightVersion: "1.58.2",
        chromiumRevision: "1208",
        chromiumVersion: "145.0.7632.6",
        executableSha256:
          "6f1af2dfc4d7f16dacf404b1f6c9fd4a65cfffb8edde6dcf957463a0e41fb1ed",
      }),
    );
    await chmod(join(fallbackDirectory, "version.json"), 0o600);
    await chown(join(fallbackDirectory, "version.json"), 1001, 1001);
    const host = createRealProbeHost(fixture);

    try {
      const status = await host.experimental_call("status", target);
      expect(status.state).toBe("repair-required");
      expect(
        status.capabilities.find((item) => item.id === "browser"),
      ).toMatchObject({ status: "failed" });
    } finally {
      await host.experimental_dispose();
      await fixture.cleanup();
    }
  });

  it("returns only redacted diagnostics through the retained host contract", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({
          snapshot: async () => ({
            ...healthySnapshot,
            exitLogs: [
              "Chrome exited at https://example.test/login?token=hunter2 Authorization: Bearer abc Cookie: sid=secret password=opensesame <script>steal()</script> /var/lib/bb-browser/profiles/personal",
            ],
          }),
        }),
      ),
    );

    const diagnostics = await host.experimental_call("diagnostics", target);
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.readiness.state).toBe("healthy");
    expect(diagnostics.dependencies).toEqual(
      expect.arrayContaining([
        { name: "bb-plugin-browser", version: "0.1.0" },
        { name: "dev-browser", version: "0.2.9" },
        { name: "Google Chrome", version: "140.0.7339.80" },
      ]),
    );
    expect(diagnostics.processes).toEqual([]);
    expect(diagnostics.resourceUse).toMatchObject({
      diskFreeBytes: 8 * 1024 ** 3,
      diskTotalBytes: 20 * 1024 ** 3,
    });
    for (const forbidden of [
      "https://",
      "hunter2",
      "Bearer abc",
      "sid=secret",
      "opensesame",
      "steal()",
      "/profiles/personal",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    await host.experimental_dispose();
  });
});
