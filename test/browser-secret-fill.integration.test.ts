import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBrowserInstanceRuntime } from "../src/browser/browser-runtime.js";
import { createProductionBrowserProcessBoundary } from "../src/browser/browser-process.js";
import { requireDevBrowserRuntime } from "../src/browser/dev-browser-runtime.js";
import {
  hostInstallationId,
  provisionedBrowserStorageRoot,
} from "../src/host/readiness.js";
import { profileStoragePaths } from "../src/host/profile-storage.js";
import { realBrowserTestHostId } from "./fixtures/real-browser-host.js";

// Fixture value only; the suite never reads a real secret file.
const PASSWORD = "real-helper-fixture-5d1e";

it.runIf(process.env.BB_BROWSER_REAL_INTEGRATION === "1")(
  "the real helper streams fillSecret requests and the host types the value",
  async () => {
    const dataDirectory = process.env.BB_BROWSER_HOST_DATA_DIR;
    if (!dataDirectory) throw new Error("BB_BROWSER_HOST_DATA_DIR is required");
    const secretsDirectory = await mkdtemp(join(tmpdir(), "real-secret-fill-"));
    const bindingPath = join(secretsDirectory, "browser-secret-refs.json");
    await writeFile(join(secretsDirectory, "app.env"), `PW=${PASSWORD}\n`);
    await writeFile(
      bindingPath,
      JSON.stringify({
        refs: {
          pw: { file: "app.env", var: "PW", origins: ["https://example.com"] },
        },
      }),
    );
    await chmod(bindingPath, 0o600);
    const devBrowser = requireDevBrowserRuntime();
    const options = {
      rootDirectory: provisionedBrowserStorageRoot(
        process.env.BB_BROWSER_REAL_ROOT,
      ),
      installationId: hostInstallationId(dataDirectory),
      chromeStablePaths: [
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
      ],
      launchBoundary: createProductionBrowserProcessBoundary({
        devBrowserExecutable: devBrowser.executable,
        devBrowserPackageDirectory: devBrowser.packageDirectory,
        secretRefs: { bindingPath, secretsDirectory },
      }),
    };
    const target = {
      hostId: realBrowserTestHostId(),
      profileId: `secret-fill-${randomUUID()}`,
      projectId: "secret-fill",
      locale: "en-US",
      timezone: "UTC",
    };
    const paths = profileStoragePaths({ ...options, ...target });
    const runtime = createBrowserInstanceRuntime(options);
    try {
      await runtime.start(target);
      const result = await runtime.execute(
        target,
        `await page.goto("https://example.com/");
await page.evaluate(() => {
  const input = document.createElement("input");
  input.id = "pw";
  document.body.append(input);
});
await fillSecret("#pw", "pw");
console.log("typed " + (await page.inputValue("#pw")).length);
return await page.inputValue("#pw");`,
        20_000,
      );
      expect(result).toBe(`typed ${PASSWORD.length}\n[redacted]`);
      await expect(
        runtime.execute(
          target,
          `await page.goto("https://example.org/");
await page.evaluate(() => document.body.append(document.createElement("input")));
await fillSecret("input", "pw");`,
          20_000,
        ),
      ).rejects.toThrow(/may not be filled on https:\/\/example\.org/u);
    } finally {
      await runtime.dispose();
      await rm(paths.profileDirectory, { recursive: true, force: true });
      await rm(secretsDirectory, { recursive: true, force: true });
    }
  },
  90_000,
);
