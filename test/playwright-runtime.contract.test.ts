import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PINNED_BROWSER_RUNTIME } from "../dependency-inventory.js";
import {
  requirePlaywrightRuntime,
  resolvePlaywrightRuntime,
} from "../playwright-runtime.js";

const isolatedHostUrl = pathToFileURL(
  "/tmp/isolated-host-artifact/host.mjs",
).href;

async function fakePlaywrightPackage(
  version: string = PINNED_BROWSER_RUNTIME.playwrightVersion,
) {
  const root = await mkdtemp(join(tmpdir(), "playwright-runtime-"));
  const packageDirectory = join(root, "playwright");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "playwright", version }),
  );
  return {
    root,
    packageDirectory,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("Playwright runtime resolution", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("does not resolve Playwright from an isolated host artifact tree", () => {
    expect(
      resolvePlaywrightRuntime({
        fromFileUrl: isolatedHostUrl,
        extraSearchRoots: [],
      }),
    ).toBeNull();
  });

  it("resolves a path-installed plugin search root when the host artifact is isolated", async () => {
    const fake = await fakePlaywrightPackage();
    cleanups.push(fake.cleanup);

    expect(
      resolvePlaywrightRuntime({
        fromFileUrl: isolatedHostUrl,
        extraSearchRoots: [fake.root],
      }),
    ).toEqual({ packageDirectory: fake.packageDirectory });
  });

  it("loads the pinned Playwright package from the plugin tree for an isolated host artifact", () => {
    const runtime = requirePlaywrightRuntime({
      fromFileUrl: isolatedHostUrl,
      extraSearchRoots: [process.cwd()],
    });

    expect(runtime.packageDirectory).toBe(
      join(process.cwd(), "node_modules", "playwright"),
    );
    const playwright = createRequire(
      join(runtime.packageDirectory, "package.json"),
    )("playwright") as {
      chromium?: { connectOverCDP?: unknown };
    };
    expect(typeof playwright.chromium?.connectOverCDP).toBe("function");
  });

  it("rejects a mismatched Playwright package from recovery search roots", async () => {
    const fake = await fakePlaywrightPackage("1.57.0");
    cleanups.push(fake.cleanup);

    expect(
      resolvePlaywrightRuntime({
        fromFileUrl: isolatedHostUrl,
        extraSearchRoots: [fake.root],
      }),
    ).toBeNull();
  });

  it("requirePlaywrightRuntime names the missing package and expected pin", () => {
    expect(() =>
      requirePlaywrightRuntime({
        fromFileUrl: isolatedHostUrl,
        extraSearchRoots: [],
      }),
    ).toThrow(
      `Cannot find the pinned playwright package (expected ${PINNED_BROWSER_RUNTIME.playwrightVersion}).`,
    );
  });

  it("reports the expected and discovered Playwright versions", async () => {
    const fake = await fakePlaywrightPackage("1.57.0");
    cleanups.push(fake.cleanup);

    expect(() =>
      requirePlaywrightRuntime({
        fromFileUrl: isolatedHostUrl,
        extraSearchRoots: [fake.root],
      }),
    ).toThrow(
      `Incompatible playwright package at ${fake.packageDirectory}: expected ${PINNED_BROWSER_RUNTIME.playwrightVersion}, found 1.57.0.`,
    );
  });
});
