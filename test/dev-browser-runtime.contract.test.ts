import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  requireDevBrowserRuntime,
  resolveDevBrowserRuntime,
} from "../src/browser/dev-browser-runtime.js";

const isolatedEnv = { PATH: process.env.PATH ?? "/usr/bin" };

async function fakeDevBrowserPackage(version = "0.2.9") {
  const root = await mkdtemp(join(tmpdir(), "dev-browser-runtime-"));
  const packageDirectory = join(root, "dev-browser");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "dev-browser", version }),
  );
  await writeFile(
    join(packageDirectory, "bin", "dev-browser.js"),
    "#!/usr/bin/env node\n",
  );
  return {
    root,
    packageDirectory,
    executable: join(packageDirectory, "bin", "dev-browser.js"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("dev-browser runtime resolution", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("does not throw when the package is absent from the host artifact tree", () => {
    expect(
      resolveDevBrowserRuntime({
        env: isolatedEnv,
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [],
      }),
    ).toBeNull();
  });

  it("resolves BB_DEV_BROWSER_PACKAGE before module lookup", async () => {
    const fake = await fakeDevBrowserPackage();
    cleanups.push(fake.cleanup);
    expect(
      resolveDevBrowserRuntime({
        env: { ...isolatedEnv, BB_DEV_BROWSER_PACKAGE: fake.packageDirectory },
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [],
      }),
    ).toEqual({
      packageDirectory: fake.packageDirectory,
      executable: fake.executable,
    });
  });

  it("resolves an extra search root used for path-installed plugins", async () => {
    const fake = await fakeDevBrowserPackage();
    cleanups.push(fake.cleanup);
    expect(
      resolveDevBrowserRuntime({
        env: isolatedEnv,
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [fake.root],
      }),
    ).toEqual({
      packageDirectory: fake.packageDirectory,
      executable: fake.executable,
    });
  });

  it("rejects a mismatched package from BB_DEV_BROWSER_PACKAGE", async () => {
    const fake = await fakeDevBrowserPackage("0.2.8");
    cleanups.push(fake.cleanup);

    expect(
      resolveDevBrowserRuntime({
        env: { ...isolatedEnv, BB_DEV_BROWSER_PACKAGE: fake.packageDirectory },
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [],
      }),
    ).toBeNull();
  });

  it("rejects a mismatched package from recovery search roots", async () => {
    const fake = await fakeDevBrowserPackage("0.3.0");
    cleanups.push(fake.cleanup);

    expect(
      resolveDevBrowserRuntime({
        env: isolatedEnv,
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [fake.root],
      }),
    ).toBeNull();
  });

  it("reports the expected and discovered package versions", async () => {
    const fake = await fakeDevBrowserPackage("0.2.8");
    cleanups.push(fake.cleanup);

    expect(() =>
      requireDevBrowserRuntime({
        env: { ...isolatedEnv, BB_DEV_BROWSER_PACKAGE: fake.packageDirectory },
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [],
      }),
    ).toThrow(
      `Incompatible dev-browser package at ${fake.packageDirectory}: expected 0.2.9, found 0.2.8.`,
    );
  });

  it("does not hide an explicit environment mismatch behind module fallback", async () => {
    const fake = await fakeDevBrowserPackage("0.2.8");
    cleanups.push(fake.cleanup);

    expect(() =>
      requireDevBrowserRuntime({
        env: { ...process.env, BB_DEV_BROWSER_PACKAGE: fake.packageDirectory },
        fromFileUrl: import.meta.url,
      }),
    ).toThrow(
      `Incompatible dev-browser package at ${fake.packageDirectory}: expected 0.2.9, found 0.2.8.`,
    );
  });

  it("requireDevBrowserRuntime names the missing package", () => {
    expect(() =>
      requireDevBrowserRuntime({
        env: isolatedEnv,
        fromFileUrl: pathToFileURL("/tmp/isolated-host-artifact/host.mjs").href,
        extraSearchRoots: [],
      }),
    ).toThrow(/Cannot find the pinned dev-browser package/);
  });
});
