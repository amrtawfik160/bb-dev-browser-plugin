import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { createBrowserInstanceRuntime } from "../src/browser/browser-runtime.js";
import { createProductionBrowserProcessBoundary } from "../src/browser/browser-process.js";
import { requireDevBrowserRuntime } from "../src/browser/dev-browser-runtime.js";
import {
  hostInstallationId,
  provisionedBrowserStorageRoot,
} from "../src/host/readiness.js";
import { profileStoragePaths } from "../src/host/profile-storage.js";

it.runIf(process.env.BB_BROWSER_REAL_INTEGRATION === "1")(
  "owner navigation and reload recover after the last real Browser Tab closes",
  async () => {
    const dataDirectory = process.env.BB_BROWSER_HOST_DATA_DIR;
    if (!dataDirectory) throw new Error("BB_BROWSER_HOST_DATA_DIR is required");
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
      }),
    };
    const target = {
      hostId: process.env.BB_BROWSER_REAL_HOST_ID ?? "ci-browser-host",
      profileId: `empty-tab-${randomUUID()}`,
      projectId: "empty-tab-recovery",
      locale: "en-US",
      timezone: "UTC",
    };
    const paths = profileStoragePaths({ ...options, ...target });
    const runtime = createBrowserInstanceRuntime(options);
    try {
      await runtime.start(target);
      for (const action of ["navigate", "reload"] as const) {
        const before = await runtime.listPages(target);
        await runtime.closePages(
          target,
          before.map((page) => page.id),
        );
        expect(await runtime.listPages(target)).toEqual([]);
        const response =
          action === "navigate"
            ? await runtime.navigate(target, "https://example.com/")
            : await runtime.history(target, "reload");
        const pages = await runtime.listPages(target);
        expect(pages).toHaveLength(1);
        expect(pages[0]).toMatchObject({
          id: response.tabId,
          url: action === "navigate" ? "https://example.com/" : "about:blank",
        });
      }
      const opened = await runtime.openPage(target);
      expect(await runtime.listPages(target)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: opened.id })]),
      );
      const beforeAgent = await runtime.listPages(target);
      await runtime.closePages(
        target,
        beforeAgent.map((page) => page.id),
      );
      expect(await runtime.listPages(target)).toEqual([]);
      await runtime.execute(target, "return page.url()", 10_000);
      expect(await runtime.listPages(target)).toHaveLength(1);
    } finally {
      await runtime.dispose();
      await rm(paths.profileDirectory, { recursive: true, force: true });
    }
  },
  90_000,
);
