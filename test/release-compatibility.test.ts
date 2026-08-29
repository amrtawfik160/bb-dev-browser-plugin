/**
 * Issue #23 acceptance criterion 7: the release candidate remains compatible
 * with the documented BB SDK contract and dev-browser 0.2.9 behavior.
 *
 * This asserts the static compatibility surface: the built artifacts declare
 * the SDK contract version, the plugin manifest conforms to the documented BB
 * plugin contract, only public SDK contracts are consumed, and the dev-browser
 * and fallback browser pins are stable. It does not provision or mutate the
 * host and does not duplicate the identity assertions in
 * `test/package-contract.test.ts` (which covers name/license/entry-points).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  dependencyInventory,
  PINNED_BROWSER_RUNTIME,
} from "../dependency-inventory.js";
import { fallbackBrowserManifestSchema } from "../browser-fallback.js";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

async function readPackage() {
  return JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
    version: string;
    bb: {
      name: string;
      server: string;
      app: string;
      host: string;
      skills: string[];
      branding: { icon: string };
    };
    engines: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

function ensureBuilt() {
  if (existsSync(join(DIST, "server.js"))) return;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
}

describe("release compatibility (issue #23 AC7)", () => {
  it("built artifacts declare the documented BB SDK contract surface", async () => {
    ensureBuilt();
    const pkg = await readPackage();
    const sdkVersion = pkg.devDependencies["@get-bb/plugin-sdk"];
    const sdkMajor = Number(sdkVersion.split(".")[0]);

    for (const artifact of [
      "server.meta.json",
      "app.meta.json",
      "host.meta.json",
    ]) {
      const meta = JSON.parse(readFileSync(join(DIST, artifact), "utf8"));
      expect(meta).toMatchObject({
        artifactFormatVersion: 1,
        pluginId: "browser",
        pluginVersion: pkg.version,
        sdkMajor,
        sdkVersion,
        builtWith: { pluginSdkVersion: sdkVersion },
      });
    }

    // The package engines gate matches the SDK the artifacts were built with.
    expect(pkg.engines.bbPluginSdk).toBe(`>=${sdkVersion}`);
  });

  it("conforms the plugin manifest to the documented BB plugin contract", async () => {
    const pkg = await readPackage();
    expect(pkg.bb).toEqual({
      name: "Browser",
      description: "Open a host-local Workspace Browser from BB threads.",
      server: "./server.ts",
      app: "./app.tsx",
      host: "./host.ts",
      skills: ["skills"],
      branding: { icon: "Globe" },
    });
    expect(pkg.engines.bb).toMatch(/^>=\d/u);
    // Every declared entry point ships in the production package.
    for (const entry of ["server.ts", "app.tsx", "host.ts"]) {
      expect(existsSync(join(ROOT, entry)), `${entry} ships`).toBe(true);
    }
    expect(existsSync(join(ROOT, "skills", "browser", "SKILL.md"))).toBe(true);
  });

  it("consumes only public plugin SDK contracts", () => {
    // Reuses the same public-SDK-only scanner as the package contract test;
    // this is the compatibility guard against private SDK surfaces drifting.
    const scan = experimental_scanPublicSdkOnly(".", {
      allow: [
        /^@eslint\/js$/,
        /^@get-bb\/plugin-sdk\/testing(?:\/(?:app|host))?$/,
        /^@testing-library\/react$/,
        /^better-sqlite3$/,
        /^playwright$/,
        /^react$/,
        /^typescript-eslint$/,
        /^vitest$/,
        /^ws$/,
        /^zod$/,
      ],
    });
    expect(scan.privateDependencies).toEqual([]);
    expect(scan.violations).toEqual([]);
  });

  it("pins dev-browser 0.2.9 and the compatible fallback browser across every surface", async () => {
    const pkg = await readPackage();
    expect(pkg.dependencies["dev-browser"]).toBe("0.2.9");
    expect(pkg.dependencies.playwright).toBe(
      PINNED_BROWSER_RUNTIME.playwrightVersion,
    );

    // The inventory exposed through diagnostics agrees with the package pins.
    const inventory = Object.fromEntries(
      dependencyInventory().map((dependency) => [
        dependency.name,
        dependency.version,
      ]),
    );
    expect(inventory["dev-browser"]).toBe("0.2.9");
    expect(inventory.playwright).toBe(PINNED_BROWSER_RUNTIME.playwrightVersion);

    // The fallback browser manifest schema is a literal contract on the pinned
    // playwright/chromium; a drift here is a compatibility break. A manifest
    // carrying the pinned values parses, and any drift is rejected.
    const pinned = {
      playwrightVersion: PINNED_BROWSER_RUNTIME.playwrightVersion,
      chromiumRevision: PINNED_BROWSER_RUNTIME.chromiumRevision,
      chromiumVersion: PINNED_BROWSER_RUNTIME.chromiumVersion,
      executableSha256: "a".repeat(64),
    };
    expect(fallbackBrowserManifestSchema.parse(pinned)).toEqual(pinned);
    expect(() =>
      fallbackBrowserManifestSchema.parse({
        ...pinned,
        playwrightVersion: "0.0.0",
      }),
    ).toThrow();
  });
});
