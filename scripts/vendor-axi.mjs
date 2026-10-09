#!/usr/bin/env node
/* global console */
// Rebuild vendor/node_modules/chrome-devtools-{axi,mcp} from npm.
//
// The Browser plugin runs chrome-devtools-axi as its own process, so it ships
// inside the plugin rather than as an install step: axi and its libraries are
// bundled into two files (its CLI and its bridge), and chrome-devtools-mcp,
// which has no runtime dependencies, is copied as published.
//
// The CLI and bridge bundles then get the fixes in axi-patches.mjs.
//
// Usage: node scripts/vendor-axi.mjs   (then commit vendor/)
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { patchAxiBridge, patchAxiCli } from "./axi-patches.mjs";

const AXI_VERSION = "0.1.39";
const MCP_VERSION = "1.10.1";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "node_modules");
const work = mkdtempSync(join(tmpdir(), "bb-vendor-axi-"));

try {
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "chrome-devtools-axi": AXI_VERSION,
        "chrome-devtools-mcp": MCP_VERSION,
      },
    }),
  );
  execFileSync(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: work, stdio: "inherit" },
  );
  const installed = join(work, "node_modules");

  // chrome-devtools-axi: CLI and bridge bundled side by side, so axi finds
  // its bridge (`../bin/chrome-devtools-axi-bridge.js`) and its version
  // (`../../package.json`) exactly where its own layout expects them.
  const axiSource = join(installed, "chrome-devtools-axi");
  const axiTarget = join(vendor, "chrome-devtools-axi");
  rmSync(axiTarget, { recursive: true, force: true });
  mkdirSync(join(axiTarget, "dist", "bin"), { recursive: true });
  await build({
    entryPoints: {
      "chrome-devtools-axi": join(axiSource, "dist/bin/chrome-devtools-axi.js"),
      "chrome-devtools-axi-bridge": join(
        axiSource,
        "dist/bin/chrome-devtools-axi-bridge.js",
      ),
    },
    outdir: join(axiTarget, "dist", "bin"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "inline",
    banner: {
      js: 'import { createRequire as __bbCreateRequire } from "node:module"; const require = __bbCreateRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
  const axiCli = join(axiTarget, "dist", "bin", "chrome-devtools-axi.js");
  writeFileSync(axiCli, patchAxiCli(readFileSync(axiCli, "utf8")));
  const axiBridge = join(
    axiTarget,
    "dist",
    "bin",
    "chrome-devtools-axi-bridge.js",
  );
  writeFileSync(axiBridge, patchAxiBridge(readFileSync(axiBridge, "utf8")));
  const axiPackage = JSON.parse(
    readFileSync(join(axiSource, "package.json"), "utf8"),
  );
  writeFileSync(
    join(axiTarget, "package.json"),
    `${JSON.stringify(
      {
        name: axiPackage.name,
        version: axiPackage.version,
        license: axiPackage.license,
        type: "module",
        bin: { "chrome-devtools-axi": "dist/bin/chrome-devtools-axi.js" },
        description: "Vendored and bundled by scripts/vendor-axi.mjs.",
      },
      null,
      2,
    )}\n`,
  );
  cpSync(join(axiSource, "LICENSE"), join(axiTarget, "LICENSE"));

  // chrome-devtools-mcp: published build, which bundles its own libraries.
  const mcpSource = join(installed, "chrome-devtools-mcp");
  const mcpTarget = join(vendor, "chrome-devtools-mcp");
  rmSync(mcpTarget, { recursive: true, force: true });
  mkdirSync(mcpTarget, { recursive: true });
  for (const entry of ["build", "LICENSE", "package.json"]) {
    cpSync(join(mcpSource, entry), join(mcpTarget, entry), { recursive: true });
  }
  console.log(
    `Vendored chrome-devtools-axi ${AXI_VERSION} and chrome-devtools-mcp ${MCP_VERSION}.`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
