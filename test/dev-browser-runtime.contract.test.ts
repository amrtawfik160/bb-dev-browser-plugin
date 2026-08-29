import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  requireDevBrowserRuntime,
  resolveDevBrowserRuntime,
} from "../dev-browser-runtime.js";

const isolatedEnv = { PATH: process.env.PATH ?? "/usr/bin" };

async function fakeDevBrowserPackage() {
  const root = await mkdtemp(join(tmpdir(), "dev-browser-runtime-"));
  const packageDirectory = join(root, "dev-browser");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: "dev-browser", version: "0.2.9" }),
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
