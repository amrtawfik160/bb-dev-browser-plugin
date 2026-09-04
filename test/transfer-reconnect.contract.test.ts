import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_ID,
  setupRequiredStatus,
  type BrowserStatus,
} from "../contracts.js";
import { createBrowserHostEntry } from "../host.js";
import { createFileBrowserProfileStore } from "../profile-storage.js";

const HOST_ID = "host-transfer-reconnect";

function healthyStatus(): BrowserStatus {
  const unavailable = setupRequiredStatus({
    hostId: HOST_ID,
    profileId: DEFAULT_PROFILE_ID,
  });
  return {
    ...unavailable,
    state: "healthy",
    code: "healthy",
    label: "Ready",
    message: "Workspace Browser is ready on this host.",
    capabilities: unavailable.capabilities.map((capability) => ({
      ...capability,
      status: "ready",
    })),
  };
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

describe("Transfer Staging on host reconnect (issue #19)", () => {
  it("keeps a staged transfer usable across a host disconnect and reconnect", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "host-transfer-"));
    const profiles = createFileBrowserProfileStore({
      rootDirectory,
      installationId: "installation-transfer",
    });
    await profiles.initialize(HOST_ID);
    // A workspace file under the environment root that staging copies from.
    const environmentRoot = await mkdtemp(join(rootDirectory, "transfer-env-"));
    const sourcePath = join(environmentRoot, "payload.txt");
    await writeFile(sourcePath, "deterministic-transfer-reconnect");
    const runtime = {
      start: async () => {
        throw new Error("not used");
      },
      stop: async () => {},
      execute: async () => {
        throw new Error("not used");
      },
      navigate: async () => {
        throw new Error("not used");
      },
      history: async () => {
        throw new Error("not used");
      },
      openPage: async () => {
        throw new Error("not used");
      },
      focusPage: async () => {
        throw new Error("not used");
      },
      closePages: async () => 0,
      listPages: async () => [],
      status: async ({
        hostId,
        profileId,
      }: {
        hostId: string;
        profileId: string;
      }) => ({
        state: "sleeping" as const,
        hostId,
        profileId,
      }),
      pinPanel: async () => {
        throw new Error("not used");
      },
      unpinPanel: async () => {},
      hostDisconnected: () => {},
      hostReconnected: async () => {},
      dispose: async () => {},
    };
    const host = experimental_createHostEntryHarness(
      createBrowserHostEntry(
        {
          inspect: healthyStatus,
          diagnostics: () => {
            throw new Error("not used");
          },
        },
        profiles,
        undefined,
        runtime,
      ),
      {
        experimental_paths: {
          dataDir: rootDirectory,
          tempDir: join(rootDirectory, "tmp"),
        },
      },
    );
    try {
      // Stage a workspace file before the host disconnects.
      const staged = await host.experimental_call("transferStage", {
        kind: "workspace",
        transferId: "reconnect-fixture",
        sourcePath,
        environmentRoot,
        hostId: HOST_ID,
      });
      expect(staged).toMatchObject({
        outcome: "staged",
        transferId: "reconnect-fixture",
        kind: "workspace",
      });

      // The host briefly disconnects and reconnects; the staged copy lives on
      // the host data directory, not in the browser process, so it survives.
      await host.experimental_call("hostConnection", {
        hostId: HOST_ID,
        generation: 1,
        state: "disconnected",
      });
      await host.experimental_call("hostConnection", {
        hostId: HOST_ID,
        generation: 2,
        state: "connected",
      });

      // After reconnect the staged transfer is still consumable: the staged
      // path leaves the host for the browser to read it.
      const consume = await host.experimental_call("transferConsume", {
        hostId: HOST_ID,
        transferId: "reconnect-fixture",
      });
      expect(consume).toMatchObject({
        outcome: "used",
        transferId: "reconnect-fixture",
      });
      if (consume.outcome === "used") {
        expect(await pathExists(consume.stagedPath)).toBe(true);
        // The browser reads the staged file, then the host releases it.
        const released = await host.experimental_call("transferRelease", {
          hostId: HOST_ID,
          transferId: "reconnect-fixture",
        });
        expect(released).toMatchObject({
          outcome: "released",
          transferId: "reconnect-fixture",
        });
        expect(await pathExists(consume.stagedPath)).toBe(false);
      }
    } finally {
      await host.experimental_dispose();
      await rm(rootDirectory, { recursive: true, force: true });
    }
  });
});
