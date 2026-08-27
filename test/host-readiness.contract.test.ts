import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE_ID } from "../contracts.js";
import {
  createHostReadinessBoundary,
  type HostProbeSnapshot,
} from "../readiness.js";
import { createBrowserHostEntry } from "../host.js";

const target = {
  hostId: "host-readiness-test",
  profileId: DEFAULT_PROFILE_ID,
  connectEnrolled: true,
};

const healthySnapshot: HostProbeSnapshot = {
  operatingSystem: {
    id: "ubuntu",
    version: "24.04",
    name: "Ubuntu 24.04 LTS",
  },
  architecture: "x64",
  browser: { name: "Google Chrome", version: "140.0.7339.80" },
  sandbox: { available: true },
  dedicatedUser: { state: "ready" },
  protectedStorage: { state: "ready" },
  disk: { freeBytes: 8 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 },
  loopback: { available: true },
  processes: [],
  exitLogs: [],
};

describe("Workspace Browser host readiness contract", () => {
  it("classifies a fully prepared Ubuntu x64 host as healthy without mutation", async () => {
    const mutationCount = 0;
    const entry = createBrowserHostEntry(
      createHostReadinessBoundary({
        snapshot: async () => healthySnapshot,
      }),
    );
    const host = experimental_createHostEntryHarness(entry);

    const status = await host.experimental_call("status", target);

    expect(status.state).toBe("healthy");
    expect(status.capabilities).toHaveLength(9);
    expect(status.capabilities.every((item) => item.status === "ready")).toBe(
      true,
    );
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    expect(mutationCount).toBe(0);
    await host.experimental_dispose();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
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

  it("requires BB Connect enrollment before the host is ready", async () => {
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        createHostReadinessBoundary({ snapshot: async () => healthySnapshot }),
      ),
    );

    const status = await host.experimental_call("status", {
      ...target,
      connectEnrolled: false,
    });

    expect(status.state).toBe("setup-required");
    expect(
      status.capabilities.find((item) => item.id === "bb-connect"),
    ).toMatchObject({ status: "missing" });
    await host.experimental_dispose();
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
