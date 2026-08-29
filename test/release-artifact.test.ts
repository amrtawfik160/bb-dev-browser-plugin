/**
 * Issue #23 acceptance criterion 2: the production package contains the intended
 * server, frontend, host, CLI, tool, skill, migrations, licenses, and
 * documentation with exact dependency pins, and fails if a required component
 * is missing or an unintended one is present.
 *
 * This test inspects the BUILT dist/ artifact and the PACKAGED tarball surface
 * (via `npm pack --dry-run`, which honors .npmignore). It reuses the identity
 * and pin assertions already made by `test/package-contract.test.ts` rather
 * than duplicating them; it focuses on the release surface that test does not
 * cover (built bundles + packaged file set + complete pin cross-check). It does
 * not provision or mutate the host.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  dependencyInventory,
  PINNED_BROWSER_RUNTIME,
} from "../dependency-inventory.js";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

/** Run `npm pack --dry-run` and return the packaged file paths. */
function packagedFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  // `npm pack --json` emits a top-level array whose `files` entry lists the
  // tarball contents (honoring .npmignore).
  const entries = JSON.parse(output) as {
    files: { path: string }[];
  }[];
  return entries[0]!.files.map((file) => file.path.replace(/\\/gu, "/"));
}

/** Build dist/ once for the suite if it is absent. */
async function ensureBuilt() {
  if (existsSync(join(DIST, "server.js"))) return;
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
}

describe("release artifact (issue #23 AC2)", () => {
  it("builds the intended server, frontend, and host bundles with SDK pins", async () => {
    await ensureBuilt();

    const requiredArtifacts = [
      "server.js",
      "server.js.map",
      "server.meta.json",
      "app.js",
      "app.css",
      "app.meta.json",
      "host.js",
      "host.js.map",
      "host.meta.json",
    ];
    for (const artifact of requiredArtifacts) {
      expect(
        existsSync(join(DIST, artifact)),
        `built dist/${artifact} is present`,
      ).toBe(true);
    }

    // Each meta.json pins the SDK contract surface for that artifact.
    for (const artifact of [
      "server.meta.json",
      "app.meta.json",
      "host.meta.json",
    ]) {
      const meta = JSON.parse(readFileSync(join(DIST, artifact), "utf8"));
      expect(meta).toMatchObject({
        artifactFormatVersion: 1,
        pluginId: "browser",
        pluginVersion: "0.1.0",
        sdkMajor: 0,
        sdkVersion: "0.4.21",
        builtWith: { pluginSdkVersion: "0.4.21" },
      });
    }
  });

  it("packages exactly the intended runtime components and no dev-only ones", async () => {
    await ensureBuilt();
    const files = packagedFiles();

    // Intended components that must ship.
    const required = [
      "package.json",
      "LICENSE",
      "dependency-inventory.ts",
      "server.ts",
      "app.tsx",
      "host.ts",
      "contracts.ts",
      "activity-records.ts",
      "skills/browser/SKILL.md",
      "dist/server.js",
      "dist/app.js",
      "dist/app.css",
      "dist/host.js",
      // Required shipping documentation set.
      "docs/browser/README.md",
      "docs/browser/quickstart.md",
      "docs/browser/operators.md",
      "docs/browser/architecture.md",
      "docs/browser/security.md",
      "docs/browser/permissions.md",
      "docs/browser/cli-reference.md",
      "docs/browser/agent-reference.md",
      "docs/browser/safe-login.md",
      "docs/browser/troubleshooting.md",
      "docs/browser/limitations.md",
      "docs/browser/third-party-notices.md",
      "docs/browser/verification-report.md",
    ];
    const missing = required.filter((path) => !files.includes(path));
    expect(
      missing,
      `missing required package components: ${missing.join(", ")}`,
    ).toEqual([]);

    // Unintended components that must never ship (fixture secrets, dev
    // endpoints, build tooling, planning docs).
    const forbiddenPatterns: { label: string; pattern: RegExp }[] = [
      { label: "tests/fixtures", pattern: /^test\// },
      { label: "typescript tests", pattern: /\.test\.tsx?$/u },
      { label: "github workflow", pattern: /^\.github\// },
      { label: "agent process docs", pattern: /^docs\/agents\// },
      { label: "planning spec", pattern: /^docs\/browser-plugin-spec\.md$/ },
      {
        label: "implementation plan",
        pattern: /^docs\/implementation-plan\.md$/,
      },
      { label: "verification plan", pattern: /^docs\/verification-plan\.md$/ },
      { label: "AGENTS.md", pattern: /^AGENTS\.md$/ },
      { label: "tsconfig.json", pattern: /^tsconfig\.json$/ },
      { label: "eslint config", pattern: /^eslint\.config\.js$/ },
      { label: "packed tarball", pattern: /\.tgz$/u },
      { label: "coverage", pattern: /^coverage\// },
    ];
    const present = files.filter((path) =>
      forbiddenPatterns.some(({ pattern }) => pattern.test(path)),
    );
    expect(
      present,
      `unintended components packaged: ${present.join(", ")}`,
    ).toEqual([]);

    // The browser_script tool, the `bb browser` CLI, and the server migrations
    // are implemented in bundled source modules (server.ts / browser-service.ts
    // / activity-records.ts) and shipped as the built dist/server.js; assert
    // those implementing modules ship so the surface is auditable.
    const implementingModules = [
      "server.ts",
      "browser-service.ts",
      "activity-records.ts",
      "host.ts",
      "app.tsx",
    ];
    for (const module of implementingModules) {
      expect(
        files,
        `${module} ships as an auditable implementing module`,
      ).toContain(module);
    }
  });

  it("pins every runtime dependency exactly and matches dependencyInventory()", async () => {
    const packageJson = JSON.parse(
      await readFile(join(ROOT, "package.json"), "utf8"),
    );
    const runtimeDeps = packageJson.dependencies as Record<string, string>;
    const exactPin = /^[0-9]/u;
    for (const [name, spec] of Object.entries(runtimeDeps)) {
      expect(
        exactPin.test(spec),
        `runtime dependency ${name} is pinned exactly (got "${spec}")`,
      ).toBe(true);
    }

    // The inventory surface BB exposes in diagnostics must agree with the
    // package pins it ships with.
    const inventory = Object.fromEntries(
      dependencyInventory().map((dependency) => [
        dependency.name,
        dependency.version,
      ]),
    );
    const expected = {
      "bb-plugin-browser": packageJson.version,
      "@get-bb/plugin-sdk":
        packageJson.devDependencies["@get-bb/plugin-sdk"] ??
        "@get-bb/plugin-sdk",
      "dev-browser": runtimeDeps["dev-browser"],
      playwright: PINNED_BROWSER_RUNTIME.playwrightVersion,
      ws: runtimeDeps["ws"],
      zod: runtimeDeps["zod"],
    };
    for (const [name, version] of Object.entries(expected)) {
      expect(inventory[name], `inventory pins ${name}`).toBe(version);
    }

    // The pinned dev-browser version asserted by the runtime (browser-fallback
    // schema literal) equals the package pin.
    expect(PINNED_BROWSER_RUNTIME.playwrightVersion).toBe(
      runtimeDeps.playwright,
    );
  });
});
